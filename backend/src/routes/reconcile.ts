import { GetObjectCommand } from "@aws-sdk/client-s3";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { LambdaEvent, LambdaResponse } from "../types";
import { financeActor } from "../sponsorFinance/repository";
import { getRawDocument } from "../db/bookkeeping";
import { json, MONTH, parse, s3 } from "./bookkeepingShared";
import {
  parseStatement,
  statementTotal,
  STATEMENT_ACCOUNTS,
  type ParsedStatement,
  type StatementAccount,
} from "../reconcile/parsers";
import {
  buildReport,
  deleteAlias,
  deleteStatement,
  getStatement,
  listAliases,
  listStatements,
  saveAlias,
  saveStatement,
} from "../reconcile/service";
import { recordRequestError } from "../requestErrorLog";

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const header = (event: LambdaEvent, name: string) =>
  Object.entries(event.headers || {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] || "";

function fail(error: unknown): LambdaResponse {
  recordRequestError(error);
  const statusCode = Number((error as { statusCode?: number }).statusCode || 0);
  if (statusCode === 401 || statusCode === 403) return json(statusCode, { error: statusCode === 401 ? "Unauthorized" : "Forbidden" });
  const message = (error as Error).message || "Reconcile request failed";
  if (statusCode) return json(statusCode, { error: message });
  return json(400, { error: message });
}

async function documentBytes(client: DynamoDBDocumentClient, documentId: string): Promise<{ bytes: Buffer; contentType: string; filename?: string }> {
  const document = await getRawDocument(client, documentId);
  if (!document || document.status !== "active") throw Object.assign(new Error("Statement document not found"), { statusCode: 404 });
  if (!["bank-statement", "private-account-statement"].includes(String(document.documentType)))
    throw new Error("Document is not a bank statement");
  const bucket = process.env.BOOKKEEPING_DOCUMENTS_BUCKET;
  if (!bucket) throw Object.assign(new Error("Document storage unavailable"), { statusCode: 503 });
  const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: String(document.s3Key) }));
  if (!object.Body) throw new Error("Statement object is empty");
  const chunks: Buffer[] = [];
  for await (const part of object.Body as unknown as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(part));
  return { bytes: Buffer.concat(chunks), contentType: String(document.contentType || "text/csv"), ...(document.originalFilename ? { filename: String(document.originalFilename) } : {}) };
}

export async function handleReconcileRoutes(
  path: string,
  method: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse> {
  try {
    await financeActor(client, header(event, "x-user-id"));
    const route = path.match(/^\/api\/reconcile(\/[^/]+(?:\/[^/]+)?)?$/);
    const action = route?.[1] || "";
    const query = event.queryStringParameters || {};

    if (action === "/report" && method === "GET") {
      const period = String(query.period || "");
      if (!MONTH.test(period)) return json(400, { error: "period must be YYYY-MM" });
      return json(200, await buildReport(client, period));
    }

    if (action === "/statements" && method === "GET") {
      const items = await listStatements(client);
      const period = query.period;
      return json(200, { items: period ? items.filter((item) => item.period === period) : items });
    }

    if (action === "/statements" && method === "POST") {
      const body = parse(event.body || null);
      if (!body) return json(400, { error: "Invalid JSON" });
      const account = String(body.account || "");
      if (!STATEMENT_ACCOUNTS.includes(account as StatementAccount)) return json(400, { error: `account must be one of ${STATEMENT_ACCOUNTS.join(", ")}` });
      const period = String(body.period || "");
      if (!MONTH.test(period)) return json(400, { error: "period must be YYYY-MM" });
      if (body.documentId !== undefined && !OPAQUE_ID.test(String(body.documentId))) return json(400, { error: "Invalid documentId" });
      const statement = await saveStatement(client, {
        accountId: account as StatementAccount,
        period,
        ...(body.documentId ? { documentId: String(body.documentId) } : {}),
        ...(body.filename ? { filename: String(body.filename).slice(0, 300) } : {}),
        ...(body.contentType ? { contentType: String(body.contentType).slice(0, 120) } : {}),
        rows: body.rows as never,
        ...(Array.isArray(body.warnings) ? { warnings: body.warnings.filter((warning: unknown) => typeof warning === "string") as string[] } : {}),
      });
      return json(201, { statement });
    }

    if (action === "/statements/parse" && method === "POST") {
      const body = parse(event.body || null);
      if (!body) return json(400, { error: "Invalid JSON" });
      const account = String(body.account || "");
      if (!STATEMENT_ACCOUNTS.includes(account as StatementAccount)) return json(400, { error: `account must be one of ${STATEMENT_ACCOUNTS.join(", ")}` });
      const documentId = String(body.documentId || "");
      if (!OPAQUE_ID.test(documentId)) return json(400, { error: "documentId is required" });
      const source = await documentBytes(client, documentId);
      let parsed: ParsedStatement;
      try {
        parsed = await parseStatement(source.contentType, source.bytes, account as StatementAccount);
      } catch (error) {
        return json(422, { error: `Statement parsing failed: ${(error as Error).message}` });
      }
      return json(200, {
        accountId: account as StatementAccount,
        documentId,
        ...(source.filename ? { filename: source.filename } : {}),
        contentType: source.contentType,
        rowCount: parsed.rows.length,
        incomingCount: parsed.rows.filter((row) => Number(row.amount) > 0).length,
        incomingTotal: statementTotal(parsed.rows.filter((row) => Number(row.amount) > 0)),
        rows: parsed.rows,
        warnings: parsed.warnings,
      });
    }

    const statementId = action.match(/^\/statements\/([^/]+)$/);
    if (statementId && method === "GET") {
      const statement = await getStatement(client, decodeURIComponent(statementId[1]));
      if (!statement) return json(404, { error: "Statement not found" });
      return json(200, { statement });
    }
    if (statementId && method === "DELETE") {
      const statement = await getStatement(client, decodeURIComponent(statementId[1]));
      if (!statement) return json(404, { error: "Statement not found" });
      await deleteStatement(client, statement.id);
      return json(200, { deleted: statement.id });
    }

    if (action === "/aliases" && method === "GET") return json(200, { items: await listAliases(client) });
    if (action === "/aliases" && method === "POST") {
      const body = parse(event.body || null);
      if (!body) return json(400, { error: "Invalid JSON" });
      try {
        const alias = await saveAlias(client, String(body.alias || ""), String(body.sponsor || ""));
        return json(201, { alias });
      } catch (error) {
        return json(400, { error: (error as Error).message });
      }
    }
    const aliasId = action.match(/^\/aliases\/([^/]+)$/);
    if (aliasId && method === "DELETE") {
      await deleteAlias(client, decodeURIComponent(aliasId[1]));
      return json(200, { deleted: decodeURIComponent(aliasId[1]) });
    }

    return json(404, { error: "Not found" });
  } catch (error) {
    return fail(error);
  }
}
