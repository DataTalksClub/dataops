import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { listBookkeepingItems, listTransactions } from '../db/bookkeeping';
import { listInvoices } from '../invoices/store';
import { latestBalances, listStatements } from '../reconcile/service';
import { loadEcbRates } from './rates';
import { bookingDate, summarize, unmatchedStatementLines, type FinanceSummary, type LedgerRow, type PeriodQuery, type StatementLine } from './summary';
import { classifyMandatoryPayment } from './mandatoryPayments';
import { taxesReport } from './taxes';
import { listTaxSchedule } from './taxSchedule';
import { upcomingDebits, type Balance, type PaidEvidence } from './upcoming';
import { businessAccountStatementRequirement } from './businessAccounts';

/** Today in Berlin, where the books are kept. */
export function berlinToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function documentVatFacts(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const facts = value as Record<string, unknown>;
  return facts.vatAmount != null || facts.vatRate != null || facts.reverseCharge === true
    || (facts.netAmount != null && (facts.amount != null || facts.grossAmount != null));
}

function sameMoney(a: unknown, b: unknown) {
  const left = Number(a);
  const right = Number(b);
  return String(a ?? '').trim() !== '' && String(b ?? '').trim() !== ''
    && Number.isFinite(left) && Number.isFinite(right)
    && Math.round(left * 100) === Math.round(right * 100);
}

function linkedVatFacts(row: LedgerRow, documents: Array<Record<string, unknown>>, links: Array<Record<string, unknown>>) {
  if (documentVatFacts(row.documentExtraction)) return row.documentExtraction;
  const candidates = links
    .filter((link) => link.transactionId === row.id && link.coverageType === 'evidence')
    .map((link) => documents.find((document) => document.id === link.documentId))
    .filter((document): document is Record<string, unknown> => !!document
      && document.status === 'active'
      && ['invoice', 'receipt'].includes(String(document.documentType))
      && documentVatFacts(document.facts))
    .map((document) => document.facts as Record<string, unknown>);
  if (candidates.length === 1) return candidates[0];
  const exact = candidates.filter((facts) =>
    String(facts.currency || '') === String(row.currency || '')
    && sameMoney(facts.amount ?? facts.grossAmount, row.amount));
  if (exact.length === 1) return exact[0];
  const vatFacts = (facts: Record<string, unknown>) => JSON.stringify({
    amount: facts.amount ?? facts.grossAmount,
    currency: facts.currency,
    netAmount: facts.netAmount,
    vatAmount: facts.vatAmount,
    vatCurrency: facts.vatCurrency,
    vatRate: facts.vatRate,
    reverseCharge: facts.reverseCharge,
  });
  return exact.length > 1 && new Set(exact.map(vatFacts)).size === 1 ? exact[0] : undefined;
}

export async function financeSummary(client: DynamoDBDocumentClient, query: PeriodQuery, today = berlinToday()): Promise<FinanceSummary & { rateErrors: string[] }> {
  const [rows, invoices, statements, accounts, documents, links] = await Promise.all([
    listTransactions(client),
    listInvoices(client),
    listStatements(client),
    listBookkeepingItems(client, 'account'),
    listBookkeepingItems(client, 'document'),
    listBookkeepingItems(client, 'link'),
  ]);
  const ledger = (rows as LedgerRow[]).map((row) => {
    const facts = linkedVatFacts(row, documents, links);
    return facts ? { ...row, documentExtraction: facts } : row;
  });
  const needs = ledger
    .filter((row) => row.currency && row.currency !== 'EUR' && !row.amountEur)
    .map((row) => ({ currency: String(row.currency), date: bookingDate(row) }));
  const { lookup, errors } = await loadEcbRates(needs);
  const summary = summarize({
    rows: ledger,
    query,
    today,
    rates: lookup,
    pendingInvoices: invoices
      .filter((invoice) => invoice.status === 'pending')
      .map((invoice) => ({ id: invoice.id, date: invoice.fields.paidDate || invoice.fields.transactionDate || invoice.createdAt.slice(0, 10), amount: invoice.fields.amount, currency: invoice.fields.currency, counterparty: invoice.fields.counterparty })),
    statementLines: statements.flatMap((statement) => statement.rows.map((line, index) => ({
      ...line,
      id: `${statement.id}:${index}`,
      accountId: statement.accountId,
    }))),
    businessAccounts: accounts
      .filter((account) => account.kind === 'business' && account.active !== false)
      .map((account) => businessAccountStatementRequirement(String(account.id))),
    statementCoverage: documents
      .filter((document) => document.documentType === 'bank-statement' && document.status === 'active')
      .map((document) => ({ accountId: String(document.accountId), month: String(document.statementMonth) })),
  });
  return { ...summary, rateErrors: errors };
}

export async function financeTaxes(client: DynamoDBDocumentClient, query: PeriodQuery, today = berlinToday()) {
  return taxesReport(await financeSummary(client, query, today), today);
}

export function parsePeriodQuery(params: Record<string, string | undefined> | null | undefined): PeriodQuery | string {
  const month = params?.month;
  const year = params?.year;
  const ytd = params?.ytd;
  const given = [month, year, ytd].filter((value) => value !== undefined && value !== '').length;
  if (given !== 1) return 'Give exactly one of month=YYYY-MM, year=YYYY or ytd=1';
  if (month) return /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? { month } : 'month must be YYYY-MM';
  if (year) return /^\d{4}$/.test(year) ? { year } : 'year must be YYYY';
  return { ytd: true };
}

/**
 * Scheduled tax and TK debits around today, marked paid where a ledger row
 * or a statement line shows the debit, with the business balance check.
 */
/** Taxes are debited from Finom: its latest EUR balance from a stored statement. */
export async function finomBalance(client: DynamoDBDocumentClient): Promise<Balance | null> {
  const balance = (await latestBalances(client, 'finom')).find((b) => b.currency === 'EUR');
  return balance ? { accountId: 'finom', amount: Number(balance.amount), currency: 'EUR', asOf: balance.asOf, source: `statement ${balance.statementId}` } : null;
}

export async function financeUpcoming(client: DynamoDBDocumentClient, days: number, today = berlinToday(), loadBalance: () => Promise<Balance | null> = () => finomBalance(client)) {
  const [schedule, rows, statements, balance] = await Promise.all([
    listTaxSchedule(client), listTransactions(client), listStatements(client), loadBalance(),
  ]);
  const ledger = rows as LedgerRow[];
  const statementLines = statements.flatMap((statement) => statement.rows.map((line, index) => ({
    ...line,
    id: `${statement.id}:${index}`,
    accountId: statement.accountId,
  }))) as StatementLine[];
  const paid: PaidEvidence[] = [
    ...ledger
      .filter((row) => row.entryType === 'expense' && classifyMandatoryPayment(row))
      .map((row) => ({ id: row.id, date: bookingDate(row), amount: Number(row.amountEur || row.amount), kind: 'ledger' as const })),
    ...unmatchedStatementLines(statementLines, ledger)
      .filter((line) => line.currency === 'EUR' && Number(line.amount) < 0 && classifyMandatoryPayment(line))
      .map((line) => ({ id: line.id || '', date: line.date, amount: Math.abs(Number(line.amount)), kind: 'statement' as const })),
  ];
  return upcomingDebits({ schedule, today, days, paid, balance });
}
