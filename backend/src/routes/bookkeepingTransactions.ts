import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createHash } from "crypto";
import type { LambdaEvent, LambdaResponse } from "../types";
import {
  BookkeepingTransactionLimitError,
  BookkeepingItemLockedError,
  bookkeepingItemId,
  documentLinkItem,
  evidenceSourceVersionKey,
  getBookkeepingItem,
  listBookkeepingItems,
  listTransactions,
  putBookkeepingTransactionWithItems,
  updateBookkeepingTransaction,
  type BookkeepingTransactItem,
} from "../db/bookkeeping";
import {
  BookkeepingAuditTooLargeError,
  MAX_BOOKKEEPING_AUDIT_ENTRIES,
} from "../bookkeepingAudit";
import { TABLE_BOOKKEEPING } from "../db/tableNames";
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
const MAX_AUDIT_REASON_BYTES = 2 * 1024;
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

function boundedAudit(entries: unknown[]): unknown[] {
  return entries.slice(-MAX_BOOKKEEPING_AUDIT_ENTRIES);
}

function auditStorageLimitResponse(error: unknown): LambdaResponse | null {
  if (!(error instanceof BookkeepingAuditTooLargeError || error instanceof BookkeepingTransactionLimitError)) {
    return null;
  }
  return json(413, { error: "Audit update exceeds storage limits; no changes were saved" });
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
  // Read versions before the consistent evidence scan. Any link change after
  // this snapshot invalidates the corresponding version at transaction time.
  const sourceVersions = await listBookkeepingItems(client, "evidence-source-version", true);
  const [documents, links, allTransactions, claims] = await Promise.all([
    listBookkeepingItems(client, "document", true),
    listBookkeepingItems(client, "link", true),
    listTransactions(client, true),
    listBookkeepingItems(client, "allocation-source-claim", true),
  ]);

  const documentsById = new Map<string, AllocationDocumentContext>();
  for (const doc of documents) {
    documentsById.set(String(doc.id), {
      id: String(doc.id),
      status: typeof doc.status === "string" ? doc.status : undefined,
      documentType: typeof doc.documentType === "string" ? doc.documentType : undefined,
      sha256: typeof doc.sha256 === "string" ? doc.sha256 : undefined,
      originalFilename:
        typeof doc.originalFilename === "string" ? doc.originalFilename : undefined,
      voidStatus: typeof doc.voidStatus === "string" ? doc.voidStatus : undefined,
      linkRefCount: typeof doc.linkRefCount === "number" ? doc.linkRefCount : undefined,
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

  for (const claim of claims) {
    const txId = String(claim.transactionId || "");
    if (!txId || txId === transactionId) continue;
    const sourceValue = String(claim.sourceValue || "");
    if (!sourceValue) continue;
    if (claim.sourceKind === "document" && !otherAllocatedDocIds.has(sourceValue)) {
      otherAllocatedDocIds.set(sourceValue, txId);
    } else if (claim.sourceKind === "invoice" && !otherAllocatedInvoiceIds.has(sourceValue)) {
      otherAllocatedInvoiceIds.set(sourceValue, txId);
    } else if (claim.sourceKind === "sha256" && !otherAllocatedSha256s.has(sourceValue)) {
      otherAllocatedSha256s.set(sourceValue, txId);
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
    claims,
    sourceVersions,
    otherAllocatedDocIds,
    otherAllocatedInvoiceIds,
    otherAllocatedSha256s,
    existingTxEvidenceDocs,
  };
}

type AllocationSourceKind = "document" | "invoice" | "sha256";

function allocationSourceClaim(
  transactionId: string,
  sourceKind: AllocationSourceKind,
  sourceValue: string,
  now: string,
) {
  const id = createHash("sha256").update(`${sourceKind}\0${sourceValue}`).digest("hex");
  const pk = `ALLOCATION-SOURCE-CLAIM#${id}`;
  return {
    id,
    PK: pk,
    SK: pk,
    transactionId,
    sourceKind,
    sourceValue,
    createdAt: now,
    updatedAt: now,
  };
}

function allocationClaimsFor(
  transactionId: string,
  allocations: ReturnType<typeof readTransactionAllocations>,
  documentsById: Map<string, AllocationDocumentContext>,
  now: string,
) {
  const claims = new Map<string, ReturnType<typeof allocationSourceClaim>>();
  for (const allocation of allocations) {
    const sources: Array<[AllocationSourceKind, string]> = [
      ["document", allocation.documentId],
      ...(allocation.invoiceId ? [["invoice", allocation.invoiceId] as [AllocationSourceKind, string]] : []),
    ];
    const sha256 = String(documentsById.get(allocation.documentId)?.sha256 || "").trim().toLowerCase();
    if (sha256) sources.push(["sha256", sha256]);
    for (const [sourceKind, sourceValue] of sources) {
      const claim = allocationSourceClaim(transactionId, sourceKind, sourceValue, now);
      claims.set(claim.id, claim);
    }
  }
  return claims;
}

function buildAllocationTransactItems(
  transactionId: string,
  allocations: ReturnType<typeof readTransactionAllocations>,
  context: Awaited<ReturnType<typeof loadAllocationValidationContext>>,
): BookkeepingTransactItem[] {
  const now = new Date().toISOString();
  const nextClaims = allocationClaimsFor(transactionId, allocations, context.documentsById, now);
  const items: BookkeepingTransactItem[] = [];
  const versions = new Map(context.sourceVersions.map((item) => [String(item.id), item.revision]));
  const checkedVersions = new Set<string>();
  for (const allocation of allocations) {
    const document = context.documentsById.get(allocation.documentId);
    const sha256 = String(document?.sha256 || "").trim().toLowerCase();
    const sources: Array<["document" | "sha256", string]> = [
      ["document", allocation.documentId],
      ...(sha256 ? [["sha256", sha256] as ["sha256", string]] : []),
    ];
    for (const [kind, value] of sources) {
      const source = evidenceSourceVersionKey(kind, value);
      if (checkedVersions.has(source.id)) continue;
      checkedVersions.add(source.id);
      const revision = versions.get(source.id);
      items.push({ ConditionCheck: {
        TableName: TABLE_BOOKKEEPING,
        Key: { PK: source.PK, SK: source.SK },
        ConditionExpression: revision === undefined ? "attribute_not_exists(PK)" : "revision = :revision",
        ...(revision === undefined ? {} : { ExpressionAttributeValues: { ":revision": revision } }),
      } });
    }
  }

  for (const claim of nextClaims.values()) {
    items.push({ Put: {
      TableName: TABLE_BOOKKEEPING,
      Item: claim,
      ConditionExpression: "attribute_not_exists(PK) OR transactionId = :transactionId",
      ExpressionAttributeValues: { ":transactionId": transactionId },
    } });
  }
  for (const claim of context.claims) {
    if (String(claim.transactionId || "") !== transactionId || nextClaims.has(String(claim.id))) continue;
    const pk = `ALLOCATION-SOURCE-CLAIM#${String(claim.id)}`;
    items.push({ Delete: {
      TableName: TABLE_BOOKKEEPING,
      Key: { PK: pk, SK: pk },
      ConditionExpression: "attribute_not_exists(PK) OR transactionId = :transactionId",
      ExpressionAttributeValues: { ":transactionId": transactionId },
    } });
  }

  const nextDocumentIds = new Set(allocations.map((allocation) => allocation.documentId));
  for (const link of context.links) {
    if (String(link.transactionId || "") !== transactionId
      || link.coverageType !== "evidence"
      || link.allocationManaged !== true
      || nextDocumentIds.has(String(link.documentId || ""))) continue;
    const documentId = String(link.documentId || "");
    const document = context.documentsById.get(documentId);
    if (!document) {
      throw new AllocationValidationError(
        `Cannot safely release allocation evidence link for missing document ${documentId}.`,
        409,
      );
    }
    const linkPk = `LINK#${String(link.id)}`;
    items.push({ Delete: {
      TableName: TABLE_BOOKKEEPING,
      Key: { PK: linkPk, SK: linkPk },
      ConditionExpression: "transactionId = :transactionId AND coverageType = :coverage AND allocationManaged = :managed",
      ExpressionAttributeValues: {
        ":transactionId": transactionId,
        ":coverage": "evidence",
        ":managed": true,
      },
    } });
    items.push({ Update: {
      TableName: TABLE_BOOKKEEPING,
      Key: { PK: `DOCUMENT#${documentId}`, SK: `DOCUMENT#${documentId}` },
      UpdateExpression: "SET updatedAt = :now ADD linkRefCount :minus",
      ConditionExpression: "linkRefCount > :zero",
      ExpressionAttributeValues: { ":now": now, ":minus": -1, ":zero": 0 },
    } });
  }

  for (const allocation of allocations) {
    const documentId = allocation.documentId;
    const document = context.documentsById.get(documentId);
    if (!document || document.status !== "active") {
      throw new AllocationValidationError(`Allocated document ${documentId} is not active.`, 409);
    }
    // A normal link changes this counter. Pin it to the validation snapshot
    // so a different parent's link cannot slip in after the preflight scan.
    const refCondition = document.linkRefCount === undefined
      ? "attribute_not_exists(linkRefCount)"
      : "linkRefCount = :expectedRefCount";
    const refValues = document.linkRefCount === undefined
      ? {}
      : { ":expectedRefCount": document.linkRefCount };
    const shaCondition = document.sha256 === undefined
      ? "attribute_not_exists(sha256)"
      : "sha256 = :expectedSha256";
    const shaValues = document.sha256 === undefined ? {} : { ":expectedSha256": document.sha256 };
    const existingEvidenceLink = context.links.find((link) =>
      String(link.transactionId || "") === transactionId
      && String(link.documentId || "") === documentId
      && link.coverageType === "evidence",
    );
    if (existingEvidenceLink) {
      // Existing operator-created evidence is reused. Pin the exact link,
      // source status, and sponsor ownership for the same atomic parent-CAS
      // operation so a concurrent unlink cannot leave an unlinked allocation.
      const existingLinkPk = `LINK#${String(existingEvidenceLink.id)}`;
      items.push({ ConditionCheck: {
        TableName: TABLE_BOOKKEEPING,
        Key: { PK: existingLinkPk, SK: existingLinkPk },
        ConditionExpression: "documentId = :documentId AND transactionId = :transactionId AND coverageType = :coverage",
        ExpressionAttributeValues: {
          ":documentId": documentId,
          ":transactionId": transactionId,
          ":coverage": "evidence",
        },
      } });
      items.push({ ConditionCheck: {
        TableName: TABLE_BOOKKEEPING,
        Key: { PK: `DOCUMENT#${documentId}`, SK: `DOCUMENT#${documentId}` },
        ConditionExpression: `#status = :active AND ${refCondition} AND ${shaCondition}`,
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":active": "active", ...refValues, ...shaValues },
      } });
      const sponsorClaim = `SPONSOR_FINANCE_CLAIM#document#${documentId}`;
      items.push({ ConditionCheck: {
        TableName: TABLE_BOOKKEEPING,
        Key: { PK: sponsorClaim, SK: sponsorClaim },
        ConditionExpression: "attribute_not_exists(PK)",
      } });
      continue;
    }

    const link = documentLinkItem({
      documentId,
      transactionId,
      coverageType: "evidence",
      allocationManaged: true,
    }, now);
    items.push({ Put: {
      TableName: TABLE_BOOKKEEPING,
      Item: link,
      ConditionExpression: "attribute_not_exists(PK)",
    } });
    items.push({ Update: {
      TableName: TABLE_BOOKKEEPING,
      Key: { PK: `DOCUMENT#${documentId}`, SK: `DOCUMENT#${documentId}` },
      UpdateExpression: "SET updatedAt = :now ADD linkRefCount :one",
      ConditionExpression: `#status = :active AND ${refCondition} AND ${shaCondition}`,
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":one": 1, ":active": "active", ":now": now, ...refValues, ...shaValues },
    } });
  }

  const updatedDocumentIds = new Set(items.flatMap((item) =>
    item.Update && String(item.Update.Key?.PK || "").startsWith("DOCUMENT#")
      ? [String(item.Update.Key?.PK).slice("DOCUMENT#".length)]
      : [],
  ));
  const retainedDocumentIds = new Set(allocations
    .map((allocation) => allocation.documentId)
    .filter((documentId) => !updatedDocumentIds.has(documentId)));
  for (const documentId of retainedDocumentIds) {
    const activeCheckAlreadyPresent = items.some((item) => item.ConditionCheck
      && String(item.ConditionCheck.Key?.PK || "") === `DOCUMENT#${documentId}`);
    if (!activeCheckAlreadyPresent) {
      items.push({ ConditionCheck: {
        TableName: TABLE_BOOKKEEPING,
        Key: { PK: `DOCUMENT#${documentId}`, SK: `DOCUMENT#${documentId}` },
        ConditionExpression: "#status = :active",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":active": "active" },
      } });
      const sponsorClaim = `SPONSOR_FINANCE_CLAIM#document#${documentId}`;
      items.push({ ConditionCheck: {
        TableName: TABLE_BOOKKEEPING,
        Key: { PK: sponsorClaim, SK: sponsorClaim },
        ConditionExpression: "attribute_not_exists(PK)",
      } });
    }
  }

  const mutatedDocumentIds = new Set(items.flatMap((item) => {
    const mutation = item.Update || item.Delete;
    const pk = String(mutation?.Key?.PK || "");
    return pk.startsWith("DOCUMENT#") ? [pk.slice("DOCUMENT#".length)] : [];
  }));
  const sponsorGuards = mutatedDocumentIds.size + 1; // documents plus the parent transaction CAS
  if (items.length + sponsorGuards > 100) {
    throw new AllocationValidationError(
      "This allocation change is too large for one atomic save. Reduce the invoice rows and retry.",
    );
  }
  return items;
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
      if (
        body.reason != null &&
        (typeof body.reason !== "string" ||
          Buffer.byteLength(body.reason, "utf8") > MAX_AUDIT_REASON_BYTES)
      ) {
        return json(400, { error: "Invalid audit reason", fields: ["reason"] });
      }
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
          const ctx = await loadAllocationValidationContext(client, transactionId);
          const relatedItems = buildAllocationTransactItems(transactionId, [], ctx);
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
          const audit = boundedAudit([
            ...(Array.isArray(previous.audit) ? previous.audit : []),
            auditEntry,
          ]);
          const updated = await updateBookkeepingTransaction(
            client,
            transactionId,
            String(previous.updatedAt),
            {
              ...previous,
              allocations: undefined,
              audit,
            },
            "active",
            undefined,
            relatedItems,
          );
          return json(200, bookkeepingTransactionView(updated!));
        } catch (error) {
          const sizeError = auditStorageLimitResponse(error);
          if (sizeError) return sizeError;
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
        const relatedItems = buildAllocationTransactItems(transactionId, normalizedAllocations, ctx);

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
        const audit = boundedAudit([
          ...(Array.isArray(previous.audit) ? previous.audit : []),
          auditEntry,
        ]);
        const updated = await updateBookkeepingTransaction(
          client,
          transactionId,
          String(previous.updatedAt),
          {
            ...previous,
            allocations: normalizedAllocations,
            audit,
            },
            "active",
            undefined,
            relatedItems,
        );
        return json(200, bookkeepingTransactionView(updated!));
      } catch (error) {
        const sizeError = auditStorageLimitResponse(error);
        if (sizeError) return sizeError;
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
      let allocationWriteItems: BookkeepingTransactItem[] = [];
      try {
        const clearAllocations =
          body.allocations === null ||
          body.clearAllocations === true ||
          (Array.isArray(body.allocations) && body.allocations.length === 0);
        if (clearAllocations) {
          if (previous) {
            const ctx = await loadAllocationValidationContext(client, String(previous.id));
            allocationWriteItems = buildAllocationTransactItems(String(previous.id), [], ctx);
          }
          if (previous?.allocations !== undefined) {
            value.allocations = undefined;
            allocationsChanged = true;
          }
        } else if (body.allocations !== undefined) {
          const unique = typeof value.sourceKey === "string" ? `source#${value.sourceKey}` : undefined;
          if (!match[1]) value.id = bookkeepingItemId(unique);
          const txIdForAlloc = match[1] || String(value.id);
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
          allocationWriteItems = buildAllocationTransactItems(
            txIdForAlloc,
            normalizedAllocations,
            ctx,
          );
        } else if (
          match[1] &&
          Array.isArray(previous?.allocations) &&
          previous.allocations.length > 0 &&
          (body.amount !== undefined ||
            body.currency !== undefined ||
            body.amountEur !== undefined)
        ) {
          const ctx = await loadAllocationValidationContext(client, match[1]);
          const normalizedAllocations = validateAndNormalizeAllocations({
            transaction: value,
            rawAllocations: previous.allocations,
            documentsById: ctx.documentsById,
            otherAllocatedDocIds: ctx.otherAllocatedDocIds,
            otherAllocatedInvoiceIds: ctx.otherAllocatedInvoiceIds,
            otherAllocatedSha256s: ctx.otherAllocatedSha256s,
          });
          value.allocations = normalizedAllocations;
          allocationsChanged = JSON.stringify(previous.allocations) !== JSON.stringify(normalizedAllocations);
          allocationWriteItems = buildAllocationTransactItems(match[1], normalizedAllocations, ctx);
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
          const audit = boundedAudit([...(Array.isArray(previous!.audit) ? previous!.audit : []), {
            action: "updated",
            actor: headerValue(event.headers, "x-user-id") || "authenticated-operator",
            at: new Date().toISOString(),
            changes: Object.fromEntries(changedFields.map((field) => [field, {
              from: previous![field] ?? null,
              to: value[field] ?? null,
            }])),
          }]);
          value.audit = audit;
          const updated = await updateBookkeepingTransaction(
            client,
            match[1],
            String(previous!.updatedAt),
            value,
            "active",
            undefined,
            allocationWriteItems,
          );
          if (["transactionDate", "paidDate", "counterparty", "amount", "amountEur", "currency"].some((field) => body[field] !== undefined)) {
            await autoAttachConfidentEvidence(client);
          }
          return json(200, bookkeepingTransactionView(updated!));
        } catch (error) {
          const sizeError = auditStorageLimitResponse(error);
          if (sizeError) return sizeError;
          if (error instanceof BookkeepingItemLockedError)
            return json(409, { error: "Transaction is locked or changed" });
          console.error(
            JSON.stringify({ message: "bookkeeping transaction update failed", error: String(error) }),
          );
          return json(503, { error: "Transaction update failed" });
        }
      }
      try {
        const unique = typeof value.sourceKey === "string" ? `source#${value.sourceKey}` : undefined;
        const created = await putBookkeepingTransactionWithItems(
          client,
          value,
          allocationWriteItems,
          unique,
        );
        await autoAttachConfidentEvidence(client);
        return json(created.duplicate ? 200 : 201, bookkeepingTransactionView(created.item));
      } catch (error) {
        if (error instanceof BookkeepingItemLockedError)
          return json(409, { error: "Transaction source or allocation is already claimed" });
        throw error;
      }
    }
  }
  return null;
}
