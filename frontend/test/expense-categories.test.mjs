import assert from "node:assert/strict";
import { test } from "node:test";
import { escapeHtml } from "../src/core/html.js";
import { CANONICAL_EXPENSE_CATEGORIES } from "../src/surfaces/finance/expense-categories.js";
import { ledgerRowMarkup } from "../src/surfaces/finance/bookkeeping-ledger.js";
import { invoiceDetailMarkup } from "../src/surfaces/finance/invoices.js";

const optionValues = (markup) => [...markup.matchAll(/<option value="([^"]*)"/g)].map((match) => match[1]);

for (const category of ["Work-related", "VAT", "Owner pay", "Owner withdrawal"]) {
  test(`expense selectors never offer the out-of-SOP value ${category}`, () => {
    const row = ledgerRowMarkup({ id: "synthetic-expense", counterparty: "Synthetic vendor", entryType: "expense", category }, {
      hasEvidence: () => false, vocab: { category: [category] }, e: escapeHtml,
    });
    const categorySelect = row.match(/<select[^>]+data-inline-field="category"[\s\S]*?<\/select>/)?.[0];
    assert.ok(categorySelect);
    assert.deepEqual(optionValues(categorySelect), ["", ...CANONICAL_EXPENSE_CATEGORIES.map(escapeHtml)]);
    const invoice = invoiceDetailMarkup({ status: "pending", fields: { category }, extraction: { direction: "expense" } }, escapeHtml);
    const invoiceSelect = invoice.match(/<select name="category">[\s\S]*?<\/select>/)?.[0];
    assert.ok(invoiceSelect);
    assert.deepEqual(optionValues(invoiceSelect), ["", ...CANONICAL_EXPENSE_CATEGORIES.map(escapeHtml)]);
  });
}

test("income editors retain unrestricted categories", () => {
  const category = "Synthetic income category";
  const row = ledgerRowMarkup({ id: "synthetic-income", entryType: "income", category }, {
    hasEvidence: () => false, vocab: {}, e: escapeHtml,
  });
  const categorySelect = row.match(/<select[^>]+data-inline-field="category"[\s\S]*?<\/select>/)?.[0];
  assert.deepEqual(optionValues(categorySelect), ["", category]);
  const invoice = invoiceDetailMarkup({ status: "pending", fields: { category }, extraction: { direction: "income" } }, escapeHtml);
  assert.match(invoice, /<input name="category"[^>]+value="Synthetic income category"/);
});
