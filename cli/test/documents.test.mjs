import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolateConfig, fakePortal } from './helpers.mjs';
isolateConfig();
const docs = await import('../src/commands/documents.mjs');
const io = { print() {} };
test('document CLI lists by task and sends explicit edit version', async () => {
  const calls = fakePortal({
    'GET /api/documents': { documents: [] },
    'GET /api/documents/doc': { document: { title: 'Title', content: 'Original', version: 3 } },
    'PUT /api/documents/doc': ({ body }) => ({ document: { id: 'doc', ...body } }),
  });
  await docs.list({ task: 'task-id', json: true }, io);
  assert.equal(calls[0].query.taskId, 'task-id');
  const result = await docs.update({ _: ['doc'], content: 'Reviewed', version: '2', json: true }, io);
  assert.equal(result.document.version, 2);
  assert.equal(result.document.title, 'Title');
  assert.equal(result.document.content, 'Reviewed');
  await assert.rejects(() => docs.update({ _: ['doc'], content: 'Oops', json: true }, io), /version/);
});
test('document copy requires target task and lets server clone original text', async () => {
  const calls = fakePortal({ 'POST /api/documents': ({ body }) => ({ document: { id: 'new', version: 1, ...body } }) });
  await docs.create({ task: 'target', from: 'source', json: true }, io);
  assert.deepEqual(calls[0].body, { taskId: 'target', from: 'source' });
  await assert.rejects(() => docs.create({ task: 'target', title: 'T', kind: 'note', file: '/unused', content: 'both' }, io), /--file or --content/);
});

test('document delete sends version in query rather than body', async () => {
  const calls = fakePortal({ 'DELETE /api/documents/doc': { deleted: true } });
  await docs.remove({ _: ['doc'], version: '2', json: true }, io);
  assert.equal(calls[0].query.version, '2');
  assert.equal(calls[0].body, undefined);
});

const staff = { id: 'staff', name: 'Staff', kind: 'staff' };
test('comment thread round-trip: add, list, reply threading, resolve, delete', async () => {
  const thread = {
    id: 'thread-1', documentId: 'doc', quote: 'Quoted sentence', resolved: false, resolvedBy: null,
    version: 1, updatedAt: '2026-11-05T00:00:00Z',
    posts: [{ id: 'p1', body: 'Please check this', author: staff, createdAt: '2026-11-05T00:00:00Z' }],
  };
  const calls = fakePortal({
    'POST /api/documents/doc/comments': ({ body }) => ({
      status: 201, body: { thread: { ...thread, posts: [{ id: 'p1', body: body.body, author: staff, createdAt: '2026-11-05T00:00:00Z' }] } },
    }),
    'GET /api/documents/doc/comments': { threads: [thread] },
    'POST /api/documents/doc/comments/thread-1/reply': ({ body }) => ({
      status: 200,
      body: {
        thread: {
          ...thread, version: body.version + 1,
          posts: [...thread.posts, { id: 'p2', body: body.body, author: { id: 'g', name: 'Guest', kind: 'reviewer' }, createdAt: '2026-11-05T01:00:00Z' }],
        },
      },
    }),
    'POST /api/documents/doc/comments/thread-1/resolve': ({ body }) => ({
      status: 200, body: { thread: { ...thread, resolved: body.resolved, resolvedBy: body.resolved ? staff : null, version: body.version + 1 } },
    }),
    'DELETE /api/documents/doc/comments/thread-1': { deleted: true },
  });
  const added = await docs.comment({ _: ['add', 'doc'], body: 'Please check this', quote: 'Quoted sentence', json: true }, io);
  assert.equal(added.thread.posts.length, 1);
  assert.deepEqual(calls[0].body, { body: 'Please check this', quote: 'Quoted sentence' });
  const listed = await docs.comment({ _: ['list', 'doc'], json: true }, io);
  assert.equal(listed.threads[0].quote, 'Quoted sentence');
  const reply = await docs.comment({ _: ['reply', 'doc', 'thread-1'], body: 'Checked', version: '1', json: true }, io);
  assert.equal(reply.thread.posts.length, 2);
  assert.equal(reply.thread.posts[1].author.kind, 'reviewer');
  assert.equal(reply.thread.version, 2);
  await assert.rejects(() => docs.comment({ _: ['reply', 'doc', 'thread-1'], body: 'Again', json: true }, io), /--version/);
  const resolved = await docs.comment({ _: ['resolve', 'doc', 'thread-1'], version: '2', json: true }, io);
  assert.equal(resolved.thread.resolved, true);
  const reopened = await docs.comment({ _: ['resolve', 'doc', 'thread-1'], version: '3', reopen: true, json: true }, io);
  assert.equal(reopened.thread.resolved, false);
  const removed = await docs.comment({ _: ['delete', 'doc', 'thread-1'], version: '4', json: true }, io);
  assert.equal(removed.deleted, true);
  assert.equal(calls[calls.length - 1].query.version, '4');
  assert.equal(calls[calls.length - 1].body, undefined);
});
test('reviewer add returns a one-time review link; revoke and list round-trip', async () => {
  const reviewer = { id: 'rev-1', name: 'Guest Reviewer', createdAt: '2026-11-05T00:00:00Z', expiresAt: '2026-12-05T00:00:00Z' };
  const calls = fakePortal({
    'POST /api/documents/doc/reviewers': ({ body }) => ({ status: 201, body: { reviewer, token: 'rev-1.tok', reviewPath: '/document-review/doc?review=rev-1.tok' } }),
    'GET /api/documents/doc/reviewers': { reviewers: [reviewer] },
    'DELETE /api/documents/doc/reviewers/rev-1': { revoked: true },
  });
  const captured = [];
  const result = await docs.reviewer({ _: ['add', 'doc'], name: 'Guest Reviewer' }, { print: line => captured.push(String(line)) });
  assert.equal(result.reviewer.name, 'Guest Reviewer');
  assert.match(result.reviewPath, /review=/);
  assert.match(captured.find(line => line.startsWith('Review link')), /review=/);
  const listed = await docs.reviewer({ _: ['list', 'doc'], json: true }, io);
  assert.equal(listed.reviewers[0].id, 'rev-1');
  const revoked = await docs.reviewer({ _: ['revoke', 'doc', 'rev-1'], json: true }, io);
  assert.equal(revoked.revoked, true);
  assert.equal(calls[calls.length - 1].method, 'DELETE');
  assert.equal(calls[calls.length - 1].route, '/api/documents/doc/reviewers/rev-1');
  await assert.rejects(() => docs.comment({ _: [], json: true }, io), /Missing comment action/);
  await assert.rejects(() => docs.reviewer({ _: ['bogus', 'doc'], json: true }, io), /Unknown reviewer action/);
});
