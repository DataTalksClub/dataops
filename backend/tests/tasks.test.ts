import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

import { getClient } from '../src/db/client';
import { startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createTables, deleteTables } from '../scripts/local-dynamodb';
import { TABLE_TASKS } from '../src/db/tableNames';
import { createCard } from '../src/db/cards';
import {
  createTask,
  getTask,
  getTaskConsistent,
  updateTask,
  updateTaskAdditive,
  deleteTask,
  listTasksByDate,
  listTasksByDateRange,
  listTasksByCard,
  listTasksByStatus,
  TaskVersionConflictError,
} from '../src/db/tasks';
import type { TaskHistoryEvent } from '../src/types';

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
    const card = await createCard(client, { title: 'Task owner', anchorDate: '2026-02-23' });
    const task = await createTask(client, {
      description: 'Write unit tests',
      date: '2026-02-23',
      cardId: card.id,
    });

    assert.ok(task.id, 'task should have an id');
    assert.ok(task.createdAt, 'task should have createdAt');
    assert.ok(task.updatedAt, 'task should have updatedAt');
    assert.strictEqual(task.description, 'Write unit tests');
    assert.strictEqual(task.date, '2026-02-23');
    assert.strictEqual(task.cardId, card.id);
    assert.strictEqual(task.status, 'todo');
    assert.strictEqual(task.version, 1);
    assert.deepStrictEqual(task.taskHistory, []);
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

  it('does not overwrite a caller-supplied duplicate id', async () => {
    const id = `task-duplicate-${crypto.randomUUID()}`;
    const first = await createTask(client, {
      id,
      description: 'Original duplicate target',
      date: '2026-02-23',
    });
    await assert.rejects(
      () => createTask(client, {
        id,
        description: 'Must not overwrite',
        date: '2026-02-24',
      }),
      (error: unknown) => (error as { name?: string }).name === 'ConditionalCheckFailedException',
    );
    assert.deepStrictEqual(await getTask(client, id), first);
  });

  it('getTask returns null for non-existent id', async () => {
    const result = await getTask(client, 'non-existent-id');
    assert.strictEqual(result, null);
  });

  it('rejects versionless or historyless persisted rows instead of defaulting them', async () => {
    const id = `noncanonical-${crypto.randomUUID()}`;
    await client.send(new PutCommand({
      TableName: TABLE_TASKS,
      Item: {
        PK: `TASK#${id}`,
        SK: `TASK#${id}`,
        id,
        description: 'Noncanonical row',
        date: '2026-02-23',
        status: 'todo',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    }));
    await assert.rejects(() => getTask(client, id), /not in the canonical versioned shape/);
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
      expectedVersion: created.version,
      patch: {
        status: 'done',
        description: 'Updated',
      },
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

    await deleteTask(client, created.id, created.version);
    const result = await getTask(client, created.id);
    assert.strictEqual(result, null);
  });

  it('allows only one mutation from a version and preserves history on deliberate retry', async () => {
    const created = await createTask(client, {
      description: 'Concurrent history',
      date: '2026-02-23',
    });
    const event = (action: TaskHistoryEvent['action']): TaskHistoryEvent => ({
      id: crypto.randomUUID(),
      taskId: created.id,
      action,
      createdAt: new Date().toISOString(),
    });
    const firstEvent = event('waiting-started');
    const secondEvent = event('completed');

    const results = await Promise.allSettled([
      updateTask(client, created.id, {
        expectedVersion: created.version,
        patch: { status: 'waiting' },
        historyEvents: [firstEvent],
      }),
      updateTask(client, created.id, {
        expectedVersion: created.version,
        patch: { status: 'done' },
        historyEvents: [secondEvent],
      }),
    ]);

    assert.strictEqual(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    assert.ok(rejected.reason instanceof TaskVersionConflictError);
    const afterRace = await getTask(client, created.id);
    assert.ok(afterRace);
    assert.strictEqual(afterRace.version, 2);
    assert.strictEqual(afterRace.taskHistory.length, 1);

    const losingEvent = afterRace.taskHistory[0].id === firstEvent.id ? secondEvent : firstEvent;
    const retried = await updateTask(client, created.id, {
      expectedVersion: afterRace.version,
      patch: { status: losingEvent.action === 'completed' ? 'done' : 'waiting' },
      historyEvents: [losingEvent],
    });
    assert.strictEqual(retried.version, 3);
    assert.deepStrictEqual(
      retried.taskHistory.map((historyEvent) => historyEvent.id),
      [afterRace.taskHistory[0].id, losingEvent.id],
    );
  });

  it('uses one conditional expression for fields, version, and history', async () => {
    let commandInput: Record<string, any> | undefined;
    const fakeClient = {
      send: async (command: { input: Record<string, any> }) => {
        commandInput = command.input;
        return {
          Attributes: {
            id: 'task-expression',
            version: 5,
            taskHistory: [],
            description: 'Expression',
            date: '2026-02-23',
            status: 'done',
            createdAt: '2026-02-23T00:00:00.000Z',
            updatedAt: '2026-02-23T00:00:01.000Z',
          },
        };
      },
    } as unknown as DynamoDBDocumentClient;

    await updateTask(fakeClient, 'task-expression', {
      expectedVersion: 4,
      patch: { description: 'Expression updated' },
      historyEvents: [{
        id: 'history-expression',
        taskId: 'task-expression',
        action: 'completed',
        createdAt: '2026-02-23T00:00:01.000Z',
      }],
    });

    assert.strictEqual(commandInput?.ConditionExpression, 'attribute_exists(PK) AND #version = :expectedVersion');
    assert.match(commandInput?.UpdateExpression || '', /#version = :nextVersion/);
    assert.match(commandInput?.UpdateExpression || '', /list_append\(#taskHistory, :historyEvents\)/);
    assert.doesNotMatch(commandInput?.UpdateExpression || '', /if_not_exists/);
    assert.strictEqual(commandInput?.ExpressionAttributeValues[':expectedVersion'], 4);
    assert.strictEqual(commandInput?.ExpressionAttributeValues[':nextVersion'], 5);
  });

  it('marks the conflict recovery read strongly consistent', async () => {
    let commandInput: Record<string, any> | undefined;
    const fakeClient = {
      send: async (command: { input: Record<string, any> }) => {
        commandInput = command.input;
        return { Item: undefined };
      },
    } as unknown as DynamoDBDocumentClient;
    assert.strictEqual(await getTaskConsistent(fakeClient, 'missing'), null);
    assert.strictEqual(commandInput?.ConsistentRead, true);
  });

  it('bounds an additive retry and remerges into the current Task', async () => {
    const stale = await createTask(client, {
      description: 'Additive retry',
      date: '2026-02-23',
      artifactRefs: [{ artifactId: 'first' }],
    });
    await updateTask(client, stale.id, {
      expectedVersion: stale.version,
      patch: { comment: 'concurrent operator field' },
    });

    const merged = await updateTaskAdditive(client, stale, (currentTask) => ({
      artifactRefs: [
        ...(currentTask.artifactRefs || []).filter(({ artifactId }) => artifactId !== 'second'),
        { artifactId: 'second' },
      ],
    }));
    assert.strictEqual(merged.version, 3);
    assert.strictEqual(merged.comment, 'concurrent operator field');
    assert.deepStrictEqual(merged.artifactRefs?.map(({ artifactId }) => artifactId), ['first', 'second']);
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

  it('listTasksByCard returns tasks for a given card', async () => {
    const bid = (await createCard(client, { title: 'Owned tasks', anchorDate: '2026-03-01' })).id;
    const other = (await createCard(client, { title: 'Other tasks', anchorDate: '2026-03-01' })).id;
    await createTask(client, { description: 'P1', date: '2026-03-01', cardId: bid, status: 'todo' });
    await createTask(client, { description: 'P2', date: '2026-03-02', cardId: bid, status: 'todo' });
    await createTask(client, { description: 'P3', date: '2026-03-01', cardId: other, status: 'todo' });

    const tasks = await listTasksByCard(client, bid);
    assert.strictEqual(tasks.length, 2);
    const descriptions = tasks.map((t) => t.description).sort();
    assert.deepStrictEqual(descriptions, ['P1', 'P2']);
  });

  it('createTask persists new fields (instructionsUrl, doc context, link, requiredLinkName, assigneeId, tags)', async () => {
    const task = await createTask(client, {
      description: 'Task with new fields',
      date: '2026-04-01',
      instructionsUrl: 'https://docs.google.com/howto',
      instructionDocId: 'sop.media.podcast.create-podcast-document',
      instructionStepId: '4',
      phase: 'preparation',
      systems: ['google-drive', 'github'],
      validation: { requiredEvidence: 'Podcast document link' },
      link: 'https://luma.com/event-123',
      requiredLinkName: 'Luma',
      assigneeId: 'user-grace',
      tags: ['webinar', 'community'],
    });

    assert.strictEqual(task.description, 'Task with new fields');
    assert.strictEqual((task as any).instructionsUrl, 'https://docs.google.com/howto');
    assert.strictEqual((task as any).instructionDocId, 'sop.media.podcast.create-podcast-document');
    assert.strictEqual((task as any).instructionStepId, '4');
    assert.strictEqual((task as any).phase, 'preparation');
    assert.deepStrictEqual((task as any).systems, ['google-drive', 'github']);
    assert.deepStrictEqual((task as any).validation, { requiredEvidence: 'Podcast document link' });
    assert.strictEqual((task as any).link, 'https://luma.com/event-123');
    assert.strictEqual((task as any).requiredLinkName, 'Luma');
    assert.strictEqual((task as any).assigneeId, 'user-grace');
    assert.deepStrictEqual((task as any).tags, ['webinar', 'community']);

    // Verify retrieval
    const fetched = await getTask(client, task.id);
    assert.ok(fetched);
    assert.strictEqual((fetched as any).instructionsUrl, 'https://docs.google.com/howto');
    assert.strictEqual((fetched as any).instructionDocId, 'sop.media.podcast.create-podcast-document');
    assert.strictEqual((fetched as any).instructionStepId, '4');
    assert.strictEqual((fetched as any).phase, 'preparation');
    assert.deepStrictEqual((fetched as any).systems, ['google-drive', 'github']);
    assert.deepStrictEqual((fetched as any).validation, { requiredEvidence: 'Podcast document link' });
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
      expectedVersion: task.version,
      patch: {
        instructionsUrl: 'https://docs.google.com/updated',
        instructionDocId: 'sop.media.podcast.updated',
        instructionStepId: '7',
        phase: 'after-event',
        systems: ['youtube'],
        validation: 'Confirm the doc is shared',
        assigneeId: 'user-valeriia',
        tags: ['newsletter'],
        link: 'https://example.com/link',
      },
    });

    assert.ok(updated);
    assert.strictEqual((updated as any).instructionsUrl, 'https://docs.google.com/updated');
    assert.strictEqual((updated as any).instructionDocId, 'sop.media.podcast.updated');
    assert.strictEqual((updated as any).instructionStepId, '7');
    assert.strictEqual((updated as any).phase, 'after-event');
    assert.deepStrictEqual((updated as any).systems, ['youtube']);
    assert.strictEqual((updated as any).validation, 'Confirm the doc is shared');
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
    assert.strictEqual((task as any).instructionDocId, undefined);
    assert.strictEqual((task as any).instructionStepId, undefined);
    assert.strictEqual((task as any).phase, undefined);
    assert.strictEqual((task as any).systems, undefined);
    assert.strictEqual((task as any).validation, undefined);
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
