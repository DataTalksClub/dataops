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
