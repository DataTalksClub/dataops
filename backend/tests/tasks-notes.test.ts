import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';

import { getClient } from '../src/db/client';
import { startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createTables } from '../scripts/local-dynamodb';
import { putEmptyTemplate } from './helpers/cardTemplate';

describe('API — task notes log', () => {
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

  async function createTask(body: Record<string, unknown>) {
    const res = await handler({
      httpMethod: 'POST',
      path: '/api/tasks',
      body: JSON.stringify({ description: 'Noted task', date: '2026-03-10', ...body }),
    }, {});
    assert.strictEqual(res.statusCode, 201);
    return JSON.parse(res.body);
  }

  it('starts the log with the creation comment', async () => {
    const task = await createTask({ comment: 'First context' });
    assert.strictEqual(task.notesLog.length, 1);
    assert.strictEqual(task.notesLog[0].text, 'First context');
    assert.ok(task.notesLog[0].createdAt);

    const bare = await createTask({});
    assert.strictEqual(bare.notesLog, undefined);
  });

  it('appends notes with author and timestamp plus history', async () => {
    const task = await createTask({ comment: 'First context' });
    const res = await handler({
      httpMethod: 'POST',
      path: `/api/tasks/${task.id}/actions/add-note`,
      body: JSON.stringify({ expectedVersion: task.version, note: 'Second note' }),
    }, {});
    assert.strictEqual(res.statusCode, 200);
    const noted = JSON.parse(res.body);
    assert.strictEqual(noted.notesLog.length, 2);
    assert.strictEqual(noted.notesLog[0].text, 'First context');
    assert.strictEqual(noted.notesLog[1].text, 'Second note');
    assert.ok(noted.notesLog[1].createdAt);
    assert.strictEqual(noted.taskHistory.at(-1).action, 'noted');
    assert.strictEqual(noted.taskHistory.at(-1).note, 'Second note');
  });

  it('rejects an empty note', async () => {
    const task = await createTask({});
    const res = await handler({
      httpMethod: 'POST',
      path: `/api/tasks/${task.id}/actions/add-note`,
      body: JSON.stringify({ expectedVersion: task.version, note: '  ' }),
    }, {});
    assert.strictEqual(res.statusCode, 400);
  });

  it('update --comment appends instead of overwriting', async () => {
    const task = await createTask({ comment: 'Original' });
    const res = await handler({
      httpMethod: 'PUT',
      path: `/api/tasks/${task.id}`,
      body: JSON.stringify({ expectedVersion: task.version, comment: 'Update' }),
    }, {});
    assert.strictEqual(res.statusCode, 200);
    const updated = JSON.parse(res.body);
    assert.strictEqual(updated.comment, 'Update');
    assert.deepStrictEqual(updated.notesLog.map((entry: { text: string }) => entry.text), ['Original', 'Update']);
  });

  it('update --comment seeds the log when there was no comment before', async () => {
    const task = await createTask({});
    const res = await handler({
      httpMethod: 'PUT',
      path: `/api/tasks/${task.id}`,
      body: JSON.stringify({ expectedVersion: task.version, comment: 'Only note' }),
    }, {});
    assert.strictEqual(res.statusCode, 200);
    const updated = JSON.parse(res.body);
    assert.deepStrictEqual(updated.notesLog.map((entry: { text: string }) => entry.text), ['Only note']);
  });

  it('notes append on done and skipped tasks', async () => {
    const doneTask = await createTask({});
    const done = await handler({
      httpMethod: 'PUT',
      path: `/api/tasks/${doneTask.id}`,
      body: JSON.stringify({ expectedVersion: doneTask.version, status: 'done' }),
    }, {});
    assert.strictEqual(done.statusCode, 200);
    const completed = JSON.parse(done.body);
    const onDone = await handler({
      httpMethod: 'POST',
      path: `/api/tasks/${doneTask.id}/actions/add-note`,
      body: JSON.stringify({ expectedVersion: completed.version, note: 'After completion' }),
    }, {});
    assert.strictEqual(onDone.statusCode, 200);

    const skippedTask = await createTask({});
    const skip = await handler({
      httpMethod: 'POST',
      path: `/api/tasks/${skippedTask.id}/actions/skip`,
      body: JSON.stringify({ expectedVersion: skippedTask.version, reason: 'Not applicable' }),
    }, {});
    assert.strictEqual(skip.statusCode, 200);
    const skipped = JSON.parse(skip.body);
    const onSkipped = await handler({
      httpMethod: 'POST',
      path: `/api/tasks/${skippedTask.id}/actions/add-note`,
      body: JSON.stringify({ expectedVersion: skipped.version, note: 'Still relevant' }),
    }, {});
    assert.strictEqual(onSkipped.statusCode, 200);
    assert.strictEqual(JSON.parse(onSkipped.body).notesLog.at(-1).text, 'Still relevant');
  });
});
