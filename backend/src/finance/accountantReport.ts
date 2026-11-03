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
  const eurValue = entry.currency === "EUR" ? entry.amount : entry.amountEur ?? "";
  const priceEur = eurValue !== "" && eurValue != null ? `${sign}${eurValue}` : "";
  return [
    accountantCashDate(entry),
    entry.counterparty || "",
    entry.description || "",
    priceEur,
  ];
}

export function formatAccountantCsv(entries: AccountantReportEntry[]) {
  const lines = [HEADERS.map(csvCell).join(",")];
  for (const entry of entries) {
    lines.push(values(entry)
      .map((value, index) => csvCell(index === 3 ? value : spreadsheetText(value)))
      .join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

export function formatAccountantTsv(entries: AccountantReportEntry[]) {
  const lines = [HEADERS.join("\t")];
  for (const entry of entries) {
    lines.push(values(entry)
      .map((value, index) => {
        const text = String(value ?? "").replace(/[\t\r\n]/g, " ");
        return index === 3 ? text : spreadsheetText(text);
      })
      .join("\t"));
  }
  return lines.join("\n");
}
