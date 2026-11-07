import { randomUUID } from "crypto";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { LambdaEvent, LambdaResponse } from "../types";
import {
  BookkeepingItemLockedError,
  deleteBookkeepingItem,
  getBookkeepingItem,
  listBookkeepingItems,
  listTransactions,
  putBookkeepingItem,
  updateBookkeepingItem,
} from "../db/bookkeeping";
import { json, parse } from "./bookkeepingShared";
import { realDate } from "../sponsorCrm/model";
import {
  DEFAULT_INVENTORY_FROM_YEAR,
  INVENTORY_DISPOSAL_KINDS,
  INVENTORY_TYPES,
  deriveInventoryDisposalState,
  deriveInventoryItems,
  inventoryItemId,
  inventoryItemSeed,
  inventorySourceRecord,
  isValidMoney,
  type InventoryDisposal,
  type InventoryDisposalKind,
  type InventoryType,
} from "../finance/inventory";

function publicInventoryItem(item: Record<string, unknown>) {
  const { PK: _pk, SK: _sk, ...safe } = item;
  return safe;
}

/** DynamoDB rejects undefined attribute values; drop them before the put. */
function stripUndefined(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).filter(([, child]) => child !== undefined),
  );
}

function validateInventoryEdit(input: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (input.name !== undefined && (typeof input.name !== "string" || !input.name.trim() || input.name.length > 300))
    errors.push("name");
  if (input.type !== undefined && !INVENTORY_TYPES.includes(String(input.type) as InventoryType))
    errors.push("type");
  // Status and disposedDate follow the disposal records; editing them
  // directly is rejected so clients cannot fight the derivation.
  if (input.status !== undefined) errors.push("status");
  if (input.disposedDate !== undefined) errors.push("disposedDate");
  if (input.notes !== undefined && input.notes !== null && (typeof input.notes !== "string" || input.notes.length > 2000))
    errors.push("notes");
  return errors;
}

/**
 * Validate a disposal record (sell / decommission) or the removal of one.
 * Status and disposedDate are derived from the records themselves, so they
 * are not writable fields.
 */
function validateDisposalChange(input: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const disposal = input.disposal as Record<string, unknown> | undefined;
  if (disposal !== undefined) {
    if (!disposal || typeof disposal !== "object" || Array.isArray(disposal))
      errors.push("disposal");
    else {
      if (!INVENTORY_DISPOSAL_KINDS.includes(String(disposal.kind) as InventoryDisposalKind))
        errors.push("disposal.kind");
      if (!realDate(disposal.date)) errors.push("disposal.date");
      const sold = disposal.kind === "sold";
      if (disposal.proceeds === undefined) {
        if (sold) errors.push("disposal.proceeds");
      } else if (!isValidMoney(disposal.proceeds)) errors.push("disposal.proceeds");
      if (disposal.currency !== undefined && disposal.currency !== null
        && (typeof disposal.currency !== "string" || !/^[A-Za-z]{3}$/.test(disposal.currency)))
        errors.push("disposal.currency");
      if (disposal.notes !== undefined && disposal.notes !== null
        && (typeof disposal.notes !== "string" || String(disposal.notes).length > 500))
        errors.push("disposal.notes");
    }
  }
  if (input.removeDisposalId !== undefined
    && (typeof input.removeDisposalId !== "string" || !input.removeDisposalId.trim()))
    errors.push("removeDisposalId");
  return errors;
}

/** Attach the current ledger record each item was derived from. */
async function enrichWithSource(
  client: DynamoDBDocumentClient,
  items: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  if (!items.length) return items;
  const transactions = await listTransactions(client);
  const byId = new Map(transactions.map((transaction) => [String(transaction.id), transaction]));
  return items.map((item) => {
    const source = inventorySourceRecord(item, byId.get(String(item.transactionId || "")));
    return source ? { ...item, source } : item;
  });
}

export async function handleBookkeepingInventoryRoutes(
  path: string,
  method: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse | null> {
  if (path === "/api/bookkeeping/inventory" && method === "GET") {
    const items = await enrichWithSource(client, await listBookkeepingItems(client, "inventory"));
    return json(200, { items: items.map(publicInventoryItem) });
  }

  if (path === "/api/bookkeeping/inventory/import" && method === "POST") {
    const body = parse(event.body || null) || {};
    const fromYear = Number(body.fromYear ?? DEFAULT_INVENTORY_FROM_YEAR);
    if (!Number.isSafeInteger(fromYear) || fromYear < 2000 || fromYear > 2100)
      return json(400, { error: "Invalid fromYear", fields: ["fromYear"] });
    const apply = body.apply === true;
    const [transactions, existing] = await Promise.all([
      listTransactions(client),
      listBookkeepingItems(client, "inventory"),
    ]);
    const known = new Set(
      existing.map((item) =>
        inventoryItemSeed(String(item.transactionId || ""), typeof item.allocationId === "string" ? item.allocationId : undefined),
      ),
    );
    const candidates = deriveInventoryItems(transactions, { fromYear }).filter(
      (candidate) => !known.has(inventoryItemSeed(candidate.transactionId, candidate.allocationId)),
    );
    const created: Record<string, unknown>[] = [];
    if (apply) {
      for (const candidate of candidates) {
        const { item, duplicate } = await putBookkeepingItem(client, "inventory", stripUndefined({
          id: inventoryItemId(candidate.transactionId, candidate.allocationId),
          transactionId: candidate.transactionId,
          allocationId: candidate.allocationId,
          name: candidate.name,
          type: candidate.type,
          vendor: candidate.vendor,
          acquisitionDate: candidate.acquisitionDate,
          amount: candidate.amount,
          currency: candidate.currency,
          amountEur: candidate.amountEur,
          status: "in-use",
        }), inventoryItemSeed(candidate.transactionId, candidate.allocationId));
        if (!duplicate) created.push(publicInventoryItem(item));
      }
    }
    return json(apply ? 201 : 200, {
      dryRun: !apply,
      matched: candidates.length,
      created: created.length,
      items: apply ? created : candidates,
    });
  }

  const item = path.match(/^\/api\/bookkeeping\/inventory\/([^/]+)$/);
  if (item) {
    const id = decodeURIComponent(item[1]);
    const body = parse(event.body || null);
    if (method === "GET") {
      const existing = await getBookkeepingItem(client, "inventory", id);
      if (!existing) return json(404, { error: "Not found" });
      const [enriched] = await enrichWithSource(client, [publicInventoryItem(existing)]);
      return json(200, enriched);
    }
    if (method === "PUT") {
      if (!body) return json(400, { error: "Invalid JSON" });
      if (body.disposal !== undefined && body.removeDisposalId !== undefined)
        return json(400, { error: "Add or remove one disposal per request", fields: ["disposal", "removeDisposalId"] });
      const errors = [...validateInventoryEdit(body), ...validateDisposalChange(body)];
      if (errors.length) return json(400, { error: "Invalid inventory item", fields: errors });
      const expectedUpdatedAt =
        typeof body.expectedUpdatedAt === "string" && body.expectedUpdatedAt.trim()
          ? body.expectedUpdatedAt.trim()
          : undefined;
      // Only named fields change; an empty value clears the stored one.
      // Amounts and names are seeded from the ledger and are not editable here.
      const value: Record<string, unknown> = {};
      if (body.name !== undefined) value.name = String(body.name).trim();
      if (body.type !== undefined) value.type = String(body.type);
      if (body.notes !== undefined)
        value.notes = body.notes === null || !String(body.notes).trim() ? undefined : String(body.notes);
      if (body.disposal !== undefined || body.removeDisposalId !== undefined) {
        const existing = await getBookkeepingItem(client, "inventory", id);
        if (!existing) return json(404, { error: "Not found" });
        const records = (Array.isArray(existing.disposals) ? existing.disposals : [])
          .filter((record): record is InventoryDisposal => Boolean(record) && typeof record === "object");
        let next: InventoryDisposal[];
        if (body.disposal !== undefined) {
          const disposal = body.disposal as Record<string, unknown>;
          const record: InventoryDisposal = {
            id: randomUUID(),
            kind: String(disposal.kind) as InventoryDisposalKind,
            date: String(disposal.date),
          };
          if (isValidMoney(disposal.proceeds)) {
            record.proceeds = String(disposal.proceeds);
            record.currency = disposal.currency ? String(disposal.currency).toUpperCase() : "EUR";
          }
          if (disposal.notes !== undefined && disposal.notes !== null && String(disposal.notes).trim())
            record.notes = String(disposal.notes);
          next = [...records, record];
        } else {
          const removeId = String(body.removeDisposalId);
          if (!records.some((record) => record.id === removeId))
            return json(404, { error: "Unknown disposal record", fields: ["removeDisposalId"] });
          next = records.filter((record) => record.id !== removeId);
        }
        // Status follows the records: disposing stamps the item, removing the
        // last record puts it back in use.
        Object.assign(value, deriveInventoryDisposalState(next));
      }
      // Ledger-seeded fields are not editable; a request naming none of the
      // editable ones is a read-back, not a write.
      if (!Object.keys(value).length) {
        const existing = await getBookkeepingItem(client, "inventory", id);
        if (!existing) return json(404, { error: "Not found" });
        const [enriched] = await enrichWithSource(client, [publicInventoryItem(existing)]);
        return json(200, enriched);
      }
      try {
        const updated = await updateBookkeepingItem(client, "inventory", id, expectedUpdatedAt, value);
        if (!updated) return json(404, { error: "Not found" });
        const [enriched] = await enrichWithSource(client, [publicInventoryItem(updated)]);
        return json(200, enriched);
      } catch (error) {
        if (error instanceof BookkeepingItemLockedError)
          return json(409, { error: "Inventory item changed; refresh and retry." });
        throw error;
      }
    }
    if (method === "DELETE") {
      try {
        const existing = await deleteBookkeepingItem(client, "inventory", id);
        return existing ? { statusCode: 204, headers: {}, body: "" } : json(404, { error: "Not found" });
      } catch (error) {
        if (error instanceof BookkeepingItemLockedError)
          return json(409, { error: "Inventory item changed; refresh and retry." });
        throw error;
      }
    }
  }
  return null;
}
