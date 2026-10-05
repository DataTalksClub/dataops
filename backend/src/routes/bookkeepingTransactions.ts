import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { LambdaEvent, LambdaResponse } from "../types";
import {
  BookkeepingItemLockedError,
  deleteBookkeepingItem,
  getBookkeepingItem,
  listBookkeepingItems,
  putBookkeepingItem,
  updateBookkeepingTransaction,
} from "../db/bookkeeping";
import { json, MONEY, parse } from "./bookkeepingShared";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY = /^[A-Z]{3}$/;
const allowed = [
  "transactionDate",
  "paidDate",
  "counterparty",
  "description",
  "amount",
  "currency",
  "amountEur",
  "vatAmount",
  "vatCurrency",
  "statementRef",
  "quantity",
  "comment",
  "entryType",
  "subtype",
  "period",
  "category",
  "sourceType",
  "sourceKey",
];

function validateTransaction(input: Record<string, unknown>, partial = false) {
  const errors: string[] = [];
  if (
    (!partial || input.transactionDate !== undefined) &&
    !realDate(input.transactionDate)
  )
    errors.push("transactionDate");
  if (input.paidDate != null && !realDate(input.paidDate))
    errors.push("paidDate");
  for (const name of ["counterparty", "description"] as const)
    if (!partial && (typeof input[name] !== "string" || !input[name].trim()))
      errors.push(name);
  for (const name of [
    "counterparty",
    "description",
    "statementRef",
    "comment",
    "entryType",
    "subtype",
    "period",
    "category",
    "sourceType",
    "sourceKey",
  ])
    if (
      input[name] != null &&
      (typeof input[name] !== "string" ||
        String(input[name]).length > (name === "comment" ? 2000 : 300))
    )
      errors.push(name);
  if (
    (!partial || input.amount !== undefined) &&
    (typeof input.amount !== "string" || !MONEY.test(input.amount))
  )
    errors.push("amount");
  if (
    input.amountEur != null &&
    (typeof input.amountEur !== "string" || !MONEY.test(input.amountEur))
  )
    errors.push("amountEur");
  if (
    input.vatAmount != null &&
    (typeof input.vatAmount !== "string" || !MONEY.test(input.vatAmount))
  )
    errors.push("vatAmount");
  if (
    input.vatCurrency != null &&
    (typeof input.vatCurrency !== "string" || !CURRENCY.test(input.vatCurrency))
  )
    errors.push("vatCurrency");
  if (
    (!partial || input.currency !== undefined) &&
    (typeof input.currency !== "string" || !CURRENCY.test(input.currency))
  )
    errors.push("currency");
  if (
    input.quantity != null &&
    (!Number.isSafeInteger(input.quantity) || Number(input.quantity) < 0)
  )
    errors.push("quantity");
  return [...new Set(errors)];
}
function realDate(value: unknown) {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number),
    parsed = new Date(Date.UTC(y, m - 1, d));
  return (
    parsed.getUTCFullYear() === y &&
    parsed.getUTCMonth() === m - 1 &&
    parsed.getUTCDate() === d
  );
}
function safeData(input: Record<string, unknown>) {
  return Object.fromEntries(
    allowed.filter((k) => input[k] !== undefined).map((k) => [k, input[k]]),
  );
}

export async function handleBookkeepingTransactionRoutes(
  path: string,
  method: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse | null> {
  const match = path.match(/^\/api\/bookkeeping\/transactions(?:\/([^/]+))?$/);
  if (match) {
    if (method === "GET" && !match[1])
      return json(200, {
        items: await listBookkeepingItems(client, "bookkeeping"),
      });
    if (method === "GET" && match[1]) {
      const item = await getBookkeepingItem(client, "bookkeeping", match[1]);
      return item ? json(200, item) : json(404, { error: "Not found" });
    }
    if (method === "DELETE" && match[1]) {
      try {
        return (await deleteBookkeepingItem(client, "bookkeeping", match[1]))
          ? { statusCode: 204, headers: {}, body: "" }
          : json(404, { error: "Not found" });
      } catch (error) {
        if (error instanceof BookkeepingItemLockedError)
          return json(409, { error: "Transaction is locked or changed" });
        console.error(
          JSON.stringify({ message: "bookkeeping transaction delete failed", error: String(error) }),
        );
        return json(503, { error: "Transaction delete failed" });
      }
    }
    if ((method === "POST" && !match[1]) || (method === "PUT" && match[1])) {
      const body = parse(event.body || null);
      if (!body) return json(400, { error: "Invalid JSON" });
      const previous = match[1]
        ? await getBookkeepingItem(client, "bookkeeping", match[1])
        : null;
      if (match[1] && !previous) return json(404, { error: "Not found" });
      const value: Record<string, unknown> = {
        ...(previous || {}),
        ...safeData(body),
        ...(match[1] ? { id: match[1] } : {}),
      };
      const errors = validateTransaction(value);
      if (errors.length)
        return json(400, { error: "Validation failed", fields: errors });
      if (match[1]) {
        try {
          const updated = await updateBookkeepingTransaction(client, match[1], String(previous!.updatedAt), value);
          return json(200, updated);
        } catch (error) {
          if (error instanceof BookkeepingItemLockedError)
            return json(409, { error: "Transaction is locked or changed" });
          console.error(
            JSON.stringify({ message: "bookkeeping transaction update failed", error: String(error) }),
          );
          return json(503, { error: "Transaction update failed" });
        }
      }
      const result = await putBookkeepingItem(
        client, "bookkeeping", value,
        typeof value.sourceKey === "string" ? `source#${value.sourceKey}` : undefined,
      );
      return json(result.duplicate ? 200 : 201, result.item);
    }
  }
  return null;
}
