import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getClient } from '../src/db/client';
import { createDealAtomic, createOrganizationAtomic } from '../src/db/sponsorCrm';
import { createTables, TABLE_BOOKKEEPING, TABLE_SPONSOR_CRM, TABLE_USERS } from '../scripts/local-dynamodb';
import { invoiceIdentity, paymentIdentity } from '../src/sponsorFinance/core';
import { getFinanceState, listFinanceHistory } from '../src/sponsorFinance/repository';
import { FINOM_PAID_INSTRUCTION_DOC_ID, FINOM_PAID_TASK_SOURCE, FINOM_PAID_TASK_TAG } from '../src/sponsorFinance/finomPaidTask';
import type { LambdaEvent, LambdaResponse, Task } from '../src/types';

// Run only through the real DynamoDB Local transaction gate: the Finom Task is
// created inside the production payment transaction, so the tests must exercise
// that transaction rather than a weakened path.
describe('sponsor Finom invoice-paid tasks', () => {
  let client: DynamoDBDocumentClient;
  const ADMIN = 'finom-admin-1';
  const today = berlinToday();
  const day = (offset: number) => {
    const date = new Date(`${today}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + offset);
    return date.toISOString().slice(0, 10);
  };

  function berlinToday(): string {
    const parts = new Intl.DateTimeFormat('en', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const value = (type: string) => parts.find((item) => item.type === type)!.value;
    return `${value('year')}-${value('month')}-${value('day')}`;
  }

  const invoke = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const [pathname, search = ''] = path.split('?');
    const event: LambdaEvent = {
      httpMethod: method,
      path: pathname,
      queryStringParameters: Object.fromEntries(new URLSearchParams(search)),
      headers,
      body: body === undefined ? null : JSON.stringify(body),
    };
    const response: LambdaResponse = await (await import('../src/handler')).handler(event, {});
    return { status: response.statusCode, body: JSON.parse(response.body || '{}') };
  };

  const put = (table: string, item: Record<string, unknown>) => client.send(new PutCommand({ TableName: table, Item: item }));

  let sequence = 0;
  /** Seed an agreed deal with an issued, payable invoice of `amountDue` EUR, as raw fixture rows. */
  async function bootstrapDeal(amountDue = '1000') {
    sequence += 1;
    const organization = await createOrganizationAtomic(client, { displayName: `Synthetic Finom Sponsor ${sequence}` }, ADMIN);
    const deal = await createDealAtomic(
      client, { organizationId: organization.item.id, status: 'agreed', productKind: 'one-off', title: `Fall bundle ${sequence}` }, ADMIN,
    );
    const dealId = deal.item.id;
    const issuedOn = day(-30);
    const invoiceSourceId = `inv-src-finom-${sequence}`;
    const invoiceSource = {
      PK: `DOCUMENT#${invoiceSourceId}`, SK: `DOCUMENT#${invoiceSourceId}`,
      id: invoiceSourceId, documentType: 'invoice', status: 'active',
      sha256: 'd'.repeat(64), objectVersionId: `obj-finom-${sequence}`, verifiedByteSize: 800,
      createdAt: `${issuedOn}T09:00:00.000Z`, updatedAt: `${issuedOn}T09:00:00.000Z`,
    };
    const linkId = `SPONSOR_FINANCE_LINK#${dealId}#document#${invoiceSourceId}`;
    await put(TABLE_SPONSOR_CRM, {
      PK: `SPONSOR_FINANCE#${dealId}`, SK: `SPONSOR_FINANCE#${dealId}`,
      id: dealId, recordType: 'sponsor-finance', dealId, version: 2,
      invoiceRequirement: 'required', amountDue, currency: 'EUR', taxMode: 'included',
      invoiceNumber: `FINOM-INV-${sequence}`, issuedOn, sentOn: issuedOn, dueOn: day(14),
      invoiceLinkId: linkId,
      paymentLinkIds: [], recordedPaymentIds: [], paymentFollowUpTaskIds: [],
      actorId: ADMIN, createdAt: `${issuedOn}T09:00:00.000Z`, updatedAt: `${issuedOn}T09:00:00.000Z`,
    });
    await put(TABLE_SPONSOR_CRM, {
      PK: linkId, SK: linkId, id: linkId, recordType: 'sponsor-finance-link',
      dealId, kind: 'document', sourceId: invoiceSourceId, identityToken: invoiceIdentity(invoiceSource),
      actorId: ADMIN, financeVersion: 2, createdAt: `${issuedOn}T09:00:00.000Z`,
    });
    await put(TABLE_BOOKKEEPING, {
      PK: `SPONSOR_FINANCE_CLAIM#document#${invoiceSourceId}`, SK: `SPONSOR_FINANCE_CLAIM#document#${invoiceSourceId}`,
      recordType: 'sponsor-finance-claim', kind: 'document', sourceId: invoiceSourceId,
      dealId, linkId, identityToken: invoiceIdentity(invoiceSource), actorId: ADMIN,
      createdAt: `${issuedOn}T09:00:00.000Z`,
    });
    await put(TABLE_BOOKKEEPING, invoiceSource);
    return { dealId, financeVersion: 2 };
  }

  const receive = async (dealId: string, extra: Record<string, unknown>, idempotencyLabel: string) => {
    const state = await getFinanceState(client, dealId);
    return invoke('POST', `/api/sponsor-crm/deals/${dealId}/finance/receipts`, {
      dealVersion: 1, expectedVersion: state!.version, receivedOn: day(-1),
      amount: '500', currency: 'EUR', reference: `synthetic-finom:${idempotencyLabel}-${sequence}`, counterparty: 'Synthetic Finom Sponsor',
      ...extra,
    }, { 'x-user-id': ADMIN, 'idempotency-key': `finom-receipt-${idempotencyLabel}-${sequence}` });
  };

  const openFinomTasks = async (dealId: string): Promise<Task[]> => {
    const pool = await invoke('GET', '/api/tasks?status=todo');
    assert.strictEqual(pool.status, 200);
    return (pool.body.tasks as Task[]).filter((task) =>
      task.subject?.type === 'sponsor-deal' && task.subject.id === dealId
      && (task.source === FINOM_PAID_TASK_SOURCE || task.tags?.includes(FINOM_PAID_TASK_TAG)));
  };

  before(async () => {
    if (!process.env.DYNAMODB_ENDPOINT?.startsWith('http://127.0.0.1:')) throw new Error('Run through the DynamoDB Local transaction gate');
    client = await getClient();
    await createTables(client);
    process.env.IS_LOCAL = 'true';
    process.env.SPONSOR_FINANCE_ENABLED = 'true';
    await put(TABLE_USERS, { PK: `USER#${ADMIN}`, SK: `USER#${ADMIN}`, id: ADMIN, role: 'admin', disabled: false });
  });

  after(async () => {
    client.destroy();
    delete process.env.IS_LOCAL;
    delete process.env.SPONSOR_FINANCE_ENABLED;
  });

  it('creates the single Finom Task with instruction, owner, due date and payment dependency on receive-payment', async () => {
    const { dealId } = await bootstrapDeal();
    const response = await receive(dealId, { amount: '1000' }, 'create');
    assert.strictEqual(response.status, 200, JSON.stringify(response.body));

    const [task] = await openFinomTasks(dealId);
    assert.ok(task, 'an open Finom Task exists after the receipt');
    assert.strictEqual(task.description, `Mark invoice FINOM-INV-${sequence} paid in Finom`);
    assert.strictEqual(task.instructionDocId, FINOM_PAID_INSTRUCTION_DOC_ID);
    assert.strictEqual(task.assigneeId, ADMIN, 'the Task is assigned to the deal owner recording the payment');
    assert.strictEqual(task.date, today, 'the Task is due the same day the payment step runs');
    assert.strictEqual(task.status, 'todo');
    assert.strictEqual(task.subject?.type, 'sponsor-deal');
    assert.strictEqual(task.subject?.id, dealId);
    assert.strictEqual(task.source, FINOM_PAID_TASK_SOURCE);
    assert.deepStrictEqual(task.tags, [FINOM_PAID_TASK_TAG]);

    // The dependency is structural: the payment-linked history event names the Task.
    const linked = (await listFinanceHistory(client, dealId)).find((item) => item.eventCode === 'payment-linked')!;
    assert.ok(linked);
    assert.strictEqual((linked.details as Record<string, unknown>).finomTaskId, task.id);
    assert.strictEqual((linked.details as Record<string, unknown>).finomTaskCreated, true);

    // The deal view's openTasks (what `sponsors show` prints) list it.
    const dealView = await invoke('GET', `/api/sponsor-crm/deals/${dealId}`);
    assert.ok(dealView.body.openTasks.some((item: { id: string }) => item.id === task.id));
  });

  it('replays a retried receive-payment to the same single Task', async () => {
    const { dealId } = await bootstrapDeal();
    const first = await receive(dealId, { amount: '1000' }, 'replay');
    assert.strictEqual(first.status, 200);
    const before = await openFinomTasks(dealId);
    assert.strictEqual(before.length, 1);
    const retry = await receive(dealId, { amount: '1000' }, 'replay');
    assert.strictEqual(retry.status, 200);
    assert.strictEqual((retry.body as { result?: { outcome?: string } }).result?.outcome, 'replayed');
    assert.deepStrictEqual(await openFinomTasks(dealId), before);
  });

  it('a second receipt adopts the open Task instead of creating parallel work', async () => {
    const { dealId } = await bootstrapDeal();
    const first = await receive(dealId, { amount: '400' }, 'partial-one');
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));
    const [open] = await openFinomTasks(dealId);
    assert.ok(open);
    const second = await receive(dealId, { amount: '600', reference: `synthetic-finom:partial-two-${sequence}` }, 'partial-two');
    assert.strictEqual(second.status, 200, JSON.stringify(second.body));
    const tasks = await openFinomTasks(dealId);
    assert.strictEqual(tasks.length, 1);
    assert.strictEqual(tasks[0].id, open.id);
    const linked = (await listFinanceHistory(client, dealId)).filter((item) => item.eventCode === 'payment-linked');
    // History lists newest first; the newest event is the second receipt's.
    assert.strictEqual((linked[0].details as Record<string, unknown>).finomTaskCreated, false);
    assert.strictEqual((linked[0].details as Record<string, unknown>).finomTaskId, open.id);
  });

  it('a resolved Task lets the next receipt create a fresh one', async () => {
    const { dealId } = await bootstrapDeal();
    const first = await receive(dealId, { amount: '500' }, 'resolve-one');
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));
    const [created] = await openFinomTasks(dealId);
    const resolved = await invoke('PUT', `/api/tasks/${created.id}`, {
      status: 'done', expectedVersion: created.version, comment: 'Marked the invoice paid in Finom.',
    }, { 'x-user-id': ADMIN });
    assert.strictEqual(resolved.status, 200, JSON.stringify(resolved.body));
    const second = await receive(dealId, { amount: '500', reference: `synthetic-finom:resolve-two-${sequence}` }, 'resolve-two');
    assert.strictEqual(second.status, 200, JSON.stringify(second.body));
    const tasks = await openFinomTasks(dealId);
    assert.strictEqual(tasks.length, 1);
    assert.notStrictEqual(tasks[0].id, created.id);
  });

  it('link-payment creates the same Finom Task for a ledger row linked after the fact', async () => {
    const { dealId } = await bootstrapDeal();
    const transactionId = `tx-finom-${sequence}`;
    const source = {
      PK: `BOOKKEEPING#${transactionId}`, SK: `BOOKKEEPING#${transactionId}`,
      id: transactionId, amount: '1000', currency: 'EUR', paidDate: day(-2),
      counterparty: 'Synthetic Finom Sponsor', description: 'Sponsor payment for deal', statementRef: `synthetic-ledger:${sequence}`,
      entryType: 'income', sourceType: 'bank-import', sourceKey: `synthetic-ledger:${sequence}`,
      createdAt: `${day(-2)}T10:00:00.000Z`, updatedAt: `${day(-2)}T10:00:00.000Z`,
    };
    await put(TABLE_BOOKKEEPING, source);
    const response = await invoke('POST', `/api/sponsor-crm/deals/${dealId}/finance/payments`, {
      dealVersion: 1, expectedVersion: (await getFinanceState(client, dealId))!.version,
      sourceId: transactionId, identityToken: paymentIdentity(source),
    }, { 'x-user-id': ADMIN, 'idempotency-key': `finom-link-${sequence}-0123456789abcdef` });
    assert.strictEqual(response.status, 200, JSON.stringify(response.body));
    const [task] = await openFinomTasks(dealId);
    assert.ok(task);
    assert.strictEqual(task.description, `Mark invoice FINOM-INV-${sequence} paid in Finom`);
    assert.strictEqual(task.instructionDocId, FINOM_PAID_INSTRUCTION_DOC_ID);
    assert.strictEqual(task.date, today);
  });

  it('concurrent receipts converge on exactly one open Finom Task', async () => {
    const { dealId } = await bootstrapDeal();
    const [first, second] = await Promise.all([
      receive(dealId, { amount: '500' }, 'race-a'),
      receive(dealId, { amount: '500', reference: `synthetic-finom:race-b-${sequence}` }, 'race-b'),
    ]);
    assert.deepStrictEqual([first.status, second.status].sort((a, b) => a - b), [200, 409]);
    assert.strictEqual((await openFinomTasks(dealId)).length, 1);
  });

  it('an unrelated open deal Task is never adopted as the Finom Task', async () => {
    const { dealId } = await bootstrapDeal();
    const created = await invoke('POST', '/api/tasks', {
      description: 'Prepare the sponsor pack', date: day(2),
      subject: { type: 'sponsor-deal', id: dealId },
    }, { 'x-user-id': ADMIN });
    assert.strictEqual(created.status, 201);
    const unrelated = created.body.task || created.body;
    const response = await receive(dealId, { amount: '1000' }, 'unrelated');
    assert.strictEqual(response.status, 200, JSON.stringify(response.body));
    const tasks = await openFinomTasks(dealId);
    assert.strictEqual(tasks.length, 1);
    assert.notStrictEqual(tasks[0].id, unrelated.id);
    const dealView = await invoke('GET', `/api/sponsor-crm/deals/${dealId}`);
    assert.deepStrictEqual(dealView.body.openTasks.length, 2);
  });
});
