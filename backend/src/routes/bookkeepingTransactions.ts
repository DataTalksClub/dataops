import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { LambdaEvent, LambdaResponse } from "../types";
import {
  BookkeepingItemLockedError,
  createDocumentLink,
  documentLinkItem,
  getBookkeepingItem,
  listBookkeepingItems,
  listTransactions,
  putBookkeepingItem,
  updateBookkeepingTransaction,
} from "../db/bookkeeping";
import { json, MONEY, MONTH, parse } from "./bookkeepingShared";
import { autoAttachConfidentEvidence } from "./bookkeepingSuggestions";
import { headerValue } from "../httpHeaders";
import { canonicalBookkeepingCounterparty, bookkeepingTransactionView } from "../bookkeepingVendors";
import { realDate } from "../sponsorCrm/model";
import {
  AllocationValidationError,
  readTransactionAllocations,
  validateAndNormalizeAllocations,
  type AllocationDocumentContext,
} from "../bookkeepingAllocations";

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

function extractExpectedUpdatedAt(
  event: LambdaEvent,
  body?: Record<string, unknown> | null,
): string | undefined {
  const fromBody =
    typeof body?.expectedUpdatedAt === "string" && body.expectedUpdatedAt.trim()
      ? body.expectedUpdatedAt.trim()
      : undefined;
  if (fromBody) return fromBody;
  const fromQuery =
    typeof event.queryStringParameters?.expectedUpdatedAt === "string" &&
    event.queryStringParameters.expectedUpdatedAt.trim()
      ? event.queryStringParameters.expectedUpdatedAt.trim()
      : undefined;
  if (fromQuery) return fromQuery;
  const ifMatch = headerValue(event.headers, "if-match");
  if (ifMatch && ifMatch.trim()) {
    return ifMatch.trim().replace(/^W\//i, "").replace(/^"(.*)"$/, "$1");
  }
  return undefined;
}

async function loadAllocationValidationContext(
  client: DynamoDBDocumentClient,
  transactionId: string,
) {
  const [documents, links, allTransactions] = await Promise.all([
    listBookkeepingItems(client, "document"),
    listBookkeepingItems(client, "link"),
    listTransactions(client),
  ]);

  const documentsById = new Map<string, AllocationDocumentContext>();
  for (const doc of documents) {
    documentsById.set(String(doc.id), {
      id: String(doc.id),
      documentType: typeof doc.documentType === "string" ? doc.documentType : undefined,
      sha256: typeof doc.sha256 === "string" ? doc.sha256 : undefined,
      originalFilename:
        typeof doc.originalFilename === "string" ? doc.originalFilename : undefined,
      voidStatus: typeof doc.voidStatus === "string" ? doc.voidStatus : undefined,
      facts:
        doc.facts && typeof doc.facts === "object"
          ? (doc.facts as Record<string, unknown>)
          : undefined,
    });
  }

  const activeTxIds = new Set(allTransactions.map((tx) => String(tx.id)));
  const otherAllocatedDocIds = new Map<string, string>();
  const otherAllocatedInvoiceIds = new Map<string, string>();
  const otherAllocatedSha256s = new Map<string, string>();

  for (const tx of allTransactions) {
    const txId = String(tx.id);
    if (txId === transactionId) continue;
    for (const alloc of readTransactionAllocations(tx)) {
      if (alloc.documentId && !otherAllocatedDocIds.has(alloc.documentId)) {
        otherAllocatedDocIds.set(alloc.documentId, txId);
      }
      if (alloc.invoiceId && !otherAllocatedInvoiceIds.has(alloc.invoiceId)) {
        otherAllocatedInvoiceIds.set(alloc.invoiceId, txId);
      }
      const doc = documentsById.get(alloc.documentId);
      if (doc?.sha256 && !otherAllocatedSha256s.has(doc.sha256)) {
        otherAllocatedSha256s.set(doc.sha256, txId);
      }
    }
  }

  for (const link of links) {
    if (String(link.coverageType || "") !== "evidence") continue;
    const txId = String(link.transactionId || "");
    const docId = String(link.documentId || "");
    if (!txId || !docId || txId === transactionId || !activeTxIds.has(txId)) continue;
    if (!otherAllocatedDocIds.has(docId)) {
      otherAllocatedDocIds.set(docId, txId);
    }
    const doc = documentsById.get(docId);
    if (doc?.sha256 && !otherAllocatedSha256s.has(doc.sha256)) {
      otherAllocatedSha256s.set(doc.sha256, txId);
    }
  }

  const existingTxEvidenceDocs = new Set(
    links
      .filter(
        (link) =>
          String(link.transactionId || "") === transactionId &&
          String(link.coverageType || "") === "evidence",
      )
      .map((link) => String(link.documentId || "")),
  );

  return {
    documents,
    links,
    documentsById,
    otherAllocatedDocIds,
    otherAllocatedInvoiceIds,
    otherAllocatedSha256s,
    existingTxEvidenceDocs,
  };
}

async function ensureAllocatedEvidenceLinks(
  client: DynamoDBDocumentClient,
  transactionId: string,
  documentIds: string[],
  existingTxEvidenceDocs: Set<string>,
) {
  for (const documentId of documentIds) {
    if (existingTxEvidenceDocs.has(documentId)) continue;
    try {
      await createDocumentLink(client, {
        documentId,
        transactionId,
        coverageType: "evidence",
      });
    } catch {
      const linkItem = documentLinkItem({
        documentId,
        transactionId,
        coverageType: "evidence",
      });
      await putBookkeepingItem(
        client,
        "link",
        linkItem,
        `link#${documentId}#${transactionId}#evidence`,
      );
    }
    existingTxEvidenceDocs.add(documentId);
  }
}

export async function handleBookkeepingTransactionRoutes(
  path: string,
  method: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse | null> {
  const allocMatch = path.match(/^\/api\/bookkeeping\/transactions\/([^/]+)\/allocations$/);
  if (allocMatch) {
    const transactionId = decodeURIComponent(allocMatch[1]);
    const previous = await getBookkeepingItem(client, "bookkeeping", transactionId);
    if (!previous) return json(404, { error: "Transaction not found" });
    if (previous.voidStatus === "voided") {
      return json(409, { error: "Cannot allocate a voided transaction" });
    }

    if (method === "GET") {
      const links = (await listBookkeepingItems(client, "link")).filter(
        (link) => String(link.transactionId) === transactionId,
      );
      const allocations = readTransactionAllocations(previous);
      return json(200, {
        transactionId,
        amount: previous.amount,
        currency: previous.currency,
        updatedAt: previous.updatedAt,
        allocations,
        links,
      });
    }

    if (method === "PUT" || method === "POST" || method === "DELETE") {
      const body =
        method === "DELETE" && !event.body ? {} : parse(event.body || null);
      if (!body) return json(400, { error: "Invalid JSON" });

      const expectedUpdatedAt = extractExpectedUpdatedAt(event, body);
      if (
        expectedUpdatedAt &&
        String(previous.updatedAt || "") !== expectedUpdatedAt
      ) {
        return json(409, {
          error:
            "Transaction was modified by another process (CAS conflict); refresh and retry.",
          expectedUpdatedAt,
          actualUpdatedAt: previous.updatedAt,
        });
      }

      const actor =
        headerValue(event.headers, "x-user-id") || "authenticated-operator";
      const reason =
        typeof body.reason === "string" && body.reason.trim()
          ? body.reason.trim()
          : undefined;

      const isClearRequest =
        method === "DELETE" ||
        body.clear === true ||
        (Array.isArray(body.allocations) &&
          body.allocations.length === 0 &&
          Array.isArray(previous.allocations) &&
          previous.allocations.length > 0);

      if (isClearRequest) {
        try {
          const auditEntry = {
            action: "allocations-cleared",
            actor,
            at: new Date().toISOString(),
            ...(reason ? { reason } : {}),
            changes: {
              allocations: {
                from: previous.allocations ?? null,
                to: null,
              },
            },
          };
          const updated = await updateBookkeepingTransaction(
            client,
            transactionId,
            String(previous.updatedAt),
            {
              ...previous,
              allocations: undefined,
              audit: [
                ...(Array.isArray(previous.audit) ? previous.audit : []),
                auditEntry,
              ].slice(-100),
            },
          );
          return json(200, bookkeepingTransactionView(updated!));
        } catch (error) {
          if (error instanceof BookkeepingItemLockedError) {
            return json(409, { error: "Transaction is locked or changed" });
          }
          throw error;
        }
      }

      try {
        const ctx = await loadAllocationValidationContext(client, transactionId);
        const normalizedAllocations = validateAndNormalizeAllocations({
          transaction: previous,
          rawAllocations: body.allocations,
          documentsById: ctx.documentsById,
          otherAllocatedDocIds: ctx.otherAllocatedDocIds,
          otherAllocatedInvoiceIds: ctx.otherAllocatedInvoiceIds,
          otherAllocatedSha256s: ctx.otherAllocatedSha256s,
        });

        await ensureAllocatedEvidenceLinks(
          client,
          transactionId,
          normalizedAllocations.map((alloc) => alloc.documentId),
          ctx.existingTxEvidenceDocs,
        );

        const auditEntry = {
          action: "allocations-updated",
          actor,
          at: new Date().toISOString(),
          ...(reason ? { reason } : {}),
          changes: {
            allocations: {
              from: previous.allocations ?? null,
              to: normalizedAllocations,
            },
          },
        };
        const updated = await updateBookkeepingTransaction(
          client,
          transactionId,
          String(previous.updatedAt),
          {
            ...previous,
            allocations: normalizedAllocations,
            audit: [
              ...(Array.isArray(previous.audit) ? previous.audit : []),
              auditEntry,
            ].slice(-100),
          },
        );
        return json(200, bookkeepingTransactionView(updated!));
      } catch (error) {
        if (error instanceof AllocationValidationError) {
          return json(error.status, { error: error.message });
        }
        if (error instanceof BookkeepingItemLockedError) {
          return json(409, { error: "Transaction is locked or changed" });
        }
        console.error(
          JSON.stringify({
            message: "bookkeeping transaction allocation update failed",
            error: String(error),
          }),
        );
        return json(503, { error: "Transaction allocation update failed" });
      }
    }
    return json(405, { error: "Method not allowed" });
  }

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
      if (match[1] && previous) {
        const expectedUpdatedAt = extractExpectedUpdatedAt(event, body);
        if (
          expectedUpdatedAt &&
          String(previous.updatedAt || "") !== expectedUpdatedAt
        ) {
          return json(409, {
            error:
              "Transaction was modified by another process (CAS conflict); refresh and retry.",
            expectedUpdatedAt,
            actualUpdatedAt: previous.updatedAt,
          });
        }
      }
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

      let allocationsChanged = false;
      try {
        if (
          body.allocations === null ||
          body.clearAllocations === true ||
          (Array.isArray(body.allocations) && body.allocations.length === 0)
        ) {
          if (previous?.allocations !== undefined) {
            value.allocations = undefined;
            allocationsChanged = true;
          }
        } else if (body.allocations !== undefined) {
          const txIdForAlloc = match[1] || String(value.id || "");
          const ctx = await loadAllocationValidationContext(client, txIdForAlloc);
          const normalizedAllocations = validateAndNormalizeAllocations({
            transaction: value,
            rawAllocations: body.allocations,
            documentsById: ctx.documentsById,
            otherAllocatedDocIds: ctx.otherAllocatedDocIds,
            otherAllocatedInvoiceIds: ctx.otherAllocatedInvoiceIds,
            otherAllocatedSha256s: ctx.otherAllocatedSha256s,
          });
          value.allocations = normalizedAllocations;
          allocationsChanged = true;
          if (match[1]) {
            await ensureAllocatedEvidenceLinks(
              client,
              match[1],
              normalizedAllocations.map((alloc) => alloc.documentId),
              ctx.existingTxEvidenceDocs,
            );
          }
        } else if (
          match[1] &&
          Array.isArray(previous?.allocations) &&
          previous.allocations.length > 0 &&
          (body.amount !== undefined ||
            body.currency !== undefined ||
            body.amountEur !== undefined)
        ) {
          const ctx = await loadAllocationValidationContext(client, match[1]);
          value.allocations = validateAndNormalizeAllocations({
            transaction: value,
            rawAllocations: previous.allocations,
            documentsById: ctx.documentsById,
            otherAllocatedDocIds: ctx.otherAllocatedDocIds,
            otherAllocatedInvoiceIds: ctx.otherAllocatedInvoiceIds,
            otherAllocatedSha256s: ctx.otherAllocatedSha256s,
          });
        }
      } catch (error) {
        if (error instanceof AllocationValidationError) {
          return json(error.status, { error: error.message });
        }
        throw error;
      }

      if (match[1]) {
        try {
          const changedFields = [
            ...Object.keys(safeData(body)),
            ...(allocationsChanged ? ["allocations"] : []),
          ];
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
      if (Array.isArray(value.allocations) && value.allocations.length > 0) {
        const ctx = await loadAllocationValidationContext(client, result.item.id);
        await ensureAllocatedEvidenceLinks(
          client,
          result.item.id,
          (value.allocations as Array<{ documentId: string }>).map(
            (alloc) => alloc.documentId,
          ),
          ctx.existingTxEvidenceDocs,
        );
      }
      await autoAttachConfidentEvidence(client);
      return json(result.duplicate ? 200 : 201, result.item);
    }
  }
  return null;
}
