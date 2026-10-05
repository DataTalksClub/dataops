import { handleInvoiceRoutes } from "./invoices";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { LambdaEvent, LambdaResponse } from "../types";
import { json } from "./bookkeepingShared";
import { handleBookkeepingTransactionRoutes } from "./bookkeepingTransactions";
import { handleBookkeepingDocumentRoutes } from "./bookkeepingDocuments";
import { handleBookkeepingReportRoutes } from "./bookkeepingReports";
import { handleBookkeepingResourceRoutes } from "./bookkeepingResources";

export async function handleBookkeepingRoutes(
  path: string,
  method: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
  sessionAuthorized: boolean,
): Promise<LambdaResponse> {
  if (!sessionAuthorized) return json(401, { error: "Unauthorized" });
  if (path.startsWith("/api/bookkeeping/invoices")) return handleInvoiceRoutes(path, method, event, client, sessionAuthorized);
  return (
    (await handleBookkeepingTransactionRoutes(path, method, event, client)) ??
    (await handleBookkeepingDocumentRoutes(path, method, event, client)) ??
    (await handleBookkeepingReportRoutes(path, method, event, client)) ??
    (await handleBookkeepingResourceRoutes(path, method, event, client)) ??
    json(404, { error: "Not found" })
  );
}
