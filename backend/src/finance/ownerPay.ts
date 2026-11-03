/**
 * Owner pay: money the company pays to its owner personally. Kept apart from
 * expenses and taxes; the summary shows it below net profit.
 *
 * A ledger row counts as owner pay when its category is "Owner pay"; the kind
 * is its ownerPayType. classifyOwnerPayCandidate is the detection used by the
 * dry-run and write-back script (scripts/finance-owner-pay.mjs) on rows that
 * are not yet categorised: it reads counterparty and booking text only.
 */
export const OWNER_PAY_CATEGORY = 'Owner pay';
export const OWNER_PAY_TYPES = ['salary', 'draw', 'reimbursement', 'unknown'] as const;
export type OwnerPayType = (typeof OWNER_PAY_TYPES)[number];

const text = (value: unknown) => (value == null ? '' : String(value));

export function ownerPayTypeOf(value: unknown): OwnerPayType {
  const type = text(value).trim().toLowerCase();
  return (OWNER_PAY_TYPES as readonly string[]).includes(type) ? type as OwnerPayType : 'unknown';
}

export function isOwnerPayRow(row: Record<string, unknown>) {
  return text(row.category).trim().toLowerCase() === OWNER_PAY_CATEGORY.toLowerCase();
}

/** A stored owner draw stays in the ledger but is omitted from accountant reports. */
export function isOwnerWithdrawalReportExempt(row: { category?: unknown; ownerPayType?: unknown }) {
  return text(row.category).trim().toLowerCase() === OWNER_PAY_CATEGORY.toLowerCase()
    && ownerPayTypeOf(row.ownerPayType) === 'draw';
}

export type OwnerPayCandidate = { ownerPayType: OwnerPayType; reason: string };

const SALARY = /gesch(?:ä|ae)ftsf(?:ü|ue)hrergehalt|\bgehalt\b|\blohn\b|salary|payroll|verg(?:ü|ue)tung/i;
const DRAW = /privatentnahme|\bentnahme\b|owner'?s?\s*draw|\bdraw\b|private\s*withdrawal/i;
const REIMBURSEMENT = /erstattung|auslagen|reimburs|expense\s*refund/i;

/**
 * Detect a transfer from a DTC account to the owner personally. `ownerNames`
 * are lowercase name fragments of the owner as they appear on the bank side.
 * Outgoing money only; the counterparty must be the owner.
 */
export function classifyOwnerPayCandidate(
  value: { counterparty?: unknown; description?: unknown; reference?: unknown; entryType?: unknown; amount?: unknown },
  ownerNames: string[],
): OwnerPayCandidate | null {
  const outgoing = value.entryType === 'expense' || (value.entryType === undefined && Number(value.amount) < 0);
  if (!outgoing) return null;
  const counterparty = text(value.counterparty).toLowerCase();
  if (!ownerNames.some((name) => name && counterparty.includes(name.toLowerCase()))) return null;
  const booking = `${text(value.description)} ${text(value.reference)}`;
  if (SALARY.test(booking)) return { ownerPayType: 'salary', reason: 'booking text names salary' };
  if (DRAW.test(booking)) return { ownerPayType: 'draw', reason: 'booking text names a private withdrawal' };
  if (REIMBURSEMENT.test(booking)) return { ownerPayType: 'reimbursement', reason: 'booking text names a reimbursement' };
  return { ownerPayType: 'unknown', reason: 'transfer to the owner without a decisive booking text' };
}
