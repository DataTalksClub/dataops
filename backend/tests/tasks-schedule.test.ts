import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';

import { getClient } from '../src/db/client';
import { startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createTables } from '../scripts/local-dynamodb';
import { putEmptyTemplate } from './helpers/cardTemplate';

describe('API — task not-before datetimes', () => {
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

  async function createTask(body: Record<string, unknown> = {}) {
    const res = await handler({
      httpMethod: 'POST',
      path: '/api/tasks',
      body: JSON.stringify({ description: 'Timed task', date: '2026-03-10', ...body }),
    }, {});
    assert.strictEqual(res.statusCode, 201);
    return JSON.parse(res.body);
  }

  async function putTask(task: { id: string; version: number }, body: Record<string, unknown>) {
    const res = await handler({
      httpMethod: 'PUT',
      path: `/api/tasks/${task.id}`,
      body: JSON.stringify({ expectedVersion: task.version, ...body }),
    }, {});
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  }

  it('stores a civil datetime in the given timezone as UTC', async () => {
    const task = await createTask();
    const { status, body } = await putTask(task, { notBeforeAt: '2026-10-23 19:00', timezone: 'Europe/Berlin' });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.notBeforeAt, '2026-10-23T17:00:00.000Z');
  });

  it('accepts ISO instants, dates, and relative words', async () => {
    const task = await createTask();
    const instant = await putTask(task, { notBeforeAt: '2026-10-23T19:00:00+02:00' });
    assert.strictEqual(instant.status, 200);
    assert.strictEqual(instant.body.notBeforeAt, '2026-10-23T17:00:00.000Z');

    const { resolveTaskDateTime } = await import('../src/relativeDates');
    const relative = await putTask(
      { id: task.id, version: instant.body.version },
      { notBeforeAt: '+7d', timezone: 'Europe/Berlin' },
    );
    assert.strictEqual(relative.status, 200);
    assert.strictEqual(relative.body.notBeforeAt, resolveTaskDateTime('+7d', 'Europe/Berlin'));
  });

  it('creates with a moment and clears it back to null', async () => {
    const task = await createTask({ notBeforeAt: '2026-10-23 19:00', timezone: 'Europe/Berlin' });
    assert.strictEqual(task.notBeforeAt, '2026-10-23T17:00:00.000Z');
    const cleared = await putTask(task, { notBeforeAt: null });
    assert.strictEqual(cleared.status, 200);
    assert.strictEqual(cleared.body.notBeforeAt, undefined);
  });

  it('rejects unreadable moments and unknown timezones', async () => {
    const task = await createTask();
    const badMoment = await putTask(task, { notBeforeAt: 'someday' });
    assert.strictEqual(badMoment.status, 400);
    const badTz = await putTask(task, { notBeforeAt: '2026-10-23 19:00', timezone: 'Mars/Base' });
    assert.strictEqual(badTz.status, 400);
    const badTime = await putTask(task, { notBeforeAt: '2026-10-23 25:00' });
    assert.strictEqual(badTime.status, 400);
  });

  it('locks the moment on skipped tasks like the other lifecycle fields', async () => {
    const task = await createTask();
    const skip = await handler({
      httpMethod: 'POST',
      path: `/api/tasks/${task.id}/actions/skip`,
      body: JSON.stringify({ expectedVersion: task.version, reason: 'Not applicable' }),
    }, {});
    assert.strictEqual(skip.statusCode, 200);
    const skipped = JSON.parse(skip.body);
    const { status } = await putTask(skipped, { notBeforeAt: '2026-10-23 19:00' });
    assert.strictEqual(status, 400);
  });
});
