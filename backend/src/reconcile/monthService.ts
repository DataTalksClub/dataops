/**
 * Month reconciliation state and actions. A month record (bookkeeping item
 * "reconcile-month", id = YYYY-MM) holds the person-made decisions: manual
 * pairs and unmatches, no-invoice exceptions, per-row payment proofs, the
 * approver's confirmation of the exception list, the open/closed state and
 * an append-only log of every action with who and when. Ledger rows, bank
 * rows and documents are never deleted here; a closed month refuses every
 * change until it is reopened.
 */
import { createHash } from "crypto";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { TABLE_BOOKKEEPING } from "../db/tableNames";
import {
  createDocumentLink,
  getBookkeepingItem,
  getRawDocument,
  listBookkeepingItems,
  listTransactions,
  putBookkeepingItem,
} from "../db/bookkeeping";
import {
  bankKeyFor,
  buildMonthTable,
  closeBlockers,
  DEFAULT_TOLERANCES,
  EXCEPTION_KINDS,
  EXCEPTION_POLICIES,
  exceptionDigest,
  pairAll,
  type BankTx,
  type ClassificationRule,
  type ExceptionKind,
  type LedgerRow,
  type ManualDecisions,
  type MonthTable,
  type ReconcileTolerances,
} from "./month";
import { listStatements, rowKeys, type StatementRecord } from "./service";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const LOG_LIMIT = 2000;

export type MonthAction =
  | "pair" | "unpair" | "exception" | "clear-exception" | "attach-proof" | "attach-document"
  | "create-ledger" | "confirm-exceptions" | "close" | "reopen" | "summary";

export type MonthLogEntry = { at: string; by: string; action: MonthAction; detail: Record<string, unknown> };

export type MonthRecord = {
  id: string;
  recordType: "reconcile-month";
  period: string;
  state: "open" | "closed";
  decisions: ManualDecisions;
  exceptionConfirmation?: { digest: string; by: string; at: string; count: number };
  closed?: { by: string; at: string };
  log: MonthLogEntry[];
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type ReconcileConfig = { rules: ClassificationRule[]; tolerances: ReconcileTolerances };

/**
 * Rules shipped with the code name only public institutions and bank
 * mechanics. Rules naming people (owner withdrawals) or vendors live in the
 * stored config, edited through the API.
 */
export const DEFAULT_RULES: ClassificationRule[] = [
  { id: "revolut-fee", kind: "bank_fee", direction: "out", accounts: ["revolut"], bankType: ["FEE"], category: "Bank fees" },
  { id: "finom-fee", kind: "bank_fee", direction: "out", accounts: ["finom"], counterparty: "^finom\\b", category: "Bank fees" },
  { id: "tk", kind: "tk_debit", direction: "out", counterparty: "techniker krankenkasse|\\btk\\b", category: "Health Insurance" },
  { id: "finanzamt", kind: "tax_debit", direction: "out", counterparty: "finanzamt|bundeskasse|steuerverwaltung", category: "Taxes" },
  { id: "revolut-exchange", kind: "internal_transfer", accounts: ["revolut"], bankType: ["EXCHANGE"] },
];

export class MonthClosedError extends Error {
  statusCode = 409;
  constructor(period: string) { super(`Month ${period} is closed; reopen it first`); }
}
export class MonthConflictError extends Error {
  statusCode = 409;
  constructor() { super("Month record changed; retry"); }
}
export class MonthGateError extends Error {
  statusCode = 409;
  constructor(message: string, readonly blockers: unknown[]) { super(message); }
}
const badRequest = (message: string) => Object.assign(new Error(message), { statusCode: 400 });
const notFound = (message: string) => Object.assign(new Error(message), { statusCode: 404 });

const withDefaults = (decisions?: Partial<ManualDecisions>): ManualDecisions => ({
  pairs: decisions?.pairs || [], rejected: decisions?.rejected || [], exceptions: decisions?.exceptions || {}, proofs: decisions?.proofs || {},
});

const monthKey = (period: string) => ({ PK: `RECONCILE-MONTH#${period}`, SK: `RECONCILE-MONTH#${period}` });

function emptyMonth(period: string): MonthRecord {
  const now = new Date().toISOString();
  return {
    id: period, recordType: "reconcile-month", period, state: "open",
    decisions: { pairs: [], rejected: [], exceptions: {}, proofs: {} },
    log: [], version: 0, createdAt: now, updatedAt: now,
  };
}

export async function getMonth(client: DynamoDBDocumentClient, period: string): Promise<MonthRecord> {
  if (!MONTH.test(period)) throw badRequest("period must be YYYY-MM");
  const result = await client.send(new GetCommand({ TableName: TABLE_BOOKKEEPING, Key: monthKey(period), ConsistentRead: true }));
  if (!result.Item) return emptyMonth(period);
  const { PK: _pk, SK: _sk, ...item } = result.Item;
  const record = item as MonthRecord;
  record.decisions = withDefaults(record.decisions);
  return record;
}

async function listMonths(client: DynamoDBDocumentClient): Promise<MonthRecord[]> {
  return (await listBookkeepingItems(client, "reconcile-month")) as unknown as MonthRecord[];
}

async function writeMonth(client: DynamoDBDocumentClient, record: MonthRecord, expectedVersion: number): Promise<MonthRecord> {
  const next = { ...record, version: expectedVersion + 1, updatedAt: new Date().toISOString(), log: record.log.slice(-LOG_LIMIT) };
  try {
    await client.send(new PutCommand({
      TableName: TABLE_BOOKKEEPING,
      Item: { ...monthKey(record.period), ...next },
      ConditionExpression: expectedVersion === 0 ? "attribute_not_exists(PK)" : "version = :version",
      ...(expectedVersion === 0 ? {} : { ExpressionAttributeValues: { ":version": expectedVersion } }),
    }));
  } catch (error) {
    if ((error as Error).name === "ConditionalCheckFailedException") throw new MonthConflictError();
    throw error;
  }
  return next;
}

/** Apply one logged change to an open month. */
async function mutateMonth(
  client: DynamoDBDocumentClient,
  period: string,
  by: string,
  action: MonthAction,
  detail: Record<string, unknown>,
  change: (record: MonthRecord) => void,
  options: { allowClosed?: boolean } = {},
): Promise<MonthRecord> {
  const record = await getMonth(client, period);
  if (record.state === "closed" && !options.allowClosed) throw new MonthClosedError(period);
  const expected = record.version;
  change(record);
  record.log.push({ at: new Date().toISOString(), by, action, detail });
  return writeMonth(client, record, expected);
}

export async function getConfig(client: DynamoDBDocumentClient): Promise<ReconcileConfig> {
  const stored = await getBookkeepingItem(client, "reconcile-config", "default");
  return {
    rules: Array.isArray(stored?.rules) ? (stored!.rules as ClassificationRule[]) : DEFAULT_RULES,
    tolerances: { ...DEFAULT_TOLERANCES, ...((stored?.tolerances as Partial<ReconcileTolerances>) || {}) },
  };
}

export function validateConfig(input: unknown): string[] {
  const problems: string[] = [];
  const value = (input || {}) as Record<string, unknown>;
  if (value.rules !== undefined) {
    if (!Array.isArray(value.rules) || value.rules.length > 500) problems.push("rules must be an array of at most 500 rules");
    else value.rules.forEach((rule: Record<string, unknown>, index: number) => {
      if (!rule || typeof rule.id !== "string" || !rule.id) problems.push(`rule ${index} id`);
      if (![...EXCEPTION_KINDS, "known_vendor"].includes(String(rule?.kind))) problems.push(`rule ${index} kind`);
      for (const field of ["counterparty", "reference"]) {
        if (rule?.[field] === undefined) continue;
        try { new RegExp(String(rule[field]), "i"); } catch { problems.push(`rule ${index} ${field} is not a valid pattern`); }
      }
      if (rule?.direction !== undefined && !["in", "out"].includes(String(rule.direction))) problems.push(`rule ${index} direction`);
    });
  }
  if (value.tolerances !== undefined) {
    const tolerances = value.tolerances as Record<string, unknown>;
    for (const [field, max] of [["dateLagDays", 31], ["fxSpreadPct", 0.2], ["feeTolerance", 100], ["namedFxSpreadPct", 0.3], ["namedMismatchPct", 0.5]] as const) {
      if (tolerances[field] !== undefined && !(typeof tolerances[field] === "number" && (tolerances[field] as number) >= 0 && (tolerances[field] as number) <= max)) problems.push(`tolerances.${field} must be a number 0..${max}`);
    }
  }
  return problems;
}

export async function saveConfig(client: DynamoDBDocumentClient, input: Partial<ReconcileConfig>, by: string): Promise<ReconcileConfig> {
  const problems = validateConfig(input);
  if (problems.length) throw badRequest(`invalid reconcile config: ${problems.join(", ")}`);
  const current = await getConfig(client);
  const next = { rules: input.rules ?? current.rules, tolerances: { ...current.tolerances, ...(input.tolerances || {}) } };
  await client.send(new PutCommand({
    TableName: TABLE_BOOKKEEPING,
    Item: { PK: "RECONCILE-CONFIG#default", SK: "RECONCILE-CONFIG#default", id: "default", ...next, updatedBy: by, updatedAt: new Date().toISOString() },
  }));
  return next;
}

/** Every stored bank row, rows repeated by an overlapping statement of the same account kept once (earliest upload wins). */
export function bankRowsFrom(statements: StatementRecord[]): BankTx[] {
  const seen = new Set<string>();
  const rows: BankTx[] = [];
  const byUpload = [...statements].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  for (const record of byUpload) {
    const keys = rowKeys(record.rows);
    record.rows.forEach((row, index) => {
      const key = bankKeyFor(record.accountId, keys[index]);
      if (seen.has(key)) return;
      seen.add(key);
      rows.push({
        key, accountId: record.accountId, statementId: record.id,
        date: row.date, amount: row.amount, currency: row.currency, counterparty: row.counterparty,
        ...(row.wallet ? { wallet: row.wallet } : {}),
        ...(row.reference ? { reference: row.reference } : {}),
        ...(row.bankId ? { bankId: row.bankId } : {}),
        ...(row.bankType ? { bankType: row.bankType } : {}),
        ...(row.origAmount ? { origAmount: row.origAmount, origCurrency: row.origCurrency } : {}),
        ...(row.fee ? { fee: row.fee } : {}),
        ...(row.relatedBankId ? { relatedBankId: row.relatedBankId } : {}),
      });
    });
  }
  return rows;
}

const signed = (amount: unknown, entryType: unknown) => {
  const value = Math.abs(Number(amount || 0));
  return (entryType === "expense" ? -value : value).toFixed(2);
};

export function ledgerRowsFrom(transactions: Array<Record<string, unknown>>, links: Array<Record<string, unknown>>): LedgerRow[] {
  const documents = new Map<string, Array<{ id: string }>>();
  for (const link of links) {
    if (link.coverageType !== "evidence") continue;
    const list = documents.get(String(link.transactionId)) || [];
    list.push({ id: String(link.documentId) });
    documents.set(String(link.transactionId), list);
  }
  return transactions
    .filter((item) => item.amount !== undefined && (item.paidDate || item.transactionDate))
    .map((item) => {
      const own = documents.get(String(item.id)) || [];
      const extra = [item.invoiceId, item.documentArtifactId].filter((value) => typeof value === "string" && value).map((value) => ({ id: String(value) }));
      return {
        id: String(item.id),
        date: String(item.paidDate || item.transactionDate).slice(0, 10),
        amount: signed(item.amount, item.entryType),
        currency: String(item.currency || "EUR").toUpperCase(),
        ...(item.amountEur ? { amountEur: signed(item.amountEur, item.entryType) } : {}),
        counterparty: String(item.counterparty || item.description || ""),
        ...(item.description ? { description: String(item.description) } : {}),
        ...(item.category ? { category: String(item.category) } : {}),
        ...(item.statementRef ? { statementRef: String(item.statementRef) } : {}),
        ...(item.invoiceNumber ? { invoiceNumber: String(item.invoiceNumber) } : {}),
        ...(item.sourceType ? { sourceType: String(item.sourceType) } : {}),
        documents: [...own, ...extra.filter((doc) => !own.some((existing) => existing.id === doc.id))],
      };
    });
}

export type MonthView = MonthTable & {
  state: MonthRecord["state"];
  closed?: MonthRecord["closed"];
  exceptionConfirmation?: MonthRecord["exceptionConfirmation"] & { current: boolean };
  exceptionDigest: string;
  blockers: number;
  statements: Array<{ id: string; accountId: string; filename?: string; from?: string; to?: string }>;
  exceptionPolicies: typeof EXCEPTION_POLICIES;
  log: MonthLogEntry[];
};

type Snapshot = { bank: BankTx[]; ledger: LedgerRow[]; statements: StatementRecord[]; months: Map<string, MonthRecord>; config: ReconcileConfig };

async function snapshot(client: DynamoDBDocumentClient): Promise<Snapshot> {
  const [statements, transactions, links, months, config] = await Promise.all([
    listStatements(client), listTransactions(client), listBookkeepingItems(client, "link"), listMonths(client), getConfig(client),
  ]);
  return {
    bank: bankRowsFrom(statements),
    ledger: ledgerRowsFrom(transactions, links),
    statements,
    months: new Map(months.map((month) => [month.period, { ...month, decisions: withDefaults(month.decisions) }])),
    config,
  };
}

/** All months' decisions merged: pairs are global, so every month's manual pairs and unmatches apply everywhere. */
function mergedDecisions(months: Map<string, MonthRecord>): ManualDecisions {
  const merged: ManualDecisions = { pairs: [], rejected: [], exceptions: {}, proofs: {} };
  for (const month of [...months.values()].sort((left, right) => left.period.localeCompare(right.period))) {
    merged.pairs.push(...month.decisions.pairs);
    merged.rejected.push(...month.decisions.rejected);
    Object.assign(merged.exceptions, month.decisions.exceptions);
    Object.assign(merged.proofs, month.decisions.proofs);
  }
  return merged;
}

function viewFor(period: string, data: Snapshot, pairing: ReturnType<typeof pairAll>, decisions: ManualDecisions): MonthView {
  const record = data.months.get(period) || emptyMonth(period);
  const table = buildMonthTable({ period, bank: data.bank, ledger: data.ledger, decisions, rules: data.config.rules, tolerances: data.config.tolerances, pairing });
  const digest = exceptionDigest(table);
  return {
    ...table,
    state: record.state,
    ...(record.closed ? { closed: record.closed } : {}),
    ...(record.exceptionConfirmation ? { exceptionConfirmation: { ...record.exceptionConfirmation, current: record.exceptionConfirmation.digest === digest } } : {}),
    exceptionDigest: digest,
    blockers: closeBlockers(table).length,
    statements: data.statements
      .filter((statement) => !(statement.to && statement.to < `${period}-01`) && !(statement.from && statement.from > `${period}-31`))
      .map((statement) => ({ id: statement.id, accountId: statement.accountId, ...(statement.filename ? { filename: statement.filename } : {}), ...(statement.from ? { from: statement.from } : {}), ...(statement.to ? { to: statement.to } : {}) })),
    exceptionPolicies: EXCEPTION_POLICIES,
    log: record.log,
  };
}

export async function buildMonths(client: DynamoDBDocumentClient, periods: string[]): Promise<MonthView[]> {
  for (const period of periods) if (!MONTH.test(period)) throw badRequest("period must be YYYY-MM");
  const data = await snapshot(client);
  const decisions = mergedDecisions(data.months);
  const pairing = pairAll(data.bank, data.ledger, decisions, data.config.tolerances);
  return periods.map((period) => viewFor(period, data, pairing, decisions));
}

export async function buildMonth(client: DynamoDBDocumentClient, period: string): Promise<MonthView> {
  return (await buildMonths(client, [period]))[0];
}

export function periodsBetween(from: string, to: string): string[] {
  if (!MONTH.test(from) || !MONTH.test(to) || from > to) throw badRequest("from/to must be YYYY-MM with from <= to");
  const periods: string[] = [];
  let [year, month] = from.split("-").map(Number);
  while (`${year}-${String(month).padStart(2, "0")}` <= to && periods.length < 240) {
    periods.push(`${year}-${String(month).padStart(2, "0")}`);
    if (++month > 12) { month = 1; year++; }
  }
  return periods;
}

async function requireBankRow(client: DynamoDBDocumentClient, bankKey: string): Promise<BankTx> {
  const row = bankRowsFrom(await listStatements(client)).find((item) => item.key === bankKey);
  if (!row) throw notFound(`Bank row ${bankKey} not found`);
  return row;
}

async function requireLedger(client: DynamoDBDocumentClient, transactionId: string) {
  const item = await getBookkeepingItem(client, "bookkeeping", transactionId);
  if (!item) throw notFound(`Ledger row ${transactionId} not found`);
  return item;
}

async function requireActiveDocument(client: DynamoDBDocumentClient, documentId: string) {
  const document = await getRawDocument(client, documentId);
  if (!document || document.status !== "active") throw notFound(`Document ${documentId} not found or not active`);
  return document;
}

export async function pairRows(client: DynamoDBDocumentClient, period: string, by: string, bankKey: string, transactionId: string, note?: string) {
  await requireBankRow(client, bankKey);
  await requireLedger(client, transactionId);
  return mutateMonth(client, period, by, "pair", { bankKey, transactionId, ...(note ? { note } : {}) }, (record) => {
    record.decisions.pairs = record.decisions.pairs.filter((pair) => pair.bankKey !== bankKey && pair.transactionId !== transactionId);
    record.decisions.pairs.push({ bankKey, transactionId, by, at: new Date().toISOString(), ...(note ? { note: note.slice(0, 500) } : {}) });
    record.decisions.rejected = record.decisions.rejected.filter((item) => item !== `${bankKey}|${transactionId}`);
  });
}

/** Undo a pair: a manual one is dropped, an automatic one is ruled out so it does not come back. */
export async function unpairRows(client: DynamoDBDocumentClient, period: string, by: string, bankKey: string, transactionId: string, note?: string) {
  return mutateMonth(client, period, by, "unpair", { bankKey, transactionId, ...(note ? { note } : {}) }, (record) => {
    record.decisions.pairs = record.decisions.pairs.filter((pair) => !(pair.bankKey === bankKey && pair.transactionId === transactionId));
    if (!record.decisions.rejected.includes(`${bankKey}|${transactionId}`)) record.decisions.rejected.push(`${bankKey}|${transactionId}`);
  });
}

export async function setException(client: DynamoDBDocumentClient, period: string, by: string, rowId: string, kind: string, proof?: string, note?: string) {
  if (!EXCEPTION_KINDS.includes(kind as ExceptionKind)) throw badRequest(`kind must be one of ${EXCEPTION_KINDS.join(", ")}`);
  const key = rowId.startsWith("ledger:") ? rowId : `bank:${rowId}`;
  return mutateMonth(client, period, by, "exception", { row: key, kind, ...(proof ? { proof } : {}), ...(note ? { note } : {}) }, (record) => {
    record.decisions.exceptions[key] = { kind: kind as ExceptionKind, by, at: new Date().toISOString(), ...(proof ? { proof: proof.slice(0, 500) } : {}), ...(note ? { note: note.slice(0, 500) } : {}) };
  });
}

export async function clearException(client: DynamoDBDocumentClient, period: string, by: string, rowId: string) {
  const key = rowId.startsWith("ledger:") ? rowId : `bank:${rowId}`;
  return mutateMonth(client, period, by, "clear-exception", { row: key }, (record) => { delete record.decisions.exceptions[key]; });
}

/** A separate payment proof for one ledger row: the document stands in for its bank side. */
export async function attachProof(client: DynamoDBDocumentClient, period: string, by: string, transactionId: string, documentId: string) {
  await requireLedger(client, transactionId);
  const document = await requireActiveDocument(client, documentId);
  return mutateMonth(client, period, by, "attach-proof", { transactionId, documentId }, (record) => {
    record.decisions.proofs[transactionId] = {
      documentId, by, at: new Date().toISOString(),
      ...(document.originalFilename ? { filename: String(document.originalFilename).slice(0, 200) } : {}),
    };
  });
}

/** An invoice/receipt for one ledger row, as the ledger's own evidence link. */
export async function attachDocument(client: DynamoDBDocumentClient, period: string, by: string, transactionId: string, documentId: string) {
  const month = await getMonth(client, period);
  if (month.state === "closed") throw new MonthClosedError(period);
  await requireLedger(client, transactionId);
  await requireActiveDocument(client, documentId);
  const link = await createDocumentLink(client, { documentId, transactionId, coverageType: "evidence" });
  await mutateMonth(client, period, by, "attach-document", { transactionId, documentId, outcome: link.outcome }, () => {});
  return link;
}

/**
 * A ledger row for a bank transaction nobody booked: same date, signed
 * amount and counterparty, paired with that bank row; optionally with its
 * invoice/receipt attached. Created once per bank row (sourceKey).
 */
export async function createLedgerFromBank(
  client: DynamoDBDocumentClient,
  period: string,
  by: string,
  bankKey: string,
  input: { category?: string; description?: string; documentId?: string },
) {
  const month = await getMonth(client, period);
  if (month.state === "closed") throw new MonthClosedError(period);
  const bank = await requireBankRow(client, bankKey);
  if (input.documentId) await requireActiveDocument(client, input.documentId);
  const amount = Number(bank.amount);
  const { item, duplicate } = await putBookkeepingItem(client, "bookkeeping", {
    transactionDate: bank.date,
    paidDate: bank.date,
    counterparty: bank.counterparty.slice(0, 300),
    description: (input.description || bank.reference || bank.counterparty).slice(0, 500),
    amount: Math.abs(amount).toFixed(2),
    currency: bank.currency,
    entryType: amount < 0 ? "expense" : "income",
    statementRef: `${bank.accountId}${bank.wallet ? ` ${bank.wallet}` : ""}`,
    ...(input.category ? { category: input.category.slice(0, 120) } : {}),
    sourceType: "statement",
    sourceKey: `statement:${bankKey}`,
  }, `statement:${bankKey}`);
  if (input.documentId) await createDocumentLink(client, { documentId: input.documentId, transactionId: item.id, coverageType: "evidence" });
  await mutateMonth(client, period, by, "create-ledger", { bankKey, transactionId: item.id, duplicate, ...(input.documentId ? { documentId: input.documentId } : {}) }, (record) => {
    if (!record.decisions.pairs.some((pair) => pair.bankKey === bankKey)) {
      record.decisions.pairs.push({ bankKey, transactionId: item.id, by, at: new Date().toISOString(), note: "ledger row created from bank row" });
    }
  });
  return { transaction: item, duplicate };
}

/** The approver signs off the month's exception list exactly as it stands now. */
export async function confirmExceptions(client: DynamoDBDocumentClient, period: string, by: string) {
  const view = await buildMonth(client, period);
  const exceptions = view.rows.filter((row) => row.exception);
  const unproven = exceptions.filter((row) => !row.exception!.satisfied);
  if (unproven.length) throw new MonthGateError(`${unproven.length} exception rows still lack their proof`, unproven.map((row) => ({ id: row.id, kind: row.exception!.kind, proof: row.exception!.proof })));
  return mutateMonth(client, period, by, "confirm-exceptions", { digest: view.exceptionDigest, count: exceptions.length }, (record) => {
    record.exceptionConfirmation = { digest: view.exceptionDigest, by, at: new Date().toISOString(), count: exceptions.length };
  });
}

export async function closeMonth(client: DynamoDBDocumentClient, period: string, by: string) {
  const view = await buildMonth(client, period);
  if (view.state === "closed") throw new MonthClosedError(period);
  const blockers = view.rows.filter((row) => row.status !== "matched");
  if (blockers.length) {
    throw new MonthGateError(
      `Month ${period} cannot close: ${blockers.length} rows lack a side`,
      blockers.map((row) => ({ id: row.id, date: row.date, counterparty: row.counterparty, amount: row.amount, currency: row.currency, status: row.status, missing: row.missing })),
    );
  }
  if (view.counters.exceptions && !view.exceptionConfirmation?.current) {
    throw new MonthGateError(`Month ${period} cannot close: the ${view.counters.exceptions} exception rows need the approver's confirmation (dataops reconcile confirm-exceptions ${period})`, []);
  }
  return mutateMonth(client, period, by, "close", { rows: view.counters.rows, exceptions: view.counters.exceptions }, (record) => {
    record.state = "closed";
    record.closed = { by, at: new Date().toISOString() };
  });
}

export async function reopenMonth(client: DynamoDBDocumentClient, period: string, by: string, reason: string) {
  if (!reason || !reason.trim()) throw badRequest("reason is required to reopen a month");
  const record = await getMonth(client, period);
  if (record.state !== "closed") throw badRequest(`Month ${period} is not closed`);
  return mutateMonth(client, period, by, "reopen", { reason: reason.slice(0, 500), closed: record.closed }, (next) => {
    next.state = "open";
    delete next.closed;
    // Anything may change once reopened, so the approver confirms again.
    delete next.exceptionConfirmation;
  }, { allowClosed: true });
}

export async function assertMonthOpen(client: DynamoDBDocumentClient, period: string) {
  const record = await getMonth(client, period);
  if (record.state === "closed") throw new MonthClosedError(period);
}

/** Short text summary of a month, for the month card and notifications. */
export function monthSummary(view: MonthView): string {
  const c = view.counters;
  return [
    `Reconciliation ${view.period} (${view.state}): ${c.rows} rows, ${c.matched} matched.`,
    `${c.bankWithoutInvoice} bank rows without invoice, ${c.ledgerWithoutBank} ledger rows without payment proof, ${c.amountMismatch} amount mismatches, ${c.needsReview} need review, ${c.exceptions} exceptions.`,
    view.blockers ? `${view.blockers} rows block closing.` : "Nothing blocks closing.",
  ].join(" ");
}

export const digestOf = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
