import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getClient } from '../src/db/client';
import { startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createTables } from '../scripts/local-dynamodb';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { listUsers } from '../src/db/users';
import { TABLE_USERS } from '../src/db/tableNames';
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

  it('creates 4 users with expected names, emails, and stable IDs', async () => {
    const before = await listUsers(client);
    assert.strictEqual(before.length, 0);

    await seed();

    const after = await listUsers(client);
    assert.strictEqual(after.length, 4);

    const names = after.map((u) => u.name).sort();
    assert.deepStrictEqual(names, ['Alexey', 'Grace', 'Orin', 'Valeriia']);

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

    const orin = after.find((u) => u.name === 'Orin');
    assert.strictEqual(orin!.id, '00000000-0000-0000-0000-000000000004');
    assert.strictEqual(orin!.email, 'orin@datatalks.club');
    assert.strictEqual(orin!.role, 'operator');
  });

  it('is idempotent — running seed twice does not duplicate users', async () => {
    const beforeSecondRun = await listUsers(client);
    const countBefore = beforeSecondRun.length;
    assert.ok(countBefore > 0, 'Users should already exist from previous test');

    await seed();

    const afterSecondRun = await listUsers(client);
    assert.strictEqual(afterSecondRun.length, countBefore, 'User count should not change after second seed');
  });

  it('seeded users carry no password: local sign-in is the portal broker', async () => {
    const raw = await client.send(new ScanCommand({ TableName: TABLE_USERS }));
    for (const item of raw.Items || []) assert.strictEqual(item.passwordHash, undefined);
  });

  it('USERS constant has the expected stable UUIDs', () => {
    assert.strictEqual(USERS.length, 4);

    assert.strictEqual(USERS[0].id, '00000000-0000-0000-0000-000000000001');
    assert.strictEqual(USERS[0].name, 'Grace');
    assert.strictEqual(USERS[0].email, 'grace@datatalks.club');

    assert.strictEqual(USERS[1].id, '00000000-0000-0000-0000-000000000002');
    assert.strictEqual(USERS[1].name, 'Valeriia');
    assert.strictEqual(USERS[1].email, 'valeriia@datatalks.club');

    assert.strictEqual(USERS[2].id, '00000000-0000-0000-0000-000000000003');
    assert.strictEqual(USERS[2].name, 'Alexey');
    assert.strictEqual(USERS[2].email, 'alexey@datatalks.club');

    assert.strictEqual(USERS[3].id, '00000000-0000-0000-0000-000000000004');
    assert.strictEqual(USERS[3].name, 'Orin');
    assert.strictEqual(USERS[3].email, 'orin@datatalks.club');
    assert.strictEqual(USERS[3].role, 'operator');
  });
});
