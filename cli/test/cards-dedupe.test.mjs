import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { captureIo, fakePortal, isolateConfig } from './helpers.mjs';
isolateConfig();
const realFetch = globalThis.fetch;
const { run } = await import('../src/cli.mjs');
afterEach(() => { globalThis.fetch = realFetch; });
const keep = { id: 'template', version: 3, status: 'todo', description: 'Collect stats from X post', templateId: 'newsletter', templateTaskRef: 'collect-x-stats', comment: 'Template note' };
const extra = { id: 'manual', version: 2, status: 'waiting', description: '  collect STATS from X post ', comment: 'Manual comment', link: 'https://example.test/post', notesLog: [{ text: 'Manual note', createdAt: '2026-01-01', authorId: 'operator' }], taskHistory: [{ action: 'created' }] };
function routes() {
  return {
    'GET /api/cards/c': { card: { id: 'c' } },
    'GET /api/cards': ({ query }) => ({ cards: { items: [{ id: query.cursor ? 'd' : 'c' }], ...(query.cursor ? {} : { nextCursor: 'page2' }) } }),
    'GET /api/tasks': ({ query }) => query.cardId === 'd' ? { tasks: [] } : query.cursor ? { tasks: [extra] } : { tasks: [keep], nextCursor: 'tasks2' },
    'GET /api/tasks/template': keep,
    'PUT /api/tasks/template': ({ body }) => ({ ...keep, ...body, version: 4 }),
    'POST /api/tasks/manual/actions/skip': ({ body }) => ({ ...extra, status: 'skipped', skipReason: body.reason }),
  };
}
test('dry-run is default, prints IDs and follows task pagination without writes', async () => {
  const calls = fakePortal(routes());
  const io = captureIo();
  assert.equal(await run(['cards', 'dedupe-tasks', '--card', 'c'], io), 0);
  assert.ok(calls.every(({ method }) => method === 'GET'));
  for (const id of ['c', 'template', 'manual']) assert.ok(io.text().includes(id));
  assert.match(io.text(), /Dry-run: 1 duplicate pairs/);
});
test('all follows card pagination and explicit dry-run is read-only', async () => {
  const calls = fakePortal(routes());
  const io = captureIo();
  assert.equal(await run(['cards', 'dedupe-tasks', '--all', '--dry-run', '--json'], io), 0);
  assert.equal(io.json().cardsScanned, 2);
  assert.equal(io.json().pairs.length, 1);
  assert.ok(calls.every(({ method }) => method === 'GET'));
});
test('apply copies notes/comment/link before versioned skip, never DELETE', async () => {
  const calls = fakePortal(routes());
  assert.equal(await run(['cards', 'dedupe-tasks', '--card', 'c', '--apply'], captureIo()), 0);
  const writes = calls.filter(({ method }) => method !== 'GET');
  assert.deepEqual(writes.map(({ method }) => method), ['PUT', 'POST']);
  assert.equal(writes[0].body.expectedVersion, 3);
  assert.equal(writes[0].body.link, extra.link);
  assert.match(writes[0].body.comment, /Manual note/);
  assert.match(writes[0].body.comment, /Manual comment/);
  assert.deepEqual(writes[1].body, { expectedVersion: 2, reason: 'duplicate of template' });
  assert.deepEqual(extra.taskHistory, [{ action: 'created' }]);
});
test('resolved manual copies and ambiguous template owners are left alone', async () => {
  for (const tasks of [[keep, { ...extra, status: 'done' }], [keep, { ...keep, id: 'second' }, extra]]) {
    const calls = fakePortal({ ...routes(), 'GET /api/tasks': { tasks } });
    const io = captureIo();
    assert.equal(await run(['cards', 'dedupe-tasks', '--card', 'c', '--apply', '--json'], io), 0);
    assert.deepEqual(io.json().pairs, []);
    assert.ok(calls.every(({ method }) => method === 'GET'));
  }
});
test('retry after merge does not append the same notes twice', async () => {
  const calls = fakePortal({ ...routes(), 'GET /api/tasks/template': { ...keep, link: extra.link, notesLog: [{ text: 'Duplicate task manual\nAlready copied' }] } });
  assert.equal(await run(['cards', 'dedupe-tasks', '--card', 'c', '--apply'], captureIo()), 0);
  assert.deepEqual(calls.filter(({ method }) => method !== 'GET').map(({ method }) => method), ['POST']);
});
