import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolateConfig, fakePortal } from './helpers.mjs';
isolateConfig();
const docs = await import('../src/commands/cardDocuments.mjs');
const io = { print() {} };
test('staff-only card document CLI scopes listing and copy to the target card', async () => {
  const calls = fakePortal({
    'GET /api/card-documents': { documents: [] },
    'POST /api/card-documents': ({ body }) => ({ document: { id: 'new', version: 1, ...body } }),
  });
  await docs.list({ card: 'event', json: true }, io);
  assert.equal(calls[0].query.cardId, 'event');
  await docs.create({ card: 'target', from: 'source', json: true }, io);
  assert.deepEqual(calls[1].body, { cardId: 'target', from: 'source' });
});
test('staff-only card edits and deletion preserve explicit version checks', async () => {
  const calls = fakePortal({
    'GET /api/card-documents/doc': { document: { title: 'Private plan', content: 'Original', version: 3 } },
    'PUT /api/card-documents/doc': ({ body }) => ({ document: { id: 'doc', ...body } }),
    'DELETE /api/card-documents/doc': { deleted: true },
  });
  const saved = await docs.update({ _: ['doc'], content: 'Reviewed', version: '2', json: true }, io);
  assert.equal(saved.document.version, 2);
  assert.equal(saved.document.title, 'Private plan');
  await docs.remove({ _: ['doc'], version: '2', json: true }, io);
  assert.equal(calls.at(-1).query.version, '2');
  assert.equal(calls.at(-1).body, undefined);
  await assert.rejects(() => docs.update({ _: ['doc'], content: 'Oops', json: true }, io), /version/);
});
test('staff-only document exports use the individual authenticated export endpoint', async () => {
  const calls = fakePortal({
    'GET /api/card-documents/doc/export': () => new Response('Private café\nSaved content'),
  });
  const result = await docs.commands.export({ _: ['doc'], format: 'md', json: true }, io);
  assert.equal(result.content, 'Private café\nSaved content');
  assert.equal(calls[0].query.format, 'md');
});
