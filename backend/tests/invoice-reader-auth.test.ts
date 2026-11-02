import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, sign as signBytes } from 'crypto';
import { readFileSync } from 'fs';
import { handler } from '../src/handler';
import { resetSharedIssuerCaches } from '../src/auth/sharedIssuer';
import { useTestDatabase } from './helpers/db';

// ── Shared-issuer rig ────────────────────────────────────────────────────────

const KID = 'service-test-key';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };

let issuer = '';
let jwksServer: ReturnType<typeof createServer>;

const nowSeconds = () => Math.floor(Date.now() / 1000);

function serviceToken(clientId: string, scopes: string[], overrides: Record<string, unknown> = {}): string {
  const t = nowSeconds();
  const claims = {
    iss: issuer,
    aud: 'https://ops.dtcdev.click',
    sub: `service:${clientId}`,
    client_id: clientId,
    scope: scopes.join(' '),
    email: null,
    email_verified: false,
    token_use: 'access',
    grant_type: 'client_credentials',
    iat: t, nbf: t, exp: t + 900, jti: `jti-${clientId}`,
    ...overrides,
  };
  const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const head = enc({ alg: 'RS256', kid: KID, typ: 'JWT' });
  const body = enc(claims);
  const signature = signBytes('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url');
  return `${head}.${body}.${signature}`;
}

const invoiceReader = () => serviceToken('dataops-invoice-reader', ['invoice:read']);
const automationService = () => serviceToken('dataops-automation-service', ['dataops:read', 'dataops:write']);
const humanToken = (email: string, overrides: Record<string, unknown> = {}) => {
  const t = nowSeconds();
  const claims = {
    iss: issuer, aud: 'https://ops.dtcdev.click', sub: 'human-1',
    email, email_verified: true, scope: 'openid mcp admin', client_id: 'dtc-cli',
    token_use: 'access', iat: t, nbf: t, exp: t + 3600, jti: 'jti-human',
    ...overrides,
  };
  const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const head = enc({ alg: 'RS256', kid: KID, typ: 'JWT' });
  const body = enc(claims);
  const signature = signBytes('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url');
  return `${head}.${body}.${signature}`;
};

// ── Portal harness ───────────────────────────────────────────────────────────

const config = {
  DATAOPS_DOCS_DOMAIN: '1', WORK_ENGINE_AUTH_MODE: 'portal', SKIP_AUTH: 'false',
  AUTH_BASE_URL: 'https://auth.example.test', AUTH_ISSUER: 'https://issuer.example.test/pool',
  AUTH_CLIENT_ID: 'synthetic', AUTH_CALLBACK_URL: 'https://ops.example.test/auth/callback',
};
const saved = Object.fromEntries(Object.keys(config).map((key) => [key, process.env[key]]));
const request = (method: string, path: string, credential?: string) => {
  const [cleanPath, query] = path.split('?');
  const queryStringParameters = query ? Object.fromEntries(new URLSearchParams(query).entries()) : null;
  const headers: Record<string, string> = { 'x-user-id': 'spoofed-admin' };
  if (credential) headers.Authorization = `Bearer ${credential}`;
  return handler({
    httpMethod: method, path: cleanPath, queryStringParameters, headers, body: '{}',
  }, {});
};

describe('shared-issuer service credentials on the configured portal', () => {
  before(async () => {
    jwksServer = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
    issuer = `http://127.0.0.1:${jwksServer.address().port}`;
    Object.assign(process.env, config, {
      OAUTH_ISSUER_URL: issuer,
      OAUTH_JWKS_URL: `${issuer}/.well-known/jwks.json`,
    });
    resetSharedIssuerCaches();
    await useTestDatabase();
  });
  after(async () => {
    resetSharedIssuerCaches();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    delete process.env.OAUTH_ISSUER_URL;
    delete process.env.OAUTH_JWKS_URL;
    await new Promise((resolve) => jwksServer.close(resolve));
  });

  it('reads invoices under invoice:read without issuing a user session', async () => {
    const identity = await request('GET', '/api/me', invoiceReader());
    assert.equal(identity.statusCode, 200);
    assert.deepEqual(JSON.parse(identity.body), { service: { id: 'dataops-invoice-reader', scopes: ['invoice:read'] } });
    const list = await request('GET', '/api/bookkeeping/invoices', invoiceReader());
    assert.equal(list.statusCode, 200);
    assert.deepEqual(JSON.parse(list.body), { items: [] });
    assert.equal((await request('GET', `/api/bookkeeping/invoices/${'b'.repeat(64)}`, invoiceReader())).statusCode, 404);
    assert.equal((await request('GET', `/api/bookkeeping/invoices/${'b'.repeat(64)}/document`, invoiceReader())).statusCode, 404);

    // Finance aggregates ride the same invoice scope; the month is validated.
    const finance = await request('GET', '/api/finance/summary?month=2026-10', invoiceReader());
    assert.equal(finance.statusCode, 200);
    assert.equal(JSON.parse(finance.body).totals.net, 0);
    assert.equal((await request('GET', '/api/finance/summary?month=2026-13', invoiceReader())).statusCode, 400);
    for (const method of ['POST', 'PUT', 'DELETE']) {
      assert.equal((await request(method, '/api/finance/summary', invoiceReader())).statusCode, 403);
    }
  });

  it('serves CRM, tasks and offers to the automation service under dataops scopes', async () => {
    const read = await request('GET', '/api/sponsor-crm/directory/companies', automationService());
    assert.equal(read.statusCode, 200);
    assert.equal((await request('GET', '/api/tasks?status=todo', automationService())).statusCode, 200);
    assert.equal((await request('GET', '/api/offers', automationService())).statusCode, 200);
    // Writes are allowed by dataops:write but still only inside the families.
    const write = await request('POST', '/api/tasks', automationService());
    assert.ok([200, 400, 404, 409].includes(write.statusCode), `POST /api/tasks -> ${write.statusCode}`);
    // The spoofed identity header never wins: the service actor is resolved server-side.
    assert.notEqual(JSON.parse(read.body), { error: 'Unauthorized' });
  });

  it('keeps every family scoped: invoice reads never open CRM or tasks', async () => {
    for (const path of ['/api/sponsor-crm/directory/companies', '/api/tasks', '/api/offers']) {
      assert.equal((await request('GET', path, invoiceReader())).statusCode, 403);
    }
    for (const path of ['/api/users', '/api/tokens', '/api/templates', '/api/bookkeeping', '/api/bookkeeping/invoices/process', `/api/bookkeeping/invoices/${'b'.repeat(64)}/verify`]) {
      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
        assert.equal((await request(method, path, automationService())).statusCode, 403);
      }
      assert.equal((await request('GET', path, automationService())).statusCode, 403);
    }
  });

  it('fails closed on garbage, expired, mis-issued or audience-mismatched tokens', async () => {
    for (const credential of ['garbage', 'not.a.jwt', serviceToken('dataops-invoice-reader', ['invoice:read'], { exp: nowSeconds() - 10 }), serviceToken('dataops-invoice-reader', ['invoice:read'], { iss: 'https://evil.example' }), serviceToken('dataops-invoice-reader', ['invoice:read'], { aud: 'https://hub.dtcdev.click/mcp' }), serviceToken('unknown-service-client', ['invoice:read'])]) {
      assert.equal((await request('GET', '/api/bookkeeping/invoices', credential)).statusCode, 401);
    }
  });

  it('maps human JWTs by verified email and refuses unknown or unverified ones', async () => {
    const unknown = await request('GET', '/api/me', humanToken('stranger@example.test'));
    assert.equal(unknown.statusCode, 401);
    const unverified = await request('GET', '/api/me', humanToken('owner@dtcdev.click', { email_verified: false }));
    assert.equal(unverified.statusCode, 401);
  });

  it('deploys the issuer URL parameter instead of a static service digest', () => {
    const template = readFileSync(new URL('../../infra/template.full.yaml', import.meta.url), 'utf8');
    const workflow = readFileSync(new URL('../../.github/workflows/deploy-dataops-v1.yml', import.meta.url), 'utf8');
    assert.match(template, /OauthIssuerUrl:\s*\n\s*Type: String\s*\n\s*Default: https:\/\/oauth\.dtcdev\.click/);
    assert.match(template, /OAUTH_ISSUER_URL: !Ref OauthIssuerUrl/);
    assert.match(workflow, /OAUTH_ISSUER_URL: https:\/\/oauth\.dtcdev\.click/);
    assert.match(workflow, /ParameterKey=OauthIssuerUrl,ParameterValue=\$OAUTH_ISSUER_URL/);
    assert.ok(!template.includes('InvoiceReaderTokenSha256'));
    assert.ok(!workflow.includes('INVOICE_READER_TOKEN_SHA256'));
  });
});
