import { createHash } from "crypto";

// The inventory tracks physical things bought for the company so the balance
// shows what hardware and furniture exists. Items are derived from ledger
// expenses: one inventory entry per physical purchase (or per allocated
// invoice row when one payment bought several things).
export const INVENTORY_TYPES = [
  "computer",
  "phone",
  "audio",
  "furniture",
  "accessory",
  "other",
] as const;
export type InventoryType = (typeof INVENTORY_TYPES)[number];

export const INVENTORY_STATUSES = ["in-use", "disposed", "returned"] as const;
export type InventoryStatus = (typeof INVENTORY_STATUSES)[number];

// Whether the item is actively used day to day or sits idle: still owned,
// still on the balance, just not in daily use.
export const INVENTORY_USAGES = ["active", "idle"] as const;
export type InventoryUsage = (typeof INVENTORY_USAGES)[number];

// An exit record for an inventory item: sold off, decommissioned (scrapped,
// recycled, given away without payment), or returned to the vendor.
export const INVENTORY_DISPOSAL_KINDS = ["sold", "decommissioned", "returned"] as const;
export type InventoryDisposalKind = (typeof INVENTORY_DISPOSAL_KINDS)[number];

export type InventoryDisposal = {
  id: string;
  kind: InventoryDisposalKind;
  date: string;
  /** Money received, required when the item was sold. */
  proceeds?: string;
  currency?: string;
  notes?: string;
};

export const DEFAULT_INVENTORY_FROM_YEAR = 2022;

// Ordered: the first matching bucket wins, so "Surface Pro 12" Keyboard"
// lands in computer even though it also names a keyboard. Phrases precede
// bare words to keep "Standing desk" out of "Standard plan" trouble.
const TYPE_PATTERNS: [InventoryType, RegExp][] = [
  [
    "computer",
    /\b(laptop|notebook|macbook|thinkpad|thinkcentre|surface|computer|desktop|workstation|tablet|ipad|mini pc|copilot\+ pc|pc)\b/i,
  ],
  ["phone", /\b(phone|iphone|smartphone|mobile|pixel)\b/i],
  [
    "audio",
    /\b(microphone|mikrofon|headset|headphones|earphones|earbuds|earpods|airpods|speaker|lavalier)\b/i,
  ],
  ["furniture", /\b(desk|schreibtisch|chair|stuhl|shelf|regal|lamp|lampe)\b/i],
  [
    "accessory",
    /\b(keyboard|tastatur|mouse|maus|cable|kabel|hdmi|usb|adapter|dock|case|cover|screen|power strip|capture card|wi-?fi|router|webcam|camera|watch|tripod|powerbank|battery|akku|ssd|hard drive|festplatte|connector|pen|monitor|display|stylus)\b/i,
  ],
];

export type PhysicalItemCandidate = {
  transactionId: string;
  allocationId?: string;
  name: string;
  type: InventoryType;
  vendor: string;
  acquisitionDate: string;
  amount?: string;
  currency?: string;
  amountEur?: string;
};

/** Classify a purchase description into an inventory type, or null when it names no physical item. */
export function classifyPhysicalItem(description: string): InventoryType | null {
  const text = String(description || "");
  if (!text.trim()) return null;
  for (const [type, pattern] of TYPE_PATTERNS) {
    if (pattern.test(text)) return type;
  }
  return null;
}

export function inventoryItemSeed(transactionId: string, allocationId?: string) {
  return `inventory:${transactionId}:${allocationId || "tx"}`;
}

export function inventoryItemId(transactionId: string, allocationId?: string) {
  return createHash("sha256").update(inventoryItemSeed(transactionId, allocationId)).digest("hex");
}

export type InventoryImage = { url: string; caption?: string };

/** Id of the tombstone that keeps a dismissed (transaction, allocation) seed out of future derivations. */
export function dismissedInventorySeedId(seed: string) {
  return createHash("sha256").update(`inventory-dismissed:${seed}`).digest("hex");
}

type TransactionLike = {
  id?: unknown;
  voidStatus?: unknown;
  entryType?: unknown;
  transactionDate?: unknown;
  paidDate?: unknown;
  counterparty?: unknown;
  description?: unknown;
  comment?: unknown;
  amount?: unknown;
  currency?: unknown;
  amountEur?: unknown;
  allocations?: unknown;
};

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** Non-negative decimal amount as stored on ledger items, e.g. "13.99". */
export function isValidMoney(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9]\d{0,11})(\.\d{1,4})?$/.test(value);
}
const money = (value: unknown) => (isValidMoney(value) ? value : undefined);

/**
 * Physical purchases among expense transactions from `fromYear` on. A payment
 * with invoice allocations yields one candidate per physical allocation row
 * and no transaction-level candidate; without allocations the payment itself
 * is the item when its description (or comment) names a physical thing.
 */
export function deriveInventoryItems(
  transactions: readonly TransactionLike[],
  options: { fromYear?: number } = {},
): PhysicalItemCandidate[] {
  const fromYear = options.fromYear ?? DEFAULT_INVENTORY_FROM_YEAR;
  const candidates: PhysicalItemCandidate[] = [];
  for (const transaction of transactions) {
    if (transaction.voidStatus === "voided") continue;
    if (transaction.entryType !== "expense") continue;
    const date = text(transaction.paidDate) || text(transaction.transactionDate);
    const year = Number(String(date).slice(0, 4));
    if (!Number.isFinite(year) || year < fromYear) continue;
    const vendor = text(transaction.counterparty);
    const currency = text(transaction.currency);
    const amount = money(transaction.amount);
    const amountEur =
      currency === "EUR" ? amount : money(transaction.amountEur);

    const allocationRows = Array.isArray(transaction.allocations) ? transaction.allocations : [];
    const matchedAllocations: PhysicalItemCandidate[] = [];
    for (const allocation of allocationRows) {
      const row = (allocation && typeof allocation === "object" ? allocation : {}) as Record<string, unknown>;
      const name = text(row.description);
      const type = classifyPhysicalItem(name);
      if (!type) continue;
      matchedAllocations.push({
        transactionId: String(transaction.id || ""),
        allocationId: text(row.id) || undefined,
        name,
        type,
        vendor: text(row.counterparty) || vendor,
        acquisitionDate: text(row.paidDate) || text(row.transactionDate) || date,
        amount: money(row.amount) ?? money(row.grossAmountEur),
        currency: text(row.currency) || currency,
        amountEur: money(row.amountEur) ?? money(row.grossAmountEur) ?? (currency === "EUR" ? money(row.amount) : undefined) ?? amountEur,
      });
    }
    if (matchedAllocations.length) {
      candidates.push(...matchedAllocations);
      continue;
    }
    const name = text(transaction.description);
    const type = classifyPhysicalItem(`${name} ${text(transaction.comment)}`);
    if (!type) continue;
    candidates.push({
      transactionId: String(transaction.id || ""),
      name,
      type,
      vendor,
      acquisitionDate: date,
      amount,
      currency,
      amountEur,
    });
  }
  return candidates.filter((candidate) => candidate.transactionId && candidate.name && candidate.acquisitionDate);
}

export type InventorySourceRecord = {
  transactionId: string;
  allocationId?: string;
  description: string;
  counterparty: string;
  date: string;
  amount?: string;
  currency?: string;
  amountEur?: string;
};

/**
 * The ledger record an inventory item came from, read back from the current
 * transaction so the tab shows when it was bought and for what price even
 * after the ledger row was corrected. Allocation-backed items describe
 * themselves from their allocation row. Returns null when the transaction
 * (or the referenced allocation row) no longer exists.
 */
export function inventorySourceRecord(
  item: { transactionId?: unknown; allocationId?: unknown },
  transaction: Record<string, unknown> | null | undefined,
): InventorySourceRecord | null {
  if (!transaction) return null;
  const transactionId = text(transaction.id);
  if (!transactionId || transactionId !== text(item.transactionId)) return null;
  const date = text(transaction.paidDate) || text(transaction.transactionDate);
  const base = {
    transactionId,
    date,
    counterparty: text(transaction.counterparty),
    amount: money(transaction.amount),
    currency: text(transaction.currency),
    amountEur: text(transaction.currency) === "EUR" ? money(transaction.amount) : money(transaction.amountEur),
  };
  const allocationId = text(item.allocationId);
  if (!allocationId) return { ...base, description: text(transaction.description) };
  const rows = Array.isArray(transaction.allocations) ? transaction.allocations : [];
  const row = rows.find(
    (candidate) => candidate && typeof candidate === "object" && text((candidate as Record<string, unknown>).id) === allocationId,
  ) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    transactionId,
    allocationId,
    description: text(row.description) || text(transaction.description),
    counterparty: text(row.counterparty) || base.counterparty,
    date: text(row.paidDate) || text(row.transactionDate) || base.date,
    amount: money(row.amount) ?? money(row.grossAmountEur) ?? base.amount,
    currency: text(row.currency) || base.currency,
    amountEur: money(row.amountEur) ?? money(row.grossAmountEur)
      ?? (text(row.currency) === "EUR" ? money(row.amount) : undefined) ?? base.amountEur,
  };
}

/**
 * Exit records drive the item status: the latest record by date wins, so a
 * returned item that is later sold flips to disposed. Returns the writable
 * fields for updateBookkeepingItem; the date fields are always present (with
 * undefined clearing the stale stamp when the records no longer imply them).
 */
export function deriveInventoryDisposalState(
  disposals: readonly InventoryDisposal[],
): { disposals: InventoryDisposal[]; status: InventoryStatus; disposedDate?: string; returnedDate?: string } {
  const records = [...disposals];
  if (!records.length)
    return { disposals: records, status: "in-use", disposedDate: undefined, returnedDate: undefined };
  const latest = records.reduce((a, b) => (b.date > a.date ? b : a), records[0]);
  if (latest.kind === "returned")
    return { disposals: records, status: "returned", returnedDate: latest.date, disposedDate: undefined };
  return { disposals: records, status: "disposed", disposedDate: latest.date, returnedDate: undefined };
}
