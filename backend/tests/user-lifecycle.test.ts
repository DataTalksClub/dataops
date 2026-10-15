/**
 * A person leaving the team: see their open work, hand it over, disable the
 * account (credentials revoked), then delete it, leaving only a name for the
 * history that cites them.
 *
 * All people here are synthetic (`example.test`).
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert';
import { GetCommand, ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { handler } from '../src/handler';
import { getClient } from '../src/db/client';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createCard, getCard } from '../src/db/cards';
import { templateLink } from './helpers/cardTemplate';
import { createApiToken, getApiToken } from '../src/db/cliAuth';
import { createRecurringConfig, generateRecurringTasks, getRecurringConfig } from '../src/db/recurring';
import { createSession, getSession } from '../src/db/sessions';
import { createCrmRecord, getCrmRecord } from '../src/db/sponsorCrm';
import { TABLE_AUDIT_EVENTS, TABLE_USERS } from '../src/db/tableNames';
import { createTask, getTask } from '../src/db/tasks';
import { createUserWithId, getUser, updateUser } from '../src/db/users';
import { getWorkspaceSettings, setDefaultAssignee } from '../src/db/workspaceSettings';
import { TeamDirectory } from '../src/identity/directory';
import { ALEXEY_USER_ID } from '../src/sponsorCrm/model';
import type { LambdaResponse } from '../src/types';

const ADMIN = 'ada-admin';
const SECOND_ADMIN = 'sam-admin';
const LEAVER = 'lee-leaver';
const HEIR = 'hal-heir';
const OPERATOR = 'oli-operator';

function invoke(method: string, path: string, actor: string, body?: unknown): Promise<LambdaResponse> {
  return handler({
    httpMethod: method,
    path,
    headers: { 'x-user-id': actor },
    body: body === undefined ? null : JSON.stringify(body),
  }, {});
}

const parsed = (response: LambdaResponse) => JSON.parse(response.body);

describe('user lifecycle: handover, disable, delete', () => {
  let client: DynamoDBDocumentClient;
  const ids: Record<string, string> = {};

  before(async () => {
    client = await getClient(await startLocal());
    await createTables(client);
    await createUserWithId(client, ADMIN, { name: 'Ada Admin', email: 'ada@example.test', role: 'admin' });
    await createUserWithId(client, SECOND_ADMIN, { name: 'Sam Admin', email: 'sam@example.test', role: 'admin' });
    await createUserWithId(client, LEAVER, { name: 'Lee Leaver', email: 'lee@example.test', role: 'operator' });
    await createUserWithId(client, HEIR, { name: 'Hal Heir', email: 'hal@example.test', role: 'operator' });
    await createUserWithId(client, OPERATOR, { name: 'Oli Operator', email: 'oli@example.test', role: 'operator' });

    ids.todo = (await createTask(client, { description: 'Open todo', date: '2026-10-20', assigneeId: LEAVER })).id;
    ids.waiting = (await createTask(client, {
      description: 'Open waiting', date: '2026-10-20', assigneeId: LEAVER, status: 'waiting',
      waitingFor: 'Vendor', followUpAt: '2026-10-22', comment: 'Asked',
    })).id;
    ids.done = (await createTask(client, {
      description: 'Done', date: '2026-10-01', assigneeId: LEAVER, status: 'done', completedBy: LEAVER,
    })).id;
    ids.card = (await createCard(client, { ...templateLink(), title: 'Owned card', ownerId: LEAVER })).id;
    ids.schedule = (await createRecurringConfig(client, {
      description: 'Weekly check', cronExpression: '0 9 * * 1', assigneeId: LEAVER,
    })).id;
    ids.organization = (await createCrmRecord(client, 'organization', { name: 'Acme', owner: LEAVER })).item.id;
    ids.deal = (await createCrmRecord(client, 'deal', {
      organizationId: ids.organization, status: 'open', owner: HEIR,
      nextAction: { type: 'follow_up', due: '2026-10-30', owner: LEAVER, note: '' },
    })).item.id;
    ids.lostDeal = (await createCrmRecord(client, 'deal', { organizationId: ids.organization, status: 'lost', owner: LEAVER })).item.id;
    await setDefaultAssignee(client, { defaultAssigneeId: LEAVER, expectedVersion: 0, actorId: ADMIN });
  });

  after(async () => {
    await stopLocal();
  });

  it('is admin only', async () => {
    for (const [method, path] of [
      ['GET', `/api/users/${LEAVER}/handover`],
      ['POST', `/api/users/${LEAVER}/reassign`],
      ['POST', `/api/users/${LEAVER}/disable`],
      ['POST', `/api/users/${LEAVER}/enable`],
      ['DELETE', `/api/users/${LEAVER}`],
    ]) {
      const response = await invoke(method, path, OPERATOR, {});
      assert.strictEqual(response.statusCode, 403, `${method} ${path}`);
    }
  });

  it('counts the open work a person holds, not their history', async () => {
    const response = await invoke('GET', `/api/users/${LEAVER}/handover`, ADMIN);
    assert.strictEqual(response.statusCode, 200, response.body);
    const summary = parsed(response);
    assert.deepStrictEqual(summary.openWork, { tasks: 2, cards: 1, schedules: 1, sponsorRecords: 2 });
    assert.strictEqual(summary.openTotal, 6);
    assert.strictEqual(summary.isDefaultAssignee, true);
    assert.strictEqual(summary.user.name, 'Lee Leaver');
  });

  it('refuses to delete an active account: disable first', async () => {
    const response = await invoke('DELETE', `/api/users/${LEAVER}`, ADMIN, { reassignTo: HEIR });
    assert.strictEqual(response.statusCode, 409);
    assert.strictEqual(parsed(response).code, 'disable_first');
    assert.ok(await getUser(client, LEAVER));
  });

  it('will not disable yourself or demote the last active admin', async () => {
    const self = await invoke('POST', `/api/users/${ADMIN}/disable`, ADMIN, {});
    assert.strictEqual(self.statusCode, 409);
    assert.strictEqual(parsed(self).code, 'self');

    // Another admin is the only one who could disable an admin, so the last
    // active admin can only be lost by a demotion.
    assert.strictEqual((await invoke('PATCH', `/api/users/${SECOND_ADMIN}`, ADMIN, { role: 'operator' })).statusCode, 200);
    try {
      const demote = await invoke('PATCH', `/api/users/${ADMIN}`, ADMIN, { role: 'operator' });
      assert.strictEqual(demote.statusCode, 409);
      assert.strictEqual(parsed(demote).code, 'last_admin');
    } finally {
      await updateUser(client, SECOND_ADMIN, { role: 'admin' });
    }
  });

  it('asks for a new default assignee and a recipient before disabling', async () => {
    const noDefault = await invoke('POST', `/api/users/${LEAVER}/disable`, ADMIN, { reassignTo: HEIR });
    assert.strictEqual(noDefault.statusCode, 409);
    assert.strictEqual(parsed(noDefault).code, 'default_assignee');

    const noRecipient = await invoke('POST', `/api/users/${LEAVER}/disable`, ADMIN, { newDefaultAssigneeId: HEIR });
    assert.strictEqual(noRecipient.statusCode, 409);
    assert.strictEqual(parsed(noRecipient).code, 'handover_required');
    assert.deepStrictEqual(parsed(noRecipient).openWork, { tasks: 2, cards: 1, schedules: 1, sponsorRecords: 2 });

    const toSelf = await invoke('POST', `/api/users/${LEAVER}/disable`, ADMIN, { reassignTo: LEAVER, newDefaultAssigneeId: HEIR });
    assert.strictEqual(toSelf.statusCode, 400);
    // Nothing changed on a refused request.
    assert.strictEqual((await getUser(client, LEAVER))?.disabled, undefined);
    assert.strictEqual((await getWorkspaceSettings(client)).defaultAssigneeId, LEAVER);
  });

  it('disables: new default, open work handed over, credentials revoked', async () => {
    const session = await createSession(client, LEAVER);
    const { token } = await createApiToken(client, { userId: LEAVER, label: 'laptop', source: 'manual' });

    const response = await invoke('POST', `/api/users/${LEAVER}/disable`, ADMIN, {
      reassignTo: HEIR,
      newDefaultAssigneeId: HEIR,
    });
    assert.strictEqual(response.statusCode, 200, response.body);
    const result = parsed(response);
    assert.strictEqual(result.user.disabled, true);
    assert.deepStrictEqual(result.moved, { tasks: 2, cards: 1, schedules: 1, sponsorRecords: 2 });
    assert.ok(result.revokedCredentials >= 2);

    assert.strictEqual((await getWorkspaceSettings(client)).defaultAssigneeId, HEIR);
    assert.strictEqual((await getTask(client, ids.todo))?.assigneeId, HEIR);
    assert.strictEqual((await getTask(client, ids.waiting))?.assigneeId, HEIR);
    assert.strictEqual((await getTask(client, ids.done))?.assigneeId, LEAVER, 'history is not rewritten');
    assert.strictEqual((await getCard(client, ids.card))?.ownerId, HEIR);
    assert.strictEqual((await getRecurringConfig(client, ids.schedule))?.assigneeId, HEIR);
    assert.strictEqual((await getCrmRecord(client, 'organization', ids.organization))?.owner, HEIR);
    assert.strictEqual(((await getCrmRecord(client, 'deal', ids.deal))?.nextAction as { owner: string }).owner, HEIR);
    assert.strictEqual((await getCrmRecord(client, 'deal', ids.lostDeal))?.owner, LEAVER, 'a lost deal is history');

    assert.strictEqual(await getSession(client, session.token), null);
    assert.strictEqual(await getApiToken(client, token), null);
    assert.strictEqual(parsed(await invoke('GET', `/api/users/${LEAVER}/handover`, ADMIN)).openTotal, 0);
  });

  it('reassigns on its own, and sends schedule work for a gone person to the default', async () => {
    // Work that lands on a disabled person (here written directly) is what
    // the standalone reassign and the delete safety check are for.
    ids.late = (await createTask(client, { description: 'Late', date: '2026-10-21', assigneeId: LEAVER })).id;
    const reassign = await invoke('POST', `/api/users/${LEAVER}/reassign`, ADMIN, { reassignTo: OPERATOR });
    assert.strictEqual(reassign.statusCode, 200, reassign.body);
    assert.deepStrictEqual(parsed(reassign).moved, { tasks: 1, cards: 0, schedules: 0, sponsorRecords: 0 });
    assert.strictEqual((await getTask(client, ids.late))?.assigneeId, OPERATOR);

    const toDisabled = await invoke('POST', `/api/users/${OPERATOR}/reassign`, ADMIN, { reassignTo: LEAVER });
    assert.strictEqual(toDisabled.statusCode, 400);
    assert.strictEqual(parsed(toDisabled).code, 'recipient_not_active');

    const schedule = await createRecurringConfig(client, {
      description: 'Still names Lee', cronExpression: '0 9 * * *', assigneeId: LEAVER,
    });
    const { generated } = await generateRecurringTasks(client, '2026-10-19', '2026-10-19');
    const fromSchedule = generated.find((task) => task.recurringConfigId === schedule.id);
    assert.strictEqual(fromSchedule?.assigneeId, HEIR, 'a disabled assignee gives way to the default');
  });

  it('deletes a disabled account, asking who takes anything still open', async () => {
    ids.stray = (await createTask(client, { description: 'Stray', date: '2026-10-22', assigneeId: LEAVER })).id;
    const ask = await invoke('DELETE', `/api/users/${LEAVER}`, ADMIN, {});
    assert.strictEqual(ask.statusCode, 409);
    assert.strictEqual(parsed(ask).code, 'handover_required');

    const response = await invoke('DELETE', `/api/users/${LEAVER}`, ADMIN, { reassignTo: HEIR });
    assert.strictEqual(response.statusCode, 200, response.body);
    assert.deepStrictEqual(parsed(response).deleted, { id: LEAVER, name: 'Lee Leaver' });
    assert.strictEqual((await getTask(client, ids.stray))?.assigneeId, HEIR);

    assert.strictEqual(await getUser(client, LEAVER), null);
    const list = parsed(await invoke('GET', '/api/users', ADMIN));
    assert.ok(!list.users.some((user: { id: string }) => user.id === LEAVER));
    assert.deepStrictEqual(
      list.formerUsers.map(({ id, name }: { id: string; name: string }) => ({ id, name })),
      [{ id: LEAVER, name: 'Lee Leaver' }],
    );
    const former = (await client.send(new GetCommand({ TableName: TABLE_USERS, Key: { PK: `FORMER#${LEAVER}`, SK: `FORMER#${LEAVER}` } }))).Item;
    assert.deepStrictEqual(Object.keys(former || {}).sort(), ['PK', 'SK', 'deletedAt', 'id', 'name'], 'only a name is kept');

    // History still reads as a person, never as an active member.
    const directory = new TeamDirectory(client);
    assert.deepStrictEqual(await directory.project(LEAVER), {
      id: LEAVER, name: 'Lee Leaver', role: null, active: false, disabled: false, available: false,
    });
    assert.ok(!(await directory.members()).some((member) => member.id === LEAVER));

    const audit = await client.send(new ScanCommand({ TableName: TABLE_AUDIT_EVENTS }));
    assert.ok((audit.Items || []).some((item) => item.action === 'user-deleted' && item.userId === LEAVER && item.actorId === ADMIN));

    const again = await invoke('DELETE', `/api/users/${LEAVER}`, ADMIN, {});
    assert.strictEqual(again.statusCode, 404);
  });

  it('refuses to delete someone the sponsor CRM still routes work to', async () => {
    await createUserWithId(client, ALEXEY_USER_ID, { name: 'Routed', email: 'routed@example.test', role: 'operator', disabled: true });
    const response = await invoke('DELETE', `/api/users/${ALEXEY_USER_ID}`, ADMIN, {});
    assert.strictEqual(response.statusCode, 409);
    assert.strictEqual(parsed(response).code, 'crm_routing');
  });

  it('re-enables a disabled account', async () => {
    await updateUser(client, OPERATOR, { disabled: true });
    const response = await invoke('POST', `/api/users/${OPERATOR}/enable`, ADMIN, {});
    assert.strictEqual(response.statusCode, 200, response.body);
    assert.strictEqual(parsed(response).user.disabled, false);
  });
});
