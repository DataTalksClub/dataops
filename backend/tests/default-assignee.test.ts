/**
 * The workspace default assignee: an admin-only, versioned setting naming the
 * team member who receives new work no one else is named for. Real bearer
 * identity, because who may change it is part of the contract.
 *
 * All people here are synthetic (`example.test`).
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getClient } from '../src/db/client';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createSession } from '../src/db/sessions';
import { createUserWithId, listUsers, updateUser } from '../src/db/users';
import { resolveDefaultAssigneeId } from '../src/db/workspaceSettings';
import { route } from '../src/router';
import type { LambdaResponse } from '../src/types';

const ADMIN = 'dana-admin';
const OPERATOR = 'oli-operator';
const TEAMMATE = 'tess-teammate';
const PATH = '/api/team-members/default-assignee';

describe('workspace default assignee', () => {
  let client: DynamoDBDocumentClient;
  const sessions: Record<string, string> = {};
  let savedSkipAuth: string | undefined;

  function invoke(method: string, path: string, bearer: string, body?: unknown): Promise<LambdaResponse> {
    return route({
      httpMethod: method,
      path,
      queryStringParameters: null,
      headers: { authorization: `Bearer ${bearer}` },
      body: body === undefined ? null : JSON.stringify(body),
    }, client);
  }

  const parsed = (response: LambdaResponse) => JSON.parse(response.body);

  before(async () => {
    savedSkipAuth = process.env.SKIP_AUTH;
    process.env.SKIP_AUTH = 'false';
    client = await getClient(await startLocal());
    await createTables(client);
    await createUserWithId(client, ADMIN, { name: 'Dana Admin', email: 'dana@example.test', role: 'admin' });
    await createUserWithId(client, OPERATOR, { name: 'Oli Operator', email: 'oli@example.test', role: 'operator' });
    await createUserWithId(client, TEAMMATE, { name: 'Tess Teammate', email: 'tess@example.test', role: 'operator' });
    for (const id of [ADMIN, OPERATOR, TEAMMATE]) sessions[id] = (await createSession(client, id)).token;
  });

  after(async () => {
    if (savedSkipAuth === undefined) delete process.env.SKIP_AUTH;
    else process.env.SKIP_AUTH = savedSkipAuth;
    await stopLocal();
  });

  it('starts unset', async () => {
    const response = await invoke('GET', PATH, sessions[OPERATOR]);
    assert.strictEqual(response.statusCode, 200);
    assert.deepStrictEqual(parsed(response), { defaultAssigneeId: null, version: 0 });
    assert.strictEqual(parsed(await invoke('GET', '/api/team-members', sessions[OPERATOR])).defaultAssigneeId, null);
    assert.strictEqual(await resolveDefaultAssigneeId(client), null);
  });

  it('only an admin may change it', async () => {
    const response = await invoke('PUT', PATH, sessions[OPERATOR], { defaultAssigneeId: TEAMMATE, expectedVersion: 0 });
    assert.strictEqual(response.statusCode, 403);
    assert.strictEqual(parsed(await invoke('GET', PATH, sessions[ADMIN])).version, 0);
  });

  it('must name an active team member', async () => {
    for (const defaultAssigneeId of ['nobody-here', '', 42]) {
      const response = await invoke('PUT', PATH, sessions[ADMIN], { defaultAssigneeId, expectedVersion: 0 });
      assert.strictEqual(response.statusCode, 400, String(defaultAssigneeId));
    }
  });

  it('an admin sets it, versioned, and the directory reports it', async () => {
    const saved = await invoke('PUT', PATH, sessions[ADMIN], { defaultAssigneeId: TEAMMATE, expectedVersion: 0 });
    assert.strictEqual(saved.statusCode, 200, saved.body);
    assert.strictEqual(parsed(saved).defaultAssigneeId, TEAMMATE);
    assert.strictEqual(parsed(saved).version, 1);
    assert.strictEqual(parsed(saved).updatedBy, ADMIN);

    const directory = parsed(await invoke('GET', '/api/team-members', sessions[OPERATOR]));
    assert.strictEqual(directory.defaultAssigneeId, TEAMMATE);
    assert.ok(directory.teamMembers.some((member: { id: string }) => member.id === TEAMMATE));
    assert.strictEqual(await resolveDefaultAssigneeId(client), TEAMMATE);
    // The settings record never appears as an account.
    assert.deepStrictEqual((await listUsers(client)).map((user) => user.id).sort(), [ADMIN, OPERATOR, TEAMMATE].sort());
  });

  it('rejects a stale write', async () => {
    const response = await invoke('PUT', PATH, sessions[ADMIN], { defaultAssigneeId: OPERATOR, expectedVersion: 0 });
    assert.strictEqual(response.statusCode, 409);
    assert.strictEqual(parsed(response).current.defaultAssigneeId, TEAMMATE);
  });

  it('a disabled default assigns no one', async () => {
    await updateUser(client, TEAMMATE, { disabled: true });
    assert.strictEqual(await resolveDefaultAssigneeId(client), null);
    await updateUser(client, TEAMMATE, { disabled: false });
  });

  it('can be cleared', async () => {
    const response = await invoke('PUT', PATH, sessions[ADMIN], { defaultAssigneeId: null, expectedVersion: 1 });
    assert.strictEqual(response.statusCode, 200, response.body);
    assert.strictEqual(parsed(response).defaultAssigneeId, null);
    assert.strictEqual(await resolveDefaultAssigneeId(client), null);
  });
});
