import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { handler } from '../src/handler';
import { getClient } from '../src/db/client';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { getCardConsistent } from '../src/db/cards';
import { listTasksByCard } from '../src/db/tasks';
import { createTemplate } from '../src/db/templates';
import { DEFAULT_HOLD_GOOGLE_CALENDARS } from '../src/calendar/dapierBroker';
import { HOLD_ORGANIZER } from '../src/calendar/holdGoogleSync';
import { setCalendarHoldGoogleDepsForTests } from '../src/routes/calendarHolds';
import { templateFromYaml, templateToYaml, validateAuthoredTemplate } from '../src/templates/yamlTemplates';
import { holdGoogleProvider } from './helpers/hold-google';
import type { LambdaResponse } from '../src/types';

function invoke(method: string, path: string, body?: unknown): Promise<LambdaResponse> {
  return handler({ httpMethod: method, path, body: body === undefined ? null : JSON.stringify(body) }, {});
}
const parsed = (response: LambdaResponse): any => JSON.parse(response.body);

let client: DynamoDBDocumentClient;
let courseTemplateId: string;

describe('course event slots: event Cards instead of text', () => {
  before(async () => {
    client = await getClient(await startLocal());
    await createTables(client);
    await createTemplate(client, {
      name: 'Synthetic course event', type: 'synthetic-course-event', triggerType: 'manual',
      taskDefinitions: [
        { refId: 'create-calendar-invite', description: 'Create the calendar invite', offsetDays: -7 },
        { refId: 'run', description: 'Run the event', offsetDays: 0 },
      ],
    });
    await createTemplate(client, {
      name: 'Synthetic slot workshop', type: 'synthetic-slot-workshop', triggerType: 'manual',
      taskDefinitions: [{ refId: 'run', description: 'Run the workshop', offsetDays: 0 }],
    });
    courseTemplateId = (await createTemplate(client, {
      name: 'Synthetic course', type: 'synthetic-slot-course', triggerType: 'manual',
      countFields: [{ id: 'workshops', label: 'Number of workshops', default: 0, min: 0, max: 5 }],
      taskDefinitions: [
        {
          refId: 'prepare-events', description: 'Prepare selected Q&A, kickoff and optional workshops', offsetDays: -35,
          validation: { requiresLinkedEventCards: true },
        },
        {
          refId: 'pre-course-qa', description: 'Run the Pre-Course Live Q&A', offsetDays: -14,
          linkCard: { templateType: 'synthetic-course-event', slot: 'Pre-Course Live Q&A' },
        },
        {
          refId: 'workshop', description: 'Workshop {n}', offsetDays: -21, repeat: { countField: 'workshops' },
          linkCard: { templateType: 'synthetic-slot-workshop', slot: 'Workshop {n}' },
        },
      ],
    } as any)).id;
  });
  after(async () => { setCalendarHoldGoogleDepsForTests({}); await stopLocal(); });

  async function createCourse(workshops = 1) {
    const response = await invoke('POST', '/api/cards', {
      templateId: courseTemplateId, title: 'Gen Media 2026', anchorDate: '2026-11-16', counts: { workshops },
    });
    assert.equal(response.statusCode, 201, response.body);
    return parsed(response);
  }

  it('creates each slot as an undated event Card linked to its Task', async () => {
    const created = await createCourse(1);
    assert.deepEqual(created.eventSlots.map((slot: any) => `${slot.slot}: ${slot.outcome}`).sort(), [
      'Pre-Course Live Q&A: created', 'Workshop 1: created',
    ]);
    const qa = created.eventSlots.find((slot: any) => slot.slot === 'Pre-Course Live Q&A');
    const qaCard = (await getCardConsistent(client, qa.cardId))!;
    assert.equal(qaCard.title, 'Gen Media 2026: Pre-Course Live Q&A');
    assert.equal(qaCard.anchorDate, undefined, 'date TBD');
    // Its Tasks are dated from the slot Task (2026-11-02) until a time is set.
    const qaTasks = await listTasksByCard(client, qaCard.id);
    assert.deepEqual(qaTasks.map((task) => task.date).sort(), ['2026-10-26', '2026-11-02']);

    const tasks = parsed(await invoke('GET', `/api/cards/${created.card.id}/tasks`)).tasks;
    const slotTask = tasks.find((task: any) => task.templateTaskRef === 'pre-course-qa');
    assert.equal(slotTask.linkedCardId, qaCard.id);
    assert.equal(slotTask.linkedCard.dateTbd, true);
    assert.deepEqual(slotTask.linkedCard.invites.map((invite: any) => invite.state), ['missing', 'missing']);

    // Rerunning creates nothing new.
    const again = parsed(await invoke('POST', `/api/cards/${created.card.id}/event-slots`, {})).eventSlots;
    assert.ok(again.every((slot: any) => slot.outcome === 'linked'));
  });

  it('completes an event Task only through its linked event Card, never a comment or URL', async () => {
    const created = await createCourse(0);
    const tasks = await listTasksByCard(client, created.card.id);
    const slotTask = tasks.find((task) => task.templateTaskRef === 'pre-course-qa')!;
    const prepare = tasks.find((task) => task.templateTaskRef === 'prepare-events')!;
    const unlinked = parsed(await invoke('POST', `/api/tasks/${slotTask.id}/actions/link-card`, {
      expectedVersion: slotTask.version, cardId: null,
    }));

    const textOnly = await invoke('PUT', `/api/tasks/${slotTask.id}`, {
      expectedVersion: unlinked.version, status: 'done', comment: 'Luma https://lu.ma/x', link: 'https://lu.ma/x',
    });
    assert.equal(textOnly.statusCode, 400, textOnly.body);
    assert.equal(parsed(textOnly).code, 'linked-card-required');
    assert.match(parsed(textOnly).error, new RegExp(`dataops cards event-slots ${created.card.id} --apply`));

    const prepareDone = await invoke('PUT', `/api/tasks/${prepare.id}`, { expectedVersion: prepare.version, status: 'done' });
    assert.equal(prepareDone.statusCode, 400, prepareDone.body);
    assert.match(parsed(prepareDone).error, /Pre-Course Live Q&A/);

    const preview = parsed(await invoke('GET', `/api/cards/${created.card.id}/event-slots`)).eventSlots;
    assert.deepEqual(preview.map((slot: any) => slot.outcome), ['planned']);
    const applied = parsed(await invoke('POST', `/api/cards/${created.card.id}/event-slots`, {})).eventSlots;
    assert.deepEqual(applied.map((slot: any) => slot.outcome), ['created']);

    const relinked = (await listTasksByCard(client, created.card.id)).find((task) => task.id === slotTask.id)!;
    const done = await invoke('PUT', `/api/tasks/${slotTask.id}`, { expectedVersion: relinked.version, status: 'done' });
    assert.equal(done.statusCode, 200, done.body);
    const prepareNow = (await listTasksByCard(client, created.card.id)).find((task) => task.id === prepare.id)!;
    const prepareOk = await invoke('PUT', `/api/tasks/${prepare.id}`, { expectedVersion: prepareNow.version, status: 'done' });
    assert.equal(prepareOk.statusCode, 200, prepareOk.body);
  });

  it('cards time dates the TBD event Card, re-dates its Tasks and re-timing moves the same invites', async () => {
    const google = holdGoogleProvider();
    setCalendarHoldGoogleDepsForTests({ fetchImpl: google.fetchImpl, credential: 'test', connectionId: 'orin' });
    const created = await createCourse(0);
    const qaCardId = created.eventSlots[0].cardId;

    const first = await invoke('POST', `/api/cards/${qaCardId}/time`, { at: '2026-11-10 17:00', guestEmails: ['alexey@datatalks.club'] });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(parsed(first).card.anchorDate, '2026-11-10');
    const invites = parsed(first).card.calendarInvites;
    for (const calendar of [HOLD_ORGANIZER, ...DEFAULT_HOLD_GOOGLE_CALENDARS]) {
      assert.ok(invites.some((invite: any) => invite.calendar === calendar), calendar);
    }
    let tasks = await listTasksByCard(client, qaCardId);
    const inviteTask = tasks.find((task) => task.templateTaskRef === 'create-calendar-invite')!;
    assert.equal(inviteTask.status, 'done', 'invite Task closes once both calendars have the invite');
    assert.equal(tasks.find((task) => task.templateTaskRef === 'run')!.date, '2026-11-10');

    const moved = await invoke('POST', `/api/cards/${qaCardId}/time`, { at: '2026-11-12 18:00' });
    assert.equal(moved.statusCode, 200, moved.body);
    assert.equal(parsed(moved).card.anchorDate, '2026-11-12');
    tasks = await listTasksByCard(client, qaCardId);
    assert.equal(tasks.find((task) => task.templateTaskRef === 'run')!.date, '2026-11-12');
    assert.equal(google.events.get(HOLD_ORGANIZER)!.size, 1, 're-timing never duplicates');
    assert.ok(!google.calls.some((call) => call.method === 'DELETE'), 'nothing is deleted');

    const courseTasks = parsed(await invoke('GET', `/api/cards/${created.card.id}/tasks`)).tasks;
    const linked = courseTasks.find((task: any) => task.templateTaskRef === 'pre-course-qa').linkedCard;
    assert.equal(linked.dateTbd, false);
    assert.equal(linked.eventStartIso, '2026-11-12T17:00:00.000Z');
    assert.deepEqual(linked.invites.map((invite: any) => invite.state), ['live', 'live']);
  });

  it('round-trips a link_card slot through authored YAML and rejects an empty slot', () => {
    const doc = {
      id: 'workflow.synthetic', type: 'synthetic', name: 'Synthetic', trigger_type: 'manual',
      tasks: [{ id: 'qa', name: 'Run the Q&A', schedule: { offset_days: -14 }, link_card: { template_type: 'webinar', slot: 'Pre-Course Live Q&A' } }],
    };
    const runtime = templateFromYaml(doc) as any;
    assert.deepEqual(runtime.taskDefinitions[0].linkCard, { templateType: 'webinar', slot: 'Pre-Course Live Q&A' });
    assert.deepEqual((templateToYaml(runtime).tasks as any[])[0].link_card, { template_type: 'webinar', slot: 'Pre-Course Live Q&A' });
    const bad = { ...doc, tasks: [{ ...doc.tasks[0], link_card: { template_type: 'webinar', slot: '' } }] };
    assert.ok(validateAuthoredTemplate(bad).some((issue: any) => /slot/.test(issue.message || String(issue))));
  });
});
