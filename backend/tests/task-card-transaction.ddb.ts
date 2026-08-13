import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ListTablesCommand,
  type CreateTableCommandInput,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';

import {
  disableLocalTransactionEmulation,
  getClient,
  usesLocalTransactionEmulation,
} from '../src/db/client';
import { getCardConsistent } from '../src/db/cards';
import {
  TABLE_AUDIT_EVENTS,
  TABLE_CARDS,
  TABLE_TASKS,
} from '../src/db/tableNames';
import {
  getTaskConsistent,
  TaskVersionConflictError,
  updateTask,
} from '../src/db/tasks';
import type { Card, Task, TaskHistoryEvent } from '../src/types';

type Dict = Record<string, unknown>;
type Attempt = {
  actorId: string;
  completedAt: string;
  historyEvent: TaskHistoryEvent;
};

const ENDPOINT = process.env.DYNAMODB_ENDPOINT;
const REGION = process.env.AWS_REGION || 'us-east-1';
const CREDENTIALS = {
  accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'local',
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'local',
};

const TASK_TABLE: CreateTableCommandInput = {
  TableName: TABLE_TASKS,
  BillingMode: 'PAY_PER_REQUEST',
  AttributeDefinitions: [
    { AttributeName: 'PK', AttributeType: 'S' },
    { AttributeName: 'SK', AttributeType: 'S' },
    { AttributeName: 'date', AttributeType: 'S' },
    { AttributeName: 'status', AttributeType: 'S' },
    { AttributeName: 'cardId', AttributeType: 'S' },
  ],
  KeySchema: [
    { AttributeName: 'PK', KeyType: 'HASH' },
    { AttributeName: 'SK', KeyType: 'RANGE' },
  ],
  GlobalSecondaryIndexes: [
    {
      IndexName: 'GSI-Date',
      KeySchema: [
        { AttributeName: 'date', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      Projection: { ProjectionType: 'ALL' },
    },
    {
      IndexName: 'GSI-Card',
      KeySchema: [
        { AttributeName: 'cardId', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      Projection: { ProjectionType: 'ALL' },
    },
    {
      IndexName: 'GSI-Status',
      KeySchema: [
        { AttributeName: 'status', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
      Projection: { ProjectionType: 'ALL' },
    },
  ],
};

const SIMPLE_TABLES: CreateTableCommandInput[] = [TABLE_CARDS, TABLE_AUDIT_EVENTS].map(
  (TableName) => ({
    TableName,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'PK', AttributeType: 'S' },
      { AttributeName: 'SK', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'PK', KeyType: 'HASH' },
      { AttributeName: 'SK', KeyType: 'RANGE' },
    ],
  }),
);

async function waitForDynamoDB(raw: DynamoDBClient): Promise<void> {
  const deadline = Date.now() + 15_000;
  let attempt = 0;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await raw.send(new ListTablesCommand({ Limit: 1 }));
      return;
    } catch (error) {
      lastError = error;
      const backoff = Math.min(250, 25 * 2 ** attempt);
      attempt += 1;
      await delay(backoff);
    }
  }
  const detail = lastError instanceof Error ? `${lastError.name}: ${lastError.message}` : String(lastError);
  throw new Error(`DynamoDB Local did not answer a bounded readiness probe: ${detail}`);
}

async function waitForTable(raw: DynamoDBClient, tableName: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  let lastStatus = 'unknown';
  while (Date.now() < deadline) {
    const result = await raw.send(new DescribeTableCommand({ TableName: tableName }));
    lastStatus = result.Table?.TableStatus || 'unknown';
    if (lastStatus === 'ACTIVE') return;
    await delay(50);
  }
  throw new Error(`Throwaway table ${tableName} did not become ACTIVE (last status: ${lastStatus})`);
}

function historyEvent(
  task: Task,
  action: 'completed' | 'reopened',
  actorId: string,
  createdAt: string,
): TaskHistoryEvent {
  return {
    id: randomUUID(),
    taskId: task.id,
    cardId: task.cardId,
    action,
    actorId,
    createdAt,
  };
}

function withoutKeys<T>(item: Dict): T {
  const { PK, SK, ...record } = item;
  return record as T;
}

async function readAuditEvents(client: DynamoDBDocumentClient): Promise<Dict[]> {
  const result = await client.send(new ScanCommand({
    TableName: TABLE_AUDIT_EVENTS,
    ConsistentRead: true,
  }));
  return (result.Items || []).map((item) => withoutKeys<Dict>(item as Dict));
}

function findAudit(events: Dict[], action: string, actorId: string): Dict {
  const event = events.find((candidate) => (
    candidate.action === action && candidate.actorId === actorId
  ));
  assert.ok(event, `expected ${action} lifecycle audit for synthetic actor ${actorId}`);
  return event;
}

function assertPublicSafeLifecycleAudit(event: Dict, task: Task): void {
  assert.equal(event.cardId, task.cardId);
  assert.equal(event.triggerTaskId, task.id);
  assert.equal(typeof event.createdAt, 'string');
  assert.match(String(event.triggerKind), /^task-(completed|reopened)$/);
  assert.equal(JSON.stringify(event).includes(task.description), false);
  for (const key of Object.keys(event)) {
    assert.doesNotMatch(
      key,
      /body|comment|content|credential|description|link|payload|secret|token|url/i,
      `lifecycle audit must not persist Task content field ${key}`,
    );
  }
}

function assertHistoryContains(task: Task, expected: TaskHistoryEvent): void {
  const persisted = task.taskHistory.find((event) => event.id === expected.id);
  assert.ok(persisted, `expected ${expected.action} Task history event`);
  assert.equal(persisted.action, expected.action);
  assert.equal(persisted.actorId, expected.actorId);
  assert.equal(persisted.cardId, expected.cardId);
}

function createTwoPartyBarrier(timeoutMs: number): () => Promise<void> {
  let arrivals = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  return async () => {
    arrivals += 1;
    if (arrivals === 2) release();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        ready,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`same-version transaction barrier saw ${arrivals} participant(s)`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

test('production Task/Card lifecycle is atomic on official DynamoDB Local', { timeout: 30_000 }, async (t) => {
  assert.equal(process.env.NODE_ENV, 'production');
  assert.ok(ENDPOINT?.startsWith('http://127.0.0.1:'), 'runner must provide an ephemeral loopback endpoint');

  const raw = new DynamoDBClient({
    endpoint: ENDPOINT,
    region: REGION,
    credentials: CREDENTIALS,
  });
  const createdTables: string[] = [];
  let appClient: DynamoDBDocumentClient | undefined;
  t.after(async () => {
    appClient?.destroy();
    for (const tableName of createdTables.reverse()) {
      try {
        await raw.send(new DeleteTableCommand({ TableName: tableName }));
      } catch (error) {
        if ((error as { name?: string }).name !== 'ResourceNotFoundException') throw error;
      }
    }
    raw.destroy();
  });

  await waitForDynamoDB(raw);
  for (const definition of [TASK_TABLE, ...SIMPLE_TABLES]) {
    await raw.send(new CreateTableCommand(definition));
    createdTables.push(String(definition.TableName));
    await waitForTable(raw, String(definition.TableName));
  }

  disableLocalTransactionEmulation();
  assert.equal(usesLocalTransactionEmulation(), false, 'the test must exercise TransactWriteCommand');
  appClient = await getClient();

  let sawTransactWrite = false;
  let transactionBarrier: (() => Promise<void>) | null = null;
  const intercepted = appClient as unknown as {
    send(command: unknown): Promise<unknown>;
  };
  const productionSend = intercepted.send.bind(appClient);
  intercepted.send = async (command: unknown) => {
    if (command instanceof TransactWriteCommand) {
      sawTransactWrite = true;
      if (transactionBarrier) await transactionBarrier();
    }
    return productionSend(command);
  };

  const startedAt = '2026-08-13T10:00:00.000Z';
  const card: Card = {
    id: `issue-183-card-${randomUUID()}`,
    version: 1,
    title: 'Synthetic transaction Card',
    taskCount: 1,
    openTaskCount: 1,
    stage: 'preparation',
    status: 'active',
    createdAt: startedAt,
    updatedAt: startedAt,
  };
  const task: Task = {
    id: `issue-183-task-${randomUUID()}`,
    version: 1,
    description: 'Synthetic Task content must not leak into lifecycle audits',
    date: '2026-08-13',
    status: 'todo',
    cardId: card.id,
    taskHistory: [],
    createdAt: startedAt,
    updatedAt: startedAt,
  };
  await appClient.send(new PutCommand({
    TableName: TABLE_CARDS,
    Item: { PK: `CARD#${card.id}`, SK: `CARD#${card.id}`, ...card },
    ConditionExpression: 'attribute_not_exists(PK)',
  }));
  await appClient.send(new PutCommand({
    TableName: TABLE_TASKS,
    Item: { PK: `TASK#${task.id}`, SK: `TASK#${task.id}`, ...task },
    ConditionExpression: 'attribute_not_exists(PK)',
  }));

  const openTask = await getTaskConsistent(appClient, task.id);
  assert.ok(openTask);
  const completionActor = 'synthetic:completion-actor';
  const completion = historyEvent(openTask, 'completed', completionActor, '2026-08-13T10:01:00.000Z');
  const completedTask = await updateTask(appClient, openTask.id, {
    currentTask: openTask,
    expectedVersion: openTask.version,
    patch: {
      status: 'done',
      completedAt: completion.createdAt,
      completedBy: completionActor,
    },
    historyEvents: [completion],
    actorId: completionActor,
    triggerKind: 'task-completed',
  });

  const persistedCompletedTask = await getTaskConsistent(appClient, task.id);
  const completedCard = await getCardConsistent(appClient, card.id);
  assert.ok(persistedCompletedTask);
  assert.ok(completedCard);
  assert.ok(persistedCompletedTask.version > openTask.version);
  assert.equal(persistedCompletedTask.version, completedTask.version);
  assert.equal(persistedCompletedTask.status, 'done');
  assert.equal(persistedCompletedTask.completedBy, completionActor);
  assertHistoryContains(persistedCompletedTask, completion);
  assert.ok(completedCard.version > card.version);
  assert.equal(completedCard.taskCount, 1);
  assert.equal(completedCard.openTaskCount, 0);
  assert.equal(completedCard.status, 'archived');
  assert.equal(completedCard.stage, 'done');
  assert.equal(completedCard.completedBy, completionActor);
  assert.equal(completedCard.activeStageBeforeCompletion, 'preparation');

  let audits = await readAuditEvents(appClient);
  const completionAudit = findAudit(audits, 'card-completed', completionActor);
  assertPublicSafeLifecycleAudit(completionAudit, task);
  assert.deepEqual(completionAudit.before, {
    stage: 'preparation', status: 'active', taskCount: 1, openTaskCount: 1,
  });
  assert.deepEqual(completionAudit.after, {
    stage: 'done', status: 'archived', taskCount: 1, openTaskCount: 0,
  });
  assert.ok(completedCard.auditEventRefs?.some((ref) => ref.auditEventId === completionAudit.id));

  const reopenActor = 'synthetic:reopen-actor';
  const reopening = historyEvent(
    persistedCompletedTask,
    'reopened',
    reopenActor,
    '2026-08-13T10:02:00.000Z',
  );
  const reopenedTask = await updateTask(appClient, persistedCompletedTask.id, {
    currentTask: persistedCompletedTask,
    expectedVersion: persistedCompletedTask.version,
    patch: { status: 'todo', completedAt: null, completedBy: null },
    historyEvents: [reopening],
    actorId: reopenActor,
    triggerKind: 'task-reopened',
  });

  const persistedReopenedTask = await getTaskConsistent(appClient, task.id);
  const reopenedCard = await getCardConsistent(appClient, card.id);
  assert.ok(persistedReopenedTask);
  assert.ok(reopenedCard);
  assert.ok(persistedReopenedTask.version > persistedCompletedTask.version);
  assert.equal(persistedReopenedTask.version, reopenedTask.version);
  assert.equal(persistedReopenedTask.status, 'todo');
  assert.equal(persistedReopenedTask.completedAt, undefined);
  assert.equal(persistedReopenedTask.completedBy, undefined);
  assertHistoryContains(persistedReopenedTask, completion);
  assertHistoryContains(persistedReopenedTask, reopening);
  assert.ok(reopenedCard.version > completedCard.version);
  assert.equal(reopenedCard.taskCount, 1);
  assert.equal(reopenedCard.openTaskCount, 1);
  assert.equal(reopenedCard.status, 'active');
  assert.equal(reopenedCard.stage, 'preparation');
  assert.equal(reopenedCard.completedAt, undefined);
  assert.equal(reopenedCard.completedBy, undefined);
  assert.equal(reopenedCard.activeStageBeforeCompletion, undefined);

  audits = await readAuditEvents(appClient);
  const reopenAudit = findAudit(audits, 'card-reactivated', reopenActor);
  assertPublicSafeLifecycleAudit(reopenAudit, task);
  assert.deepEqual(reopenAudit.before, {
    stage: 'done', status: 'archived', taskCount: 1, openTaskCount: 0,
  });
  assert.deepEqual(reopenAudit.after, {
    stage: 'preparation', status: 'active', taskCount: 1, openTaskCount: 1,
  });
  assert.ok(reopenedCard.auditEventRefs?.some((ref) => ref.auditEventId === reopenAudit.id));

  const raceAttempts: Attempt[] = [
    {
      actorId: 'synthetic:race-alpha',
      completedAt: '2026-08-13T10:03:00.000Z',
      historyEvent: historyEvent(
        persistedReopenedTask,
        'completed',
        'synthetic:race-alpha',
        '2026-08-13T10:03:00.000Z',
      ),
    },
    {
      actorId: 'synthetic:race-beta',
      completedAt: '2026-08-13T10:04:00.000Z',
      historyEvent: historyEvent(
        persistedReopenedTask,
        'completed',
        'synthetic:race-beta',
        '2026-08-13T10:04:00.000Z',
      ),
    },
  ];
  transactionBarrier = createTwoPartyBarrier(5_000);
  const raceResults = await Promise.allSettled(raceAttempts.map((attempt) => (
    updateTask(appClient!, persistedReopenedTask.id, {
      currentTask: persistedReopenedTask,
      expectedVersion: persistedReopenedTask.version,
      patch: {
        status: 'done',
        completedAt: attempt.completedAt,
        completedBy: attempt.actorId,
      },
      historyEvents: [attempt.historyEvent],
      actorId: attempt.actorId,
      triggerKind: 'task-completed',
    })
  )));
  transactionBarrier = null;

  const fulfilled = raceResults.flatMap((result, index) => (
    result.status === 'fulfilled' ? [{ attempt: raceAttempts[index], task: result.value }] : []
  ));
  const rejected = raceResults.flatMap((result, index) => (
    result.status === 'rejected' ? [{ attempt: raceAttempts[index], reason: result.reason }] : []
  ));
  assert.equal(fulfilled.length, 1, 'one same-version mutation must win');
  assert.equal(rejected.length, 1, 'one same-version mutation must lose');
  assert.ok(rejected[0].reason instanceof TaskVersionConflictError);

  const winner = fulfilled[0];
  const loser = rejected[0];
  const finalTask = await getTaskConsistent(appClient, task.id);
  const finalCard = await getCardConsistent(appClient, card.id);
  assert.ok(finalTask);
  assert.ok(finalCard);
  assert.ok(finalTask.version > persistedReopenedTask.version);
  assert.equal(finalTask.version, winner.task.version);
  assert.equal(finalTask.status, 'done');
  assert.equal(finalTask.completedBy, winner.attempt.actorId);
  assertHistoryContains(finalTask, winner.attempt.historyEvent);
  assert.equal(
    finalTask.taskHistory.some((event) => event.id === loser.attempt.historyEvent.id),
    false,
    'the losing transaction must not append Task history',
  );
  assert.ok(finalCard.version > reopenedCard.version);
  assert.equal(finalCard.status, 'archived');
  assert.equal(finalCard.stage, 'done');
  assert.equal(finalCard.taskCount, 1);
  assert.equal(finalCard.openTaskCount, 0);
  assert.equal(finalCard.completedBy, winner.attempt.actorId);

  audits = await readAuditEvents(appClient);
  const winnerAudit = findAudit(audits, 'card-completed', winner.attempt.actorId);
  assertPublicSafeLifecycleAudit(winnerAudit, task);
  assert.equal(
    audits.some((event) => event.action === 'card-completed' && event.actorId === loser.attempt.actorId),
    false,
    'the losing transaction must not persist a Card lifecycle audit',
  );
  assert.ok(finalCard.auditEventRefs?.some((ref) => ref.auditEventId === winnerAudit.id));
  const persistedAuditIds = new Set(audits.map((event) => event.id));
  assert.ok(
    finalCard.auditEventRefs?.every((ref) => persistedAuditIds.has(ref.auditEventId)),
    'the losing transaction must not append a dangling Card audit reference',
  );
  assert.equal(sawTransactWrite, true, 'production TransactWriteCommand was not observed');

  const taskItem = await appClient.send(new GetCommand({
    TableName: TABLE_TASKS,
    Key: { PK: `TASK#${task.id}`, SK: `TASK#${task.id}` },
    ConsistentRead: true,
  }));
  assert.equal(taskItem.Item?.version, finalTask.version);
});
