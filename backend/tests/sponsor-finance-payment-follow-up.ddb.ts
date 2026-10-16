import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { PutCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getClient } from '../src/db/client';
import { createTables, TABLE_BOOKKEEPING, TABLE_SPONSOR_CRM, TABLE_USERS } from '../scripts/local-dynamodb';
import { invoiceIdentity } from '../src/sponsorFinance/core';
import { getFinanceState, receivePayment } from '../src/sponsorFinance/repository';
import { withPaymentFollowUpTasks } from '../src/sponsorFinance/paymentFollowUp';
import { createDealAtomic, createOrganizationAtomic } from '../src/db/sponsorCrm';
import type { FinanceProjection, LambdaEvent, LambdaResponse } from '../src/types';

// Run only through the real DynamoDB Local transaction gate. Production uses
// the canonical finance projection's TransactGet and claim-identity checks;
// tests must exercise those commands rather than weakening production for dynalite.
describe('sponsor payment follow-ups', () => {
  let client: DynamoDBDocumentClient;
  const ADMIN = 'follow-up-admin-1';
  const OPERATOR = 'follow-up-operator-1';
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

  const requestFollowUp = async (
    dealId: string, body: Record<string, unknown>, idempotencyLabel: string, userId = ADMIN,
  ) => invoke('POST', `/api/sponsor-crm/deals/${dealId}/finance/follow-up`, body, {
    'x-user-id': userId,
    'idempotency-key': `follow-up-test-key-${idempotencyLabel}`,
  });

  /** The payment follow-up view the finance projection route would attach. */
  const followUpView = async (dealId: string) => {
    const projection = await withPaymentFollowUpTasks(client, { dealId } as FinanceProjection, await getFinanceState(client, dealId));
    return projection.paymentFollowUp;
  };

  const put = (table: string, item: Record<string, unknown>) => client.send(new PutCommand({ TableName: table, Item: item }));

  let sequence = 0;
  /**
   * Seed an agreed deal with an issued, payable invoice as raw fixture rows.
   * `dueIn` days from today (negative = overdue); `recordedAmount` seeds a
   * recorded pre-ledger payment of that size.
   */
  async function bootstrapDeal(options: { dueIn?: number; issue?: boolean; recordedAmount?: string; amountDue?: string } = {}) {
    sequence += 1;
    const amountDue = options.amountDue || '1000';
    const organization = await createOrganizationAtomic(client, { displayName: `Synthetic Follow-up Sponsor ${sequence}` }, 'test');
    const deal = await createDealAtomic(
      client, { organizationId: organization.item.id, status: 'agreed', productKind: 'one-off', title: `Fall bundle ${sequence}` }, 'test',
    );
    const dealId = deal.item.id;
    const issuedOn = day(-30);
    const dueOn = day(options.dueIn ?? -7);
    const issued = options.issue !== false;
    const invoiceSourceId = `inv-src-${sequence}`;
    const invoiceSource = {
      PK: `DOCUMENT#${invoiceSourceId}`, SK: `DOCUMENT#${invoiceSourceId}`,
      id: invoiceSourceId, documentType: 'invoice', status: 'active',
      sha256: 'c'.repeat(64), objectVersionId: `obj-${sequence}`, verifiedByteSize: 800,
      createdAt: `${issuedOn}T09:00:00.000Z`, updatedAt: `${issuedOn}T09:00:00.000Z`,
    };
    const linkId = `SPONSOR_FINANCE_LINK#${dealId}#document#${invoiceSourceId}`;
    const recordedIds: string[] = [];
    if (options.recordedAmount !== undefined) {
      const paymentKey = `SPONSOR_FINANCE_PAYMENT#${dealId}#recorded-${sequence}`;
      recordedIds.push(paymentKey);
      await put(TABLE_SPONSOR_CRM, {
        PK: paymentKey, SK: paymentKey, id: paymentKey,
        recordType: 'sponsor-finance-payment', dealId, paymentId: `recorded-${sequence}`,
        receivedOn: day(-1), amount: options.recordedAmount, currency: 'EUR', method: 'bank-report',
        actorId: ADMIN, financeVersion: 2, createdAt: `${day(-1)}T09:00:00.000Z`,
      });
    }
    await put(TABLE_SPONSOR_CRM, {
      PK: `SPONSOR_FINANCE#${dealId}`, SK: `SPONSOR_FINANCE#${dealId}`,
      id: dealId, recordType: 'sponsor-finance', dealId, version: 2,
      invoiceRequirement: 'required', amountDue, currency: 'EUR', taxMode: 'included',
      ...(issued ? { invoiceNumber: `FOLLOW-UP-INV-${sequence}`, issuedOn, sentOn: issuedOn, dueOn } : {}),
      ...(issued ? { invoiceLinkId: linkId } : {}),
      paymentLinkIds: [], recordedPaymentIds: recordedIds, paymentFollowUpTaskIds: [],
      actorId: ADMIN, createdAt: `${issuedOn}T09:00:00.000Z`, updatedAt: `${issuedOn}T09:00:00.000Z`,
    });
    if (issued) {
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
    }
    return { dealId, organizationName: String(organization.item.displayName), financeVersion: 2 };
  }

  before(async () => {
    if (!process.env.DYNAMODB_ENDPOINT?.startsWith('http://127.0.0.1:')) throw new Error('Run through the DynamoDB Local transaction gate');
    client = await getClient();
    await createTables(client);
    process.env.IS_LOCAL = 'true';
    process.env.SPONSOR_FINANCE_ENABLED = 'true';
    await Promise.all([
      put(TABLE_USERS, { PK: `USER#${ADMIN}`, SK: `USER#${ADMIN}`, id: ADMIN, role: 'admin', disabled: false }),
      put(TABLE_USERS, { PK: `USER#${OPERATOR}`, SK: `USER#${OPERATOR}`, id: OPERATOR, role: 'operator', disabled: false }),
    ]);
  });

  after(async () => {
    client.destroy();
    delete process.env.IS_LOCAL;
    delete process.env.SPONSOR_FINANCE_ENABLED;
  });

  it('links an existing deal Task without recreating or changing its work', async () => {
    const seeded = await bootstrapDeal();
    const created = await invoke('POST', '/api/tasks', {
      description: 'Existing sponsor follow-up', date: day(-2), assigneeId: OPERATOR,
      subject: { type: 'sponsor-deal', id: seeded.dealId },
    }, { 'x-user-id': ADMIN });
    assert.strictEqual(created.status, 201);
    const task = created.body.task || created.body;
    const body = { dealVersion: 1, expectedVersion: seeded.financeVersion, existingTaskId: task.id };
    const linked = await requestFollowUp(seeded.dealId, body, 'link-existing');
    assert.strictEqual(linked.status, 201, JSON.stringify(linked.body));
    assert.strictEqual(linked.body.task.id, task.id);
    assert.strictEqual(linked.body.task.date, task.date);
    assert.strictEqual(linked.body.task.assigneeId, OPERATOR);
    assert.strictEqual(linked.body.task.version, task.version);
    assert.deepStrictEqual((await getFinanceState(client, seeded.dealId))!.paymentFollowUpTaskIds, [task.id]);
    const replay = await requestFollowUp(seeded.dealId, body, 'link-existing');
    assert.strictEqual(replay.body.task.id, task.id);
    assert.strictEqual(replay.body.replayed, true);
  });

  it('requires current review of open deal Tasks before adding separate work', async () => {
    const seeded = await bootstrapDeal();
    const created = await invoke('POST', '/api/tasks', {
      description: 'Other deal work', date: day(2),
      subject: { type: 'sponsor-deal', id: seeded.dealId },
    }, { 'x-user-id': ADMIN });
    assert.strictEqual(created.status, 201);
    const task = created.body.task || created.body;
    const before = { dealVersion: 1, expectedVersion: seeded.financeVersion };
    assert.strictEqual((await requestFollowUp(seeded.dealId, before, 'no-review')).status, 409);
    assert.strictEqual((await requestFollowUp(seeded.dealId, { ...before, reviewedOpenTasks: [] }, 'incomplete-review')).status, 409);
    assert.strictEqual((await requestFollowUp(seeded.dealId, { ...before, existingTaskId: 'unrelated' }, 'wrong-task')).status, 400);
    assert.strictEqual((await requestFollowUp(seeded.dealId, { ...before, reviewedOpenTasks: 'yes' }, 'invalid-review')).status, 400);
    const updated = await invoke('PUT', `/api/tasks/${task.id}`, {
      description: 'Other work changed after review', expectedVersion: task.version,
    }, { 'x-user-id': ADMIN });
    assert.strictEqual(updated.status, 200);
    const currentTask = updated.body.task || updated.body;
    assert.strictEqual((await requestFollowUp(seeded.dealId, {
      ...before, reviewedOpenTasks: [{ id: task.id, version: task.version }],
    }, 'stale-review')).status, 409);
    const reviewed = await requestFollowUp(seeded.dealId, {
      ...before, reviewedOpenTasks: [{ id: task.id, version: currentTask.version }],
    }, 'reviewed-separate');
    assert.strictEqual(reviewed.status, 201, JSON.stringify(reviewed.body));
    assert.notStrictEqual(reviewed.body.task.id, task.id);
  });

  it('makes concurrent payment follow-up creation converge on one finance-linked Task', async () => {
    const seeded = await bootstrapDeal();
    const body = { dealVersion: 1, expectedVersion: seeded.financeVersion };
    const attempts = await Promise.all([
      requestFollowUp(seeded.dealId, body, 'race-create-one'),
      requestFollowUp(seeded.dealId, body, 'race-create-two'),
    ]);
    assert.deepStrictEqual(attempts.map((result) => result.status).sort(), [201, 409]);
    assert.strictEqual((await getFinanceState(client, seeded.dealId))!.paymentFollowUpTaskIds.length, 1);
  });

  it('creates reconciliation work when the canonical invoice claim identity is inconsistent', async () => {
    const seeded = await bootstrapDeal();
    const state = await getFinanceState(client, seeded.dealId);
    const sourceId = state!.invoiceLinkId!.split('#').at(-1)!;
    const key = `SPONSOR_FINANCE_CLAIM#document#${sourceId}`;
    await client.send(new UpdateCommand({
      TableName: TABLE_BOOKKEEPING, Key: { PK: key, SK: key },
      UpdateExpression: 'SET identityToken = :bad',
      ExpressionAttributeValues: { ':bad': 'stale-claim-identity' },
    }));
    const response = await requestFollowUp(seeded.dealId,
      { dealVersion: 1, expectedVersion: seeded.financeVersion }, 'inconsistent-claim');
    assert.strictEqual(response.status, 201);
    assert.match(response.body.task.description, /Reconcile the payment evidence/);
    const after = await getFinanceState(client, seeded.dealId);
    assert.strictEqual(after!.version, seeded.financeVersion + 1);
    assert.deepStrictEqual(after!.paymentFollowUpTaskIds, [response.body.task.id]);
  });

  it('queues unclassified agreed deals and does not let a completed Task hide the missing invoice', async () => {
    const organization = await createOrganizationAtomic(client, { displayName: 'Synthetic Unclassified Sponsor' }, ADMIN);
    const deal = await createDealAtomic(client, { organizationId: organization.item.id, status: 'agreed' }, ADMIN);
    const first = await requestFollowUp(deal.item.id, { dealVersion: 1, expectedVersion: 0 }, 'unclassified-first');
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.match(first.body.task.description, /Record invoice amount/);
    const duplicate = await requestFollowUp(deal.item.id, { dealVersion: 1, expectedVersion: 0 }, 'unclassified-duplicate');
    assert.equal(duplicate.status, 409);
    const resolved = await invoke('PUT', `/api/tasks/${first.body.task.id}`, { status: 'done', expectedVersion: 1,
      comment: 'Reviewed billing requirement; invoice details still need owner confirmation.' });
    assert.equal(resolved.status, 200);
    const next = await requestFollowUp(deal.item.id, { dealVersion: 1, expectedVersion: 0 }, 'unclassified-next');
    assert.equal(next.status, 201, JSON.stringify(next.body));
    assert.notEqual(next.body.task.id, first.body.task.id);
  });

  it('creates missing-invoice work with no dates and waits for a sent invoice due date', async () => {
    const bare = await bootstrapDeal({ issue: false });
    const notIssued = await requestFollowUp(bare.dealId, { dealVersion: 1, expectedVersion: bare.financeVersion }, 'blocked-not-issued');
    assert.strictEqual(notIssued.status, 201, JSON.stringify(notIssued.body));
    assert.match(notIssued.body.task.description, /Verify or send the invoice/);

    const notOverdue = await bootstrapDeal({ dueIn: 7 });
    const response = await requestFollowUp(notOverdue.dealId, {
      dealVersion: 1, expectedVersion: notOverdue.financeVersion,
    }, 'blocked-not-overdue');
    assert.strictEqual(response.status, 422);
    assert.match(response.body.error, /not overdue/);
  });

  it('creates one payment follow-up Task in the main pool with deal, invoice, and verification context', async () => {
    const { dealId, organizationName, financeVersion } = await bootstrapDeal({});
    const response = await requestFollowUp(dealId, { dealVersion: 1, expectedVersion: financeVersion }, 'create-1');
    assert.strictEqual(response.status, 201, JSON.stringify(response.body));
    const task = response.body.task;
    assert.strictEqual(task.status, 'todo');
    assert.strictEqual(task.source, 'sponsor-finance');
    assert.deepStrictEqual(task.tags, ['payment-follow-up']);
    assert.deepStrictEqual(task.subject, { type: 'sponsor-deal', id: dealId });
    assert.strictEqual(task.date, today);
    assert.deepStrictEqual(task.proofRequirement, {
      type: 'comment', required: true, label: 'Payment verification and outcome',
    });
    assert.match(task.description, /^Follow up on the payment from /);
    assert.ok(task.description.includes(organizationName));
    assert.match(task.description, /FOLLOW-UP-INV-\d+/);
    assert.match(task.description, /1000 EUR outstanding/);
    assert.match(task.description, /record what you verified/);

    // The main task pool lists it like any other Task; the ordinary filters work.
    const pool = await invoke('GET', '/api/tasks?status=todo');
    assert.ok(pool.body.tasks.some((item: { id: string }) => item.id === task.id));

    // The deal view's open tasks (the sponsor pipeline surface) show it too.
    const dealView = await invoke('GET', `/api/sponsor-crm/deals/${dealId}`);
    assert.ok(dealView.body.openTasks.some((item: { id: string }) => item.id === task.id));

    // The finance projection composes the same open payment follow-up work for website and CLI.
    assert.deepStrictEqual(await followUpView(dealId), {
      tasks: [{ id: task.id, version: task.version, description: task.description, date: today, status: 'todo', assigneeId: task.assigneeId }],
      existingTasks: [],
    });
  });

  it('never creates a second open payment follow-up Task for the same deal', async () => {
    const { dealId, financeVersion } = await bootstrapDeal({});
    const first = await requestFollowUp(dealId, { dealVersion: 1, expectedVersion: financeVersion }, 'dup-1');
    assert.strictEqual(first.status, 201);
    const second = await requestFollowUp(dealId, { dealVersion: 1, expectedVersion: financeVersion + 1 }, 'dup-2');
    assert.strictEqual(second.status, 409);
    assert.strictEqual(second.body.taskId, first.body.task.id);

    const pool = await invoke('GET', '/api/tasks?status=todo');
    const followUps = pool.body.tasks.filter((item: { source?: string; subject?: { id: string } }) =>
      item.source === 'sponsor-finance' && item.subject?.id === dealId);
    assert.strictEqual(followUps.length, 1);
  });

  it('replays a retried creation with the same Idempotency-Key to the same Task', async () => {
    const { dealId, financeVersion } = await bootstrapDeal({});
    const first = await requestFollowUp(dealId, { dealVersion: 1, expectedVersion: financeVersion }, 'replay-1');
    assert.strictEqual(first.status, 201);
    const retry = await requestFollowUp(dealId, { dealVersion: 1, expectedVersion: financeVersion }, 'replay-1');
    assert.strictEqual(retry.status, 201);
    assert.strictEqual(retry.body.task.id, first.body.task.id);
    const pool = await invoke('GET', '/api/tasks?status=todo');
    const followUps = pool.body.tasks.filter((item: { subject?: { id: string } }) => item.subject?.id === dealId);
    assert.strictEqual(followUps.length, 1);
  });

  it('gates resolution on the payment-verification proof and allows the full waiting lifecycle', async () => {
    const { dealId, financeVersion } = await bootstrapDeal({});
    const created = await requestFollowUp(dealId, { dealVersion: 1, expectedVersion: financeVersion }, 'life-1');
    const taskId = created.body.task.id as string;

    // Without the verification comment the payment follow-up cannot be resolved done.
    const noProof = await invoke('PUT', `/api/tasks/${taskId}`, { status: 'done', expectedVersion: 1 });
    assert.strictEqual(noProof.status, 400);
    assert.match(noProof.body.error, /comment/);

    // Waiting on the sponsor carries the next follow-up date into the projection view.
    const waiting = await invoke('POST', `/api/tasks/${taskId}/actions/mark-waiting`, {
      expectedVersion: 1, waitingFor: 'Sponsor accounts team', followUpAt: day(7), channel: 'email', note: 'Sent the reminder',
    });
    assert.strictEqual(waiting.status, 200, JSON.stringify(waiting.body));
    assert.strictEqual(waiting.body.status, 'waiting');
    const followUpState = await followUpView(dealId);
    assert.strictEqual(followUpState!.tasks[0].status, 'waiting');
    assert.strictEqual(followUpState!.tasks[0].followUpAt, day(7));
    const waitingQueue = await invoke('GET', '/api/tasks?status=waiting');
    assert.ok(waitingQueue.body.tasks.some((item: { id: string }) => item.id === taskId));

    // A recorded follow-up moves the next follow-up date.
    const followedUp = await invoke('POST', `/api/tasks/${taskId}/actions/follow-up-sent`, {
      expectedVersion: 2, channel: 'email', note: 'Second reminder', nextFollowUpAt: day(14),
    });
    assert.strictEqual(followedUp.status, 200);
    assert.strictEqual(followedUp.body.followUpAt, day(14));

    // Response received returns the Task to todo; resolution still needs the proof.
    const responded = await invoke('POST', `/api/tasks/${taskId}/actions/response-received`, { expectedVersion: 3, note: 'Sponsor confirmed the payment run' });
    assert.strictEqual(responded.status, 200);
    assert.strictEqual(responded.body.status, 'todo');

    const resolved = await invoke('PUT', `/api/tasks/${taskId}`, {
      status: 'done', expectedVersion: 4,
      comment: 'Ledger and linked evidence checked today: no payment received; reminder sent and sponsor acknowledged.',
    });
    assert.strictEqual(resolved.status, 200);
    assert.strictEqual(resolved.body.status, 'done');

    // Resolved payment follow-up work leaves the projection, and a new payment follow-up may be created.
    assert.deepStrictEqual(await followUpView(dealId), { tasks: [], existingTasks: [] });
    const nextFollowUp = await requestFollowUp(dealId, { dealVersion: 1, expectedVersion: financeVersion + 1 }, 'life-2');
    assert.strictEqual(nextFollowUp.status, 201);
    assert.notStrictEqual(nextFollowUp.body.task.id, taskId);
  });

  it('stays consistent with the projection: settled money is not followed up, partial payments are', async () => {
    const settled = await bootstrapDeal();
    settled.financeVersion = (await receivePayment(client, { actorId: ADMIN, dealId: settled.dealId, dealVersion: 1, expectedVersion: settled.financeVersion, idempotencyKey: 'settled-receipt-0123456789', receivedOn: day(-1), amount: '1000', currency: 'EUR', reference: 'synthetic-account:settled-receipt', counterparty: 'Synthetic Sponsor' })).financeVersion;
    const settledFollowUp = await requestFollowUp(settled.dealId, {
      dealVersion: 1, expectedVersion: settled.financeVersion,
    }, 'blocked-paid');
    assert.strictEqual(settledFollowUp.status, 422);
    assert.match(settledFollowUp.body.error, /already settled/);

    const partial = await bootstrapDeal();
    partial.financeVersion = (await receivePayment(client, { actorId: ADMIN, dealId: partial.dealId, dealVersion: 1, expectedVersion: partial.financeVersion, idempotencyKey: 'partial-receipt-0123456789', receivedOn: day(-1), amount: '400', currency: 'EUR', reference: 'synthetic-account:partial-receipt', counterparty: 'Synthetic Sponsor' })).financeVersion;
    const partialFollowUp = await requestFollowUp(partial.dealId, {
      dealVersion: 1, expectedVersion: partial.financeVersion,
    }, 'create-partial');
    assert.strictEqual(partialFollowUp.status, 201, JSON.stringify(partialFollowUp.body));
    assert.match(partialFollowUp.body.task.description, /600 EUR outstanding/);
    assert.match(partialFollowUp.body.task.description, /partially paid/);
    const followUpState = await followUpView(partial.dealId);
    assert.strictEqual(followUpState!.tasks.length, 1);
  });

  it('keeps the existing task rules in force for payment follow-up Tasks', async () => {
    const { dealId, financeVersion } = await bootstrapDeal({});
    const created = await requestFollowUp(dealId, { dealVersion: 1, expectedVersion: financeVersion }, 'rules-1');
    const taskId = created.body.task.id as string;

    // dependsOn stays Card-only: no parallel prerequisite machinery on subject Tasks.
    const depends = await invoke('PUT', `/api/tasks/${taskId}`, { dependsOn: [taskId], expectedVersion: 1 });
    assert.strictEqual(depends.status, 400);
    assert.match(depends.body.error, /depend/i);

    // Deletion stays an admin action.
    const operatorDelete = await invoke('DELETE', `/api/tasks/${taskId}`, { expectedVersion: 1 }, { 'x-user-id': OPERATOR });
    assert.strictEqual(operatorDelete.status, 403);
    const adminDelete = await invoke('DELETE', `/api/tasks/${taskId}`, { expectedVersion: 1 }, { 'x-user-id': ADMIN });
    assert.strictEqual(adminDelete.status, 204);

    // A deleted payment follow-up stops throttling re-creation: the money still needs a payment follow-up.
    const recreated = await requestFollowUp(dealId, { dealVersion: 1, expectedVersion: financeVersion + 1 }, 'rules-2');
    assert.strictEqual(recreated.status, 201);
  });

  it('rejects a payment follow-up when the deal is lost or the actor is not a finance admin', async () => {
    const { dealId, financeVersion } = await bootstrapDeal({});
    const operatorAttempt = await requestFollowUp(dealId, {
      dealVersion: 1, expectedVersion: financeVersion,
    }, 'blocked-operator', OPERATOR);
    assert.strictEqual(operatorAttempt.status, 403);

    await put(TABLE_SPONSOR_CRM, {
      PK: `DEAL#${dealId}`, SK: `DEAL#${dealId}`,
      id: dealId, version: 2, status: 'lost', active: true,
      organizationId: 'organization-unknown', productKind: 'one-off',
    });
    const response = await requestFollowUp(dealId, { dealVersion: 2, expectedVersion: financeVersion }, 'blocked-lost');
    assert.strictEqual(response.status, 409);
  });

  it('accepts an explicit follow-up date and rejects a malformed one', async () => {
    const { dealId, financeVersion } = await bootstrapDeal({});
    const badDate = await requestFollowUp(dealId, {
      dealVersion: 1, expectedVersion: financeVersion, date: 'not-a-date',
    }, 'date-bad');
    assert.strictEqual(badDate.status, 400);
    assert.match(badDate.body.error, /date/);

    const good = await requestFollowUp(dealId, {
      dealVersion: 1, expectedVersion: financeVersion, date: day(3),
    }, 'date-good');
    assert.strictEqual(good.status, 201);
    assert.strictEqual(good.body.task.date, day(3));
  });
});
