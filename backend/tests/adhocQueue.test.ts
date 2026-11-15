import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getClient } from '../src/db/client';
import { startLocal, stopLocal, createTables } from '../scripts/local-dynamodb';
import {
  adhocQueueItemId,
  handleAdhocQueueRoutes,
  setAdhocQueueSecretReaderForTests,
} from '../src/routes/adhocQueue';

const TOKEN = 'synthetic-aisl-queue-token';

describe('Ad-hoc queue', () => {
  let client: DynamoDBDocumentClient;
  before(async () => {
    process.env.SKIP_AUTH = 'true';
    client = await getClient(await startLocal());
    await createTables(client);
  });
  after(async () => { await stopLocal(); });
  afterEach(() => setAdhocQueueSecretReaderForTests(null));

  function secrets(map: Record<string, string>) {
    setAdhocQueueSecretReaderForTests(async (name) => {
      if (name in map) return map[name];
      throw new Error(`Secret '${name}' does not exist or has no ciphertext`);
    });
  }

  async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, query?: Record<string, string>) {
    const res = await handleAdhocQueueRoutes({
      httpMethod: method,
      path,
      headers,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      queryStringParameters: query,
    }, client);
    assert.ok(res);
    return { status: res.statusCode, body: JSON.parse(res.body) };
  }

  const post = (body: unknown, token = TOKEN) => call('POST', '/api/v1/queue/items', body, token ? { authorization: `Bearer ${token}` } : {});

  const sample = {
    source: 'aisl',
    kind: 'event.updated',
    title: 'Evals in CI moved to 2026-11-23 14:00',
    payload: { eventId: 42, changes: { start: ['2026-11-16T13:00:00Z', '2026-11-23T13:00:00Z'] } },
    links: [{ label: 'Event', url: 'https://aishippinglabs.com/events/evals-in-ci' }],
    idempotencyKey: 'event-42-v3',
  };

  it('stores a post from any registered source and dedupes a retry', async () => {
    secrets({ 'adhoc-queue.aisl': TOKEN });
    const first = await post(sample);
    assert.equal(first.status, 201);
    assert.equal(first.body.item.id, adhocQueueItemId('aisl', 'event-42-v3'));
    assert.equal(first.body.item.status, 'new');
    assert.deepEqual(first.body.item.links, sample.links);

    const retry = await post({ ...sample, title: 'changed on retry' });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.duplicate, true);
    assert.equal(retry.body.item.title, sample.title);

    const list = await call('GET', '/api/queue');
    assert.equal(list.status, 200);
    assert.equal(list.body.items.filter((i: { id: string }) => i.id === first.body.item.id).length, 1);
  });

  it('is not tied to one source: a second system posts with its own token', async () => {
    secrets({ 'adhoc-queue.aisl': TOKEN, 'adhoc-queue.billing': 'other-token' });
    const res = await post({ ...sample, source: 'billing', kind: 'invoice.overdue', idempotencyKey: 'inv-1' }, 'other-token');
    assert.equal(res.status, 201);
    // AISL's token cannot post as billing.
    const cross = await post({ ...sample, source: 'billing', idempotencyKey: 'inv-2' }, TOKEN);
    assert.equal(cross.status, 401);
  });

  it('rejects missing or wrong tokens and unregistered sources with 401', async () => {
    secrets({ 'adhoc-queue.aisl': TOKEN });
    assert.equal((await post(sample, '')).status, 401);
    assert.equal((await post(sample, 'wrong')).status, 401);
    assert.equal((await post({ ...sample, source: 'nobody' }, TOKEN)).status, 401);
  });

  it('rejects malformed bodies with a clear 400', async () => {
    secrets({ 'adhoc-queue.aisl': TOKEN });
    const notJson = await call('POST', '/api/v1/queue/items', '{nope', { authorization: `Bearer ${TOKEN}` });
    assert.equal(notJson.status, 400);
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ ...sample, kind: 'Event Updated' }, /kind/],
      [{ ...sample, title: '' }, /title/],
      [{ ...sample, idempotencyKey: undefined }, /idempotencyKey/],
      [{ ...sample, payload: [1] }, /payload/],
      [{ ...sample, links: [{ url: 'javascript:alert(1)' }] }, /link/],
    ];
    for (const [body, message] of cases) {
      const res = await post(body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match(res.body.error.message, message);
    }
  });

  it('fails loudly with 503 when storage fails', async () => {
    secrets({ 'adhoc-queue.aisl': TOKEN });
    const broken = { send: async () => { throw Object.assign(new Error('table missing'), { name: 'ResourceNotFoundException' }); } };
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (chunk: string) => { written.push(String(chunk)); return true; };
    const originalError = console.error;
    console.error = () => {};
    try {
      const res = await handleAdhocQueueRoutes({
        httpMethod: 'POST', path: '/api/v1/queue/items',
        headers: { authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ ...sample, idempotencyKey: 'broken-1' }),
      }, broken as unknown as DynamoDBDocumentClient);
      assert.equal(res?.statusCode, 503);
    } finally {
      (process.stdout as unknown as { write: typeof original }).write = original;
      console.error = originalError;
    }
    assert.ok(written.some((line) => line.includes('"StoreFailure":1') && line.includes('DataOps/AdhocQueue')));
  });

  it('lets an operator ack and mark done with a note; done items leave the open list', async () => {
    secrets({ 'adhoc-queue.aisl': TOKEN });
    const created = await post({ ...sample, idempotencyKey: 'event-42-cancel', kind: 'event.cancelled' });
    const id = created.body.item.id;

    const shown = await call('GET', `/api/queue/${id}`);
    assert.equal(shown.body.item.kind, 'event.cancelled');

    const acked = await call('PUT', `/api/queue/${id}/status`, { status: 'acked' });
    assert.equal(acked.status, 200);
    assert.equal(acked.body.item.status, 'acked');

    assert.equal((await call('PUT', `/api/queue/${id}/status`, { status: 'done' })).status, 400);
    const done = await call('PUT', `/api/queue/${id}/status`, { status: 'done', note: 'Card re-anchored' });
    assert.equal(done.body.item.status, 'done');
    assert.equal(done.body.item.history.length, 3);

    const open = await call('GET', '/api/queue');
    assert.ok(!open.body.items.some((i: { id: string }) => i.id === id));
    const all = await call('GET', '/api/queue', undefined, {}, { status: 'all' });
    assert.ok(all.body.items.some((i: { id: string }) => i.id === id));

    assert.equal((await call('GET', '/api/queue/q-000000000000000000000000')).status, 404);
    assert.equal((await call('GET', '/api/queue/bad id')).status, 400);
  });
});
