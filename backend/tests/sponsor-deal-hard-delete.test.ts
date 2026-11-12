import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { PutCommand, ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { handler } from '../src/handler';
import { getClient } from '../src/db/client';
import { TABLE_BOOKKEEPING, TABLE_NEWSLETTER_SLOTS, TABLE_SPONSOR_CRM, TABLE_TASKS } from '../src/db/tableNames';
import { createUserWithId } from '../src/db/users';
import { humanBearer } from './helpers/human-bearer';
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
    assert.ok(!afterCrm.some(row => row.PK === `SPONSOR_FINANCE#${target.id}`), 'the active finance state is removed');
    assert.ok(afterCrm.some(row => row.PK === `SPONSOR_FINANCE_ARCHIVE#${target.id}` && row.SK === 'STATE' &&
      row.invoiceRequirement === 'required' && row.dealId === undefined), 'finance state is retained without its deal link');
    assert.ok(afterCrm.some(row => row.PK === `SPONSOR_FINANCE_HISTORY#${target.id}`), 'finance audit history stays');
    assert.ok(!afterCrm.some(row => JSON.stringify(row).includes(target.id) &&
      !String(row.PK).startsWith('MESSAGE#') && !String(row.PK).startsWith('DEAL_DELETE_AUDIT#') &&
      !String(row.PK).startsWith('SPONSOR_FINANCE_ARCHIVE#') && !String(row.PK).startsWith('SPONSOR_FINANCE_HISTORY#')),
    'no active row of the deal remains');
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

  it('deletes real deliverables with explicit confirmation and keeps the booked newsletter slot', async () => {
    const { org, deal: target } = await deal();
    await put(TABLE_SPONSOR_CRM, {
      PK: 'DELIVERABLE#booked-new', SK: 'DELIVERABLE#booked-new', id: 'booked-new',
      dealId: target.id, newsletterIssueId: 'issue-99', version: 1, publishedAt: '2026-10-01T00:00:00Z',
    });
    await put(TABLE_SPONSOR_CRM, {
      PK: 'DELIVERABLE#published', SK: 'DELIVERABLE#published', id: 'published',
      dealId: target.id, version: 1, artifactUrls: ['https://files.test/published.pdf'],
    });
    await put(TABLE_NEWSLETTER_SLOTS, {
      PK: 'ISSUE#issue-99', SK: 'ISSUE#issue-99', id: 'issue-99', kind: 'weekly', status: 'scheduled',
      slots: { primary: { sponsor: 'Synthetic deal fixture', organizationId: org.id } }, version: 1,
    });

    const preview = await removeWithDeliverables(target.id);
    assert.equal(preview.statusCode, 200, preview.body);
    assert.deepEqual(data(preview).deletedDeliverableIds.sort(), ['booked-new', 'published']);
    assert.deepEqual(data(preview).retainedNewsletterSlotIds, ['issue-99']);
    assert.equal((await getCrmRecord(client, 'deal', target.id))?.id, target.id);

    const applied = await removeWithDeliverables(target.id, { apply: true });
    assert.equal(applied.statusCode, 200, applied.body);
    assert.equal((await getCrmRecord(client, 'deal', target.id)), null);
    const after = await rows(TABLE_SPONSOR_CRM);
    assert.ok(!after.some(row => row.PK === 'DELIVERABLE#booked-new' || row.PK === 'DELIVERABLE#published'));
    const issue = (await rows(TABLE_NEWSLETTER_SLOTS)).find(row => row.PK === 'ISSUE#issue-99');
    assert.equal((issue?.slots as any)?.primary?.sponsor, 'Synthetic deal fixture');
  });

  it('detaches finance links while retaining invoice, payment and finance records', async () => {
    const { deal: target } = await deal();
    const invoiceLinkId = `SPONSOR_FINANCE_LINK#${target.id}#document#invoice-42`;
    const paymentLinkId = `SPONSOR_FINANCE_LINK#${target.id}#transaction#payment-42`;
    const financeKey = `SPONSOR_FINANCE#${target.id}`;
    const recordedPaymentKey = `SPONSOR_FINANCE_PAYMENT#${target.id}#recorded-42`;
    await put(TABLE_SPONSOR_CRM, {
      PK: financeKey, SK: financeKey, id: target.id, recordType: 'sponsor-finance', dealId: target.id, version: 2,
      invoiceNumber: 'INV-42', amountDue: '100.00', invoiceLinkId, paymentLinkIds: [paymentLinkId],
      recordedPaymentIds: [recordedPaymentKey], settlementAdjustment: { amount: '5.00', currency: 'EUR' },
    });
    await put(TABLE_SPONSOR_CRM, {
      PK: invoiceLinkId, SK: invoiceLinkId, id: invoiceLinkId, recordType: 'sponsor-finance-link',
      dealId: target.id, kind: 'document', sourceId: 'invoice-42',
    });
    await put(TABLE_SPONSOR_CRM, {
      PK: paymentLinkId, SK: paymentLinkId, id: paymentLinkId, recordType: 'sponsor-finance-link',
      dealId: target.id, kind: 'transaction', sourceId: 'payment-42',
    });
    await put(TABLE_SPONSOR_CRM, {
      PK: recordedPaymentKey, SK: recordedPaymentKey, id: recordedPaymentKey, paymentId: 'recorded-42',
      recordType: 'sponsor-finance-payment', dealId: target.id, amount: '25.00', currency: 'EUR',
    });
    for (const [kind, sourceId, linkId] of [
      ['document', 'invoice-42', invoiceLinkId], ['transaction', 'payment-42', paymentLinkId],
    ]) {
      const key = `SPONSOR_FINANCE_CLAIM#${kind}#${sourceId}`;
      await put(TABLE_BOOKKEEPING, { PK: key, SK: key, recordType: 'sponsor-finance-claim', kind, sourceId, dealId: target.id, linkId });
    }
    await put(TABLE_BOOKKEEPING, { PK: 'DOCUMENT#invoice-42', SK: 'DOCUMENT#invoice-42', id: 'invoice-42', documentType: 'invoice' });
    await put(TABLE_BOOKKEEPING, { PK: 'BOOKKEEPING#payment-42', SK: 'BOOKKEEPING#payment-42', id: 'payment-42', amount: '75.00' });

    const applied = await removeWithDeliverables(target.id, { apply: true });
    assert.equal(applied.statusCode, 200, applied.body);
    assert.deepEqual(data(applied).detachedFinanceSourceIds.sort(), ['invoice-42', 'payment-42']);
    const crm = await rows(TABLE_SPONSOR_CRM);
    assert.ok(!crm.some(row => row.PK === financeKey || row.PK === invoiceLinkId || row.PK === paymentLinkId || row.PK === recordedPaymentKey));
    const archive = crm.filter(row => row.PK === `SPONSOR_FINANCE_ARCHIVE#${target.id}`);
    assert.ok(archive.some(row => row.SK === 'STATE' && row.amountDue === '100.00' && row.dealId === undefined &&
      row.invoiceNumber === 'INV-42' && row.settlementAdjustment &&
      row.invoiceLinkId === undefined && row.paymentLinkIds === undefined));
    assert.ok(archive.some(row => row.SK === 'PAYMENT#recorded-42' && row.amount === '25.00' && row.dealId === undefined));
    const bookkeeping = await rows(TABLE_BOOKKEEPING);
    assert.ok(bookkeeping.some(row => row.PK === 'DOCUMENT#invoice-42'), 'the invoice source remains');
    assert.ok(bookkeeping.some(row => row.PK === 'BOOKKEEPING#payment-42'), 'the payment source remains');
    assert.ok(!bookkeeping.some(row => row.PK === 'SPONSOR_FINANCE_CLAIM#document#invoice-42' ||
      row.PK === 'SPONSOR_FINANCE_CLAIM#transaction#payment-42'), 'finance claims are released');
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
    process.env.SPONSOR_CRM_TEST_FAIL_AFTER = '1'; process.env.LOCAL_TRANSACTION_TEST_FAIL_AFTER = '1';
    try { assert.equal((await remove(target.id)).statusCode, 500); }
    finally { delete process.env.SPONSOR_CRM_TEST_FAIL_AFTER; delete process.env.LOCAL_TRANSACTION_TEST_FAIL_AFTER; }
    assert.deepEqual(await rows(TABLE_SPONSOR_CRM), beforeRows);
    assert.equal((await invoke('DELETE', `/api/sponsor-crm/deals/${target.id}`)).statusCode, 200);
    assert.ok(data(await invoke('GET', `/api/sponsor-crm/deals/${target.id}`)).archivedAt);
  });

  it('requires an authenticated active admin', async () => {
    const { deal: target } = await deal();
    const { deal: cascadeTarget } = await deal();
    await createUserWithId(client, 'deal-delete-admin', { name: 'Admin', email: 'deal-admin@example.test', role: 'admin' });
    await createUserWithId(client, 'deal-delete-operator', { name: 'Operator', email: 'deal-operator@example.test', role: 'operator' });
    const admin = await humanBearer(client, 'deal-delete-admin'); const operator = await humanBearer(client, 'deal-delete-operator');
    process.env.SKIP_AUTH = 'false';
    try {
      assert.equal((await invoke('DELETE', `/api/sponsor-crm/deals/${cascadeTarget.id}?hard=true`, undefined, { Authorization: `Bearer ${admin}` })).statusCode, 400);
      const path = `/api/sponsor-crm/deals/${target.id}/delete`;
      const body = { withDeliverables: false, apply: true };
      assert.equal((await invoke('POST', path, body, { 'x-user-id': 'deal-delete-admin' })).statusCode, 401);
      assert.equal((await invoke('POST', path, body, { Authorization: `Bearer ${operator}` })).statusCode, 403);
      assert.equal((await invoke('POST', path, body, { Authorization: `Bearer ${admin}` })).statusCode, 200);
      const cascadePath = `/api/sponsor-crm/deals/${cascadeTarget.id}/delete`;
      const cascadeBody = { withDeliverables: true, apply: true };
      assert.equal((await invoke('POST', cascadePath, cascadeBody, { 'x-user-id': 'deal-delete-admin' })).statusCode, 401);
      assert.equal((await invoke('POST', cascadePath, cascadeBody, { Authorization: `Bearer ${operator}` })).statusCode, 403);
      assert.equal((await invoke('POST', cascadePath, cascadeBody, { Authorization: `Bearer ${admin}` })).statusCode, 200);
    } finally { process.env.SKIP_AUTH = 'true'; }
  });
});
