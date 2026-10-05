import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { LambdaEvent, LambdaResponse } from "../types";
import {
  createDocumentLink,
  deleteBookkeepingItem,
  deleteDeletingReport,
  deleteDocumentLink,
  getBookkeepingItem,
  listBookkeepingItems,
  markReportDeleting,
  putBookkeepingItem,
  removeDocumentReportReference,
} from "../db/bookkeeping";
import { json, MONTH, parse, publicDocument, publicLink } from "./bookkeepingShared";

export async function handleBookkeepingResourceRoutes(
  path: string,
  method: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse | null> {
  if (path === "/api/bookkeeping/accounts/setup" && method === "POST") {
    const names = [
      process.env.BOOKKEEPING_BUSINESS_ACCOUNT_1 || "Primary business account",
      process.env.BOOKKEEPING_BUSINESS_ACCOUNT_2 || "Secondary business account",
    ];
    const accounts = [];
    for (const [index, displayName] of names.entries()) {
      accounts.push((await putBookkeepingItem(client, "account", {
        id: `business-${index + 1}`,
        displayName,
        kind: "business",
        active: true,
      }, `business-account#${index + 1}`)).item);
    }
    return json(200, { accounts });
  }
  // Account/link/report metadata use the same private table and authenticated boundary.
  const resource = path.match(
    /^\/api\/bookkeeping\/(accounts|documents|links|reports)(?:\/([^/]+))?$/,
  );
  if (resource) {
    const kind = resource[1].slice(0, -1),
      id = resource[2];
    if (method === "GET" && !id) {
      const items = await listBookkeepingItems(client, kind);
      return json(200, {
        items: items.map((item) =>
          kind === "document"
            ? publicDocument(item)
            : kind === "link"
              ? publicLink(item)
              : item,
        ),
      });
    }
    if (method === "POST" && !id) {
      if (kind === "document" || kind === "report") {
        return json(405, {
          error: "Use the validated upload or report snapshot endpoint",
        });
      }
      const body = parse(event.body || null);
      if (!body) return json(400, { error: "Invalid JSON" });
      if (
        kind === "account" &&
        (!["business", "private"].includes(String(body.kind)) ||
          typeof body.displayName !== "string")
      )
        return json(400, { error: "Invalid account" });
      if (kind === "link") {
        if (
          !["evidence", "statement-coverage", "report-source"].includes(
            String(body.coverageType),
          )
        )
          return json(400, { error: "Invalid coverage type" });
        const targetDocument = await getBookkeepingItem(
          client,
          "document",
          String(body.documentId),
        );
        if (
          targetDocument?.status !== "active" ||
          !(await getBookkeepingItem(client, "bookkeeping", String(body.transactionId)))
        )
          return json(404, { error: "Link target not found" });
        const result = await createDocumentLink(client, {
          documentId: String(body.documentId),
          transactionId: String(body.transactionId),
          coverageType: String(body.coverageType),
        });
        const safeLink = publicLink(result.item);
        return json(result.outcome === "created" ? 201 : 200, {
          ...safeLink,
          outcome: result.outcome,
          link: safeLink,
        });
      }
      if (kind === "report" && !MONTH.test(String(body.month || "")))
        return json(400, { error: "Invalid month" });
      return json(
        201,
        (
          await putBookkeepingItem(
            client,
            kind,
            body,
            kind === "link"
              ? `link#${body.documentId}#${body.transactionId}#${body.coverageType}`
              : undefined,
          )
        ).item,
      );
    }
    if (method === "DELETE" && id) {
      if (kind === "document")
        return json(405, { error: "Bookkeeping documents cannot be deleted through this API" });
      if (kind === "link") {
        const link = await getBookkeepingItem(client, "link", id);
        if (!link) return json(404, { error: "Not found" });
        await deleteDocumentLink(client, link);
        return { statusCode: 204, headers: {}, body: "" };
      }
      if (kind === "report") {
        const report = await getBookkeepingItem(client, "report", id);
        if (!report) return json(404, { error: "Not found" });
        await markReportDeleting(client, id);
        let cleanupFailed = false;
        for (const documentId of Array.isArray(report.documentIds)
          ? report.documentIds.map(String)
          : [])
          await removeDocumentReportReference(client, documentId, id).catch(
            (error) => {
              if ((error as Error).name !== "TransactionCanceledException")
                cleanupFailed = true;
            },
          );
        if (cleanupFailed)
          return json(503, { error: "Report cleanup incomplete" });
        await deleteDeletingReport(client, id);
        return { statusCode: 204, headers: {}, body: "" };
      }
      return (await deleteBookkeepingItem(client, kind, id))
        ? { statusCode: 204, headers: {}, body: "" }
        : json(404, { error: "Not found" });
    }
  }
  return null;
}
