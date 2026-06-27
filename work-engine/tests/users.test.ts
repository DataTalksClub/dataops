import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { startLocal, stopLocal, getClient } from '../src/db/client';
import { createTables } from '../src/db/setup';
import { createUser, createUserWithId, getUser, listUsers } from '../src/db/users';

describe('DB — Users', () => {
  let client: DynamoDBDocumentClient;

  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
  });

  after(async () => {
    await stopLocal();
  });

  describe('createUser', () => {
    it('creates a user with auto-generated UUID and createdAt', async () => {
      const user = await createUser(client, { name: 'Test User', email: 'test@example.com' });

      assert.ok(user.id);
      assert.strictEqual(user.name, 'Test User');
      assert.strictEqual(user.email, 'test@example.com');
      assert.ok(user.createdAt);
      // Should not have PK/SK
      assert.strictEqual((user as any).PK, undefined);
      assert.strictEqual((user as any).SK, undefined);
    });
  });

  describe('createUserWithId', () => {
    it('creates a user with a specific ID', async () => {
      const id = '00000000-0000-0000-0000-000000000099';
      const user = await createUserWithId(client, id, { name: 'Specific', email: 'specific@example.com' });

      assert.strictEqual(user.id, id);
      assert.strictEqual(user.name, 'Specific');
      assert.strictEqual(user.email, 'specific@example.com');
      assert.ok(user.createdAt);
    });
  });

  describe('getUser', () => {
    it('retrieves an existing user by ID', async () => {
      const created = await createUser(client, { name: 'Get Me', email: 'getme@example.com' });
      const retrieved = await getUser(client, created.id);

      assert.ok(retrieved);
      assert.strictEqual(retrieved!.id, created.id);
      assert.strictEqual(retrieved!.name, 'Get Me');
      assert.strictEqual(retrieved!.email, 'getme@example.com');
    });

    it('returns null for a nonexistent user', async () => {
      const result = await getUser(client, 'nonexistent-id-999');
      assert.strictEqual(result, null);
    });
  });

  describe('listUsers', () => {
    it('returns an array of users', async () => {
      const users = await listUsers(client);
      assert.ok(Array.isArray(users));
      assert.ok(users.length > 0, 'Should have at least one user from previous tests');
    });

    it('each user has expected fields and no PK/SK', async () => {
      const users = await listUsers(client);
      for (const user of users) {
        assert.ok(user.id);
        assert.ok(user.name);
        assert.ok(user.email);
        assert.ok(user.createdAt);
        assert.strictEqual((user as any).PK, undefined);
        assert.strictEqual((user as any).SK, undefined);
      }
    });
  });
});
