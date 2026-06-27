import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { startLocal, stopLocal, getClient } from '../src/db/client';
import { createTables, deleteTables } from '../src/db/setup';
import {
  createTask,
  getTask,
  updateTask,
  deleteTask,
  listTasksByDate,
  listTasksByDateRange,
  listTasksByBundle,
  listTasksByStatus,
} from '../src/db/tasks';

describe('Tasks data layer', () => {
  let client: DynamoDBDocumentClient;
  let port: number;

  before(async () => {
    port = await startLocal();
    client = await getClient(port);
    await createTables(client);
  });

  after(async () => {
    await stopLocal();
  });

  it('createTask returns a task with id, createdAt, updatedAt', async () => {
    const task = await createTask(client, {
      description: 'Write unit tests',
      date: '2026-02-23',
      bundleId: 'bundle-1',
    });

    assert.ok(task.id, 'task should have an id');
    assert.ok(task.createdAt, 'task should have createdAt');
    assert.ok(task.updatedAt, 'task should have updatedAt');
    assert.strictEqual(task.description, 'Write unit tests');
    assert.strictEqual(task.date, '2026-02-23');
    assert.strictEqual(task.bundleId, 'bundle-1');
    assert.strictEqual(task.status, 'todo');
    // PK/SK should be stripped
    assert.strictEqual((task as Record<string, unknown>).PK, undefined);
    assert.strictEqual((task as Record<string, unknown>).SK, undefined);
  });

  it('getTask returns the task by id', async () => {
    const created = await createTask(client, {
      description: 'Fetch me',
      date: '2026-02-23',
    });

    const fetched = await getTask(client, created.id);
    assert.ok(fetched);
    assert.strictEqual(fetched.id, created.id);
    assert.strictEqual(fetched.description, 'Fetch me');
  });

  it('getTask returns null for non-existent id', async () => {
    const result = await getTask(client, 'non-existent-id');
    assert.strictEqual(result, null);
  });

  it('updateTask performs partial update and refreshes updatedAt', async () => {
    const created = await createTask(client, {
      description: 'Original',
      date: '2026-02-23',
      status: 'todo',
    });

    // Small delay to ensure updatedAt changes
    await new Promise((r) => setTimeout(r, 10));

    const updated = await updateTask(client, created.id, {
      status: 'done',
      description: 'Updated',
    });

    assert.strictEqual(updated.status, 'done');
    assert.strictEqual(updated.description, 'Updated');
    assert.strictEqual(updated.date, '2026-02-23');
    assert.ok(updated.updatedAt > created.updatedAt, 'updatedAt should be refreshed');
  });

  it('deleteTask removes the task', async () => {
    const created = await createTask(client, {
      description: 'Delete me',
      date: '2026-02-23',
    });

    await deleteTask(client, created.id);
    const result = await getTask(client, created.id);
    assert.strictEqual(result, null);
  });

  it('listTasksByDate returns tasks for a specific date', async () => {
    const uniqueDate = '2099-01-15';
    await createTask(client, { description: 'A', date: uniqueDate, status: 'todo' });
    await createTask(client, { description: 'B', date: uniqueDate, status: 'done' });
    await createTask(client, { description: 'C', date: '2099-01-16', status: 'todo' });

    const tasks = await listTasksByDate(client, uniqueDate);
    assert.strictEqual(tasks.length, 2);
    const descriptions = tasks.map((t) => t.description).sort();
    assert.deepStrictEqual(descriptions, ['A', 'B']);
  });

  it('listTasksByDateRange returns tasks in a date range', async () => {
    const d1 = '2098-06-01';
    const d2 = '2098-06-02';
    const d3 = '2098-06-03';
    const d4 = '2098-06-04';

    await createTask(client, { description: 'R1', date: d1, status: 'todo' });
    await createTask(client, { description: 'R2', date: d2, status: 'todo' });
    await createTask(client, { description: 'R3', date: d3, status: 'todo' });
    await createTask(client, { description: 'R4', date: d4, status: 'todo' });

    const tasks = await listTasksByDateRange(client, d2, d3);
    const descriptions = tasks.map((t) => t.description).sort();
    assert.deepStrictEqual(descriptions, ['R2', 'R3']);
  });

  it('listTasksByBundle returns tasks for a given bundle', async () => {
    const bid = 'bundle-unique-' + crypto.randomUUID();
    await createTask(client, { description: 'P1', date: '2026-03-01', bundleId: bid, status: 'todo' });
    await createTask(client, { description: 'P2', date: '2026-03-02', bundleId: bid, status: 'todo' });
    await createTask(client, { description: 'P3', date: '2026-03-01', bundleId: 'other', status: 'todo' });

    const tasks = await listTasksByBundle(client, bid);
    assert.strictEqual(tasks.length, 2);
    const descriptions = tasks.map((t) => t.description).sort();
    assert.deepStrictEqual(descriptions, ['P1', 'P2']);
  });

  it('createTask persists new fields (instructionsUrl, link, requiredLinkName, assigneeId, tags)', async () => {
    const task = await createTask(client, {
      description: 'Task with new fields',
      date: '2026-04-01',
      instructionsUrl: 'https://docs.google.com/howto',
      link: 'https://luma.com/event-123',
      requiredLinkName: 'Luma',
      assigneeId: 'user-grace',
      tags: ['webinar', 'community'],
    });

    assert.strictEqual(task.description, 'Task with new fields');
    assert.strictEqual((task as any).instructionsUrl, 'https://docs.google.com/howto');
    assert.strictEqual((task as any).link, 'https://luma.com/event-123');
    assert.strictEqual((task as any).requiredLinkName, 'Luma');
    assert.strictEqual((task as any).assigneeId, 'user-grace');
    assert.deepStrictEqual((task as any).tags, ['webinar', 'community']);

    // Verify retrieval
    const fetched = await getTask(client, task.id);
    assert.ok(fetched);
    assert.strictEqual((fetched as any).instructionsUrl, 'https://docs.google.com/howto');
    assert.strictEqual((fetched as any).link, 'https://luma.com/event-123');
    assert.strictEqual((fetched as any).requiredLinkName, 'Luma');
    assert.strictEqual((fetched as any).assigneeId, 'user-grace');
    assert.deepStrictEqual((fetched as any).tags, ['webinar', 'community']);
  });

  it('updateTask can update new fields', async () => {
    const task = await createTask(client, {
      description: 'Update new fields',
      date: '2026-04-02',
    });

    await new Promise((r) => setTimeout(r, 10));

    const updated = await updateTask(client, task.id, {
      instructionsUrl: 'https://docs.google.com/updated',
      assigneeId: 'user-valeriia',
      tags: ['newsletter'],
      link: 'https://example.com/link',
    });

    assert.ok(updated);
    assert.strictEqual((updated as any).instructionsUrl, 'https://docs.google.com/updated');
    assert.strictEqual((updated as any).assigneeId, 'user-valeriia');
    assert.deepStrictEqual((updated as any).tags, ['newsletter']);
    assert.strictEqual((updated as any).link, 'https://example.com/link');
    assert.strictEqual(updated!.description, 'Update new fields');
  });

  it('createTask without new fields leaves them absent (backward compatibility)', async () => {
    const task = await createTask(client, {
      description: 'Old-style task',
      date: '2026-04-03',
    });

    assert.strictEqual((task as any).instructionsUrl, undefined);
    assert.strictEqual((task as any).link, undefined);
    assert.strictEqual((task as any).requiredLinkName, undefined);
    assert.strictEqual((task as any).assigneeId, undefined);
    assert.strictEqual((task as any).tags, undefined);
  });

  it('listTasksByStatus returns tasks with a given status', async () => {
    const uniqueStatus = 'status-' + crypto.randomUUID();
    await createTask(client, { description: 'S1', date: '2026-04-01', status: uniqueStatus });
    await createTask(client, { description: 'S2', date: '2026-04-02', status: uniqueStatus });
    await createTask(client, { description: 'S3', date: '2026-04-01', status: 'other-status' });

    const tasks = await listTasksByStatus(client, uniqueStatus);
    assert.strictEqual(tasks.length, 2);
    const descriptions = tasks.map((t) => t.description).sort();
    assert.deepStrictEqual(descriptions, ['S1', 'S2']);
  });
});
