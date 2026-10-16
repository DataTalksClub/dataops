import type { FollowUp, InvoiceState, PaymentState, TimingState, WaitingOn } from './types';

export function daysBetween(from: string, to: string): number {
  return Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export type FollowUpInput = {
  dealStatus?: string;
  invoiceState: InvoiceState;
  paymentState: PaymentState;
  requestBy?: string;
  expectedInvoiceBy?: string;
  dueOn?: string;
  waitingOn?: WaitingOn;
  /** Latest delivered (published) deliverable date, if any deliverable is delivered. */
  deliveredOn?: string;
};

/**
 * The one thing that should happen next on a deal's money, and who has to act.
 * Derived on every read; never stored.
 */
export function deriveFollowUp(input: FollowUpInput, today: string): FollowUp {
  const { invoiceState, paymentState, waitingOn } = input;
  if (invoiceState === 'unclassified') {
    return input.dealStatus === 'agreed' ? { code: 'classify', party: 'us' } : { code: 'none', party: 'none' };
  }
  if (invoiceState === 'voided' || invoiceState === 'not-required') return { code: 'none', party: 'none' };
  if (paymentState === 'reconciliation-required') return { code: 'reconcile', party: 'us' };
  if (paymentState === 'paid') return { code: 'none', party: 'none' };
  if (waitingOn?.party === 'us') return { code: 'unblock', party: 'us', since: waitingOn.since, reason: waitingOn.reason };
  if (invoiceState === 'issued') {
    if (input.dueOn && input.dueOn < today) {
      return { code: 'payment-follow-up', party: 'us', since: input.dueOn, daysOverdue: daysBetween(input.dueOn, today) };
    }
    if (waitingOn) return { code: 'await-sponsor', party: 'sponsor', since: waitingOn.since, reason: waitingOn.reason };
    return { code: 'await-payment', party: 'sponsor', ...(input.dueOn ? { since: input.dueOn } : {}) };
  }
  if (waitingOn) return { code: 'await-sponsor', party: 'sponsor', since: waitingOn.since, reason: waitingOn.reason };
  const deadline = [input.requestBy, input.expectedInvoiceBy].filter(Boolean).sort()[0];
  if (input.deliveredOn && input.deliveredOn <= today) return { code: 'send-invoice', party: 'us', since: input.deliveredOn };
  if (deadline && deadline < today) return { code: 'send-invoice', party: 'us', since: deadline };
  return { code: 'invoice-later', party: 'none', ...(deadline ? { since: deadline } : {}) };
}

const URGENCY: Record<FollowUp['code'], number> = {
  reconcile: 0,
  unblock: 1,
  'payment-follow-up': 2,
  'send-invoice': 3,
  classify: 4,
  'await-sponsor': 5,
  'await-payment': 6,
  'invoice-later': 7,
  none: 8,
};

export function followUpUrgency(followUp: FollowUp): number {
  return URGENCY[followUp.code];
}

export function deriveStates(
  state: {
    voidedAt?: string; invoiceRequirement: 'required' | 'not-required'; issuedOn?: string;
    invoiceRequestedAt?: string; amountDue?: string; dueOn?: string;
  },
  paidScaled: bigint,
  amountDueScaled: bigint | undefined,
  coherent: boolean,
  today: string,
): { invoiceState: InvoiceState; paymentState: PaymentState; timingState: TimingState } {
  const invoiceState: InvoiceState = state.voidedAt ? 'voided'
    : state.invoiceRequirement === 'not-required' ? 'not-required'
      : state.issuedOn ? 'issued'
        : state.invoiceRequestedAt ? 'requested' : 'to-request';
  const paymentState: PaymentState = !coherent ? 'reconciliation-required'
    : state.invoiceRequirement === 'not-required' ? 'not-applicable'
      : paidScaled === 0n ? 'unpaid'
        : amountDueScaled !== undefined && paidScaled === amountDueScaled ? 'paid' : 'partially-paid';
  const timingState: TimingState = paymentState === 'not-applicable' ? 'not-applicable'
    : paymentState === 'paid' ? 'settled'
      : state.dueOn && state.dueOn < today ? 'overdue' : 'not-due';
  return { invoiceState, paymentState, timingState };
}
