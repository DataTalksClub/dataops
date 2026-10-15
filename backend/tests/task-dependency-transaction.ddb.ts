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
import { PutCommand, ScanCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { disableLocalTransactionEmulation, getClient, usesLocalTransactionEmulation } from '../src/db/client';
import { TABLE_AUDIT_EVENTS, TABLE_CARDS, TABLE_TASKS } from '../src/db/tableNames';
import { TaskDependencyError } from '../src/db/taskDependencies';
import { CardLifecycleConflictError, deleteTask, getTaskConsistent, updateTask } from '../src/db/tasks';
import type { Card, Task } from '../src/types';

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


const NOW = '2026-10-01T10:00:00.000Z';

test('task dependency guards hold on official DynamoDB Local', { timeout: 60_000 }, async (t) => {
  assert.equal(process.env.NODE_ENV, 'production');
  assert.ok(ENDPOINT?.startsWith('http://127.0.0.1:'), 'runner must provide an ephemeral loopback endpoint');

  const raw = new DynamoDBClient({ endpoint: ENDPOINT, region: REGION, credentials: CREDENTIALS });
  const createdTables: string[] = [];
  let client: DynamoDBDocumentClient | undefined;
  t.after(async () => {
    client?.destroy();
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
  client = await getClient();
  const db = client;

  let sawConditionCheck = false;
  const intercepted = db as unknown as { send(command: unknown): Promise<unknown> };
  const productionSend = intercepted.send.bind(db);
  intercepted.send = async (command: unknown) => {
    if (command instanceof TransactWriteCommand) {
      sawConditionCheck ||= (command.input.TransactItems || []).some((item) => item.ConditionCheck);
    }
    return productionSend(command);
  };

  async function seedCard(taskCount: number): Promise<Card> {
    const card: Card = {
      id: `dep-card-${randomUUID()}`, version: 1, title: 'Synthetic dependency Card',
      taskCount, openTaskCount: taskCount, stage: 'preparation', status: 'active',
      createdAt: NOW, updatedAt: NOW,
    };
    await db.send(new PutCommand({
      TableName: TABLE_CARDS, Item: { PK: `CARD#${card.id}`, SK: `CARD#${card.id}`, ...card },
    }));
    return card;
  }
  async function seedTask(card: Card, name: string, fields: Partial<Task> = {}): Promise<Task> {
    const task: Task = {
      id: `dep-task-${randomUUID()}`, version: 1, description: name, date: '2026-10-01', status: 'todo',
      cardId: card.id, taskHistory: [], createdAt: NOW, updatedAt: NOW, ...fields,
    };
    await db.send(new PutCommand({
      TableName: TABLE_TASKS, Item: { PK: `TASK#${task.id}`, SK: `TASK#${task.id}`, ...task },
    }));
    return task;
  }
  const read = async (id: string) => (await getTaskConsistent(db, id))!;

  await t.test('completion needs every prerequisite done, in the same transaction', async () => {
    const card = await seedCard(2);
    const prerequisite = await seedTask(card, 'Prerequisite');
    const dependent = await seedTask(card, 'Dependent', { dependsOn: [prerequisite.id] });
    await assert.rejects(
      updateTask(db, dependent.id, { expectedVersion: 1, patch: { status: 'done' } }),
      (error: unknown) => error instanceof TaskDependencyError && error.code === 'prerequisites-incomplete',
    );
    await updateTask(db, prerequisite.id, { expectedVersion: 1, patch: { status: 'done' } });
    const done = await updateTask(db, dependent.id, { expectedVersion: 1, patch: { status: 'done' } });
    assert.equal(done.status, 'done');
    assert.equal(sawConditionCheck, true, 'the production ConditionCheck was not exercised');
  });

  await t.test('a prerequisite reopened between the check and the write cancels the completion', async () => {
    const card = await seedCard(2);
    const prerequisite = await seedTask(card, 'Prerequisite', { status: 'done', completedAt: NOW });
    const dependent = await seedTask(card, 'Dependent', { dependsOn: [prerequisite.id] });
    // Reopen the prerequisite after the dependent's checks read it as done.
    let reopened = false;
    const send = db.send.bind(db) as (command: unknown) => Promise<unknown>;
    (db as unknown as { send: typeof send }).send = async (command: unknown) => {
      if (command instanceof TransactWriteCommand && !reopened) {
        reopened = true;
        await db.send(new PutCommand({
          TableName: TABLE_TASKS,
          Item: {
            PK: `TASK#${prerequisite.id}`, SK: `TASK#${prerequisite.id}`,
            ...prerequisite, status: 'todo', version: 2,
          },
        }));
      }
      return send(command);
    };
    try {
      await assert.rejects(updateTask(db, dependent.id, { expectedVersion: 1, patch: { status: 'done' } }));
    } finally {
      (db as unknown as { send: typeof send }).send = send;
    }
    assert.equal((await read(dependent.id)).status, 'todo');
  });

  await t.test('concurrent edits that would form a cycle cannot both commit', async () => {
    const card = await seedCard(2);
    const a = await seedTask(card, 'A');
    const b = await seedTask(card, 'B');
    const results = await Promise.allSettled([
      updateTask(db, a.id, { expectedVersion: 1, patch: { dependsOn: [b.id] } }),
      updateTask(db, b.id, { expectedVersion: 1, patch: { dependsOn: [a.id] } }),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const [finalA, finalB] = [await read(a.id), await read(b.id)];
    assert.equal(Boolean(finalA.dependsOn) && Boolean(finalB.dependsOn), false);
  });

  await t.test('a prerequisite of a completed Task cannot be reopened', async () => {
    const card = await seedCard(2);
    const prerequisite = await seedTask(card, 'Prerequisite', { status: 'done', completedAt: NOW });
    await seedTask(card, 'Dependent', { dependsOn: [prerequisite.id], status: 'done', completedAt: NOW });
    await assert.rejects(
      updateTask(db, prerequisite.id, { expectedVersion: 1, patch: { status: 'todo', completedAt: null } }),
      (error: unknown) => error instanceof TaskDependencyError && error.code === 'prerequisite-of-completed-task',
    );
    assert.equal((await read(prerequisite.id)).status, 'done');
  });

  await t.test('a dependent inserted after the dependents were read cancels the delete', async () => {
    const card = await seedCard(2);
    const prerequisite = await seedTask(card, 'Prerequisite');
    const later = await seedTask(card, 'Later dependent');
    const send = db.send.bind(db) as (command: unknown) => Promise<unknown>;
    let fired = false;
    (db as unknown as { send: typeof send }).send = async (command: unknown) => {
      const result = await send(command);
      if (!fired && command instanceof ScanCommand) {
        fired = true;
        await updateTask(db, later.id, { expectedVersion: 1, patch: { dependsOn: [prerequisite.id] } });
      }
      return result;
    };
    try {
      await assert.rejects(deleteTask(db, prerequisite.id, 1), CardLifecycleConflictError);
    } finally {
      (db as unknown as { send: typeof send }).send = send;
    }
    assert.ok(await getTaskConsistent(db, prerequisite.id));
    assert.deepEqual((await read(later.id)).dependsOn, [prerequisite.id]);
  });
});
