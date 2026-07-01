import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { handler } from '../src/handler';
import { startLocal, stopLocal, getClient } from '../src/db/client';
import { createTables } from '../src/db/setup';
import { createUserWithId, getUser } from '../src/db/users';
import type { LambdaResponse } from '../src/types';

function invoke(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<LambdaResponse> {
  const event = {
    httpMethod: method,
    path,
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : null,
    headers: headers || {},
  };
  return handler(event, {});
}

describe('API — Users', () => {
  let client: DynamoDBDocumentClient;

  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
  });

  after(async () => {
    await stopLocal();
  });

  const ADMIN_ID = '00000000-0000-0000-0000-0000000000a1';
  const OPERATOR_ID = '00000000-0000-0000-0000-0000000000o1';
  const adminHeaders = { 'x-user-id': ADMIN_ID };
  const operatorHeaders = { 'x-user-id': OPERATOR_ID };
  const noHeaders = {};

  async function seedActor(id: string, role: string) {
    await createUserWithId(client, id, { name: id.slice(-2), email: `${id}@datatalks.club`, role });
  }

  // ---- Existing routes still work ----

  describe('Existing routes still work', () => {
    it('GET /api/health returns 200 with ok status', async () => {
      const res = await invoke('GET', '/api/health', undefined, {});
      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.deepStrictEqual(body, { status: 'ok' });
    });
  });

  // ---- GET /api/users (empty) ----

  describe('GET /api/users (empty)', () => {
    it('returns 200 with empty users array when no users exist', async () => {
      const res = await invoke('GET', '/api/users', undefined, {});
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers!['Content-Type'], 'application/json');

      const body = JSON.parse(res.body);
      assert.ok(Array.isArray(body.users));
      assert.strictEqual(body.users.length, 0);
    });
  });

  // ---- GET /api/users after creating users ----

  describe('GET /api/users (with users)', () => {
    before(async () => {
      await createUserWithId(client, '00000000-0000-0000-0000-000000000001', {
        name: 'Grace',
        email: 'grace@datatalks.club',
        role: 'admin',
      });
      await createUserWithId(client, '00000000-0000-0000-0000-000000000002', {
        name: 'Valeriia',
        email: 'valeriia@datatalks.club',
        role: 'admin',
      });
      await createUserWithId(client, '00000000-0000-0000-0000-000000000003', {
        name: 'Alexey',
        email: 'alexey@datatalks.club',
        role: 'admin',
      });
    });

    it('returns 200 with all seeded users', async () => {
      const res = await invoke('GET', '/api/users', undefined, {});
      assert.strictEqual(res.statusCode, 200);

      const body = JSON.parse(res.body);
      assert.ok(Array.isArray(body.users));
      // The 3 seeded users plus any created by earlier describe blocks.
      assert.ok(body.users.length >= 3);

      const names = body.users.map((u: any) => u.name).sort();
      assert.ok(names.includes('Alexey'));
      assert.ok(names.includes('Grace'));
      assert.ok(names.includes('Valeriia'));
    });

    it('each user has id, name, email, and createdAt fields', async () => {
      const res = await invoke('GET', '/api/users', undefined, {});
      const body = JSON.parse(res.body);

      for (const user of body.users) {
        assert.ok(user.id);
        assert.ok(user.name);
        assert.ok(user.email);
        assert.ok(user.createdAt);
        // passwordHash must never leak.
        assert.strictEqual(user.passwordHash, undefined);
      }
    });
  });

  // ---- GET /api/users/:id ----

  describe('GET /api/users/:id', () => {
    it('returns 200 with the user for a valid id', async () => {
      const res = await invoke('GET', '/api/users/00000000-0000-0000-0000-000000000001', undefined, {});
      assert.strictEqual(res.statusCode, 200);

      const body = JSON.parse(res.body);
      assert.ok(body.user);
      assert.strictEqual(body.user.id, '00000000-0000-0000-0000-000000000001');
      assert.strictEqual(body.user.name, 'Grace');
      assert.strictEqual(body.user.email, 'grace@datatalks.club');
      assert.ok(body.user.createdAt);
    });

    it('returns 404 for a nonexistent user', async () => {
      const res = await invoke('GET', '/api/users/nonexistent-id-999', undefined, {});
      assert.strictEqual(res.statusCode, 404);

      const body = JSON.parse(res.body);
      assert.strictEqual(body.error, 'User not found');
    });
  });

  // ---- POST /api/users (create) ----

  describe('POST /api/users (create)', () => {
    before(async () => {
      await seedActor(ADMIN_ID, 'admin');
      await seedActor(OPERATOR_ID, 'operator');
    });

    it('admin can create a user and passwordHash is never returned', async () => {
      const res = await invoke('POST', '/api/users', {
        name: 'New Person',
        email: 'new-person@datatalks.club',
        role: 'operator',
        password: 'supersecret',
      }, adminHeaders);
      assert.strictEqual(res.statusCode, 201, res.body);

      const body = JSON.parse(res.body);
      assert.ok(body.user);
      assert.ok(body.user.id);
      assert.strictEqual(body.user.name, 'New Person');
      assert.strictEqual(body.user.email, 'new-person@datatalks.club');
      assert.strictEqual(body.user.role, 'operator');
      assert.strictEqual(body.user.passwordHash, undefined);

      // Persisted with a passwordHash that is stripped on read.
      const stored = await getUser(client, body.user.id);
      assert.ok(stored);
    });

    it('defaults role to operator when omitted', async () => {
      const res = await invoke('POST', '/api/users', {
        name: 'No Role',
        email: 'no-role@datatalks.club',
      }, adminHeaders);
      assert.strictEqual(res.statusCode, 201, res.body);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.user.role, 'operator');
    });

    it('rejects create with 403 when actor is an operator', async () => {
      const res = await invoke('POST', '/api/users', {
        name: 'Should Fail',
        email: 'should-fail@datatalks.club',
      }, operatorHeaders);
      assert.strictEqual(res.statusCode, 403);
      assert.strictEqual(JSON.parse(res.body).error, 'Admin access required');
    });

    it('rejects create with 403 when no actor header is present', async () => {
      const res = await invoke('POST', '/api/users', {
        name: 'Anon',
        email: 'anon@datatalks.club',
      }, noHeaders);
      assert.strictEqual(res.statusCode, 403);
    });

    it('rejects create with 400 when name is missing', async () => {
      const res = await invoke('POST', '/api/users', {
        email: 'missing-name@datatalks.club',
      }, adminHeaders);
      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(JSON.parse(res.body).error, 'name is required');
    });

    it('rejects create with 400 when email is missing', async () => {
      const res = await invoke('POST', '/api/users', { name: 'Has Name' }, adminHeaders);
      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(JSON.parse(res.body).error, 'email is required');
    });

    it('rejects create with 400 for an invalid email', async () => {
      const res = await invoke('POST', '/api/users', {
        name: 'Bad Email',
        email: 'not-an-email',
      }, adminHeaders);
      assert.strictEqual(res.statusCode, 400);
      assert.ok(JSON.parse(res.body).error.includes('email'));
    });

    it('rejects create with 400 for an invalid role', async () => {
      const res = await invoke('POST', '/api/users', {
        name: 'Bad Role',
        email: 'bad-role@datatalks.club',
        role: 'superuser',
      }, adminHeaders);
      assert.strictEqual(res.statusCode, 400);
      assert.ok(JSON.parse(res.body).error.includes('role'));
    });

    it('rejects create with 400 when password is too short', async () => {
      const res = await invoke('POST', '/api/users', {
        name: 'Short Pw',
        email: 'short-pw@datatalks.club',
        password: '12',
      }, adminHeaders);
      assert.strictEqual(res.statusCode, 400);
      assert.ok(JSON.parse(res.body).error.includes('password'));
    });

    it('rejects create with 400 when body is missing', async () => {
      const res = await invoke('POST', '/api/users', undefined, adminHeaders);
      assert.strictEqual(res.statusCode, 400);
    });
  });

  // ---- PATCH /api/users/:id (edit / disable) ----

  describe('PATCH /api/users/:id (edit / disable)', () => {
    let targetId: string;

    before(async () => {
      const created = await invoke('POST', '/api/users', {
        name: 'Patch Target',
        email: 'patch-target@datatalks.club',
        role: 'operator',
      }, adminHeaders);
      assert.strictEqual(created.statusCode, 201, created.body);
      targetId = JSON.parse(created.body).user.id;
    });

    it('admin can edit a user name and role', async () => {
      const res = await invoke('PATCH', `/api/users/${targetId}`, {
        name: 'Renamed',
        role: 'admin',
      }, adminHeaders);
      assert.strictEqual(res.statusCode, 200, res.body);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.user.name, 'Renamed');
      assert.strictEqual(body.user.role, 'admin');
    });

    it('admin can disable a user', async () => {
      const res = await invoke('PATCH', `/api/users/${targetId}`, {
        disabled: true,
      }, adminHeaders);
      assert.strictEqual(res.statusCode, 200, res.body);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.user.disabled, true);
    });

    it('admin can re-enable a disabled user', async () => {
      const res = await invoke('PATCH', `/api/users/${targetId}`, {
        disabled: false,
      }, adminHeaders);
      assert.strictEqual(res.statusCode, 200, res.body);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.user.disabled, false);
    });

    it('admin can reset a password', async () => {
      const res = await invoke('PATCH', `/api/users/${targetId}`, {
        password: 'newpassword',
      }, adminHeaders);
      assert.strictEqual(res.statusCode, 200, res.body);
      assert.strictEqual(JSON.parse(res.body).user.passwordHash, undefined);
    });

    it('rejects edit with 403 when actor is an operator', async () => {
      const res = await invoke('PATCH', `/api/users/${targetId}`, {
        name: 'Operator Edit',
      }, operatorHeaders);
      assert.strictEqual(res.statusCode, 403);
    });

    it('rejects edit with 404 for a nonexistent user', async () => {
      const res = await invoke('PATCH', '/api/users/does-not-exist-999', {
        name: 'Ghost',
      }, adminHeaders);
      assert.strictEqual(res.statusCode, 404);
    });

    it('rejects edit with 400 for an invalid role', async () => {
      const res = await invoke('PATCH', `/api/users/${targetId}`, {
        role: 'wizard',
      }, adminHeaders);
      assert.strictEqual(res.statusCode, 400);
    });

    it('rejects edit with 400 when disabled is not a boolean', async () => {
      const res = await invoke('PATCH', `/api/users/${targetId}`, {
        disabled: 'yes',
      }, adminHeaders);
      assert.strictEqual(res.statusCode, 400);
    });

    it('rejects edit with 400 when no valid fields are provided', async () => {
      const res = await invoke('PATCH', `/api/users/${targetId}`, {
        id: 'cannot-change',
        createdAt: 'cannot-change',
      }, adminHeaders);
      assert.strictEqual(res.statusCode, 400);
    });
  });

  describe('Method not allowed', () => {
    it('returns 405 for PUT /api/users (collection)', async () => {
      const res = await invoke('PUT', '/api/users', undefined, {});
      assert.strictEqual(res.statusCode, 405);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.error, 'Method not allowed');
    });

    it('returns 405 for DELETE /api/users', async () => {
      const res = await invoke('DELETE', '/api/users', undefined, {});
      assert.strictEqual(res.statusCode, 405);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.error, 'Method not allowed');
    });

    it('returns 405 for DELETE /api/users/:id', async () => {
      const res = await invoke('DELETE', '/api/users/00000000-0000-0000-0000-000000000001', undefined, {});
      assert.strictEqual(res.statusCode, 405);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.error, 'Method not allowed');
    });
  });

  // ---- Content-Type header ----

  describe('Content-Type header', () => {
    it('all user API responses include Content-Type: application/json', async () => {
      const res200 = await invoke('GET', '/api/users', undefined, {});
      assert.strictEqual(res200.headers!['Content-Type'], 'application/json');

      const res404 = await invoke('GET', '/api/users/nonexistent', undefined, {});
      assert.strictEqual(res404.headers!['Content-Type'], 'application/json');

      const res405 = await invoke('DELETE', '/api/users', undefined, {});
      assert.strictEqual(res405.headers!['Content-Type'], 'application/json');
    });
  });
});
