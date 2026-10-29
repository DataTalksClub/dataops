import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert';
import { GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

import { getClient } from '../src/db/client';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createCard, getCard } from '../src/db/cards';
import { templateLink } from './helpers/cardTemplate';
import { createFile } from '../src/db/files';
import { buildNewsletterIssue, issueItem, getNewsletterIssue } from '../src/db/newsletterIssues';
import { TABLE_ARTIFACTS, TABLE_AUDIT_EVENTS, TABLE_NEWSLETTER_SLOTS, TABLE_NOTIFICATIONS } from '../src/db/tableNames';
import { createTask, getTask } from '../src/db/tasks';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

describe('DELETE /api/cards/:id', () => {
  let port: number;
  let client: DynamoDBDocumentClient;
  let handler: typeof import('../src/handler').handler;

  before(async () => {
    port = await startLocal();
    client = await getClient(port);
    await createTables(client);
    process.env.IS_LOCAL = 'true';
    handler = (await import('../src/handler')).handler;
  });

  after(async () => {
    await stopLocal();
    delete process.env.IS_LOCAL;
  });

  afterEach(() => {
    delete process.env.CARD_DELETION_TEST_FAIL_AFTER;
  });

  function remove(cardId: string, body: unknown) {
    return handler({
      httpMethod: 'DELETE',
      path: `/api/cards/${cardId}`,
      headers: { 'x-user-id': 'synthetic-admin' },
      body: body === undefined ? null : JSON.stringify(body),
    }, {});
  }

  async function seed(title: string) {
    const card = await createCard(client, { ...templateLink(), title, anchorDate: '2031-02-02' });
    const first = await createTask(client, { description: `${title} first`, date: '2031-02-02', cardId: card.id });
    const second = await createTask(client, { description: `${title} second`, date: '2031-02-02', cardId: card.id, status: 'done' });
    return { card: (await getCard(client, card.id))!, first, second };
  }

  /** A newsletter issue owning `cardId`, written directly. */
  async function issueOwning(cardId: string) {
    const issue = buildNewsletterIssue({
      kind: 'weekly', publicationDate: '2031-02-02', status: 'planned', slots: { primary: {} }, cardId,
    }, `issue-${cardId}`);
    await client.send(new PutCommand({ TableName: TABLE_NEWSLETTER_SLOTS, Item: issueItem(issue) }));
    return issue;
  }

  it('deletes the Card with its Tasks, unlinks artifacts, drops notifications, and audits it', async () => {
    const { card, first, second } = await seed('Synthetic duplicate card');
    const other = await createCard(client, { ...templateLink(), title: 'Synthetic other card', anchorDate: '2031-02-02' });
    const otherTask = await createTask(client, { description: 'Other', date: '2031-02-02', cardId: other.id });
    await client.send(new PutCommand({ TableName: TABLE_ARTIFACTS, Item: {
      PK: 'ARTIFACT#synthetic-art', SK: 'ARTIFACT#synthetic-art', id: 'synthetic-art', taskId: second.id, title: 'Draft',
    } }));
    await client.send(new PutCommand({ TableName: TABLE_NOTIFICATIONS, Item: {
      PK: 'NOTIFICATION#synthetic-n', SK: 'NOTIFICATION#synthetic-n', id: 'synthetic-n', taskId: first.id,
    } }));

    const res = await remove(card.id, { expectedVersion: card.version });
    assert.strictEqual(res.statusCode, 200, res.body);
    const { deleted } = JSON.parse(res.body);
    assert.strictEqual(deleted.cardId, card.id);
    assert.strictEqual(deleted.title, 'Synthetic duplicate card');
    assert.deepStrictEqual(new Set(deleted.deletedTaskIds), new Set([first.id, second.id]));
    assert.deepStrictEqual(deleted.unlinked.artifacts, ['synthetic-art']);
    assert.deepStrictEqual(deleted.unlinked.notifications, ['synthetic-n']);

    assert.strictEqual(await getCard(client, card.id), null);
    assert.strictEqual(await getTask(client, first.id), null);
    assert.strictEqual(await getTask(client, second.id), null);
    assert.ok(await getTask(client, otherTask.id));
    const artifact = (await client.send(new GetCommand({
      TableName: TABLE_ARTIFACTS, Key: { PK: 'ARTIFACT#synthetic-art', SK: 'ARTIFACT#synthetic-art' },
    }))).Item!;
    assert.strictEqual(artifact.taskId, undefined);
    const notification = (await client.send(new GetCommand({
      TableName: TABLE_NOTIFICATIONS, Key: { PK: 'NOTIFICATION#synthetic-n', SK: 'NOTIFICATION#synthetic-n' },
    }))).Item;
    assert.strictEqual(notification, undefined);

    const audits = (await client.send(new ScanCommand({ TableName: TABLE_AUDIT_EVENTS }))).Items || [];
    const audit = audits.find(({ id }) => id === deleted.auditEventId)!;
    assert.strictEqual(audit.action, 'card-deleted');
    assert.strictEqual(audit.actorId, 'synthetic-admin');
    assert.strictEqual(audit.title, 'Synthetic duplicate card');
    assert.strictEqual(audit.taskCount, 2);
    assert.ok(Date.parse(audit.createdAt));

    const again = await remove(card.id, { expectedVersion: card.version });
    assert.strictEqual(again.statusCode, 404, again.body);
    assert.strictEqual(JSON.parse(again.body).code, 'card_not_found');
  });

  it('requires expectedVersion and rejects a stale one without writing', async () => {
    const { card, first } = await seed('Synthetic stale card');
    for (const body of [undefined, {}, { expectedVersion: 0 }, { version: card.version }]) {
      const res = await remove(card.id, body);
      assert.strictEqual(res.statusCode, 400, res.body);
    }
    const stale = await remove(card.id, { expectedVersion: card.version + 3 });
    assert.strictEqual(stale.statusCode, 409, stale.body);
    assert.strictEqual(JSON.parse(stale.body).code, 'card_version_conflict');
    assert.ok(await getCard(client, card.id));
    assert.ok(await getTask(client, first.id));
  });

  it('refuses while an uploaded file still belongs to one of its Tasks, naming it', async () => {
    const { card, first } = await seed('Synthetic card with evidence');
    const file = await createFile(client, {
      taskId: first.id, cardId: card.id, filename: 'proof.png', category: 'image', storagePath: 'synthetic/proof.png',
    });
    const res = await remove(card.id, { expectedVersion: card.version });
    assert.strictEqual(res.statusCode, 409, res.body);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.code, 'card_has_references');
    assert.deepStrictEqual(body.references, {
      files: [file.id], sponsorDeliverables: [], newsletterIssues: [], linkingTasks: [],
    });
    assert.ok(await getCard(client, card.id));
  });

  it('refuses while a newsletter issue owns the Card: the issue decides its Card', async () => {
    const { card, first } = await seed('Synthetic issue card');
    const issue = await issueOwning(card.id);
    const res = await remove(card.id, { expectedVersion: card.version });
    assert.strictEqual(res.statusCode, 409, res.body);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.code, 'card_has_references');
    assert.deepStrictEqual(body.references.newsletterIssues, [issue.id]);
    assert.match(body.error, /delete or cancel the issue/);
    assert.ok(await getCard(client, card.id));
    assert.ok(await getTask(client, first.id));
    assert.strictEqual((await getNewsletterIssue(client, issue.id))?.cardId, card.id);
  });

  it('rolls every write back when the transaction fails part-way', async () => {
    const { card, first, second } = await seed('Synthetic rollback card');
    process.env.CARD_DELETION_TEST_FAIL_AFTER = '3';
    const res = await remove(card.id, { expectedVersion: card.version });
    assert.strictEqual(res.statusCode, 500, res.body);
    assert.deepStrictEqual(await getCard(client, card.id), card);
    assert.deepStrictEqual(await getTask(client, first.id), first);
    assert.deepStrictEqual(await getTask(client, second.id), second);
  });
});
