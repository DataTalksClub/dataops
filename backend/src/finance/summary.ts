import { DEFAULT_TOLERANCES } from '../reconcile/month';
import { classifyMandatoryPayment, taxTypeOf, type MandatoryPaymentKind, type TaxType } from './mandatoryPayments';
import { isOwnerPayRow, ownerPayTypeOf, type OwnerPayType } from './ownerPay';
import type { BusinessAccountStatementRequirement } from './businessAccounts';

/**
 * Finance summary: money in, money out and net per month, year and
 * year-to-date, in EUR. Pure: callers load the rows and supply exchange rates,
 * so the portal, the CLI and the tests all run the same arithmetic. The rules
 * are written out in SOURCE_RULES and in docs/finance-summary.md; change both
 * together.
 */

export type LedgerRow = Record<string, unknown> & { id: string };
export type StatementLine = { id?: string; bankKey?: string; accountId: string; date: string; amount: string; currency: string; counterparty?: string; reference?: string };
export type PendingInvoice = { id: string; date: string; amount?: string; currency?: string; counterparty?: string };
export type StatementCoverage = { accountId: string; month: string };

export type PeriodQuery = { month: string } | { year: string } | { ytd: true };
export type Period = { kind: 'month' | 'year' | 'ytd'; label: string; from: string; to: string; months: string[] };

/** Units of `currency` per 1 EUR on `date` (the ECB convention). */
export type Rate = { currency: string; rate: number; date: string; source: 'ecb' };
export type RateLookup = (currency: string, date: string) => Rate | null;

export type Line = 'operating' | 'vat' | 'taxes' | 'health-insurance' | 'owner-pay';

export type Entry = {
  id: string;
  bankKey?: string;
  date: string;
  month: string;
  direction: 'in' | 'out';
  line: Line;
  /** Supplier credit note (contra-expense): reduces operating expenses. */
  refund: boolean;
  counterparty: string;
  description: string;
  category: string;
  subtype: string;
  sourceType: string;
  mandatoryKind: MandatoryPaymentKind | null;
  /** Tax a vat/taxes/health-insurance entry belongs to. */
  taxType: TaxType | null;
  /** Set on owner-pay entries. */
  ownerPayType: OwnerPayType | null;
  amount: string;
  currency: string;
  /** Exact booked EUR amount stored on the ledger row, when present. */
  amountEur: string | null;
  /** Exact conversion source text stored on the ledger row, when present. */
  bookedRateSource: string | null;
  eur: number | null;
  rate: number | null;
  rateDate: string | null;
  rateSource: 'eur' | 'booked' | 'ecb' | null;
  vatEur: number | null;
  reverseChargeVatEur: number | null;
  vatAmount: string | null;
  vatCurrency: string | null;
  vatRate: string | null;
  reverseCharge: boolean;
  zeroRated: boolean;
};

export type Totals = {
  moneyIn: number;
  moneyOut: number;
  net: number;
  operatingIncome: number;
  operatingExpenses: number;
  outputVat: number;
  inputVat: number;
  incomeNetOfVat: number;
  expensesNetOfVat: number;
  netProfitExVat: number;
  projectedVat: number;
  vatPaid: number;
  vatRefunded: number;
  otherTaxes: number;
  healthInsurance: number;
  netAfterTaxes: number;
  /** Paid to the owner personally; shown below net profit, not an expense. */
  ownerPay: number;
  netAfterOwnerPay: number;
  entryCount: number;
  unconvertedCount: number;
};

export type Gap = { kind: string; month?: string; message: string; count: number; ids?: string[] };
export type Duplicate = { keptId: string; droppedId: string; reason: string };

export type FinanceSummary = {
  period: Period;
  baseCurrency: 'EUR';
  generatedAt: string;
  totals: Totals;
  months: Array<{ month: string; future: boolean } & Totals>;
  byCurrency: Array<{ currency: string; moneyIn: string; moneyOut: string; moneyInEur: number; moneyOutEur: number }>;
  entries: Entry[];
  duplicates: Duplicate[];
  gaps: Gap[];
  rules: string[];
};

export const SOURCE_RULES = [
  'Confirmed ledger rows count, along with unmatched bank statement rows classified as TK or Finanzamt mandatory debits. Pending and rejected invoice drafts never count; they are listed as gaps.',
  'A row is booked in the month it was paid (paidDate), or its transactionDate when it has no paid date. entryType income is money in, expense is money out.',
  'Issued outgoing invoices count only once paid, through the payment row. An unpaid invoice is not income.',
  'Bank statement lines matching a ledger row are counted once through that row. Unmatched TK and Finanzamt debit lines are counted directly; other unmatched statement lines are listed as gaps.',
  'A bookkeeping-sheet row that repeats an invoice, sponsor-payment or payout row (same direction, currency and amount, paid within 3 days, same payer or payee) is dropped and listed under duplicates; the non-sheet row is kept.',
  'EUR conversion: a EUR row is taken as is. A non-EUR row uses its booked EUR amount (amountEur, what the bank actually credited or debited), with the implied rate shown. Without one, the ECB reference rate for the paid date (or the last ECB business day before it) is used. A row that cannot be converted is excluded from the totals and listed as a gap.',
  'Lines: category VAT or a Finanzamt USt/UMS.ST purpose in the ledger row or its matched statement reference is VAT paid/refunded; other Finanzamt tax purposes are other taxes; TK/Health Insurance is health insurance. These mandatory payments do not affect operating profit.',
  'VAT uses the reviewed ledger vatAmount first, then linked stored document VAT facts. If VAT amount is absent, an explicit VAT rate and net amount or the document gross-minus-net amount determine it; explicit 0% remains zero. Reverse-charge VAT is derived only from an explicit rate and net amount and is counted as both output and input VAT. No rate or source VAT fields means zero VAT.',
  'Refunds from suppliers (credit notes: rows with subtype Refund or a credit-note:<number> source key) are contra-expense: they reduce operating expenses, their VAT reduces input VAT, and they are not money in and not revenue.',
  'Owner pay: ledger rows with category Owner pay (ownerPayType salary, draw, reimbursement or unknown, decided from the booking text and counterparty) are money paid to the owner personally. They are money out, never operating expenses, and appear on their own line below net profit; net after owner pay = net after taxes and TK - owner pay.',
  'Tax types: a mandatory payment carries a taxType (vat, income-tax, trade-tax, health-insurance, other), the stored row value first, otherwise derived from the booking text (Gewerbesteuer = trade-tax; Einkommensteuer, Körperschaftsteuer, Soli = income-tax). Category VAT without a decisive text stays vat. dataops finance taxes shows them per period.',
  'Net profit excluding VAT = (operating income - output VAT) - (operating expenses - input VAT); supplier refunds reduce the expense side. Taxes and TK are shown as their own lines and in net after taxes; VAT payments and refunds are not profit or loss.',
  'Projected VAT position = output VAT - input VAT: positive is owed to the Finanzamt, negative is a refund. Missing VAT fields contribute zero and do not create a warning.',
];

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const YEAR = /^\d{4}$/;

export function resolvePeriod(query: PeriodQuery, today: string): Period {
  const currentMonth = today.slice(0, 7);
  if ('month' in query) {
    if (!MONTH.test(query.month)) throw new RangeError('month must be YYYY-MM');
    return { kind: 'month', label: query.month, from: `${query.month}-01`, to: monthEnd(query.month), months: [query.month] };
  }
  if ('year' in query) {
    if (!YEAR.test(query.year)) throw new RangeError('year must be YYYY');
    const months = Array.from({ length: 12 }, (_, i) => `${query.year}-${String(i + 1).padStart(2, '0')}`);
    return { kind: 'year', label: query.year, from: `${query.year}-01-01`, to: `${query.year}-12-31`, months };
  }
  const year = today.slice(0, 4);
  const months = Array.from({ length: Number(currentMonth.slice(5)) }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
  return { kind: 'ytd', label: `${year} YTD (to ${today})`, from: `${year}-01-01`, to: today, months };
}

function monthEnd(month: string) {
  const [y, m] = month.split('-').map(Number);
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}

const cents = (value: number) => Math.round(value * 100);
const fromCents = (value: number) => value / 100;
const str = (value: unknown) => (value === undefined || value === null ? '' : String(value));
const positive = (value: unknown) => {
  const n = Number(value);
  return str(value).trim() !== '' && Number.isFinite(n) ? Math.abs(n) : null;
};

export function bookingDate(row: LedgerRow) {
  return str(row.paidDate) || str(row.transactionDate);
}

/** A supplier credit note however its entryType was recorded. */
export const isRefundRow = (row: LedgerRow) => str(row.subtype) === 'Refund' || str(row.sourceKey).startsWith('credit-note:');

export function lineOf(row: LedgerRow): Line {
  if (isOwnerPayRow(row)) return 'owner-pay';
  const mandatory = classifyMandatoryPayment(row);
  if (mandatory) return mandatory.line;
  const category = str(row.category);
  if (category === 'VAT') return 'vat';
  if (category === 'Taxes') return 'taxes';
  if (category === 'Health Insurance') return 'health-insurance';
  return 'operating';
}

/** EUR value of a row plus how it was converted; null eur when no rate exists. */
export function convert(row: LedgerRow, rates: RateLookup) {
  const amount = positive(row.amount);
  const currency = str(row.currency) || 'EUR';
  const date = bookingDate(row);
  if (amount === null) return { eur: null, rate: null, rateDate: null, rateSource: null } as const;
  if (currency === 'EUR') return { eur: fromCents(cents(amount)), rate: 1, rateDate: date, rateSource: 'eur' } as const;
  const booked = positive(row.amountEur);
  if (booked) return { eur: fromCents(cents(booked)), rate: round6(amount / booked), rateDate: date, rateSource: 'booked' } as const;
  const ecb = rates(currency, date);
  if (!ecb) return { eur: null, rate: null, rateDate: null, rateSource: null } as const;
  return { eur: fromCents(cents(amount / ecb.rate)), rate: ecb.rate, rateDate: ecb.date, rateSource: 'ecb' } as const;
}

const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

function documentVatFacts(row: LedgerRow): Record<string, unknown> | null {
  const value = row.documentExtraction;
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function vatAmounts(row: LedgerRow, conversion: ReturnType<typeof convert>, rates: RateLookup) {
  const facts = documentVatFacts(row);
  const reverseCharge = row.reverseCharge === true || facts?.reverseCharge === true;
  const directVat = row.vatAmount !== undefined && row.vatAmount !== null;
  const extractedVat = !directVat && facts?.vatAmount !== undefined && facts?.vatAmount !== null;
  const sourceVat = directVat ? row.vatAmount : extractedVat ? facts?.vatAmount : null;
  const explicitVat = positive(sourceVat);
  let vat = explicitVat;
  let reverseChargeVat: number | null = null;
  let derivedFromRate = false;
  const net = positive(facts?.netAmount ?? row.netAmount);
  const rate = positive(facts?.vatRate ?? row.vatRate);
  const gross = positive(facts?.amount ?? facts?.grossAmount);

  if (reverseCharge && rate !== null && net !== null) {
    reverseChargeVat = fromCents(cents(net * rate / 100));
    if (vat === null) vat = reverseChargeVat;
    derivedFromRate = true;
  } else if (reverseCharge && explicitVat !== null && explicitVat > 0) {
    reverseChargeVat = explicitVat;
  } else if (!reverseCharge && vat === null && rate !== null && net !== null) {
    vat = fromCents(cents(net * rate / 100));
    derivedFromRate = true;
  } else if (!reverseCharge && vat === null && gross !== null && net !== null) {
    vat = fromCents(cents(Math.max(0, gross - net)));
  }
  const missingVat = vat === null;
  const vatAmount = vat ?? 0;
  const vatRate = facts?.vatRate ?? row.vatRate;
  const rateText = vatRate === undefined || vatRate === null || String(vatRate).trim() === '' ? null : String(vatRate);
  const currency = directVat
    ? str(row.vatCurrency) || str(row.currency) || 'EUR'
    : str(facts?.vatCurrency) || str(facts?.currency) || str(row.vatCurrency) || str(row.currency) || 'EUR';
  const storedVatEur = directVat ? positive(row.vatAmountEur) : extractedVat ? positive(facts?.vatAmountEur) : null;
  const netEur = derivedFromRate ? positive(facts?.netAmountEur) : null;
  let eur: number | null = missingVat ? 0 : storedVatEur === null ? null : fromCents(cents(storedVatEur));
  if (eur === null && netEur !== null && rate !== null) eur = fromCents(cents(netEur * rate / 100));
  if (eur === null) {
    if (currency === 'EUR') eur = fromCents(cents(vatAmount));
    else if (currency === str(row.currency) && conversion.rate) eur = fromCents(cents(vatAmount / conversion.rate));
    else {
      const ecb = rates(currency, bookingDate(row));
      if (ecb) eur = fromCents(cents(vatAmount / ecb.rate));
    }
  }
  let reverseChargeEur: number | null = null;
  if (reverseChargeVat !== null) {
    const storedReverseChargeEur = derivedFromRate
      ? rate !== null && netEur !== null ? fromCents(cents(netEur * rate / 100)) : null
      : storedVatEur === null ? null : fromCents(cents(storedVatEur));
    reverseChargeEur = storedReverseChargeEur;
    if (reverseChargeEur === null) {
      if (currency === 'EUR') reverseChargeEur = fromCents(cents(reverseChargeVat));
      else if (currency === str(row.currency) && conversion.rate) reverseChargeEur = fromCents(cents(reverseChargeVat / conversion.rate));
      else {
        const ecb = rates(currency, bookingDate(row));
        if (ecb) reverseChargeEur = fromCents(cents(reverseChargeVat / ecb.rate));
      }
    }
  }
  return {
    vatEur: reverseCharge && explicitVat === null ? 0 : eur,
    reverseChargeVatEur: missingVat && reverseCharge ? 0 : reverseChargeEur,
    vatAmount: vatAmount.toFixed(2),
    vatCurrency: currency,
    vatRate: rateText,
    reverseCharge,
    zeroRated: rate === 0,
  };
}

const SYSTEM_SOURCES = new Set(['invoice', 'sponsor-receipt', 'payout']);
const nameKey = (value: unknown) => str(value).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6);
const dayDistance = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;

/** Drop sheet rows that repeat an invoice/receipt/payout row; see SOURCE_RULES. */
export function dedupe(rows: LedgerRow[]): { kept: LedgerRow[]; duplicates: Duplicate[] } {
  const system = rows.filter((row) => SYSTEM_SOURCES.has(str(row.sourceType)));
  const claimed = new Set<string>();
  const duplicates: Duplicate[] = [];
  const dropped = new Set<string>();
  for (const row of rows) {
    if (str(row.sourceType) !== 'spreadsheet') continue;
    const twin = system.find((candidate) =>
      !claimed.has(candidate.id)
      && str(candidate.entryType) === str(row.entryType)
      && (str(candidate.currency) || 'EUR') === (str(row.currency) || 'EUR')
      && positive(candidate.amount) === positive(row.amount)
      && dayDistance(bookingDate(candidate), bookingDate(row)) <= 3
      && nameKey(candidate.counterparty) !== ''
      && nameKey(candidate.counterparty) === nameKey(row.counterparty));
    if (!twin) continue;
    claimed.add(twin.id);
    dropped.add(row.id);
    duplicates.push({ keptId: twin.id, droppedId: row.id, reason: `sheet row repeats ${str(twin.sourceType)} row` });
  }
  return { kept: rows.filter((row) => !dropped.has(row.id)), duplicates };
}

function emptyTotals(): Totals {
  return {
    moneyIn: 0, moneyOut: 0, net: 0, operatingIncome: 0, operatingExpenses: 0, outputVat: 0, inputVat: 0,
    incomeNetOfVat: 0, expensesNetOfVat: 0, netProfitExVat: 0, projectedVat: 0, vatPaid: 0, vatRefunded: 0,
    otherTaxes: 0, healthInsurance: 0, netAfterTaxes: 0, ownerPay: 0, netAfterOwnerPay: 0, entryCount: 0, unconvertedCount: 0,
  };
}

const SUMMED: Array<keyof Totals> = ['moneyIn', 'moneyOut', 'operatingIncome', 'operatingExpenses', 'outputVat', 'inputVat', 'vatPaid', 'vatRefunded', 'otherTaxes', 'healthInsurance', 'ownerPay'];

/** Totals in integer cents, then derived figures, then back to EUR. */
function total(entries: Entry[]): Totals {
  const c = Object.fromEntries(SUMMED.map((key) => [key, 0])) as Record<string, number>;
  let unconvertedCount = 0;
  let reverseChargeInputVat = 0;
  let reverseChargeOutputVat = 0;
  for (const entry of entries) {
    if (entry.eur === null) { unconvertedCount += 1; continue; }
    const value = cents(entry.eur);
    const vat = entry.vatEur === null ? 0 : cents(entry.vatEur);
    const reverseChargeVat = entry.reverseChargeVatEur === null ? 0 : cents(entry.reverseChargeVatEur);
    if (entry.line === 'operating' && entry.refund) {
      // A supplier credit note is contra-expense however its entryType was
      // recorded: it reduces operating expenses and their input VAT, and is
      // neither money in, money out, nor revenue.
      c.operatingExpenses -= value;
      c.inputVat -= vat + reverseChargeVat;
      c.outputVat -= reverseChargeVat;
      reverseChargeInputVat -= reverseChargeVat;
      reverseChargeOutputVat -= reverseChargeVat;
      continue;
    }
    c[entry.direction === 'in' ? 'moneyIn' : 'moneyOut'] += value;
    if (entry.line === 'operating') {
      if (entry.direction === 'out') {
        c.operatingExpenses += value;
        c.inputVat += vat + reverseChargeVat;
        c.outputVat += reverseChargeVat;
        reverseChargeInputVat += reverseChargeVat;
        reverseChargeOutputVat += reverseChargeVat;
      }
      else { c.operatingIncome += value; c.outputVat += vat; }
    } else if (entry.line === 'vat') c[entry.direction === 'out' ? 'vatPaid' : 'vatRefunded'] += value;
    else if (entry.line === 'taxes') c.otherTaxes += entry.direction === 'out' ? value : -value;
    else if (entry.line === 'owner-pay') c.ownerPay += entry.direction === 'out' ? value : -value;
    else c.healthInsurance += entry.direction === 'out' ? value : -value;
  }
  const incomeNetOfVat = c.operatingIncome - (c.outputVat - reverseChargeOutputVat);
  const expensesNetOfVat = c.operatingExpenses - (c.inputVat - reverseChargeInputVat);
  const netProfitExVat = incomeNetOfVat - expensesNetOfVat;
  const out = emptyTotals();
  for (const key of SUMMED) (out[key] as number) = fromCents(c[key]);
  return {
    ...out,
    net: fromCents(c.moneyIn - c.moneyOut),
    incomeNetOfVat: fromCents(incomeNetOfVat),
    expensesNetOfVat: fromCents(expensesNetOfVat),
    netProfitExVat: fromCents(netProfitExVat),
    projectedVat: fromCents(c.outputVat - c.inputVat),
    netAfterTaxes: fromCents(netProfitExVat - c.otherTaxes - c.healthInsurance),
    netAfterOwnerPay: fromCents(netProfitExVat - c.otherTaxes - c.healthInsurance - c.ownerPay),
    entryCount: entries.length,
    unconvertedCount,
  };
}

export function toEntry(row: LedgerRow, rates: RateLookup): Entry | null {
  const entryType = str(row.entryType);
  if (entryType !== 'income' && entryType !== 'expense') return null;
  const date = bookingDate(row);
  const conversion = convert(row, rates);
  const mandatory = classifyMandatoryPayment(row);
  const vat = vatAmounts(row, conversion, rates);
  const line = isOwnerPayRow(row) ? 'owner-pay' : mandatory?.line || lineOf(row);
  return {
    id: row.id,
    date,
    month: date.slice(0, 7),
    direction: entryType === 'income' ? 'in' : 'out',
    line,
    refund: isRefundRow(row),
    counterparty: str(row.counterparty),
    description: str(row.description),
    category: str(row.category),
    subtype: str(row.subtype),
    sourceType: str(row.sourceType),
    mandatoryKind: line === 'owner-pay' ? null : mandatory?.kind || null,
    taxType: line === 'vat' || line === 'taxes' || line === 'health-insurance' ? taxTypeOf(row, line) : null,
    ownerPayType: line === 'owner-pay' ? ownerPayTypeOf(row.ownerPayType) : null,
    amount: str(row.amount),
    currency: str(row.currency) || 'EUR',
    amountEur: str(row.amountEur) || null,
    bookedRateSource: str(row.rateSource) || null,
    eur: conversion.eur,
    rate: conversion.rate,
    rateDate: conversion.rateDate,
    rateSource: conversion.rateSource,
    vatEur: vat.vatEur,
    reverseChargeVatEur: vat.reverseChargeVatEur,
    vatAmount: vat.vatAmount,
    vatCurrency: vat.vatCurrency,
    vatRate: vat.vatRate,
    reverseCharge: vat.reverseCharge,
    zeroRated: vat.zeroRated,
  };
}

function toMandatoryStatementEntry(line: StatementLine, index: number, rates: RateLookup): Entry | null {
  const mandatory = classifyMandatoryPayment(line);
  const amount = positive(line.amount);
  if (!mandatory || amount === null || amount === 0) return null;
  const row: LedgerRow = {
    id: line.id || `statement:${line.accountId}:${line.date}:${index}`,
    transactionDate: line.date,
    paidDate: line.date,
    entryType: Number(line.amount) < 0 ? 'expense' : 'income',
    amount: String(amount),
    currency: line.currency || 'EUR',
    counterparty: line.counterparty || '',
    description: line.reference || '',
    category: mandatory.line === 'vat' ? 'VAT' : mandatory.line === 'taxes' ? 'Taxes' : 'Health Insurance',
    sourceType: 'statement',
  };
  const entry = toEntry(row, rates);
  return entry && line.bankKey ? { ...entry, bankKey: line.bankKey } : entry;
}

export type SummaryInput = {
  rows: LedgerRow[];
  query: PeriodQuery;
  today: string;
  rates: RateLookup;
  pendingInvoices?: PendingInvoice[];
  statementLines?: StatementLine[];
  businessAccounts?: BusinessAccountStatementRequirement[];
  statementCoverage?: StatementCoverage[];
  generatedAt?: string;
};

export function summarize(input: SummaryInput): FinanceSummary {
  const period = resolvePeriod(input.query, input.today);
  const inPeriod = (date: string) => date >= period.from && date <= period.to;
  const { kept, duplicates } = dedupe(input.rows);
  const statementMatches = matchStatementLines(input.statementLines || [], kept);
  const periodRows = kept
    .map((row) => {
      const reference = statementMatches.byLedgerId.get(row.id)?.reference;
      if (!reference) return row;
      return { ...row, reference: [str(row.reference), reference].filter(Boolean).join(' ') };
    })
    .filter((row) => inPeriod(bookingDate(row)));
  const gaps: Gap[] = [];
  const entries: Entry[] = [];
  const noDirection: string[] = [];
  for (const row of periodRows) {
    const entry = toEntry(row, input.rates);
    if (entry) entries.push(entry);
    else noDirection.push(row.id);
  }
  const unmatched = statementMatches.unmatched.filter((line) => inPeriod(line.date));
  for (const [index, line] of unmatched.entries()) {
    const entry = toMandatoryStatementEntry(line, index, input.rates);
    if (entry) entries.push(entry);
  }
  entries.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const periodDuplicates = duplicates.filter((d) => periodRows.some((row) => row.id === d.keptId));

  const months = period.months.map((month) => ({
    month,
    future: month > input.today.slice(0, 7),
    ...total(entries.filter((entry) => entry.month === month)),
  }));

  const currencies = new Map<string, { in: number; out: number; inEur: number; outEur: number }>();
  for (const entry of entries) {
    if (entry.refund) continue; // contra-expense: never money in or out
    const bucket = currencies.get(entry.currency) || { in: 0, out: 0, inEur: 0, outEur: 0 };
    const original = cents(positive(entry.amount) || 0);
    const eur = entry.eur === null ? 0 : cents(entry.eur);
    if (entry.direction === 'in') { bucket.in += original; bucket.inEur += eur; } else { bucket.out += original; bucket.outEur += eur; }
    currencies.set(entry.currency, bucket);
  }

  const unconverted = entries.filter((entry) => entry.eur === null);
  if (unconverted.length) gaps.push({ kind: 'unconverted', message: 'Rows without a usable amount or exchange rate; left out of the totals', count: unconverted.length, ids: unconverted.map((e) => e.id) });
  if (noDirection.length) gaps.push({ kind: 'no-direction', message: 'Rows whose entryType is neither income nor expense; left out of the totals', count: noDirection.length, ids: noDirection });
  const ecbConverted = entries.filter((entry) => entry.rateSource === 'ecb');
  if (ecbConverted.length) gaps.push({ kind: 'no-booked-eur', message: 'Non-EUR rows without the EUR amount the bank booked; converted at the ECB reference rate', count: ecbConverted.length, ids: ecbConverted.map((e) => e.id) });
  const pending = (input.pendingInvoices || []).filter((invoice) => inPeriod(invoice.date));
  if (pending.length) gaps.push({ kind: 'pending-invoices', message: 'Incoming invoice drafts not yet verified; not counted until confirmed and published', count: pending.length, ids: pending.map((p) => p.id) });

  const unclassified = unmatched.filter((line) => !classifyMandatoryPayment(line));
  if (unclassified.length) gaps.push({ kind: 'bank-line-without-ledger-row', message: 'Unclassified statement lines with no ledger row; not counted until a row is recorded', count: unclassified.length });

  const today = input.today.slice(0, 7);
  for (const month of period.months.filter((m) => m <= today)) {
    const missing = (input.businessAccounts || [])
      .filter((account) => account.requiredFromMonth === undefined || month >= account.requiredFromMonth)
      .filter((account) => account.requiredThroughMonth === undefined || month <= account.requiredThroughMonth)
      .filter((account) => !(input.statementCoverage || []).some((c) => c.accountId === account.id && c.month === month))
      .map((account) => account.id);
    if (missing.length) gaps.push({ kind: 'missing-statement', month, message: `No bank statement stored for ${missing.join(', ')}`, count: missing.length });
  }

  return {
    period,
    baseCurrency: 'EUR',
    generatedAt: input.generatedAt || new Date().toISOString(),
    totals: total(entries),
    months,
    byCurrency: [...currencies.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, b]) => ({
      currency,
      moneyIn: (b.in / 100).toFixed(2),
      moneyOut: (b.out / 100).toFixed(2),
      moneyInEur: fromCents(b.inEur),
      moneyOutEur: fromCents(b.outEur),
    })),
    entries,
    duplicates: periodDuplicates,
    gaps,
    rules: SOURCE_RULES,
  };
}

/**
 * Statement lines no ledger row explains: same currency and absolute amount
 * (or the row's booked EUR amount against a EUR line), within the reconciliation
 * date-lag tolerance. Each ledger row explains at most one line.
 */
function matchStatementLines(lines: StatementLine[], rows: LedgerRow[]) {
  const used = new Set<string>();
  const unmatched: StatementLine[] = [];
  const byLedgerId = new Map<string, StatementLine>();
  for (const line of lines) {
    const amount = positive(line.amount);
    const match = rows.find((row) => {
      if (used.has(row.id)) return false;
      // A refund row is explained by the money that came back (a credit line).
      if ((Number(line.amount) < 0) !== (str(row.entryType) === 'expense' && !isRefundRow(row))) return false;
      if (dayDistance(bookingDate(row), line.date) > DEFAULT_TOLERANCES.dateLagDays) return false;
      const sameCurrency = (str(row.currency) || 'EUR') === line.currency && positive(row.amount) === amount;
      const bookedEur = line.currency === 'EUR' && positive(row.amountEur) === amount;
      return sameCurrency || bookedEur;
    });
    if (match) {
      used.add(match.id);
      byLedgerId.set(match.id, line);
    } else unmatched.push(line);
  }
  return { byLedgerId, unmatched };
}

export function unmatchedStatementLines(lines: StatementLine[], rows: LedgerRow[]): StatementLine[] {
  return matchStatementLines(lines, rows).unmatched;
}
