/** Real DynamoDB transaction verification; runs in the owned loopback harness, never against AWS. */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { CreateTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { TABLE_CALENDAR, TABLE_CARDS } from '../src/db/tableNames';
import { createCard, getCardConsistent, updateCard } from '../src/db/cards';
import { planEventTransition, EventConflictError, type EventCommand, type EventRecord } from '../src/events/lifecycle';
import { getEventRecord, commitEventTransition, claimEventOperation, completeEventOperation, getEventHistory } from '../src/events/store';
import { policy } from './helpers/eventPolicy';
import { templateLink } from './helpers/cardTemplate';

const endpoint = process.env.DYNAMODB_ENDPOINT;
if (!endpoint || !/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint)) throw new Error('Event transaction tests require the owned loopback DynamoDB Local harness');
const raw = new DynamoDBClient({ endpoint, region: 'us-east-1', credentials: { accessKeyId: 'local', secretAccessKey: 'local' } });
const client = DynamoDBDocumentClient.from(raw);
before(async () => {
  for (const TableName of [TABLE_CALENDAR, TABLE_CARDS]) {
    try { await raw.send(new CreateTableCommand({ TableName, BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [{ AttributeName: 'PK', AttributeType: 'S' }, { AttributeName: 'SK', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'PK', KeyType: 'HASH' }, { AttributeName: 'SK', KeyType: 'RANGE' }],
    })); } catch (error) { if ((error as { name?: string }).name !== 'ResourceInUseException') throw error; }
  }
});
const now = '2030-01-01T10:00:00.000Z';
function command(transition: EventCommand['transition'], expectedVersion: number): EventCommand {
  return { transition, expectedVersion, operationKey: `${transition}-${expectedVersion}`, actor: 'test', now,
    ...(['propose', 'reschedule'].includes(transition) ? { date: '2030-12-03', time: '12:30', proposal: {
      templateId: 'template', templateVersion: 1, policy: policy(), title: 'Synthetic', topic: 'Test', guestNames: 'Test guest', documentUrl: '', guestEmails: ['test@example.invalid'],
    } } : {}),
  };
}
async function setup() {
  const card = await createCard(client, { ...templateLink(), title: 'Synthetic event' });
  const event = planEventTransition(`hold_${card.id}`, card.id, null, command('propose', 0));
  return { card, event };
}
async function finish(event: EventRecord) {
  const key = event.operations.at(-1)!.key;
  const lease = (await claimEventOperation(client, event.id, key, now))!;
  assert.ok(lease);
  await completeEventOperation(client, event, key, lease, { organizer: 'synthetic-google-event' }, '2030-01-01T10:00:01.000Z');
  return (await getEventRecord(client, event.id))!;
}

test('event, Card datetime, operation and history commit atomically; completion preserves unrelated Card edits', async () => {
  const { card, event } = await setup();
  await commitEventTransition(client, card, 0, event);
  const stored = (await getEventRecord(client, event.id))!;
  const projected = (await getCardConsistent(client, card.id))!;
  assert.equal(projected.anchorDate, event.date);
  assert.equal(projected.eventTime!.startIso, event.startIso);
  assert.equal(projected.eventTime!.sync, 'syncing');
  assert.equal((await getEventHistory(client, event.id)).length, 1);
  const root = (await client.send(new GetCommand({ TableName: TABLE_CALENDAR, Key: { PK: `CALHOLD#${event.id}`, SK: `CALHOLD#${event.id}` } }))).Item!;
  assert.equal(Object.hasOwn(root, 'operations'), false);
  assert.equal(Object.hasOwn(root, 'history'), false);
  await updateCard(client, card.id, { expectedVersion: projected.version, patch: { description: 'Independent Card edit' } });
  const completed = await finish(stored);
  const updated = (await getCardConsistent(client, card.id))!;
  assert.equal(updated.description, 'Independent Card edit');
  assert.equal(updated.eventTime!.sync, 'synced');
  assert.equal(updated.eventTime!.googleEventIds.organizer, 'synthetic-google-event');
  assert.equal(completed.operations[0].state, 'complete');
  assert.equal(completed.version, event.version + 1);
});

test('a stale Card version rolls back the event and all journals', async () => {
  const { card, event } = await setup();
  await updateCard(client, card.id, { expectedVersion: card.version, patch: { description: 'Concurrent edit' } });
  await assert.rejects(() => commitEventTransition(client, card, 0, event), EventConflictError);
  assert.equal(await getEventRecord(client, event.id), null);
  assert.deepEqual(await getEventHistory(client, event.id), []);
  const op = await client.send(new GetCommand({ TableName: TABLE_CALENDAR, Key: { PK: `CALEVENTLOG#${event.id}`, SK: `OP#${event.operations[0].key}` } }));
  assert.equal(op.Item, undefined);
});

test('concurrent approval and reschedule have one winner and cannot split Card/event dates', async () => {
  const { card, event } = await setup();
  await commitEventTransition(client, card, 0, event);
  const current = await finish(event);
  const freshCard = (await getCardConsistent(client, card.id))!;
  const approve = planEventTransition(event.id, card.id, current, command('approve', current.version));
  const change = command('reschedule', current.version); change.date = '2030-12-10';
  const reschedule = planEventTransition(event.id, card.id, current, change);
  const results = await Promise.allSettled([
    commitEventTransition(client, freshCard, current.version, approve),
    commitEventTransition(client, freshCard, current.version, reschedule),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const stored = (await getEventRecord(client, event.id))!;
  const projected = (await getCardConsistent(client, card.id))!;
  assert.equal(projected.anchorDate, stored.date);
  assert.equal(projected.eventTime!.startIso, stored.startIso);
  assert.equal((await getEventHistory(client, event.id)).length, 2);
});

test('exclusive leases fence expired workers and failed completion leaves every projection pending', async () => {
  const { card, event } = await setup(); await commitEventTransition(client, card, 0, event);
  const key = event.operations[0].key;
  const lease = (await claimEventOperation(client, event.id, key, now, 1))!;
  assert.equal(await claimEventOperation(client, event.id, key, now), null);
  await assert.rejects(() => completeEventOperation(client, event, key, lease, {}, '2030-01-01T10:00:02.000Z'), EventConflictError);
  assert.equal((await getEventRecord(client, event.id))!.version, 1);
  assert.equal((await getCardConsistent(client, card.id))!.eventTime!.sync, 'syncing');
  const replacement = (await claimEventOperation(client, event.id, key, '2030-01-01T10:00:02.000Z'))!;
  assert.ok(replacement); assert.notEqual(replacement, lease);
  await assert.rejects(() => completeEventOperation(client, event, key, lease, {}, '2030-01-01T10:00:03.000Z'), EventConflictError);
  await completeEventOperation(client, event, key, replacement, {}, '2030-01-01T10:00:03.000Z');
});

test('legacy authority rows fail loudly before lifecycle writes', async () => {
  await client.send(new PutCommand({ TableName: TABLE_CALENDAR, Item: { PK: 'CALHOLD#legacy-test', SK: 'CALHOLD#legacy-test', id: 'legacy-test', status: 'tentative' } }));
  await assert.rejects(() => getEventRecord(client, 'legacy-test'), /migrated offline/);
});


test('completion retry after a lost successful response is a no-op, including old snapshots', async () => {
  const { card, event } = await setup(); await commitEventTransition(client, card, 0, event);
  const key = event.operations[0].key;
  const lease = (await claimEventOperation(client, event.id, key, now))!;
  const ids = { organizer: 'synthetic-result' };
  await completeEventOperation(client, event, key, lease, ids, '2030-01-01T10:00:01.000Z');
  const before = (await getCardConsistent(client, card.id))!;
  await completeEventOperation(client, event, key, lease, ids, '2030-01-01T10:00:02.000Z');
  const latest = (await getEventRecord(client, event.id))!;
  await completeEventOperation(client, latest, key, lease, ids, '2030-01-01T10:00:02.000Z');
  assert.equal((await getCardConsistent(client, card.id))!.version, before.version);
  await assert.rejects(() => completeEventOperation(client, event, key, lease, { organizer: 'different' }, '2030-01-01T10:00:03.000Z'), EventConflictError);
});

test('oversized authorities are rejected before the atomic write', async () => {
  const { card, event } = await setup();
  event.renderValues.title = '日'.repeat(110000);
  await assert.rejects(() => commitEventTransition(client, card, 0, event), /byte budget/);
  assert.equal(await getEventRecord(client, event.id), null);
  assert.equal((await getCardConsistent(client, card.id))!.eventTime, undefined);
});
