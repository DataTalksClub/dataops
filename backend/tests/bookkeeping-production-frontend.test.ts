import { after, before, describe, it } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { handler } from '../src/handler';
import { getClient, startLocal, stopLocal } from '../src/db/client';
import { createTables } from '../src/db/setup';
import { createBrowserSession } from '../src/db/sessions';
import { createUserWithId } from '../src/db/users';

const frontendRoot = path.resolve(__dirname, '../../frontend');
let authCookie = '';
const invoke = (requestPath: string) => handler({ httpMethod: 'GET', path: requestPath, headers: { cookie: authCookie } }, {});

describe('production portal bookkeeping frontend', () => {
  before(async () => {
    process.env.DATAOPS_DOCS_DOMAIN = '1';
    process.env.FRONTEND_ROOT = frontendRoot;
    Object.assign(process.env, { AUTH_BASE_URL: 'https://auth.example.test', AUTH_ISSUER: 'https://issuer.example.test/pool', AUTH_CLIENT_ID: 'dataops-client', AUTH_CALLBACK_URL: 'https://ops.example.test/auth/callback', AUTH_LOGOUT_URL: 'https://ops.example.test/' });
    const port = await startLocal();
    const client = await getClient(port);
    await createTables(client);
    await createUserWithId(client, 'synthetic-operator', { name: 'Synthetic operator', email: 'operator@datatalks.club', role: 'operator' });
    const session = await createBrowserSession(client, 'synthetic-operator', { lifetimeSeconds: 3600 });
    authCookie = `dataops_session=${session.token}`;
  });
  after(async () => {
    delete process.env.DATAOPS_DOCS_DOMAIN;
    delete process.env.FRONTEND_ROOT;
    for (const key of ['AUTH_BASE_URL', 'AUTH_ISSUER', 'AUTH_CLIENT_ID', 'AUTH_CALLBACK_URL', 'AUTH_LOGOUT_URL']) delete process.env[key];
    await stopLocal();
  });

  it('serves Bookkeeping navigation from the real deployed frontend', async () => {
    const response = await invoke('/');
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /data-workspace-view="bookkeeping"/);
  });

  it('serves the complete bookkeeping operator surface and responsive styles', async () => {
    const finance = await invoke('/src/surfaces/finance.js');
    const css = await invoke('/src/styles.css');
    assert.equal(finance.statusCode, 200);
    for (const marker of ['renderBookkeepingSurface', '/transactions', '/documents/prepare', '/complete', 'idempotencyKey', 'runId', 'crypto.subtle.digest', '/accounts/setup', '/reports/snapshot', 'data-unlink', 'missingEvidence']) assert.ok(finance.body.includes(marker), marker);
    assert.ok(!finance.body.includes('/documents/upload'), 'retired non-atomic upload route must stay absent');
    assert.equal(css.statusCode, 200);
    assert.match(css.body, /\.bookkeeping-surface/);
    assert.match(css.body, /@media \(max-width: 820px\)/);
  });
});
