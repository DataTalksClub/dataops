import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { listBookkeepingItems, listTransactions } from '../db/bookkeeping';
import { listInvoices } from '../invoices/store';
import { latestBalances, listStatements, rowKeys, type StatementRecord } from '../reconcile/service';
import { bankKeyFor, pairAll } from '../reconcile/month';
import { mergedDecisions, snapshot, type Snapshot } from '../reconcile/monthService';
import { loadEcbRates } from './rates';
import { bookingDate, dedupe, enrichLedgerFromStatement, isRefundRow, matchFinanceStatements, summarize, type FinanceSummary, type LedgerRow, type PeriodQuery, type StatementLine } from './summary';
import { classifyMandatoryPayment, taxTypeOf } from './mandatoryPayments';
import { taxesReport } from './taxes';
import { estimateTaxes } from './taxEstimate';
import { getTaxReturn, type TaxReturnRecord } from './taxReturns';
import { listTaxSchedule } from './taxSchedule';
import { upcomingDebits, type Balance, type PaidEvidence } from './upcoming';
import { businessAccountStatementRequirement } from './businessAccounts';

import { berlinToday } from '../relativeDates';

export { berlinToday };

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

/** Use the same stable bank-row identity as reconciliation, including overlapping statements. */
export function financeStatementLines(statements: StatementRecord[]): StatementLine[] {
  const seen = new Set<string>();
  const ordered = [...statements].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return ordered.flatMap((statement) => {
    const keys = rowKeys(statement.rows);
    return statement.rows.flatMap((line, index) => {
      const bankKey = bankKeyFor(statement.accountId, keys[index]);
      if (seen.has(bankKey)) return [];
      seen.add(bankKey);
      return [{ ...line, id: `${statement.id}:${index}`, bankKey, accountId: statement.accountId }];
    });
  });
}

/** Exactly the pairing used by reconciliation, including manual decisions. */
export function financePairings(data: Snapshot): Map<string, string> {
  const pairing = pairAll(data.bank, data.ledger, mergedDecisions(data.months), data.config.tolerances, undefined, {
    issuedInvoices: data.issuedInvoices, receivedInvoiceDocuments: data.receivedInvoiceDocuments,
  });
  return new Map([...pairing.pairs].map(([key, pair]) => [key, pair.ledger.id]));
}

export async function financeSummary(client: DynamoDBDocumentClient, query: PeriodQuery, today = berlinToday()): Promise<FinanceSummary & { rateErrors: string[]; taxReturn: TaxReturnRecord | null }> {
  const [rows, invoices, statements, accounts, documents, links] = await Promise.all([
    listTransactions(client),
    listInvoices(client),
    listStatements(client),
    listBookkeepingItems(client, 'account'),
    listBookkeepingItems(client, 'document'),
    listBookkeepingItems(client, 'link'),
  ]);
  const reconciliation = await snapshot(client, {
    preloaded: { statements, transactions: rows, links, documents, invoices },
    includePendingEmailInvoices: false,
  });
  const pairs = financePairings(reconciliation);
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
    statementLines: financeStatementLines(statements),
    statementPairs: pairs,
    businessAccounts: accounts
      .filter((account) => account.kind === 'business' && account.active !== false)
      .map((account) => businessAccountStatementRequirement(String(account.id))),
    statementCoverage: documents
      .filter((document) => document.documentType === 'bank-statement' && document.status === 'active')
      .map((document) => ({ accountId: String(document.accountId), month: String(document.statementMonth) })),
  });
  // A stored Bescheid record closes the year: the summary carries the official
  // figures next to the ledger-based payment buckets.
  const taxReturn = 'year' in query ? await getTaxReturn(client, Number(query.year)) : null;
  return { ...summary, rateErrors: errors, taxReturn };
}

export async function financeTaxes(client: DynamoDBDocumentClient, query: PeriodQuery, today = berlinToday()) {
  return taxesReport(await financeSummary(client, query, today), today);
}

/**
 * Rough German tax estimate for one year from the profit actually earned so
 * far: § 32a EStG tariff plus Soli and Berlin Gewerbesteuer, § 35 relief
 * applied, compared with the taxes already paid in that year. Refunds from
 * earlier years are never a negative tax here: the paid numbers come from the
 * same payment-only buckets the taxes report uses — or, once a year has a
 * stored Bescheid record, from the assessment itself. Alongside the estimate
 * it answers the planning questions: how much money the year leaves after
 * tax, and how much of the business balance is safe to withdraw now because
 * no tax is still owed on it.
 */
export async function financeTaxEstimate(client: DynamoDBDocumentClient, year: number, today = berlinToday()) {
  const [summary, balances] = await Promise.all([
    financeSummary(client, { year: String(year) }, today),
    latestBalances(client),
  ]);
  const assessment = summary.taxReturn;
  const report = taxesReport(summary, today);
  const profit = summary.totals.netProfitExVat;
  const estimate = estimateTaxes(year, profit);
  const ledgerPaid = {
    incomeTax: report.totals.taxes['income-tax'],
    tradeTax: report.totals.taxes['trade-tax'],
  };
  const paid = assessment
    ? { incomeTax: assessment.paid.incomeTax + assessment.paid.soli, tradeTax: assessment.paid.tradeTax }
    : ledgerPaid;
  const paidTotal = Math.round((paid.incomeTax + paid.tradeTax) * 100) / 100;
  const remaining = Math.round((estimate.totalEstimate - paidTotal) * 100) / 100;

  // Planning numbers per Alexey's ask: money left after tax, and the balance
  // that can be withdrawn because no estimated tax is still owed on it.
  const ownerPayEur = Math.round(summary.totals.ownerPay * 100) / 100;
  const eurBalances = balances.filter((b) => b.currency === 'EUR' && Number.isFinite(Number(b.amount)));
  const accounts = eurBalances.map((b) => ({
    accountId: b.accountId,
    wallet: b.wallet || '',
    amountEur: Math.round(Number(b.amount) * 100) / 100,
    asOf: b.asOf,
  }));
  const balanceTotalEur = accounts.length
    ? Math.round(accounts.reduce((sum, a) => sum + a.amountEur, 0) * 100) / 100
    : null;
  const projectedAfterTaxEur = Math.round((profit - estimate.totalEstimate) * 100) / 100;
  const safeToWithdrawEur = balanceTotalEur === null ? null : Math.round((balanceTotalEur - remaining) * 100) / 100;
  const balanceLabel = accounts.map((a) => `${a.accountId}${a.wallet ? `/${a.wallet}` : ''} ${a.amountEur.toFixed(2)} EUR (as of ${a.asOf})`).join(' + ');
  const planningFormula = [
    `Projected year-end money after tax = profit earned so far (${estimate.profitEur} EUR) − total tax estimate (${estimate.totalEstimate} EUR) = ${projectedAfterTaxEur} EUR. The year is not over, so this moves with every booking.`,
    `Safe to withdraw now = business account balance (${balanceLabel || 'no statements uploaded yet'}) − estimated remaining tax for ${year} (${remaining.toFixed(2)} EUR = total estimate minus taxes already paid/prepaid; negative means paid ahead, which comes back) = ${safeToWithdrawEur === null ? 'unknown until a statement is uploaded' : `${safeToWithdrawEur.toFixed(2)} EUR`}.`,
    `Owner withdrawals already made in ${year} (${ownerPayEur.toFixed(2)} EUR) are not added back: that money has already left the balance.`,
  ];

  return {
    ...estimate,
    paid,
    paidTotal,
    /** Positive: still to pay; negative: paid more than the estimate. */
    remaining,
    /** The stored Bescheid figures for this year, when the year is assessed. */
    assessment,
    planning: {
      ownerPayEur,
      businessBalance: { totalEur: balanceTotalEur, accounts },
      projectedAfterTaxEur,
      safeToWithdrawEur,
      formula: planningFormula,
    },
  };
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
  const reconciliation = await snapshot(client, {
    preloaded: { statements, transactions: rows }, includePendingEmailInvoices: false,
  });
  const ledger = rows as LedgerRow[];
  const { kept, duplicates } = dedupe(ledger);
  const canonical = new Map(duplicates.map((duplicate) => [duplicate.droppedId, duplicate.keptId]));
  const pairs = new Map([...financePairings(reconciliation)].map(([key, id]) => [key, canonical.get(id) || id]));
  const statementLines = financeStatementLines(statements);
  const matches = matchFinanceStatements(statementLines, kept, pairs);
  const evidenceTaxType = (item: Record<string, unknown>): PaidEvidence['taxType'] => {
    const classification = classifyMandatoryPayment(item);
    if (!classification) return null;
    const kind = taxTypeOf(item, classification.line);
    // Generic tax-authority text cannot distinguish an unknown tax from an explicitly recorded other tax.
    const stored = String(item.taxType ?? '').trim().toLowerCase();
    return kind === 'other' && stored !== 'other' ? null : kind;
  };
  const paid: PaidEvidence[] = [
    ...kept.flatMap((row) => {
      const statement = matches.byLedgerId.get(row.id);
      const enriched = statement ? enrichLedgerFromStatement(row, statement) : row;
      if (row.entryType !== 'expense' || isRefundRow(row) || !classifyMandatoryPayment(enriched)) return [];
      const bankEur = statement?.currency === 'EUR' && Number(statement.amount) < 0
        ? Math.abs(Number(statement.amount)) : null;
      const bookedEur = String(row.amountEur ?? '').trim() ? Number(row.amountEur) : null;
      const nativeEur = String(row.currency || 'EUR').toUpperCase() === 'EUR' ? Number(row.amount) : null;
      const amount = bankEur ?? bookedEur ?? nativeEur;
      if (amount === null || !Number.isFinite(amount) || amount <= 0) return [];
      return [{ id: row.id, date: statement?.date || bookingDate(row), amount, kind: 'ledger' as const, taxType: evidenceTaxType(enriched) }];
    }),
    ...matches.unmatched
      .filter((line) => line.currency === 'EUR' && Number(line.amount) < 0 && classifyMandatoryPayment(line))
      .map((line) => ({ id: line.id || '', date: line.date, amount: Math.abs(Number(line.amount)), kind: 'statement' as const, taxType: evidenceTaxType(line) })),
  ];
  return upcomingDebits({ schedule, today, days, paid, balance });
}
