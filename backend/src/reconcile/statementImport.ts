import { createHash } from "crypto";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { transactBookkeeping } from "../db/bookkeeping";
import { TABLE_BOOKKEEPING } from "../db/tableNames";
import { getMonth } from "./monthService";
import { listStatementHistory, statementIdFor, type StatementRecord } from "./service";
import type { ParsedStatement, StatementAccount } from "./parsers";
import { canonicalStatementValue, defaultStatementSelection, overlaps, selectedStatementRecords, statementDifferences, walletKey, verifiedStatementSelection } from "./statementSelection";
import { statementSourceBytes } from "./statementSource";
import type { StatementSource } from "./statementIntake";
import { coverageGaps } from "./match";

export class StatementIdentityReviewError extends Error {
  statusCode = 422;
  constructor(readonly account: StatementAccount) { super("Statement header has no stable bank account identifier; an IBAN or account number is required before import. Source retained for review; no active statement changed."); }
}

export type StatementImportOptions = { preview?: boolean; replace?: boolean; previewDigest?: string; expectedAccount?: StatementAccount; expectedPeriod?: string; by?: string };
const conflict = (message: string) => Object.assign(new Error(message), { statusCode: 409 });
const digest = (value: unknown) => createHash("sha256").update(canonicalStatementValue(value)).digest("hex");

/** Read original PDF headers, including historical records parsed before header coverage was saved. */
export async function verifiedStatementRecord(client: DynamoDBDocumentClient, record: StatementRecord): Promise<StatementRecord> {
  if (record.contentType !== "application/pdf" && !/\.pdf$/i.test(record.filename || "")) return record;
  const source = await statementSourceBytes(client, record);
  const { recognizeStatement, statementPeriodForMonth } = await import("./statementIntake");
  const { parsed } = await recognizeStatement(source.bytes, source.contentType, { expectedAccount: record.accountId, filename: source.filename });
  return { ...record, ...statementPeriodForMonth(record.period, parsed.period), issueDate: parsed.issueDate, bankAccounts: parsed.bankAccounts,
    openingBalances: parsed.openingBalances?.filter((balance) => balance.asOf.startsWith(record.period)), balances: parsed.balances.filter((balance) => balance.asOf.startsWith(record.period)),
    rows: parsed.rows.filter((row) => row.date.startsWith(record.period)) };
}

export async function statementPackageSources(client: DynamoDBDocumentClient, period: string) {
  const history = (await listStatementHistory(client)).filter((record) => record.period === period);
  const month = await getMonth(client, period);
  const records: StatementRecord[] = [];
  const problems: Array<{ rowId: string; reference: string; reason: string }> = [];
  const warnings: Array<{ rowId: string; reference: string; reason: string }> = [];
  const explicitIds = month.statementSelection ? new Set(Object.values(month.statementSelection).flatMap((refs) => refs.map((ref) => ref.id))) : undefined;
  for (const record of history) {
    // A confirmed active selection never reparses or gates on superseded history.
    if (explicitIds && !explicitIds.has(record.id)) continue;
    try { records.push(await verifiedStatementRecord(client, record)); }
    catch (error) {
      const problem = { rowId: record.id, reference: record.filename || record.id, reason: `Statement validation failed: ${(error as Error).message}` };
      if (explicitIds?.has(record.id)) problems.push(problem); else warnings.push(problem);
    }
  }
  const selection = month.statementSelection ? verifiedStatementSelection(month.statementSelection, history, records) : defaultStatementSelection(records);
  const selected = selectedStatementRecords(records, selection);
  for (const id of explicitIds || []) if (!history.some((record) => record.id === id)) problems.push({ rowId: id, reference: id, reason: "Selected statement source is unavailable" });
  if (!explicitIds && warnings.length) problems.push(...warnings);
  for (const key of Object.keys(selection).filter((key) => key.startsWith("finom|") && selection[key].some((ref) => selected.some((record) => record.id === ref.id && (record.contentType === "application/pdf" || /\.pdf$/i.test(record.filename || "")))))) {
    const ranges = selection[key].filter((ref) => selected.some((record) => record.id === ref.id)).map((ref) => {
      const record = selected.find((item) => item.id === ref.id)!;
      return { from: record.from!, to: record.to! };
    });
    if (coverageGaps(period, ranges).gaps.length) problems.push({ rowId: period, reference: key, reason: "Finom statement coverage must include every calendar day from the first through the last day of the month" });
  }
  return { statements: selected, problems, warnings };
}

/** Preview and commit use the same parsed bytes; every month/wallet changes in one CAS transaction. */
export async function prepareStatementImport(client: DynamoDBDocumentClient, source: StatementSource, account: StatementAccount, parsed: ParsedStatement, options: StatementImportOptions) {
  const { statementPeriodForMonth } = await import("./statementIntake");
  if (options.expectedAccount && account !== options.expectedAccount) throw new Error("Statement bank differs from selected account");
  const periods = [...new Set([...parsed.rows.map((row) => row.date.slice(0, 7)), ...parsed.balances.map((row) => row.asOf.slice(0, 7))])].sort();
  if (options.expectedPeriod && !periods.includes(options.expectedPeriod)) throw new Error("Statement header/rows do not cover the selected month");
  if (periods.length > 24) throw new Error("Import at most 24 months in one statement batch");
  const missingIdentity = [...parsed.rows, ...parsed.balances].some((row) => !parsed.bankAccounts?.[`${row.wallet || "main"}|${row.currency}`]);
  if (missingIdentity) throw new StatementIdentityReviewError(account);
  const history = await listStatementHistory(client);
  const months = await Promise.all(periods.map((period) => getMonth(client, period)));
  const skippedClosedMonths = months.filter((month) => month.state === "closed").map((month) => month.period);
  const candidates: StatementRecord[] = [];
  const replacements: Array<{ period: string; wallets: string[]; difference: ReturnType<typeof statementDifferences> }> = [];
  const plans = [];
  const metadataUpdates = new Map<string, { original: StatementRecord; verified: StatementRecord }>();
  const now = new Date().toISOString();
  for (const month of months) {
    if (month.state === "closed") continue;
    const period = month.period;
    const activeIds = month.statementSelection ? new Set(Object.values(month.statementSelection).flatMap((refs) => refs.map((ref) => ref.id))) : undefined;
    const own = history.filter((record) => record.period === period && (!activeIds || activeIds.has(record.id)));
    // Only this bank's sources need byte revalidation; other accounts stay untouched.
    const verified = await Promise.all(own.map((record) => record.accountId === account ? verifiedStatementRecord(client, record) : record));
    const selection = month.statementSelection ? verifiedStatementSelection(month.statementSelection, own, verified) : defaultStatementSelection(verified);
    for (const record of verified) {
      const original = history.find((item) => item.id === record.id)!;
      if (record.accountId === account && canonicalStatementValue({ bankAccounts: record.bankAccounts, from: record.from, to: record.to, issueDate: record.issueDate, openingBalances: record.openingBalances, balances: record.balances }) !== canonicalStatementValue({ bankAccounts: original.bankAccounts, from: original.from, to: original.to, issueDate: original.issueDate, openingBalances: original.openingBalances, balances: original.balances })) metadataUpdates.set(record.id, { original, verified: record });
    }
    const active = selectedStatementRecords(verified, selection);
    const id = statementIdFor(source.documentId || `artifact:${source.artifactId}`, account, period);
    const previous = history.find((record) => record.id === id);
    const rows = parsed.rows.filter((row) => row.date.startsWith(period));
    const balances = parsed.balances.filter((balance) => balance.asOf.startsWith(period));
    const bounds = statementPeriodForMonth(period, parsed.period) || { from: rows.map((row) => row.date).sort()[0], to: rows.map((row) => row.date).sort().at(-1)! };
    const candidate: StatementRecord = { id, recordType: "reconcile-statement", accountId: account, period, ...source, rows, balances, ...bounds,
      bankAccounts: parsed.bankAccounts, ...(parsed.issueDate ? { issueDate: parsed.issueDate } : {}), ...(parsed.openingBalances ? { openingBalances: parsed.openingBalances.filter((balance) => balance.asOf.startsWith(period)) } : {}),
      warnings: parsed.warnings, createdAt: previous?.createdAt || now, updatedAt: now };
    if (verified.some((record) => record.accountId === account && overlaps(record, candidate) && [...record.rows, ...(record.balances || [])].some((row) => !record.bankAccounts?.[`${row.wallet || "main"}|${row.currency}`]))) throw new StatementIdentityReviewError(account);
    const keys = [...new Set([...rows, ...balances].map((row) => walletKey(candidate, row)))].sort();
    const existing = active.flatMap((record) => {
      if (record.accountId !== account || !overlaps(record, candidate)) return [];
      const matchingRows = record.rows.filter((row) => keys.includes(walletKey(record, row)));
      const matchingBalances = (record.balances || []).filter((row) => keys.includes(walletKey(record, row)));
      return matchingRows.length || matchingBalances.length ? [{ ...record, rows: matchingRows, balances: matchingBalances, openingBalances: record.openingBalances?.filter((row) => keys.includes(walletKey(record, row))) }] : [];
    });
    if (existing.length) replacements.push({ period, wallets: keys, difference: statementDifferences(existing, candidate) });
    for (const key of keys) selection[key] = [...(selection[key] || []).filter((ref) => !overlaps(ref, candidate)), { id, from: candidate.from!, to: candidate.to! }];
    candidates.push(candidate);
    plans.push({ month, selection, previous });
  }
  // Exclude the generated timestamp; bind confirmation to source bytes/parsed values and all current versions.
  const previewDigest = digest({ source, account, parsed, versions: months.map((month) => [month.period, month.version]), history: history.filter((record) => periods.includes(record.period)).map((record) => [record.id, record.updatedAt]).sort(), replacements });
  const requiresConfirmation = replacements.length > 0;
  const preview = { digest: previewDigest, requiresConfirmation, replacements, candidateIssueDate: parsed.issueDate,
    message: requiresConfirmation ? (replacements.every((item) => item.difference.identical) ? "A statement already exists. No differences in operations, balances or coverage. Replace it?" : "A statement already exists. Review the differences before replacing it.") : "No overlapping active statement exists." };
  if (options.preview || (requiresConfirmation && !options.replace)) return { preview, committed: false, statements: [], skippedClosedMonths };
  if (requiresConfirmation && options.previewDigest !== previewDigest) throw conflict("Statement preview is stale or missing; preview again before replacing");
  if (options.replace && options.previewDigest && options.previewDigest !== previewDigest) throw conflict("Statement preview changed; preview again before replacing");
  if (!candidates.length) return { preview, committed: true, statements: [], skippedClosedMonths };
  const transact = plans.flatMap(({ month, selection, previous }, index) => {
    const candidate = candidates[index];
    const next = { ...month, statementSelection: selection, version: month.version + 1, updatedAt: now,
      log: [...month.log, { at: now, by: options.by || "statement-import", action: "import-statement", detail: { statementId: candidate.id, replaced: replacements.filter((item) => item.period === month.period).flatMap((item) => item.difference.existing.map((record) => record.id)) } }].slice(-2000) };
    return [{ Put: { TableName: TABLE_BOOKKEEPING, Item: { PK: `STATEMENT#${candidate.id}`, SK: `STATEMENT#${candidate.id}`, ...candidate },
      ConditionExpression: previous ? "updatedAt = :updatedAt" : "attribute_not_exists(PK)", ...(previous ? { ExpressionAttributeValues: { ":updatedAt": previous.updatedAt } } : {}) } },
    { Put: { TableName: TABLE_BOOKKEEPING, Item: { PK: `RECONCILE-MONTH#${month.period}`, SK: `RECONCILE-MONTH#${month.period}`, ...next },
      ConditionExpression: month.version ? "version = :version" : "attribute_not_exists(PK)", ...(month.version ? { ExpressionAttributeValues: { ":version": month.version } } : {}) } }];
  });
  const candidateIds = new Set(candidates.map((record) => record.id));
  for (const { original, verified } of metadataUpdates.values()) {
    if (candidateIds.has(original.id)) continue; // One operation per item in the atomic batch.
    // Migrate identity/header metadata atomically with selection. Retain monetary rows.
    const migrated = { ...original, bankAccounts: verified.bankAccounts, from: verified.from, to: verified.to,
      ...(verified.issueDate ? { issueDate: verified.issueDate } : {}), ...(verified.openingBalances ? { openingBalances: verified.openingBalances } : {}), ...(verified.balances ? { balances: verified.balances } : {}), updatedAt: now };
    transact.push({ Put: { TableName: TABLE_BOOKKEEPING, Item: { PK: `STATEMENT#${original.id}`, SK: `STATEMENT#${original.id}`, ...migrated },
      ConditionExpression: "updatedAt = :updatedAt", ExpressionAttributeValues: { ":updatedAt": original.updatedAt } } });
  }
  try { await transactBookkeeping(client, { TransactItems: transact }); }
  catch (error) {
    if (["TransactionCanceledException", "ConditionalCheckFailedException"].includes((error as Error).name)) throw conflict("Statement selection changed; preview again before importing");
    throw error;
  }
  return { preview, committed: true, statements: candidates.map((record) => ({ id: record.id, period: record.period, from: record.from, to: record.to, rowCount: record.rows.length })), skippedClosedMonths };
}
