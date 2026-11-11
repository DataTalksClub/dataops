import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getClient } from '../src/db/client';
import { startLocal, stopLocal, createTables } from '../scripts/local-dynamodb';
import { handleInboxRoutes } from '../src/routes/inbox';

describe('Materials inbox', () => {
  let client: DynamoDBDocumentClient;
  before(async () => {
    process.env.SKIP_AUTH = 'true';
    client = await getClient(await startLocal());
    await createTables(client);
  });
  after(async () => { await stopLocal(); });

  async function request(method: string, path: string, body?: unknown, query?: Record<string, string>) {
    const res = await handleInboxRoutes({
      httpMethod: method,
      path,
      body: body === undefined ? undefined : JSON.stringify(body),
      queryStringParameters: query,
    }, client);
    assert.ok(res);
    return { status: res.statusCode, body: JSON.parse(res.body) };
  }

  it('saves a material unprocessed with provenance and keeps it visible until processed', async () => {
    const provenance = {
      source: 'synthetic-test-intake',
      replyTo: 't3002s10592',
      sha256: 'synthetic-sha256',
      bytes: 18,
    };
    const created = await request('POST', '/api/inbox', {
      id: 'inbox-test-first-item',
      title: 'Synthetic case-study brief',
      body: '# Synthetic brief\n\nSanitized test content.',
      summary: 'Sanitized test summary',
      metadata: { provenance },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.item.status, 'new');
    assert.equal(created.body.item.bodyRef, '# Synthetic brief\n\nSanitized test content.');
    assert.deepEqual(created.body.item.metadata.provenance, provenance);
    assert.ok(created.body.item.tags.includes('materials-inbox'));

    const listed = await request('GET', '/api/inbox');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.unprocessedCount, 1);
    assert.equal(listed.body.totalCount, 1);
    assert.equal(listed.body.items.length, 1);
    assert.equal(listed.body.items[0].bodyRef, undefined);

    const detail = await request('GET', '/api/inbox/inbox-test-first-item');
    assert.equal(detail.status, 200);
    assert.equal(detail.body.item.bodyRef, '# Synthetic brief\n\nSanitized test content.');

    const unprocessed = await request('GET', '/api/inbox', undefined, { status: 'unprocessed' });
    assert.equal(unprocessed.body.items.length, 1);

    const processed = await request('PUT', '/api/inbox/inbox-test-first-item', {
      status: 'archived',
      resolutionReason: 'Saved to the permanent location',
    });
    assert.equal(processed.status, 200);
    assert.equal(processed.body.item.status, 'archived');

    const after = await request('GET', '/api/inbox');
    assert.equal(after.body.unprocessedCount, 0);
    assert.equal(after.body.items[0].status, 'archived');
  });

  it('validates inbox input and status transitions', async () => {
    assert.equal((await request('POST', '/api/inbox', { title: '', body: 'x' })).status, 400);
    assert.equal((await request('POST', '/api/inbox', { title: 'T', body: '' })).status, 400);
    assert.equal((await request('POST', '/api/inbox', { title: 'T', body: 'x', priority: 'nope' })).status, 400);
    const created = await request('POST', '/api/inbox', { title: 'Second', body: 'content' });
    assert.equal(created.status, 201);
    const id = created.body.item.id;
    assert.equal((await request('PUT', `/api/inbox/${id}`, { status: 'archived' })).status, 400);
    assert.equal((await request('PUT', `/api/inbox/${id}`, { status: 'bogus' })).status, 400);
    assert.equal((await request('PUT', '/api/inbox/missing-item', { title: 'x' })).status, 404);
    assert.equal((await request('GET', '/api/inbox/missing-item')).status, 404);
  });

  it('reuses the same idempotent id instead of duplicating the inbox item', async () => {
    const first = await request('POST', '/api/inbox', { id: 'inbox-idempotent', title: 'Once', body: 'same content' });
    assert.equal(first.status, 201);
    const second = await request('POST', '/api/inbox', { id: 'inbox-idempotent', title: 'Once', body: 'same content' });
    assert.equal(second.status, 200);
    assert.equal(second.body.item.id, 'inbox-idempotent');
  });
});
