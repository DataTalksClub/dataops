import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  berlinDate,
  displayMoney,
  invoiceIdentity,
  MAX_PAYMENT_LINK_TRANSACTION_ACTIONS,
  PAYMENT_LINK_LIMIT,
  paymentIdentity,
  realDate,
  scaledMoney,
} from '../src/sponsorFinance/core';
import { handleSponsorFinanceRoutes } from '../src/routes/sponsorFinance';
import { ENTITY_SPECS, OMITTED_ENTITIES } from '../src/export/portable';
import { classifyFinance, listFinanceCandidates } from '../src/sponsorFinance/repository';

describe('sponsor finance contracts', () => {
  it('uses exact four-place scaled integer money arithmetic', () => {
    assert.equal(scaledMoney('1'), 10_000n);
    assert.equal(scaledMoney('1.0'), 10_000n);
    assert.equal(scaledMoney('1.0000'), 10_000n);
    assert.equal(scaledMoney('999999999999.9999'), 9_999_999_999_999_999n);
    assert.equal(displayMoney(scaledMoney('10.1250') - scaledMoney('0.125')), '10');
    for (const invalid of ['0', '-1', '+1', '01', '1e2', ' 1', '1.00000', '1000000000000']) {
      assert.throws(() => scaledMoney(invalid), invalid);
    }
    assert.equal(scaledMoney('0', true), 0n);
  });

  it('keeps the 20-link contract within the current DynamoDB transaction limit', () => {
    assert.equal(PAYMENT_LINK_LIMIT, 20);
    assert.equal(MAX_PAYMENT_LINK_TRANSACTION_ACTIONS, 46);
    assert.ok(MAX_PAYMENT_LINK_TRANSACTION_ACTIONS <= 100);
  });

  it('validates real dates and formats the Europe/Berlin date deterministically', () => {
    assert.equal(realDate('2024-02-29'), true);
    assert.equal(realDate('2026-02-29'), false);
    assert.equal(realDate('2026-13-01'), false);
    assert.equal(berlinDate(new Date('2026-07-30T22:30:00.000Z')), '2026-07-31');
    assert.equal(berlinDate(new Date('2026-03-29T00:30:00.000Z')), '2026-03-29');
    assert.equal(berlinDate(new Date('2026-03-29T22:30:00.000Z')), '2026-03-30');
    assert.equal(berlinDate(new Date('2026-10-25T22:30:00.000Z')), '2026-10-25');
  });

  it('binds invoice and payment identities to their exact authority fields', () => {
    const invoice = {
      id: 'invoice-1',
      status: 'active',
      documentType: 'invoice',
      sha256: 'a'.repeat(64),
      objectVersionId: 'version-1',
      verifiedByteSize: 500,
      updatedAt: 'ignored',
    };
    assert.equal(invoiceIdentity(invoice), invoiceIdentity({ ...invoice, updatedAt: 'changed' }));
    assert.notEqual(invoiceIdentity(invoice), invoiceIdentity({ ...invoice, objectVersionId: 'version-2' }));
    const payment = {
      id: 'payment-1',
      updatedAt: '2026-07-30T10:00:00.000Z',
      amount: '10.0000',
      currency: 'EUR',
    };
    assert.notEqual(paymentIdentity(payment), paymentIdentity({ ...payment, amount: '10.0001' }));
    assert.throws(() => paymentIdentity({ ...payment, currency: 'eur' }));
  });

  it('checks the default-off flag before any database read', async () => {
    const previous = process.env.SPONSOR_FINANCE_ENABLED;
    delete process.env.SPONSOR_FINANCE_ENABLED;
    let calls = 0;
    const response = await handleSponsorFinanceRoutes(
      '/api/sponsor-crm/bookings/booking-1/finance',
      'GET',
      { headers: { 'x-user-id': 'admin-1' }, body: null },
      { send: async () => { calls++; throw new Error('must not read'); } } as never,
    );
    if (previous === undefined) delete process.env.SPONSOR_FINANCE_ENABLED;
    else process.env.SPONSOR_FINANCE_ENABLED = previous;
    assert.equal(response?.statusCode, 404);
    assert.equal(calls, 0);
    assert.deepEqual(JSON.parse(response!.body), { error: 'Finance follow-through is disabled' });
  });

  it('explicitly omits every sponsor-finance record family from public restore data', () => {
    for (const name of [
      'sponsor_finance_state',
      'sponsor_finance_links',
      'sponsor_finance_claims',
      'sponsor_finance_history',
      'sponsor_finance_receipts',
      'sponsor_finance_alerts',
    ]) assert.ok(OMITTED_ENTITIES.includes(name), name);
    const notifications = ENTITY_SPECS.find((spec) => spec.name === 'notifications')!;
    assert.equal(notifications.filter?.({
      type: 'sponsor-finance',
      metadata: { financeFingerprint: 'opaque' },
    }), false);
    assert.equal(notifications.filter?.({ type: 'follow-up-due', metadata: {} }), true);
  });

  it('reports an unprovable transaction result as an explicit redacted unknown outcome', async () => {
    let gets = 0;
    const client = {
      send: async (command: { constructor: { name: string } }) => {
        if (command.constructor.name === 'GetCommand') {
          gets++;
          if (gets <= 3) return {};
          throw Object.assign(new Error('synthetic disconnect'), { name: 'TimeoutError' });
        }
        throw Object.assign(new Error('synthetic uncertain write'), { name: 'TimeoutError' });
      },
    };
    await assert.rejects(
      () => classifyFinance(client as never, {
        actorId: 'admin-1',
        bookingId: 'booking-1',
        bookingVersion: 1,
        idempotencyKey: 'unknown-0123456789abcdef',
        body: { invoiceRequirement: 'not-required' },
      }),
      (error: Error & { statusCode?: number; outcome?: string }) => (
        error.statusCode === 503
        && error.outcome === 'outcome_unknown'
        && !error.message.includes('synthetic')
      ),
    );
  });

  it('keeps TransactionInProgress ambiguous until the durable receipt proves success', async () => {
    const client = {
      send: async (command: { constructor: { name: string } }) => {
        if (command.constructor.name === 'GetCommand') return {};
        throw Object.assign(new Error('still processing'), { name: 'TransactionInProgressException' });
      },
    };
    await assert.rejects(
      () => classifyFinance(client as never, {
        actorId: 'admin-1',
        bookingId: 'booking-1',
        bookingVersion: 1,
        idempotencyKey: 'in-progress-0123456789abcdef',
        body: { invoiceRequirement: 'not-required' },
      }),
      (error: Error & { statusCode?: number; outcome?: string }) =>
        error.statusCode === 503 && error.outcome === 'outcome_unknown',
    );
  });

  it('maps only a proven conditional transaction cancellation to a safe conflict', async () => {
    const client = {
      send: async (command: { constructor: { name: string } }) => {
        if (command.constructor.name === 'GetCommand') return {};
        throw Object.assign(new Error('cancelled'), {
          name: 'TransactionCanceledException',
          CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }],
        });
      },
    };
    await assert.rejects(
      () => classifyFinance(client as never, {
        actorId: 'admin-1',
        bookingId: 'booking-1',
        bookingVersion: 1,
        idempotencyKey: 'conditional-0123456789abcdef',
        body: { invoiceRequirement: 'not-required' },
      }),
      (error: Error & { statusCode?: number }) => error.statusCode === 409,
    );
  });

  it('fails bounded candidate discovery on a repeated storage cursor', async () => {
    let scans = 0;
    const client = {
      send: async (command: { constructor: { name: string } }) => {
        if (command.constructor.name !== 'ScanCommand') return {};
        scans++;
        return {
          Items: [],
          ScannedCount: 1,
          LastEvaluatedKey: { PK: 'BOOKKEEPING#cycle', SK: 'BOOKKEEPING#cycle' },
        };
      },
    };
    await assert.rejects(
      () => listFinanceCandidates(client as never, { kind: 'transaction', currency: 'EUR', limit: 10 }),
      (error: Error & { statusCode?: number }) => error.statusCode === 503,
    );
    assert.equal(scans, 2);
  });

  it('enforces the 5,000-row discovery budget in each DynamoDB Scan request', async () => {
    const limits: number[] = [];
    const oversizedTerminalClient = {
      send: async (command: { constructor: { name: string }; input: { Limit?: number } }) => {
        assert.equal(command.constructor.name, 'ScanCommand');
        limits.push(Number(command.input.Limit));
        return { Items: [], ScannedCount: 5_001 };
      },
    };
    await assert.rejects(
      () => listFinanceCandidates(oversizedTerminalClient as never, {
        kind: 'transaction', currency: 'EUR', limit: 10,
      }),
      (error: Error & { statusCode?: number }) => error.statusCode === 503,
    );
    assert.deepEqual(limits, [5_001]);

    let page = 0;
    const remainingBudgetClient = {
      send: async (command: { constructor: { name: string }; input: { Limit?: number } }) => {
        assert.equal(command.constructor.name, 'ScanCommand');
        limits.push(Number(command.input.Limit));
        page++;
        return page === 1
          ? { Items: [], ScannedCount: 4_999, LastEvaluatedKey: { PK: 'next', SK: 'next' } }
          : { Items: [], ScannedCount: 2 };
      },
    };
    await assert.rejects(
      () => listFinanceCandidates(remainingBudgetClient as never, {
        kind: 'transaction', currency: 'EUR', limit: 10,
      }),
      (error: Error & { statusCode?: number }) => error.statusCode === 503,
    );
    assert.deepEqual(limits, [5_001, 5_001, 2]);
  });
});
