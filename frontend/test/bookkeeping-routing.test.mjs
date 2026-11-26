import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ledgerClickAction,
  readBookkeepingRoute,
  writeBookkeepingRoute,
} from "../src/surfaces/finance/bookkeeping-ledger.js";

// Minimal DOM stub: tag + dataset + parent chain with a closest() that
// covers the selectors the ledger delegation uses.
function node(tag, dataset = {}, parent = null) {
  const element = {
    tag: String(tag).toLowerCase(),
    dataset,
    parent,
    closest(selector) {
      let current = element;
      const parts = String(selector).split(",").map((part) => part.trim());
      while (current) {
        if (parts.some((part) => matchesPart(current, part))) return current;
        current = current.parent;
      }
      return null;
    },
  };
  return element;
}

function matchesPart(element, part) {
  const tagMatch = part.match(/^([a-z]+)?(\[data-([a-z-]+)\])?$/);
  if (!tagMatch) return false;
  const [, tag, , attribute] = tagMatch;
  if (tag && element.tag !== tag) return false;
  if (attribute) {
    const key = attribute.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (element.dataset?.[key] === undefined) return false;
  }
  return true;
}

test("the route keeps the list context next to the open item", () => {
  const route = readBookkeepingRoute("?month=2026-11&q=veselka&dir=expense&tx=abc&view=&invoice=");
  assert.equal(route.lens, "2026-11");
  assert.equal(route.filters.q, "veselka");
  assert.equal(route.filters.dir, "expense");
  assert.equal(route.tx, "abc");
  assert.equal(route.view, "");
  assert.equal(route.invoice, "");

  const query = writeBookkeepingRoute({
    lens: "2026-11", defaultLens: "2026-11", filters: route.filters, tx: "abc", view: "", invoice: "",
  });
  assert.equal(query, "?q=veselka&dir=expense&tx=abc");

  const invoiceQuery = writeBookkeepingRoute({
    lens: "2026-11", defaultLens: "2026-10", filters: { q: "", account: "", dir: "", category: "" },
    tx: "", view: "invoices", invoice: "draft-1",
  });
  assert.equal(invoiceQuery, "?month=2026-11&view=invoices&invoice=draft-1");

  // The invoice id never travels without the invoice review.
  const dropped = writeBookkeepingRoute({
    lens: "2026-11", defaultLens: "2026-10", filters: { q: "", account: "", dir: "", category: "" },
    tx: "", view: "", invoice: "draft-1",
  });
  assert.equal(dropped, "?month=2026-11");

  assert.equal(readBookkeepingRoute("?view=bogus").view, "");
  assert.equal(readBookkeepingRoute("?month=all").lens, "all");
  assert.equal(readBookkeepingRoute("?month=november").lens, "");
});

test("clicking any line item opens that item, never the full invoice list", () => {
  const postedRow = node("tr", { tx: "tx-1" });
  const whoCell = node("td", {}, postedRow);
  const whoLink = node("a", { openTx: "tx-1" }, whoCell);
  assert.deepEqual(ledgerClickAction(node("span", {}, whoLink)), { action: "transaction", id: "tx-1" });

  const multiRow = node("tr", { tx: "tx-2" });
  const iconButton = node("button", { openTx: "tx-2" }, node("td", {}, multiRow));
  assert.deepEqual(ledgerClickAction(iconButton), { action: "transaction", id: "tx-2" });

  // Allocation children carry no data-tx row: the payment link must still
  // open the parent transaction instead of navigating away.
  const allocationRow = node("tr", { allocationParent: "tx-3" });
  const paymentLink = node("a", { openTx: "tx-3" }, node("td", {}, allocationRow));
  assert.deepEqual(ledgerClickAction(node("span", {}, paymentLink)), { action: "transaction", id: "tx-3" });

  // A pending draft row opens that draft for review from any cell.
  const draftRow = node("tr", { pendingInvoice: "draft-9" });
  assert.deepEqual(ledgerClickAction(node("td", {}, draftRow)), { action: "invoice", id: "draft-9" });
  const draftLink = node("a", { openInvoiceReview: "draft-9" }, node("td", {}, draftRow));
  assert.deepEqual(ledgerClickAction(draftLink), { action: "invoice", id: "draft-9" });

  // A posted row still opens its own dialog.
  assert.deepEqual(ledgerClickAction(node("td", {}, node("tr", { tx: "tx-4" }))), { action: "transaction", id: "tx-4" });

  const docButton = node("button", { viewDocument: "doc-1" }, node("td", {}, postedRow));
  assert.deepEqual(ledgerClickAction(docButton), { action: "document", id: "doc-1" });
});

test("form controls, deal links and empty space keep their own behavior", () => {
  const row = node("tr", { tx: "tx-7" });
  const cell = node("td", {}, row);
  assert.equal(ledgerClickAction(node("select", { inlineField: "category", id: "tx-7" }, cell)), null);
  assert.equal(ledgerClickAction(node("button", {}, cell)), null);
  assert.equal(ledgerClickAction(node("input", {}, cell)), null);
  assert.equal(ledgerClickAction(node("a", { dealLink: "" }, cell)), null);

  const clearer = node("button", { clearFilters: "" });
  assert.deepEqual(ledgerClickAction(clearer), { action: "clear-filters" });

  assert.equal(ledgerClickAction(node("td", {}, node("tbody", {}, node("table")))), null);
  assert.equal(ledgerClickAction(null), null);
});
