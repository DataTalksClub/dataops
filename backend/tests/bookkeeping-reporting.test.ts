import assert from "node:assert/strict";
import { test } from "node:test";
import { isReportExemptTransaction } from "../src/db/bookkeeping";
import {
  readBookkeepingReportSnapshot,
  reportSnapshotChunkSizeBytes,
  storeBookkeepingReportSnapshot,
} from "../src/db/bookkeepingReportSnapshots";
import { accountantReportRows, formatAccountantCsv } from "../src/routes/bookkeepingAccountantReport";
import { accountantSnapshotRows, formatReportSnapshotCsv } from "../src/routes/bookkeepingReports";

test("accountant CSV projects mixed allocations by child category in either parent direction", () => {
  const payments = [
    {
      id: "synthetic-parent-tax",
      transactionDate: "2026-11-02",
      paidDate: "2026-11-03",
      counterparty: "Synthetic combined payee A",
      description: "Synthetic tax settlement",
      amount: "30.00",
      amountEur: "30.00",
      currency: "EUR",
      entryType: "expense",
      category: "Taxes",
      mandatoryKind: "tax_debit",
      audit: [{ action: "synthetic-parent-only-audit", payload: "not copied into report items" }],
      allocations: [
        { id: "ordinary-a", documentId: "synthetic-doc-a", counterparty: "Synthetic software", description: "Service A", amount: "10.00", amountEur: "10.00", currency: "EUR", category: "Software" },
        { id: "exempt-a", documentId: "synthetic-doc-exempt-a", counterparty: "Synthetic tax office", description: "Tax A", amount: "20.00", amountEur: "20.00", currency: "EUR", category: "Taxes" },
      ],
    },
    {
      id: "synthetic-parent-owner",
      transactionDate: "2026-11-04",
      paidDate: "2026-11-04",
      counterparty: "Synthetic combined payee B",
      description: "Synthetic owner draw",
      amount: "70.00",
      amountEur: "70.00",
      currency: "EUR",
      entryType: "expense",
      category: "Owner pay",
      ownerPayType: "draw",
      allocations: [
        { id: "exempt-b", documentId: "synthetic-doc-exempt-b", counterparty: "Synthetic tax office", description: "Tax B", amount: "30.00", amountEur: "30.00", currency: "EUR", category: "Taxes" },
        { id: "ordinary-b", documentId: "synthetic-doc-b", counterparty: "Synthetic hosting", description: "Service B", amount: "40.00", amountEur: "40.00", currency: "EUR", category: "Software" },
      ],
    },
  ];

  assert.equal(isReportExemptTransaction(payments[0]), false,
    "a parent tax marker does not make its ordinary child exempt");
  assert.equal(isReportExemptTransaction(payments[1]), false,
    "a parent owner draw marker does not make its ordinary child exempt");
  const projected = accountantReportRows(payments);
  const included = projected.filter((entry) => !isReportExemptTransaction(entry));
  const excluded = projected.filter(isReportExemptTransaction);
  assert.deepEqual(included.map((entry) => [entry.counterparty, entry.amount, entry.category, entry.allocationDocumentId]), [
    ["Synthetic software", "10.00", "Software", "synthetic-doc-a"],
    ["Synthetic hosting", "40.00", "Software", "synthetic-doc-b"],
  ]);
  assert.deepEqual(excluded.map((entry) => [entry.counterparty, entry.amount]), [
    ["Synthetic tax office", "20.00"],
    ["Synthetic tax office", "30.00"],
  ]);
  assert.equal(included.reduce((sum, entry) => sum + Number(entry.amount), 0), 50);
  assert.equal(excluded.reduce((sum, entry) => sum + Number(entry.amount), 0), 50);
  const csv = formatAccountantCsv(included);
  for (const value of ["Synthetic software", "Synthetic hosting", "10.00", "40.00"])
    assert.ok(csv.includes(value), `CSV includes ${value}`);
  for (const value of ["Synthetic tax office", "Synthetic tax settlement", "Synthetic owner draw", "20.00", "30.00"])
    assert.ok(!csv.includes(value), `CSV excludes ${value}`);
  assert.equal((csv.match(/Synthetic software/g) || []).length, 1);
  assert.equal((csv.match(/Synthetic hosting/g) || []).length, 1);
  const packageCsv = formatReportSnapshotCsv(included);
  for (const value of ["Synthetic software", "Synthetic hosting", "10.00", "40.00"])
    assert.ok(packageCsv.includes(value), `snapshot CSV includes ${value}`);
  for (const value of ["Synthetic tax office", "Synthetic tax settlement", "Synthetic owner draw", "20.00", "30.00"])
    assert.ok(!packageCsv.includes(value), `snapshot CSV excludes ${value}`);
  const snapshotRows = accountantSnapshotRows(included);
  assert.equal(snapshotRows.some((row) => "audit" in row || "allocations" in row), false,
    "snapshot rows contain accountant fields rather than repeated parent history");
});

test("large monthly report snapshots are stored and verified as DynamoDB-safe chunks", async () => {
  const payload = {
    transactionIds: Array.from({ length: 600 }, (_, index) => `synthetic-transaction-${index}`),
    transactionRows: Array.from({ length: 600 }, (_, index) => ({
      counterparty: `Synthetic vendor ${index}`,
      description: `Synthetic description ${index} ${"x".repeat(900)}`,
      amount: "1.00",
    })),
    documentIds: ["synthetic-statement-a", "synthetic-statement-b"],
    reconciliation: { transactionCount: 600, documentCount: 2 },
  };
  const items: Array<Record<string, unknown>> = [];
  const fakeClient = {
    send: async (command: any) => {
      if (command.constructor.name === "PutCommand") {
        items.push(command.input.Item);
        return {};
      }
      if (command.constructor.name === "QueryCommand") {
        return { Items: items.filter((item) => item.PK === command.input.ExpressionAttributeValues[":pk"]) };
      }
      throw new Error(`Unexpected snapshot storage command: ${command.constructor.name}`);
    },
  } as any;

  const stored = await storeBookkeepingReportSnapshot(fakeClient, "synthetic-large-report", payload);
  assert.ok(stored.snapshotByteSize > 350 * 1024);
  assert.ok(stored.snapshotChunkCount > 1);
  assert.equal(items.length, stored.snapshotChunkCount);
  assert.ok(items.every((item) => reportSnapshotChunkSizeBytes(item) < 350 * 1024));
  assert.deepEqual(
    await readBookkeepingReportSnapshot(fakeClient, "synthetic-large-report", stored),
    payload,
  );
});
