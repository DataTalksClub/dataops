import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';

import { handler } from '../src/handler';
import { stopLocal } from '../src/db/client';
import { useTestDatabase } from './helpers/db';
import { createUserWithId } from '../src/db/users';
import { normalizeUserCode } from '../src/db/cliAuth';

const PORTAL_HEADERS = {
  'x-portal-auth': 'true',
  'x-portal-secret': 'test-portal-secret',
  'x-user-id': 'device-operator',
};

function body(response: { body: string }): Record<string, unknown> {
  return JSON.parse(response.body || '{}');
}

async function startDeviceLogin(label = 'grace@laptop') {
  const response = await handler(
    {
      httpMethod: 'POST',
      path: '/api/auth/device',
      body: JSON.stringify({ label }),
      headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' },
    },
    {},
  );
  assert.strictEqual(response.statusCode, 200);
  return body(response) as { deviceCode: string; userCode: string; interval: number; verificationUriComplete: string };
}

async function poll(deviceCode: string) {
  return handler(
    {
      httpMethod: 'POST',
      path: '/api/auth/device/token',
      body: JSON.stringify({ deviceCode }),
      headers: {},
    },
    {},
  );
}

async function approve(userCode: string, approveIt = true, headers = PORTAL_HEADERS) {
  return handler(
    {
      httpMethod: 'POST',
      path: '/api/auth/device/approve',
      body: JSON.stringify({ userCode, approve: approveIt }),
      headers,
    },
    {},
  );
}

describe('CLI device authorization', () => {
  const originalSkipAuth = process.env.SKIP_AUTH;
  const originalAuthMode = process.env.WORK_ENGINE_AUTH_MODE;
  const originalPortalSecret = process.env.WORK_ENGINE_PORTAL_SECRET;

  before(async () => {
    process.env.IS_LOCAL = 'true';
    const { client } = await useTestDatabase();
    const warmUp = await handler({ httpMethod: 'GET', path: '/api/health' }, {});
    assert.strictEqual(warmUp.statusCode, 200);
    await createUserWithId(client, 'device-operator', {
      name: 'Device Operator',
      email: 'device-operator@datatalks.club',
      role: 'operator',
    });
    process.env.SKIP_AUTH = 'false';
    process.env.WORK_ENGINE_AUTH_MODE = 'portal';
    process.env.WORK_ENGINE_PORTAL_SECRET = 'test-portal-secret';
  });

  after(async () => {
    if (originalSkipAuth === undefined) delete process.env.SKIP_AUTH;
    else process.env.SKIP_AUTH = originalSkipAuth;
    if (originalAuthMode === undefined) delete process.env.WORK_ENGINE_AUTH_MODE;
    else process.env.WORK_ENGINE_AUTH_MODE = originalAuthMode;
    if (originalPortalSecret === undefined) delete process.env.WORK_ENGINE_PORTAL_SECRET;
    else process.env.WORK_ENGINE_PORTAL_SECRET = originalPortalSecret;
    delete process.env.IS_LOCAL;
    await stopLocal();
  });

  it('issues a token only after the operator confirms the code in the browser', async () => {
    const start = await startDeviceLogin();
    assert.match(start.userCode, /^[BCDFGHJKLMNPQRSTVWXZ23456789]{4}-[BCDFGHJKLMNPQRSTVWXZ23456789]{4}$/);
    assert.ok(start.deviceCode.length >= 64);
    assert.ok(start.verificationUriComplete.includes(encodeURIComponent(start.userCode)));

    const pending = await poll(start.deviceCode);
    assert.strictEqual(pending.statusCode, 400);
    assert.deepStrictEqual(body(pending), { error: 'authorization_pending' });

    // The browser half runs on the operator's portal session.
    const preview = await handler(
      {
        httpMethod: 'GET',
        path: '/api/auth/device/pending',
        queryStringParameters: { userCode: start.userCode },
        headers: PORTAL_HEADERS,
      },
      {},
    );
    assert.strictEqual(preview.statusCode, 200);
    assert.deepStrictEqual(
      { label: body(preview).label, requestIp: body(preview).requestIp },
      { label: 'grace@laptop', requestIp: '203.0.113.9' },
    );

    assert.strictEqual((await approve(start.userCode)).statusCode, 200);

    const granted = await poll(start.deviceCode);
    assert.strictEqual(granted.statusCode, 200);
    const payload = body(granted) as { token: string; user: { id: string }; expiresAt: string };
    assert.match(payload.token, /^dops_[0-9a-f]{64}$/);
    assert.strictEqual(payload.user.id, 'device-operator');
    assert.ok(Date.parse(payload.expiresAt) > Date.now());

    // The grant is single use.
    const replay = await poll(start.deviceCode);
    assert.strictEqual(replay.statusCode, 400);
    assert.deepStrictEqual(body(replay), { error: 'expired_token' });
  });

  it('authenticates API routes with the issued token and records the acting user', async () => {
    const start = await startDeviceLogin('grace@remote');
    await approve(start.userCode);
    const token = (body(await poll(start.deviceCode)) as { token: string }).token;

    const me = await handler(
      { httpMethod: 'GET', path: '/api/me', headers: { authorization: `Bearer ${token}` } },
      {},
    );
    assert.strictEqual(me.statusCode, 200);
    assert.strictEqual((body(me) as { user: { id: string } }).user.id, 'device-operator');

    const created = await handler(
      {
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({ description: 'Filed by the CLI', date: '2028-11-04' }),
        headers: { authorization: `Bearer ${token}` },
      },
      {},
    );
    assert.strictEqual(created.statusCode, 201);

    const listed = await handler(
      { httpMethod: 'GET', path: '/api/tokens', headers: { authorization: `Bearer ${token}` } },
      {},
    );
    assert.strictEqual(listed.statusCode, 200);
    const tokens = (body(listed) as { tokens: Array<{ label: string; id: string }> }).tokens;
    assert.ok(tokens.some((entry) => entry.label === 'grace@remote'));

    // Revoking must take the credential out of service immediately.
    const target = tokens.find((entry) => entry.label === 'grace@remote')!;
    const revoked = await handler(
      {
        httpMethod: 'DELETE',
        path: `/api/tokens/${target.id}`,
        headers: { authorization: `Bearer ${token}` },
      },
      {},
    );
    assert.strictEqual(revoked.statusCode, 204);
    const afterRevoke = await handler(
      { httpMethod: 'GET', path: '/api/me', headers: { authorization: `Bearer ${token}` } },
      {},
    );
    assert.strictEqual(afterRevoke.statusCode, 401);
  });

  it('refuses a denied grant, an unauthenticated approval, and an unknown code', async () => {
    const denied = await startDeviceLogin();
    assert.strictEqual((await approve(denied.userCode, false)).statusCode, 200);
    const deniedPoll = await poll(denied.deviceCode);
    assert.strictEqual(deniedPoll.statusCode, 400);
    assert.deepStrictEqual(body(deniedPoll), { error: 'access_denied' });

    // Approval requires a signed-in operator: a bare request cannot confirm.
    const pendingGrant = await startDeviceLogin();
    const anonymous = await approve(pendingGrant.userCode, true, {} as typeof PORTAL_HEADERS);
    assert.strictEqual(anonymous.statusCode, 401);
    assert.strictEqual((await poll(pendingGrant.deviceCode)).statusCode, 400);

    const unknown = await approve('BCDF-GHJK');
    assert.strictEqual(unknown.statusCode, 404);

    const guessedDeviceCode = await poll('f'.repeat(64));
    assert.strictEqual(guessedDeviceCode.statusCode, 400);
    assert.deepStrictEqual(body(guessedDeviceCode), { error: 'expired_token' });
  });

  it('keeps password login disabled in portal mode while device login stays reachable', async () => {
    const login = await handler(
      {
        httpMethod: 'POST',
        path: '/api/auth/login',
        body: JSON.stringify({ email: 'device-operator@datatalks.club', password: 'whatever' }),
        headers: {},
      },
      {},
    );
    assert.strictEqual(login.statusCode, 404);

    const device = await handler(
      { httpMethod: 'POST', path: '/api/auth/device', body: JSON.stringify({}), headers: {} },
      {},
    );
    assert.strictEqual(device.statusCode, 200);
    assert.strictEqual((body(device) as { userCode: string }).userCode.length, 9);
  });

  it('normalizes user codes the way an operator retypes them', () => {
    assert.strictEqual(normalizeUserCode('bcdf-ghjk'), 'BCDF-GHJK');
    assert.strictEqual(normalizeUserCode(' bcdfghjk '), 'BCDF-GHJK');
    assert.strictEqual(normalizeUserCode('BCDF GHJK'), 'BCDF-GHJK');
    assert.strictEqual(normalizeUserCode('BCDF-GHJ'), '');
  });
});
