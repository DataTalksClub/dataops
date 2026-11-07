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

export const INVENTORY_STATUSES = ["in-use", "disposed"] as const;
export type InventoryStatus = (typeof INVENTORY_STATUSES)[number];

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
const money = (value: unknown) =>
  typeof value === "string" && /^(0|[1-9]\d{0,11})(\.\d{1,4})?$/.test(value) ? value : undefined;

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
