import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scaledMoney } from '../src/sponsorFinance/core';
import { settlementBalance, validateSettlementAdjustment, type SettlementAdjustment } from '../src/sponsorFinance/settlementAdjustment';
import type { FinanceEvidence } from '../src/sponsorFinance/types';

const evidence: FinanceEvidence[] = [{ kind: 'note', ref: 'task:owner-approval' }];
const input = { amount: '7.5000', currency: 'EUR', reason: 'Owner accepted the bank fee shortfall', approvedBy: 'Owner', approvedOn: '2026-01-02', evidence };
const context = { currency: 'EUR', outstanding: scaledMoney('7.5'), today: '2026-01-03', validateEvidence: (value: unknown) => value as FinanceEvidence[] };
const adjustment = (): SettlementAdjustment => ({ ...validateSettlementAdjustment(input, context), id: 'adjustment-1', actorId: 'admin-1', createdAt: '2026-01-03T12:00:00Z' });

describe('explicit noncash settlement adjustments', () => {
  it('canonicalizes approved reductions and discards caller-supplied audit identities', () => {
    const value = validateSettlementAdjustment({ ...input, id: 'forged', actorId: 'forged', createdAt: 'forged' }, context);
    assert.equal(value.amount, '7.5');
    assert.deepEqual(Object.keys(value).sort(), ['amount', 'approvedBy', 'approvedOn', 'currency', 'evidence', 'reason']);
  });

  it('requires explicit approval, a real nonfuture date, reason and evidence', () => {
    for (const patch of [{ approvedBy: '' }, { reason: '' }, { approvedOn: '2026-02-30' }, { approvedOn: '2026-01-04' }, { evidence: [] }]) {
      assert.throws(() => validateSettlementAdjustment({ ...input, ...patch }, context));
    }
    assert.throws(() => validateSettlementAdjustment(input, { ...context, validateEvidence: () => { throw new Error('Invalid evidence'); } }));
  });

  it('rejects invalid amounts, currency conversion and reductions exceeding the remaining receivable', () => {
    for (const amount of ['0', '-1', '1e2', '7.5001']) assert.throws(() => validateSettlementAdjustment({ ...input, amount }, context));
    assert.throws(() => validateSettlementAdjustment({ ...input, currency: 'USD' }, context));
    assert.throws(() => validateSettlementAdjustment(input, { ...context, outstanding: -1n }));
  });

  it('settles cash plus an approved adjustment without changing nominal or cash', () => {
    const due = scaledMoney('800');
    const cash = scaledMoney('792.5');
    assert.deepEqual(settlementBalance(due, cash, 'EUR', adjustment()), { adjusted: scaledMoney('7.5'), outstanding: 0n, coherent: true });
    assert.equal(cash, scaledMoney('792.5'));
    assert.equal(due, scaledMoney('800'));
    assert.deepEqual(settlementBalance(due, cash, 'EUR'), { adjusted: 0n, outstanding: scaledMoney('7.5'), coherent: true });
  });

  it('retains a partial outstanding balance and detects over-settlement or corrupt persisted adjustments', () => {
    assert.equal(settlementBalance(scaledMoney('800'), scaledMoney('700'), 'EUR', adjustment()).outstanding, scaledMoney('92.5'));
    assert.equal(settlementBalance(scaledMoney('800'), scaledMoney('801'), 'EUR').coherent, false);
    assert.equal(settlementBalance(scaledMoney('800'), scaledMoney('799'), 'EUR', adjustment()).coherent, false);
    assert.equal(settlementBalance(scaledMoney('800'), scaledMoney('700'), 'EUR', { ...adjustment(), currency: 'USD' }).coherent, false);
    assert.equal(settlementBalance(scaledMoney('800'), scaledMoney('700'), 'EUR', { ...adjustment(), amount: '-7' }).coherent, false);
  });
});
