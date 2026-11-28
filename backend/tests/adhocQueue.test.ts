import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getClient } from '../src/db/client';
import { startLocal, stopLocal, createTables } from '../scripts/local-dynamodb';
import { getTask } from '../src/db/tasks';
import { createUser, updateUser } from '../src/db/users';
import {
  adhocQueueItemId,
  adhocQueueTaskId,
  handleAdhocQueueRoutes,
  setAdhocQueueSecretReaderForTests,
  setAdhocQueueOperatorPagerForTests,
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
    const pages: Array<{ alarmName: string; reason: string }> = [];
    setAdhocQueueOperatorPagerForTests(async (alarm) => { pages.push(alarm); return { published: true, topicArn: 'arn:test' }; });
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
      setAdhocQueueOperatorPagerForTests(null);
    }
    assert.ok(written.some((line) => line.includes('"StoreFailure":1') && line.includes('DataOps/AdhocQueue')));
    assert.equal(pages.length, 1);
    assert.equal(pages[0].alarmName, 'dataops-v1-adhoc-queue-store-failure');
    assert.match(pages[0].reason, /table missing/);
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

  describe('task sources', () => {
    const BAN_TOKEN = 'synthetic-slack-mod-app-queue-token';
    let orinId: string;
    const ban = (key: string, extra: Record<string, unknown> = {}) => ({
      source: 'slack-mod-app',
      kind: 'slack.ban-request',
      title: `Slack ban request ${key}: deactivate U0SYNTH0001`,
      payload: { decision: { request_id: key, member_id: 'U0SYNTH0001' }, decision_digest: 'd'.repeat(64) },
      links: [{ label: 'Source decision', url: `https://mod.example.test/?request=${key}` }],
      idempotencyKey: `ban-request:${key}`,
      task: {
        description: 'Slack ban: deactivate U0SYNTH0001',
        checklist: ['Run the guarded action', 'Verify inactive', 'Resolve the source request'],
        instructionDocId: 'sop.community.slack.process-slack-moderation-ban-requests',
        comment: 'Source: synthetic request',
        browserRequirement: 'headless',
      },
      ...extra,
    });

    before(async () => {
      orinId = (await createUser(client, { email: 'orin@datatalks.club', name: 'Orin', role: 'admin' })).id;
    });

    it('materializes exactly one Task assigned to the operator, with the checklist and SOP inline', async () => {
      secrets({ 'adhoc-queue.slack-mod-app': BAN_TOKEN });
      const first = await post(ban('synthetic-1'), BAN_TOKEN);
      assert.equal(first.status, 201);
      const itemId = adhocQueueItemId('slack-mod-app', 'ban-request:synthetic-1');
      const taskId = adhocQueueTaskId(itemId);
      assert.equal(first.body.item.taskId, taskId);
      const task = await getTask(client, taskId);
      assert.ok(task);
      assert.equal(task.assigneeId, orinId);
      assert.equal(task.source, 'queue:slack-mod-app');
      assert.equal(task.queueItemId, itemId);
      assert.equal(task.status, 'todo');
      assert.equal(task.instructionDocId, 'sop.community.slack.process-slack-moderation-ban-requests');
      assert.equal(task.browserRequirement, 'headless');
      assert.deepEqual(task.tags, ['slack-ban']);
      assert.deepEqual(task.checklistItems?.map((row) => row.text), ['Run the guarded action', 'Verify inactive', 'Resolve the source request']);
      assert.ok(task.checklistItems?.every((row) => row.instructionDocId === task.instructionDocId && !row.checked));
      assert.equal(task.comment, 'Source: synthetic request');
      assert.equal(task.materials?.[0].url, 'https://mod.example.test/?request=synthetic-1');

      // A retry, even with a different spec, keeps the one stored item and Task.
      const retry = await post(ban('synthetic-1', { task: { description: 'other', checklist: ['x'] } }), BAN_TOKEN);
      assert.equal(retry.status, 200);
      assert.equal(retry.body.duplicate, true);
      assert.equal(retry.body.item.taskId, taskId);
      assert.equal((await getTask(client, taskId))?.description, 'Slack ban: deactivate U0SYNTH0001');
      assert.equal((await getTask(client, taskId))?.version, 1);
    });

    it('requires a valid task block from a task source and refuses one from any other source', async () => {
      secrets({ 'adhoc-queue.slack-mod-app': BAN_TOKEN, 'adhoc-queue.aisl': TOKEN });
      const cases: [Record<string, unknown>, RegExp][] = [
        [ban('bad-1', { task: undefined }), /task must be an object/],
        [ban('bad-2', { task: { description: 'x', checklist: [] } }), /checklist/],
        [ban('bad-3', { task: { description: 'x', checklist: ['a'], instructionDocId: '../etc' } }), /instructionDocId/],
        [ban('bad-4', { task: { description: 'x', checklist: ['a'], browserRequirement: 'maybe' } }), /browserRequirement/],
      ];
      for (const [body, message] of cases) {
        const res = await post(body, BAN_TOKEN);
        assert.equal(res.status, 400, JSON.stringify(body));
        assert.match(res.body.error.message, message);
      }
      const foreign = await post({ ...sample, idempotencyKey: 'aisl-task', task: ban('x').task });
      assert.equal(foreign.status, 400);
      assert.match(foreign.body.error.message, /registered task source/);
      // An unregistered kind from the same source stays a plain item.
      const plain = await post({ ...ban('plain-1'), kind: 'slack.note', task: undefined }, BAN_TOKEN);
      assert.equal(plain.status, 201);
      assert.equal(plain.body.item.taskId, undefined);
    });

    it('answers 503 when the assignee cannot be resolved, and the retry creates the Task once it can', async () => {
      secrets({ 'adhoc-queue.slack-mod-app': BAN_TOKEN });
      const originalError = console.error;
      const original = process.stdout.write.bind(process.stdout);
      console.error = () => {};
      (process.stdout as unknown as { write: (s: string) => boolean }).write = () => true;
      setAdhocQueueOperatorPagerForTests(async () => ({ published: true, topicArn: 'arn:test' }));
      await updateUser(client, orinId, { disabled: true });
      let failed;
      try {
        failed = await post(ban('synthetic-2'), BAN_TOKEN);
      } finally {
        await updateUser(client, orinId, { disabled: false });
        console.error = originalError;
        (process.stdout as unknown as { write: typeof original }).write = original;
        setAdhocQueueOperatorPagerForTests(null);
      }
      assert.equal(failed.status, 503);
      const taskId = adhocQueueTaskId(adhocQueueItemId('slack-mod-app', 'ban-request:synthetic-2'));
      assert.equal(await getTask(client, taskId), null);
      const retry = await post(ban('synthetic-2'), BAN_TOKEN);
      assert.equal(retry.status, 200);
      assert.equal(retry.body.item.taskId, taskId);
      assert.equal((await getTask(client, taskId))?.assigneeId, orinId);
    });
  });
});
