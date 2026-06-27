import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';

import { handler } from '../src/handler';
import { startLocal, stopLocal } from '../src/db/client';

describe('Portal broker authentication', () => {
  const originalSkipAuth = process.env.SKIP_AUTH;
  const originalAuthMode = process.env.WORK_ENGINE_AUTH_MODE;
  const originalPortalSecret = process.env.WORK_ENGINE_PORTAL_SECRET;

  before(async () => {
    process.env.IS_LOCAL = 'true';
    await startLocal();
    const warmUp = await handler({ httpMethod: 'GET', path: '/api/health' }, {});
    assert.strictEqual(warmUp.statusCode, 200);
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

  it('requires normal session auth when portal trust headers are absent', async () => {
    process.env.SKIP_AUTH = 'false';
    process.env.WORK_ENGINE_AUTH_MODE = 'portal';
    process.env.WORK_ENGINE_PORTAL_SECRET = 'test-portal-secret';

    const response = await handler(
      {
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({ description: 'Portal-only task', date: '2028-10-01' }),
        headers: {},
      },
      {},
    );

    assert.strictEqual(response.statusCode, 401);
    assert.deepStrictEqual(JSON.parse(response.body), { error: 'Unauthorized' });
  });

  it('does not trust portal headers unless portal auth mode is enabled', async () => {
    process.env.SKIP_AUTH = 'false';
    process.env.WORK_ENGINE_PORTAL_SECRET = 'test-portal-secret';
    delete process.env.WORK_ENGINE_AUTH_MODE;

    const response = await handler(
      {
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({ description: 'Ignored portal task', date: '2028-10-02' }),
        headers: { 'x-portal-auth': 'true', 'x-user-id': 'portal-admin' },
      },
      {},
    );

    assert.strictEqual(response.statusCode, 401);
  });

  it('rejects portal headers without the broker secret', async () => {
    process.env.SKIP_AUTH = 'false';
    process.env.WORK_ENGINE_AUTH_MODE = 'portal';
    process.env.WORK_ENGINE_PORTAL_SECRET = 'test-portal-secret';

    const response = await handler(
      {
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({ description: 'Spoofed task', date: '2028-10-03' }),
        headers: { 'x-portal-auth': 'true', 'x-user-id': 'portal-admin' },
      },
      {},
    );

    assert.strictEqual(response.statusCode, 401);
  });

  it('accepts portal broker headers without a bearer session', async () => {
    process.env.SKIP_AUTH = 'false';
    process.env.WORK_ENGINE_AUTH_MODE = 'portal';
    process.env.WORK_ENGINE_PORTAL_SECRET = 'test-portal-secret';

    const response = await handler(
      {
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({ description: 'Brokered task', date: '2028-10-04' }),
        headers: {
          'x-portal-auth': 'true',
          'x-portal-secret': 'test-portal-secret',
          'x-user-id': 'portal-admin',
        },
      },
      {},
    );

    assert.strictEqual(response.statusCode, 201);
    const body = JSON.parse(response.body);
    assert.strictEqual(body.description, 'Brokered task');
    assert.strictEqual(body.date, '2028-10-04');
  });

  it('returns a portal actor for /api/me in portal mode', async () => {
    process.env.SKIP_AUTH = 'false';
    process.env.WORK_ENGINE_AUTH_MODE = 'portal';
    process.env.WORK_ENGINE_PORTAL_SECRET = 'test-portal-secret';

    const response = await handler(
      {
        httpMethod: 'GET',
        path: '/api/me',
        headers: {
          'x-portal-auth': 'true',
          'x-portal-secret': 'test-portal-secret',
          'x-user-id': 'ops-manager',
        },
      },
      {},
    );

    assert.strictEqual(response.statusCode, 200);
    assert.deepStrictEqual(JSON.parse(response.body), { user: { id: 'ops-manager', name: 'Portal user' } });
  });
});
