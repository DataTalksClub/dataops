import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { LambdaEvent, LambdaResponse } from "../types";
import { financeActor } from "../sponsorFinance/repository";
import { json, MONTH, parse } from "./bookkeepingShared";
import {
  ParseError,
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
  latestBalances,
  listAliases,
  listStatements,
  saveAlias,
} from "../reconcile/service";
import { recordRequestError } from "../requestErrorLog";
import {
  assertMonthOpen,
  attachDocument,
  restoreLedgerRow,
  attachProof,
  buildMonth,
  buildMonths,
  clearException,
  closeMonth,
  confirmExceptions,
  createLedgerFromBank,
  getConfig,
  monthPackage,
  MonthGateError,
  pairRows,
  periodsBetween,
  reopenMonth,
  saveConfig,
  setException,
  setInvoiceDisposition,
  unpairRows,
  voidLedgerRow,
} from "../reconcile/monthService";
import { tableCsv } from "../reconcile/month";
import { importStatement, recognizeStatement, UnrecognizedStatementError } from "../reconcile/statementIntake";
import { autoMatchMonths, matchesOf } from "../reconcile/autoMatch";

import { StatementAccountCollisionError } from "../reconcile/statementSelection";
import { statementSourceBytes as documentBytes } from "../reconcile/statementSource";

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CURRENCY = /^[A-Z]{3}$/;

const header = (event: LambdaEvent, name: string) =>
  Object.entries(event.headers || {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] || "";

function fail(error: unknown): LambdaResponse {
  recordRequestError(error);
  const statusCode = Number((error as { statusCode?: number }).statusCode || 0);
  if (statusCode === 401 || statusCode === 403) return json(statusCode, { error: statusCode === 401 ? "Unauthorized" : "Forbidden" });
  const message = (error as Error).message || "Reconcile request failed";
  if (error instanceof MonthGateError) return json(409, { ...(error.reportPeriod ? { reportPeriod: error.reportPeriod } : {}), error: message, blockers: error.blockers });
  if (error instanceof StatementAccountCollisionError) return json(409, { error: message, identityConflicts: error.identityConflicts });
  if (statusCode) return json(statusCode, { error: message });
  return json(400, { error: message });
}

export async function handleReconcileRoutes(
  path: string,
  method: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse> {
  try {
    const actor = await financeActor(client, header(event, "x-user-id"));
    const monthRoute = path.match(/^\/api\/reconcile\/months(?:\/(\d{4}-\d{2})(?:\/([a-z-]+))?)?$/);
    if (monthRoute) return await handleMonthRoutes(monthRoute[1], monthRoute[2], method, event, client, actor);
    if (path === "/api/reconcile/config" && method === "GET") return json(200, { config: await getConfig(client) });
    if (path === "/api/reconcile/config" && method === "PUT") {
      await financeActor(client, actor.id, true);
      const body = parse(event.body || null);
      if (!body) return json(400, { error: "Invalid JSON" });
      return json(200, { config: await saveConfig(client, body as never, actor.id) });
    }
    const route = path.match(/^\/api\/reconcile(\/[^/]+(?:\/[^/]+)?)?$/);
    const action = route?.[1] || "";
    const query = event.queryStringParameters || {};

    if (action === "/report" && method === "GET") {
      const period = String(query.period || "");
      if (!MONTH.test(period)) return json(400, { error: "period must be YYYY-MM" });
      return json(200, await buildReport(client, period));
    }

    if (action === "/statements" && method === "GET") {
      const items = (await listStatements(client)).map((statement) => ({
        ...statement,
        incomingTotal: statementTotal(statement.rows.filter((row) => Number(row.amount) > 0)),
      }));
      const period = query.period;
      const selected = period ? items.filter((item) => item.period === period) : items;
      return json(200, { items: selected.map((item) => ({
        ...item,
        rowCount: item.rows.length,
        incomingCount: item.rows.filter((row) => Number(row.amount) > 0).length,
      })) });
    }

    if (action === "/statements/import" && method === "POST") {
      // No account or period: the bank and coverage period come from the file.
      const body = parse(event.body || null);
      if (!body) return json(400, { error: "Invalid JSON" });
      const documentId = String(body.documentId || "");
      if (!OPAQUE_ID.test(documentId)) return json(400, { error: "documentId is required" });
      const currency = body.currency === undefined ? undefined : String(body.currency).toUpperCase();
      if (currency !== undefined && !CURRENCY.test(currency)) return json(400, { error: "currency must be a 3-letter ISO code" });
      const source = await documentBytes(client, { documentId });
      try {
        const result = await importStatement(client, source.bytes, { documentId, contentType: source.contentType, ...(source.filename ? { filename: source.filename } : {}) }, { ...(currency ? { currency } : {}), notify: body.notify !== false,
          preview: body.preview === true, replace: body.replace === true,
          ...(typeof body.previewDigest === "string" ? { previewDigest: body.previewDigest } : {}),
          ...(body.account ? { expectedAccount: String(body.account) as StatementAccount } : {}),
          ...(body.period ? { expectedPeriod: String(body.period) } : {}), by: actor.id });
        return json(result.committed ? 201 : 200, {
          preview: result.preview, committed: result.committed, issueDate: result.parsed.issueDate,
          account: result.account, layout: result.layout, statements: result.statements, skippedClosedMonths: result.skippedClosedMonths,
          rowCount: result.parsed.rows.length, balances: result.parsed.balances, warnings: result.parsed.warnings, summaries: result.summaries,
          autoMatch: result.autoMatch, matches: result.matches,
        });
      } catch (error) {
        if (error instanceof UnrecognizedStatementError || error instanceof ParseError) return json(422, { error: `Statement not recognized: ${(error as Error).message}` });
        throw error;
      }
    }

    if (action === "/statements/parse" && method === "POST") {
      const body = parse(event.body || null);
      if (!body) return json(400, { error: "Invalid JSON" });
      const account = String(body.account || "");
      if (!STATEMENT_ACCOUNTS.includes(account as StatementAccount)) return json(400, { error: `account must be one of ${STATEMENT_ACCOUNTS.join(", ")}` });
      const documentId = String(body.documentId || "");
      if (!OPAQUE_ID.test(documentId)) return json(400, { error: "documentId is required" });
      const currency = body.currency === undefined ? undefined : String(body.currency).toUpperCase();
      if (currency !== undefined && !CURRENCY.test(currency)) return json(400, { error: "currency must be a 3-letter ISO code" });
      const source = await documentBytes(client, { documentId });
      let parsed: ParsedStatement;
      try {
        const recognized = await recognizeStatement(source.bytes, source.contentType, {
          expectedAccount: account as StatementAccount,
          ...(currency ? { currency } : {}),
          ...(source.filename ? { filename: source.filename } : {}),
        });
        parsed = recognized.parsed;
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
        balances: parsed.balances,
        warnings: parsed.warnings,
      });
    }

    if (action === "/balances" && method === "GET") {
      const account = query.account ? String(query.account) : undefined;
      if (account !== undefined && !STATEMENT_ACCOUNTS.includes(account as StatementAccount)) return json(400, { error: `account must be one of ${STATEMENT_ACCOUNTS.join(", ")}` });
      return json(200, { items: await latestBalances(client, account as StatementAccount | undefined) });
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

const text = (value: unknown, max = 500) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined);

async function handleMonthRoutes(
  period: string | undefined,
  action: string | undefined,
  method: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
  actor: { id: string; role: string },
): Promise<LambdaResponse> {
  const query = event.queryStringParameters || {};
  if (!period) {
    if (method !== "GET") return json(404, { error: "Not found" });
    const periods = periodsBetween(String(query.from || ""), String(query.to || ""));
    const views = await buildMonths(client, periods);
    return json(200, {
      items: views.map((view) => ({
        period: view.period, state: view.state, counters: view.counters, blockers: view.blockers,
        statements: view.statements.length,
        ...(view.closed ? { closed: view.closed } : {}),
        ...(view.exceptionConfirmation ? { exceptionConfirmation: view.exceptionConfirmation } : {}),
      })),
    });
  }
  if (action === "package" && method === "GET") return json(200, await monthPackage(client, period, { draft: query.draft === "true" }));
  if (action === "matches" && method === "GET") return json(200, matchesOf(await buildMonth(client, period)));
  if (action === "auto-match" && method === "POST") {
    const attached = await autoMatchMonths(client, [period]);
    return json(200, { autoMatch: attached, ...matchesOf(await buildMonth(client, period)) });
  }
  if (!action && method === "GET") {
    const view = await buildMonth(client, period);
    if (query.format === "csv") return { statusCode: 200, headers: { "Content-Type": "text/csv; charset=utf-8" }, body: tableCsv(view) };
    return json(200, view);
  }
  if (method !== "POST") return json(404, { error: "Not found" });
  const body = parse(event.body || null);
  if (!body) return json(400, { error: "Invalid JSON" });
  const id = (field: string) => {
    const value = String(body[field] || "");
    if (!OPAQUE_ID.test(value)) throw Object.assign(new Error(`${field} is required`), { statusCode: 400 });
    return value;
  };
  const rowId = () => {
    const value = String(body.row || "");
    if (!/^(ledger:)?[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw Object.assign(new Error("row is required"), { statusCode: 400 });
    return value;
  };
  switch (action) {
    case "invoice-disposition": {
      await financeActor(client, actor.id, true);
      return json(200, { month: await setInvoiceDisposition(client, period, actor.id, {
        rowId: String(body.rowId || ""), kind: String(body.kind || ""), reason: String(body.reason || ""),
        evidence: String(body.evidence || ""), rowDigest: String(body.rowDigest || ""), version: body.version as number,
        ...(body.targetPeriod ? { targetPeriod: String(body.targetPeriod) } : {}),
      }) });
    }
    case "pair": return json(200, { month: await pairRows(client, period, actor.id, id("bankKey"), id("transactionId"), text(body.note)) });
    case "unpair": return json(200, { month: await unpairRows(client, period, actor.id, id("bankKey"), id("transactionId"), text(body.note)) });
    case "void-ledger": {
      await financeActor(client, actor.id, true);
      return json(200, await voidLedgerRow(client, period, actor.id, id("transactionId"), {
        reason: String(body.reason || ""), duplicateOf: id("duplicateOf"), confirm: body.confirm === true,
      }));
    }
    case "restore-ledger": {
      await financeActor(client, actor.id, true);
      return json(200, await restoreLedgerRow(client, period, actor.id, id("transactionId"), {
        reason: String(body.reason || ""), confirm: body.confirm === true,
      }));
    }
    case "exception": return json(200, { month: await setException(client, period, actor.id, rowId(), String(body.kind || ""), text(body.proof), text(body.note)) });
    case "clear-exception": return json(200, { month: await clearException(client, period, actor.id, rowId()) });
    case "proof": return json(200, { month: await attachProof(client, period, actor.id, id("transactionId"), id("documentId")) });
    case "document": return json(200, { link: await attachDocument(client, period, actor.id, id("transactionId"), id("documentId")) });
    case "ledger": return json(201, await createLedgerFromBank(client, period, actor.id, id("bankKey"), {
      ...(text(body.category, 120) ? { category: text(body.category, 120) } : {}),
      ...(text(body.description) ? { description: text(body.description) } : {}),
      ...(body.documentId ? { documentId: id("documentId") } : {}),
    }));
    case "confirm-exceptions": {
      if (actor.role !== "admin") return json(403, { error: "Only an admin confirms a month's exception list" });
      return json(200, { month: await confirmExceptions(client, period, actor.id) });
    }
    case "close": return json(200, { month: await closeMonth(client, period, actor.id) });
    case "reopen": return json(200, { month: await reopenMonth(client, period, actor.id, String(body.reason || "")) });
    default: return json(404, { error: "Not found" });
  }
}
