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
  INVENTORY_STATUSES,
  INVENTORY_TYPES,
  deriveInventoryItems,
  inventoryItemId,
  inventoryItemSeed,
  type InventoryStatus,
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
  if (input.status !== undefined && !INVENTORY_STATUSES.includes(String(input.status) as InventoryStatus))
    errors.push("status");
  if (input.disposedDate !== undefined && input.disposedDate !== null && !realDate(input.disposedDate))
    errors.push("disposedDate");
  if (input.notes !== undefined && input.notes !== null && (typeof input.notes !== "string" || input.notes.length > 2000))
    errors.push("notes");
  return errors;
}

export async function handleBookkeepingInventoryRoutes(
  path: string,
  method: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse | null> {
  if (path === "/api/bookkeeping/inventory" && method === "GET") {
    const items = await listBookkeepingItems(client, "inventory");
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
      return existing ? json(200, publicInventoryItem(existing)) : json(404, { error: "Not found" });
    }
    if (method === "PUT") {
      if (!body) return json(400, { error: "Invalid JSON" });
      const errors = validateInventoryEdit(body);
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
      if (body.status !== undefined) value.status = String(body.status);
      if (body.notes !== undefined)
        value.notes = body.notes === null || !String(body.notes).trim() ? undefined : String(body.notes);
      if (body.disposedDate !== undefined)
        value.disposedDate = body.disposedDate === null ? undefined : String(body.disposedDate);
      if (body.status !== undefined && body.status !== "disposed" && body.disposedDate === undefined)
        value.disposedDate = undefined;
      // Ledger-seeded fields are not editable; a request naming none of the
      // editable ones is a read-back, not a write.
      if (!Object.keys(value).length) {
        const existing = await getBookkeepingItem(client, "inventory", id);
        return existing ? json(200, publicInventoryItem(existing)) : json(404, { error: "Not found" });
      }
      try {
        const updated = await updateBookkeepingItem(client, "inventory", id, expectedUpdatedAt, value);
        if (!updated) return json(404, { error: "Not found" });
        return json(200, publicInventoryItem(updated));
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
