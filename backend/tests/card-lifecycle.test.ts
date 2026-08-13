import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getClient } from '../src/db/client';
import { createCard, getCard, updateCard } from '../src/db/cards';
import {
  CardLifecycleConflictError,
  createTask,
  deleteTask,
  getTask,
  updateTask,
} from '../src/db/tasks';
import { TABLE_AUDIT_EVENTS } from '../src/db/tableNames';
import { createCardFromTemplate, createTemplate } from '../src/db/templates';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';

describe('Card lifecycle aggregate', () => {
  let client: DynamoDBDocumentClient;

  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
  });

  after(stopLocal);

  it('creates a canonical empty active Card', async () => {
    const card = await createCard(client, { title: 'Empty', anchorDate: '2026-09-01' });
    assert.deepEqual(
      {
        version: card.version,
        taskCount: card.taskCount,
        openTaskCount: card.openTaskCount,
        stage: card.stage,
        status: card.status,
      },
      { version: 1, taskCount: 0, openTaskCount: 0, stage: 'preparation', status: 'active' },
    );
    assert.equal(card.completedAt, undefined);
  });

  it('atomically completes and reactivates a Card while retaining lifecycle audit history', async () => {
    const created = await createCard(client, { title: 'Lifecycle', anchorDate: '2026-09-02' });
    const staged = await updateCard(client, created.id, {
      expectedVersion: created.version,
      patch: { stage: 'announced' },
    });
    const task = await createTask(client, {
      description: 'Publish',
      date: '2026-09-02',
      cardId: created.id,
      createdBy: 'operator-one',
    });
    const withTask = await getCard(client, created.id);
    assert.ok(withTask);
    assert.deepEqual(
      { version: withTask?.version, taskCount: withTask?.taskCount, openTaskCount: withTask?.openTaskCount },
      { version: staged.version + 1, taskCount: 1, openTaskCount: 1 },
    );

    const done = await updateTask(client, task.id, {
      expectedVersion: task.version,
      patch: { status: 'done' },
      actorId: 'operator-two',
      triggerKind: 'task-completed',
    });
    const completed = await getCard(client, created.id);
    assert.equal(done.status, 'done');
    assert.deepEqual(
      {
        version: completed?.version,
        taskCount: completed?.taskCount,
        openTaskCount: completed?.openTaskCount,
        stage: completed?.stage,
        status: completed?.status,
        completedBy: completed?.completedBy,
        activeStageBeforeCompletion: completed?.activeStageBeforeCompletion,
      },
      {
        version: withTask.version + 1,
        taskCount: 1,
        openTaskCount: 0,
        stage: 'done',
        status: 'archived',
        completedBy: 'operator-two',
        activeStageBeforeCompletion: 'announced',
      },
    );
    assert.match(completed?.completedAt || '', /^\d{4}-\d{2}-\d{2}T/);
    const completionRef = completed?.auditEventRefs?.at(-1);
    assert.equal(completionRef?.action, 'card-completed');
    const audit = await client.send(new GetCommand({
      TableName: TABLE_AUDIT_EVENTS,
      Key: {
        PK: `AUDIT_EVENT#${completionRef?.auditEventId}`,
        SK: `AUDIT_EVENT#${completionRef?.auditEventId}`,
      },
      ConsistentRead: true,
    }));
    assert.deepEqual(
      {
        action: audit.Item?.action,
        actorId: audit.Item?.actorId,
        cardId: audit.Item?.cardId,
        triggerTaskId: audit.Item?.triggerTaskId,
      },
      {
        action: 'card-completed',
        actorId: 'operator-two',
        cardId: created.id,
        triggerTaskId: task.id,
      },
    );

    const reopenedTask = await updateTask(client, task.id, {
      expectedVersion: done.version,
      patch: { status: 'todo', completedAt: null, completedBy: null },
      actorId: 'operator-three',
      triggerKind: 'task-reopened',
    });
    assert.equal(reopenedTask.completedAt, undefined);
    assert.equal(reopenedTask.completedBy, undefined);
    assert.equal((await getTask(client, task.id))?.completedAt, undefined);
    assert.equal((await getTask(client, task.id))?.completedBy, undefined);
    const reopened = await getCard(client, created.id);
    assert.deepEqual(
      {
        stage: reopened?.stage,
        status: reopened?.status,
        taskCount: reopened?.taskCount,
        openTaskCount: reopened?.openTaskCount,
        completedAt: reopened?.completedAt,
        completedBy: reopened?.completedBy,
        activeStageBeforeCompletion: reopened?.activeStageBeforeCompletion,
      },
      {
        stage: 'announced',
        status: 'active',
        taskCount: 1,
        openTaskCount: 1,
        completedAt: undefined,
        completedBy: undefined,
        activeStageBeforeCompletion: undefined,
      },
    );
    assert.deepEqual(
      reopened?.auditEventRefs?.map(({ action }) => action),
      ['card-completed', 'card-reactivated'],
    );
  });

  it('never regresses an active Card stage from an older Template Task hint', async () => {
    const card = await createCard(client, {
      title: 'Monotonic stage Card',
      anchorDate: '2026-09-12',
      stage: 'after-event',
    });
    const task = await createTask(client, {
      description: 'Old milestone',
      date: '2026-09-12',
      status: 'todo',
      source: 'template',
      stageOnComplete: 'preparation',
      cardId: card.id,
    });
    await createTask(client, {
      description: 'Still open',
      date: '2026-09-13',
      status: 'todo',
      cardId: card.id,
    });
    await updateTask(client, task.id, {
      expectedVersion: task.version,
      patch: { status: 'done', completedAt: '2026-09-12T12:00:00.000Z', completedBy: 'operator' },
      actorId: 'operator',
    });
    assert.equal((await getCard(client, card.id))?.stage, 'after-event');
  });

  it('keeps zero-Task Cards active after deleting their final Task', async () => {
    const card = await createCard(client, { title: 'Delete final', anchorDate: '2026-09-03' });
    const task = await createTask(client, { description: 'Only', date: '2026-09-03', cardId: card.id });
    await deleteTask(client, task.id, task.version, 'operator-one');
    assert.equal(await getTask(client, task.id), null);
    const current = await getCard(client, card.id);
    assert.deepEqual(
      { taskCount: current?.taskCount, openTaskCount: current?.openTaskCount, status: current?.status },
      { taskCount: 0, openTaskCount: 0, status: 'active' },
    );
  });

  it('treats archived Tasks as terminal and moves Task aggregates between Cards', async () => {
    const source = await createCard(client, { title: 'Source', anchorDate: '2026-09-04' });
    const target = await createCard(client, { title: 'Target', anchorDate: '2026-09-04' });
    const task = await createTask(client, { description: 'Move', date: '2026-09-04', cardId: source.id });
    const moved = await updateTask(client, task.id, {
      expectedVersion: task.version,
      patch: { cardId: target.id },
      actorId: 'operator-one',
      triggerKind: 'task-moved',
    });
    assert.deepEqual(
      {
        source: (await getCard(client, source.id))?.taskCount,
        target: (await getCard(client, target.id))?.openTaskCount,
      },
      { source: 0, target: 1 },
    );
    await updateTask(client, moved.id, {
      expectedVersion: moved.version,
      patch: { status: 'archived' },
      actorId: 'operator-one',
    });
    const archived = await getCard(client, target.id);
    assert.deepEqual(
      { taskCount: archived?.taskCount, openTaskCount: archived?.openTaskCount, status: archived?.status },
      { taskCount: 1, openTaskCount: 0, status: 'archived' },
    );
  });

  it('allows only one concurrent final-Task transition and completes after deliberate retry', async () => {
    const card = await createCard(client, { title: 'Race', anchorDate: '2026-09-05' });
    const first = await createTask(client, { description: 'First', date: '2026-09-05', cardId: card.id });
    const second = await createTask(client, { description: 'Second', date: '2026-09-05', cardId: card.id });
    const results = await Promise.allSettled([
      updateTask(client, first.id, { expectedVersion: first.version, patch: { status: 'done' } }),
      updateTask(client, second.id, { expectedVersion: second.version, patch: { status: 'done' } }),
    ]);
    assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
    const rejected = results.find(({ status }) => status === 'rejected') as PromiseRejectedResult;
    assert.ok(rejected.reason instanceof CardLifecycleConflictError);

    const loser = results[0].status === 'rejected' ? first : second;
    const currentLoser = await getTask(client, loser.id);
    assert.equal(currentLoser?.version, 1, 'failed aggregate mutation must not update its Task');
    await updateTask(client, loser.id, {
      expectedVersion: currentLoser!.version,
      patch: { status: 'done' },
      actorId: 'operator-retry',
    });
    const completed = await getCard(client, card.id);
    assert.deepEqual(
      { taskCount: completed?.taskCount, openTaskCount: completed?.openTaskCount, status: completed?.status },
      { taskCount: 2, openTaskCount: 0, status: 'archived' },
    );
  });

  it('rolls back Task and Card when the local transaction harness injects a failure', async () => {
    const card = await createCard(client, { title: 'Rollback', anchorDate: '2026-09-06' });
    const task = await createTask(client, { description: 'Atomic', date: '2026-09-06', cardId: card.id });
    const beforeCard = await getCard(client, card.id);
    process.env.TASK_CARD_LIFECYCLE_TEST_FAIL_AFTER = '2';
    try {
      await assert.rejects(
        updateTask(client, task.id, { expectedVersion: task.version, patch: { status: 'done' } }),
        /Injected Task\/Card lifecycle transaction failure/,
      );
    } finally {
      delete process.env.TASK_CARD_LIFECYCLE_TEST_FAIL_AFTER;
    }
    assert.deepEqual(await getTask(client, task.id), task);
    assert.deepEqual(await getCard(client, card.id), beforeCard);
  });

  it('creates a Template Card and every Task in one preflighted transaction', async () => {
    const template = await createTemplate(client, {
      name: 'Atomic template',
      taskDefinitions: [
        { refId: 'one', description: 'One', offsetDays: 0 },
        { refId: 'two', description: 'Two', offsetDays: 1 },
      ],
    });
    const result = await createCardFromTemplate(
      client,
      { id: 'atomic-template-card', title: 'Atomic', anchorDate: '2026-09-07', templateId: template.id },
      template,
      '2026-09-07',
    );
    assert.deepEqual(
      { taskCount: result.card.taskCount, openTaskCount: result.card.openTaskCount, tasks: result.tasks.length },
      { taskCount: 2, openTaskCount: 2, tasks: 2 },
    );
    assert.ok(result.tasks.every(({ cardId, version, status }) => (
      cardId === result.card.id && version === 1 && status === 'todo'
    )));
  });

  it('rolls back Template Card creation and rejects oversized aggregates before writing', async () => {
    const template = await createTemplate(client, {
      name: 'Rollback template',
      taskDefinitions: [{ refId: 'one', description: 'One', offsetDays: 0 }],
    });
    process.env.TEMPLATE_CARD_CREATE_TEST_FAIL_AFTER = '1';
    try {
      await assert.rejects(
        createCardFromTemplate(
          client,
          { id: 'rolled-back-template-card', title: 'Rollback', anchorDate: '2026-09-08', templateId: template.id },
          template,
          '2026-09-08',
        ),
        /Injected Template Card creation transaction failure/,
      );
    } finally {
      delete process.env.TEMPLATE_CARD_CREATE_TEST_FAIL_AFTER;
    }
    assert.equal(await getCard(client, 'rolled-back-template-card'), null);

    const oversized = await createTemplate(client, {
      name: 'Oversized template',
      taskDefinitions: Array.from({ length: 99 }, (_, index) => ({
        refId: `task-${index}`,
        description: `Task ${index}`,
        offsetDays: index,
      })),
    });
    await assert.rejects(
      createCardFromTemplate(
        client,
        { id: 'oversized-template-card', title: 'Oversized', anchorDate: '2026-09-09', templateId: oversized.id },
        oversized,
        '2026-09-09',
      ),
      /requires 101 transaction items; maximum is 100/,
    );
    assert.equal(await getCard(client, 'oversized-template-card'), null);
  });
});
