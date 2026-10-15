import assert from 'node:assert/strict';
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
import { CardDeletionConflictError, deleteCardCascade } from '../src/db/cardDeletion';
import { createCard, getCardConsistent } from '../src/db/cards';
import { templateLink } from './helpers/cardTemplate';
import { buildNewsletterIssue, createIssueWrite, deleteIssueWrite } from '../src/db/newsletterIssues';
import {
  TABLE_ARTIFACTS,
  TABLE_AUDIT_EVENTS,
  TABLE_CALENDAR,
  TABLE_CARDS,
  TABLE_FILES,
  TABLE_INTAKE,
  TABLE_NEWSLETTER_SLOTS,
  TABLE_NOTIFICATIONS,
  TABLE_SPONSOR_CRM,
  TABLE_TASKS,
} from '../src/db/tableNames';
import { createTask, getTaskConsistent } from '../src/db/tasks';

type Dict = Record<string, unknown>;

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
    { AttributeName: 'cardId', AttributeType: 'S' },
  ],
  KeySchema: [
    { AttributeName: 'PK', KeyType: 'HASH' },
    { AttributeName: 'SK', KeyType: 'RANGE' },
  ],
  GlobalSecondaryIndexes: [{
    IndexName: 'GSI-Card',
    KeySchema: [
      { AttributeName: 'cardId', KeyType: 'HASH' },
      { AttributeName: 'SK', KeyType: 'RANGE' },
    ],
    Projection: { ProjectionType: 'ALL' },
  }],
};

const SIMPLE_TABLES: CreateTableCommandInput[] = [
  TABLE_CARDS,
  TABLE_AUDIT_EVENTS,
  TABLE_NEWSLETTER_SLOTS,
  TABLE_ARTIFACTS,
  TABLE_INTAKE,
  TABLE_NOTIFICATIONS,
  TABLE_FILES,
  TABLE_CALENDAR,
  TABLE_SPONSOR_CRM,
].map((TableName) => ({
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
}));

async function waitForDynamoDB(raw: DynamoDBClient): Promise<void> {
  const deadline = Date.now() + 15_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await raw.send(new ListTablesCommand({ Limit: 1 }));
      return;
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw new Error(`DynamoDB Local did not answer a bounded readiness probe: ${String(lastError)}`);
}

async function waitForTable(raw: DynamoDBClient, tableName: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await raw.send(new DescribeTableCommand({ TableName: tableName }));
    if (result.Table?.TableStatus === 'ACTIVE') return;
    await delay(50);
  }
  throw new Error(`Throwaway table ${tableName} did not become ACTIVE`);
}

async function row(client: DynamoDBDocumentClient, tableName: string, pk: string): Promise<Dict | undefined> {
  return (await client.send(new GetCommand({
    TableName: tableName,
    Key: { PK: pk, SK: pk },
    ConsistentRead: true,
  }))).Item as Dict | undefined;
}

test('admin Card deletion is one transaction on official DynamoDB Local', { timeout: 30_000 }, async (t) => {
  assert.equal(process.env.NODE_ENV, 'production');
  assert.ok(ENDPOINT?.startsWith('http://127.0.0.1:'), 'runner must provide an ephemeral loopback endpoint');

  const raw = new DynamoDBClient({ endpoint: ENDPOINT, region: REGION, credentials: CREDENTIALS });
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
  const client = appClient;
  let transactWrites = 0;
  const send = client.send.bind(client);
  client.send = (async (command: unknown, ...rest: unknown[]) => {
    if (command instanceof TransactWriteCommand) transactWrites += 1;
    return (send as (...args: unknown[]) => Promise<unknown>)(command, ...rest);
  }) as typeof client.send;

  const card = await createCard(client, { ...templateLink(), title: 'Synthetic duplicate newsletter', anchorDate: '2031-01-05' });
  const first = await createTask(client, { description: 'First', date: '2031-01-05', cardId: card.id });
  const second = await createTask(client, { description: 'Second', date: '2031-01-05', cardId: card.id });
  const keeper = await createCard(client, { ...templateLink(), title: 'Synthetic kept newsletter', anchorDate: '2031-01-05' });
  const kept = await createTask(client, { description: 'Kept', date: '2031-01-05', cardId: keeper.id });
  // The newsletter issue that owns the Card is deleted in the same transaction.
  const issue = buildNewsletterIssue({
    kind: 'weekly', publicationDate: '2031-01-05', status: 'planned', slots: { primary: { ticked: true } }, cardId: card.id,
  }, 'synthetic-issue');
  await client.send(new PutCommand(createIssueWrite(issue).item.Put as any));
  const owner = { newsletterIssueId: issue.id, write: deleteIssueWrite(issue) };
  await client.send(new PutCommand({ TableName: TABLE_ARTIFACTS, Item: {
    PK: 'ARTIFACT#art-1', SK: 'ARTIFACT#art-1', id: 'art-1', cardId: card.id, taskId: first.id, title: 'Synthetic draft',
  } }));
  await client.send(new PutCommand({ TableName: TABLE_INTAKE, Item: {
    PK: 'INTAKE#in-1', SK: 'INTAKE#in-1', id: 'in-1', cardIds: [card.id, keeper.id], taskIds: [second.id, kept.id],
    updatedAt: '2031-01-01T00:00:00.000Z',
  } }));
  await client.send(new PutCommand({ TableName: TABLE_NOTIFICATIONS, Item: {
    PK: 'NOTIFICATION#n-1', SK: 'NOTIFICATION#n-1', id: 'n-1', taskId: first.id, cardId: card.id,
  } }));
  await client.send(new PutCommand({ TableName: TABLE_NOTIFICATIONS, Item: {
    PK: 'NOTIFICATION#n-2', SK: 'NOTIFICATION#n-2', id: 'n-2', taskId: kept.id, cardId: keeper.id,
  } }));

  const current = (await getCardConsistent(client, card.id))!;

  // A Task that moves on after the plan was read cancels the whole transaction.
  const firstNow = (await getTaskConsistent(client, first.id))!;
  const stalePlanClient = client.send;
  let raced = false;
  client.send = (async (command: unknown, ...rest: unknown[]) => {
    if (command instanceof TransactWriteCommand && !raced) {
      raced = true;
      await send(new PutCommand({
        TableName: TABLE_TASKS,
        Item: { PK: `TASK#${first.id}`, SK: `TASK#${first.id}`, ...firstNow, version: firstNow.version + 1 },
      }));
    }
    return (stalePlanClient as (...args: unknown[]) => Promise<unknown>)(command, ...rest);
  }) as typeof client.send;
  await assert.rejects(
    deleteCardCascade(client, card.id, current.version, 'synthetic-admin', owner),
    CardDeletionConflictError,
  );
  client.send = stalePlanClient;
  assert.ok(await row(client, TABLE_CARDS, `CARD#${card.id}`), 'a cancelled deletion keeps the Card');
  assert.ok(await row(client, TABLE_TASKS, `TASK#${second.id}`), 'a cancelled deletion keeps every Task');
  assert.equal((await row(client, TABLE_NEWSLETTER_SLOTS, `ISSUE#${issue.id}`))?.cardId, card.id);
  assert.equal((await row(client, TABLE_ARTIFACTS, 'ARTIFACT#art-1'))?.cardId, card.id);
  assert.ok(await row(client, TABLE_NOTIFICATIONS, 'NOTIFICATION#n-1'));

  const result = await deleteCardCascade(client, card.id, current.version, 'synthetic-admin', owner);
  assert.ok(transactWrites >= 2, 'both attempts used TransactWriteCommand');
  assert.deepEqual(new Set(result.deletedTaskIds), new Set([first.id, second.id]));
  assert.deepEqual(result.unlinked, {
    artifacts: ['art-1'],
    intakeItems: ['in-1'],
    notifications: ['n-1'],
  });

  assert.equal(await row(client, TABLE_CARDS, `CARD#${card.id}`), undefined);
  assert.equal(await row(client, TABLE_TASKS, `TASK#${first.id}`), undefined);
  assert.equal(await row(client, TABLE_TASKS, `TASK#${second.id}`), undefined);
  assert.ok(await row(client, TABLE_TASKS, `TASK#${kept.id}`));
  assert.equal(await row(client, TABLE_NEWSLETTER_SLOTS, `ISSUE#${issue.id}`), undefined, 'the owning issue goes with its Card');
  const artifact = (await row(client, TABLE_ARTIFACTS, 'ARTIFACT#art-1'))!;
  assert.equal(artifact.cardId, undefined);
  assert.equal(artifact.taskId, undefined);
  const intake = (await row(client, TABLE_INTAKE, 'INTAKE#in-1'))!;
  assert.deepEqual(intake.cardIds, [keeper.id]);
  assert.deepEqual(intake.taskIds, [kept.id]);
  assert.equal(await row(client, TABLE_NOTIFICATIONS, 'NOTIFICATION#n-1'), undefined);
  assert.ok(await row(client, TABLE_NOTIFICATIONS, 'NOTIFICATION#n-2'));

  const audits = ((await client.send(new ScanCommand({ TableName: TABLE_AUDIT_EVENTS, ConsistentRead: true }))).Items || []) as Dict[];
  const audit = audits.find(({ action }) => action === 'card-deleted');
  assert.ok(audit);
  assert.equal(audit.id, result.auditEventId);
  assert.equal(audit.actorId, 'synthetic-admin');
  assert.equal(audit.title, 'Synthetic duplicate newsletter');
  assert.equal(audit.taskCount, 2);
  assert.equal(audit.cardVersion, current.version);
});
