import { isReportExemptTransaction } from "../db/bookkeeping";
import { readTransactionAllocations } from "../bookkeepingAllocations";

export type AccountantReportEntry = Record<string, unknown>;

export function accountantCashDate(entry: AccountantReportEntry) {
  const paidDate = String(entry.paidDate || "").slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(paidDate)) return paidDate;
  const transactionDate = String(entry.transactionDate || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(transactionDate) ? transactionDate : "";
}

/** Expand a payment using the saved Company/What and exact invoice-level allocation amounts. */
export function accountantReportRows(transactions: AccountantReportEntry[]) {
  return transactions.flatMap((entry) => {
    const allocations = readTransactionAllocations(entry);
    if (!allocations.length) return [entry];
    return allocations.map((allocation) => ({
      ...entry,
      transactionDate: entry.transactionDate,
      paidDate: entry.paidDate,
      counterparty: allocation.counterparty,
      description: allocation.description,
      amount: allocation.amount,
      currency: allocation.currency,
      ...(allocation.amountEur !== undefined ? { amountEur: allocation.amountEur } : { amountEur: undefined }),
      ...(allocation.vatAmount !== undefined ? { vatAmount: allocation.vatAmount } : { vatAmount: undefined }),
      ...(allocation.vatCurrency !== undefined ? { vatCurrency: allocation.vatCurrency } : { vatCurrency: undefined }),
      category: allocation.category || entry.category,
      subtype: allocation.subtype || entry.subtype,
      invoiceNumber: allocation.invoiceNumber,
      allocationDocumentId: allocation.documentId,
      invoiceId: allocation.invoiceId,
      allocations: undefined,
    }));
  });
}

/** Cash-date selection shared by the native accountant report and package exports. */
export function accountantReportRowsForPeriod(transactions: AccountantReportEntry[], period: string) {
  return accountantReportRows(transactions)
    .filter((entry) => !period || accountantCashDate(entry).startsWith(period));
}

export function isAccountantReportRowIncluded(entry: AccountantReportEntry) {
  return !isReportExemptTransaction(entry);
}

export function selectAccountantReportRows(transactions: AccountantReportEntry[], period: string) {
  return accountantReportRowsForPeriod(transactions, period).filter(isAccountantReportRowIncluded);
}

function accountantCurrency(entry: AccountantReportEntry) {
  return String(entry.currency || "EUR").trim().toUpperCase();
}

/** Rows that cannot be represented in the EUR-only accountant report. */
export function unconvertedAccountantReportRows(entries: AccountantReportEntry[]) {
  return entries.filter((entry) =>
    accountantCurrency(entry) !== "EUR" &&
    !String(entry.amountEur ?? "").trim(),
  );
}

const HEADERS = ["Date", "Company", "What", "Amount, EUR"];

function direction(entry: AccountantReportEntry) {
  const type = String(entry.entryType || "").trim().toLowerCase();
  if (!type) return "";
  return type.includes("income") ? "income" : "expense";
}

function spreadsheetText(value: unknown) {
  const text = String(value ?? "");
  return /^\s*[=+@-]/.test(text) ? `'${text}` : text;
}

function csvCell(value: unknown) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function values(entry: AccountantReportEntry) {
  const dir = direction(entry);
  const sign = dir === "expense" ? "-" : "";
  const eurValue = accountantCurrency(entry) === "EUR" ? entry.amount : entry.amountEur ?? "";
  const priceEur = eurValue !== "" && eurValue != null ? `${sign}${eurValue}` : "";
  return [
    accountantCashDate(entry),
    entry.counterparty || "",
    entry.description || "",
    priceEur,
  ];
}

/** Cash-date order, deterministic parent ties, and saved allocation order. */
function chronologicalReportRows(entries: AccountantReportEntry[]) {
  return entries.map((entry, index) => ({ entry, index }))
    .sort((left, right) => accountantCashDate(left.entry).localeCompare(accountantCashDate(right.entry))
      || String(left.entry.id || "").localeCompare(String(right.entry.id || ""))
      || left.index - right.index)
    .map(({ entry }) => entry);
}

export function formatAccountantCsv(entries: AccountantReportEntry[]) {
  const lines = [HEADERS.map(csvCell).join(",")];
  for (const entry of chronologicalReportRows(entries)) {
    lines.push(values(entry)
      .map((value, index) => csvCell(index === 3 ? value : spreadsheetText(value)))
      .join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

export function formatAccountantTsv(entries: AccountantReportEntry[]) {
  const lines = [HEADERS.join("\t")];
  for (const entry of chronologicalReportRows(entries)) {
    lines.push(values(entry)
      .map((value, index) => {
        const text = String(value ?? "").replace(/[\t\r\n]/g, " ");
        return index === 3 ? text : spreadsheetText(text);
      })
      .join("\t"));
  }
  return lines.join("\n");
}

/** Email-ready semantic table using the same cells and order as CSV/TSV. */
export function formatAccountantHtml(entries: AccountantReportEntry[]) {
  const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
  const headers = HEADERS.map((header) => `<th scope="col" style="padding:2px 3px;vertical-align:middle;border:1px solid rgb(204,204,204);text-align:left;font-weight:bold">${escape(header)}</th>`).join("");
  const rows = chronologicalReportRows(entries).map((entry) => `<tr>${values(entry).map((value, index) =>
    `<td style="padding:2px 3px;vertical-align:middle;border:1px solid rgb(204,204,204);white-space:pre-wrap${index === 3 ? ";text-align:right" : ""}">${escape(value)}</td>`).join("")}</tr>`);
  return `<table cellspacing="0" cellpadding="0" dir="ltr" border="1" style="font-size:10pt;font-family:Arial;border-collapse:collapse"><thead><tr>${headers}</tr></thead><tbody>${rows.join("")}</tbody></table>`;
}
