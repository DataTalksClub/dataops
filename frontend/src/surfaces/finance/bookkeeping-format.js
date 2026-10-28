// Pure formatting and validation helpers for the bookkeeping surface. The
// backend owns the persisted contracts these mirror.

// Mirror of the backend MONEY contract: a positive decimal string with no
// sign or separators. The entry type carries the direction.
export const MONEY_PATTERN = /^(0|[1-9]\d{0,11})(\.\d{1,4})?$/;

export const FIELD_LABELS = {
  transactionDate: "Date",
  paidDate: "Paid date",
  counterparty: "Counterparty",
  description: "What",
  amountEur: "EUR value",
  statementRef: "Account / statement",
  subtype: "Type",
  period: "Period",
  amount: "Amount",
  currency: "Currency",
  vatAmount: "VAT amount",
  vatCurrency: "VAT currency",
  category: "Category",
  entryType: "Direction",
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

// The month before/after "YYYY-MM" or "YYYY"; stepping is how the operator moves the
// close lens without opening a picker.
export function shiftMonth(month, step) {
  if (/^\d{4}$/.test(String(month))) {
    return String(Number(month) + step);
  }
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

// Display only: entry forms and storage keep their original decimal strings.
export function formatAmount(value, currency = "EUR") {
  const raw = value === null || value === undefined ? "" : String(value);
  const code = String(currency || "").trim().toUpperCase();
  if (!raw.trim()) return "—";
  const numeric = typeof value === "number" || typeof value === "string"
    ? Number(value)
    : NaN;
  const fallback = `${raw}${code ? ` ${code}` : ""}`;
  if (!Number.isFinite(numeric) || !/^[A-Z]{3}$/.test(code)) return fallback;
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: code,
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(numeric);
  } catch {
    return fallback;
  }
}
// Unique years from transactions plus fallback, sorted descending.
export function yearsOf(entries, fallback) {
  const set = new Set();
  const currentYear = String(new Date().getFullYear());
  set.add(currentYear);
  if (fallback) {
    const y = String(fallback).slice(0, 4);
    if (/^\d{4}$/.test(y)) set.add(y);
  }
  (entries || []).forEach((e) => {
    const y = String(e?.transactionDate || "").slice(0, 4);
    if (/^\d{4}$/.test(y)) set.add(y);
  });
  return [...set].sort((a, b) => b.localeCompare(a));
}

// RFC 4180 CSV cell quoting
export function csvCell(value) {
  if (value == null) return '""';
  const str = String(value);
  return `"${str.replace(/"/g, '""')}"`;
}

// Spreadsheet applications interpret leading formula markers in text fields.
// Monetary columns remain numeric strings so expense signs and precision survive.
function spreadsheetText(value) {
  const text = String(value ?? "");
  return /^\s*[=+@-]/.test(text) ? `'${text}` : text;
}

// Payment categories tracked in the ledger but kept out of accountant's
// monthly package and taxable report.
export const REPORT_EXEMPT_CATEGORIES = new Set(["Taxes", "Health Insurance"]);
export function isReportExempt(entry) {
  return REPORT_EXEMPT_CATEGORIES.has(String(entry?.category || ""));
}

// Format ledger entries into the standard accountant tax report CSV.
// Follows the DTC bookkeeping sheet specification (signed EUR prices, USD original prices).
export function formatReportCsv(entries, options = {}) {
  const excludeExempt = options.excludeExempt ?? true;
  const rows = excludeExempt
    ? (entries || []).filter((e) => !isReportExempt(e))
    : (entries || []);
  const headers = [
    "Date",
    "Paid Date",
    "Provider",
    "Description",
    "Price EUR",
    "Price USD",
    "Original Currency",
    "VAT Amount",
    "VAT Currency",
    "Category",
    "Type",
    "Statement",
  ];
  const lines = [headers.map(csvCell).join(",")];
  for (const entry of rows) {
    const dir = entryDirection(entry);
    const sign = dir === "expense" ? "-" : "";
    const eurVal =
      entry.currency === "EUR"
        ? entry.amount
        : entry.amountEur ?? "";
    const priceEur = eurVal !== "" && eurVal != null ? `${sign}${eurVal}` : "";
    const priceUsd =
      entry.currency === "USD" ? `${sign}${entry.amount}` : "";
    lines.push(
      [
        entry.transactionDate || "",
        entry.paidDate || "",
        entry.counterparty || "",
        entry.description || "",
        priceEur,
        priceUsd,
        entry.currency || "",
        entry.vatAmount || "",
        entry.vatCurrency || "",
        entry.category || "",
        dir === "income" ? "Income" : dir === "expense" ? "Expense" : entry.entryType || "",
        entry.statementRef || "",
      ]
        .map((value, index) => csvCell([4, 5, 7].includes(index) ? value : spreadsheetText(value)))
        .join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

// Format full raw ledger entries matching the backend snapshot format.
export function formatFullCsv(entries) {
  const columns = [
    "transactionDate",
    "paidDate",
    "counterparty",
    "description",
    "amount",
    "currency",
    "amountEur",
    "vatAmount",
    "vatCurrency",
    "category",
    "entryType",
    "statementRef",
  ];
  const lines = [columns.map(csvCell).join(",")];
  for (const entry of entries || []) {
    lines.push(columns.map((c) => csvCell(["amount", "amountEur", "vatAmount"].includes(c) ? entry[c] : spreadsheetText(entry[c]))).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

// Format tab-separated values ready for copy-pasting directly into Gmail or Google Sheets.
export function formatReportTsv(entries, options = {}) {
  const excludeExempt = options.excludeExempt ?? true;
  const rows = excludeExempt
    ? (entries || []).filter((e) => !isReportExempt(e))
    : (entries || []);
  const headers = [
    "Date",
    "Paid Date",
    "Provider",
    "Description",
    "Price EUR",
    "Price USD",
    "Currency",
    "VAT",
    "VAT Currency",
    "Category",
    "Type",
    "Statement",
  ];
  const lines = [headers.join("\t")];
  for (const entry of rows) {
    const dir = entryDirection(entry);
    const sign = dir === "expense" ? "-" : "";
    const eurVal =
      entry.currency === "EUR"
        ? entry.amount
        : entry.amountEur ?? "";
    const priceEur = eurVal !== "" && eurVal != null ? `${sign}${eurVal}` : "";
    const priceUsd =
      entry.currency === "USD" ? `${sign}${entry.amount}` : "";
    lines.push(
      [
        entry.transactionDate || "",
        entry.paidDate || "",
        entry.counterparty || "",
        entry.description || "",
        priceEur,
        priceUsd,
        entry.currency || "",
        entry.vatAmount ?? "",
        entry.vatCurrency || "",
        entry.category || "",
        dir === "income" ? "Income" : dir === "expense" ? "Expense" : entry.entryType || "",
        entry.statementRef || "",
      ]
        .map((v, index) => {
          const text = String(v ?? "").replace(/[\t\r\n]/g, " ");
          return [4, 5, 7].includes(index) ? text : spreadsheetText(text);
        })
        .join("\t"),
    );
  }
  return lines.join("\n");
}

// Trigger client-side file download.
export function downloadCsv(content, filename) {
  if (typeof document === "undefined") return;
  const blob =
    typeof Blob !== "undefined"
      ? new Blob([content], { type: "text/csv;charset=utf-8;" })
      : null;
  const url =
    blob && typeof URL !== "undefined" && URL.createObjectURL
      ? URL.createObjectURL(blob)
      : "";
  const link = document.createElement("a");
  if (url) link.href = url;
  link.download = filename;
  const container = document.body || document.documentElement || document;
  if (container?.appendChild) container.appendChild(link);
  if (link.click) link.click();
  if (link.remove) link.remove();
  if (url && typeof URL !== "undefined" && URL.revokeObjectURL) {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

// Copy text to clipboard with fallback.
export async function copyToClipboard(text) {
  if (typeof navigator !== "undefined" && navigator?.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback below
    }
  }
  if (typeof document !== "undefined") {
    const container = document.body || document.documentElement || document;
    if (container && typeof container.appendChild === "function") {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      container.appendChild(textarea);
      if (textarea.select) textarea.select();
      const success = document.execCommand ? document.execCommand("copy") : false;
      if (textarea.remove) {
        textarea.remove();
      } else if (container.removeChild) {
        container.removeChild(textarea);
      }
      return Boolean(success);
    }
    return false;
  }
  return false;
}
