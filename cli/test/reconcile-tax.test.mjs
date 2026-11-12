import assert from "node:assert/strict";
import { test } from "node:test";
import { month } from "../src/commands/reconcile.mjs";

test("month output places tax and health insurance rows in a separate final section", async () => {
  const oldFetch = globalThis.fetch;
  const oldToken = process.env.DATAOPS_TOKEN;
  process.env.DATAOPS_TOKEN = "synthetic-test-token";
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/api\/reconcile\/months\/2026-10$/);
    return new Response(JSON.stringify({
      period: "2026-10", state: "open", blockers: 1,
      counters: { rows: 1, matched: 0, bankWithoutInvoice: 1, ledgerWithoutBank: 0, amountMismatch: 0, needsReview: 0, exceptions: 0 },
      statements: [], rows: [
        { id: "ordinary", date: "2026-10-02", status: "no-invoice", amount: "-20.00", currency: "EUR", counterparty: "Vendor", documents: [], missing: "no ledger row" },
        { id: "tax-refund", date: "2026-10-03", status: "matched", tax: true, amount: "1234.56", currency: "EUR", counterparty: "Finanzamt Example", documents: [], exception: { kind: "tax_refund", proof: "category", satisfied: true } },
      ],
    }));
  };
  try {
    const io = { lines: [], print(line) { this.lines.push(String(line)); } };
    await month({ url: "https://portal.example.test", token: "synthetic-test-token", json: false, _: ["2026-10"] }, io);
    const ordinaryIndex = io.lines.findIndex((line) => line.includes("row ordinary"));
    const sectionIndex = io.lines.findIndex((line) => line.includes("Taxes and health insurance"));
    const taxIndex = io.lines.findIndex((line) => line.includes("row tax-refund"));
    assert.ok(ordinaryIndex >= 0);
    assert.ok(sectionIndex > ordinaryIndex, io.lines.join("\n"));
    assert.ok(taxIndex > sectionIndex);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldToken === undefined) delete process.env.DATAOPS_TOKEN; else process.env.DATAOPS_TOKEN = oldToken;
  }
});
