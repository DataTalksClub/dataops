import assert from "node:assert/strict";
import { test } from "node:test";

import { createBookkeepingTransactionModal } from "../src/surfaces/finance/bookkeeping-transaction-modal.js";
import { escapeHtml } from "../src/core/html.js";

function dialogStub() {
  const listeners = new Map();
  const suggestionHost = { innerHTML: "" };
  return {
    open: false,
    innerHTML: "",
    addEventListener: (name, listener) => listeners.set(name, listener),
    showModal() { this.open = true; },
    close() { this.open = false; listeners.get("close")?.(); },
    querySelector(selector) { return selector === "[data-suggestions]" ? suggestionHost : null; },
  };
}

test("transaction modal renders one dialog with summary, invoice state, and statement lookup", async () => {
  const dialog = dialogStub();
  const transaction = {
    id: "tx-1",
    transactionDate: "2026-09-12",
    entryType: "expense",
    counterparty: "Go Daddy",
    description: ".COM Domain Registration",
    amount: "178.49",
    currency: "EUR",
  };
  const monthCalls = [];
  const controller = createBookkeepingTransactionModal({
    dialog,
    request: async (url) => {
      monthCalls.push(url);
      return { period: url.split("/").at(-1), rows: [] };
    },
    workApiUrl: (url) => url,
    api: async () => ({ items: [] }),
    escapeHtml,
    formatAmount: (value, currency) => `${Number(value).toFixed(2)} ${currency}`,
    suggestions: { show() {}, clear() {} },
    getSelectedId: () => transaction.id,
    getEntry: () => transaction,
    getAttached: () => [],
    openDocument() {},
    refreshEvidence() {},
    safeAction: async (action) => action(),
    setStatus() {},
    onClose() {},
  });

  controller.render(transaction);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(dialog.open, true);
  assert.doesNotMatch(dialog.innerHTML, /<dialog\b/);
  assert.match(dialog.innerHTML, /GoDaddy/);
  assert.match(dialog.innerHTML, /Raw bank name/);
  assert.match(dialog.innerHTML, /Domain renewal/);
  assert.match(dialog.innerHTML, /No invoice/);
  assert.match(dialog.innerHTML, /Not matched to a statement/);
  assert.equal(monthCalls.length, 1, "the selected date window stays in September");
});
