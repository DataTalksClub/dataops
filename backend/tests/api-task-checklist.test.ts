import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { handler } from '../src/handler';
import { getClient } from '../src/db/client';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { configureTaskChecklistStore } from '../src/taskChecklist';
import { createTaskChecklistFixture } from './helpers/task-checklist-fixture';

describe('ad-hoc Task checklists', () => {
  let port: number;
  let checklistFixture: ReturnType<typeof createTaskChecklistFixture>;

  before(async () => {
    checklistFixture = createTaskChecklistFixture();
    configureTaskChecklistStore(checklistFixture.store);
    port = await startLocal();
    await createTables(await getClient(port));
    process.env.IS_LOCAL = 'true';
  });

  after(async () => {
    configureTaskChecklistStore(null);
    checklistFixture.cleanup();
    await stopLocal();
    delete process.env.IS_LOCAL;
  });

  async function invoke(method: string, path: string, body?: unknown) {
    return handler({
      httpMethod: method,
      path,
      headers: { 'x-user-id': 'checklist-operator' },
      body: body === undefined ? null : JSON.stringify(body),
    }, {});
  }

  it('copies checklist SOP links, supports check/uncheck, and blocks done while rows are open', async () => {
    const createdResponse = await invoke('POST', '/api/tasks', {
      description: 'Move event details to the new date',
      date: '2026-11-10',
      checklistDocId: 'checklist.events.rescheduling.checklist-document-for-rescheduling-events',
      inlineChecklistItems: ['Confirm the updated event time'],
    });
    assert.equal(createdResponse.statusCode, 201, createdResponse.body);
    let task = JSON.parse(createdResponse.body);
    assert.equal(task.cardId, undefined);
    assert.deepEqual(task.checklistItems.map((item: any) => item.instructionDocId), [
      'sop.test.review-event-details',
      'sop.test.notify-participants',
      undefined,
    ]);
    assert.ok(task.sourceDocIds.includes(task.checklistDocId));

    const blocked = await invoke('PUT', `/api/tasks/${task.id}`, {
      expectedVersion: task.version,
      status: 'done',
    });
    assert.equal(blocked.statusCode, 400);
    assert.match(JSON.parse(blocked.body).error, /0\/3 checklist items/);

    const checked = await invoke('POST', `/api/tasks/${task.id}/actions/checklist-check`, {
      expectedVersion: task.version,
      itemId: 'kb-1',
      link: 'https://example.test/event-details',
      note: 'Verified the new date and time',
    });
    assert.equal(checked.statusCode, 200, checked.body);
    task = JSON.parse(checked.body);
    assert.equal(task.checklistItems[0].checked, true);
    assert.equal(task.checklistItems[0].link, 'https://example.test/event-details');
    assert.equal(task.checklistItems[0].checkedBy, 'checklist-operator');
    assert.equal(task.taskHistory.at(-1).checklistItemId, 'kb-1');

    const stale = await invoke('POST', `/api/tasks/${task.id}/actions/checklist-uncheck`, {
      expectedVersion: task.version - 1,
      itemId: 'kb-1',
    });
    assert.equal(stale.statusCode, 409);

    const unchecked = await invoke('POST', `/api/tasks/${task.id}/actions/checklist-uncheck`, {
      expectedVersion: task.version,
      itemId: 'kb-1',
    });
    assert.equal(unchecked.statusCode, 200, unchecked.body);
    task = JSON.parse(unchecked.body);
    assert.equal(task.checklistItems[0].checked, false);
    assert.equal(task.checklistItems[0].link, undefined);
    assert.equal(task.checklistItems[0].note, undefined);
    assert.equal(task.checklistItems[0].checkedAt, undefined);

    for (const item of task.checklistItems) {
      const response = await invoke('POST', `/api/tasks/${task.id}/actions/checklist-check`, {
        expectedVersion: task.version,
        itemId: item.id,
      });
      assert.equal(response.statusCode, 200, response.body);
      task = JSON.parse(response.body);
    }
    const completed = await invoke('PUT', `/api/tasks/${task.id}`, {
      expectedVersion: task.version,
      status: 'done',
    });
    assert.equal(completed.statusCode, 200, completed.body);
    assert.equal(JSON.parse(completed.body).status, 'done');
  });

  it('requires and records a reason for force-completing open checklist rows', async () => {
    const created = await invoke('POST', '/api/tasks', {
      description: 'Review an event change',
      date: '2026-11-10',
      inlineChecklistItems: ['Review the event change'],
    });
    assert.equal(created.statusCode, 201, created.body);
    const task = JSON.parse(created.body);

    const missingReason = await invoke('PUT', `/api/tasks/${task.id}`, {
      expectedVersion: task.version,
      status: 'done',
      force: true,
    });
    assert.equal(missingReason.statusCode, 400);
    assert.match(JSON.parse(missingReason.body).error, /--force requires.*--reason/);

    const forced = await invoke('PUT', `/api/tasks/${task.id}`, {
      expectedVersion: task.version,
      status: 'done',
      force: true,
      reason: 'The event was cancelled before these steps applied',
    });
    assert.equal(forced.statusCode, 200, forced.body);
    const result = JSON.parse(forced.body);
    assert.equal(result.status, 'done');
    assert.match(result.taskHistory.at(-1).note, /The event was cancelled/);
  });

  it('blocks resolving a waiting Task with open rows unless a reasoned force is supplied', async () => {
    const created = await invoke('POST', '/api/tasks', {
      description: 'Resume the event update',
      date: '2026-11-10',
      inlineChecklistItems: ['Review the new event date'],
    });
    const task = JSON.parse(created.body);
    const waiting = await invoke('POST', `/api/tasks/${task.id}/actions/mark-waiting`, {
      expectedVersion: task.version,
      waitingFor: 'Organizer confirmation',
      channel: 'email',
      followUpAt: '2026-11-12',
      note: 'Asked the organizer to confirm the change',
    });
    assert.equal(waiting.statusCode, 200, waiting.body);
    const waitingTask = JSON.parse(waiting.body);

    const blocked = await invoke('POST', `/api/tasks/${task.id}/actions/resolve-done`, {
      expectedVersion: waitingTask.version,
      note: 'Organizer replied',
    });
    assert.equal(blocked.statusCode, 400);
    assert.match(JSON.parse(blocked.body).error, /0\/1 checklist items/);

    const forced = await invoke('POST', `/api/tasks/${task.id}/actions/resolve-done`, {
      expectedVersion: waitingTask.version,
      note: 'Organizer replied',
      force: true,
      reason: 'The event was cancelled before this step applied',
    });
    assert.equal(forced.statusCode, 200, forced.body);
    const result = JSON.parse(forced.body);
    assert.equal(result.status, 'done');
    assert.match(result.taskHistory.at(-1).note, /The event was cancelled/);
  });
});
