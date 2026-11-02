import type { FinanceSummary, Entry } from './summary';
import { TAX_TYPES, type TaxType } from './mandatoryPayments';

/**
 * Tax ledger view of a finance summary: VAT (expected vs actually paid or
 * refunded), every other tax by type, and TK, per month and for the period.
 * Pure, derived from the same entries the summary uses, so the numbers match.
 */
export type TaxBucket = Record<Exclude<TaxType, 'vat'>, number>;

export type TaxMonth = {
  month: string;
  future: boolean;
  outputVat: number;
  inputVat: number;
  /** output VAT - input VAT: positive owed to the Finanzamt, negative a refund. */
  projectedVat: number;
  vatPaid: number;
  vatRefunded: number;
  /** paid - refunded: what actually moved to (+) or from (-) the Finanzamt. */
  vatSettled: number;
  /** projected - settled: still to pay (+) or to be refunded (-). */
  vatOutstanding: number;
  taxes: TaxBucket;
  otherTaxes: number;
  healthInsurance: number;
  totalTaxesAndTk: number;
};

export type TaxesReport = {
  period: FinanceSummary['period'];
  baseCurrency: 'EUR';
  generatedAt: string;
  /** The period still has days to run: the VAT position is a projection. */
  open: boolean;
  netProfitExVat: number;
  totals: Omit<TaxMonth, 'month' | 'future'>;
  months: TaxMonth[];
  entries: Entry[];
  gaps: FinanceSummary['gaps'];
  rules: string[];
};

const c = (v: number) => Math.round(v * 100);
const e = (v: number) => v / 100;

function bucketOf(entries: Entry[]): TaxBucket {
  const out = Object.fromEntries(TAX_TYPES.filter((t) => t !== 'vat').map((t) => [t, 0])) as TaxBucket;
  for (const entry of entries) {
    if (entry.line === 'vat' || entry.line === 'operating' || entry.line === 'owner-pay' || entry.eur === null) continue;
    const type = (entry.taxType || 'other') as keyof TaxBucket;
    if (type === ('vat' as string)) continue;
    out[type] = e(c(out[type]) + (entry.direction === 'out' ? c(entry.eur) : -c(entry.eur)));
  }
  return out;
}

export const TAX_RULES = [
  'Taxes come from the same entries as dataops finance summary; same source rules, dedup and EUR conversion.',
  'VAT: projected = output VAT on income - input VAT on expenses (reverse charge counts on both sides). Paid/refunded = Finanzamt VAT payments and refunds actually seen in the ledger or on a bank statement. Outstanding = projected - (paid - refunded).',
  'Other taxes are listed by tax type: income-tax (Einkommensteuer, Körperschaftsteuer, Soli), trade-tax (Gewerbesteuer), other. TK health insurance is its own line.',
  'Tax payments are not expenses: they never reduce net profit excluding VAT; they appear below it.',
];

export function taxesReport(summary: FinanceSummary, today: string): TaxesReport {
  const month = (m: { month: string; future: boolean; outputVat: number; inputVat: number; projectedVat: number; vatPaid: number; vatRefunded: number; otherTaxes: number; healthInsurance: number }, bucket: TaxBucket) => {
    const vatSettled = e(c(m.vatPaid) - c(m.vatRefunded));
    return {
      outputVat: m.outputVat, inputVat: m.inputVat, projectedVat: m.projectedVat,
      vatPaid: m.vatPaid, vatRefunded: m.vatRefunded, vatSettled,
      vatOutstanding: e(c(m.projectedVat) - c(vatSettled)),
      taxes: bucket, otherTaxes: m.otherTaxes, healthInsurance: m.healthInsurance,
      totalTaxesAndTk: e(c(m.otherTaxes) + c(m.healthInsurance) + c(vatSettled)),
    };
  };
  const months = summary.months.map((m) => ({
    month: m.month, future: m.future,
    ...month(m, bucketOf(summary.entries.filter((entry) => entry.month === m.month))),
  }));
  return {
    period: summary.period,
    baseCurrency: 'EUR',
    generatedAt: summary.generatedAt,
    open: summary.period.to >= today,
    netProfitExVat: summary.totals.netProfitExVat,
    totals: month({ month: '', future: false, ...summary.totals }, bucketOf(summary.entries)),
    months,
    entries: summary.entries.filter((entry) => entry.line === 'vat' || entry.line === 'taxes' || entry.line === 'health-insurance'),
    gaps: summary.gaps.filter((g) => ['unconverted', 'missing-statement', 'bank-line-without-ledger-row'].includes(g.kind)),
    rules: TAX_RULES,
  };
}
