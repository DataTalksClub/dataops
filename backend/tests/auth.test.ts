import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

import { getClient } from '../src/db/client';
import { startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createTables } from '../scripts/local-dynamodb';
import { createBrowserSession, getSession, deleteSession } from '../src/db/sessions';
import { createApiToken } from '../src/db/apiTokens';
import { humanBearer } from './helpers/human-bearer';
import { TABLE_SESSIONS } from '../src/db/tableNames';
import { createUserWithId } from '../src/db/users';

describe('Sessions DB layer', () => {
  let client: DynamoDBDocumentClient;

  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
  });

  after(async () => {
    await stopLocal();
  });

  const newSession = (c: DynamoDBDocumentClient, userId: string) => createBrowserSession(c, userId, { lifetimeSeconds: 3600 });

  it('createBrowserSession returns a session with token, userId, createdAt', async () => {
    const session = await newSession(client, 'user-123');

    assert.ok(session.token, 'should have token');
    assert.strictEqual(session.userId, 'user-123');
    assert.ok(session.createdAt, 'should have createdAt');
    assert.strictEqual((session as any).PK, undefined, 'should not expose PK');
    assert.strictEqual((session as any).SK, undefined, 'should not expose SK');
  });

  it('getSession returns the session by token', async () => {
    const created = await newSession(client, 'user-456');
    const retrieved = await getSession(client, created.token);

    assert.ok(retrieved, 'should find the session');
    assert.strictEqual(retrieved!.token, created.token);
    assert.strictEqual(retrieved!.userId, 'user-456');
    assert.ok(retrieved!.createdAt);
  });

  it('getSession returns null for nonexistent token', async () => {
    const result = await getSession(client, 'nonexistent-token-xyz');
    assert.strictEqual(result, null);
  });

  it('getSession refuses a session stored without expiresAt', async () => {
    const token = 'unbounded-session-token';
    await client.send(new PutCommand({
      TableName: TABLE_SESSIONS,
      Item: { PK: `SESSION#${token}`, SK: `SESSION#${token}`, token, userId: 'user-000', createdAt: new Date().toISOString() },
    }));
    assert.strictEqual(await getSession(client, token), null);
  });

  it('deleteSession removes the session', async () => {
    const created = await newSession(client, 'user-789');

    // Verify it exists
    const before = await getSession(client, created.token);
    assert.ok(before, 'session should exist before delete');

    // Delete it
    await deleteSession(client, created.token);

    // Verify it's gone
    const after = await getSession(client, created.token);
    assert.strictEqual(after, null, 'session should not exist after delete');
  });

  it('each session has a unique token (UUID)', async () => {
    const s1 = await newSession(client, 'user-111');
    const s2 = await newSession(client, 'user-111');

    assert.notStrictEqual(s1.token, s2.token, 'each session should have unique token');
  });
});

describe('API — Auth', () => {
  let handler: typeof import('../src/handler').handler;
  let client: DynamoDBDocumentClient;
  const graceId = '00000000-0000-0000-0000-000000000001';
  const disabledId = '00000000-0000-0000-0000-0000000000d1';

  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);

    const mod = await import('../src/handler');
    handler = mod.handler;

    // Warm up
    await handler({ httpMethod: 'GET', path: '/api/health' }, {});

    await createUserWithId(client, graceId, {
      name: 'Grace',
      email: 'grace@datatalks.club',
      role: 'admin',
    });
    await createUserWithId(client, disabledId, {
      name: 'Disabled',
      email: 'disabled@example.test',
      role: 'operator',
      disabled: true,
    });
  });

  after(async () => {
    await stopLocal();
  });

  function invoke(method: string, path: string, body?: unknown, token?: string) {
    const headers: Record<string, string> = {};
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    const event = {
      httpMethod: method,
      path,
      headers,
      body: body !== undefined ? JSON.stringify(body) : null,
    };
    return handler(event, {});
  }

  // Sign-in is SSO in the browser and the device flow for the CLI; a human
  // bearer is a shared-issuer JWT, never a password or a session token.
  async function signedInToken(): Promise<string> {
    return humanBearer(client, graceId);
  }

  it('has no password login', async () => {
    const res = await invoke('POST', '/api/auth/login', { email: 'grace@datatalks.club', password: '111' });
    assert.notStrictEqual(res.statusCode, 200);
    assert.strictEqual(JSON.parse(res.body || '{}').token, undefined);
  });

  describe('GET /api/me', () => {
    it('returns 401 without token', async () => {
      const res = await invoke('GET', '/api/me');
      assert.strictEqual(res.statusCode, 401);
    });

    it('returns 200 with user for valid token', async () => {
      const meRes = await invoke('GET', '/api/me', undefined, await signedInToken());
      assert.strictEqual(meRes.statusCode, 200);
      const body = JSON.parse(meRes.body);
      assert.ok(body.user);
      assert.strictEqual(body.user.id, graceId);
    });

    it('returns 401 for invalid token', async () => {
      const res = await invoke('GET', '/api/me', undefined, 'invalid-token-xyz');
      assert.strictEqual(res.statusCode, 401);
    });
  });

  describe('browser session token presented as a bearer', () => {
    // A browser session authenticates only as the HttpOnly portal cookie. The
    // same opaque value replayed as `Authorization: Bearer` must not be a second
    // auth path, least of all for a disabled account.
    const savedSkipAuth = process.env.SKIP_AUTH;
    before(() => { process.env.SKIP_AUTH = 'false'; });
    after(() => {
      if (savedSkipAuth === undefined) delete process.env.SKIP_AUTH; else process.env.SKIP_AUTH = savedSkipAuth;
    });

    for (const [label, userId] of [['an enabled user', graceId], ['a disabled user', disabledId]] as const) {
      it(`is rejected for ${label} on /api/me and protected routes`, async () => {
        const session = await createBrowserSession(client, userId, { lifetimeSeconds: 3600 });
        assert.ok(await getSession(client, session.token), 'the browser session itself is valid');
        for (const path of ['/api/me', '/api/notifications', '/api/files', '/api/cards', '/api/bookkeeping/transactions']) {
          const res = await invoke('GET', path, undefined, session.token);
          assert.strictEqual(res.statusCode, 401, `${path} must refuse a session bearer`);
        }
      });
    }

    it('bearer logout does not revoke a browser session', async () => {
      const session = await createBrowserSession(client, graceId, { lifetimeSeconds: 3600 });
      const res = await invoke('POST', '/api/auth/logout', undefined, session.token);
      assert.strictEqual(res.statusCode, 204);
      assert.ok(await getSession(client, session.token), 'only the cookie logout ends a browser session');
    });
  });

  describe('POST /api/auth/logout', () => {
    it('revokes an API token (subsequent /api/me returns 401)', async () => {
      const { token } = await createApiToken(client, { userId: graceId, issuedBy: graceId, label: 'logout test', scopes: ['cards:write'] });
      const meBeforeRes = await invoke('GET', '/api/me', undefined, token);
      assert.strictEqual(meBeforeRes.statusCode, 200);

      const logoutRes = await invoke('POST', '/api/auth/logout', undefined, token);
      assert.strictEqual(logoutRes.statusCode, 204);

      const meAfterRes = await invoke('GET', '/api/me', undefined, token);
      assert.strictEqual(meAfterRes.statusCode, 401);
    });

    it('logout without token returns 204 (graceful)', async () => {
      const res = await invoke('POST', '/api/auth/logout');
      assert.strictEqual(res.statusCode, 204);
    });
  });

  describe('Auth middleware', () => {
    it('GET /api/health is exempt from auth (no token needed)', async () => {
      const res = await invoke('GET', '/api/health');
      assert.strictEqual(res.statusCode, 200);
    });

    it('GET / is exempt from auth (no token needed)', async () => {
      const res = await invoke('GET', '/');
      assert.strictEqual(res.statusCode, 200);
      assert.ok(res.headers?.['Content-Type']?.includes('text/html'));
    });
  });
});

describe('Per-user notifications', () => {
  let client: DynamoDBDocumentClient;

  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
  });

  after(async () => {
    await stopLocal();
  });

  it('listUndismissedNotifications filters by userId when provided', async () => {
    const { createNotification, listUndismissedNotifications } = await import('../src/db/notifications');

    const graceId = 'grace-id-001';
    const valeriiId = 'valeriia-id-002';

    // Create one notification for Grace
    const graceNotif = await createNotification(client, {
      message: 'Grace-specific notification',
      userId: graceId,
    });

    // Create one notification for Valeriia
    const valeriaNotif = await createNotification(client, {
      message: 'Valeriia-specific notification',
      userId: valeriiId,
    });

    // Create a global notification (no userId)
    const globalNotif = await createNotification(client, {
      message: 'Global notification (no userId)',
    });

    // Grace should see her notification and global
    const graceNotifs = await listUndismissedNotifications(client, graceId);
    const graceIds = graceNotifs.map((n) => n.id);
    assert.ok(graceIds.includes(graceNotif.id), 'Grace should see her notification');
    assert.ok(graceIds.includes(globalNotif.id), 'Grace should see global notification');
    assert.ok(!graceIds.includes(valeriaNotif.id), 'Grace should NOT see Valeriia notification');

    // Valeriia should see her notification and global
    const valeriaNotifs = await listUndismissedNotifications(client, valeriiId);
    const valeriaIds = valeriaNotifs.map((n) => n.id);
    assert.ok(valeriaIds.includes(valeriaNotif.id), 'Valeriia should see her notification');
    assert.ok(valeriaIds.includes(globalNotif.id), 'Valeriia should see global notification');
    assert.ok(!valeriaIds.includes(graceNotif.id), 'Valeriia should NOT see Grace notification');
  });

  it('listUndismissedNotifications returns all when no userId provided', async () => {
    const { createNotification, listUndismissedNotifications } = await import('../src/db/notifications');

    // All notifications from this test share the same DB
    const notifs = await listUndismissedNotifications(client);
    // Should include all 3 from previous test
    assert.ok(notifs.length >= 3, 'should return all notifications when no userId filter');
  });
});
