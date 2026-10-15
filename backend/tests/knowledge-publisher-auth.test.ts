import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { handler } from '../src/handler';
import { configureDocsRuntime, handleDocsRoutes, resetDocsRuntime } from '../src/docs/contentApi';
import { resetKnowledgePublisherCaches } from '../src/auth/knowledgePublisher';
import { syntheticKnowledge } from './helpers/knowledge';
import { useTestDatabase } from './helpers/db';

const REPO = 'ExampleOrg/knowledge';
const SHA = 'a'.repeat(40);
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const { privateKey: strangerKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'gh-key', alg: 'RS256', use: 'sig' };

const config = {
  DATAOPS_DOCS_DOMAIN: '1', WORK_ENGINE_AUTH_MODE: 'portal', SKIP_AUTH: 'false',
  AUTH_BASE_URL: 'https://auth.example.test', AUTH_ISSUER: 'https://issuer.example.test/pool',
  AUTH_CLIENT_ID: 'synthetic', AUTH_CALLBACK_URL: 'https://ops.example.test/auth/callback',
  KNOWLEDGE_PUBLISHER_REPOSITORY: REPO, KNOWLEDGE_PUBLISHER_BRANCH: 'main',
};
const saved = Object.fromEntries(Object.keys(config).map((key) => [key, process.env[key]]));
const realFetch = globalThis.fetch;

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: 'https://token.actions.githubusercontent.com', aud: 'dataops-knowledge-publish',
    iat: now, nbf: now, exp: now + 300, repository: REPO, ref: 'refs/heads/main', sha: SHA,
    workflow_ref: `${REPO}/.github/workflows/validate.yml@refs/heads/main`, event_name: 'push',
    ...overrides,
  };
}
function token(body = claims(), key = privateKey, kid = 'gh-key'): string {
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(body)).toString('base64url');
  return `${head}.${payload}.${sign('RSA-SHA256', Buffer.from(`${head}.${payload}`), key).toString('base64url')}`;
}
const request = (method: string, path: string, credential: string, body: unknown = {}) => handler({
  httpMethod: method, path, headers: { Authorization: `Bearer ${credential}`, 'x-user-id': 'spoofed-admin' },
  body: JSON.stringify(body),
}, {});

describe('GitHub Actions OIDC knowledge publisher', () => {
  let dir: string;
  let revision: string;
  before(async () => {
    Object.assign(process.env, config);
    await useTestDatabase();
    globalThis.fetch = (async (url: string | URL) => {
      assert.equal(String(url), 'https://token.actions.githubusercontent.com/.well-known/jwks');
      return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
    }) as typeof fetch;
  });
  after(() => {
    globalThis.fetch = realFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  beforeEach(() => {
    mkdirSync(resolve('../.tmp'), { recursive: true });
    dir = mkdtempSync(resolve('../.tmp/publisher-'));
    const fixture = syntheticKnowledge({ 'content/a.md': 'old' }, dir);
    configureDocsRuntime(fixture.store);
    revision = fixture.publication.revision;
    resetKnowledgePublisherCaches();
  });
  afterEach(() => { resetDocsRuntime(); rmSync(dir, { recursive: true, force: true }); });

  it('reads the manifest and publishes as the verified commit, ignoring body attribution', async () => {
    const manifest = await request('GET', '/knowledge/manifest', token());
    assert.equal(manifest.statusCode, 200);
    assert.equal(JSON.parse(manifest.body).revision, revision);
    const published = await request('POST', '/knowledge/publish', token(), {
      expectedRevision: revision, message: 'forged', actor: 'forged',
      mutations: [{ path: 'content/a.md', base64: Buffer.from('new').toString('base64') }],
    });
    assert.equal(published.statusCode, 200);
    const history = await handleDocsRoutes({ httpMethod: 'GET', path: '/knowledge/history', headers: {}, queryStringParameters: { path: 'content/a.md' }, body: null }, 'reader');
    const version = JSON.parse(history!.body).versions[0];
    assert.equal(version.actor, `git:knowledge@${SHA.slice(0, 12)}`);
    assert.equal(version.message, `Publish knowledge ${SHA}`);
    const stale = await request('POST', '/knowledge/publish', token(), {
      expectedRevision: revision, mutations: [{ path: 'content/a.md', content: 'stale' }],
    });
    assert.equal(stale.statusCode, 409);
  });

  it('may not reach any other route', async () => {
    for (const [method, path] of [['GET', '/knowledge/history'], ['GET', '/docs'], ['PUT', '/docs'], ['POST', '/knowledge/restore'],
      ['GET', '/api/me'], ['GET', '/api/tasks'], ['POST', '/api/tasks'], ['GET', '/knowledge/publication'], ['GET', '/content/a.md']]) {
      assert.equal((await request(method, path, token())).statusCode, 403, `${method} ${path}`);
    }
  });

  it('refuses tokens from another repository, branch, workflow, event, audience, key or time', async () => {
    const refused = [
      token(claims({ repository: 'ExampleOrg/other' })),
      token(claims({ ref: 'refs/heads/feature' })),
      token(claims({ workflow_ref: `${REPO}/.github/workflows/other.yml@refs/heads/main` })),
      token(claims({ workflow_ref: `${REPO}/.github/workflows/validate.yml@refs/heads/feature` })),
      token(claims({ event_name: 'pull_request' })),
      token(claims({ aud: 'sts.amazonaws.com' })),
      token(claims({ exp: Math.floor(Date.now() / 1000) - 600 })),
      token(claims({ nbf: Math.floor(Date.now() / 1000) + 600 })),
      token(claims({ sha: 'not-a-sha' })),
      token(claims(), strangerKey),
      token(claims(), privateKey, 'unknown-kid'),
      `${token().split('.').slice(0, 2).join('.')}.${Buffer.from('bad').toString('base64url')}`,
    ];
    for (const credential of refused) {
      assert.equal((await request('GET', '/knowledge/manifest', credential)).statusCode, 401);
    }
  });

  it('is disabled when the deployment names no repository', async () => {
    delete process.env.KNOWLEDGE_PUBLISHER_REPOSITORY;
    try {
      assert.equal((await request('GET', '/knowledge/manifest', token())).statusCode, 401);
    } finally {
      process.env.KNOWLEDGE_PUBLISHER_REPOSITORY = REPO;
    }
  });

  it('is configured from the deployed knowledge repository parameters', () => {
    const template = readFileSync(new URL('../../infra/template.full.yaml', import.meta.url), 'utf8');
    assert.match(template, /KNOWLEDGE_PUBLISHER_REPOSITORY: !Sub \$\{GitHubOwner\}\/\$\{GitHubRepo\}/);
    assert.match(template, /KNOWLEDGE_PUBLISHER_BRANCH: !Ref GitHubBranch/);
  });
});
