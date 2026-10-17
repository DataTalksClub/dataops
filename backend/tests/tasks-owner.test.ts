import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';

import { getClient } from '../src/db/client';
import { startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createTables } from '../scripts/local-dynamodb';
import { putEmptyTemplate } from './helpers/cardTemplate';
import { createUserWithId } from '../src/db/users';

describe('API — owner references by id, email, or name', () => {
  let port: number;
  let handler: typeof import('../src/handler').handler;

  const ORIN_ID = 'test-orin-id';
  const ANN_ID = 'test-ann-id';

  before(async () => {
    port = await startLocal();
    const client = await getClient(port);
    await createTables(client);
    await putEmptyTemplate(client);
    await createUserWithId(client, ORIN_ID, { name: 'Orin', email: 'orin@datatalks.club', role: 'operator' });
    await createUserWithId(client, ANN_ID, { name: 'Ann', email: 'ann@datatalks.club', role: 'operator' });
    process.env.IS_LOCAL = 'true';

    const mod = await import('../src/handler');
    handler = mod.handler;

    const warmUp = await handler({ httpMethod: 'GET', path: '/api/health' }, {});
    assert.strictEqual(warmUp.statusCode, 200);
  });

  after(async () => {
    await stopLocal();
    delete process.env.IS_LOCAL;
  });

  async function createTask(description: string, assigneeId: string) {
    const res = await handler({
      httpMethod: 'POST',
      path: '/api/tasks',
      body: JSON.stringify({ description, date: '2026-03-10', assigneeId }),
    }, {});
    assert.strictEqual(res.statusCode, 201);
    return JSON.parse(res.body);
  }

  async function listOwner(owner: string, actorId: string = ANN_ID) {
    const res = await handler({
      httpMethod: 'GET',
      path: '/api/tasks',
      headers: { 'x-user-id': actorId },
      queryStringParameters: { owner, status: 'todo' },
    }, {});
    return { status: res.statusCode, body: JSON.parse(res.body) };
  }

  it('lists Orin\'s work by id, email, local part, or name', async () => {
    const task = await createTask('Orin queue item', ORIN_ID);
    await createTask('Ann queue item', ANN_ID);

    for (const owner of [ORIN_ID, 'orin@datatalks.club', 'ORIN@DATATALKS.CLUB', 'orin', 'Orin']) {
      const { status, body } = await listOwner(owner);
      assert.strictEqual(status, 200, `owner=${owner}`);
      assert.deepStrictEqual(body.tasks.map((item: { id: string }) => item.id), [task.id]);
      assert.strictEqual(body.owner.id, ORIN_ID);
    }
  });

  it('an operator sees their own queue through owner=me', async () => {
    const task = await createTask('Orin self item', ORIN_ID);
    const { status, body } = await listOwner('me', ORIN_ID);
    assert.strictEqual(status, 200);
    assert.ok(body.tasks.some((item: { id: string }) => item.id === task.id));
  });

  it('tasks created without an assignee default to the calling operator', async () => {
    const res = await handler({
      httpMethod: 'POST',
      path: '/api/tasks',
      headers: { 'x-user-id': ORIN_ID },
      body: JSON.stringify({ description: 'Orin creates', date: '2026-03-10' }),
    }, {});
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(JSON.parse(res.body).assigneeId, ORIN_ID);
  });

  it('an unknown reference still answers empty with honest availability', async () => {
    const { status, body } = await listOwner('no-such-person');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body.tasks, []);
    assert.strictEqual(body.owner.available, false);
  });

  it('an ambiguous name is rejected with the candidates', async () => {
    const client = await getClient(port);
    await createUserWithId(client, 'test-orin-duplicate', {
      name: 'Orin', email: 'orin2@datatalks.club', role: 'operator',
    });
    const { status, body } = await listOwner('orin');
    assert.strictEqual(status, 400);
    assert.match(body.error, /matches 2 team members/);
  });
});
