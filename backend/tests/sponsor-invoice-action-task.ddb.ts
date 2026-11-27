import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { GetCommand, PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getClient } from '../src/db/client';
import { createDealAtomic } from '../src/db/sponsorCrm';
import { createTables, TABLE_SPONSOR_CRM, TABLE_TASKS, TABLE_USERS } from '../scripts/local-dynamodb';
import { evaluateSponsorFinanceAlerts } from '../src/sponsorFinance/alerts';
import {
  INVOICE_TASK_INSTRUCTION_DOC_ID,
  INVOICE_TASK_SOURCE,
  INVOICE_TASK_TAG,
  invoiceTaskClaimKey,
  isInvoiceTask,
  syncDealInvoiceTask,
} from '../src/sponsorFinance/invoiceTask';
import { relatedDealTasks } from '../src/sponsorFinance/paymentFollowUp';
import type { LambdaEvent, LambdaResponse, Task } from '../src/types';

// Synthetic sponsors only, through the real deal and finance HTTP routes and the
// DynamoDB Local transaction gate: the claim row is what keeps the action unique.
describe('sponsor deal invoice action Task', () => {
  let client: DynamoDBDocumentClient;
  const ADMIN = 'invoice-action-admin-1';
  const OWNER = 'invoice-action-owner-1';
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
      headers: { 'x-user-id': ADMIN, ...headers },
      body: body === undefined ? null : JSON.stringify(body),
    };
    const response: LambdaResponse = await (await import('../src/handler')).handler(event, {});
    return { status: response.statusCode, body: JSON.parse(response.body || '{}') };
  };
  const put = (table: string, item: Record<string, unknown>) => client.send(new PutCommand({ TableName: table, Item: item }));

  let sequence = 0;
  const key = (label: string) => `invoice-action-${label}-${sequence}-${'k'.repeat(8)}`;

  async function organization() {
    sequence += 1;
    const created = await invoke('POST', '/api/sponsor-crm/organizations', { displayName: `Synthetic Invoice Sponsor ${sequence}` });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    return String(created.body.id);
  }

  async function openDeal(extra: Record<string, unknown> = {}) {
    const organizationId = await organization();
    const created = await invoke('POST', '/api/sponsor-crm/deals', {
      organizationId, status: 'open', productKind: 'one-off', title: `Newsletter package ${sequence}`, amountEur: 5000, owner: OWNER, ...extra,
    });
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    return created.body as { id: string; version: number };
  }

  const deal = async (dealId: string) => (await invoke('GET', `/api/sponsor-crm/deals/${dealId}`)).body as { id: string; version: number };
  const agree = async (dealId: string) => {
    const current = await deal(dealId);
    const updated = await invoke('PUT', `/api/sponsor-crm/deals/${dealId}`, { version: current.version, status: 'agreed', agreementDate: today });
    assert.strictEqual(updated.status, 200, JSON.stringify(updated.body));
  };
  const finance = async (dealId: string) => (await invoke('GET', `/api/sponsor-crm/deals/${dealId}/finance`)).body as { finance?: { version: number } };
  const financeWrite = async (dealId: string, method: string, action: string, body: Record<string, unknown>, label: string) => {
    const current = await deal(dealId);
    const projection = await finance(dealId);
    const response = await invoke(method, `/api/sponsor-crm/deals/${dealId}/finance${action ? `/${action}` : ''}`, {
      dealVersion: current.version, expectedVersion: projection.finance?.version ?? 0, ...body,
    }, { 'idempotency-key': key(label) });
    assert.strictEqual(response.status, 200, JSON.stringify(response.body));
    return response.body;
  };
  const classify = (dealId: string, extra: Record<string, unknown> = {}) => financeWrite(dealId, 'PUT', '', {
    invoiceRequirement: 'required', amountDue: '5000', currency: 'EUR', taxMode: 'included', ...extra,
  }, `classify-${JSON.stringify(extra).length}`);

  /** What the Active queue reads: open Tasks due today or earlier, not waiting. */
  const activeQueue = async (): Promise<Task[]> => {
    const lanes = await Promise.all([
      invoke('GET', `/api/tasks?date=${today}`),
      invoke('GET', '/api/tasks?status=todo'),
    ]);
    for (const lane of lanes) assert.strictEqual(lane.status, 200, JSON.stringify(lane.body));
    const tasks = new Map<string, Task>();
    for (const lane of lanes) for (const task of lane.body.tasks as Task[]) tasks.set(task.id, task);
    return [...tasks.values()].filter((task) => task.status === 'todo' && task.date <= today && !task.followUpAt && !task.waitingFor);
  };
  /** Every Task about the deal in any status (consistent read), or only those in `status`. */
  const dealTasks = async (dealId: string, status?: string): Promise<Task[]> =>
    (await relatedDealTasks(client, dealId, false)).filter((task) => !status || task.status === status);
  const invoiceActions = async (dealId: string) => (await activeQueue())
    .filter((task) => task.subject?.type === 'sponsor-deal' && task.subject.id === dealId && isInvoiceTask(task));
  const task = async (id: string) => (await client.send(new GetCommand({ TableName: TABLE_TASKS, Key: { PK: `TASK#${id}`, SK: `TASK#${id}` }, ConsistentRead: true }))).Item as Task;

  before(async () => {
    if (!process.env.DYNAMODB_ENDPOINT?.startsWith('http://127.0.0.1:')) throw new Error('Run through the DynamoDB Local transaction gate');
    client = await getClient();
    await createTables(client);
    process.env.IS_LOCAL = 'true';
    process.env.SPONSOR_FINANCE_ENABLED = 'true';
    await put(TABLE_USERS, { PK: `USER#${ADMIN}`, SK: `USER#${ADMIN}`, id: ADMIN, role: 'admin', disabled: false });
    await put(TABLE_USERS, { PK: `USER#${OWNER}`, SK: `USER#${OWNER}`, id: OWNER, role: 'operator', disabled: false });
  });

  after(async () => {
    client.destroy();
    delete process.env.IS_LOCAL;
    delete process.env.SPONSOR_FINANCE_ENABLED;
  });

  it('puts exactly one invoice action in Active the moment the deal is agreed, and keeps it single across retries and deliverables', async () => {
    const { id: dealId } = await openDeal();
    assert.deepStrictEqual(await invoiceActions(dealId), [], 'an open (unconfirmed) deal owes no invoice yet');
    await agree(dealId);
    const [action, ...extra] = await invoiceActions(dealId);
    assert.ok(action, 'the agreed deal has its invoice action in Active immediately');
    assert.deepStrictEqual(extra, []);
    assert.strictEqual(action.date, today);
    assert.strictEqual(action.status, 'todo');
    assert.strictEqual(action.source, INVOICE_TASK_SOURCE);
    assert.deepStrictEqual(action.tags, [INVOICE_TASK_TAG]);
    assert.strictEqual(action.assigneeId, OWNER, 'the deal owner owns the invoice action');
    assert.strictEqual(action.instructionDocId, INVOICE_TASK_INSTRUCTION_DOC_ID);
    assert.match(action.description, /^Issue and send the invoice for Synthetic Invoice Sponsor \d+ — Newsletter package \d+\./);
    assert.match(action.description, /invoice terms not recorded .*deal value 5000 EUR/);
    assert.match(action.description, /Payment is tracked separately once the invoice is sent\.$/);

    // Three booked deliverables, further deal edits, a duplicate route retry and racing syncs: still one.
    for (const position of ['primary', 'secondary', 'main']) {
      const deliverable = await invoke('POST', '/api/sponsor-crm/deliverables', { dealId, channel: 'main', title: `Slot ${position}`, plannedPublicationDate: day(10) });
      assert.strictEqual(deliverable.status, 201, JSON.stringify(deliverable.body));
    }
    const current = await deal(dealId);
    assert.strictEqual((await invoke('PUT', `/api/sponsor-crm/deals/${dealId}`, { version: current.version, title: `Newsletter package ${sequence}` })).status, 200);
    await Promise.all([1, 2, 3, 4].map(() => syncDealInvoiceTask(client, dealId)));
    const after = await dealTasks(dealId);
    assert.deepStrictEqual(after.map((item) => item.id), [action.id], 'one Task on the deal, no matter how many writes or deliverables');
  });

  it('shows billing prerequisites apart from payment and refreshes them when billing details arrive', async () => {
    const { id: dealId } = await openDeal();
    await agree(dealId);
    await classify(dealId);
    await financeWrite(dealId, 'PUT', 'follow-through', { waitingOn: { party: 'sponsor', reason: 'billing-details', since: today, note: 'AP contact asked' } }, 'waiting');
    let [action] = await invoiceActions(dealId);
    assert.ok(action, 'waiting on the sponsor keeps the action in Active, not Waiting');
    assert.match(action.description, /Billing prerequisites: amount 5000 EUR, tax included; waiting on sponsor for billing details since \d{4}-\d{2}-\d{2} \(AP contact asked\)/);
    assert.doesNotMatch(action.description, /outstanding|overdue|paid/i, 'payment state is not mixed into the billing prerequisites');

    await financeWrite(dealId, 'PUT', 'follow-through', {
      waitingOn: null, evidence: [{ kind: 'email', ref: 'synthetic-billing-details-1', label: 'Billing details received' }],
    }, 'received');
    [action] = await invoiceActions(dealId);
    assert.match(action.description, /billing details: no open blocker, 1 evidence item on file/);
    assert.doesNotMatch(action.description, /waiting on sponsor/);
  });

  it('closes the action once the invoice is actually sent, not when it is only issued, and never reopens it', async () => {
    const { id: dealId } = await openDeal();
    await agree(dealId);
    await classify(dealId);
    const [action] = await invoiceActions(dealId);
    await financeWrite(dealId, 'POST', 'issue', { invoiceNumber: 'SYN-INV-1', issuedOn: today, dueOn: day(30) }, 'issue');
    let [stillOpen] = await invoiceActions(dealId);
    assert.strictEqual(stillOpen?.id, action.id, 'an issued but unsent invoice keeps the action open');
    assert.match(stillOpen.description, /^Send the issued invoice SYN-INV-1 for/);

    await financeWrite(dealId, 'POST', 'issue', { invoiceNumber: 'SYN-INV-1', issuedOn: today, dueOn: day(30), sentOn: today }, 'sent');
    assert.deepStrictEqual(await invoiceActions(dealId), []);
    const closed = await task(action.id);
    assert.strictEqual(closed.status, 'done');
    assert.strictEqual(closed.completedBy, 'system:sponsor-invoice');
    assert.match(String(closed.comment), /Invoice SYN-INV-1 sent/);

    await syncDealInvoiceTask(client, dealId);
    assert.strictEqual((await task(action.id)).status, 'done', 'a sent invoice never brings the action back');
    assert.deepStrictEqual((await dealTasks(dealId, 'todo')).filter(isInvoiceTask), []);
  });

  it('opens nothing for non-invoice deals or deals whose invoice was already issued and sent', async () => {
    const notRequired = await openDeal();
    await classify(notRequired.id, { invoiceRequirement: 'not-required' });
    await agree(notRequired.id);
    assert.deepStrictEqual(await dealTasks(notRequired.id), []);

    const noValue = await openDeal({ amountEur: 0 });
    await agree(noValue.id);
    assert.deepStrictEqual(await dealTasks(noValue.id), [], 'an unclassified deal with no value is not known to need an invoice');

    const alreadySent = await openDeal();
    await classify(alreadySent.id);
    await financeWrite(alreadySent.id, 'POST', 'issue', { invoiceNumber: 'SYN-INV-2', issuedOn: day(-3), dueOn: day(27), sentOn: day(-3) }, 'sent-before');
    await agree(alreadySent.id);
    assert.deepStrictEqual(await dealTasks(alreadySent.id), []);

    const issuedOnly = await openDeal();
    await classify(issuedOnly.id);
    await financeWrite(issuedOnly.id, 'POST', 'issue', { invoiceNumber: 'SYN-INV-3', issuedOn: day(-3), dueOn: day(27) }, 'issued-before');
    await agree(issuedOnly.id);
    assert.deepStrictEqual(await dealTasks(issuedOnly.id), [], 'an issued invoice is not reopened as new work');

    // A deal reclassified as not needing an invoice retires its open action.
    const reclassified = await openDeal();
    await agree(reclassified.id);
    const [action] = await invoiceActions(reclassified.id);
    await classify(reclassified.id, { invoiceRequirement: 'not-required' });
    const retired = await task(action.id);
    assert.strictEqual(retired.status, 'skipped');
    assert.strictEqual(retired.skipReason, 'The deal does not need an invoice');
  });

  it('adopts the deal\'s hand-made invoice Task instead of adding a second one, pulling it into Active', async () => {
    const { id: dealId } = await openDeal();
    const manual = await invoke('POST', '/api/tasks', {
      description: 'Issue and send the €5,000 synthetic newsletter package invoice', date: day(2),
      subject: { type: 'sponsor-deal', id: dealId }, assigneeId: ADMIN,
    });
    assert.strictEqual(manual.status, 201, JSON.stringify(manual.body));
    const unrelated = await invoke('POST', '/api/tasks', {
      description: 'Vendor setup: await marketing operations confirmation and invoice instructions', date: day(-1),
      subject: { type: 'sponsor-deal', id: dealId },
    });
    assert.strictEqual(unrelated.status, 201, JSON.stringify(unrelated.body));
    await agree(dealId);
    const [action, ...extra] = await invoiceActions(dealId);
    assert.deepStrictEqual(extra, []);
    assert.strictEqual(action.id, manual.body.id, 'the hand-made Task became the canonical action');
    assert.strictEqual(action.date, today, 'it moved from the future into Active');
    assert.strictEqual(action.assigneeId, ADMIN, 'its owner is kept');
    assert.ok(action.tags?.includes(INVOICE_TASK_TAG));
    const history = (await task(action.id)).taskHistory || [];
    assert.ok(history.some((event) => event.note?.includes('Previous description: Issue and send the €5,000 synthetic newsletter package invoice')));
    const vendor = await task(unrelated.body.id);
    assert.ok(!vendor.tags?.includes(INVOICE_TASK_TAG), 'a prerequisite Task about invoicing is not taken over');
    assert.strictEqual(vendor.description, 'Vendor setup: await marketing operations confirmation and invoice instructions');
    assert.strictEqual((await dealTasks(dealId)).length, 2);

    // A payment follow-up for the invoice step is the same work: refused, pointing at the action.
    await classify(dealId);
    const current = await deal(dealId);
    const projection = await finance(dealId);
    const followUp = await invoke('POST', `/api/sponsor-crm/deals/${dealId}/finance/follow-up`, {
      dealVersion: current.version, expectedVersion: projection.finance!.version,
    }, { 'idempotency-key': key('follow-up') });
    assert.strictEqual(followUp.status, 409, JSON.stringify(followUp.body));
    assert.strictEqual(followUp.body.taskId, action.id);
  });

  it('racing first syncs on an unclaimed agreed deal create one action', async () => {
    const organizationId = await organization();
    const raced = await createDealAtomic(client, { organizationId, status: 'agreed', productKind: 'one-off', title: 'Synthetic race', amountEur: 900, agreementDate: today }, ADMIN);
    const outcomes = await Promise.all([1, 2, 3, 4, 5].map(() => syncDealInvoiceTask(client, String(raced.item.id))));
    assert.strictEqual(outcomes.filter((item) => item.outcome === 'created').length, 1, JSON.stringify(outcomes));
    assert.strictEqual(new Set(outcomes.map((item) => item.taskId)).size, 1);
    assert.strictEqual((await dealTasks(String(raced.item.id))).length, 1);
  });

  it('the daily finance sweep retries a recent confirmation that never synced and leaves old deals alone', async () => {
    const organizationId = await organization();
    const recent = await createDealAtomic(client, { organizationId, status: 'agreed', productKind: 'one-off', title: 'Synthetic missed sync', amountEur: 1200, agreementDate: today }, ADMIN);
    const old = await createDealAtomic(client, { organizationId, status: 'agreed', productKind: 'one-off', title: 'Synthetic old backlog', amountEur: 1200, agreementDate: '2026-01-10' }, ADMIN);
    await put(TABLE_SPONSOR_CRM, { ...old.item, PK: `DEAL#${old.item.id}`, SK: `DEAL#${old.item.id}`, updatedAt: '2026-01-10T09:00:00.000Z' });
    const first = await evaluateSponsorFinanceAlerts(client, today);
    assert.ok(first.invoiceTasksCreated >= 1);
    assert.strictEqual((await invoiceActions(String(recent.item.id))).length, 1);
    assert.deepStrictEqual(await dealTasks(String(old.item.id)), []);
    const claim = (await client.send(new GetCommand({ TableName: TABLE_SPONSOR_CRM, Key: { PK: invoiceTaskClaimKey(String(recent.item.id)), SK: invoiceTaskClaimKey(String(recent.item.id)) } }))).Item;
    assert.strictEqual(claim?.dealId, recent.item.id);
    const second = await evaluateSponsorFinanceAlerts(client, today);
    assert.strictEqual(second.invoiceTaskFailures, 0);
    assert.strictEqual((await dealTasks(String(recent.item.id))).length, 1, 'a second sweep run does not duplicate');
  });
});
