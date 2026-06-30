import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ContentsApiGithubStore } from '../src/docs/githubStore';
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
