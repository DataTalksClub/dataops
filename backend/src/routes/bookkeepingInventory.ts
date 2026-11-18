import { randomUUID } from "crypto";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { LambdaEvent, LambdaResponse } from "../types";
import {
  BookkeepingItemLockedError,
  deleteBookkeepingItem,
  dismissInventorySeed,
  getBookkeepingItem,
  listBookkeepingItems,
  listTransactions,
  putBookkeepingItem,
  sweepInventory,
  updateBookkeepingItem,
} from "../db/bookkeeping";
import { json, parse } from "./bookkeepingShared";
import { realDate } from "../sponsorCrm/model";
import {
  INVENTORY_DISPOSAL_KINDS,
  INVENTORY_TYPES,
  INVENTORY_USAGES,
  deriveInventoryDisposalState,
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
  if (input.usage !== undefined && !INVENTORY_USAGES.includes(String(input.usage) as (typeof INVENTORY_USAGES)[number]))
    errors.push("usage");
  // Status and exit dates follow the disposal records; editing them
  // directly is rejected so clients cannot fight the derivation.
  if (input.status !== undefined) errors.push("status");
  if (input.disposedDate !== undefined) errors.push("disposedDate");
  if (input.returnedDate !== undefined) errors.push("returnedDate");
  if (input.notes !== undefined && input.notes !== null && (typeof input.notes !== "string" || input.notes.length > 2000))
    errors.push("notes");
  if (input.addImage !== undefined) {
    const image = input.addImage as Record<string, unknown>;
    if (!image || typeof image !== "object" || Array.isArray(image))
      errors.push("addImage");
    else {
      if (typeof image.url !== "string" || !/^https?:\/\/\S+$/.test(image.url) || image.url.length > 1000)
        errors.push("addImage.url");
      if (image.caption !== undefined && image.caption !== null
        && (typeof image.caption !== "string" || image.caption.length > 200))
        errors.push("addImage.caption");
    }
  }
  if (input.removeImageUrl !== undefined
    && (typeof input.removeImageUrl !== "string" || !input.removeImageUrl.trim()))
    errors.push("removeImageUrl");
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

  if (path === "/api/bookkeeping/inventory/sweep" && method === "POST") {
    const result = await sweepInventory(client);
    return json(201, {
      matched: result.matched,
      created: result.created.length,
      items: result.created.map(publicInventoryItem),
    });
  }

  // Record an inventory item for a purchase picked from the ledger. One
  // invoice can yield several items (one payment, two things), and every
  // item keeps the same invoice as its source record.
  if (path === "/api/bookkeeping/inventory/items" && method === "POST") {
    const body = parse(event.body || null);
    if (!body) return json(400, { error: "Invalid JSON" });
    const transactionId = typeof body.transactionId === "string" ? body.transactionId.trim() : "";
    if (!transactionId) return json(400, { error: "transactionId is required", fields: ["transactionId"] });
    const transaction = await getBookkeepingItem(client, "bookkeeping", transactionId);
    if (!transaction || transaction.voidStatus === "voided")
      return json(404, { error: "Transaction not found", fields: ["transactionId"] });
    const allocationId = typeof body.allocationId === "string" && body.allocationId.trim()
      ? body.allocationId.trim()
      : undefined;
    const source = inventorySourceRecord({ transactionId, allocationId }, transaction);
    if (allocationId && !source)
      return json(400, { error: "Unknown allocation row", fields: ["allocationId"] });
    const name = typeof body.name === "string" && body.name.trim()
      ? body.name.trim()
      : String(source?.description || "");
    if (!name || name.length > 300)
      return json(400, { error: "name is required", fields: ["name"] });
    if (body.type !== undefined && !INVENTORY_TYPES.includes(String(body.type) as InventoryType))
      return json(400, { error: "Invalid inventory item", fields: ["type"] });
    if (body.usage !== undefined && !INVENTORY_USAGES.includes(String(body.usage) as (typeof INVENTORY_USAGES)[number]))
      return json(400, { error: "Invalid inventory item", fields: ["usage"] });
    if (body.notes !== undefined && body.notes !== null
      && (typeof body.notes !== "string" || body.notes.length > 2000))
      return json(400, { error: "Invalid inventory item", fields: ["notes"] });
    if (!allocationId) {
      // A payment without invoice rows derives one automatic transaction-level
      // item; recording items by hand replaces it. Dismiss that seed so the
      // automatic entry never comes back alongside the hand-recorded ones,
      // but refuse while the automatic item still exists.
      const existing = await listBookkeepingItems(client, "inventory");
      const clash = existing.find((item) =>
        String(item.transactionId || "") === transactionId && !item.allocationId && !item.manual);
      if (clash)
        return json(409, { error: "This invoice already has an inventory item; remove that one first to record its items separately." });
      await dismissInventorySeed(client, inventoryItemSeed(transactionId), { transactionId });
    }
    const { item } = await putBookkeepingItem(client, "inventory", stripUndefined({
      id: inventoryItemId(transactionId, allocationId ?? `manual:${randomUUID()}`),
      transactionId,
      allocationId,
      manual: true,
      name,
      type: typeof body.type === "string" ? String(body.type) : "other",
      vendor: String(source?.counterparty ?? ""),
      acquisitionDate: String(source?.date ?? ""),
      amount: source?.amount,
      currency: source?.currency,
      amountEur: source?.amountEur,
      status: "in-use",
      usage: typeof body.usage === "string" ? String(body.usage) : "active",
      ...(body.notes !== undefined && body.notes !== null && String(body.notes).trim()
        ? { notes: String(body.notes).trim() }
        : {}),
    }));
    const [enriched] = await enrichWithSource(client, [publicInventoryItem(item)]);
    return json(201, enriched);
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
      if (body.usage !== undefined) value.usage = String(body.usage);
      if (body.notes !== undefined)
        value.notes = body.notes === null || !String(body.notes).trim() ? undefined : String(body.notes);
      if (body.addImage !== undefined || body.removeImageUrl !== undefined) {
        const existingImages = await getBookkeepingItem(client, "inventory", id);
        if (!existingImages) return json(404, { error: "Not found" });
        const current = (Array.isArray(existingImages.images) ? existingImages.images : [])
          .filter((image): image is Record<string, unknown> => Boolean(image) && typeof image === "object");
        const removeUrl = typeof body.removeImageUrl === "string" ? body.removeImageUrl : "";
        let next = current.filter((image) => image.url !== removeUrl);
        if (body.addImage !== undefined) {
          if (next.length >= 8)
            return json(409, { error: "An item keeps at most 8 pictures." });
          const image = body.addImage as Record<string, unknown>;
          const record: Record<string, unknown> = { url: String(image.url) };
          if (typeof image.caption === "string" && image.caption.trim())
            record.caption = image.caption.trim();
          next = [...next, record];
        }
        value.images = next;
      }
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
      let removed: Record<string, unknown> | null = null;
      try {
        removed = await deleteBookkeepingItem(client, "inventory", id);
        if (removed) {
          // Tombstone the seed so the sweep and later ledger writes never
          // re-derive this item. Removal is deliberate (API or CLI only, no
          // UI affordance), and the tombstone makes it stick.
          const transactionId = String(removed.transactionId || "");
          const allocationId = typeof removed.allocationId === "string" ? removed.allocationId : undefined;
          await dismissInventorySeed(
            client,
            inventoryItemSeed(transactionId, allocationId),
            {
              transactionId,
              ...(allocationId !== undefined ? { allocationId } : {}),
              ...(removed.manual ? { manual: true } : {}),
            },
          );
        }
        return removed ? { statusCode: 204, headers: {}, body: "" } : json(404, { error: "Not found" });
      } catch (error) {
        if (error instanceof BookkeepingItemLockedError)
          return json(409, { error: "Inventory item changed; refresh and retry." });
        throw error;
      }
    }
  }
  return null;
}
