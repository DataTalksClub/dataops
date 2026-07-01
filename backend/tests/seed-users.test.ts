import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { startLocal, stopLocal, getClient } from '../src/db/client';
import { createTables } from '../src/db/setup';
import { listUsers, getUserByEmail } from '../src/db/users';
import { seed, USERS } from '../scripts/seed-users';

describe('Seed users script', () => {
  let client: DynamoDBDocumentClient;

  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
  });

  after(async () => {
    await stopLocal();
  });

  it('creates 3 users with expected names, emails, and stable IDs', async () => {
    const before = await listUsers(client);
    assert.strictEqual(before.length, 0);

    await seed();

    const after = await listUsers(client);
    assert.strictEqual(after.length, 3);

    const names = after.map((u) => u.name).sort();
    assert.deepStrictEqual(names, ['Alexey', 'Grace', 'Valeriia']);

    // Verify stable IDs
    const grace = after.find((u) => u.name === 'Grace');
    assert.strictEqual(grace!.id, '00000000-0000-0000-0000-000000000001');
    assert.strictEqual(grace!.email, 'grace@datatalks.club');

    const valeriia = after.find((u) => u.name === 'Valeriia');
    assert.strictEqual(valeriia!.id, '00000000-0000-0000-0000-000000000002');
    assert.strictEqual(valeriia!.email, 'valeriia@datatalks.club');

    const alexey = after.find((u) => u.name === 'Alexey');
    assert.strictEqual(alexey!.id, '00000000-0000-0000-0000-000000000003');
    assert.strictEqual(alexey!.email, 'alexey@datatalks.club');
  });

  it('is idempotent — running seed twice does not duplicate users', async () => {
    const beforeSecondRun = await listUsers(client);
    const countBefore = beforeSecondRun.length;
    assert.ok(countBefore > 0, 'Users should already exist from previous test');

    await seed();

    const afterSecondRun = await listUsers(client);
    assert.strictEqual(afterSecondRun.length, countBefore, 'User count should not change after second seed');
  });

  it('seeded users have passwordHash set (not returned via cleanItem)', async () => {
    // getUserByEmail returns raw user including passwordHash
    const grace = await getUserByEmail(client, 'grace@datatalks.club');
    assert.ok(grace, 'Grace should exist');
    assert.ok(grace!.passwordHash, 'Grace should have passwordHash');
    assert.ok(grace!.passwordHash!.length === 64, 'SHA-256 hex should be 64 chars');
  });

  it('cleanItem strips passwordHash from user objects returned via listUsers', async () => {
    const users = await listUsers(client);
    for (const user of users) {
      assert.strictEqual((user as any).passwordHash, undefined, 'passwordHash must not appear in cleanItem results');
    }
  });

  it('USERS constant has the expected stable UUIDs', () => {
    assert.strictEqual(USERS.length, 3);

    assert.strictEqual(USERS[0].id, '00000000-0000-0000-0000-000000000001');
    assert.strictEqual(USERS[0].name, 'Grace');
    assert.strictEqual(USERS[0].email, 'grace@datatalks.club');

    assert.strictEqual(USERS[1].id, '00000000-0000-0000-0000-000000000002');
    assert.strictEqual(USERS[1].name, 'Valeriia');
    assert.strictEqual(USERS[1].email, 'valeriia@datatalks.club');

    assert.strictEqual(USERS[2].id, '00000000-0000-0000-0000-000000000003');
    assert.strictEqual(USERS[2].name, 'Alexey');
    assert.strictEqual(USERS[2].email, 'alexey@datatalks.club');
  });
});
