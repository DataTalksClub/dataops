/**
 * Statement and alias persistence plus report assembly. Statements and
 * counterparty aliases live in the bookkeeping table as new item kinds; the
 * raw statement file itself stays a bookkeeping document (private storage),
 * referenced by id. Re-uploading the same file/account/period rewrites the
 * statement record, so uploads are idempotent. Statements of one account
 * that overlap (a year export next to a month export) are deduplicated row by
 * row when the report is built.
 */
import { createHash } from "crypto";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { TABLE_BOOKKEEPING } from "../db/tableNames";
import {
  deleteBookkeepingItem,
  getBookkeepingItem,
  listBookkeepingItems,
  listTransactions,
  putBookkeepingItem,
} from "../db/bookkeeping";
import { listCrmRecords, scanCrmPrefix } from "../db/sponsorCrm";
import type { StatementAccount, StatementBalance, StatementRow } from "./parsers";
import {
  coverageGaps,
  matchStatements,
  type AliasRecord,
  type CoverageGap,
  type DealFinanceFacts,
  type LedgerTransaction,
  type ReconcileReport,
  type StatementSummary,
} from "./match";

const AMOUNT = /^-?(0|[1-9]\d{0,9})(\.\d{1,2})$/;
const CURRENCY = /^[A-Z]{3}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;
export const MAX_ROWS = 2000;

export type StatementRecord = {
  id: string;
  recordType: "reconcile-statement";
  accountId: StatementAccount;
  period: string;
  documentId?: string;
  /** The emailed attachment a statement came from, when it arrived by email. */
  artifactId?: string;
  filename?: string;
  contentType?: string;
  rows: StatementRow[];
  balances?: StatementBalance[];
  from?: string;
  to?: string;
  warnings?: string[];
  createdAt: string;
  updatedAt: string;
};

export type StatementInput = {
  accountId: StatementAccount;
  period: string;
  documentId?: string;
  artifactId?: string;
  filename?: string;
  contentType?: string;
  rows: StatementRow[];
  balances?: StatementBalance[];
  warnings?: string[];
};

export type AccountBalance = StatementBalance & { accountId: StatementAccount; statementId: string };

export function statementIdFor(documentId: string, accountId: string, period: string): string {
  return createHash("sha256").update(`${documentId}|${accountId}|${period}`).digest("hex").slice(0, 32);
}

function realDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  return new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

/** Field-level problems; empty means the rows can be stored. */
export function validateRows(rows: unknown): string[] {
  if (!Array.isArray(rows)) return ["rows must be an array"];
  if (!rows.length) return ["rows must not be empty"];
  if (rows.length > MAX_ROWS) return [`rows must hold at most ${MAX_ROWS} rows`];
  const problems: string[] = [];
  rows.forEach((row, index) => {
    const label = `row ${index}`;
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      problems.push(`${label} must be an object`);
      return;
    }
    const candidate = row as Record<string, unknown>;
    if (typeof candidate.date !== "string" || !realDate(candidate.date)) problems.push(`${label} date`);
    if (typeof candidate.amount !== "string" || !AMOUNT.test(candidate.amount) || Number(candidate.amount) === 0) problems.push(`${label} amount`);
    if (typeof candidate.currency !== "string" || !CURRENCY.test(candidate.currency)) problems.push(`${label} currency`);
    if (typeof candidate.counterparty !== "string" || !candidate.counterparty.trim() || candidate.counterparty.length > 300) problems.push(`${label} counterparty`);
    if (candidate.reference !== undefined && (typeof candidate.reference !== "string" || candidate.reference.length > 300)) problems.push(`${label} reference`);
    for (const field of ["bankId", "bankType", "relatedBankId", "wallet"]) {
      if (candidate[field] !== undefined && (typeof candidate[field] !== "string" || !candidate[field] || (candidate[field] as string).length > 120)) problems.push(`${label} ${field}`);
    }
    for (const field of ["origAmount", "fee"]) {
      if (candidate[field] !== undefined && (typeof candidate[field] !== "string" || !AMOUNT.test(candidate[field] as string))) problems.push(`${label} ${field}`);
    }
    if (candidate.origCurrency !== undefined && (typeof candidate.origCurrency !== "string" || !CURRENCY.test(candidate.origCurrency))) problems.push(`${label} origCurrency`);
  });
  return problems;
}

const BALANCE_AMOUNT = /^-?(0|[1-9]\d{0,11})(\.\d{1,2})$/;

export function validateBalances(balances: unknown): string[] {
  if (balances === undefined) return [];
  if (!Array.isArray(balances) || balances.length > 50) return ["balances must be an array of at most 50 items"];
  const problems: string[] = [];
  balances.forEach((balance, index) => {
    const label = `balance ${index}`;
    if (!balance || typeof balance !== "object" || Array.isArray(balance)) { problems.push(`${label} must be an object`); return; }
    const candidate = balance as Record<string, unknown>;
    if (typeof candidate.currency !== "string" || !CURRENCY.test(candidate.currency)) problems.push(`${label} currency`);
    if (typeof candidate.amount !== "string" || !BALANCE_AMOUNT.test(candidate.amount)) problems.push(`${label} amount`);
    if (typeof candidate.asOf !== "string" || !realDate(candidate.asOf)) problems.push(`${label} asOf`);
    if (candidate.wallet !== undefined && (typeof candidate.wallet !== "string" || !candidate.wallet || candidate.wallet.length > 120)) problems.push(`${label} wallet`);
  });
  return problems;
}

export async function saveStatement(client: DynamoDBDocumentClient, input: StatementInput): Promise<StatementRecord> {
  if (!MONTH.test(input.period)) throw new Error("period must be YYYY-MM");
  const problems = validateRows(input.rows);
  if (problems.length) throw new Error(`invalid statement rows: ${problems.join(", ")}`);
  const balanceProblems = validateBalances(input.balances);
  if (balanceProblems.length) throw new Error(`invalid statement balances: ${balanceProblems.join(", ")}`);
  const sorted = [...input.rows].map((row) => ({ ...row })).sort((left, right) => left.date.localeCompare(right.date));
  const id = statementIdFor(input.documentId || (input.artifactId ? `artifact:${input.artifactId}` : "adhoc"), input.accountId, input.period);
  const now = new Date().toISOString();
  const record: StatementRecord = {
    id,
    recordType: "reconcile-statement",
    accountId: input.accountId,
    period: input.period,
    ...(input.documentId ? { documentId: input.documentId } : {}),
    ...(input.artifactId ? { artifactId: input.artifactId } : {}),
    ...(input.filename ? { filename: input.filename } : {}),
    ...(input.contentType ? { contentType: input.contentType } : {}),
    rows: input.rows,
    ...(input.balances?.length ? { balances: input.balances } : {}),
    from: sorted[0].date,
    to: sorted[sorted.length - 1].date,
    ...(input.warnings?.length ? { warnings: input.warnings.slice(0, 100) } : {}),
    createdAt: now,
    updatedAt: now,
  };
  const existing = await getBookkeepingItem(client, "statement", id);
  await client.send(new PutCommand({
    TableName: TABLE_BOOKKEEPING,
    Item: { PK: `STATEMENT#${id}`, SK: `STATEMENT#${id}`, ...record, ...(existing ? { createdAt: existing.createdAt } : {}) },
  }));
  return record;
}

export async function getStatement(client: DynamoDBDocumentClient, id: string): Promise<StatementRecord | null> {
  return (await getBookkeepingItem(client, "statement", id)) as unknown as StatementRecord | null;
}

export async function listStatements(client: DynamoDBDocumentClient): Promise<StatementRecord[]> {
  return (await listBookkeepingItems(client, "statement")) as unknown as StatementRecord[];
}

/**
 * The latest known balance per account wallet and currency, across every
 * stored statement: the one with the latest as-of date wins, a later upload
 * breaks ties.
 */
export async function latestBalances(client: DynamoDBDocumentClient, accountId?: StatementAccount): Promise<AccountBalance[]> {
  const latest = new Map<string, { balance: AccountBalance; updatedAt: string }>();
  for (const record of await listStatements(client)) {
    if (accountId && record.accountId !== accountId) continue;
    for (const balance of record.balances || []) {
      const key = `${record.accountId}|${balance.wallet || ""}|${balance.currency}`;
      const current = latest.get(key);
      if (current && (current.balance.asOf > balance.asOf || (current.balance.asOf === balance.asOf && current.updatedAt > record.updatedAt))) continue;
      latest.set(key, { balance: { accountId: record.accountId, statementId: record.id, ...balance }, updatedAt: record.updatedAt });
    }
  }
  return [...latest.values()].map((item) => item.balance)
    .sort((left, right) => left.accountId.localeCompare(right.accountId) || (left.wallet || "").localeCompare(right.wallet || "") || left.currency.localeCompare(right.currency));
}

/**
 * Identity of a statement row across overlapping statements of one account:
 * the bank's transaction id when the export has one, otherwise the row's
 * content plus its occurrence number (two identical card payments on one day
 * stay two rows).
 */
export function rowKeys(rows: StatementRow[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    if (row.bankId) return `id|${row.bankId}|${row.currency}|${row.amount}`;
    const content = `row|${row.date}|${row.amount}|${row.currency}|${row.counterparty.toLowerCase()}|${row.reference || ""}`;
    const occurrence = (seen.get(content) || 0) + 1;
    seen.set(content, occurrence);
    return `${content}|${occurrence}`;
  });
}

/** Per statement, its in-period rows minus those an earlier-uploaded statement of the same account already holds. */
function dedupedPeriodRows(statements: StatementRecord[], bounds: { start: number; end: number }): Map<string, { rows: StatementRow[]; duplicates: number }> {
  const result = new Map<string, { rows: StatementRow[]; duplicates: number }>();
  const seenByAccount = new Map<string, Set<string>>();
  const byUpload = [...statements].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  for (const record of byUpload) {
    const seen = seenByAccount.get(record.accountId) || new Set<string>();
    seenByAccount.set(record.accountId, seen);
    const rows = rowsInPeriod(record, bounds);
    const keys = rowKeys(rows);
    const kept = rows.filter((_, index) => !seen.has(keys[index]));
    keys.forEach((key) => seen.add(key));
    result.set(record.id, { rows: kept, duplicates: rows.length - kept.length });
  }
  return result;
}

export async function deleteStatement(client: DynamoDBDocumentClient, id: string): Promise<void> {
  await deleteBookkeepingItem(client, "statement", id);
}

export async function saveAlias(client: DynamoDBDocumentClient, alias: string, sponsor: string): Promise<AliasRecord> {
  const name = String(alias || "").trim();
  const target = String(sponsor || "").trim();
  if (!name || name.length > 120 || !target || target.length > 120) throw new Error("alias and sponsor are required (max 120 chars)");
  const { item } = await putBookkeepingItem(client, "reconcile-alias", {
    id: createHash("sha256").update(name.toLowerCase()).digest("hex").slice(0, 24),
    alias: name,
    sponsor: target,
  }, `reconcile-alias#${name.toLowerCase()}`);
  return item as unknown as AliasRecord;
}

export async function listAliases(client: DynamoDBDocumentClient): Promise<AliasRecord[]> {
  const items = await listBookkeepingItems(client, "reconcile-alias");
  return items
    .map((item) => item as unknown as AliasRecord)
    .sort((left, right) => left.alias.localeCompare(right.alias));
}

export async function deleteAlias(client: DynamoDBDocumentClient, id: string): Promise<void> {
  await deleteBookkeepingItem(client, "reconcile-alias", id);
}

const monthBounds = (period: string) => {
  const [year, month] = period.split("-").map(Number);
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0));
  return {
    from: start.toISOString().slice(0, 10),
    to: end.toISOString().slice(0, 10),
    start: start.getTime(),
    end: end.getTime() + 86_400_000,
  };
};

const overlapsPeriod = (record: StatementRecord, bounds: { from: string; to: string }) =>
  !(record.to && record.to < bounds.from) && !(record.from && record.from > bounds.to);

function rowsInPeriod(record: StatementRecord, bounds: { start: number; end: number }): StatementRow[] {
  return record.rows.filter((row) => {
    const at = Date.parse(`${row.date}T00:00:00Z`);
    return at >= bounds.start && at < bounds.end;
  });
}

export async function buildReport(client: DynamoDBDocumentClient, period: string): Promise<ReconcileReport> {
  if (!MONTH.test(period)) throw new Error("period must be YYYY-MM");
  const bounds = monthBounds(period);
  const [allStatements, ledgerRaw, deals, organizations, financeRaw, aliases] = await Promise.all([
    listStatements(client),
    listTransactions(client),
    listCrmRecords(client, "deal"),
    listCrmRecords(client, "organization"),
    scanCrmPrefix(client, "SPONSOR_FINANCE#"),
    listAliases(client),
  ]);

  const statements = allStatements
    .filter((record) => overlapsPeriod(record, bounds))
    .sort((left, right) => left.accountId.localeCompare(right.accountId) || (left.from || "").localeCompare(right.from || ""));

  const orgName = new Map(organizations.map((org) => [org.id, String(org.name || "")]));
  const dealById = new Map(deals.map((deal) => [deal.id, deal]));
  const finance: DealFinanceFacts[] = financeRaw
    .filter((item) => typeof item.dealId === "string")
    .map((item) => {
      const deal = dealById.get(String(item.dealId));
      const organizationName = deal && typeof deal.organizationId === "string" ? orgName.get(deal.organizationId) : undefined;
      return {
        dealId: String(item.dealId),
        dealName: String(deal?.name || organizationName || item.dealId),
        ...(organizationName ? { organizationName } : {}),
        ...(typeof item.invoiceNumber === "string" && item.invoiceNumber ? { invoiceNumber: item.invoiceNumber } : {}),
        ...(typeof item.amountDue === "string" && item.amountDue ? { amountDue: item.amountDue } : {}),
        ...(typeof item.currency === "string" && item.currency ? { currency: item.currency } : {}),
        ...(typeof item.issuedOn === "string" && item.issuedOn ? { issuedOn: item.issuedOn } : {}),
        ...(typeof item.dueOn === "string" && item.dueOn ? { dueOn: item.dueOn } : {}),
        voided: Boolean(item.voidedAt),
      };
    });

  const ledger: LedgerTransaction[] = ledgerRaw.map((item) => ({
    id: item.id,
    ...(item.transactionDate ? { transactionDate: String(item.transactionDate) } : {}),
    ...(item.paidDate ? { paidDate: String(item.paidDate) } : {}),
    ...(item.amount !== undefined ? { amount: String(item.amount) } : {}),
    ...(item.currency ? { currency: String(item.currency) } : {}),
    ...(item.counterparty ? { counterparty: String(item.counterparty) } : {}),
    ...(item.sponsorDealId ? { sponsorDealId: String(item.sponsorDealId) } : {}),
  }));

  const periodRows = dedupedPeriodRows(statements, bounds);
  const matched = matchStatements({
    statements: statements.map((record) => {
      const { rows } = periodRows.get(record.id)!;
      return {
        id: record.id,
        accountId: record.accountId,
        period: record.period,
        rowCount: rows.length,
        incomingCount: rows.filter((row) => Number(row.amount) > 0).length,
        rows,
      };
    }),
    finance,
    aliases,
    ledger,
  });

  const summaries: StatementSummary[] = statements.map((record) => {
    const { rows, duplicates } = periodRows.get(record.id)!;
    return {
      id: record.id,
      accountId: record.accountId,
      ...(record.documentId ? { documentId: record.documentId } : {}),
      ...(record.filename ? { filename: record.filename } : {}),
      period: record.period,
      rowCount: rows.length,
      incomingCount: rows.filter((row) => Number(row.amount) > 0).length,
      ...(duplicates ? { duplicateCount: duplicates } : {}),
      ...(record.from ? { from: record.from } : {}),
      ...(record.to ? { to: record.to } : {}),
    };
  });

  const accounts = [...new Set([
    ...statements.map((record) => record.accountId),
    ...(await listBookkeepingItems(client, "account")).filter((account) => account.active !== false).map((account) => String(account.id)),
  ])].sort();
  const coverage = accounts.map((accountId) => {
    const own = statements.filter((record) => record.accountId === accountId);
    const gaps: CoverageGap[] = own.length ? coverageGaps(period, own.map((record) => ({ from: record.from, to: record.to }))).gaps : [];
    return {
      accountId,
      statementCount: own.length,
      coveredDays: own.length ? coverageGaps(period, own.map((record) => ({ from: record.from, to: record.to }))).coveredDays : 0,
      gaps,
    };
  });
  const daysInPeriod = coverageGaps(period, []).daysInPeriod;

  return {
    period,
    statements: summaries,
    matched: matched.matched,
    ambiguous: matched.ambiguous,
    unmatchedIncoming: matched.unmatchedIncoming,
    missingPayments: matched.missingPayments,
    coverage: {
      daysInPeriod,
      accounts: coverage,
      accountsWithoutStatement: coverage.filter((account) => !account.statementCount).map((account) => account.accountId),
    },
    totals: matched.totals,
  };
}
