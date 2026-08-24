import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { ContentsApiGithubStore, contentRootUnavailableMessage } from '../src/docs/githubStore';
import {
  handleDocsRoutes,
  configureDocsRuntime,
  resetDocsRuntime,
} from '../src/docs/contentApi';
import type { LambdaEvent } from '../src/types';

// ── In-memory GitHub backing the store via injected fetch ─────────────────────
interface RecordedCall {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

class FakeGitHub {
  blobs = new Map<string, string>();
  calls: RecordedCall[] = [];
  private shaCounter = 0;

  constructor(seed: Record<string, string> = {}) {
    for (const [p, c] of Object.entries(seed)) this.blobs.set(p, c);
  }

  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const method = (init?.method || 'GET').toUpperCase();
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null;
    this.calls.push({ method, path: u.pathname + (u.search || ''), body });

    if (method === 'GET' && u.pathname.includes('/git/trees/')) {
      const tree = [...this.blobs.entries()].map(([p, c]) => ({
        path: p,
        sha: `sha-${p}`,
        type: 'blob',
        size: Buffer.byteLength(c),
      }));
      return json(200, { tree });
    }
    if (method === 'GET' && u.pathname.includes('/git/blobs/')) {
      const sha = decodeURIComponent(u.pathname.split('/git/blobs/')[1]);
      const path = sha.replace(/^sha-/, '');
      const content = this.blobs.get(path);
      if (content === undefined) return json(404, { message: 'Not Found' });
      return json(200, { content: Buffer.from(content, 'utf-8').toString('base64') });
    }
    if (u.pathname.includes('/contents/')) {
      const repoPath = decodeURIComponent(u.pathname.split('/contents/')[1]);
      if (method === 'PUT') {
        this.blobs.set(repoPath, Buffer.from(String(body?.content || ''), 'base64').toString('utf-8'));
        return json(200, { content: { path: repoPath } });
      }
      if (method === 'DELETE') {
        this.blobs.delete(repoPath);
        return json(200, { commit: {} });
      }
    }
    return json(404, { message: `unhandled ${method} ${u.pathname}` });
  };

  commitCalls(): RecordedCall[] {
    return this.calls.filter((c) => c.method === 'PUT' || c.method === 'DELETE');
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const SOP = [
  '---',
  'title: Reset a password',
  'summary: How to reset a user password',
  'doc_type: sop',
  'schema_version: 1',
  'tags: [accounts, security]',
  '---',
  '',
  '# Reset a password',
  '',
  '<!-- sop-section-start: procedure -->',
  '## Procedure',
  '<!-- sop-step-start id=1 -->',
  '1. Open the admin console and reset the password.',
  '<!-- sop-step-end -->',
  '<!-- sop-section-end -->',
].join('\n');

const REF = [
  '---',
  'id: ref.newsletter',
  'title: Newsletter reference',
  'summary: Newsletter sponsorship reference',
  'doc_type: reference',
  '---',
  '',
  '# Newsletter reference',
  '',
  'Details about newsletter sponsorship and billing.',
].join('\n');

function ev(httpMethod: string, path: string, opts: { query?: Record<string, string>; body?: unknown } = {}): LambdaEvent {
  return {
    httpMethod,
    path,
    headers: {},
    queryStringParameters: opts.query || null,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : null,
  };
}

async function call(event: LambdaEvent): Promise<{ status: number; body: any }> {
  const res = await handleDocsRoutes(event);
  assert.ok(res, `handleDocsRoutes returned null for ${event.path}`);
  return { status: res!.statusCode, body: res!.body ? JSON.parse(res!.body) : null };
}

describe('contentApi - docs endpoints (GitHub mocked)', () => {
  let dir: string;
  let github: FakeGitHub;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'content-api-'));
    github = new FakeGitHub({
      'content/accounts/sops/reset-password.md': SOP,
      'content/overview/reference/newsletter.md': REF,
    });
    const store = new ContentsApiGithubStore({
      owner: 'DataTalksClub',
      repo: 'dataops',
      branch: 'main',
      token: 'test-token',
      cacheDir: dir,
      fetchImpl: github.fetch as unknown as typeof fetch,
    });
    configureDocsRuntime(store);
  });

  afterEach(() => {
    resetDocsRuntime();
    rmSync(dir, { recursive: true, force: true });
  });

  it('health returns ok', async () => {
    const { status, body } = await call(ev('GET', '/health'));
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, { ok: true });
  });

  it('lists docs from the registry', async () => {
    const { status, body } = await call(ev('GET', '/docs'));
    assert.strictEqual(status, 200);
    const paths = body.documents.map((d: any) => d.path).sort();
    assert.deepStrictEqual(paths, [
      'content/accounts/sops/reset-password.md',
      'content/overview/reference/newsletter.md',
    ]);
    const ref = body.documents.find((d: any) => d.id === 'ref.newsletter');
    assert.strictEqual(ref.stable_id, true);
    assert.ok('updated' in ref);
  });

  it('loads a doc with rendered content + parsed SOP structure', async () => {
    const { status, body } = await call(ev('GET', '/docs', { query: { path: 'content/accounts/sops/reset-password.md' } }));
    assert.strictEqual(status, 200);
    assert.strictEqual(body.path, 'content/accounts/sops/reset-password.md');
    assert.match(body.content, /Reset a password/);
    assert.ok(body.parsed, 'SOP parsed structure present');
    assert.ok([1, '1'].includes(body.parsed.schema_version), 'schema_version 1');
  });

  it('resolves a document reference by id', async () => {
    const { status, body } = await call(ev('GET', '/docs/resolve', { query: { ref: 'ref.newsletter' } }));
    assert.strictEqual(status, 200);
    assert.strictEqual(body.document.path, 'content/overview/reference/newsletter.md');
  });

  it('returns the document registry', async () => {
    const { status, body } = await call(ev('GET', '/docs/registry'));
    assert.strictEqual(status, 200);
    assert.strictEqual(body.documents.length, 2);
  });

  it('search returns docs results over the SearchIndex', async () => {
    const { status, body } = await call(ev('GET', '/search', { query: { q: 'reset password' } }));
    assert.strictEqual(status, 200);
    assert.strictEqual(body.query, 'reset password');
    assert.ok(body.results.length >= 1);
    assert.strictEqual(body.results[0].type, 'doc');
    assert.ok(body.results.some((r: any) => r.path === 'content/accounts/sops/reset-password.md'));
    assert.ok(body.sources.some((s: any) => s.source === 'docs' && s.status === 'ok'));
  });

  it('search requires q', async () => {
    const { status, body } = await call(ev('GET', '/search', { query: {} }));
    assert.strictEqual(status, 400);
    assert.match(body.error, /required query parameter: q/);
  });

  it('lint reports schema_version:1 SOP violations only', async () => {
    const { status, body } = await call(ev('GET', '/lint'));
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body.docs));
    assert.strictEqual(typeof body.total_violations, 'number');
    // the reference doc is not schema_version:1, so it must not appear
    assert.ok(!body.docs.some((d: any) => d.path.includes('newsletter')));
  });

  it('returns public-safe process quality and read-only Git availability diagnostics', async () => {
    const quality = await call(ev('GET', '/docs/process-quality'));
    assert.strictEqual(quality.status, 200);
    assert.ok(Array.isArray(quality.body.findings));
    assert.strictEqual(quality.body.summary.total, quality.body.findings.length);
    assert.ok(quality.body.findings.every((finding: any) => finding.source === 'local docs validation'));

    const status = await call(ev('GET', '/git/status'));
    assert.deepStrictEqual(
      { status: status.status, ok: status.body.ok, available: status.body.available, files: status.body.files },
      { status: 200, ok: false, available: false, files: [] },
    );
    const history = await call(ev('GET', '/git/log', { query: { path: 'content/accounts/sops/reset-password.md' } }));
    assert.deepStrictEqual(
      { status: history.status, available: history.body.available, commits: history.body.commits },
      { status: 200, available: false, commits: [] },
    );
    assert.strictEqual((await call(ev('POST', '/git/pull'))).status, 405);
  });

  it('parse returns structured SOP for valid content and error for invalid', async () => {
    const ok = await call(ev('POST', '/parse', { body: { content: SOP } }));
    assert.strictEqual(ok.status, 200);
    assert.ok(ok.body.parsed);
    const bad = await call(ev('POST', '/parse', { body: {} }));
    assert.strictEqual(bad.status, 400);
  });
});

describe('contentApi - mutations commit to GitHub + refresh search', () => {
  let dir: string;
  let github: FakeGitHub;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'content-api-mut-'));
    github = new FakeGitHub({
      'content/accounts/sops/reset-password.md': SOP,
    });
    const store = new ContentsApiGithubStore({
      owner: 'DataTalksClub',
      repo: 'dataops',
      branch: 'main',
      token: 'test-token',
      cacheDir: dir,
      fetchImpl: github.fetch as unknown as typeof fetch,
    });
    configureDocsRuntime(store);
  });

  afterEach(() => {
    resetDocsRuntime();
    rmSync(dir, { recursive: true, force: true });
  });

  it('save commits to GitHub, returns lint warnings, and search reflects the change', async () => {
    // Baseline search has no hit for the new term.
    const before = await call(ev('GET', '/search', { query: { q: 'mfa enrollment' } }));
    assert.ok(!before.body.results.some((r: any) => r.path.includes('reset-password')));

    const edited = SOP.replace('reset the password.', 'reset the password and trigger mfa enrollment.');
    const newContent = edited.includes('mfa enrollment')
      ? edited
      : SOP.replace('1. Open the admin console and reset the password.', '1. Open the admin console and reset the password and trigger mfa enrollment.');

    const save = await call(
      ev('PUT', '/docs', { query: { path: 'content/accounts/sops/reset-password.md' }, body: { content: newContent } }),
    );
    assert.strictEqual(save.status, 200);
    assert.ok(Array.isArray(save.body.warnings), 'lint warnings array present');

    // A PUT commit was issued with the new base64 content.
    const put = github.commitCalls().find((c) => c.method === 'PUT');
    assert.ok(put, 'a commit (PUT) was issued on save');
    assert.strictEqual(Buffer.from(String(put!.body!.content), 'base64').toString('utf-8'), newContent);

    // Search index refreshed in-process: new term now returns the doc.
    const after = await call(ev('GET', '/search', { query: { q: 'mfa enrollment' } }));
    assert.ok(
      after.body.results.some((r: any) => r.path === 'content/accounts/sops/reset-password.md'),
      'search reflects the saved change',
    );
  });

  it('creates a new doc with a scaffold and commits it', async () => {
    const res = await call(ev('POST', '/docs', { body: { path: 'content/accounts/sops/new-thing.md', title: 'New Thing' } }));
    assert.strictEqual(res.status, 201);
    assert.match(res.body.content, /schema_version: 1/);
    assert.ok(github.commitCalls().some((c) => c.method === 'PUT' && c.path.includes('new-thing.md')));
  });

  it('rejects creating an existing doc', async () => {
    const res = await call(ev('POST', '/docs', { body: { path: 'content/accounts/sops/reset-password.md' } }));
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /already exists/);
  });

  it('deletes a doc and commits the deletion', async () => {
    const res = await call(ev('DELETE', '/docs', { query: { path: 'content/accounts/sops/reset-password.md' } }));
    assert.strictEqual(res.status, 200);
    assert.ok(github.commitCalls().some((c) => c.method === 'DELETE'));
  });

  it('rejects a path that escapes the content root', async () => {
    const res = await call(ev('GET', '/docs', { query: { path: '../../etc/passwd' } }));
    assert.strictEqual(res.status, 400);
  });

  it('uploads an image and commits it', async () => {
    const data = Buffer.from('PNGDATA').toString('base64');
    const res = await call(
      ev('POST', '/images', {
        body: { doc_path: 'content/accounts/sops/reset-password.md', filename: 'Diagram.png', data },
      }),
    );
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.absolute_path, 'content/images/reset-password/diagram.png');
    assert.ok(github.commitCalls().some((c) => c.method === 'PUT' && c.path.includes('images')));
  });
});

// A collection listing must never answer "Document not found". Offline (local
// dev, e2e, `DTC_OFFLINE=1`) nothing hydrates the cache, so the content root is
// exactly as configured: populated, empty, or absent. Each state has its own
// honest answer (#190).
describe('contentApi - docs listing content-root contract (offline)', () => {
  const SCRATCH = resolve(__dirname, '..', '..', '.tmp', 'docs-content-api-tests');
  let scratch: string;
  let offlineBefore: string | undefined;

  const COLLECTION_ROUTES = ['/docs', '/docs/registry', '/docs/process-quality'];

  function runtimeFor(cacheDir: string): void {
    configureDocsRuntime(
      new ContentsApiGithubStore({
        owner: 'DataTalksClub',
        repo: 'dataops',
        branch: 'main',
        token: 'test-token',
        cacheDir,
        fetchImpl: (async () => {
          throw new Error('offline docs runtime must not call GitHub');
        }) as unknown as typeof fetch,
      }),
    );
  }

  function populatedRoot(name: string): string {
    const cacheDir = join(scratch, name);
    const file = join(cacheDir, 'content', 'accounts', 'sops', 'reset-password.md');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, SOP);
    return cacheDir;
  }

  beforeEach(() => {
    mkdirSync(SCRATCH, { recursive: true });
    scratch = mkdtempSync(join(SCRATCH, 'root-'));
    offlineBefore = process.env.DTC_OFFLINE;
    process.env.DTC_OFFLINE = '1';
  });

  afterEach(() => {
    resetDocsRuntime();
    if (offlineBefore === undefined) delete process.env.DTC_OFFLINE;
    else process.env.DTC_OFFLINE = offlineBefore;
    rmSync(scratch, { recursive: true, force: true });
  });

  it('lists the documents under a populated content root', async () => {
    runtimeFor(populatedRoot('populated'));
    const { status, body } = await call(ev('GET', '/docs'));
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(
      body.documents.map((doc: any) => doc.path),
      ['content/accounts/sops/reset-password.md'],
    );
  });

  it('returns an empty list for a present but empty content root', async () => {
    const cacheDir = join(scratch, 'empty');
    mkdirSync(join(cacheDir, 'content'), { recursive: true });
    runtimeFor(cacheDir);

    const { status, body } = await call(ev('GET', '/docs'));
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, { documents: [] });
  });

  it('fails loudly and names the path when the content root is missing', async () => {
    const cacheDir = join(scratch, 'missing');
    const contentRoot = join(cacheDir, 'content');
    runtimeFor(cacheDir);

    for (const path of COLLECTION_ROUTES) {
      const { status, body } = await call(ev('GET', path));
      assert.ok(status >= 500 && status < 600, `${path}: expected a 5xx, got ${status}`);
      assert.notStrictEqual(status, 404, `${path}: a missing content root is not a missing document`);
      assert.ok(
        String(body.error).includes(contentRoot),
        `${path}: error must name the configured content root, got ${body.error}`,
      );
    }
    assert.strictEqual(existsSync(contentRoot), false, 'the content root must not be created as a side effect');
  });

  it('still returns 404 for a missing document under a populated content root', async () => {
    runtimeFor(populatedRoot('populated-404'));
    const { status, body } = await call(ev('GET', '/docs', { query: { path: 'does-not-exist.md' } }));
    assert.strictEqual(status, 404);
    assert.strictEqual(body.error, 'Document not found');
  });
});

// A single-file read has a different prerequisite from a stateless parse or
// health check, but shares the corpus precondition with collection reads. These
// cases keep the outage distinct from a genuinely absent document (#191).
describe('contentApi - single-document content-root contract', () => {
  const SCRATCH = resolve(__dirname, '..', '..', '.tmp', 'docs-content-api-single-doc-tests');
  let scratch: string;
  let offlineBefore: string | undefined;

  function githubStore(cacheDir: string): { store: ContentsApiGithubStore; github: FakeGitHub } {
    const github = new FakeGitHub({
      'content/one.md': '# One',
      'content/two.md': '# Two',
      'content/images/one/picture.png': 'PNGDATA',
    });
    return {
      github,
      store: new ContentsApiGithubStore({
        owner: 'DataTalksClub',
        repo: 'dataops',
        branch: 'main',
        token: 'test-token',
        cacheDir,
        fetchImpl: github.fetch as unknown as typeof fetch,
      }),
    };
  }

  function unavailableRuntime(cacheDir: string): FakeGitHub {
    const { github, store } = githubStore(cacheDir);
    configureDocsRuntime(store);
    return github;
  }

  beforeEach(() => {
    mkdirSync(SCRATCH, { recursive: true });
    scratch = mkdtempSync(join(SCRATCH, 'single-doc-'));
    offlineBefore = process.env.DTC_OFFLINE;
    process.env.DTC_OFFLINE = '1';
  });

  afterEach(() => {
    resetDocsRuntime();
    if (offlineBefore === undefined) delete process.env.DTC_OFFLINE;
    else process.env.DTC_OFFLINE = offlineBefore;
    rmSync(scratch, { recursive: true, force: true });
  });

  it('returns the named corpus outage instead of a missing-document 404', async () => {
    const cacheDir = join(scratch, 'missing-root');
    const contentRoot = join(cacheDir, 'content');
    const github = unavailableRuntime(cacheDir);

    const { status, body } = await call(ev('GET', '/docs', { query: { path: 'content/example.md' } }));

    assert.strictEqual(status, 503);
    assert.deepStrictEqual(body, { error: contentRootUnavailableMessage(contentRoot) });
    assert.strictEqual(github.calls.length, 0);
    assert.strictEqual(existsSync(contentRoot), false);
  });

  it('validates a document path before evaluating content-root availability', async () => {
    const cacheDir = join(scratch, 'validation-first');
    const contentRoot = join(cacheDir, 'content');
    const github = unavailableRuntime(cacheDir);

    const { status, body } = await call(
      ev('GET', '/docs', { query: { path: '../../etc/passwd' } }),
    );

    assert.strictEqual(status, 400);
    assert.match(body.error, /Document path may only contain/);
    assert.strictEqual(github.calls.length, 0);
    assert.strictEqual(existsSync(contentRoot), false);
  });

  it('keeps populated-root and empty-root misses at document 404', async () => {
    const populatedCache = join(scratch, 'populated');
    mkdirSync(dirname(join(populatedCache, 'content', 'present.md')), { recursive: true });
    writeFileSync(join(populatedCache, 'content', 'present.md'), '# Present');
    unavailableRuntime(populatedCache);

    const populated = await call(ev('GET', '/docs', { query: { path: 'does-not-exist.md' } }));
    assert.deepStrictEqual(populated, { status: 404, body: { error: 'Document not found' } });

    const emptyCache = join(scratch, 'empty');
    mkdirSync(join(emptyCache, 'content'), { recursive: true });
    unavailableRuntime(emptyCache);
    const empty = await call(ev('GET', '/docs', { query: { path: 'does-not-exist.md' } }));
    assert.deepStrictEqual(empty, { status: 404, body: { error: 'Document not found' } });
  });

  it('hydrates one requested blob online and leaves unrelated files alone', async () => {
    delete process.env.DTC_OFFLINE;
    const cacheDir = join(scratch, 'online-lazy');
    const { github, store } = githubStore(cacheDir);
    configureDocsRuntime(store);

    const { status, body } = await call(ev('GET', '/docs', { query: { path: 'content/one.md' } }));

    assert.strictEqual(status, 200);
    assert.strictEqual(body.path, 'content/one.md');
    assert.strictEqual(body.content, '# One');
    assert.strictEqual(github.calls.filter((entry) => entry.path.includes('/git/trees/')).length, 1);
    assert.strictEqual(github.calls.filter((entry) => entry.path.includes('/git/blobs/sha-content/one.md')).length, 1);
    assert.ok(existsSync(store.localPath('content/one.md')));
    assert.strictEqual(existsSync(store.localPath('content/two.md')), false);
    assert.strictEqual(existsSync(store.localPath('content/images/one/picture.png')), false);
  });

  it('returns document 404 online without creating an absent cache root', async () => {
    delete process.env.DTC_OFFLINE;
    const cacheDir = join(scratch, 'online-missing-path');
    const { github, store } = githubStore(cacheDir);
    configureDocsRuntime(store);

    const { status, body } = await call(ev('GET', '/docs', { query: { path: 'content/absent.md' } }));

    assert.strictEqual(status, 404);
    assert.deepStrictEqual(body, { error: 'Document not found' });
    assert.strictEqual(github.calls.filter((entry) => entry.path.includes('/git/trees/')).length, 1);
    assert.strictEqual(github.calls.filter((entry) => entry.path.includes('/git/blobs/')).length, 0);
    assert.strictEqual(existsSync(store.root), false);
    assert.strictEqual(existsSync(store.contentRoot), false);
  });

  it('reports image uploads against an unavailable corpus before filesystem or GitHub mutations', async () => {
    const cacheDir = join(scratch, 'image-upload-outage');
    const contentRoot = join(cacheDir, 'content');
    unavailableRuntime(cacheDir);

    const { status, body } = await call(
      ev('POST', '/images', {
        body: {
          doc_path: 'content/example.md',
          filename: 'Diagram.PNG',
          data: Buffer.from('PNGDATA').toString('base64'),
        },
      }),
    );

    assert.strictEqual(status, 503);
    assert.deepStrictEqual(body, { error: contentRootUnavailableMessage(contentRoot) });
    assert.strictEqual(existsSync(cacheDir), false);
  });
});
