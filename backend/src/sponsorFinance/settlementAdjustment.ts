import { boundedText, CURRENCY, displayMoney, realDate, scaledMoney } from './core';
import type { FinanceEvidence } from './types';

/** A reduction in the receivable, never a cash receipt or bookkeeping income. */
export type SettlementAdjustment = {
  id: string;
  amount: string;
  currency: string;
  reason: string;
  evidence: FinanceEvidence[];
  approvedBy: string;
  approvedOn: string;
  actorId: string;
  createdAt: string;
};

export type SettlementAdjustmentInput = Omit<SettlementAdjustment, 'id' | 'actorId' | 'createdAt'>;

/** Caller authenticates an admin and atomically persists this with version checks and audit. */
export function validateSettlementAdjustment(input: unknown, context: {
  currency: string;
  outstanding: bigint;
  today: string;
  validateEvidence: (value: unknown) => FinanceEvidence[];
}): SettlementAdjustmentInput {
  const invalid = () => Object.assign(new Error('Invalid settlement adjustment'), { statusCode: 400 });
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid();
  const value = input as Record<string, unknown>;
  let amount: bigint;
  try { amount = scaledMoney(value.amount); } catch { throw invalid(); }
  if (
    !CURRENCY.test(context.currency) || value.currency !== context.currency
    || amount > context.outstanding
    || !boundedText(value.reason, 1000) || !boundedText(value.approvedBy, 160)
    || !realDate(context.today) || !realDate(value.approvedOn) || value.approvedOn > context.today
  ) throw invalid();
  const evidence = context.validateEvidence(value.evidence);
  if (!evidence.length) throw invalid();
  return {
    amount: displayMoney(amount), currency: context.currency,
    reason: String(value.reason), approvedBy: String(value.approvedBy),
    approvedOn: value.approvedOn, evidence,
  };
}

/** Cash remains independent; corrupt or over-allocated adjustments require reconciliation. */
export function settlementBalance(
  due: bigint, cash: bigint, currency: string, adjustment?: SettlementAdjustment,
): { adjusted: bigint; outstanding: bigint; coherent: boolean } {
  let adjusted = 0n;
  let coherent = due >= 0n && cash >= 0n && CURRENCY.test(currency);
  if (adjustment) {
    try { adjusted = scaledMoney(adjustment.amount); } catch { coherent = false; }
    if (adjustment.currency !== currency) coherent = false;
  }
  const remaining = due - cash - adjusted;
  return { adjusted, outstanding: remaining > 0n ? remaining : 0n, coherent: coherent && remaining >= 0n };
}
