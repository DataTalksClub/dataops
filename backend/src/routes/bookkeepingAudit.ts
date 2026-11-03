import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { LambdaEvent, LambdaResponse } from "../types";
import { getBookkeepingAuditPage } from "../db/bookkeeping";
import { json } from "./bookkeepingShared";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

export async function handleBookkeepingAuditRoutes(
  path: string,
  method: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse | null> {
  const match = path.match(/^\/api\/bookkeeping\/transactions\/([^/]+)\/audit$/);
  if (!match) return null;
  if (method !== "GET") return json(405, { error: "Method not allowed" });

  const rawLimit = event.queryStringParameters?.limit;
  const limit = rawLimit === undefined ? DEFAULT_PAGE_SIZE : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    return json(400, { error: `limit must be an integer from 1 to ${MAX_PAGE_SIZE}` });
  }

  const rawCursor = event.queryStringParameters?.cursor;
  const cursor = rawCursor === undefined ? 0 : Number(rawCursor);
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    return json(400, { error: "cursor must be a non-negative audit sequence" });
  }

  const transactionId = decodeURIComponent(match[1]);
  const page = await getBookkeepingAuditPage(client, transactionId, cursor, limit);
  if (!page) return json(404, { error: "Not found" });
  return json(200, { transactionId, ...page });
}
