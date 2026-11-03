import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { isReportExemptTransaction, listTransactions } from "../db/bookkeeping";
import { readTransactionAllocations } from "../bookkeepingAllocations";
import type { LambdaEvent, LambdaResponse } from "../types";
import { json } from "./bookkeepingShared";

const CSV_HEADERS = [
  "Date", "Paid Date", "Provider", "Description", "Price EUR", "Price USD",
  "Original Currency", "VAT Amount", "VAT Currency", "Category", "Type", "Statement",
];
const TSV_HEADERS = [
  "Date", "Paid Date", "Provider", "Description", "Price EUR", "Price USD",
  "Currency", "VAT", "VAT Currency", "Category", "Type", "Statement",
];

type ReportEntry = Record<string, unknown>;

function cashDate(entry: ReportEntry) {
  const paidDate = String(entry.paidDate || "").slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(paidDate)) return paidDate;
  const transactionDate = String(entry.transactionDate || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(transactionDate) ? transactionDate : "";
}

export function accountantReportRows(transactions: ReportEntry[]) {
  return transactions.flatMap((entry) => {
    const allocations = readTransactionAllocations(entry);
    if (!allocations.length) return [entry];
    return allocations.map((allocation) => ({
      ...entry,
      transactionDate: allocation.transactionDate || entry.transactionDate,
      paidDate: allocation.paidDate || entry.paidDate,
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
      allocations: undefined,
    }));
  });
}

function direction(entry: ReportEntry) {
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

function values(entry: ReportEntry) {
  const dir = direction(entry);
  const sign = dir === "expense" ? "-" : "";
  const eurValue = entry.currency === "EUR" ? entry.amount : entry.amountEur ?? "";
  const priceEur = eurValue !== "" && eurValue != null ? `${sign}${eurValue}` : "";
  const priceUsd = entry.currency === "USD" ? `${sign}${entry.amount}` : "";
  return [
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
  ];
}

export function formatAccountantCsv(entries: ReportEntry[]) {
  const lines = [CSV_HEADERS.map(csvCell).join(",")];
  for (const entry of entries) {
    lines.push(values(entry)
      .map((value, index) => csvCell([4, 5, 7].includes(index) ? value : spreadsheetText(value)))
      .join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

export function formatAccountantTsv(entries: ReportEntry[]) {
  const lines = [TSV_HEADERS.join("\t")];
  for (const entry of entries) {
    lines.push(values(entry)
      .map((value, index) => {
        const text = String(value ?? "").replace(/[\t\r\n]/g, " ");
        return [4, 5, 7].includes(index) ? text : spreadsheetText(text);
      })
      .join("\t"));
  }
  return lines.join("\n");
}

/**
 * The native accountant Copy/CSV formatter, also available to the generic
 * `dataops api` CLI. This is separate from the reconciliation package CSV.
 */
export async function handleBookkeepingAccountantReportRoutes(
  path: string,
  method: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse | null> {
  if (path !== "/api/bookkeeping/reports/accountant" || method !== "GET") return null;
  const period = String(event.queryStringParameters?.period || "all");
  const format = String(event.queryStringParameters?.format || "csv");
  if (!/^(all|\d{4}|\d{4}-(0[1-9]|1[0-2]))$/.test(period))
    return json(400, { error: "Invalid period" });
  if (format !== "csv" && format !== "tsv")
    return json(400, { error: "Invalid format" });

  const reportRows = accountantReportRows(await listTransactions(client)).filter((entry) =>
    period === "all" || cashDate(entry).startsWith(period),
  );
  const included = reportRows.filter((entry) => !isReportExemptTransaction(entry));
  return json(200, {
    period,
    format,
    count: included.length,
    excludedCount: reportRows.length - included.length,
    content: format === "csv" ? formatAccountantCsv(included) : formatAccountantTsv(included),
  });
}
