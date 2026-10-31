/**
 * Finance summary: money in, money out and net per month, year and
 * year-to-date, in EUR, from the bookkeeping ledger. Pure: callers load the
 * rows and supply exchange rates, so the portal, the CLI and the tests all run
 * the same arithmetic. The rules are written out in SOURCE_RULES and in
 * docs/finance-summary.md; change both together.
 */

export type LedgerRow = Record<string, unknown> & { id: string };
export type StatementLine = { accountId: string; date: string; amount: string; currency: string; counterparty?: string };
export type PendingInvoice = { id: string; date: string; amount?: string; currency?: string; counterparty?: string };
export type StatementCoverage = { accountId: string; month: string };

export type PeriodQuery = { month: string } | { year: string } | { ytd: true };
export type Period = { kind: 'month' | 'year' | 'ytd'; label: string; from: string; to: string; months: string[] };

/** Units of `currency` per 1 EUR on `date` (the ECB convention). */
export type Rate = { currency: string; rate: number; date: string; source: 'ecb' };
export type RateLookup = (currency: string, date: string) => Rate | null;

export type Line = 'operating' | 'vat' | 'taxes' | 'health-insurance';

export type Entry = {
  id: string;
  date: string;
  month: string;
  direction: 'in' | 'out';
  line: Line;
  refund: boolean;
  counterparty: string;
  description: string;
  category: string;
  sourceType: string;
  amount: string;
  currency: string;
  eur: number | null;
  rate: number | null;
  rateDate: string | null;
  rateSource: 'eur' | 'booked' | 'ecb' | null;
  vatEur: number | null;
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
  entryCount: number;
  vatUnknownCount: number;
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
  conversions: Array<{ id: string; date: string; amount: string; currency: string; eur: number | null; rate: number | null; rateDate: string | null; rateSource: string | null }>;
  entries: Entry[];
  duplicates: Duplicate[];
  gaps: Gap[];
  rules: string[];
};

export const SOURCE_RULES = [
  'Ledger rows are the only thing counted. A row is there because a person or a verified flow put it there: a confirmed and published incoming invoice, a recorded sponsor payment, a platform payout, or a bookkeeping-sheet row. Pending and rejected invoice drafts never count; they are listed as gaps.',
  'A row is booked in the month it was paid (paidDate), or its transactionDate when it has no paid date. entryType income is money in, expense is money out.',
  'Issued outgoing invoices count only once paid, through the payment row. An unpaid invoice is not income.',
  'Bank and PayPal statement lines are never counted. They are evidence: a statement line with no ledger row is listed as a gap, so the payment, the invoice it settles and the bank line are counted once.',
  'A bookkeeping-sheet row that repeats an invoice, sponsor-payment or payout row (same direction, currency and amount, paid within 3 days, same payer or payee) is dropped and listed under duplicates; the non-sheet row is kept.',
  'EUR conversion: a EUR row is taken as is. A non-EUR row uses its booked EUR amount (amountEur, what the bank actually credited or debited), with the implied rate shown. Without one, the ECB reference rate for the paid date (or the last ECB business day before it) is used. A row that cannot be converted is excluded from the totals and listed as a gap.',
  'Lines: category VAT is a payment to (expense) or refund from (income) the Finanzamt for VAT; category Taxes is every other tax (Gewerbesteuer, income or corporate tax prepayments); category Health Insurance is TK. Everything else is operating income or expense. A Refund subtype income row reduces operating expenses instead of adding to income.',
  'Net profit excluding VAT = (operating income - output VAT) - (operating expenses - input VAT). Taxes and TK are shown as their own lines and in net after taxes; VAT payments and refunds are not profit or loss.',
  'Projected VAT position = output VAT - input VAT: positive is owed to the Finanzamt, negative is a refund. A row without a VAT amount counts as zero VAT and is listed as a gap, so the projection is only as complete as the VAT data.',
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

export function lineOf(row: LedgerRow): Line {
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

function vatEur(row: LedgerRow, conversion: ReturnType<typeof convert>) {
  const vat = positive(row.vatAmount);
  if (vat === null) return null;
  const currency = str(row.vatCurrency) || str(row.currency) || 'EUR';
  if (currency === 'EUR') return fromCents(cents(vat));
  if (currency === str(row.currency) && conversion.rate) return fromCents(cents(vat / conversion.rate));
  return null;
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
    otherTaxes: 0, healthInsurance: 0, netAfterTaxes: 0, entryCount: 0, vatUnknownCount: 0, unconvertedCount: 0,
  };
}

const SUMMED: Array<keyof Totals> = ['moneyIn', 'moneyOut', 'operatingIncome', 'operatingExpenses', 'outputVat', 'inputVat', 'vatPaid', 'vatRefunded', 'otherTaxes', 'healthInsurance'];

/** Totals in integer cents, then derived figures, then back to EUR. */
function total(entries: Entry[]): Totals {
  const c = Object.fromEntries(SUMMED.map((key) => [key, 0])) as Record<string, number>;
  let vatUnknownCount = 0;
  let unconvertedCount = 0;
  for (const entry of entries) {
    if (entry.eur === null) { unconvertedCount += 1; continue; }
    const value = cents(entry.eur);
    const vat = entry.vatEur === null ? 0 : cents(entry.vatEur);
    c[entry.direction === 'in' ? 'moneyIn' : 'moneyOut'] += value;
    if (entry.line === 'operating') {
      if (entry.vatEur === null) vatUnknownCount += 1;
      if (entry.direction === 'out') { c.operatingExpenses += value; c.inputVat += vat; }
      else if (entry.refund) { c.operatingExpenses -= value; c.inputVat -= vat; }
      else { c.operatingIncome += value; c.outputVat += vat; }
    } else if (entry.line === 'vat') c[entry.direction === 'out' ? 'vatPaid' : 'vatRefunded'] += value;
    else if (entry.line === 'taxes') c.otherTaxes += entry.direction === 'out' ? value : -value;
    else c.healthInsurance += entry.direction === 'out' ? value : -value;
  }
  const incomeNetOfVat = c.operatingIncome - c.outputVat;
  const expensesNetOfVat = c.operatingExpenses - c.inputVat;
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
    entryCount: entries.length,
    vatUnknownCount,
    unconvertedCount,
  };
}

export function toEntry(row: LedgerRow, rates: RateLookup): Entry | null {
  const entryType = str(row.entryType);
  if (entryType !== 'income' && entryType !== 'expense') return null;
  const date = bookingDate(row);
  const conversion = convert(row, rates);
  return {
    id: row.id,
    date,
    month: date.slice(0, 7),
    direction: entryType === 'income' ? 'in' : 'out',
    line: lineOf(row),
    refund: entryType === 'income' && str(row.subtype) === 'Refund',
    counterparty: str(row.counterparty),
    description: str(row.description),
    category: str(row.category),
    sourceType: str(row.sourceType),
    amount: str(row.amount),
    currency: str(row.currency) || 'EUR',
    eur: conversion.eur,
    rate: conversion.rate,
    rateDate: conversion.rateDate,
    rateSource: conversion.rateSource,
    vatEur: vatEur(row, conversion),
  };
}

export type SummaryInput = {
  rows: LedgerRow[];
  query: PeriodQuery;
  today: string;
  rates: RateLookup;
  pendingInvoices?: PendingInvoice[];
  statementLines?: StatementLine[];
  businessAccounts?: string[];
  statementCoverage?: StatementCoverage[];
  generatedAt?: string;
};

export function summarize(input: SummaryInput): FinanceSummary {
  const period = resolvePeriod(input.query, input.today);
  const inPeriod = (date: string) => date >= period.from && date <= period.to;
  const { kept, duplicates } = dedupe(input.rows);
  const periodRows = kept.filter((row) => inPeriod(bookingDate(row)));
  const gaps: Gap[] = [];
  const entries: Entry[] = [];
  const noDirection: string[] = [];
  for (const row of periodRows) {
    const entry = toEntry(row, input.rates);
    if (entry) entries.push(entry);
    else noDirection.push(row.id);
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
  const vatUnknown = entries.filter((entry) => entry.line === 'operating' && entry.vatEur === null);
  if (vatUnknown.length) gaps.push({ kind: 'vat-unknown', message: 'Operating rows with no VAT amount; counted as zero VAT', count: vatUnknown.length, ids: vatUnknown.map((e) => e.id) });

  const pending = (input.pendingInvoices || []).filter((invoice) => inPeriod(invoice.date));
  if (pending.length) gaps.push({ kind: 'pending-invoices', message: 'Incoming invoice drafts not yet verified; not counted until confirmed and published', count: pending.length, ids: pending.map((p) => p.id) });

  const unmatched = unmatchedStatementLines(input.statementLines || [], kept).filter((line) => inPeriod(line.date));
  if (unmatched.length) gaps.push({ kind: 'bank-line-without-ledger-row', message: 'Statement lines with no ledger row; not counted until a row is recorded', count: unmatched.length });

  const today = input.today.slice(0, 7);
  for (const month of period.months.filter((m) => m <= today)) {
    const missing = (input.businessAccounts || []).filter((account) => !(input.statementCoverage || []).some((c) => c.accountId === account && c.month === month));
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
    conversions: entries.filter((entry) => entry.currency !== 'EUR').map((entry) => ({
      id: entry.id, date: entry.date, amount: entry.amount, currency: entry.currency, eur: entry.eur, rate: entry.rate, rateDate: entry.rateDate, rateSource: entry.rateSource,
    })),
    entries,
    duplicates: periodDuplicates,
    gaps,
    rules: SOURCE_RULES,
  };
}

/**
 * Statement lines no ledger row explains: same currency and absolute amount
 * (or the row's booked EUR amount against a EUR line), within 5 days. Each
 * ledger row explains at most one line.
 */
export function unmatchedStatementLines(lines: StatementLine[], rows: LedgerRow[]): StatementLine[] {
  const used = new Set<string>();
  return lines.filter((line) => {
    const amount = positive(line.amount);
    const match = rows.find((row) => {
      if (used.has(row.id)) return false;
      if ((Number(line.amount) < 0) !== (str(row.entryType) === 'expense')) return false;
      if (dayDistance(bookingDate(row), line.date) > 5) return false;
      const sameCurrency = (str(row.currency) || 'EUR') === line.currency && positive(row.amount) === amount;
      const bookedEur = line.currency === 'EUR' && positive(row.amountEur) === amount;
      return sameCurrency || bookedEur;
    });
    if (match) used.add(match.id);
    return !match;
  });
}
