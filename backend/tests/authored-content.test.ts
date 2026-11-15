import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authoredContentIssues } from '../src/docs/authoredContent';
import { syntheticKnowledge } from './helpers/knowledge';
import { configureDocsRuntime, resetDocsRuntime, handleDocsRoutes } from '../src/docs/contentApi';

const document = (body: string, metadata = '') => `---\nid: reference.example\ndoc_type: reference\nstatus: proposed\nconfidentiality: internal\n${metadata}---\n# Example\n${body}\n## References\n- Maintained service documentation\n`;

test('content gates reject debt and privacy findings without echoing sensitive values', () => {
  for (const body of ['TODO: fill in', 'TBD', 'FIXME', '<insert image>', "couldn't be converted automatically", 'content size mismatch', '![](image.png)', '<!-- sop-caption-start -->\nThis screenshot shows something']) {
    assert.ok(authoredContentIssues('content/example.md', document(body)).length, body);
  }
  for (const value of ['person@example.test', 'ghp_' + 'a'.repeat(30), 'github_pat_' + 'a'.repeat(30), 'xoxb-' + 'a'.repeat(30), 'AKIA' + 'A'.repeat(16), 'sk_live_' + 'a'.repeat(20), '-----BEGIN PRIVATE KEY-----']) {
    const issues = authoredContentIssues('content/example.md', document(value));
    assert.ok(issues.length);
    assert.ok(!issues.join(' ').includes(value));
  }
  assert.deepEqual(authoredContentIssues('content/example.md', document('Ready')), []);
  assert.ok(authoredContentIssues('content/example.md', document('## Summary\n')).some(issue => issue.includes('empty Summary')));
  assert.deepEqual(authoredContentIssues('content/example.md', document('person@example.test').replace('internal', 'restricted-internal')), []);
  assert.deepEqual(authoredContentIssues('content/example.md', document('TODO').replace('proposed', 'archived')), []);
  assert.ok(authoredContentIssues('content/example.md', document('person@example.test').replace('proposed', 'archived')).length);
});

test('required controls must contain meaningful text', () => {
  for (const type of ['sop', 'template', 'prompt', 'reference', 'playbook', 'checklist']) {
    const text = document('').replace('doc_type: reference', `doc_type: ${type}`).replace('- Maintained service documentation', '<!-- comment -->\n- References:');
    assert.ok(authoredContentIssues('content/example.md', text).length, type);
  }
});

test('publication rejects the entire batch before writing objects, including rename and restore', async () => {
  const bad = document('TBD');
  const { store, s3, publication } = syntheticKnowledge({ 'content/example.md': document('Ready'), 'content/old.md': bad });
  const before = [...s3.objects.keys()];
  for (const mutation of [
    { path: 'content/example.md', bytes: bad },
    { path: 'content/copied.md', sourcePath: 'content/old.md' },
    { path: 'content/old.md', restoreRevision: publication.revision },
  ]) {
    await assert.rejects(() => store.publish([{ path: 'content/first.md', bytes: document('Ready') }, mutation], publication.revision, 'actor', 'Edit'), /Authored-content validation failed/);
    assert.deepEqual([...s3.objects.keys()], before);
    assert.equal((await store.pin()).revision, publication.revision);
  }
});

test('web save, create, preview and bulk publication return actionable errors and preserve revision', async () => {
  const { store, publication } = syntheticKnowledge({ 'content/example.md': document('Ready') });
  configureDocsRuntime(store);
  try {
    for (const [method, path, body] of [
      ['PUT', '/docs', { path: 'content/example.md', content: document('TBD'), expectedRevision: publication.revision }],
      ['POST', '/docs', { path: 'content/new.md', content: document('person@example.test'), absent: true, expectedRevision: publication.revision }],
      ['POST', '/docs/preview-write', { path: 'content/example.md', content: document('TBD') }],
      ['POST', '/knowledge/publish', { expectedRevision: publication.revision, mutations: [{ path: 'content/example.md', base64: Buffer.from(document('TBD')).toString('base64') }] }],
    ] as const) {
      const response = await handleDocsRoutes({ httpMethod: method, path, headers: {}, queryStringParameters: { path: 'content/example.md' }, body: JSON.stringify(body) }, 'actor');
      assert.equal(response?.statusCode, 400, `${path}: ${response?.body}`);
      assert.match(response?.body || '', /Authored-content validation failed/);
      assert.equal((await store.pin()).revision, publication.revision);
    }
  } finally { resetDocsRuntime(); }
});


test('unfinished controls save with path-specific warnings instead of silently passing the gates', async () => {
  const { store, publication } = syntheticKnowledge({ 'content/example.md': document('Ready') });
  configureDocsRuntime(store);
  try {
    const content = document('Ready').replace('- Maintained service documentation', '- References:');
    const response = await handleDocsRoutes({ httpMethod: 'PUT', path: '/docs', headers: {}, queryStringParameters: { path: 'content/example.md' }, body: JSON.stringify({ content, expectedRevision: publication.revision }) }, 'actor');
    assert.equal(response?.statusCode, 200);
    assert.ok(JSON.parse(response!.body).warnings.some((warning: string) => warning.includes('content/example.md: governed document has empty References section')));
  } finally { resetDocsRuntime(); }
});
