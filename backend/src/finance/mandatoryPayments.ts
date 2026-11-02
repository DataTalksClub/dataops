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
  const storedType = text(input.taxType).trim().toLowerCase();
  if (!kind && storedType && storedType !== 'health-insurance') kind = 'tax_debit';
  if (!kind) return null;

  if (storedType === 'health-insurance') return { kind: 'tk_debit', line: 'health-insurance', label: 'Health insurance' };
  if (kind === 'tax_debit' && storedType) {
    return storedType === 'vat' ? { kind, line: 'vat', label: 'VAT' } : { kind, line: 'taxes', label: 'Other taxes' };
  }
  if (kind === 'tk_debit') return { kind, line: 'health-insurance', label: 'Health insurance' };
  const vat = category === 'vat' || VAT_PURPOSE_TEXT.test(description);
  return vat
    ? { kind, line: 'vat', label: 'VAT' }
    : { kind, line: 'taxes', label: 'Other taxes' };
}

export type TaxType = 'vat' | 'income-tax' | 'trade-tax' | 'health-insurance' | 'other';
export const TAX_TYPES: TaxType[] = ['vat', 'income-tax', 'trade-tax', 'health-insurance', 'other'];

const TRADE_TAX_TEXT = /gewerbesteuer|\bgewst\b|trade\s*tax/i;
const INCOME_TAX_TEXT = /einkommensteuer|\best\b|k(?:ö|oe)rperschaftsteuer|\bkst\b|solidarit(?:ä|ae)ts|\bsoli\b|income\s*tax|corporate\s*tax/i;

/**
 * The tax a mandatory payment belongs to. A stored row taxType wins; otherwise
 * it is derived from the booking text. Plain "Taxes" rows without a decisive
 * text are "other".
 */
export function taxTypeOf(value: unknown, line: MandatoryPaymentLine): TaxType {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const stored = text(input.taxType).trim().toLowerCase();
  if ((TAX_TYPES as string[]).includes(stored)) return stored as TaxType;
  if (line === 'health-insurance') return 'health-insurance';
  if (line === 'vat') return 'vat';
  const description = [input.counterparty, input.description, input.reference].map(text).join(' ');
  if (TRADE_TAX_TEXT.test(description)) return 'trade-tax';
  if (INCOME_TAX_TEXT.test(description)) return 'income-tax';
  return 'other';
}
