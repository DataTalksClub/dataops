import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { handler } from '../src/handler';
import { startLocal, stopLocal, getClient } from '../src/db/client';
import { createTables } from '../src/db/setup';
import { createUserWithId } from '../src/db/users';
import type { LambdaResponse } from '../src/types';

function invoke(method: string, path: string, body?: unknown): Promise<LambdaResponse> {
  const event = {
    httpMethod: method,
    path,
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : null,
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

  // ---- Existing routes still work ----

  describe('Existing routes still work', () => {
    it('GET /api/health returns 200 with ok status', async () => {
      const res = await invoke('GET', '/api/health');
      assert.strictEqual(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.deepStrictEqual(body, { status: 'ok' });
    });
  });

  // ---- GET /api/users (empty) ----

  describe('GET /api/users (empty)', () => {
    it('returns 200 with empty users array when no users exist', async () => {
      const res = await invoke('GET', '/api/users');
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
      });
      await createUserWithId(client, '00000000-0000-0000-0000-000000000002', {
        name: 'Valeriia',
        email: 'valeriia@datatalks.club',
      });
      await createUserWithId(client, '00000000-0000-0000-0000-000000000003', {
        name: 'Alexey',
        email: 'alexey@datatalks.club',
      });
    });

    it('returns 200 with all seeded users', async () => {
      const res = await invoke('GET', '/api/users');
      assert.strictEqual(res.statusCode, 200);

      const body = JSON.parse(res.body);
      assert.ok(Array.isArray(body.users));
      assert.strictEqual(body.users.length, 3);

      const names = body.users.map((u: any) => u.name).sort();
      assert.deepStrictEqual(names, ['Alexey', 'Grace', 'Valeriia']);
    });

    it('each user has id, name, email, and createdAt fields', async () => {
      const res = await invoke('GET', '/api/users');
      const body = JSON.parse(res.body);

      for (const user of body.users) {
        assert.ok(user.id);
        assert.ok(user.name);
        assert.ok(user.email);
        assert.ok(user.createdAt);
      }
    });
  });

  // ---- GET /api/users/:id ----

  describe('GET /api/users/:id', () => {
    it('returns 200 with the user for a valid id', async () => {
      const res = await invoke('GET', '/api/users/00000000-0000-0000-0000-000000000001');
      assert.strictEqual(res.statusCode, 200);

      const body = JSON.parse(res.body);
      assert.ok(body.user);
      assert.strictEqual(body.user.id, '00000000-0000-0000-0000-000000000001');
      assert.strictEqual(body.user.name, 'Grace');
      assert.strictEqual(body.user.email, 'grace@datatalks.club');
      assert.ok(body.user.createdAt);
    });

    it('returns 404 for a nonexistent user', async () => {
      const res = await invoke('GET', '/api/users/nonexistent-id-999');
      assert.strictEqual(res.statusCode, 404);

      const body = JSON.parse(res.body);
      assert.strictEqual(body.error, 'User not found');
    });
  });

  // ---- Method not allowed ----

  describe('Method not allowed', () => {
    it('returns 405 for POST /api/users', async () => {
      const res = await invoke('POST', '/api/users');
      assert.strictEqual(res.statusCode, 405);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.error, 'Method not allowed');
    });

    it('returns 405 for PUT /api/users', async () => {
      const res = await invoke('PUT', '/api/users');
      assert.strictEqual(res.statusCode, 405);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.error, 'Method not allowed');
    });

    it('returns 405 for DELETE /api/users', async () => {
      const res = await invoke('DELETE', '/api/users');
      assert.strictEqual(res.statusCode, 405);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.error, 'Method not allowed');
    });

    it('returns 405 for PUT /api/users/:id', async () => {
      const res = await invoke('PUT', '/api/users/00000000-0000-0000-0000-000000000001');
      assert.strictEqual(res.statusCode, 405);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.error, 'Method not allowed');
    });

    it('returns 405 for DELETE /api/users/:id', async () => {
      const res = await invoke('DELETE', '/api/users/00000000-0000-0000-0000-000000000001');
      assert.strictEqual(res.statusCode, 405);
      const body = JSON.parse(res.body);
      assert.strictEqual(body.error, 'Method not allowed');
    });
  });

  // ---- Content-Type header ----

  describe('Content-Type header', () => {
    it('all user API responses include Content-Type: application/json', async () => {
      const res200 = await invoke('GET', '/api/users');
      assert.strictEqual(res200.headers!['Content-Type'], 'application/json');

      const res404 = await invoke('GET', '/api/users/nonexistent');
      assert.strictEqual(res404.headers!['Content-Type'], 'application/json');

      const res405 = await invoke('DELETE', '/api/users');
      assert.strictEqual(res405.headers!['Content-Type'], 'application/json');
    });
  });
});
