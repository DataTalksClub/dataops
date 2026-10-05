import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { handler } from '../src/handler';
import { handlePortal } from '../src/docs/portal';
import { useTestDatabase } from './helpers/db';
import { createUserWithId, updateUser } from '../src/db/users';
import { createBrowserSession } from '../src/db/sessions';
import { createDeviceGrant, getDeviceGrantByDeviceCode } from '../src/db/cliAuth';

const config = {
  DATAOPS_DOCS_DOMAIN: '1', WORK_ENGINE_AUTH_MODE: 'portal', SKIP_AUTH: 'false',
  AUTH_BASE_URL: 'https://auth.example.test', AUTH_ISSUER: 'https://issuer.example.test/pool',
  AUTH_CLIENT_ID: 'synthetic-client', AUTH_CALLBACK_URL: 'https://ops.example.test/auth/callback',
  AUTH_LOGOUT_URL: 'https://ops.example.test/',
};
const saved = Object.fromEntries(Object.keys(config).map(key => [key, process.env[key]]));
let client: DynamoDBDocumentClient;
let cookie: string;
const request = (method: string, path: string, body: unknown = {}, headers: Record<string, string> = {}) =>
  handler({ httpMethod: method, path, body: JSON.stringify(body), headers }, {});
const json = (response: { body: string }) => JSON.parse(response.body);

async function start(prefix = '', headers: Record<string, string> = {}) {
  const response = await request('POST', `${prefix}/api/auth/device`, { label: 'Synthetic CLI' }, headers);
  assert.equal(response.statusCode, 200);
  const grant = json(response);
  assert.match(grant.userCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(grant.expiresIn <= 600 && grant.expiresIn > 0, true);
  return grant as { deviceCode: string; userCode: string };
}

describe('device authentication through the configured portal and router', () => {
  before(async () => {
    Object.assign(process.env, config);
    ({ client } = await useTestDatabase());
    await createUserWithId(client, 'device-browser-operator', {
      name: 'Synthetic Operator', email: 'device@example.test', role: 'operator',
    });
    const session = await createBrowserSession(client, 'device-browser-operator', { lifetimeSeconds: 3600 });
    cookie = `dataops_session=${session.token}`;
  });
  after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  it('passes only device start and poll without establishing an authenticated identity', async () => {
    for (const prefix of ['', '/work']) {
      for (const suffix of ['', '/token']) {
        const event = { httpMethod: 'POST', path: `${prefix}/api/auth/device${suffix}`, headers: {} };
        assert.deepEqual(await handlePortal(event, client), { authorized: false });
        assert.equal(event.path, `/api/auth/device${suffix}`);
        assert.deepEqual(event.headers, {});
      }
      const grant = await start(prefix, { 'X-User-Id': 'device-browser-operator' });
      const poll = await request('POST', `${prefix}/api/auth/device/token`, { deviceCode: grant.deviceCode });
      assert.equal(poll.statusCode, 400);
      assert.deepEqual(json(poll), { error: 'authorization_pending' });
      assert.equal((await getDeviceGrantByDeviceCode(client, grant.deviceCode))?.userId, undefined);
    }
  });

  it('does not widen the exception to methods, lookalikes, identity headers or private APIs', async () => {
    const paths = ['/api/auth/device', '/api/auth/device/token'];
    for (const prefix of ['', '/work']) {
      for (const path of paths) {
        for (const method of ['GET', 'PUT', 'DELETE', 'PATCH', 'HEAD']) {
          assert.equal((await request(method, prefix + path)).statusCode, 401, `${method} ${prefix + path}`);
        }
      }
      for (const path of ['/api/auth/device/', '/api/auth/device/token/', '/api/auth/device-extra',
        '/api/auth/device/token-extra', '/api/auth/device/pending', '/api/auth/device/approve',
        '/api/tokens', '/api/tokens/synthetic-id', '/api/me', '/api/bookkeeping/invoices', '/api/tasks']) {
        for (const headers of [{}, { 'X-User-Id': 'device-browser-operator' }, { authorization: 'Bearer invalid' }]) {
          const response = await request(path.endsWith('/approve') ? 'POST' : 'GET', prefix + path, {}, headers);
          assert.equal(response.statusCode, 401, prefix + path);
        }
      }
      assert.equal((await request('POST', `${prefix}/api/auth/login`)).statusCode, 404);
    }
  });

  it('retains request validation and anonymous pending, denied, expired and unknown outcomes', async () => {
    assert.equal((await handler({ httpMethod: 'POST', path: '/api/auth/device', body: '{', headers: {} }, {})).statusCode, 400);
    assert.deepEqual(json(await request('POST', '/api/auth/device/token')), { error: 'deviceCode is required' });
    assert.deepEqual(json(await request('POST', '/api/auth/device/token', { deviceCode: 'unknown' })), { error: 'expired_token' });
    const expired = await createDeviceGrant(client, { label: 'Expired', requestIp: '127.0.0.1', now: new Date(Date.now() - 601_000) });
    assert.deepEqual(json(await request('POST', '/api/auth/device/token', { deviceCode: expired.deviceCode })), { error: 'expired_token' });
    const denied = await start();
    assert.equal((await request('POST', '/api/auth/device/approve', { userCode: denied.userCode, approve: false }, { cookie })).statusCode, 200);
    assert.deepEqual(json(await request('POST', '/api/auth/device/token', { deviceCode: denied.deviceCode })), { error: 'access_denied' });
  });

  it('requires browser approval and preserves single-use exchange, bearer validation and disabled-user denial', async () => {
    const grant = await start();
    assert.equal((await request('POST', '/api/auth/device/approve', { userCode: grant.userCode }, { 'x-user-id': 'device-browser-operator' })).statusCode, 401);
    const preview = await handler({ httpMethod: 'GET', path: '/work/api/auth/device/pending',
      queryStringParameters: { userCode: grant.userCode }, headers: { cookie } }, {});
    assert.equal(preview.statusCode, 200);
    assert.equal(json(preview).label, 'Synthetic CLI');
    assert.equal((await request('POST', '/work/api/auth/device/approve', { userCode: grant.userCode }, { cookie })).statusCode, 200);
    const exchange = await request('POST', '/api/auth/device/token', { deviceCode: grant.deviceCode });
    assert.equal(exchange.statusCode, 200);
    const credential = json(exchange);
    assert.equal(credential.user.id, 'device-browser-operator');
    assert.ok(Date.parse(credential.expiresAt) > Date.now());
    assert.deepEqual(json(await request('POST', '/api/auth/device/token', { deviceCode: grant.deviceCode })), { error: 'expired_token' });
    assert.equal((await request('GET', '/api/me', {}, { authorization: `Bearer ${credential.token}` })).statusCode, 200);
    assert.equal((await request('GET', '/api/tokens', {}, { authorization: `Bearer ${credential.token}` })).statusCode, 200);
    const blocked = await start();
    await request('POST', '/api/auth/device/approve', { userCode: blocked.userCode }, { cookie });
    await updateUser(client, 'device-browser-operator', { disabled: true });
    try {
      assert.deepEqual(json(await request('POST', '/api/auth/device/token', { deviceCode: blocked.deviceCode })), { error: 'access_denied' });
      assert.equal((await request('POST', '/api/auth/device/approve', { userCode: (await start()).userCode }, { cookie })).statusCode, 401);
    } finally { await updateUser(client, 'device-browser-operator', { disabled: false }); }
  });
});
