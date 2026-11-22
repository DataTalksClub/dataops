import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KnowledgeStore } from '../src/docs/knowledgeStore';
import { KnowledgeValidationError, recordValidation, requireKnowledgeValidation, validationCandidate, withValidatedKnowledgePublisher } from '../src/docs/knowledgeValidation';
import { syntheticKnowledge } from './helpers/knowledge';

const url = 'https://github.com/DataTalksClub/dataops-knowledge/actions/runs/123';
const change = [{ path: 'content/example.md', bytes: 'New content' }];
test('full gate holds activation, deduplicates retries, binds receipts to exact bytes, base and actor', async () => {
  const { s3, store, publication } = syntheticKnowledge({ 'content/example.md': 'Original' });
  const dispatched: string[] = [];
  const dispatch = async (id: string) => { dispatched.push(id); };
  let id = '';
  for (let retry = 0; retry < 2; retry++) {
    await assert.rejects(() => requireKnowledgeValidation(store, publication, change, 'editor', dispatch), (error: unknown) => {
      assert.ok(error instanceof KnowledgeValidationError);
      assert.equal(error.status, 'pending');
      id = error.id;
      return true;
    });
  }
  assert.equal(dispatched.length, 1);
  assert.equal(JSON.parse(s3.objects.get(`${store.bucket}/active.json`)!.toString()).revision, publication.revision);
  assert.equal((await validationCandidate(store, id)).mutations[0].base64, Buffer.from('New content').toString('base64'));
  await recordValidation(store, id, { status: 'passed', runUrl: url });
  await requireKnowledgeValidation(store, publication, change, 'editor', dispatch);
  for (const [base, mutations, actor] of [
    [publication, [{ ...change[0], bytes: 'Different' }], 'editor'],
    [{ ...publication, revision: 'another' }, change, 'editor'],
    [publication, change, 'another-editor'],
  ] as const) {
    await assert.rejects(() => requireKnowledgeValidation(store, base, [...mutations], actor, dispatch), KnowledgeValidationError);
  }
});
test('failed gates stay rejected and dispatch errors stay loud and retryable', async () => {
  const { store, publication } = syntheticKnowledge({ 'content/example.md': 'Original' });
  await assert.rejects(() => requireKnowledgeValidation(store, publication, change, 'editor', async () => { throw new Error('HTTP 403'); }), /Could not start full knowledge validation/);
  let id = '';
  await assert.rejects(() => requireKnowledgeValidation(store, publication, change, 'editor', async value => { id = value; }), KnowledgeValidationError);
  await recordValidation(store, id, { status: 'failed', runUrl: url });
  await assert.rejects(() => requireKnowledgeValidation(store, publication, change, 'editor'), (error: unknown) => {
    assert.ok(error instanceof KnowledgeValidationError);
    assert.equal(error.status, 'failed');
    assert.match(error.message, /rejected/);
    return true;
  });
});
test('store enforces the full gate and publisher trust is scoped to its async request', async () => {
  const { s3, publication } = syntheticKnowledge({ 'asset.bin': 'Original' });
  const store = new KnowledgeStore({ bucket: 'test-knowledge', client: s3, offline: false, validate: (target, prior, mutations, actor) => requireKnowledgeValidation(target, prior, mutations, actor, async () => {}) });
  const mutation = [{ path: 'asset.bin', bytes: 'Changed' }];
  await assert.rejects(() => store.publish(mutation, publication.revision, 'editor', 'Edit'), KnowledgeValidationError);
  const saved = await withValidatedKnowledgePublisher(() => store.publish(mutation, publication.revision, 'publisher', 'Publish tested commit'));
  assert.notEqual(saved.revision, publication.revision);
  await assert.rejects(() => store.publish(mutation, saved.revision, 'editor', 'Edit'), KnowledgeValidationError);
});
test('rename with replacement and restore candidates carry exact effective bytes', async () => {
  const { store, publication } = syntheticKnowledge({ 'content/old.md': 'Original' });
  let id = '';
  const mutations = [{ path: 'content/new.md', sourcePath: 'content/old.md', bytes: 'Replacement' }, { path: 'content/restored.md', restoreRevision: publication.revision }];
  // Restore an existing historical path, including a rename in the same batch.
  mutations[1].path = 'content/old.md';
  await assert.rejects(() => requireKnowledgeValidation(store, publication, mutations, 'editor', async value => { id = value; }), KnowledgeValidationError);
  const candidate = await validationCandidate(store, id);
  assert.deepEqual(candidate.mutations, [
    { path: 'content/new.md', base64: Buffer.from('Replacement').toString('base64') },
    { path: 'content/old.md', base64: Buffer.from('Original').toString('base64') },
  ]);
});

test('candidate matches a rename of an earlier edit and canonicalizes independent write order', async () => {
  const { store, publication } = syntheticKnowledge({ 'content/a.md': 'Old', 'content/z.md': 'Z' });
  let id = '';
  const mutations = [{ path: 'content/a.md', bytes: 'New' }, { path: 'content/b.md', sourcePath: 'content/a.md' }];
  await assert.rejects(() => requireKnowledgeValidation(store, publication, mutations, 'editor', async value => { id = value; }), KnowledgeValidationError);
  assert.deepEqual((await validationCandidate(store, id)).mutations, [
    { path: 'content/a.md' }, { path: 'content/b.md', base64: Buffer.from('New').toString('base64') },
  ]);
  let first = '';
  const writes = [{ path: 'content/a.md', bytes: 'A' }, { path: 'content/z.md', bytes: 'Z' }];
  await assert.rejects(() => requireKnowledgeValidation(store, publication, writes, 'editor', async value => { first = value; }), KnowledgeValidationError);
  await recordValidation(store, first, { status: 'passed', runUrl: url });
  await requireKnowledgeValidation(store, publication, [...writes].reverse(), 'editor', async () => { throw new Error('Should reuse exact final state'); });
});

test('the actual docs save route exposes pending, failed and accepted validation decisions', async () => {
  const { configureDocsRuntime, resetDocsRuntime, handleDocsRoutes } = await import('../src/docs/contentApi');
  const content = '---\nid: reference.example\ndoc_type: reference\nstatus: proposed\nconfidentiality: internal\n---\n# Example\n\n## References\n- Service documentation\n';
  const { s3, publication } = syntheticKnowledge({ 'content/example.md': content });
  const store = new KnowledgeStore({ bucket: 'test-knowledge', client: s3, offline: false, validate: (target, prior, mutations, actor) => requireKnowledgeValidation(target, prior, mutations, actor, async () => {}) });
  configureDocsRuntime(store);
  const event = { httpMethod: 'PUT', path: '/docs', headers: {}, queryStringParameters: { path: 'content/example.md' }, body: JSON.stringify({ content: content + '\nChanged.\n', expectedRevision: publication.revision }) };
  try {
    const pending = await handleDocsRoutes(event, 'editor');
    assert.equal(pending?.statusCode, 422, pending?.body);
    const decision = JSON.parse(pending!.body).validation;
    assert.equal(decision.status, 'pending');
    assert.match(JSON.parse(pending!.body).error, /has not been saved/);
    assert.equal((await store.pin()).revision, publication.revision);
    await recordValidation(store, decision.id, { status: 'failed', runUrl: url });
    const rejected = await handleDocsRoutes(event, 'editor');
    assert.equal(rejected?.statusCode, 400);
    assert.equal((await store.pin()).revision, publication.revision);
    await recordValidation(store, decision.id, { status: 'passed', runUrl: url });
    const accepted = await handleDocsRoutes(event, 'editor');
    assert.equal(accepted?.statusCode, 200, accepted?.body);
    assert.notEqual((await store.pin()).revision, publication.revision);
    assert.equal(await store.readFile('content/example.md'), content + '\nChanged.\n');
  } finally { resetDocsRuntime(); }
});
