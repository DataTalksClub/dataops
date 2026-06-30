import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { route } from '../src/router';
import { ContentsApiGithubStore } from '../src/docs/githubStore';
import { configureDocsRuntime, resetDocsRuntime } from '../src/docs/contentApi';
import { configurePortalStore } from '../src/docs/portal';
import type { LambdaEvent } from '../src/types';

// Minimal in-memory GitHub for the docs store.
class FakeGitHub {
  blobs = new Map<string, string>();
  constructor(seed: Record<string, string> = {}) {
    for (const [p, c] of Object.entries(seed)) this.blobs.set(p, c);
  }
  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const method = (init?.method || 'GET').toUpperCase();
    if (method === 'GET' && u.pathname.includes('/git/trees/')) {
      const tree = [...this.blobs.entries()].map(([p, c]) => ({ path: p, sha: `sha-${p}`, type: 'blob', size: Buffer.byteLength(c) }));
      return json(200, { tree });
    }
    if (method === 'GET' && u.pathname.includes('/git/blobs/')) {
      const path = decodeURIComponent(u.pathname.split('/git/blobs/')[1]).replace(/^sha-/, '');
      const content = this.blobs.get(path);
      if (content === undefined) return json(404, {});
      return json(200, { content: Buffer.from(content, 'utf-8').toString('base64') });
    }
    return json(404, {});
  };
}
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const PASSWORD = 'sekret';
const BASIC = 'Basic ' + Buffer.from(`admin:${PASSWORD}`).toString('base64');
const fakeClient = {} as never;

function ev(httpMethod: string, path: string, opts: { headers?: Record<string, string>; query?: Record<string, string>; body?: string } = {}): LambdaEvent {
  return { httpMethod, path, headers: opts.headers || {}, queryStringParameters: opts.query || null, body: opts.body || null };
}

describe('portal - single-origin auth + frontend + docs wiring', () => {
  let feRoot: string;
  let cacheDir: string;
  const saved: Record<string, string | undefined> = {};

  before(() => {
    feRoot = mkdtempSync(join(tmpdir(), 'portal-fe-'));
    mkdirSync(join(feRoot, 'src'), { recursive: true });
    writeFileSync(join(feRoot, 'index.html'), '<!doctype html><html><body><h1>DataOps Portal</h1><span id="app-version"></span></body></html>');
    writeFileSync(join(feRoot, 'src', 'app.js'), 'console.log("portal app");');

    for (const k of ['DATAOPS_DOCS_DOMAIN', 'FRONTEND_ROOT', 'BASIC_AUTH_PASSWORD', 'BASIC_AUTH_USERNAME']) saved[k] = process.env[k];
    process.env.DATAOPS_DOCS_DOMAIN = 'true';
    process.env.FRONTEND_ROOT = feRoot;
    process.env.BASIC_AUTH_PASSWORD = PASSWORD;
    process.env.BASIC_AUTH_USERNAME = 'admin';
  });

  after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(feRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'portal-cache-'));
    const store = new ContentsApiGithubStore({
      owner: 'o',
      repo: 'r',
      branch: 'main',
      token: 't',
      cacheDir,
      fetchImpl: new FakeGitHub({
        'content/a/reference/guide.md': '---\nid: ref.guide\ntitle: Guide\ndoc_type: reference\n---\n\n# Guide\nbody',
      }).fetch as unknown as typeof fetch,
    });
    configureDocsRuntime(store);
    configurePortalStore(store);
  });

  afterEach(() => {
    resetDocsRuntime();
    configurePortalStore(null);
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('redirects unauthenticated browser navigation to /login', async () => {
    const res = await route(ev('GET', '/'), fakeClient);
    assert.strictEqual(res.statusCode, 302);
    assert.strictEqual(res.headers?.location, '/login');
  });

  it('challenges unauthenticated API/data requests with 401 Basic', async () => {
    const res = await route(ev('GET', '/api/tasks'), fakeClient);
    assert.strictEqual(res.statusCode, 401);
    assert.match(res.headers?.['www-authenticate'] || '', /Basic/);
  });

  it('serves the login page', async () => {
    const res = await route(ev('GET', '/login'), fakeClient);
    assert.strictEqual(res.statusCode, 200);
    assert.match(res.body, /DataOps/);
    assert.match(res.body, /Sign in/);
  });

  it('issues a session cookie on correct login', async () => {
    const res = await route(
      ev('POST', '/login', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: PASSWORD }) }),
      fakeClient,
    );
    assert.strictEqual(res.statusCode, 302);
    assert.match(res.headers?.['set-cookie'] || '', /dtc_auth=/);
  });

  it('serves the static frontend with valid Basic auth', async () => {
    const res = await route(ev('GET', '/', { headers: { authorization: BASIC } }), fakeClient);
    assert.strictEqual(res.statusCode, 200);
    assert.match(res.body, /DataOps Portal/);
    const js = await route(ev('GET', '/src/app.js', { headers: { authorization: BASIC } }), fakeClient);
    assert.strictEqual(js.statusCode, 200);
    assert.match(js.body, /portal app/);
  });

  it('serves a docs API route through the single origin', async () => {
    const res = await route(ev('GET', '/docs/registry', { headers: { authorization: BASIC } }), fakeClient);
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.documents.some((d: any) => d.id === 'ref.guide'));
  });

  it('serves /content/* from the GitHub store cache', async () => {
    const res = await route(ev('GET', '/content/a/reference/guide.md', { headers: { authorization: BASIC } }), fakeClient);
    assert.strictEqual(res.statusCode, 200);
    assert.match(res.body, /# Guide/);
  });

  it('rewrites the old /work/api proxy path to /api in-process', async () => {
    // /work/health -> /api/health (work route), authorized via Basic auth.
    const res = await route(ev('GET', '/work/health', { headers: { authorization: BASIC } }), fakeClient);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(res.body), { status: 'ok' });
  });

  it('renders the SPA shell for an extensionless app route', async () => {
    const res = await route(ev('GET', '/work', { headers: { authorization: BASIC } }), fakeClient);
    assert.strictEqual(res.statusCode, 200);
    assert.match(res.body, /DataOps Portal/);
  });
});

describe('portal - disabled flag leaves work routes untouched', () => {
  it('does not intercept when DATAOPS_DOCS_DOMAIN is off', async () => {
    const prev = process.env.DATAOPS_DOCS_DOMAIN;
    delete process.env.DATAOPS_DOCS_DOMAIN;
    try {
      // /api/health is auth-exempt and handled by the normal work router.
      const res = await route(ev('GET', '/api/health'), fakeClient);
      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(JSON.parse(res.body), { status: 'ok' });
    } finally {
      if (prev === undefined) delete process.env.DATAOPS_DOCS_DOMAIN;
      else process.env.DATAOPS_DOCS_DOMAIN = prev;
    }
  });
});
