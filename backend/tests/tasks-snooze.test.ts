import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';

import { getClient } from '../src/db/client';
import { startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createTables } from '../scripts/local-dynamodb';
import { putEmptyTemplate } from './helpers/cardTemplate';
import { resolveTaskDate, berlinToday } from '../src/relativeDates';

describe('API — task snooze', () => {
  let port: number;
  let handler: typeof import('../src/handler').handler;

  before(async () => {
    port = await startLocal();
    await createTables(await getClient(port));
    await putEmptyTemplate(await getClient(port));
    process.env.IS_LOCAL = 'true';

    const mod = await import('../src/handler');
    handler = mod.handler;

    const warmUp = await handler({ httpMethod: 'GET', path: '/api/health' }, {});
    assert.strictEqual(warmUp.statusCode, 200);
  });

  after(async () => {
    await stopLocal();
    delete process.env.IS_LOCAL;
  });

  async function createTask(description = 'Snooze me', date = '2026-03-10') {
    const res = await handler({
      httpMethod: 'POST',
      path: '/api/tasks',
      body: JSON.stringify({ description, date }),
    }, {});
    assert.strictEqual(res.statusCode, 201);
    return JSON.parse(res.body);
  }

  it('creates a task with a relative date resolved against the Berlin today', async () => {
    const task = await createTask('Relative date', '+7d');
    assert.strictEqual(task.date, resolveTaskDate('+7d', berlinToday()));
  });

  it('snoozes with an absolute date, a reason, and history', async () => {
    const task = await createTask();
    const res = await handler({
      httpMethod: 'POST',
      path: `/api/tasks/${task.id}/actions/snooze`,
      body: JSON.stringify({ expectedVersion: task.version, snoozedUntil: '2026-04-01', reason: 'Waiting on sponsor' }),
    }, {});
    assert.strictEqual(res.statusCode, 200);
    const snoozed = JSON.parse(res.body);
    assert.strictEqual(snoozed.snoozedUntil, '2026-04-01');
    assert.strictEqual(snoozed.snoozeReason, 'Waiting on sponsor');
    assert.strictEqual(snoozed.status, 'todo');
    assert.strictEqual(snoozed.version, task.version + 1);
    const event = snoozed.taskHistory.at(-1);
    assert.strictEqual(event.action, 'snoozed');
    assert.strictEqual(event.followUpAt, '2026-04-01');
    assert.strictEqual(event.note, 'Waiting on sponsor');
  });

  it('snoozes with a relative date like +7d', async () => {
    const task = await createTask();
    const res = await handler({
      httpMethod: 'POST',
      path: `/api/tasks/${task.id}/actions/snooze`,
      body: JSON.stringify({ expectedVersion: task.version, snoozedUntil: '+7d', reason: 'Next week' }),
    }, {});
    assert.strictEqual(res.statusCode, 200);
    const snoozed = JSON.parse(res.body);
    assert.strictEqual(snoozed.snoozedUntil, resolveTaskDate('+7d', berlinToday()));
  });

  it('requires a reason and a resolvable date', async () => {
    const task = await createTask();
    const noReason = await handler({
      httpMethod: 'POST',
      path: `/api/tasks/${task.id}/actions/snooze`,
      body: JSON.stringify({ expectedVersion: task.version, snoozedUntil: '2026-04-01' }),
    }, {});
    assert.strictEqual(noReason.statusCode, 400);
    const badDate = await handler({
      httpMethod: 'POST',
      path: `/api/tasks/${task.id}/actions/snooze`,
      body: JSON.stringify({ expectedVersion: task.version, snoozedUntil: 'someday', reason: 'R' }),
    }, {});
    assert.strictEqual(badDate.statusCode, 400);
  });

  it('refuses to snooze a completed task', async () => {
    const task = await createTask();
    const done = await handler({
      httpMethod: 'PUT',
      path: `/api/tasks/${task.id}`,
      body: JSON.stringify({ expectedVersion: task.version, status: 'done' }),
    }, {});
    assert.strictEqual(done.statusCode, 200);
    const completed = JSON.parse(done.body);
    const res = await handler({
      httpMethod: 'POST',
      path: `/api/tasks/${task.id}/actions/snooze`,
      body: JSON.stringify({ expectedVersion: completed.version, snoozedUntil: '2026-04-01', reason: 'R' }),
    }, {});
    assert.strictEqual(res.statusCode, 400);
  });

  it('unsnoozes and returns the task to the queue', async () => {
    const task = await createTask();
    const snoozedRes = await handler({
      httpMethod: 'POST',
      path: `/api/tasks/${task.id}/actions/snooze`,
      body: JSON.stringify({ expectedVersion: task.version, snoozedUntil: '2026-04-01', reason: 'Later' }),
    }, {});
    const snoozed = JSON.parse(snoozedRes.body);
    const res = await handler({
      httpMethod: 'POST',
      path: `/api/tasks/${task.id}/actions/unsnooze`,
      body: JSON.stringify({ expectedVersion: snoozed.version }),
    }, {});
    assert.strictEqual(res.statusCode, 200);
    const back = JSON.parse(res.body);
    assert.strictEqual(back.snoozedUntil, undefined);
    assert.strictEqual(back.snoozeReason, undefined);
    assert.strictEqual(back.taskHistory.at(-1).action, 'unsnoozed');

    const again = await handler({
      httpMethod: 'POST',
      path: `/api/tasks/${task.id}/actions/unsnooze`,
      body: JSON.stringify({ expectedVersion: back.version }),
    }, {});
    assert.strictEqual(again.statusCode, 400);
  });
});
