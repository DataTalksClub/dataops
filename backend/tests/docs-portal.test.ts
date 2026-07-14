import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { route } from '../src/router';
import { ContentsApiGithubStore } from '../src/docs/githubStore';
import { configureDocsRuntime, resetDocsRuntime } from '../src/docs/contentApi';
import { configurePortalStore } from '../src/docs/portal';
import { startLocal, stopLocal, getClient } from '../src/db/client';
import { createTables } from '../src/db/setup';
import { createBrowserSession } from '../src/db/sessions';
import { createUserWithId } from '../src/db/users';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
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

function ev(httpMethod: string, path: string, opts: { headers?: Record<string, string>; query?: Record<string, string>; body?: string } = {}): LambdaEvent {
  return { httpMethod, path, headers: opts.headers || {}, queryStringParameters: opts.query || null, body: opts.body || null };
}

describe('portal - single-origin auth + frontend + docs wiring', () => {
  let feRoot: string;
  let cacheDir: string;
  let client: DynamoDBDocumentClient;
  let browserCookie: string;
  const saved: Record<string, string | undefined> = {};

  before(async () => {
    feRoot = mkdtempSync(join(tmpdir(), 'portal-fe-'));
    mkdirSync(join(feRoot, 'src'), { recursive: true });
    writeFileSync(join(feRoot, 'index.html'), '<!doctype html><html><body><h1>DataOps Portal</h1><span id="app-version"></span></body></html>');
    writeFileSync(join(feRoot, 'src', 'app.js'), 'console.log("portal app");');

    for (const k of ['DATAOPS_DOCS_DOMAIN', 'FRONTEND_ROOT', 'AUTH_BASE_URL', 'AUTH_ISSUER', 'AUTH_JWKS_URL', 'AUTH_CLIENT_ID', 'AUTH_CALLBACK_URL', 'AUTH_LOGOUT_URL']) saved[k] = process.env[k];
    process.env.DATAOPS_DOCS_DOMAIN = 'true';
    process.env.FRONTEND_ROOT = feRoot;
    process.env.AUTH_BASE_URL = 'https://auth.example.test';
    process.env.AUTH_ISSUER = 'https://issuer.example.test/pool';
    process.env.AUTH_JWKS_URL = 'https://issuer.example.test/pool/.well-known/jwks.json';
    process.env.AUTH_CLIENT_ID = 'docs-client';
    process.env.AUTH_CALLBACK_URL = 'https://ops.example.test/auth/callback';
    process.env.AUTH_LOGOUT_URL = 'https://ops.example.test/';
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
    await createUserWithId(client, 'docs-operator', { name: 'Docs operator', email: 'docs@datatalks.club', role: 'operator' });
    const session = await createBrowserSession(client, 'docs-operator', { lifetimeSeconds: 3600 });
    browserCookie = `dataops_session=${session.token}`;
  });

  after(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(feRoot, { recursive: true, force: true });
    await stopLocal();
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
    const res = await route(ev('GET', '/'), client);
    assert.strictEqual(res.statusCode, 302);
    assert.strictEqual(res.headers?.location, '/login');
  });

  it('returns JSON 401 for unauthenticated API/data requests without a Basic challenge', async () => {
    const res = await route(ev('GET', '/api/tasks'), client);
    assert.strictEqual(res.statusCode, 401);
    assert.deepStrictEqual(JSON.parse(res.body), { error: 'Unauthorized' });
    assert.strictEqual(res.headers?.['www-authenticate'], undefined);
  });

  it('redirects /login to the shared authorize endpoint', async () => {
    const res = await route(ev('GET', '/login'), client);
    assert.strictEqual(res.statusCode, 302);
    assert.strictEqual(new URL(res.headers!.location).origin, 'https://auth.example.test');
    assert.match(res.headers?.['set-cookie'] || '', /dataops_oauth_tx=/);
  });

  it('serves the branded auth error only at a clean no-store route', async () => {
    const res = await route(ev('GET', '/auth/error'), client);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.headers?.['cache-control'], 'no-store');
    assert.strictEqual(res.headers?.['referrer-policy'], 'no-referrer');
    assert.match(res.body, /DataOps/);
    assert.match(res.body, /We couldn’t sign you in/);
    assert.match(res.body, /Try signing in again/);
    assert.doesNotMatch(res.body, /code=|state=|token|verifier|access_denied/i);
  });

  it('does not serve the historical password login', async () => {
    const res = await route(ev('POST', '/login'), client);
    assert.strictEqual(res.statusCode, 302);
    assert.strictEqual(res.headers?.location, '/login');
  });

  it('serves the static frontend with a valid opaque browser session', async () => {
    const res = await route(ev('GET', '/', { headers: { cookie: browserCookie } }), client);
    assert.strictEqual(res.statusCode, 200);
    assert.match(res.body, /DataOps Portal/);
    const js = await route(ev('GET', '/src/app.js', { headers: { cookie: browserCookie } }), client);
    assert.strictEqual(js.statusCode, 200);
    assert.match(js.body, /portal app/);
  });

  it('serves a docs API route through the single origin', async () => {
    const res = await route(ev('GET', '/docs/registry', { headers: { cookie: browserCookie } }), client);
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.documents.some((d: any) => d.id === 'ref.guide'));
  });

  it('serves /content/* from the GitHub store cache', async () => {
    const res = await route(ev('GET', '/content/a/reference/guide.md', { headers: { cookie: browserCookie } }), client);
    assert.strictEqual(res.statusCode, 200);
    assert.match(res.body, /# Guide/);
  });

  it('rewrites the old /work/api proxy path to /api in-process', async () => {
    // /work/health -> /api/health (work route), authorized via browser session.
    const res = await route(ev('GET', '/work/health', { headers: { cookie: browserCookie } }), client);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(res.body), { status: 'ok' });
  });

  it('renders the SPA shell for an extensionless app route', async () => {
    const res = await route(ev('GET', '/work', { headers: { cookie: browserCookie } }), client);
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
      const res = await route(ev('GET', '/api/health'), {} as never);
      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(JSON.parse(res.body), { status: 'ok' });
    } finally {
      if (prev === undefined) delete process.env.DATAOPS_DOCS_DOMAIN;
      else process.env.DATAOPS_DOCS_DOMAIN = prev;
    }
  });
});
