import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { GetCommand, PutCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { migratePodcastGuestIdentity } from '../scripts/migrate-podcast-guest-identity';
import { disableLocalTransactionEmulation, getClient, usesLocalTransactionEmulation } from '../src/db/client';
import { cardSponsorDocIndexKey, sponsorDocKey } from '../src/db/sponsorDocs';
import { TABLE_ARTIFACTS } from '../src/db/tableNames';

const endpoint = process.env.DYNAMODB_ENDPOINT;
if (endpoint && (new URL(endpoint).hostname !== '127.0.0.1' || new URL(endpoint).protocol !== 'http:')) {
  throw new Error('Migration transaction tests require an explicit loopback-only DynamoDB endpoint');
}

describe(`podcast guest identity migration script (${endpoint ? 'real DynamoDB transactions' : 'Dynalite condition emulation'})`, () => {
  let client: DynamoDBDocumentClient;
  const id = 'synthetic-migration-doc';
  const cardId = 'synthetic-migration-card';
  const content = { guestName: 'Jane Doe, Staff Engineer at Example', notes: 'Keep this answer' };
  const primaryKey = sponsorDocKey(id);
  const indexKey = cardSponsorDocIndexKey(cardId, id);

  beforeEach(async () => {
    if (endpoint) {
      disableLocalTransactionEmulation();
      assert.equal(usesLocalTransactionEmulation(), false);
      client = await getClient();
    } else client = await getClient(await startLocal());
    await createTables(client);
    await client.send(new PutCommand({ TableName: TABLE_ARTIFACTS, Item: {
      ...primaryKey, id, cardId, template: 'podcast', content, version: 4,
      updatedAt: '2026-01-01T00:00:00.000Z', accessCodeHash: 'synthetic-hash',
    } }));
    await client.send(new PutCommand({ TableName: TABLE_ARTIFACTS, Item: {
      ...indexKey, id, cardId, template: 'podcast', version: 4,
      updatedAt: '2026-01-01T00:00:00.000Z',
    } }));
  });
  afterEach(async () => { client.destroy(); if (!endpoint) await stopLocal(); });

  async function read(key = primaryKey) {
    return (await client.send(new GetCommand({ TableName: TABLE_ARTIFACTS, Key: key, ConsistentRead: true }))).Item!;
  }

  function afterScan(mutate: () => Promise<void>) {
    let mutated = false;
    client.middlewareStack.add((next, context) => async (args) => {
      const result = await next(args);
      if (context.commandName === 'ScanCommand' && !mutated) {
        mutated = true;
        await mutate();
      }
      return result;
    }, { step: 'initialize', name: 'concurrentGuestEdit' });
  }

  it('finds the real persisted key prefix and defaults to a read-only dry run', async () => {
    const before = await read();
    const messages: string[] = [];
    const result = await migratePodcastGuestIdentity(client, { log: (message) => messages.push(message) });
    assert.equal(result.scanned, 1);
    assert.equal(result.candidates, 1);
    assert.equal(result.updated, 0);
    assert.equal(result.apply, false);
    assert.deepEqual(await read(), before);
    assert.equal((await read(indexKey)).version, 4);
    assert.doesNotMatch(messages.join('\n'), /Jane Doe|Keep this answer|synthetic-hash/);
  });

  it('migrates once, advances primary and summary versions together, and preserves unrelated fields', async () => {
    const result = await migratePodcastGuestIdentity(client, { apply: true, log: () => {} });
    assert.equal(result.updated, 1);
    assert.equal(result.conflicts, 0);
    const primary = await read();
    const index = await read(indexKey);
    assert.deepEqual(primary.content, {
      guestName: 'Jane Doe', guestRole: 'Staff Engineer', guestCompany: 'Example', notes: content.notes,
    });
    assert.equal(primary.accessCodeHash, 'synthetic-hash');
    assert.equal(primary.version, 5);
    assert.equal(index.version, 5);
    assert.equal(index.updatedAt, primary.updatedAt);
    const again = await migratePodcastGuestIdentity(client, { apply: true, log: () => {} });
    assert.equal(again.candidates, 0);
    assert.equal(again.updated, 0);
    assert.deepEqual(await read(), primary);
  });

  for (const advanceVersion of [false, true]) {
    it(`preserves a guest edit made after scan (${advanceVersion ? 'new' : 'unchanged'} version)`, async () => {
      const newerContent = { ...content, guestName: 'A different guest identity', notes: 'New guest answer after scan' };
      afterScan(async () => {
        await client.send(new UpdateCommand({
          TableName: TABLE_ARTIFACTS, Key: primaryKey,
          UpdateExpression: 'SET content = :content, #version = :version',
          ExpressionAttributeNames: { '#version': 'version' },
          ExpressionAttributeValues: { ':content': newerContent, ':version': advanceVersion ? 5 : 4 },
        }));
      });
      const result = await migratePodcastGuestIdentity(client, { apply: true, log: () => {} });
      assert.equal(result.updated, 0);
      assert.equal(result.conflicts, 1);
      assert.deepEqual((await read()).content, newerContent);
      assert.equal((await read()).version, advanceVersion ? 5 : 4);
      assert.equal((await read(indexKey)).version, 4);
    });
  }

  it('preserves unrelated content changed without a version bump', async () => {
    afterScan(async () => {
      await client.send(new UpdateCommand({
        TableName: TABLE_ARTIFACTS, Key: primaryKey,
        UpdateExpression: 'SET content.notes = :answer',
        ExpressionAttributeValues: { ':answer': 'New unrelated answer' },
      }));
    });
    const result = await migratePodcastGuestIdentity(client, { apply: true, log: () => {} });
    assert.equal(result.updated, 1);
    const primary = await read();
    assert.equal(primary.content.notes, 'New unrelated answer');
    assert.equal(primary.content.guestName, 'Jane Doe');
  });

  it('leaves primary content unchanged when the summary changed concurrently', async () => {
    const before = await read();
    afterScan(async () => {
      await client.send(new UpdateCommand({
        TableName: TABLE_ARTIFACTS, Key: indexKey,
        UpdateExpression: 'SET #version = :version',
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: { ':version': 5 },
      }));
    });
    const result = await migratePodcastGuestIdentity(client, { apply: true, log: () => {} });
    assert.equal(result.updated, 0);
    assert.equal(result.conflicts, 1);
    assert.deepEqual(await read(), before);
    assert.equal((await read(indexKey)).version, 5);
  });

  it('CLI reports unresolved conflicts with structured counts and a nonzero exit', { skip: !endpoint }, async () => {
    const before = await read();
    await client.send(new UpdateCommand({
      TableName: TABLE_ARTIFACTS, Key: indexKey,
      UpdateExpression: 'SET #version = :version',
      ExpressionAttributeNames: { '#version': 'version' },
      ExpressionAttributeValues: { ':version': 5 },
    }));
    const child = spawnSync(process.execPath, [
      '--import', 'tsx', 'scripts/migrate-podcast-guest-identity.ts', '--apply',
    ], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, TMPDIR: '/tmp' }, encoding: 'utf8', timeout: 20_000 });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 1, child.stderr);
    const report = JSON.parse(child.stdout.trim().split('\n').at(-1)!);
    assert.equal(report.conflicts, 1);
    assert.equal(report.updated, 0);
    assert.deepEqual(await read(), before);
  });
});
