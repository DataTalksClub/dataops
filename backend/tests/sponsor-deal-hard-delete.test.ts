import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { PutCommand, ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { handler } from '../src/handler';
import { getClient } from '../src/db/client';
import { TABLE_SPONSOR_CRM, TABLE_TASKS } from '../src/db/tableNames';
import { createUserWithId } from '../src/db/users';
import { createSession } from '../src/db/sessions';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createCrmRecord, getCrmRecord } from '../src/db/sponsorCrm';

const invoke = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const url = new URL(path, 'http://crm.test');
  return handler({ httpMethod: method, path: url.pathname, headers,
    queryStringParameters: Object.fromEntries(url.searchParams), body: body === undefined ? null : JSON.stringify(body) }, {});
};
const data = (response: any) => JSON.parse(response.body);
const remove = (id: string, query = '') => {
  const params = new URLSearchParams(query.replace(/^&/, ''));
  const expectedVersion = params.get('expectedVersion');
  return invoke('POST', `/api/sponsor-crm/deals/${id}/delete`, {
    withDeliverables: false,
    apply: true,
    ...(expectedVersion ? { expectedVersion: Number(expectedVersion) } : {}),
  });
};
const removeWithDeliverables = (id: string, body: Record<string, unknown> = {}) =>
  invoke('POST', `/api/sponsor-crm/deals/${id}/delete`, { withDeliverables: true, ...body });

describe('CRM deal hard delete', () => {
  let client: DynamoDBDocumentClient;
  before(async () => { client = await getClient(await startLocal()); await createTables(client); });
  after(stopLocal);

  const deal = async () => {
    const org = data(await invoke('POST', '/api/sponsor-crm/organizations', { displayName: 'Synthetic deal fixture' }));
    const created = await invoke('POST', '/api/sponsor-crm/deals', { organizationId: org.id, status: 'open', title: 'Synthetic deal' });
    assert.equal(created.statusCode, 201, created.body);
    return { org, deal: data(created) };
  };
  const put = (table: string, Item: Record<string, unknown>) => client.send(new PutCommand({ TableName: table, Item }));
  const rows = async (table: string) => (await client.send(new ScanCommand({ TableName: table }))).Items!;
  const refuses = async (id: string, pattern: RegExp) => {
    const result = await remove(id);
    assert.equal(result.statusCode, 409, result.body); assert.match(data(result).error, pattern);
    assert.equal((await invoke('GET', `/api/sponsor-crm/deals/${id}`)).statusCode, 200);
  };

  it('deletes a deal with history, notes, tasks and message index, leaving no orphans', async () => {
    const { org, deal: target } = await deal();
    const other = (await deal()).deal;
    const note = await invoke('POST', `/api/sponsor-crm/notes/deal/${target.id}`, { body: 'Workspace note' }, { 'x-user-id': 'synthetic-author' });
    assert.equal(note.statusCode, 201, note.body);
    const task = await invoke('POST', '/api/tasks', { description: 'Follow up', date: '2026-11-01', subject: { type: 'sponsor-deal', id: target.id } });
    assert.equal(task.statusCode, 201, task.body);
    const keepTask = await invoke('POST', '/api/tasks', { description: 'Other deal', date: '2026-11-01', subject: { type: 'sponsor-deal', id: other.id } });
    assert.equal(keepTask.statusCode, 201, keepTask.body);
    await createCrmRecord(client, 'message', { organizationId: org.id, dealId: target.id, sourceType: 'gmail', sentAt: '2026-10-01T12:00:00Z' });
    await put(TABLE_SPONSOR_CRM, { PK: `SPONSOR_FINANCE#${target.id}`, SK: `SPONSOR_FINANCE#${target.id}`, dealId: target.id, version: 1, invoiceRequirement: 'required', paymentLinkIds: [], recordedPaymentIds: [] });
    await put(TABLE_SPONSOR_CRM, { PK: `SPONSOR_FINANCE_HISTORY#${target.id}`, SK: 'h1', dealId: target.id });

    const beforeCrm = await rows(TABLE_SPONSOR_CRM);
    assert.ok(beforeCrm.some(row => row.PK === `HISTORY#${target.id}`));
    assert.ok(beforeCrm.some(row => row.PK === `NOTE#deal:${target.id}`));
    assert.ok(beforeCrm.some(row => row.PK === `MESSAGE_TARGET#deal:${target.id}`));

    const currentTarget = data(await invoke('GET', `/api/sponsor-crm/deals/${target.id}`));
    const result = await remove(target.id, `&expectedVersion=${currentTarget.version}`);
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(data(result).deleted, true);
    assert.equal((await invoke('GET', `/api/sponsor-crm/deals/${target.id}`)).statusCode, 404);
    assert.equal((await remove(target.id)).statusCode, 404);

    const afterCrm = await rows(TABLE_SPONSOR_CRM);
    assert.ok(!afterCrm.some(row => JSON.stringify(row).includes(target.id) &&
      !String(row.PK).startsWith('MESSAGE#') && !String(row.PK).startsWith('DEAL_DELETE_AUDIT#')), 'no live row of the deal remains');
    const audit = afterCrm.find(row => String(row.PK).startsWith(`DEAL_DELETE_AUDIT#${target.id}`));
    assert.ok(audit, 'the deal deletion retains an audit snapshot');
    assert.equal((audit.snapshot as any).deal.id, target.id);
    assert.ok(afterCrm.some(row => String(row.PK).startsWith('MESSAGE#')), 'the shared message record stays');
    assert.ok(afterCrm.some(row => row.PK === `DEAL#${other.id}`) && afterCrm.some(row => row.PK === `HISTORY#${other.id}`));
    const tasks = await rows(TABLE_TASKS);
    assert.ok(!tasks.some(row => (row.subject as any)?.id === target.id));
    assert.ok(tasks.some(row => (row.subject as any)?.id === other.id));
  });

  it('refuses a booked newsletter slot/issue and names the issue', async () => {
    const { deal: target } = await deal();
    await put(TABLE_SPONSOR_CRM, { PK: 'DELIVERABLE#booked', SK: 'DELIVERABLE#booked', id: 'booked', dealId: target.id, newsletterIssueId: 'issue-42', version: 1 });
    await refuses(target.id, /booked newsletter slot\/issue \(issue issue-42\)/);
  });

  it('refuses a deliverable', async () => {
    const { deal: target } = await deal();
    await put(TABLE_SPONSOR_CRM, { PK: 'DELIVERABLE#plain', SK: 'DELIVERABLE#plain', id: 'plain', dealId: target.id, archivedAt: '2026-10-01T00:00:00Z', version: 1 });
    await refuses(target.id, /deliverable \(plain\)/);
  });

  it('previews then deletes a placeholder deliverable with the deal and keeps its audit snapshot', async () => {
    const { deal: target } = await deal();
    await put(TABLE_SPONSOR_CRM, {
      PK: 'DELIVERABLE#placeholder', SK: 'DELIVERABLE#placeholder', id: 'placeholder',
      dealId: target.id, channel: 'standalone', version: 1,
    });
    const preview = await removeWithDeliverables(target.id);
    assert.equal(preview.statusCode, 200, preview.body);
    assert.equal(data(preview).mode, 'dry-run');
    assert.deepEqual(data(preview).deletedDeliverableIds, ['placeholder']);
    assert.equal((await invoke('GET', `/api/sponsor-crm/deals/${target.id}`)).statusCode, 200);
    assert.equal((await getCrmRecord(client, 'deal', target.id))?.id, target.id);

    const applied = await removeWithDeliverables(target.id, { apply: true });
    assert.equal(applied.statusCode, 200, applied.body);
    assert.equal(data(applied).mode, 'applied');
    assert.equal(data(applied).auditSnapshotRetained, true);
    assert.equal((await invoke('GET', `/api/sponsor-crm/deals/${target.id}`)).statusCode, 404);
    const after = await rows(TABLE_SPONSOR_CRM);
    assert.ok(!after.some(row => row.PK === 'DELIVERABLE#placeholder'));
    const audit = after.find(row => String(row.PK).startsWith(`DEAL_DELETE_AUDIT#${target.id}`));
    assert.equal((audit?.snapshot as any)?.deliverables[0]?.id, 'placeholder');
  });

  it('with-deliverables deletion still refuses booked slots and finance records', async () => {
    const { deal: booked } = await deal();
    await put(TABLE_SPONSOR_CRM, { PK: 'DELIVERABLE#booked-new', SK: 'DELIVERABLE#booked-new', id: 'booked-new', dealId: booked.id, newsletterIssueId: 'issue-99', version: 1 });
    const slot = await removeWithDeliverables(booked.id);
    assert.equal(slot.statusCode, 409); assert.match(data(slot).error, /booked newsletter slot\/issue/);
    assert.equal((await getCrmRecord(client, 'deal', booked.id))?.id, booked.id);

    const { deal: financed } = await deal();
    await put(TABLE_SPONSOR_CRM, { PK: 'DELIVERABLE#placeholder-finance', SK: 'DELIVERABLE#placeholder-finance', id: 'placeholder-finance', dealId: financed.id, channel: 'standalone', version: 1 });
    await put(TABLE_SPONSOR_CRM, { PK: `SPONSOR_FINANCE#${financed.id}`, SK: `SPONSOR_FINANCE#${financed.id}`, dealId: financed.id, version: 1, invoiceNumber: 'INV-42' });
    const finance = await removeWithDeliverables(financed.id);
    assert.equal(finance.statusCode, 409); assert.match(data(finance).error, /finance \(invoice\)/);
    assert.equal((await getCrmRecord(client, 'deal', financed.id))?.id, financed.id);
  });

  it('refuses finance: invoice, payment and settlement', async () => {
    const state = (dealId: string, extra: Record<string, unknown>) => put(TABLE_SPONSOR_CRM, {
      PK: `SPONSOR_FINANCE#${dealId}`, SK: `SPONSOR_FINANCE#${dealId}`, dealId, version: 1,
      invoiceRequirement: 'required', paymentLinkIds: [], recordedPaymentIds: [], ...extra,
    });
    for (const [extra, pattern] of [
      [{ invoiceNumber: 'INV-1' }, /finance \(invoice\)/],
      [{ recordedPaymentIds: ['p1'] }, /finance \(payment\)/],
      [{ settlementAdjustment: { amount: '1.00' } }, /finance \(settlement\)/],
    ] as const) {
      const { deal: target } = await deal();
      await state(target.id, extra);
      await refuses(target.id, pattern);
    }
    const { deal: linked } = await deal();
    await put(TABLE_SPONSOR_CRM, { PK: `SPONSOR_FINANCE_LINK#${linked.id}#transaction#t1`, SK: `SPONSOR_FINANCE_LINK#${linked.id}#transaction#t1`, dealId: linked.id });
    await refuses(linked.id, /finance \(payment\)/);
  });

  it('plans finance without concrete results do not block deletion', async () => {
    const { deal: target } = await deal();
    await put(TABLE_SPONSOR_CRM, { PK: `SPONSOR_FINANCE#${target.id}`, SK: `SPONSOR_FINANCE#${target.id}`, dealId: target.id, version: 1, invoiceRequirement: 'required', amountDue: '100.00', paymentLinkIds: [], recordedPaymentIds: [] });
    assert.equal((await remove(target.id)).statusCode, 200);
  });

  it('reports a version conflict, validates the version and returns 404 for an unknown deal', async () => {
    const { deal: target } = await deal();
    const stale = await remove(target.id, `&expectedVersion=${target.version + 1}`);
    assert.equal(stale.statusCode, 409); assert.match(data(stale).error, /changed/);
    assert.equal((await remove(target.id, '&expectedVersion=0')).statusCode, 400);
    assert.equal((await invoke('GET', `/api/sponsor-crm/deals/${target.id}`)).statusCode, 200);
    const missing = await remove('does-not-exist');
    assert.equal(missing.statusCode, 404); assert.deepEqual(data(missing), { error: 'Not found' });
  });

  it('archives without hard=true and rolls back when cleanup fails', async () => {
    const { deal: target } = await deal();
    const beforeRows = await rows(TABLE_SPONSOR_CRM);
    process.env.SPONSOR_CRM_TEST_FAIL_AFTER = '1'; process.env.CARD_DELETION_TEST_FAIL_AFTER = '1';
    try { assert.equal((await remove(target.id)).statusCode, 500); }
    finally { delete process.env.SPONSOR_CRM_TEST_FAIL_AFTER; delete process.env.CARD_DELETION_TEST_FAIL_AFTER; }
    assert.deepEqual(await rows(TABLE_SPONSOR_CRM), beforeRows);
    assert.equal((await invoke('DELETE', `/api/sponsor-crm/deals/${target.id}`)).statusCode, 200);
    assert.ok(data(await invoke('GET', `/api/sponsor-crm/deals/${target.id}`)).archivedAt);
  });

  it('requires an authenticated active admin', async () => {
    const { deal: target } = await deal();
    const { deal: cascadeTarget } = await deal();
    await createUserWithId(client, 'deal-delete-admin', { name: 'Admin', email: 'deal-admin@example.test', role: 'admin' });
    await createUserWithId(client, 'deal-delete-operator', { name: 'Operator', email: 'deal-operator@example.test', role: 'operator' });
    const admin = await createSession(client, 'deal-delete-admin'); const operator = await createSession(client, 'deal-delete-operator');
    process.env.SKIP_AUTH = 'false';
    try {
      assert.equal((await invoke('DELETE', `/api/sponsor-crm/deals/${cascadeTarget.id}?hard=true`, undefined, { Authorization: `Bearer ${admin.token}` })).statusCode, 400);
      const path = `/api/sponsor-crm/deals/${target.id}/delete`;
      const body = { withDeliverables: false, apply: true };
      assert.equal((await invoke('POST', path, body, { 'x-user-id': 'deal-delete-admin' })).statusCode, 401);
      assert.equal((await invoke('POST', path, body, { Authorization: `Bearer ${operator.token}` })).statusCode, 403);
      assert.equal((await invoke('POST', path, body, { Authorization: `Bearer ${admin.token}` })).statusCode, 200);
      const cascadePath = `/api/sponsor-crm/deals/${cascadeTarget.id}/delete`;
      const cascadeBody = { withDeliverables: true, apply: true };
      assert.equal((await invoke('POST', cascadePath, cascadeBody, { 'x-user-id': 'deal-delete-admin' })).statusCode, 401);
      assert.equal((await invoke('POST', cascadePath, cascadeBody, { Authorization: `Bearer ${operator.token}` })).statusCode, 403);
      assert.equal((await invoke('POST', cascadePath, cascadeBody, { Authorization: `Bearer ${admin.token}` })).statusCode, 200);
    } finally { process.env.SKIP_AUTH = 'true'; }
  });
});
