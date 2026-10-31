/**
 * Statement import without flags: the bank is recognised from the file
 * itself (CSV/XLSX header row, or PDF layout markers), the rows are parsed
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
  csvHeaders,
  detectStatementAccount,
  parseStatementCsv,
  parseStatementXlsx,
  ParseError,
  type ParsedStatement,
  type StatementAccount,
} from "./parsers";
import { detectPdfStatementAccount, parseFinomPdfText, parseRevolutPdfText } from "./pdfLayouts";
import { saveStatement, type StatementRecord } from "./service";
import { buildMonths, getMonth, monthSummary } from "./monthService";

export type StatementSource = { documentId?: string; artifactId?: string; filename?: string; contentType: string };

export type ImportedStatement = {
  account: StatementAccount;
  layout: string;
  statements: Array<Pick<StatementRecord, "id" | "period" | "from" | "to"> & { rowCount: number }>;
  skippedClosedMonths: string[];
  parsed: ParsedStatement;
  summaries: string[];
};

export class UnrecognizedStatementError extends Error {
  statusCode = 422;
}

const XLSX = /spreadsheetml|ms-excel/;
const isPdf = (contentType: string, bytes: Buffer) => contentType === "application/pdf" || bytes.subarray(0, 5).toString("ascii") === "%PDF-";

/** Which bank, which layout, and the parsed rows; throws UnrecognizedStatementError when the file is no known statement. */
export async function recognizeStatement(bytes: Buffer, contentType: string, options: { currency?: string } = {}): Promise<{ account: StatementAccount; layout: string; parsed: ParsedStatement }> {
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (isPdf(type, bytes)) {
    const text = await pdfText(bytes);
    const account = detectPdfStatementAccount(text);
    if (!account) throw new UnrecognizedStatementError("PDF is not a recognized Finom or Revolut statement");
    const parsed = account === "finom" ? parseFinomPdfText(text) : parseRevolutPdfText(text);
    return { account, layout: `${account} PDF statement`, parsed };
  }
  if (XLSX.test(type)) {
    for (const account of ["revolut", "finom"] as StatementAccount[]) {
      try {
        return { account, layout: `${account} workbook`, parsed: await parseStatementXlsx(bytes, account, options) };
      } catch (error) {
        if (!(error instanceof ParseError) || !/unrecognized/.test(error.message)) throw error;
      }
    }
    throw new UnrecognizedStatementError("workbook is not a recognized Finom or Revolut statement export");
  }
  const text = bytes.toString("utf8");
  const headers = csvHeaders(text);
  const detected = detectStatementAccount(headers);
  if (!detected) {
    throw new UnrecognizedStatementError(`CSV is not a recognized Finom or Revolut statement export (headers: ${headers.slice(0, 12).join(", ")}${headers.length > 12 ? ", …" : ""})`);
  }
  return { account: detected.account, layout: detected.layout, parsed: parseStatementCsv(text, detected.account, options) };
}

/** Store parsed rows as one statement per month; a closed month is left untouched and reported. */
export async function importStatement(
  client: DynamoDBDocumentClient,
  bytes: Buffer,
  source: StatementSource,
  options: { currency?: string; notify?: boolean } = {},
): Promise<ImportedStatement> {
  const { account, layout, parsed } = await recognizeStatement(bytes, source.contentType, options);
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
  const views = touched.length ? await buildMonths(client, touched) : [];
  const summaries = views.map(monthSummary);
  if (options.notify && views.length) {
    const latest = views[views.length - 1];
    await createNotification(client, {
      type: "reconcile-month",
      message: `${account} statement imported (${parsed.rows.length} rows, ${touched.join(", ")}). ${summaries.at(-1)}`,
      metadata: { period: latest.period, account, statements: statements.map((statement) => statement.id), counters: latest.counters, blockers: latest.blockers, audience: "finance-operator" },
    });
  }
  return { account, layout, statements, skippedClosedMonths, parsed, summaries };
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
 * Email intake: every attachment that is a Finom or Revolut statement is
 * imported and tagged so invoice processing skips it. Non-PDF attachments
 * that are no known statement are reported back instead of dropped.
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
