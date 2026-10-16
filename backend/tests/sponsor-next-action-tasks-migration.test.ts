import { after, before, describe, it } from 'node:test';
import assert from 'node:assert';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getClient } from '../src/db/client';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createCrmRecord, getCrmRecord } from '../src/db/sponsorCrm';
import { getTask } from '../src/db/tasks';
import { createUserWithId } from '../src/db/users';
import { setDefaultAssignee } from '../src/db/workspaceSettings';
import { handler } from '../src/handler';
import { nextActionTaskId } from '../src/routes/sponsorNextActionTasksMigration';

const OWNER = 'synthetic-owner';
const DEFAULT = 'synthetic-default';

const migrate = async (body: unknown) => {
  const response = await handler({
    httpMethod: 'POST',
    path: '/api/admin/sponsor-next-action-tasks',
    body: JSON.stringify(body),
  }, {});
  return { status: response.statusCode, body: JSON.parse(response.body) };
};

describe('sponsor next action to Task migration', () => {
  let client: DynamoDBDocumentClient;
  const ids: Record<string, string> = {};

  before(async () => {
    client = await getClient(await startLocal());
    await createTables(client);
    process.env.IS_LOCAL = 'true';
    await createUserWithId(client, OWNER, { name: 'Synthetic Owner', email: 'owner@example.test', role: 'admin' });
    await createUserWithId(client, DEFAULT, { name: 'Synthetic Default', email: 'default@example.test', role: 'admin' });
    await setDefaultAssignee(client, { defaultAssigneeId: DEFAULT, expectedVersion: 0 });
    const company = (await createCrmRecord(client, 'organization', { displayName: 'Synthetic Co' })).item;
    const deal = (extra: Record<string, unknown>) => createCrmRecord(client, 'deal', { organizationId: company.id, status: 'agreed', ...extra });
    ids.owned = (await deal({ nextAction: { type: 'chase_payment', due: '2026-10-14', owner: OWNER, note: 'Chase the invoice' } })).item.id;
    ids.former = (await deal({ nextAction: { type: 'follow_up', due: '2026-10-20', owner: 'gone-user', note: '' } })).item.id;
    ids.placeholder = (await deal({ nextAction: { type: 'follow_up', due: '2026-11-15', owner: OWNER, note: 'Backfilled' } })).item.id;
    ids.none = (await deal({})).item.id;
  });

  after(async () => {
    await stopLocal();
    delete process.env.IS_LOCAL;
  });

  it('plans one Task per stored next action without writing anything', async () => {
    const plan = await migrate({ apply: false });
    assert.strictEqual(plan.status, 200);
    assert.strictEqual(plan.body.dealCount, 3);
    const owned = plan.body.plans.find((item: { dealId: string }) => item.dealId === ids.owned);
    assert.deepStrictEqual(owned.task, {
      id: nextActionTaskId(ids.owned),
      description: 'Chase the invoice',
      date: '2026-10-14',
      assigneeId: OWNER,
      subject: { type: 'sponsor-deal', id: ids.owned },
    });
    const former = plan.body.plans.find((item: { dealId: string }) => item.dealId === ids.former);
    assert.strictEqual(former.task.description, 'Follow up');
    assert.strictEqual(former.task.assigneeId, DEFAULT, 'an owner who is not an active member falls back to the default assignee');
    assert.strictEqual(await getTask(client, nextActionTaskId(ids.owned)), null);
    assert.ok((await getCrmRecord(client, 'deal', ids.owned))?.nextAction);
  });

  it('rejects overrides for deals without a next action', async () => {
    const response = await migrate({ apply: false, overrides: { [ids.none]: { description: 'x' } } });
    assert.strictEqual(response.status, 400);
  });

  it('creates the Tasks, applies overrides, removes the field and is safe to rerun', async () => {
    const overrides = { [ids.placeholder]: { description: 'Check the invoice was paid', date: '2026-11-16' } };
    const applied = await migrate({ apply: true, overrides });
    assert.strictEqual(applied.status, 200);
    assert.deepStrictEqual(applied.body.results.map((item: { status: string }) => item.status), ['applied', 'applied', 'applied']);

    const task = await getTask(client, nextActionTaskId(ids.placeholder));
    assert.strictEqual(task?.description, 'Check the invoice was paid');
    assert.strictEqual(task?.date, '2026-11-16');
    assert.strictEqual(task?.status, 'todo');
    assert.strictEqual(task?.cardId, undefined);
    assert.deepStrictEqual(task?.subject, { type: 'sponsor-deal', id: ids.placeholder });
    for (const id of [ids.owned, ids.former, ids.placeholder]) {
      assert.strictEqual((await getCrmRecord(client, 'deal', id))?.nextAction, undefined);
    }

    const rerun = await migrate({ apply: true });
    assert.strictEqual(rerun.status, 200);
    assert.strictEqual(rerun.body.dealCount, 0);
  });
});
