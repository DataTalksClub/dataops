import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { GetCommand, PutCommand, QueryCommand, ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getClient } from '../src/db/client';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { TABLE_ARTIFACTS, TABLE_CALENDAR } from '../src/db/tableNames';
import {
  getGuestIntakeJob, saveGuestIntakeJob, listResumableGuestIntakes, guestIntakeKey, PENDING_INDEX, type GuestIntakeJob,
} from '../src/events/guestIntakeStore';
import { resumeGuestPortalTimeChoices } from '../src/events/guestIntakePortal';
import { pollEventCalendarAcceptances } from '../src/events/service';
import { backfillGuestPendingIndex } from '../scripts/backfill-guest-pending-index';

let db: DynamoDBDocumentClient;
before(async () => { db = await getClient(await startLocal()); await createTables(db); });
after(async () => { await stopLocal(); });

/** Wraps the client and records every command it sends, so tests can prove no Scan reaches the artifacts table. */
function spy(client: DynamoDBDocumentClient) {
  const commands: Array<{ name: string; input: Record<string, any> }> = [];
  const wrapped = { send: (command: any) => { commands.push({ name: command.constructor.name, input: command.input }); return client.send(command); } };
  return { client: wrapped as unknown as DynamoDBDocumentClient, commands };
}
const raw = async (key: Record<string, string>) => (await db.send(new GetCommand({ TableName: TABLE_ARTIFACTS, Key: key, ConsistentRead: true }))).Item;
const indexed = async (kind: string) => (await db.send(new QueryCommand({ TableName: TABLE_ARTIFACTS, IndexName: PENDING_INDEX,
  KeyConditionExpression: 'pendingKind = :k', ExpressionAttributeValues: { ':k': kind } }))).Items || [];
function job(id: string, extra: Partial<GuestIntakeJob> = {}): GuestIntakeJob {
  return { id, cardId: `card-${id}`, taskId: `task-${id}`, actorId: 'synthetic-actor', type: 'webinar', creationKey: id, fingerprint: id,
    status: 'queued', skipEmail: false, createdAt: '2030-01-01T00:00:00.000Z', updatedAt: '2030-01-01T00:00:00.000Z', ...extra };
}

test('pending guest intake jobs are found through the sparse index and leave it once done', async () => {
  await saveGuestIntakeJob(db, job('pending-queued'));
  await saveGuestIntakeJob(db, job('pending-failed', { status: 'failed', retryable: true }));
  await saveGuestIntakeJob(db, job('done-sent', { status: 'sent' }));
  await saveGuestIntakeJob(db, job('stuck-unretryable', { status: 'failed', retryable: false }));

  assert.equal((await raw(guestIntakeKey('pending-queued')))!.pendingKind, 'guest-intake');
  assert.equal((await raw(guestIntakeKey('done-sent')))!.pendingKind, undefined);
  assert.equal((await raw(guestIntakeKey('stuck-unretryable')))!.pendingKind, undefined);
  assert.ok(!('pendingKind' in (await getGuestIntakeJob(db, 'pending-queued'))!), 'the index attribute is storage-only');

  const watched = spy(db);
  const ids = (await listResumableGuestIntakes(watched.client)).map(j => j.id).sort();
  assert.deepEqual(ids, ['pending-failed', 'pending-queued']);
  assert.ok(!watched.commands.some(c => c.name === 'ScanCommand'), 'the backstop must not scan the artifacts table');
  const query = watched.commands.find(c => c.name === 'QueryCommand')!;
  assert.equal(query.input.IndexName, PENDING_INDEX);
  assert.equal(query.input.ConsistentRead, undefined, 'GSI reads are eventually consistent; the worker re-claims conditionally');

  // Completing a job rewrites the row without pendingKind, so it drops out of the index.
  const loaded = (await getGuestIntakeJob(db, 'pending-queued'))!;
  await saveGuestIntakeJob(db, { ...loaded, status: 'sent' });
  assert.equal((await raw(guestIntakeKey('pending-queued')))!.pendingKind, undefined);
  assert.deepEqual((await indexed('guest-intake')).map(i => i.id), ['pending-failed']);
});

test('a leased job stays indexed but is not resumed until its lease expires', async () => {
  await saveGuestIntakeJob(db, job('leased', { leaseUntil: undefined }));
  await db.send(new PutCommand({ TableName: TABLE_ARTIFACTS, Item: { ...(await raw(guestIntakeKey('leased')))!, leaseUntil: Date.now() + 60000 } }));
  assert.ok((await indexed('guest-intake')).some(i => i.id === 'leased'));
  assert.ok(!(await listResumableGuestIntakes(db)).some(j => j.id === 'leased'));
});

test('the guest choice backstop queries only pending choices and a finished choice leaves the index', async () => {
  const pending = { PK: 'GUESTCHOICE#synthetic-missing-doc', SK: 'GUESTCHOICE#synthetic-missing-doc', docId: 'synthetic-missing-doc', choice: 'confirm_proposed',
    intent: { choice: 'confirm_proposed', proposalVersion: 1, proposalStartIso: '2030-12-01T16:00:00.000Z' }, version: 3, status: 'pending', pendingKind: 'guest-choice' };
  await db.send(new PutCommand({ TableName: TABLE_ARTIFACTS, Item: pending }));
  await db.send(new PutCommand({ TableName: TABLE_ARTIFACTS, Item: { ...pending, PK: 'GUESTCHOICE#old', SK: 'GUESTCHOICE#old', docId: 'old', status: 'complete', pendingKind: undefined } }));

  const watched = spy(db);
  assert.deepEqual(await resumeGuestPortalTimeChoices(watched.client), { checked: 1 });
  assert.ok(!watched.commands.some(c => c.name === 'ScanCommand'));
  // The document no longer exists, so the claimed choice is superseded and finished as cancelled.
  const after = (await raw({ PK: pending.PK, SK: pending.SK }))!;
  assert.equal(after.status, 'cancelled');
  assert.equal(after.pendingKind, undefined);
  assert.deepEqual(await indexed('guest-choice'), []);
  assert.deepEqual(await resumeGuestPortalTimeChoices(db), { checked: 0 });
});

test('calendar acceptance poll reads every Scan page instead of stopping at the first 1 MB', async () => {
  const pages = [
    { Items: [{ id: 'hold-page-1', generation: 1 }], LastEvaluatedKey: { PK: 'CALHOLD#hold-page-1', SK: 'CALHOLD#hold-page-1' } },
    { Items: [{ id: 'hold-page-2', generation: 1 }], LastEvaluatedKey: { PK: 'CALHOLD#hold-page-2', SK: 'CALHOLD#hold-page-2' } },
    { Items: [{ id: 'hold-page-3', generation: 1 }] },
  ];
  const scans: Array<Record<string, any>> = [];
  const gets: string[] = [];
  const fake = { send: async (command: any) => {
    if (command instanceof ScanCommand) { scans.push(command.input); return pages[scans.length - 1]; }
    if (command instanceof GetCommand) { gets.push(String(command.input.Key!.PK)); return {}; }
    throw new Error(`unexpected ${command.constructor.name}`);
  } } as unknown as DynamoDBDocumentClient;

  await pollEventCalendarAcceptances(fake, { deps: {} as never, automaticOnly: true });
  assert.equal(scans.length, 3);
  assert.equal(scans[0].ExclusiveStartKey, undefined);
  assert.deepEqual(scans[1].ExclusiveStartKey, pages[0].LastEvaluatedKey);
  assert.deepEqual(scans[2].ExclusiveStartKey, pages[1].LastEvaluatedKey);
  assert.ok(scans.every(s => s.TableName === TABLE_CALENDAR && s.ConsistentRead === undefined));
  assert.match(scans[0].FilterExpression, /autoAcceptancePoll = :auto/);
  assert.deepEqual(gets, ['CALHOLD#hold-page-1', 'CALHOLD#hold-page-2', 'CALHOLD#hold-page-3']);
});

test('one-off backfill indexes pending rows written before pendingKind existed and clears stale ones', async () => {
  const legacy = (id: string, extra: Record<string, unknown>) => ({ ...guestIntakeKey(id), ...job(id), ...extra });
  await db.send(new PutCommand({ TableName: TABLE_ARTIFACTS, Item: legacy('legacy-queued', {}) }));
  await db.send(new PutCommand({ TableName: TABLE_ARTIFACTS, Item: legacy('legacy-sent-stale', { status: 'sent', pendingKind: 'guest-intake' }) }));
  await db.send(new PutCommand({ TableName: TABLE_ARTIFACTS, Item: { PK: 'GUESTCHOICE#legacy', SK: 'GUESTCHOICE#legacy', docId: 'legacy', version: 2, status: 'pending' } }));
  await db.send(new PutCommand({ TableName: TABLE_ARTIFACTS, Item: { PK: 'SPONSORDOC#unrelated', SK: 'SPONSORDOC#unrelated', status: 'pending' } }));

  const dry = await backfillGuestPendingIndex(db, { log: () => {} });
  assert.equal(dry.changed, 3);
  assert.equal((await raw(guestIntakeKey('legacy-queued')))!.pendingKind, undefined, 'dry run writes nothing');

  const applied = await backfillGuestPendingIndex(db, { apply: true, log: () => {} });
  assert.deepEqual({ changed: applied.changed, conflicts: applied.conflicts }, { changed: 3, conflicts: 0 });
  assert.equal((await raw(guestIntakeKey('legacy-queued')))!.pendingKind, 'guest-intake');
  assert.equal((await raw(guestIntakeKey('legacy-sent-stale')))!.pendingKind, undefined);
  assert.equal((await raw({ PK: 'GUESTCHOICE#legacy', SK: 'GUESTCHOICE#legacy' }))!.pendingKind, 'guest-choice');
  assert.equal((await raw({ PK: 'SPONSORDOC#unrelated', SK: 'SPONSORDOC#unrelated' }))!.pendingKind, undefined);
  assert.ok((await listResumableGuestIntakes(db)).some(j => j.id === 'legacy-queued'));

  assert.equal((await backfillGuestPendingIndex(db, { apply: true, log: () => {} })).changed, 0, 'idempotent');
});
