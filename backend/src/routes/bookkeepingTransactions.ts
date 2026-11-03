import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { LambdaEvent, LambdaResponse } from "../types";
import {
  BookkeepingItemLockedError,
  getBookkeepingItem,
  listTransactions,
  putBookkeepingItem,
  updateBookkeepingTransaction,
} from "../db/bookkeeping";
import { json, MONEY, MONTH, parse } from "./bookkeepingShared";
import { autoAttachConfidentEvidence } from "./bookkeepingSuggestions";
import { headerValue } from "../httpHeaders";
import { canonicalBookkeepingCounterparty, bookkeepingTransactionView } from "../bookkeepingVendors";
import { realDate } from "../sponsorCrm/model";

const CURRENCY = /^[A-Z]{3}$/;
const allowed = [
  "transactionDate",
  "paidDate",
  "counterparty",
  "description",
  "amount",
  "currency",
  "amountEur",
  "rateSource",
  "vatAmount",
  "vatCurrency",
  "statementRef",
  "quantity",
  "comment",
  "entryType",
  "subtype",
  "period",
  "incomePeriod",
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
    "incomePeriod",
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
    input.rateSource != null &&
    (typeof input.rateSource !== "string" || !input.rateSource.trim() || input.rateSource.length > 300)
  )
    errors.push("rateSource");
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
  if (input.incomePeriod != null && (typeof input.incomePeriod !== "string" || !MONTH.test(input.incomePeriod)))
    errors.push("incomePeriod");
  if (input.sourceType === "platform-payout") {
    if (input.entryType !== "income") errors.push("entryType");
    if (typeof input.sourceKey !== "string" || !input.sourceKey.startsWith("platform-payout:") || input.sourceKey.length > 300)
      errors.push("sourceKey");
    if (typeof input.statementRef !== "string" || !input.statementRef.trim()) errors.push("statementRef");
    if (typeof input.incomePeriod !== "string" || !MONTH.test(input.incomePeriod)) errors.push("incomePeriod");
    if (typeof input.amount !== "string" || Number(input.amount) <= 0) errors.push("amount");
  }
  if (input.sourceType === "credit-note") {
    if (input.entryType !== "expense") errors.push("entryType");
    if (typeof input.sourceKey !== "string" || !/^credit-note:.+/.test(input.sourceKey) || input.sourceKey.length > 300)
      errors.push("sourceKey");
    if (typeof input.statementRef !== "string" || !input.statementRef.trim()) errors.push("statementRef");
    if (input.subtype !== "Refund") errors.push("subtype");
    if (typeof input.amount !== "string" || Number(input.amount) <= 0) errors.push("amount");
  }
  return [...new Set(errors)];
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
        items: (await listTransactions(client)).map(bookkeepingTransactionView),
      });
    if (method === "GET" && match[1]) {
      const item = await getBookkeepingItem(client, "bookkeeping", match[1]);
      return item ? json(200, bookkeepingTransactionView(item)) : json(404, { error: "Not found" });
    }
    if (method === "DELETE" && match[1]) {
      return json(405, { error: "Ledger rows are retained. Use the reconciliation void-ledger action with a period, reason, duplicate row, and confirmation." });
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
      value.counterpartyCanonical = canonicalBookkeepingCounterparty(value.counterparty);
      if (!match[1] && (value.sourceType === "platform-payout" || value.sourceType === "credit-note"))
        value.addedAt = new Date().toISOString().slice(0, 10);
      const errors = validateTransaction(value);
      if (errors.length)
        return json(400, { error: "Validation failed", fields: errors });
      if (match[1]) {
        try {
          const changedFields = Object.keys(safeData(body));
          value.audit = [...(Array.isArray(previous!.audit) ? previous!.audit : []), {
            action: "updated",
            actor: headerValue(event.headers, "x-user-id") || "authenticated-operator",
            at: new Date().toISOString(),
            changes: Object.fromEntries(changedFields.map((field) => [field, {
              from: previous![field] ?? null,
              to: value[field] ?? null,
            }])),
          }].slice(-100);
          const updated = await updateBookkeepingTransaction(client, match[1], String(previous!.updatedAt), value);
          if (["transactionDate", "paidDate", "counterparty", "amount", "amountEur", "currency"].some((field) => body[field] !== undefined)) {
            await autoAttachConfidentEvidence(client);
          }
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
      await autoAttachConfidentEvidence(client);
      return json(result.duplicate ? 200 : 201, result.item);
    }
  }
  return null;
}
