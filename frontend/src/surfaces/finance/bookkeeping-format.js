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

export function entryDirection(entry) {
  return String(entry.entryType || "").trim().toLowerCase();
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
