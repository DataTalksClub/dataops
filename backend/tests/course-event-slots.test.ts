import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { handler } from '../src/handler';
import { getClient } from '../src/db/client';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { getCardConsistent, updateCard } from '../src/db/cards';
import { listTasksByCard } from '../src/db/tasks';
import { createTemplate } from '../src/db/templates';
import { DEFAULT_HOLD_GOOGLE_CALENDARS, PUBLIC_DTC_EVENTS_CALENDAR } from '../src/calendar/dapierBroker';
import { HOLD_ORGANIZER } from '../src/calendar/holdGoogleSync';
import { setCalendarHoldGoogleDepsForTests } from '../src/routes/calendarHolds';
import { templateFromYaml, templateToYaml, validateAuthoredTemplate } from '../src/templates/yamlTemplates';
import { holdGoogleProvider } from './helpers/hold-google';
import { configureTaskChecklistStore } from '../src/taskChecklist';
import { createTaskChecklistFixture } from './helpers/task-checklist-fixture';
import type { LambdaResponse } from '../src/types';

function invoke(method: string, path: string, body?: unknown, query: Record<string, string> = {}): Promise<LambdaResponse> {
  return handler({ httpMethod: method, path, body: body === undefined ? null : JSON.stringify(body), queryStringParameters: query }, {});
}
const parsed = (response: LambdaResponse): any => JSON.parse(response.body);

let client: DynamoDBDocumentClient;
let courseTemplateId: string;
let checklistFixture: ReturnType<typeof createTaskChecklistFixture>;

describe('course event slots: event Cards instead of text', () => {
  before(async () => {
    checklistFixture = createTaskChecklistFixture();
    configureTaskChecklistStore(checklistFixture.store);
    client = await getClient(await startLocal());
    await createTables(client);
    await createTemplate(client, {
      name: 'Synthetic course event', type: 'synthetic-course-event', triggerType: 'manual',
      cardLinkDefinitions: [{ name: 'Luma' }],
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
          refId: 'launch', description: 'Run Launch', offsetDays: 0, optionalGroup: 'live-events',
          linkCard: { templateType: 'synthetic-course-event', slot: 'Launch' },
        },
        {
          refId: 'office-hours', description: 'Run office hours', offsetDays: -3, optionalGroup: 'live-events',
          linkCard: { templateType: 'synthetic-course-event', slot: 'Office Hours' },
        },
        {
          refId: 'workshop', description: 'Workshop {n}', offsetDays: -21, repeat: { countField: 'workshops' },
          linkCard: { templateType: 'synthetic-slot-workshop', slot: 'Workshop {n}' },
        },
      ],
    } as any)).id;
  });
  after(async () => {
    setCalendarHoldGoogleDepsForTests({});
    configureTaskChecklistStore(null);
    checklistFixture.cleanup();
    await stopLocal();
  });

  async function createCourse(workshops = 1, optionalGroups: string[] = []) {
    const response = await invoke('POST', '/api/cards', {
      templateId: courseTemplateId, title: 'Gen Media 2026', anchorDate: '2026-11-16', counts: { workshops }, optionalGroups,
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
    assert.deepEqual(slotTask.linkedCard.invites.map((invite: any) => invite.state), ['missing']);

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
    assert.deepEqual(linked.invites.map((invite: any) => invite.state), ['live']);
  });

  it('times a Luma cohort event onto the DTC events, Orin and Alexey personal calendars, attendee-free and idempotently', async () => {
    const google = holdGoogleProvider();
    setCalendarHoldGoogleDepsForTests({ fetchImpl: google.fetchImpl, credential: 'test', connectionId: 'orin' });
    try {
      const created = await createCourse(0, ['live-events']);
      const qaCardId = created.eventSlots.find((slot: any) => slot.slot === 'Pre-Course Live Q&A').cardId;
      const launchCardId = created.eventSlots.find((slot: any) => slot.slot === 'Launch').cardId;
      const officeHoursCardId = created.eventSlots.find((slot: any) => slot.slot === 'Office Hours').cardId;
      const launchCard = (await getCardConsistent(client, launchCardId))!;
      google.events.set(PUBLIC_DTC_EVENTS_CALENDAR, new Map([['manual-launch-dtc', {
        id: 'manual-launch-dtc', status: 'confirmed', summary: launchCard.title,
        description: 'Subtitle\nStream: https://www.youtube.com/datatalksclub\nLuma: https://luma.com/production-ai-agents-launch',
        location: 'https://www.youtube.com/datatalksclub',
        start: { dateTime: '2026-11-16T16:00:00.000Z', timeZone: 'Europe/Berlin' },
        end: { dateTime: '2026-11-16T17:00:00.000Z', timeZone: 'Europe/Berlin' },
      }]]));
      await updateCard(client, launchCardId, {
        expectedVersion: launchCard.version,
        patch: { calendarInvites: [{ eventId: 'deleted-old-launch', calendar: PUBLIC_DTC_EVENTS_CALENDAR, staleAt: '2026-11-02T00:00:00.000Z' }] },
      });
      let courseTasks = await listTasksByCard(client, created.card.id);
      let qaTask = courseTasks.find((task) => task.templateTaskRef === 'pre-course-qa')!;
      const lumaLink = await invoke('PUT', `/api/tasks/${qaTask.id}`, {
        expectedVersion: qaTask.version, link: 'https://lu.ma/production-ai-agents-qa',
      });
      assert.equal(lumaLink.statusCode, 200, lumaLink.body);
      courseTasks = await listTasksByCard(client, created.card.id);
      qaTask = courseTasks.find((task) => task.templateTaskRef === 'pre-course-qa')!;
      const launchTask = courseTasks.find((task) => task.templateTaskRef === 'launch')!;
      const launchLink = await invoke('PUT', `/api/tasks/${launchTask.id}`, {
        expectedVersion: launchTask.version, link: 'https://luma.com/production-ai-agents-launch',
      });
      assert.equal(launchLink.statusCode, 200, launchLink.body);
      courseTasks = await listTasksByCard(client, created.card.id);
      qaTask = courseTasks.find((task) => task.templateTaskRef === 'pre-course-qa')!;
      const prepare = courseTasks.find((task) => task.templateTaskRef === 'prepare-events')!;
      const slotDone = await invoke('PUT', `/api/tasks/${qaTask.id}`, { expectedVersion: qaTask.version, status: 'done' });
      assert.equal(slotDone.statusCode, 200, slotDone.body);

      const missing = await invoke('PUT', `/api/tasks/${prepare.id}`, { expectedVersion: prepare.version, status: 'done' });
      assert.equal(missing.statusCode, 400, missing.body);
      assert.match(parsed(missing).error, /calendar entries.*alexey\.s\.grigoriev@gmail\.com/i);

      const first = await invoke('POST', `/api/cards/${qaCardId}/time`, { at: '2026-11-10 17:00' });
      assert.equal(first.statusCode, 200, first.body);
      assert.equal(parsed(first).invite.outcome, 'synced');
      // The cohort event lands on the DTC events calendar, Orin and Alexey personal.
      assert.deepEqual(parsed(first).card.calendarInvites.map((invite: any) => invite.calendar),
        [PUBLIC_DTC_EVENTS_CALENDAR, HOLD_ORGANIZER, ...DEFAULT_HOLD_GOOGLE_CALENDARS]);
      assert.deepEqual(Object.keys(parsed(first).card.eventTime.googleEventIds),
        [PUBLIC_DTC_EVENTS_CALENDAR, HOLD_ORGANIZER, ...DEFAULT_HOLD_GOOGLE_CALENDARS]);
      for (const calendar of [PUBLIC_DTC_EVENTS_CALENDAR, HOLD_ORGANIZER, ...DEFAULT_HOLD_GOOGLE_CALENDARS]) {
        const event = [...google.events.get(calendar)!.values()].find((item) => item.summary === 'Gen Media 2026: Pre-Course Live Q&A');
        assert.ok(event, `Q&A event exists on ${calendar}`);
        assert.equal(event.summary, 'Gen Media 2026: Pre-Course Live Q&A');
        assert.match(event.description, /Luma: https:\/\/lu\.ma\/production-ai-agents-qa/);
        assert.match(event.description, /Stream: https:\/\/www\.youtube\.com\/datatalksclub/);
        assert.equal(event.location, 'https://www.youtube.com/datatalksclub');
        // Public entry and organizer copy stay attendee-free; each personal
        // copy lists only its own calendar (the Google import constraint).
        if (DEFAULT_HOLD_GOOGLE_CALENDARS.includes(calendar as never)) {
          assert.deepEqual(event.attendees, [{ email: calendar }]);
        } else {
          assert.deepEqual(event.attendees || [], [], 'public and organizer entries never contain guests');
        }
        assert.ok(!/zoom/i.test(JSON.stringify(event)), 'cohort event entries carry no Zoom details');
      }
      assert.ok(!google.calls.some((call) => call.method === 'PATCH' && call.url.searchParams.get('sendUpdates') === 'all'),
        'silent cohort copies never send updates');
      const imports = google.calls.filter((call) => call.method === 'POST' && call.url.pathname.endsWith('/events/import'));
      assert.equal(imports.length, 2, 'personal copies use the silent import path');
      assert.ok(imports.every((call) => !call.url.searchParams.has('sendUpdates')), 'Google import never sends invitations');

      const retry = await invoke('POST', `/api/cards/${qaCardId}/time`, { at: '2026-11-10 17:00' });
      assert.equal(retry.statusCode, 200, retry.body);
      assert.equal(google.events.get(PUBLIC_DTC_EVENTS_CALENDAR)!.size, 2, 'retry does not add a duplicate public event');
      assert.equal(google.events.get(HOLD_ORGANIZER)!.size, 1, 'retry does not add a duplicate organizer copy');
      assert.equal(google.events.get(DEFAULT_HOLD_GOOGLE_CALENDARS[0])!.size, 1, 'retry does not add a duplicate personal copy');

      const stillMissingLaunch = await invoke('PUT', `/api/tasks/${prepare.id}`, { expectedVersion: prepare.version, status: 'done' });
      assert.equal(stillMissingLaunch.statusCode, 400, stillMissingLaunch.body);
      assert.match(parsed(stillMissingLaunch).error, /Launch is missing live calendar entries/i);
      const launchTime = await invoke('POST', `/api/cards/${launchCardId}/time`, { at: '2026-11-16 17:00' });
      assert.equal(launchTime.statusCode, 200, launchTime.body);
      assert.equal(parsed(launchTime).card.eventTime.googleEventIds[PUBLIC_DTC_EVENTS_CALENDAR], 'manual-launch-dtc');
      assert.deepEqual(Object.keys(parsed(launchTime).card.eventTime.googleEventIds).sort(),
        [HOLD_ORGANIZER, PUBLIC_DTC_EVENTS_CALENDAR, ...DEFAULT_HOLD_GOOGLE_CALENDARS].sort());
      assert.ok(parsed(launchTime).card.calendarInvites.some((invite: any) => invite.eventId === 'manual-launch-dtc'));
      assert.ok(parsed(launchTime).card.calendarInvites.some((invite: any) => invite.calendar === DEFAULT_HOLD_GOOGLE_CALENDARS[0]),
        'the Launch also lands on Alexey personal');
      assert.equal(google.events.get(PUBLIC_DTC_EVENTS_CALENDAR)!.size, 2, 'cards time adopts the existing public entry instead of adding a duplicate');
      const repeatLaunchTime = await invoke('POST', `/api/cards/${launchCardId}/time`, { at: '2026-11-16 17:00' });
      assert.equal(repeatLaunchTime.statusCode, 200, repeatLaunchTime.body);
      assert.equal(google.events.get(PUBLIC_DTC_EVENTS_CALENDAR)!.size, 2, 'retry keeps the adopted public entry');
      const duplicateLaunch = await invoke('POST', `/api/cards/${launchCardId}/time`, { at: '2026-11-16 17:00' });
      assert.equal(duplicateLaunch.statusCode, 200, duplicateLaunch.body);
      assert.equal(google.events.get(PUBLIC_DTC_EVENTS_CALENDAR)!.size, 2);

      courseTasks = await listTasksByCard(client, created.card.id);
      const officeHoursTask = courseTasks.find((task) => task.templateTaskRef === 'office-hours')!;
      const officeHoursLink = await invoke('PUT', `/api/tasks/${officeHoursTask.id}`, {
        expectedVersion: officeHoursTask.version, link: 'https://luma.com/production-ai-agents-office-hours',
      });
      assert.equal(officeHoursLink.statusCode, 200, officeHoursLink.body);
      const stillMissingOfficeHours = await invoke('PUT', `/api/tasks/${prepare.id}`, { expectedVersion: prepare.version, status: 'done' });
      assert.equal(stillMissingOfficeHours.statusCode, 400, stillMissingOfficeHours.body);
      assert.match(parsed(stillMissingOfficeHours).error, /Office Hours is missing live calendar entries/i);
      const officeHoursTime = await invoke('POST', `/api/cards/${officeHoursCardId}/time`, { at: '2026-11-14 17:00' });
      assert.equal(officeHoursTime.statusCode, 200, officeHoursTime.body);
      assert.deepEqual(parsed(officeHoursTime).card.calendarInvites.map((invite: any) => invite.calendar),
        [PUBLIC_DTC_EVENTS_CALENDAR, HOLD_ORGANIZER, ...DEFAULT_HOLD_GOOGLE_CALENDARS]);
      for (const calendar of [PUBLIC_DTC_EVENTS_CALENDAR, HOLD_ORGANIZER, ...DEFAULT_HOLD_GOOGLE_CALENDARS]) {
        assert.ok([...google.events.get(calendar)!.values()].some((item) => item.summary === 'Gen Media 2026: Office Hours'),
          `office hours event exists on ${calendar}`);
      }

      const eventCard = (await getCardConsistent(client, qaCardId))!;
      const dtcEventId = eventCard.eventTime!.googleEventIds[PUBLIC_DTC_EVENTS_CALENDAR];
      const dtcEvent = google.events.get(PUBLIC_DTC_EVENTS_CALENDAR)!.get(dtcEventId)!;
      dtcEvent.status = 'cancelled';
      const verifiedStale = await invoke('GET', `/api/cards/${qaCardId}/calendar-invites`, undefined, { verify: '1' });
      assert.ok(parsed(verifiedStale).invites.find((invite: any) => invite.eventId === dtcEventId).staleAt);
      dtcEvent.status = 'confirmed';

      const moved = await invoke('POST', `/api/cards/${qaCardId}/time`, { at: '2026-11-11 17:00' });
      assert.equal(moved.statusCode, 200, moved.body);
      assert.deepEqual(Object.keys(parsed(moved).card.eventTime.googleEventIds),
        [PUBLIC_DTC_EVENTS_CALENDAR, HOLD_ORGANIZER, ...DEFAULT_HOLD_GOOGLE_CALENDARS]);
      assert.ok(!parsed(moved).card.calendarInvites.find((invite: any) => invite.eventId === dtcEventId),
        'a cancelled public copy is replaced without retaining a stale duplicate row');
      assert.equal(google.events.get(PUBLIC_DTC_EVENTS_CALENDAR)!.size, 4);
      assert.equal(google.events.get(HOLD_ORGANIZER)!.size, 3, 'moving updates the organizer copy in place instead of duplicating');
      assert.equal(google.events.get(DEFAULT_HOLD_GOOGLE_CALENDARS[0])!.size, 3, 'moving updates the personal copy in place instead of duplicating');
      assert.ok(google.calls.filter((call) => call.method === 'PATCH').every((call) => call.url.searchParams.get('sendUpdates') === 'none'));

      courseTasks = await listTasksByCard(client, created.card.id);
      const latestPrepare = courseTasks.find((task) => task.templateTaskRef === 'prepare-events')!;
      const complete = await invoke('PUT', `/api/tasks/${latestPrepare.id}`, { expectedVersion: latestPrepare.version, status: 'done' });
      assert.equal(complete.statusCode, 200, complete.body);
    } finally {
      setCalendarHoldGoogleDepsForTests({});
    }
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
