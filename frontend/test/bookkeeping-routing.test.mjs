import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createBookkeepingRouter,
  ledgerClickAction,
  markSelectedLedgerRow,
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

test("the open row is highlighted in the rendered table", () => {
  const seen = [];
  const ledger = {
    querySelectorAll: () => [{
      dataset: { tx: "tx-1" },
      setAttribute: (name, value) => seen.push(["tx-1", name, value]),
      removeAttribute: (name) => seen.push(["tx-1", `no-${name}`]),
    }, {
      dataset: { tx: "tx-2" },
      setAttribute: (name, value) => seen.push(["tx-2", name, value]),
      removeAttribute: (name) => seen.push(["tx-2", `no-${name}`]),
    }],
  };
  markSelectedLedgerRow(ledger, "tx-2");
  assert.deepEqual(seen, [["tx-1", "no-aria-selected"], ["tx-2", "aria-selected", "true"]]);
});

test("opening an item pushes history; Back restores the list context", () => {
  const pushes = [], replaces = [];
  const locationRef = { pathname: "/bookkeeping", search: "" };
  const historyRef = {
    state: null,
    pushState: (_state, _title, url) => { pushes.push(url); locationRef.search = url.slice("/bookkeeping".length); },
    replaceState: (_state, _title, url) => { replaces.push(url); locationRef.search = url.slice("/bookkeeping".length); },
  };
  const listeners = new Map();
  const originalAddEventListener = globalThis.addEventListener;
  globalThis.addEventListener = (name, listener) => listeners.set(name, listener);
  const entries = [{ id: "tx-1" }, { id: "tx-2" }];
  let rendered = 0, opened = null, closed = 0, drafted = null;
  const state = { lens: "2026-11", defaultLens: "2026-11", filters: { q: "", account: "", dir: "", category: "" },
    tx: "", view: "", invoice: "" };
  try {
    const router = createBookkeepingRouter({
      locationRef,
      historyRef,
      getRoute: () => ({ ...state }),
      setRoute: (route) => {
        state.lens = route.lens || state.defaultLens;
        state.filters = route.filters;
        state.view = route.view;
        state.invoice = route.invoice;
        state.tx = route.tx;
      },
      render: () => { rendered += 1; },
      findEntry: (id) => entries.find((entry) => entry.id === id) || null,
      openEntry: (entry) => { opened = entry.id; },
      closeEntry: () => { closed += 1; state.tx = ""; },
      openDraft: (invoiceId) => { drafted = invoiceId; },
    });
    // Opening a transaction pushes ?tx= next to the list context.
    state.tx = "tx-1";
    router.sync({ push: true });
    assert.deepEqual(pushes, ["/bookkeeping?tx=tx-1"]);
    assert.deepEqual(replaces, []);

    // Browser Back drops ?tx= and closes the item on the same list.
    locationRef.search = "";
    listeners.get("popstate")();
    assert.equal(state.tx, "");
    assert.equal(state.view, "");
    assert.equal(opened, null);
    assert.equal(closed, 1);
    assert.equal(rendered, 1);
    // The URL already matches, so no redundant history write happens.
    assert.deepEqual(replaces, []);

    // Back to an invoice draft reopens that draft, not the full list.
    locationRef.search = "?view=invoices&invoice=draft-9";
    listeners.get("popstate")();
    assert.equal(state.view, "invoices");
    assert.equal(drafted, "draft-9");
    assert.equal(rendered, 2);

    // Filter keystrokes replace in place instead of pushing.
    state.filters = { q: "veselka", account: "", dir: "", category: "" };
    router.sync();
    assert.deepEqual(pushes, ["/bookkeeping?tx=tx-1"]);
    assert.ok(replaces.at(-1).includes("q=veselka"));
  } finally {
    globalThis.addEventListener = originalAddEventListener;
  }
});

test("Back to the forwarded-invoice list with no open draft leaves the list on its own", () => {
  const locationRef = { pathname: "/bookkeeping", search: "" };
  const historyRef = {
    state: null,
    pushState: () => {},
    replaceState: () => {},
  };
  const listeners = new Map();
  const originalAddEventListener = globalThis.addEventListener;
  globalThis.addEventListener = (name, listener) => listeners.set(name, listener);
  const drafted = [];
  try {
    createBookkeepingRouter({
      locationRef,
      historyRef,
      getRoute: () => ({ lens: "", defaultLens: "", filters: { q: "", account: "", dir: "", category: "" }, tx: "", view: "", invoice: "" }),
      setRoute: () => {},
      render: () => {},
      findEntry: () => null,
      openEntry: () => {},
      closeEntry: () => {},
      // An empty id is how the surface closes a draft left open by an
      // earlier visit.
      openDraft: (invoiceId) => { drafted.push(invoiceId); },
    });
    locationRef.search = "?view=invoices&invoice=draft-9";
    listeners.get("popstate")();
    locationRef.search = "?view=invoices";
    listeners.get("popstate")();
    assert.deepEqual(drafted, ["draft-9", ""]);
  } finally {
    globalThis.addEventListener = originalAddEventListener;
  }
});
