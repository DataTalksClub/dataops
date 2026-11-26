import assert from "node:assert/strict";
import { test } from "node:test";
import { isReportExemptTransaction } from "../src/db/bookkeeping";
import { accountantReportRows, formatAccountantCsv } from "../src/routes/bookkeepingAccountantReport";

const alloc = (id: string, documentId: string, counterparty: string, description: string, amount: string, category: string) =>
  ({ id, documentId, counterparty, description, amount, amountEur: amount, currency: "EUR", category });

test("mixed allocations are classified per child regardless of parent markers", () => {
  const payments = [
    { id: "synthetic-parent-tax", transactionDate: "2026-11-02", paidDate: "2026-11-03", counterparty: "Synthetic combined payee A",
      description: "Synthetic tax settlement", amount: "30.00", amountEur: "30.00", currency: "EUR", entryType: "expense",
      category: "Taxes", mandatoryKind: "tax_debit", kind: "tax_debit",
      allocations: [alloc("a1", "doc-a", "Synthetic software", "Service A", "10.00", "Software"),
        alloc("a2", "doc-x-a", "Synthetic tax office", "Tax A", "20.00", "Taxes")] },
    { id: "synthetic-parent-owner", transactionDate: "2026-11-04", paidDate: "2026-11-04", counterparty: "Synthetic combined payee B",
      description: "Synthetic owner draw", amount: "70.00", amountEur: "70.00", currency: "EUR", entryType: "expense",
      category: "Owner pay", ownerPayType: "draw",
      allocations: [alloc("b1", "doc-x-b", "Synthetic tax office", "Tax B", "30.00", "Taxes"),
        alloc("b2", "doc-b", "Synthetic hosting", "Service B", "40.00", "Software")] },
    { id: "synthetic-all-exempt", transactionDate: "2026-11-05", counterparty: "Synthetic payee C", description: "Tax C",
      amount: "5.00", amountEur: "5.00", currency: "EUR", entryType: "expense", category: "Software",
      allocations: [alloc("c1", "doc-c", "Synthetic tax office", "Tax C", "5.00", "Taxes")] },
  ];
  assert.equal(isReportExemptTransaction(payments[0]), false);
  assert.equal(isReportExemptTransaction(payments[1]), false);
  assert.equal(isReportExemptTransaction(payments[2]), true);
  const rows = accountantReportRows(payments);
  assert.ok(rows.every((row) => row.id === (row.sourceTransactionId as string)), "child keeps parent id for omit lookups");
  const included = rows.filter((row) => !isReportExemptTransaction(row));
  assert.deepEqual(included.map((r) => [r.counterparty, r.amount, r.category, r.allocationDocumentId]), [
    ["Synthetic software", "10.00", "Software", "doc-a"], ["Synthetic hosting", "40.00", "Software", "doc-b"]]);
  const csv = formatAccountantCsv(included);
  assert.ok(csv.includes("Synthetic software") && csv.includes("Synthetic hosting"));
  assert.ok(!csv.includes("Synthetic tax office") && !csv.includes("20.00") && !csv.includes("30.00"));
});
