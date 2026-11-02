/**
 * Payment follow-up Tasks are chased weekly. Moving a due one forward without
 * having chased (an outgoing email) or escalated (a raised card) would hide an
 * unpaid invoice, so every re-wait or snooze of a due payment Task has to cite
 * one of the two, and the default next date is a week out.
 */
import type { Task } from './types';
import { addDays } from './relativeDates';

export const PAYMENT_FOLLOW_UP_DEFAULT_DAYS = 7;

const PAYMENT_WORDS = /\b(payment|invoice|invoices|billing|overdue payment)\b/i;

/** Finance-created follow-ups, plus sponsor-deal Tasks whose own text is about payment or billing. */
export function isPaymentFollowUpTask(task: Pick<Task, 'source' | 'tags' | 'subject' | 'description'>): boolean {
  if (task.source === 'sponsor-finance' || task.tags?.includes('payment-follow-up')) return true;
  return task.subject?.type === 'sponsor-deal' && PAYMENT_WORDS.test(String(task.description || ''));
}

export function defaultPaymentNextFollowUp(today: string): string {
  return addDays(today, PAYMENT_FOLLOW_UP_DEFAULT_DAYS);
}

const dayOf = (value: unknown) => String(value || '').slice(0, 10);

/** A payment Task is due once its follow-up (or, without one, its date) is today or earlier. */
export function isPaymentFollowUpDue(task: Pick<Task, 'date' | 'followUpAt' | 'status' | 'waitingFor'>, today: string): boolean {
  const attention = task.status === 'waiting' || task.waitingFor || task.followUpAt ? dayOf(task.followUpAt) : dayOf(task.date);
  return attention !== '' && attention <= today;
}

export type PaymentEvidence = { emailRef?: string; raisedCardId?: string };

function evidenceString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : undefined;
}

/** The email ref or raised card named on a snooze/wait request, if any. */
export function paymentEvidence(body: Record<string, unknown>): PaymentEvidence {
  const emailRef = evidenceString(body.emailRef);
  const raisedCardId = evidenceString(body.raisedCardId);
  return { ...(emailRef ? { emailRef } : {}), ...(raisedCardId ? { raisedCardId } : {}) };
}

/** An error message when a due payment follow-up is deferred without evidence; null when allowed. */
export function paymentDeferralError(task: Task, body: Record<string, unknown>, today: string): string | null {
  if (!isPaymentFollowUpTask(task) || !isPaymentFollowUpDue(task, today)) return null;
  const evidence = paymentEvidence(body);
  if (evidence.emailRef || evidence.raisedCardId) return null;
  return 'This payment follow-up is due: record the outgoing email (emailRef) or the raised card (raisedCardId) before waiting or snoozing it again';
}

/** The note with the evidence reference appended, so history shows what justified the deferral. */
export function noteWithEvidence(note: string, evidence: PaymentEvidence): string {
  const refs = [evidence.emailRef ? `email ${evidence.emailRef}` : '', evidence.raisedCardId ? `card ${evidence.raisedCardId}` : ''].filter(Boolean);
  return refs.length ? `${note} [${refs.join(', ')}]` : note;
}
