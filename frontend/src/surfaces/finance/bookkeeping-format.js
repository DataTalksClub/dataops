// Pure formatting and validation helpers for the bookkeeping surface. The
// backend owns the persisted contracts these mirror.

// Mirror of the backend MONEY contract: a positive decimal string with no
// sign or separators. The entry type carries the direction.
export const MONEY_PATTERN = /^(0|[1-9]\d{0,11})(\.\d{1,4})?$/;

export const FIELD_LABELS = {
  transactionDate: "Transaction date",
  paidDate: "Paid date",
  counterparty: "Provider / payee",
  description: "Description",
  amount: "Amount",
  currency: "Currency",
  vatAmount: "VAT amount",
  vatCurrency: "VAT currency",
  category: "Category",
  entryType: "Type",
  quantity: "Count",
  comment: "Comment",
};

// Observable classification from the groomed #243 contract: a type that
// contains "income" (case-insensitive) is income, any other non-empty type is
// an expense, and only entries without a type stay unclassified.
export function entryDirection(entry) {
  const type = String(entry.entryType || "").trim().toLowerCase();
  if (!type) return "";
  if (type.includes("income")) return "income";
  return "expense";
}

// Ledger dates read as short human dates; the year is kept when it is not
// the current one, since a finance ledger spans years.
export function ledgerDate(value) {
  const iso = String(value || "").slice(0, 10);
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return value || "";
  const sameYear = iso.slice(0, 4) === String(new Date().getFullYear());
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone: "UTC",
  }).format(parsed);
}

// The month a ledger entry belongs to, in "YYYY-MM" form. Undated entries
// have no month and only surface in the all-months view.
export function monthOf(entry) {
  const month = String(entry?.transactionDate || "").slice(0, 7);
  return /^\d{4}-\d{2}$/.test(month) ? month : "";
}

// "2026-09" reads as "September 2026".
export function monthLabel(month) {
  if (!/^\d{4}-\d{2}$/.test(String(month))) return String(month || "");
  const parsed = new Date(`${month}-01T00:00:00Z`);
  return new Intl.DateTimeFormat("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(parsed);
}

// The month before/after "YYYY-MM"; stepping is how the operator moves the
// close lens without opening a picker.
export function shiftMonth(month, step) {
  if (!/^\d{4}-\d{2}$/.test(String(month))) return month;
  const [y, m] = String(month).split("-").map(Number);
  const shifted = new Date(Date.UTC(y, m - 1 + step, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

// The month the close lens opens on: the latest month that has ledger
// activity, falling back to the caller's "today" month so an empty ledger
// still points at the month the operator would close next.
export function latestActivityMonth(entries, fallbackMonth) {
  const months = (entries || [])
    .map((entry) => monthOf(entry))
    .filter(Boolean)
    .sort();
  if (months.length) return months[months.length - 1];
  return fallbackMonth;
}
