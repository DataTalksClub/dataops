import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { handler } from '../src/handler';
import { useTestDatabase } from './helpers/db';

const token = `dops_svc_${'a'.repeat(64)}`;
const config = {
  DATAOPS_DOCS_DOMAIN: '1', WORK_ENGINE_AUTH_MODE: 'portal', SKIP_AUTH: 'false',
  AUTH_BASE_URL: 'https://auth.example.test', AUTH_ISSUER: 'https://issuer.example.test/pool',
  AUTH_CLIENT_ID: 'synthetic', AUTH_CALLBACK_URL: 'https://ops.example.test/auth/callback',
  INVOICE_READER_TOKEN_SHA256: createHash('sha256').update(token).digest('hex'),
};
const saved = Object.fromEntries(Object.keys(config).map(key => [key, process.env[key]]));
const request = (method: string, path: string, credential = token) => {
  const [cleanPath, query] = path.split('?');
  const queryStringParameters = query
    ? Object.fromEntries(new URLSearchParams(query).entries())
    : null;
  return handler({
    httpMethod: method, path: cleanPath, queryStringParameters,
    headers: { Authorization: `Bearer ${credential}`, 'x-user-id': 'spoofed-admin' }, body: '{}',
  }, {});
};

describe('deployment-managed invoice reader through the configured portal', () => {
  before(async () => { Object.assign(process.env, config); await useTestDatabase(); });
  after(() => { for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  it('reads invoices and identifies a service without issuing a user session', async () => {
    for (const prefix of ['', '/work']) {
      const identity = await request('GET', `${prefix}/api/me`);
      assert.equal(identity.statusCode, 200);
      assert.deepEqual(JSON.parse(identity.body), { service: { id: 'invoice-reader', scopes: ['invoices:read', 'crm:read', 'crm:write'], expiresAt: null } });
      const list = await request('GET', `${prefix}/api/bookkeeping/invoices`);
      assert.equal(list.statusCode, 200);
      assert.deepEqual(JSON.parse(list.body), { items: [] });
      assert.equal((await request('GET', `${prefix}/api/bookkeeping/invoices/${'b'.repeat(64)}`)).statusCode, 404);
      assert.equal((await request('GET', `${prefix}/api/bookkeeping/invoices/${'b'.repeat(64)}/document`)).statusCode, 404);

      // CRM directory and tasks are accessible under crm:read
      const crmCompanies = await request('GET', `${prefix}/api/sponsor-crm/directory/companies`);
      assert.equal(crmCompanies.statusCode, 200);
      const tasksList = await request('GET', `${prefix}/api/tasks?status=todo`);
      assert.equal(tasksList.statusCode, 200);

      // Finance aggregates are readable; the period is validated.
      const finance = await request('GET', `${prefix}/api/finance/summary?month=2026-10`);
      assert.equal(finance.statusCode, 200);
      assert.equal(JSON.parse(finance.body).totals.net, 0);
      assert.equal((await request('GET', `${prefix}/api/finance/summary?month=2026-13`)).statusCode, 400);
      for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await request(method, `${prefix}/api/finance/summary`)).statusCode, 403);
    }
  });
  it('refuses every mutation, unrelated API and path lookalike', async () => {
    for (const prefix of ['', '/work']) for (const path of ['/api/me', '/api/users', '/api/tokens',
      '/api/templates',
      '/api/auth/device/approve', '/api/bookkeeping', '/api/bookkeeping/invoices/',
      '/api/bookkeeping/invoices/process', `/api/bookkeeping/invoices/${'b'.repeat(64)}/verify`]) {
      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) assert.equal((await request(method, prefix + path)).statusCode, 403);
      if (path !== '/api/me') assert.equal((await request('GET', prefix + path)).statusCode, 403);
    }
  });
  it('fails closed when disabled, malformed, incorrect or rotated', async () => {
    for (const value of ['', 'malformed', '0'.repeat(64)]) {
      process.env.INVOICE_READER_TOKEN_SHA256 = value;
      assert.equal((await request('GET', '/api/bookkeeping/invoices')).statusCode, 401);
    }
    process.env.INVOICE_READER_TOKEN_SHA256 = config.INVOICE_READER_TOKEN_SHA256;
    assert.equal((await request('GET', '/api/me', 'dops_svc_bad')).statusCode, 401);
    const rotated = `dops_svc_${'c'.repeat(64)}`;
    process.env.INVOICE_READER_TOKEN_SHA256 = createHash('sha256').update(rotated).digest('hex');
    assert.equal((await request('GET', '/api/me')).statusCode, 401);
    assert.equal((await request('GET', '/api/me', rotated)).statusCode, 200);
  });
  it('deploys only the digest, with the same disable switch through CI and SAM', () => {
    const template = readFileSync(new URL('../../infra/template.full.yaml', import.meta.url), 'utf8');
    const workflow = readFileSync(new URL('../../.github/workflows/deploy-dataops-v1.yml', import.meta.url), 'utf8');
    assert.match(template, /InvoiceReaderTokenSha256:\s+Type: String\s+Default: ""\s+NoEcho: true/);
    assert.match(template, /INVOICE_READER_TOKEN_SHA256: !Ref InvoiceReaderTokenSha256/);
    assert.match(workflow, /secrets\.INVOICE_READER_TOKEN_SHA256/);
    assert.match(workflow, /ParameterKey=InvoiceReaderTokenSha256,ParameterValue=\$INVOICE_READER_TOKEN_SHA256/);
  });
});
