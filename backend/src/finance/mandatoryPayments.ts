import { EXCEPTION_KINDS, type ExceptionKind } from '../reconcile/month';

export type MandatoryPaymentKind = Extract<ExceptionKind, 'tax_debit' | 'tk_debit'>;
export type MandatoryPaymentLine = 'vat' | 'taxes' | 'health-insurance';

export type MandatoryPaymentClassification = {
  kind: MandatoryPaymentKind;
  line: MandatoryPaymentLine;
  label: 'VAT' | 'Other taxes' | 'Health insurance';
};

export type MandatoryPaymentInput = {
  kind?: unknown;
  category?: unknown;
  counterparty?: unknown;
  description?: unknown;
  reference?: unknown;
};

const MANDATORY_KINDS = new Set<MandatoryPaymentKind>(
  EXCEPTION_KINDS.filter((kind): kind is MandatoryPaymentKind => kind === 'tax_debit' || kind === 'tk_debit'),
);

const text = (value: unknown) => value == null ? '' : String(value);
const TK_TEXT = /techniker\s*krankenkasse|krankenkasse|\btk\b/i;
const TAX_AUTHORITY_TEXT = /finanzamt|bundeskasse|steuerverwaltung/i;
const VAT_PURPOSE_TEXT = /umsatzsteuer|\bums\.?\s*st\b|\bust(?:va)?(?:\b|[.-])|\bvat\b/i;

/**
 * Classify the mandatory bank debits also recognized by month reconciliation.
 * Category remains a fallback for ledger rows recorded before bank matching.
 */
export function classifyMandatoryPayment(value: unknown): MandatoryPaymentClassification | null {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const category = text(input.category).trim().toLowerCase();
  const description = [input.counterparty, input.description, input.reference].map(text).join(' ');
  const suppliedKind = typeof input.kind === 'string' && MANDATORY_KINDS.has(input.kind as MandatoryPaymentKind)
    ? input.kind as MandatoryPaymentKind
    : null;

  let kind: MandatoryPaymentKind | null = suppliedKind;
  if (!kind && (category === 'health insurance' || TK_TEXT.test(description))) kind = 'tk_debit';
  if (!kind && (category === 'vat' || category === 'taxes' || TAX_AUTHORITY_TEXT.test(description))) kind = 'tax_debit';
  if (!kind) return null;

  if (kind === 'tk_debit') return { kind, line: 'health-insurance', label: 'Health insurance' };
  const vat = category === 'vat' || VAT_PURPOSE_TEXT.test(description);
  return vat
    ? { kind, line: 'vat', label: 'VAT' }
    : { kind, line: 'taxes', label: 'Other taxes' };
}
