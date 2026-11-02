import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';

import { getClient } from '../src/db/client';
import { startLocal, stopLocal, createTables } from '../scripts/local-dynamodb';
import { createTask, getTask } from '../src/db/tasks';
import { berlinToday, addDays } from '../src/relativeDates';
import { deriveFollowUp } from '../src/sponsorFinance/followUp';
import { ensurePaymentFollowUpTask, paymentTasksByDeal } from '../src/sponsorFinance/overdueTasks';
import { chaseDates } from '../src/sponsorFinance/chase';
import { isPaymentFollowUpDue, isPaymentFollowUpTask, paymentDeferralError } from '../src/paymentTaskGuard';
import type { Task } from '../src/types';

const today = berlinToday();
const yesterday = addDays(today, -1);

describe('payment follow-up guard (pure)', () => {
  const finance = { source: 'sponsor-finance', tags: ['payment-follow-up'], subject: { type: 'sponsor-deal', id: 'd1' }, description: 'x' } as unknown as Task;
  it('recognises finance tasks and sponsor-deal tasks about payment', () => {
    assert.ok(isPaymentFollowUpTask(finance));
    assert.ok(isPaymentFollowUpTask({ subject: { type: 'sponsor-deal', id: 'd' }, description: 'Chase invoice 202608/40' } as Task));
    assert.ok(!isPaymentFollowUpTask({ subject: { type: 'sponsor-deal', id: 'd' }, description: 'Send logo' } as Task));
    assert.ok(!isPaymentFollowUpTask({ description: 'Pay invoice' } as Task));
  });
  it('is due on its follow-up date once waiting, otherwise on its date', () => {
    assert.ok(isPaymentFollowUpDue({ status: 'todo', date: yesterday } as Task, today));
    assert.ok(!isPaymentFollowUpDue({ status: 'waiting', date: yesterday, followUpAt: addDays(today, 3) } as Task, today));
    assert.ok(isPaymentFollowUpDue({ status: 'waiting', date: yesterday, followUpAt: today } as Task, today));
  });
  it('rejects deferring a due payment task without evidence, accepts email ref or card', () => {
    const due = { ...finance, status: 'todo', date: yesterday } as Task;
    assert.match(String(paymentDeferralError(due, {}, today)), /emailRef/);
    assert.match(String(paymentDeferralError(due, { emailRef: '  ' }, today)), /emailRef/);
    assert.strictEqual(paymentDeferralError(due, { emailRef: 'msg-1' }, today), null);
    assert.strictEqual(paymentDeferralError(due, { raisedCardId: 'card-1' }, today), null);
    assert.strictEqual(paymentDeferralError({ ...due, date: addDays(today, 2) }, {}, today), null);
    assert.strictEqual(paymentDeferralError({ ...due, source: 'x', tags: [], description: 'Send logo' } as Task, {}, today), null);
  });
});

describe('followUp code after the sponsor was chased', () => {
  const issued = { invoiceState: 'issued' as const, paymentState: 'unpaid' as const, dueOn: '2026-09-20' };
  it('is payment-follow-up, not send-invoice, once a chase is recorded without sentOn', () => {
    assert.deepStrictEqual(deriveFollowUp(issued, '2026-10-14'), { code: 'send-invoice', party: 'us' });
    assert.deepStrictEqual(
      deriveFollowUp({ ...issued, chasedOn: '2026-09-28' }, '2026-10-14'),
      { code: 'payment-follow-up', party: 'us', since: '2026-09-20', daysOverdue: 24 },
    );
  });
});

describe('overdue payment tasks and chase evidence (local DynamoDB)', () => {
  let client: Awaited<ReturnType<typeof getClient>>;
  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
  });
  after(async () => { await stopLocal(); });

  const invoice = { dealId: 'deal-a', organizationName: 'Acme', invoiceNumber: '202608/40', dueOn: '2026-09-01', daysOverdue: 60 };

  it('creates one task, is idempotent, then reopens a done one', async () => {
    assert.strictEqual(await ensurePaymentFollowUpTask(client, [], invoice, today), 'created');
    const first = (await paymentTasksByDeal(client)).get('deal-a') || [];
    assert.strictEqual(first.length, 1);
    assert.strictEqual(first[0].status, 'todo');
    assert.strictEqual(first[0].date, today);
    assert.strictEqual(await ensurePaymentFollowUpTask(client, first, invoice, today), 'existing');
    // A concurrent run that did not see the row loses the conditional write.
    assert.strictEqual(await ensurePaymentFollowUpTask(client, [], invoice, today), 'existing');
    assert.strictEqual(((await paymentTasksByDeal(client)).get('deal-a') || []).length, 1);

    const done = { ...first[0], status: 'done', completedAt: '2026-10-01T00:00:00Z' } as Task;
    assert.strictEqual(await ensurePaymentFollowUpTask(client, [done], invoice, today), 'reopened');
    const reopened = await getTask(client, first[0].id);
    assert.strictEqual(reopened?.status, 'todo');
    assert.strictEqual(reopened?.taskHistory.at(-1)?.action, 'reopened');
  });

  it('dates the first recorded follow-up on a deal task', async () => {
    await createTask(client, {
      description: 'Chase', date: yesterday, status: 'waiting', waitingFor: 'Acme', followUpAt: today,
      subject: { type: 'sponsor-deal', id: 'deal-b' },
    }, { actorId: 'tester' });
    const dates = await chaseDates(client);
    assert.strictEqual(dates.get('deal-b'), new Date().toISOString().slice(0, 10));
    assert.strictEqual((await chaseDates(client, 'deal-b')).size, 1);
    assert.ok(!dates.has('deal-a'));
  });

  describe('Task actions', () => {
    let handler: typeof import('../src/handler').handler;
    before(async () => {
      process.env.IS_LOCAL = 'true';
      handler = (await import('../src/handler')).handler;
    });
    const act = async (id: string, action: string, body: Record<string, unknown>) => handler({
      httpMethod: 'POST', path: `/api/tasks/${id}/actions/${action}`, body: JSON.stringify(body),
    }, {});
    const paymentTask = (extra: Record<string, unknown> = {}) => createTask(client, {
      description: 'Payment follow-up', date: yesterday, status: 'waiting', waitingFor: 'Sponsor', followUpAt: yesterday,
      source: 'sponsor-finance', tags: ['payment-follow-up'], subject: { type: 'sponsor-deal', id: 'deal-c' }, ...extra,
    }, { actorId: 'tester' });

    it('followed-up defaults the next follow-up to +7 days and needs an email ref or card when due', async () => {
      const task = await paymentTask();
      const base = { channel: 'email', note: 'Chased', expectedVersion: task.version };
      const rejected = await act(task.id, 'follow-up-sent', base);
      assert.strictEqual(rejected.statusCode, 422);
      assert.match(JSON.parse(rejected.body).error, /emailRef/);
      const accepted = await act(task.id, 'follow-up-sent', { ...base, emailRef: 'msg-42' });
      assert.strictEqual(accepted.statusCode, 200);
      const body = JSON.parse(accepted.body);
      assert.strictEqual(body.followUpAt, addDays(berlinToday(), 7));
      assert.match(body.taskHistory.at(-1).note, /msg-42/);
    });

    it('rejects snoozing a due payment follow-up silently; a raised card allows it', async () => {
      const task = await paymentTask({ status: 'todo', waitingFor: undefined, followUpAt: undefined });
      const request = { snoozedUntil: '+7d', reason: 'Still unpaid', expectedVersion: task.version };
      assert.strictEqual((await act(task.id, 'snooze', request)).statusCode, 422);
      assert.strictEqual((await act(task.id, 'mark-waiting', {
        waitingFor: 'Sponsor', followUpAt: '+7d', channel: 'email', note: 'n', expectedVersion: task.version,
      })).statusCode, 422);
      const ok = await act(task.id, 'snooze', { ...request, raisedCardId: 'card-1' });
      assert.strictEqual(ok.statusCode, 200);
    });

    it('leaves non-payment tasks and not-yet-due payment tasks alone', async () => {
      const other = await createTask(client, { description: 'Send logo', date: yesterday, status: 'todo' }, { actorId: 'tester' });
      assert.strictEqual((await act(other.id, 'snooze', { snoozedUntil: '+7d', reason: 'later', expectedVersion: other.version })).statusCode, 200);
      const future = await paymentTask({ status: 'todo', waitingFor: undefined, followUpAt: undefined, date: addDays(berlinToday(), 3) });
      assert.strictEqual((await act(future.id, 'snooze', { snoozedUntil: '+7d', reason: 'not due', expectedVersion: future.version })).statusCode, 200);
    });
  });
});
