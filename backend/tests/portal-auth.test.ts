import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';

import { handler } from '../src/handler';
import { getClient, startLocal, stopLocal } from '../src/db/client';
import { createNotification } from '../src/db/notifications';
import { createSession } from '../src/db/sessions';
import { createUserWithId } from '../src/db/users';

describe('Portal broker authentication', () => {
  const originalSkipAuth = process.env.SKIP_AUTH;
  const originalAuthMode = process.env.WORK_ENGINE_AUTH_MODE;
  const originalPortalSecret = process.env.WORK_ENGINE_PORTAL_SECRET;

  before(async () => {
    process.env.IS_LOCAL = 'true';
    await startLocal();
    const warmUp = await handler({ httpMethod: 'GET', path: '/api/health' }, {});
    assert.strictEqual(warmUp.statusCode, 200);
    const client = await getClient();
    await createUserWithId(client, 'ops-manager', { name: 'Ops Manager', email: 'ops-manager@datatalks.club', role: 'operator' });
    await createUserWithId(client, 'legacy-user', { name: 'Legacy client', email: 'legacy@datatalks.club', role: 'operator' });
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

  it('rejects portal headers with the wrong broker secret', async () => {
    process.env.SKIP_AUTH = 'false';
    process.env.WORK_ENGINE_AUTH_MODE = 'portal';
    process.env.WORK_ENGINE_PORTAL_SECRET = 'test-portal-secret';

    const response = await handler(
      {
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({ description: 'Wrong secret task', date: '2028-10-03' }),
        headers: {
          'x-portal-auth': 'true',
          'x-portal-secret': 'wrong-secret',
          'x-user-id': 'portal-admin',
        },
      },
      {},
    );

    assert.strictEqual(response.statusCode, 401);
  });

  it('hides standalone auth routes in portal mode', async () => {
    process.env.SKIP_AUTH = 'false';
    process.env.WORK_ENGINE_AUTH_MODE = 'portal';
    process.env.WORK_ENGINE_PORTAL_SECRET = 'test-portal-secret';

    const response = await handler(
      {
        httpMethod: 'POST',
        path: '/api/auth/login',
        body: JSON.stringify({ email: 'ops@datatalks.club', password: 'secret' }),
        headers: {},
      },
      {},
    );

    assert.strictEqual(response.statusCode, 404);
    assert.deepStrictEqual(JSON.parse(response.body), { error: 'Not found' });
  });

  it('preserves existing bearer sessions for /api/me in portal mode', async () => {
    process.env.SKIP_AUTH = 'false';
    process.env.WORK_ENGINE_AUTH_MODE = 'portal';
    process.env.WORK_ENGINE_PORTAL_SECRET = 'test-portal-secret';

    const client = await getClient();
    const session = await createSession(client, 'legacy-user');

    const response = await handler(
      {
        httpMethod: 'GET',
        path: '/api/me',
        headers: { Authorization: `Bearer ${session.token}` },
      },
      {},
    );

    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(JSON.parse(response.body).user.id, 'legacy-user');
  });

  it('preserves legacy bearer clients on protected API routes without a browser cookie', async () => {
    process.env.SKIP_AUTH = 'false';
    process.env.WORK_ENGINE_AUTH_MODE = 'portal';
    process.env.WORK_ENGINE_PORTAL_SECRET = 'test-portal-secret';
    const client = await getClient();
    const session = await createSession(client, 'legacy-user');

    const response = await handler({
      httpMethod: 'GET',
      path: '/api/users',
      headers: { authorization: `Bearer ${session.token}` },
    }, {});

    assert.strictEqual(response.statusCode, 200);
    assert.ok(Array.isArray(JSON.parse(response.body).users));
  });

  it('rejects a fabricated bearer even when a raw x-user-id names an existing admin', async () => {
    process.env.SKIP_AUTH = 'false';
    process.env.WORK_ENGINE_AUTH_MODE = 'portal';
    process.env.WORK_ENGINE_PORTAL_SECRET = 'test-portal-secret';

    const response = await handler({
      httpMethod: 'GET',
      path: '/api/me',
      headers: { Authorization: 'Bearer fabricated-token', 'X-User-Id': 'ops-manager' },
    }, {});

    assert.strictEqual(response.statusCode, 401);
    assert.deepStrictEqual(JSON.parse(response.body), { error: 'Unauthorized' });
  });

  it('ignores a mismatched raw x-user-id and resolves a valid bearer to its session user', async () => {
    process.env.SKIP_AUTH = 'false';
    process.env.WORK_ENGINE_AUTH_MODE = 'portal';
    process.env.WORK_ENGINE_PORTAL_SECRET = 'test-portal-secret';
    const client = await getClient();
    const session = await createSession(client, 'legacy-user');

    const response = await handler({
      httpMethod: 'GET',
      path: '/api/me',
      headers: { authorization: `Bearer ${session.token}`, 'x-user-id': 'ops-manager' },
    }, {});

    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(JSON.parse(response.body).user.id, 'legacy-user');
    assert.strictEqual(JSON.parse(response.body).user.role, 'operator');
  });

  it('does not let raw x-user-id authorize other protected API routes', async () => {
    process.env.SKIP_AUTH = 'false';
    process.env.WORK_ENGINE_AUTH_MODE = 'portal';
    process.env.WORK_ENGINE_PORTAL_SECRET = 'test-portal-secret';

    const response = await handler({
      httpMethod: 'POST',
      path: '/api/tasks',
      body: JSON.stringify({ description: 'Must not be created', date: '2028-10-03' }),
      headers: { authorization: 'Bearer fabricated-token', 'x-user-id': 'ops-manager' },
    }, {});

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
    const body = JSON.parse(response.body);
    assert.strictEqual(body.user.id, 'ops-manager');
    assert.strictEqual(body.user.name, 'Ops Manager');
    assert.strictEqual(body.user.role, 'operator');
  });

  it('treats portal-admin notification requests as unscoped so operator-assigned notifications remain visible', async () => {
    process.env.SKIP_AUTH = 'false';
    process.env.WORK_ENGINE_AUTH_MODE = 'portal';
    process.env.WORK_ENGINE_PORTAL_SECRET = 'test-portal-secret';

    const client = await getClient();
    const suffix = Date.now().toString(36);
    const assignedNotification = await createNotification(client, {
      type: 'operator-assigned-regression',
      message: `Portal admin visible assigned notification ${suffix}`,
      dueAt: '2028-10-05T09:00:00.000Z',
      userId: 'operator-assignee',
    });

    const response = await handler(
      {
        httpMethod: 'GET',
        path: '/api/notifications',
        headers: {
          'x-portal-auth': 'true',
          'x-portal-secret': 'test-portal-secret',
          'x-user-id': 'portal-admin',
        },
      },
      {},
    );

    assert.strictEqual(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.ok(
      body.notifications.some((notification: { id?: string }) => notification.id === assignedNotification.id),
      'portal-admin should receive the unscoped notifications list, including operator-assigned notifications',
    );
  });

  it('keeps notification filtering scoped for real portal user ids', async () => {
    process.env.SKIP_AUTH = 'false';
    process.env.WORK_ENGINE_AUTH_MODE = 'portal';
    process.env.WORK_ENGINE_PORTAL_SECRET = 'test-portal-secret';

    const client = await getClient();
    const suffix = Date.now().toString(36);
    const otherUserNotification = await createNotification(client, {
      type: 'real-user-filter-regression',
      message: `Other operator hidden notification ${suffix}`,
      dueAt: '2028-10-05T09:00:00.000Z',
      userId: 'other-operator',
    });
    const globalNotification = await createNotification(client, {
      type: 'real-user-filter-regression',
      message: `Global visible notification ${suffix}`,
      dueAt: '2028-10-05T09:00:00.000Z',
    });

    const response = await handler(
      {
        httpMethod: 'GET',
        path: '/api/notifications',
        headers: {
          'x-portal-auth': 'true',
          'x-portal-secret': 'test-portal-secret',
          'x-user-id': 'ops-manager',
        },
      },
      {},
    );

    assert.strictEqual(response.statusCode, 200);
    const body = JSON.parse(response.body);
    const ids = body.notifications.map((notification: { id: string }) => notification.id);
    assert.ok(ids.includes(globalNotification.id), 'real users should still see global notifications');
    assert.ok(!ids.includes(otherUserNotification.id), 'real users should not see notifications assigned to another user');
  });

  it('allows portal broker headers to perform Operations Home write actions', async () => {
    process.env.SKIP_AUTH = 'false';
    process.env.WORK_ENGINE_AUTH_MODE = 'portal';
    process.env.WORK_ENGINE_PORTAL_SECRET = 'test-portal-secret';

    const headers = {
      'x-portal-auth': 'true',
      'x-portal-secret': 'test-portal-secret',
      'x-user-id': 'ops-manager',
    };
    const suffix = Date.now().toString(36);

    const createTaskResponse = await handler(
      {
        httpMethod: 'POST',
        path: '/api/tasks',
        body: JSON.stringify({ description: `Portal action task ${suffix}`, date: '2028-10-05' }),
        headers,
      },
      {},
    );
    assert.strictEqual(createTaskResponse.statusCode, 201);
    const createdTask = JSON.parse(createTaskResponse.body);

    const waitingTaskResponse = await handler(
      {
        httpMethod: 'PUT',
        path: `/api/tasks/${createdTask.id}`,
        body: JSON.stringify({
          status: 'waiting',
          waitingFor: 'guest bio',
          followUpAt: '2028-10-06',
          comment: '[2028-10-05T10:00:00.000Z] Follow-up sent; next follow-up 2028-10-06',
        }),
        headers,
      },
      {},
    );
    assert.strictEqual(waitingTaskResponse.statusCode, 200);
    const waitingTask = JSON.parse(waitingTaskResponse.body);
    assert.strictEqual(waitingTask.status, 'waiting');
    assert.strictEqual(waitingTask.waitingFor, 'guest bio');
    assert.strictEqual(waitingTask.followUpAt, '2028-10-06');

    const createBundleResponse = await handler(
      {
        httpMethod: 'POST',
        path: '/api/bundles',
        body: JSON.stringify({ title: `Portal action bundle ${suffix}`, anchorDate: '2028-10-05' }),
        headers,
      },
      {},
    );
    assert.strictEqual(createBundleResponse.statusCode, 201);
    const createdBundle = JSON.parse(createBundleResponse.body).bundle;

    const updateBundleResponse = await handler(
      {
        httpMethod: 'PUT',
        path: `/api/bundles/${createdBundle.id}`,
        body: JSON.stringify({
          stage: 'announced',
          bundleLinks: [{ name: 'Podcast doc', url: 'https://example.com/doc' }],
          references: [{ name: 'Guest notes', url: 'https://example.com/notes' }],
        }),
        headers,
      },
      {},
    );
    assert.strictEqual(updateBundleResponse.statusCode, 200);
    const updatedBundle = JSON.parse(updateBundleResponse.body).bundle;
    assert.strictEqual(updatedBundle.stage, 'announced');
    assert.deepStrictEqual(updatedBundle.bundleLinks, [{ name: 'Podcast doc', url: 'https://example.com/doc' }]);
    assert.deepStrictEqual(updatedBundle.references, [{ name: 'Guest notes', url: 'https://example.com/notes' }]);

    const createRecurringResponse = await handler(
      {
        httpMethod: 'POST',
        path: '/api/recurring',
        body: JSON.stringify({
          description: `Portal recurring ${suffix}`,
          cronExpression: '0 9 * * *',
          enabled: true,
        }),
        headers,
      },
      {},
    );
    assert.strictEqual(createRecurringResponse.statusCode, 201);
    const recurringConfig = JSON.parse(createRecurringResponse.body).recurringConfig;
    assert.strictEqual(recurringConfig.description, `Portal recurring ${suffix}`);

    const generateRecurringResponse = await handler(
      {
        httpMethod: 'POST',
        path: '/api/recurring/generate',
        body: JSON.stringify({ startDate: '2028-10-07', endDate: '2028-10-07' }),
        headers,
      },
      {},
    );
    assert.strictEqual(generateRecurringResponse.statusCode, 200);
    const generated = JSON.parse(generateRecurringResponse.body);
    assert.ok(generated.generated.some((task: { recurringConfigId?: string }) => task.recurringConfigId === recurringConfig.id));
  });
});
