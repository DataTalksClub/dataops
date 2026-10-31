import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { listBookkeepingItems, listTransactions } from '../db/bookkeeping';
import { listInvoices } from '../invoices/store';
import { latestBalances, listStatements } from '../reconcile/service';
import { loadEcbRates } from './rates';
import { bookingDate, summarize, type FinanceSummary, type LedgerRow, type PeriodQuery } from './summary';
import { listTaxSchedule } from './taxSchedule';
import { upcomingDebits, type Balance, type PaidEvidence } from './upcoming';

/** Today in Berlin, where the books are kept. */
export function berlinToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export async function financeSummary(client: DynamoDBDocumentClient, query: PeriodQuery, today = berlinToday()): Promise<FinanceSummary & { rateErrors: string[] }> {
  const [rows, invoices, statements, accounts, documents] = await Promise.all([
    listTransactions(client),
    listInvoices(client),
    listStatements(client),
    listBookkeepingItems(client, 'account'),
    listBookkeepingItems(client, 'document'),
  ]);
  const ledger = rows as LedgerRow[];
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
    statementLines: statements.flatMap((statement) => statement.rows.map((line) => ({ ...line, accountId: statement.accountId }))),
    businessAccounts: accounts.filter((account) => account.kind === 'business' && account.active !== false).map((account) => String(account.id)),
    statementCoverage: documents
      .filter((document) => document.documentType === 'bank-statement' && document.status === 'active')
      .map((document) => ({ accountId: String(document.accountId), month: String(document.statementMonth) })),
  });
  return { ...summary, rateErrors: errors };
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

const TAX_LINES = new Set(['VAT', 'Taxes', 'Health Insurance']);

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
  const paid: PaidEvidence[] = [
    ...(rows as LedgerRow[])
      .filter((row) => row.entryType === 'expense' && (TAX_LINES.has(String(row.category || '')) || /finanzamt|krankenkasse/i.test(String(row.counterparty || ''))))
      .map((row) => ({ id: row.id, date: bookingDate(row), amount: Number(row.amountEur || row.amount), kind: 'ledger' as const })),
    ...statements.flatMap((statement) => statement.rows
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.currency === 'EUR' && Number(line.amount) < 0)
      .map(({ line, index }) => ({ id: `${statement.id}:${index}`, date: line.date, amount: Math.abs(Number(line.amount)), kind: 'statement' as const }))),
  ];
  return upcomingDebits({ schedule, today, days, paid, balance });
}
