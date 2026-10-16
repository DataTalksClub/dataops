export const DEAL_STATUSES = new Set(['open', 'agreed', 'lost']);
export const PRODUCT_KINDS = new Set(['one-off', 'package', 'course']);
export const CHANNELS = new Set(['main', 'secondary', 'standalone', 'social', 'podcast', 'webinar', 'workshop', 'course', 'other']);
export const NEXT_ACTION_TYPES = new Set(['follow_up', 'send_invoice', 'chase_payment', 'chase_materials', 'send_stats', 'other']);
export const LOST_REASONS = new Set(['no_budget', 'no_reply', 'wrong_fit', 'timing', 'other']);
export const MONEY_STATES = ['none', 'invoiced', 'partial', 'paid', 'overdue'] as const;
export type MoneyState = (typeof MONEY_STATES)[number];

export type NextAction = { type: string; due: string; owner: string; note: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function realDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  return new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

export function dayDiff(from: string, to: string): number {
  return Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

export function registrableDomain(urlOrHost: unknown): string | null {
  if (typeof urlOrHost !== 'string' || !urlOrHost.trim()) return null;
  let host = urlOrHost.trim().toLowerCase();
  try {
    if (host.includes('://')) host = new URL(host).hostname;
    else if (host.includes('/') && host.includes('.')) host = new URL(`https://${host}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^www\./, '').replace(/\.$/, '');
  if (!host || host.includes(' ') || !host.includes('.')) return null;
  return host;
}

export function parseNextAction(value: unknown): NextAction | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!NEXT_ACTION_TYPES.has(String(record.type)) || !realDate(record.due) || typeof record.owner !== 'string' || !record.owner.trim() || record.owner.length > 128) {
    return null;
  }
  if (record.note !== undefined && (typeof record.note !== 'string' || record.note.length > 500)) return null;
  return { type: String(record.type), due: String(record.due), owner: String(record.owner).trim(), note: typeof record.note === 'string' ? record.note : '' };
}

export function dealIsRotting(deal: Record<string, unknown>): boolean {
  const status = String(deal.status || '');
  if (status !== 'open' && status !== 'agreed') return false;
  const action = deal.nextAction as NextAction | null | undefined;
  return !action || !action.type || !action.due || !action.owner;
}

/** The money facts the CRM reads from the deal's sponsor finance state. */
export type DealMoneyFacts = {
  invoiceState: string;
  paymentState: string;
  timingState: string;
  followUp: { code: string; party: string; since?: string; daysOverdue?: number };
  amountDue?: string;
  currency?: string;
  invoiceNumber?: string;
  dueOn?: string;
  outstanding?: string;
  lastPaymentOn?: string;
};

export function deriveMoney(facts: DealMoneyFacts | undefined): MoneyState {
  if (!facts || facts.invoiceState !== 'issued') return 'none';
  if (facts.paymentState === 'paid') return 'paid';
  if (facts.timingState === 'overdue') return 'overdue';
  if (facts.paymentState === 'partially-paid') return 'partial';
  return 'invoiced';
}

export function deriveFulfillment(deliverables: Array<Record<string, unknown>>): 'none' | 'not-started' | 'in-delivery' | 'delivered' {
  if (!deliverables.length) return 'none';
  if (deliverables.every((item) => item.publishedAt)) return 'delivered';
  if (deliverables.some((item) => item.publishedAt || item.plannedPublicationDate)) return 'in-delivery';
  return 'not-started';
}

export function relationshipTag(
  organization: Record<string, unknown>,
  deals: Array<Record<string, unknown>>,
  today: string,
): 'customer' | 'talking' | 'dormant' | 'prospect' {
  const paid = deals.some((deal) => deal.money === 'paid');
  const live = deals.some((deal) => deal.status === 'open' || deal.status === 'agreed');
  const last = String(organization.lastInboundAt || organization.lastOutboundAt || '').slice(0, 10);
  const hasLast = Boolean(last && realDate(last));
  const quietDays = hasLast ? dayDiff(last, today) : 0;
  if (paid && hasLast && quietDays > 540) return 'dormant';
  if (paid) return 'customer';
  if (live || (organization.lastOutboundAt && quietDays <= 90)) return 'talking';
  return 'prospect';
}

export function dealIsComplete(
  deal: Record<string, unknown>,
  facts: DealMoneyFacts | undefined,
  deliverables: Array<Record<string, unknown>>,
): boolean {
  if (String(deal.status || '') === 'lost') return true;
  const money = facts?.invoiceState === 'not-required' ? 'paid' : deriveMoney(facts);
  const fulfillment = deriveFulfillment(deliverables);
  return money === 'paid' && (fulfillment === 'delivered' || fulfillment === 'none');
}
