import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { handler } from '../src/handler';
import { getClient } from '../src/db/client';
import { startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createTables } from '../scripts/local-dynamodb';
import { getCard } from '../src/db/cards';
import { listTasksByCard } from '../src/db/tasks';
import { createTemplate } from '../src/db/templates';
import {
  expandTaskDefinitions,
  parseRepeatInstanceRef,
} from '../src/templates/repeatedTasks';
import {
  templateFromYaml,
  templateToYaml,
  validateAuthoredTemplate,
} from '../src/templates/yamlTemplates';
import type { LambdaResponse, TaskDefinition, Template } from '../src/types';

function invoke(method: string, path: string, body?: unknown): Promise<LambdaResponse> {
  return handler({
    httpMethod: method,
    path,
    headers: { 'x-user-id': 'operator-repeated-tasks' },
    body: body === undefined ? null : JSON.stringify(body),
  }, {});
}

function parsed(response: LambdaResponse): any {
  return JSON.parse(response.body);
}

const WORKSHOP_GROUP: TaskDefinition[] = [
  { refId: 'kickoff', description: 'Kick off the launch', offsetDays: -30 },
  {
    refId: 'workshop',
    description: 'Workshop {n}',
    offsetDays: -14,
    repeat: { countField: 'workshops' },
    linkCard: { templateType: 'workshop-synthetic' },
  },
  {
    refId: 'workshop-promo',
    description: 'Promote workshop {n}',
    offsetDays: -10,
    repeat: { countField: 'workshops' },
    dependsOn: ['workshop'],
  },
  { refId: 'launch', description: 'Launch stream', offsetDays: 0, dependsOn: ['kickoff'] },
];

describe('repeated task expansion', () => {
  it('numbers each group instance, interleaves the group and keeps orders stable as the count grows', () => {
    const two = expandTaskDefinitions(WORKSHOP_GROUP, { workshops: 2 });
    assert.deepEqual(two.map(({ refId }) => refId), [
      'kickoff', 'workshop#1', 'workshop-promo#1', 'workshop#2', 'workshop-promo#2', 'launch',
    ]);
    assert.deepEqual(two.map(({ description }) => description).slice(1, 3), ['Workshop 1', 'Promote workshop 1']);
    assert.deepEqual(two.find(({ refId }) => refId === 'workshop-promo#2')!.dependsOn, ['workshop#2']);
    assert.deepEqual(two.find(({ refId }) => refId === 'launch')!.dependsOn, ['kickoff']);
    const three = expandTaskDefinitions(WORKSHOP_GROUP, { workshops: 3 });
    const orders = new Map(three.map(({ refId, order }) => [refId, order]));
    for (const definition of two) assert.equal(orders.get(definition.refId), definition.order, definition.refId);
    const sorted = [...three].sort((left, right) => left.order! - right.order!);
    assert.deepEqual(sorted.map(({ refId }) => refId), three.map(({ refId }) => refId));
    assert.deepEqual(expandTaskDefinitions(WORKSHOP_GROUP, { workshops: 0 }).map(({ refId }) => refId), ['kickoff', 'launch']);
    assert.deepEqual(
      expandTaskDefinitions(WORKSHOP_GROUP, { workshops: 1 }, new Map([['workshops', new Set([3])]]))
        .map(({ refId }) => refId),
      ['kickoff', 'workshop#1', 'workshop-promo#1', 'workshop#3', 'workshop-promo#3', 'launch'],
    );
    assert.equal(expandTaskDefinitions([{ refId: 'w', description: 'Workshop', offsetDays: 0, repeat: { countField: 'w' } }], { w: 1 })[0].description, 'Workshop 1');
    assert.deepEqual(parseRepeatInstanceRef('workshop-promo#12'), { refId: 'workshop-promo', index: 12 });
    assert.equal(parseRepeatInstanceRef('workshop'), null);
  });

  it('round-trips count_fields, repeat and link_card through authored YAML and validates them', () => {
    const doc = {
      type: 'course-synthetic',
      name: 'Course',
      trigger: { mode: 'manual' },
      count_fields: [{ id: 'workshops', label: 'Number of workshops', default: 2, min: 0, max: 10 }],
      tasks: [
        { id: 'workshop', name: 'Workshop {n}', schedule: { offset_days: -14 }, repeat: { count_field: 'workshops' }, link_card: { template_type: 'workshop' } },
      ],
    };
    assert.deepEqual(validateAuthoredTemplate(doc), []);
    const runtime = templateFromYaml(doc);
    assert.deepEqual(runtime.countFields, [{ id: 'workshops', label: 'Number of workshops', default: 2, min: 0, max: 10 }]);
    assert.deepEqual((runtime.taskDefinitions as any[])[0].repeat, { countField: 'workshops' });
    assert.deepEqual((runtime.taskDefinitions as any[])[0].linkCard, { templateType: 'workshop' });
    assert.deepEqual(templateToYaml(runtime), { ...doc, tasks: [{ ...doc.tasks[0] }] });

    const messages = (value: Record<string, unknown>) => validateAuthoredTemplate(value).map(({ message }) => message);
    assert.match(messages({ ...doc, tasks: [{ ...doc.tasks[0], repeat: { count_field: 'speakers' } }] }).join('\n'), /unknown count field 'speakers'/);
    assert.match(messages({ ...doc, count_fields: [{ id: 'workshops', label: 'N', default: 20, min: 0, max: 10 }] }).join('\n'), /min <= default <= max/);
    assert.match(messages({ ...doc, tasks: [...doc.tasks, { id: 'wrap', name: 'Wrap up', schedule: { offset_days: 5 }, depends_on: ['workshop'] }] }).join('\n'), /depends on repeated task 'workshop'/);
    assert.match(messages({ ...doc, tasks: [{ ...doc.tasks[0], id: 'a#1' }] }).join('\n'), /must not contain '#'/);
  });
});

describe('API — count-driven repeated tasks and task card links', () => {
  let client: DynamoDBDocumentClient;
  let course: Template;
  let workshop: Template;

  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
    workshop = await createTemplate(client, {
      name: 'Synthetic workshop',
      type: 'workshop-synthetic',
      taskDefinitions: [{ refId: 'host', description: 'Host workshop', offsetDays: 0 }],
    });
    course = await createTemplate(client, {
      name: 'Synthetic course',
      type: `course-synthetic-${crypto.randomUUID()}`,
      countFields: [{ id: 'workshops', label: 'Number of workshops', default: 1, min: 0, max: 10 }],
      taskDefinitions: WORKSHOP_GROUP,
    });
  });

  after(async () => {
    await stopLocal();
  });

  async function createCourse(counts?: Record<string, number>) {
    const response = await invoke('POST', '/api/cards', {
      title: 'Synthetic course launch', anchorDate: '2026-11-16', templateId: course.id, ...(counts ? { counts } : {}),
    });
    assert.equal(response.statusCode, 201, response.body);
    return parsed(response);
  }

  async function createWorkshop(title: string) {
    const response = await invoke('POST', '/api/cards', { title, anchorDate: '2026-11-03', templateId: workshop.id });
    assert.equal(response.statusCode, 201, response.body);
    return parsed(response).card;
  }

  async function changeCount(cardId: string, workshops: number) {
    const path = `/api/cards/${cardId}/template-update`;
    const previewResponse = await invoke('POST', path, { previewOnly: true, counts: { workshops } });
    assert.equal(previewResponse.statusCode, 200, previewResponse.body);
    const preview = parsed(previewResponse).preview;
    const applied = await invoke('POST', path, { previewToken: preview.previewToken, counts: { workshops } });
    assert.equal(applied.statusCode, 200, applied.body);
    return { preview, result: parsed(applied) };
  }

  it('creates the counted instances and validates counts', async () => {
    const created = await createCourse({ workshops: 2 });
    assert.deepEqual(created.card.counts, { workshops: 2 });
    assert.equal(created.card.taskCount, 6);
    assert.deepEqual(created.tasks.map((task: any) => task.description), [
      'Kick off the launch', 'Workshop 1', 'Promote workshop 1', 'Workshop 2', 'Promote workshop 2', 'Launch stream',
    ]);
    const promo2 = created.tasks.find((task: any) => task.templateTaskRef === 'workshop-promo#2');
    const workshop2 = created.tasks.find((task: any) => task.templateTaskRef === 'workshop#2');
    assert.deepEqual(promo2.dependsOn, [workshop2.id]);
    const defaulted = await createCourse();
    assert.deepEqual(defaulted.card.counts, { workshops: 1 });
    for (const counts of [{ workshops: 11 }, { workshops: 1.5 }, { speakers: 1 }]) {
      const response = await invoke('POST', '/api/cards', {
        title: 'Bad', anchorDate: '2026-11-16', templateId: course.id, counts,
      });
      assert.equal(response.statusCode, 400, JSON.stringify(counts));
    }
  });

  it('raises a count by adding the missing instances, and lowers it removing only unlinked open extras', async () => {
    const created = await createCourse({ workshops: 1 });
    const cardId = created.card.id;

    const raised = await changeCount(cardId, 4);
    assert.equal(raised.preview.counts.added, 6);
    assert.deepEqual(raised.preview.currentCounts, { workshops: 1 });
    assert.deepEqual(raised.preview.targetCounts, { workshops: 4 });
    assert.equal(raised.preview.taskChanges.filter((change: any) => change.action === 'update').length, 0, 'existing Tasks keep their order');
    assert.deepEqual(raised.result.card.counts, { workshops: 4 });
    assert.equal(raised.result.card.taskCount, 10);

    const tasks = await listTasksByCard(client, cardId);
    const byRef = new Map(tasks.map((task) => [task.templateTaskRef, task]));
    // Workshop 3 links a Card; promote workshop 4 is done; workshop 2 is open and unlinked.
    const workshopCard = await createWorkshop('Workshop three card');
    const linked = await invoke('POST', `/api/tasks/${byRef.get('workshop#3')!.id}/actions/link-card`, {
      expectedVersion: byRef.get('workshop#3')!.version, cardId: workshopCard.id,
    });
    assert.equal(linked.statusCode, 200, linked.body);
    const done = await invoke('PUT', `/api/tasks/${byRef.get('workshop#4')!.id}`, {
      expectedVersion: byRef.get('workshop#4')!.version, status: 'done',
    });
    assert.equal(done.statusCode, 200, done.body);

    const path = `/api/cards/${cardId}/template-update`;
    const preview = parsed(await invoke('POST', path, { previewOnly: true, counts: { workshops: 1 } })).preview;
    const removed = preview.taskChanges.filter((change: any) => change.action === 'remove').map((change: any) => change.taskRef);
    assert.deepEqual(removed.sort(), ['workshop#2', 'workshop-promo#2']);
    assert.equal((await listTasksByCard(client, cardId)).length, 10, 'preview performs no writes');

    const lowered = await changeCount(cardId, 1);
    assert.deepEqual(lowered.result.card.counts, { workshops: 1 });
    assert.equal(lowered.result.card.taskCount, 8);
    const after = await listTasksByCard(client, cardId);
    assert.deepEqual(after.map((task) => task.templateTaskRef).sort(), [
      'kickoff', 'launch', 'workshop#1', 'workshop#3', 'workshop#4', 'workshop-promo#1', 'workshop-promo#3', 'workshop-promo#4',
    ]);
    const card = (await getCard(client, cardId))!;
    assert.equal(card.openTaskCount, after.filter((task) => task.status === 'todo' || task.status === 'waiting').length);
    assert.ok(!card.templateDefinitionSnapshot.taskRefs.includes('workshop#2'));

    // Raising again brings Workshop 2 back; 3 and 4 are already there.
    const again = await changeCount(cardId, 2);
    assert.deepEqual(again.preview.taskChanges.filter((change: any) => change.action === 'add').map((change: any) => change.taskRef).sort(), ['workshop#2', 'workshop-promo#2']);
    assert.equal(again.result.card.taskCount, 10);
  });

  it('links a Task to a Card, shows the link both ways, and guards deleting the linked Card', async () => {
    const created = await createCourse({ workshops: 1 });
    const task = created.tasks.find((candidate: any) => candidate.templateTaskRef === 'workshop#1');
    const target = await createWorkshop('Linked workshop card');

    const wrongType = await invoke('POST', `/api/tasks/${task.id}/actions/link-card`, {
      expectedVersion: task.version, cardId: created.card.id,
    });
    assert.equal(wrongType.statusCode, 400, 'own Card');
    const otherCourse = await createCourse({ workshops: 0 });
    const typed = await invoke('POST', `/api/tasks/${task.id}/actions/link-card`, {
      expectedVersion: task.version, cardId: otherCourse.card.id,
    });
    assert.equal(typed.statusCode, 422, typed.body);

    const linkedResponse = await invoke('POST', `/api/tasks/${task.id}/actions/link-card`, {
      expectedVersion: task.version, cardId: target.id,
    });
    assert.equal(linkedResponse.statusCode, 200, linkedResponse.body);
    const linked = parsed(linkedResponse);
    assert.equal(linked.linkedCardId, target.id);
    assert.equal(linked.linkedCard.title, 'Linked workshop card');
    assert.equal(linked.linkedCard.status, 'active');
    assert.equal(linked.linkedCard.url, `/cards?cardId=${target.id}`);

    const cardTasks = parsed(await invoke('GET', `/api/cards/${created.card.id}/tasks`)).tasks;
    assert.equal(cardTasks.find((candidate: any) => candidate.id === task.id).linkedCard.id, target.id);
    const targetView = parsed(await invoke('GET', `/api/cards/${target.id}`)).card;
    assert.deepEqual(targetView.linkedFrom.map((ref: any) => [ref.taskId, ref.cardId, ref.cardTitle, ref.taskDescription]), [
      [task.id, created.card.id, 'Synthetic course launch', 'Workshop 1'],
    ]);

    const second = await createCourse({ workshops: 1 });
    const secondTask = second.tasks.find((candidate: any) => candidate.templateTaskRef === 'workshop#1');
    const taken = await invoke('POST', `/api/tasks/${secondTask.id}/actions/link-card`, {
      expectedVersion: secondTask.version, cardId: target.id,
    });
    assert.equal(taken.statusCode, 409);
    assert.equal(parsed(taken).code, 'card-already-linked');

    const targetCard = (await getCard(client, target.id))!;
    const blocked = await invoke('DELETE', `/api/cards/${target.id}`, { expectedVersion: targetCard.version });
    assert.equal(blocked.statusCode, 409, blocked.body);
    assert.equal(parsed(blocked).code, 'card_has_references');
    assert.deepEqual(parsed(blocked).references.linkingTasks, [task.id]);

    const unlinked = await invoke('POST', `/api/tasks/${task.id}/actions/link-card`, {
      expectedVersion: linked.version, cardId: null,
    });
    assert.equal(unlinked.statusCode, 200, unlinked.body);
    assert.equal(parsed(unlinked).linkedCardId, undefined);
    const cleared = (await getCard(client, target.id))!;
    assert.equal(cleared.linkedFrom, undefined);
    const deleted = await invoke('DELETE', `/api/cards/${target.id}`, { expectedVersion: cleared.version });
    assert.equal(deleted.statusCode, 200, deleted.body);
  });
});
