/**
 * Statement import without flags: the bank is recognised from the file
 * itself (PDF layout markers), the rows are parsed
 * through that bank's fixed layout, stored as one statement per calendar
 * month, and every touched month is re-reconciled and summarised. Used by
 * the email intake (a statement sent to the invoice address), the
 * statement import route and the historical import.
 */
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { getArtifact, updateArtifact } from "../db/artifacts";
import { getIntakeItem } from "../db/intake";
import { createNotification } from "../db/notifications";
import { pdfText } from "../invoices/extract";
import {
  ParseError,
  parseStatementDate,
  type ParsedStatement,
  type StatementAccount,
} from "./parsers";
import { detectPdfStatementAccount, parseFinomPdfText, parseRevolutPdfText } from "./pdfLayouts";
import { saveStatement, type StatementRecord } from "./service";
import { buildMonths, getMonth, monthSummary } from "./monthService";
import { autoMatchMonths, matchCountsText, matchesOf, type AutoMatchResult, type MatchesView } from "./autoMatch";

export type StatementSource = { documentId?: string; artifactId?: string; filename?: string; contentType: string };

export type ImportedStatement = {
  account: StatementAccount;
  layout: string;
  statements: Array<Pick<StatementRecord, "id" | "period" | "from" | "to"> & { rowCount: number }>;
  skippedClosedMonths: string[];
  parsed: ParsedStatement;
  summaries: string[];
  autoMatch: AutoMatchResult;
  matches: Array<MatchesView["counts"] & { period: string }>;
};

export class UnrecognizedStatementError extends Error {
  statusCode = 422;
}

const isPdf = (contentType: string, bytes: Buffer) => contentType === "application/pdf" || bytes.subarray(0, 5).toString("ascii") === "%PDF-";
let statementPdfText = pdfText;
export function setStatementPdfTextForTests(extractor?: typeof pdfText) {
  statementPdfText = extractor ?? pdfText;
}

function safeFilename(filename?: string): string {
  return String(filename || "uploaded statement.pdf").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 200);
}

function pdfErrorLine(text: string, message: string): { number: number; text: string } {
  const source = text.split(/\r?\n/).map((line, index) => ({ number: index + 1, text: line.trim() })).filter((line) => line.text);
  const date = message.match(/\b(\d{4}-\d{2}-\d{2}|\d{1,2}\.\d{1,2}\.\d{4}|\d{1,2} [A-Z][a-z]{2} \d{4})\b/)?.[1];
  for (const line of source) {
    const printed = line.text.match(/^(\d{1,2}\.\d{1,2}\.\d{4}|\d{1,2} [A-Z][a-z]{2} \d{4})\b/)?.[1];
    if (!printed) continue;
    if (!date && /(?:unreadable date|date out of range)/i.test(message)) {
      try { parseStatementDate(printed); } catch { return line; }
    }
    if (!date) continue;
    if (printed === date) return line;
    try { if (parseStatementDate(printed) === parseStatementDate(date)) return line; }
    catch { if (/(?:unreadable date|date out of range)/i.test(message)) return line; }
  }
  const summary = message.match(/Money in|Money out|Opening balance|Closing balance/i)?.[0];
  if (summary) {
    const line = source.find((candidate) => candidate.text.startsWith(summary));
    if (line) return line;
  }
  if (/balance|reconcil/i.test(message)) {
    const line = source.find((candidate) => /^Closing balance\s*:/.test(candidate.text));
    if (line) return line;
  }
  if (/zero transaction rows|no transactions/i.test(message)) {
    const line = source.find((candidate) => /^(Completed|Date \(UTC\))/i.test(candidate.text));
    if (line) return line;
  }
  if (/header|layout|column/i.test(message)) {
    const line = source.find((candidate) => /^(Completed|Date \(UTC\))/i.test(candidate.text));
    if (line) return line;
  }
  return source.find((candidate) => /^\d{2}\.\d{2}\.\d{4}|^\d{1,2} [A-Z][a-z]{2} \d{4}/.test(candidate.text))
    || source[0]
    || { number: 1, text: "(no extractable statement text)" };
}

function pdfFailure(error: unknown, text: string, filename?: string): ParseError {
  const message = error instanceof Error ? error.message : String(error);
  const source = pdfErrorLine(text, message);
  const excerpt = source.text.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 240);
  return new ParseError(`${safeFilename(filename)}: line ${source.number}, source text "${excerpt}": ${message}`);
}

/** Recognize and completely parse a supported bank PDF before any statement rows are stored. */
export async function recognizeStatement(bytes: Buffer, contentType: string, options: { currency?: string; expectedAccount?: StatementAccount; filename?: string } = {}): Promise<{ account: StatementAccount; layout: string; parsed: ParsedStatement }> {
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (!isPdf(type, bytes)) {
    throw new UnrecognizedStatementError(`${safeFilename(options.filename)}: bank statement uploads accept PDF files only`);
  }

  let text: string;
  try { text = await statementPdfText(bytes); }
  catch (error) { throw pdfFailure(error, "", options.filename); }
  const account = detectPdfStatementAccount(text);
  if (!account) {
    const message = "PDF is not a recognized Finom or Revolut statement";
    throw new UnrecognizedStatementError(pdfFailure(message, text, options.filename).message);
  }
  if (options.expectedAccount && account !== options.expectedAccount) {
    throw pdfFailure(`PDF contains a ${account} statement, not the selected ${options.expectedAccount} account`, text, options.filename);
  }

  try {
    const parsed = account === "finom" ? parseFinomPdfText(text) : parseRevolutPdfText(text);
    if (!parsed.rows.length) throw new ParseError("PDF statement parsed zero transaction rows");
    return { account, layout: `${account} PDF statement`, parsed };
  } catch (error) {
    throw pdfFailure(error, text, options.filename);
  }
}

/** Store parsed rows as one statement per month; a closed month is left untouched and reported. */
export async function importStatement(
  client: DynamoDBDocumentClient,
  bytes: Buffer,
  source: StatementSource,
  options: { currency?: string; notify?: boolean } = {},
): Promise<ImportedStatement> {
  const { account, layout, parsed } = await recognizeStatement(bytes, source.contentType, { ...options, filename: source.filename });
  const months = [...new Set(parsed.rows.map((row) => row.date.slice(0, 7)))].sort();
  const statements: ImportedStatement["statements"] = [];
  const skippedClosedMonths: string[] = [];
  for (const period of months) {
    if ((await getMonth(client, period)).state === "closed") { skippedClosedMonths.push(period); continue; }
    const rows = parsed.rows.filter((row) => row.date.startsWith(period));
    const balances = parsed.balances.filter((balance) => balance.asOf.startsWith(period));
    const record = await saveStatement(client, {
      accountId: account,
      period,
      ...(source.documentId ? { documentId: source.documentId } : {}),
      ...(source.artifactId ? { artifactId: source.artifactId } : {}),
      ...(source.filename ? { filename: source.filename.slice(0, 300) } : {}),
      contentType: source.contentType,
      rows,
      ...(balances.length ? { balances } : {}),
      ...(parsed.warnings.length && period === months.at(-1) ? { warnings: parsed.warnings } : {}),
    });
    statements.push({ id: record.id, period, from: record.from, to: record.to, rowCount: rows.length });
  }
  const touched = statements.map((statement) => statement.period);
  // The matcher runs on every upload: confident pairs are persisted before the months are summarised.
  const autoMatch = await autoMatchMonths(client, touched);
  const views = touched.length ? await buildMonths(client, touched) : [];
  const matches = views.map((view) => ({ period: view.period, ...matchesOf(view).counts }));
  const summaries = views.map(monthSummary);
  if (options.notify && views.length) {
    const latest = views[views.length - 1];
    await createNotification(client, {
      type: "reconcile-month",
      message: `${account} statement imported (${parsed.rows.length} rows, ${touched.join(", ")}). ${summaries.at(-1)} ${matchCountsText(matches[matches.length - 1])}`,
      metadata: { period: latest.period, account, statements: statements.map((statement) => statement.id), counters: latest.counters, matches: matches[matches.length - 1], autoMatched: autoMatch.attached, blockers: latest.blockers, audience: "finance-operator" },
    });
  }
  return { account, layout, statements, skippedClosedMonths, parsed, summaries, autoMatch, matches };
}

let s3 = new S3Client({});
export function setStatementIntakeStorageForTests(client: S3Client) { s3 = client; }

async function artifactContent(client: DynamoDBDocumentClient, artifactId: string): Promise<{ bytes: Buffer; contentType: string; filename?: string }> {
  const artifact = await getArtifact(client, artifactId);
  if (!artifact || artifact.metadata?.importState !== "complete") throw new Error("source-document-unavailable");
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(artifact.storageUri || "");
  if (!match || match[1] !== process.env.EMAIL_DOCUMENTS_BUCKET) throw new Error("source-document-boundary-mismatch");
  const object = await s3.send(new GetObjectCommand({ Bucket: match[1], Key: match[2] }));
  if (!object.Body) throw new Error("source-document-unavailable");
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of object.Body as unknown as AsyncIterable<Uint8Array>) {
    const chunk = Buffer.from(part);
    size += chunk.length;
    if (size > 25 * 1024 * 1024) throw new Error("source-document-size-mismatch");
    parts.push(chunk);
  }
  return { bytes: Buffer.concat(parts), contentType: String(artifact.contentType || "application/octet-stream"), ...(artifact.filename ? { filename: String(artifact.filename) } : {}) };
}

const STATEMENT_ATTACHMENT = /\.(csv|xlsx|pdf)$/i;

/**
 * Email intake imports PDF Finom or Revolut statements and tags them so
 * invoice processing skips them. CSV/XLSX exports are reported as rejected
 * PDF-only statement inputs and are never imported.
 */
export async function processStatementIntake(client: DynamoDBDocumentClient, intakeItemId: string): Promise<{ imported: ImportedStatement[]; issues: string[] }> {
  const intake = await getIntakeItem(client, intakeItemId);
  if (!intake) throw new Error("intake-not-found");
  const imported: ImportedStatement[] = [];
  const issues: string[] = [];
  // Issues name attachments by position: the response and logs never echo filenames.
  for (const [index, ref] of (intake.artifactRefs || []).entries()) {
    const label = `attachment ${index + 1}`;
    const artifact = await getArtifact(client, ref.artifactId);
    if (!artifact || artifact.metadata?.importState !== "complete") continue;
    if (artifact.metadata?.reconcileStatement) continue;
    const contentType = String(artifact.contentType || "");
    if (!STATEMENT_ATTACHMENT.test(String(artifact.filename || "")) && !/csv|spreadsheetml|ms-excel|pdf/.test(contentType)) continue;
    let content: Awaited<ReturnType<typeof artifactContent>>;
    try { content = await artifactContent(client, artifact.id); } catch {
      if (!/pdf/.test(contentType)) issues.push(`${label}: could not read the attachment`);
      continue;
    }
    try {
      const result = await importStatement(client, content.bytes, { artifactId: artifact.id, contentType: content.contentType, ...(content.filename ? { filename: content.filename } : {}) }, { notify: true });
      imported.push(result);
      await updateArtifact(client, artifact.id, { metadata: { ...(artifact.metadata || {}), reconcileStatement: { account: result.account, statements: result.statements.map((statement) => statement.id) } } });
      if (result.skippedClosedMonths.length) issues.push(`${label}: months ${result.skippedClosedMonths.join(", ")} are closed; reopen them to import these rows`);
    } catch (error) {
      if (error instanceof UnrecognizedStatementError || error instanceof ParseError) {
        // A PDF that is no statement is an invoice or receipt: invoice processing takes it.
        if (!isPdf(content.contentType.toLowerCase(), content.bytes)) issues.push(`${label}: ${error.message.replace(/ \(headers: .*\)$/, "")}`);
        continue;
      }
      throw error;
    }
  }
  return { imported, issues };
}
