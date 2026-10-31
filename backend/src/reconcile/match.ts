/**
 * Month-end matching. Statement rows are paired with sponsor deals through
 * three strategies, strongest first: the invoice number inside the payment
 * reference, a stored counterparty alias (or the organization's own name),
 * and finally amount+currency inside the invoice date window. A row's ledger
 * twin (the BOOKKEEPING transaction imported from the accountant's sheet) is
 * attached when one pairs, so confirm can link the existing ledger row
 * instead of creating a receipt.
 */
import { createHash } from "crypto";
import type { StatementRow } from "./parsers";

const DAY = 86_400_000;
const MIN_INVOICE_TOKEN = 4;
const MIN_ALIAS_TOKEN = 3;
const WINDOW_BEFORE_ISSUED_DAYS = 10;
const WINDOW_AFTER_DUE_DAYS = 60;

export type DealFinanceFacts = {
  dealId: string;
  dealName: string;
  organizationName?: string;
  invoiceNumber?: string;
  amountDue?: string;
  currency?: string;
  issuedOn?: string;
  dueOn?: string;
  voided: boolean;
};

export type AliasRecord = { id: string; alias: string; sponsor: string };

export type LedgerTransaction = {
  id: string;
  transactionDate?: string;
  paidDate?: string;
  amount?: string;
  currency?: string;
  counterparty?: string;
  sponsorDealId?: string;
};

export type MatchStrategy = "invoice-number" | "alias" | "amount-window";
export type MatchConfidence = "exact" | "strong" | "proposed";

export type MatchItem = {
  matchId: string;
  statementId: string;
  rowIndex: number;
  row: StatementRow;
  dealId: string;
  dealName: string;
  invoiceNumber?: string;
  amountDue?: string;
  issuedOn?: string;
  dueOn?: string;
  strategy: MatchStrategy;
  confidence: MatchConfidence;
  transactionId?: string;
  transactionClaimedBy?: string;
};

export type AmbiguousMatch = {
  statementId: string;
  rowIndex: number;
  row: StatementRow;
  candidates: Array<{ dealId: string; dealName: string; strategy: MatchStrategy; invoiceNumber?: string }>;
};

export type UnmatchedIncoming = {
  statementId: string;
  rowIndex: number;
  row: StatementRow;
  transactionId?: string;
  transactionClaimedBy?: string;
};

export type MissingPayment = {
  dealId: string;
  dealName: string;
  invoiceNumber?: string;
  amountDue?: string;
  currency?: string;
  issuedOn?: string;
  dueOn?: string;
  daysOverdue?: number;
};

export type StatementSummary = {
  id: string;
  accountId: string;
  documentId?: string;
  filename?: string;
  period: string;
  rowCount: number;
  incomingCount: number;
  /** In-period rows dropped because an earlier-uploaded statement of the same account already holds them. */
  duplicateCount?: number;
  from?: string;
  to?: string;
};

export type CoverageGap = { from: string; to: string };

export type ReconcileReport = {
  period: string;
  statements: StatementSummary[];
  matched: MatchItem[];
  ambiguous: AmbiguousMatch[];
  unmatchedIncoming: UnmatchedIncoming[];
  missingPayments: MissingPayment[];
  coverage: {
    daysInPeriod: number;
    accounts: Array<{ accountId: string; statementCount: number; coveredDays: number; gaps: CoverageGap[] }>;
    accountsWithoutStatement: string[];
  };
  totals: { incomingCount: number; matchedCount: number; unmatchedCount: number; ambiguousCount: number };
};

export const normalizeToken = (value: string): string =>
  String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** "20260636" in a reference finds invoice "202606/36"; punctuation is ignored. */
export function referenceMatchesInvoice(reference: string | undefined, invoiceNumber: string | undefined): boolean {
  if (!reference || !invoiceNumber) return false;
  const row = normalizeToken(reference), invoice = normalizeToken(invoiceNumber);
  return invoice.length >= MIN_INVOICE_TOKEN && (row === invoice || row.includes(invoice));
}

export function matchIdFor(statementId: string, rowIndex: number, dealId: string): string {
  return createHash("sha256").update(`${statementId}|${rowIndex}|${dealId}`).digest("hex").slice(0, 16);
}

function amountEqual(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) return false;
  return Math.abs(Number(left) - Number(right)) <= 0.004;
}

function invoiceWindow(facts: DealFinanceFacts): { from: number; to: number } | null {
  const issued = facts.issuedOn ? Date.parse(`${facts.issuedOn}T00:00:00Z`) : NaN;
  const due = facts.dueOn ? Date.parse(`${facts.dueOn}T00:00:00Z`) : NaN;
  if (!Number.isFinite(issued) && !Number.isFinite(due)) return null;
  const from = (Number.isFinite(issued) ? issued : due) - WINDOW_BEFORE_ISSUED_DAYS * DAY;
  const to = (Number.isFinite(due) ? due : issued) + WINDOW_AFTER_DUE_DAYS * DAY;
  return { from, to };
}

function aliasHit(counterparty: string, alias: string): boolean {
  const row = normalizeToken(counterparty), token = normalizeToken(alias);
  return token.length >= MIN_ALIAS_TOKEN && (row.includes(token) || token.includes(row));
}

type LedgerPair = { transaction?: LedgerTransaction; claimedBy?: string };

function pairLedger(row: StatementRow, ledger: LedgerTransaction[]): LedgerPair {
  const candidates = ledger.filter((item) =>
    amountEqual(row.amount, item.amount)
    && (item.currency || "").toUpperCase() === row.currency
    && Math.abs(
      Date.parse(`${(item.paidDate || item.transactionDate || "").slice(0, 10)}T00:00:00Z`)
        - Date.parse(`${row.date}T00:00:00Z`),
    ) <= 3 * DAY
    && Number.isFinite(Date.parse(`${(item.paidDate || item.transactionDate || "")}T00:00:00Z`)));
  const counterpart = normalizeToken(row.counterparty);
  candidates.sort((left, right) =>
    Number(aliasHit(right.counterparty || "", counterpart || " ")) - Number(aliasHit(left.counterparty || "", counterpart || " ")));
  const best = candidates[0];
  return best ? { transaction: best, claimedBy: best.sponsorDealId } : {};
}

export type MatchInput = {
  statements: Array<StatementSummary & { rows: StatementRow[] }>;
  finance: DealFinanceFacts[];
  aliases: AliasRecord[];
  ledger: LedgerTransaction[];
};

export function matchStatements(input: MatchInput): Omit<ReconcileReport, "period" | "coverage" | "statements"> {
  const matched: MatchItem[] = [];
  const ambiguous: AmbiguousMatch[] = [];
  const unmatchedIncoming: UnmatchedIncoming[] = [];
  const activeFinance = input.finance.filter((facts) => !facts.voided);
  const paidDeals = new Set(
    input.ledger.filter((item) => item.sponsorDealId && Number(item.amount) > 0).map((item) => item.sponsorDealId as string),
  );

  for (const statement of input.statements) {
    statement.rows.forEach((row, rowIndex) => {
      if (Number(row.amount) <= 0) return;
      const ledgerPair = pairLedger(row, input.ledger);

      type Candidate = { deal: DealFinanceFacts; strategy: MatchStrategy; confidence: MatchConfidence };
      const candidates: Candidate[] = [];
      for (const deal of activeFinance) {
        if ((deal.currency || "").toUpperCase() !== row.currency && deal.currency) continue;
        if (referenceMatchesInvoice(row.reference, deal.invoiceNumber)) {
          candidates.push({ deal, strategy: "invoice-number", confidence: "exact" });
          continue;
        }
        const names = [deal.organizationName, ...input.aliases.filter((alias) => alias.sponsor === deal.organizationName || alias.sponsor === deal.dealName).map((alias) => alias.alias)]
          .filter(Boolean) as string[];
        if (names.some((name) => aliasHit(row.counterparty, name))) {
          candidates.push({
            deal,
            strategy: "alias",
            confidence: amountEqual(row.amount, deal.amountDue) ? "strong" : "proposed",
          });
          continue;
        }
        const window = invoiceWindow(deal);
        if (window && amountEqual(row.amount, deal.amountDue)) {
          const when = Date.parse(`${row.date}T00:00:00Z`);
          if (when >= window.from && when <= window.to) {
            candidates.push({ deal, strategy: "amount-window", confidence: "proposed" });
          }
        }
      }

      const rank: Record<MatchConfidence, number> = { exact: 3, strong: 2, proposed: 1 };
      const best = candidates.sort((left, right) => rank[right.confidence] - rank[left.confidence])[0];
      if (!best) {
        unmatchedIncoming.push({
          statementId: statement.id,
          rowIndex,
          row,
          ...(ledgerPair.transaction ? { transactionId: ledgerPair.transaction.id } : {}),
          ...(ledgerPair.claimedBy ? { transactionClaimedBy: ledgerPair.claimedBy } : {}),
        });
        return;
      }
      const tied = candidates.filter((candidate) => candidate.confidence === best.confidence);
      if (tied.length > 1) {
        ambiguous.push({
          statementId: statement.id,
          rowIndex,
          row,
          candidates: tied.map((candidate) => ({
            dealId: candidate.deal.dealId,
            dealName: candidate.deal.dealName,
            strategy: candidate.strategy,
            ...(candidate.deal.invoiceNumber ? { invoiceNumber: candidate.deal.invoiceNumber } : {}),
          })),
        });
        return;
      }
      matched.push({
        matchId: matchIdFor(statement.id, rowIndex, best.deal.dealId),
        statementId: statement.id,
        rowIndex,
        row,
        dealId: best.deal.dealId,
        dealName: best.deal.dealName,
        ...(best.deal.invoiceNumber ? { invoiceNumber: best.deal.invoiceNumber } : {}),
        ...(best.deal.amountDue ? { amountDue: best.deal.amountDue } : {}),
        ...(best.deal.issuedOn ? { issuedOn: best.deal.issuedOn } : {}),
        ...(best.deal.dueOn ? { dueOn: best.deal.dueOn } : {}),
        strategy: best.strategy,
        confidence: best.confidence,
        ...(ledgerPair.transaction ? { transactionId: ledgerPair.transaction.id } : {}),
        ...(ledgerPair.claimedBy ? { transactionClaimedBy: ledgerPair.claimedBy } : {}),
      });
    });
  }

  const unmatchedDealIds = new Set([
    ...matched.map((item) => item.dealId),
    ...input.ledger.filter((item) => item.sponsorDealId).map((item) => item.sponsorDealId as string),
  ]);
  const missingPayments: MissingPayment[] = activeFinance
    .filter((deal) =>
      deal.invoiceNumber
      && deal.amountDue
      && !unmatchedDealIds.has(deal.dealId)
      && !(paidDeals.has(deal.dealId)))
    .map((deal) => {
      const anchor = deal.dueOn || deal.issuedOn || "";
      const daysOverdue = anchor && Date.parse(`${anchor}T00:00:00Z`) < Date.now()
        ? Math.floor((Date.now() - Date.parse(`${anchor}T00:00:00Z`)) / DAY)
        : undefined;
      return {
        dealId: deal.dealId,
        dealName: deal.dealName,
        ...(deal.invoiceNumber ? { invoiceNumber: deal.invoiceNumber } : {}),
        ...(deal.amountDue ? { amountDue: deal.amountDue } : {}),
        ...(deal.currency ? { currency: deal.currency } : {}),
        ...(deal.issuedOn ? { issuedOn: deal.issuedOn } : {}),
        ...(deal.dueOn ? { dueOn: deal.dueOn } : {}),
        ...(daysOverdue !== undefined ? { daysOverdue } : {}),
      };
    });

  return {
    matched: matched.sort((left, right) => left.row.date.localeCompare(right.row.date) || left.statementId.localeCompare(right.statementId)),
    ambiguous,
    unmatchedIncoming,
    missingPayments: missingPayments.sort((left, right) => (right.dueOn || "").localeCompare(left.dueOn || "")),
    totals: {
      incomingCount: matched.length + unmatchedIncoming.length + ambiguous.length,
      matchedCount: matched.length,
      unmatchedCount: unmatchedIncoming.length,
      ambiguousCount: ambiguous.length,
    },
  };
}

/** Maximal runs of days in the month no statement of the account covers. */
export function coverageGaps(period: string, ranges: Array<{ from?: string; to?: string }>): { daysInPeriod: number; coveredDays: number; gaps: CoverageGap[] } {
  const [year, month] = period.split("-").map(Number);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const monthStart = Date.parse(`${period}-01T00:00:00Z`);
  const covered = new Set<number>();
  for (const range of ranges) {
    if (!range.from || !range.to) continue;
    const from = Math.max(monthStart, Date.parse(`${range.from}T00:00:00Z`));
    const to = Math.min(monthStart + (days - 1) * DAY, Date.parse(`${range.to}T00:00:00Z`));
    for (let at = from; at <= to; at += DAY) {
      if (at >= monthStart && at < monthStart + days * DAY) covered.add(Math.round((at - monthStart) / DAY));
    }
  }
  const gaps: CoverageGap[] = [];
  let run: CoverageGap | null = null;
  for (let day = 0; day < days; day++) {
    if (covered.has(day)) {
      run = null;
      continue;
    }
    const date = new Date(monthStart + day * DAY).toISOString().slice(0, 10);
    if (run) run.to = date;
    else run = { from: date, to: date };
    if (!gaps.includes(run)) gaps.push(run);
  }
  return { daysInPeriod: days, coveredDays: covered.size, gaps };
}
