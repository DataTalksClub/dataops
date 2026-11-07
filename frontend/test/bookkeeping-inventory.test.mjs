import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeHtml } from "../src/core/html.js";
import { createBookkeepingInventory } from "../src/surfaces/finance/bookkeeping-inventory.js";

function fakeHost() {
  const listeners = new Map();
  return {
    listeners,
    innerHTML: "",
    addEventListener(name, handler) { listeners.set(name, handler); },
  };
}

const node = (dataset, row) => ({ dataset, closest: (probe) => (row && probe === "[data-inv]" ? row : null) });

const laptop = {
  id: "inv-laptop", transactionId: "tx-1", name: "Laptop", type: "computer",
  vendor: "Amazon", acquisitionDate: "2026-03-19", amount: "1813.58",
  currency: "EUR", amountEur: "1813.58", status: "in-use",
  source: {
    transactionId: "tx-1", description: "MacBook Pro 14", counterparty: "Amazon",
    date: "2026-03-19", amount: "1813.58", currency: "EUR", amountEur: "1813.58",
  },
};
const headset = {
  id: "inv-headset", transactionId: "tx-2", name: "Stereo Headset", type: "audio",
  vendor: "Amazon", acquisitionDate: "2025-06-18", amount: "35.40",
  currency: "EUR", amountEur: "35.40", status: "disposed", disposedDate: "2026-09-01",
  disposals: [{ id: "d-1", kind: "sold", date: "2026-09-01", proceeds: "20.00", currency: "EUR", notes: "eBay" }],
};

function mount({ inventoryPages, putResponses = [], deletes = [] } = {}) {
  const host = fakeHost();
  const scanButton = { disabled: false, addEventListener(name, handler) { host.listeners.set(`scan:${name}`, handler); } };
  const surface = {
    querySelector: (selector) =>
      selector === "[data-inventory]" ? host
        : selector === "[data-inventory-scan]" ? scanButton
          : null,
  };
  const status = [];
  const calls = [];
  const opened = [];
  let page = 0;
  const api = async (path, options = {}) => {
    calls.push([path, options.method || "GET", options.body ? JSON.parse(options.body) : undefined]);
    if (path === "/inventory") return { items: inventoryPages[Math.min(page++, inventoryPages.length - 1)] };
    if (path.startsWith("/inventory/") && options.method === "PUT") return putResponses.shift() ?? { ...laptop, ...JSON.parse(options.body) };
    if (path.startsWith("/inventory/") && options.method === "DELETE") { deletes.push(path); return undefined; }
    if (path === "/inventory/import") return { dryRun: false, matched: 1, created: 1, items: [laptop] };
    throw new Error(`unexpected ${options.method || "GET"} ${path}`);
  };
  const errors = [];
  const safeAction = async (action, fallback) => {
    try { await action(); } catch (error) { errors.push(`${fallback}: ${error.message}`); }
  };
  const view = createBookkeepingInventory({
    surface, api, escapeHtml, safeAction,
    setStatus: (text) => status.push(text),
    todayIsoDate: () => "2037-03-15",
    openTransaction: (id) => opened.push(id),
  });
  // A click on a node whose closest() answers every probed selector.
  const click = (probes) =>
    host.listeners.get("click")({ target: { closest: (probe) => probes[probe] ?? null } });
  const change = (dataset, value) =>
    host.listeners.get("change")({ target: {
      closest: (probe) => (probe === "[data-inv-disposal]" ? { dataset, value } : null),
    } });
  const type = (dataset, value) =>
    host.listeners.get("input")({ target: {
      closest: (probe) => (probe === "[data-inv-disposal]" ? { dataset, value } : null),
    } });
  return { view, host, calls, status, errors, opened, click, change, type, scanClick: () => host.listeners.get("scan:click")() };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("loads the inventory and renders items with the in-use total", async () => {
  const { view, host } = mount({ inventoryPages: [[laptop, headset]] });
  await view.renderInventory();
  assert.match(host.innerHTML, /Laptop/);
  assert.match(host.innerHTML, /Stereo Headset/);
  assert.match(host.innerHTML, /2 items/);
  assert.match(host.innerHTML, /in use: €1,813\.58/);
  assert.match(host.innerHTML, /is-disposed/);
});

test("an empty inventory explains how to fill it", async () => {
  const { view, host } = mount({ inventoryPages: [[]] });
  await view.renderInventory();
  assert.match(host.innerHTML, /No inventory yet/);
  assert.match(host.innerHTML, /Scan the ledger/);
});

test("scan applies the import, reports the outcome and reloads", async () => {
  const { view, host, calls, status, scanClick } = mount({ inventoryPages: [[], [laptop]] });
  await view.renderInventory();
  scanClick();
  await flush();
  assert.deepEqual(calls[1], ["/inventory/import", "POST", { apply: true }]);
  assert.match(status.at(-1), /Added 1 item from the ledger\./);
  assert.match(host.innerHTML, /Laptop/);
});

test("each item links back to the ledger record it came from", async () => {
  const { view, host, opened, click } = mount({ inventoryPages: [[laptop]] });
  await view.renderInventory();
  assert.match(host.innerHTML, /↳ ledger: MacBook Pro 14/);
  click({ "[data-inv-source]": node({ invSource: "tx-1" }) });
  assert.deepEqual(opened, ["tx-1"]);
});

test("recording a sale sends a disposal with proceeds and derives the disposed status", async () => {
  const { view, host, calls, status, click, type } = mount({
    inventoryPages: [[laptop]],
    putResponses: [{ ...laptop, status: "disposed", disposedDate: "2037-03-15",
      disposals: [{ id: "d-9", kind: "sold", date: "2037-03-15", proceeds: "250", currency: "EUR" }] }],
  });
  await view.renderInventory();
  click({ "[data-inv-dispose]": node({ invDispose: laptop.id }) });
  assert.match(host.innerHTML, /bk-inv-dispose/);
  type({ invDisposal: "proceeds" }, "250");
  click({ "[data-inv-disposal-save]": node({}) });
  await flush();
  assert.deepEqual(calls.at(-1), [`/inventory/${laptop.id}`, "PUT", {
    disposal: { kind: "sold", date: "2037-03-15", proceeds: "250" },
  }]);
  assert.match(status.at(-1), /Recorded the sale\./);
  // The saved item renders as disposed with its record listed.
  assert.match(host.innerHTML, /disposed · 2037-03-15/);
  assert.match(host.innerHTML, /<strong>sold<\/strong> 2037-03-15/);
  assert.match(host.innerHTML, /proceeds/);
});

test("a decommission form has no proceeds field and sends the decommissioned kind", async () => {
  const { view, host, calls, click, change } = mount({
    inventoryPages: [[laptop]],
    putResponses: [{ ...laptop, status: "disposed", disposedDate: "2037-03-15",
      disposals: [{ id: "d-8", kind: "decommissioned", date: "2037-03-15" }] }],
  });
  await view.renderInventory();
  click({ "[data-inv-dispose]": node({ invDispose: laptop.id }) });
  assert.match(host.innerHTML, /Proceeds/);
  change({ invDisposal: "kind" }, "decommissioned");
  assert.doesNotMatch(host.innerHTML, /Proceeds/);
  click({ "[data-inv-disposal-save]": node({}) });
  await flush();
  assert.deepEqual(calls.at(-1), [`/inventory/${laptop.id}`, "PUT", {
    disposal: { kind: "decommissioned", date: "2037-03-15" },
  }]);
});

test("cancel closes the dispose form without writing", async () => {
  const { view, calls, click } = mount({ inventoryPages: [[laptop]] });
  await view.renderInventory();
  click({ "[data-inv-dispose]": node({ invDispose: laptop.id }) });
  click({ "[data-inv-disposal-cancel]": node({}) });
  assert.deepEqual(calls.filter(([, method]) => method === "PUT"), []);
});

test("a sale without a date is rejected before any request", async () => {
  const { view, status, calls, click, type } = mount({ inventoryPages: [[laptop]] });
  await view.renderInventory();
  click({ "[data-inv-dispose]": node({ invDispose: laptop.id }) });
  type({ invDisposal: "date" }, "");
  click({ "[data-inv-disposal-save]": node({}) });
  await flush();
  assert.match(status.at(-1), /Pick a disposal date\./);
  assert.deepEqual(calls.filter(([, method]) => method === "PUT"), []);
});

test("removing the last disposal record puts the item back in use", async () => {
  const { view, host, calls, click } = mount({
    inventoryPages: [[headset]],
    putResponses: [{ ...headset, status: "in-use", disposedDate: undefined, disposals: [] }],
  });
  await view.renderInventory();
  assert.match(host.innerHTML, /<strong>sold<\/strong> 2026-09-01/);
  assert.match(host.innerHTML, /proceeds/);
  click({
    "[data-inv-disposal-remove]": node({ invDisposalRemove: "d-1" }, node({ inv: headset.id })),
  });
  await flush();
  assert.deepEqual(calls.at(-1), [`/inventory/${headset.id}`, "PUT", { removeDisposalId: "d-1" }]);
});

test("removal confirms first and drops the row", async () => {
  const { view, host, calls, click } = mount({ inventoryPages: [[laptop]] });
  const originalConfirm = globalThis.confirm;
  globalThis.confirm = () => true;
  try {
    await view.renderInventory();
    click({ "[data-inv-remove]": node({ invRemove: laptop.id }) });
    await flush();
    assert.deepEqual(calls.at(-1), [`/inventory/${laptop.id}`, "DELETE", undefined]);
    assert.doesNotMatch(host.innerHTML, /Laptop/);
  } finally {
    globalThis.confirm = originalConfirm;
  }
});

test("declined confirmation leaves the row in place", async () => {
  const { view, host, calls, click } = mount({ inventoryPages: [[laptop]] });
  const originalConfirm = globalThis.confirm;
  globalThis.confirm = () => false;
  try {
    await view.renderInventory();
    click({ "[data-inv-remove]": node({ invRemove: laptop.id }) });
    await flush();
    assert.deepEqual(calls.filter(([, method]) => method === "DELETE"), []);
    assert.match(host.innerHTML, /Laptop/);
  } finally {
    globalThis.confirm = originalConfirm;
  }
});
