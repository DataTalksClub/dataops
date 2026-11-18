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

const row = (id) => ({ dataset: { inv: id }, closest: (probe) => (probe === "[data-inv]" ? { dataset: { inv: id } } : null) });

const laptop = {
  id: "inv-laptop", transactionId: "tx-1", name: "Laptop", type: "computer",
  vendor: "Amazon", acquisitionDate: "2026-03-19", amount: "1813.58",
  currency: "EUR", amountEur: "1813.58", status: "in-use", usage: "active",
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

function mount({ inventoryPages, putResponses = [] } = {}) {
  const host = fakeHost();
  const surface = {
    querySelector: (selector) => (selector === "[data-inventory]" ? host : null),
  };
  const status = [];
  const calls = [];
  const opened = [];
  let page = 0;
  const api = async (path, options = {}) => {
    calls.push([path, options.method || "GET", options.body ? JSON.parse(options.body) : undefined]);
    if (path === "/inventory") return { items: inventoryPages[Math.min(page++, inventoryPages.length - 1)] };
    if (path.startsWith("/inventory/") && options.method === "PUT") return putResponses.shift() ?? { ...laptop, ...JSON.parse(options.body) };
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
  // A target whose closest() answers every probed selector from one map.
  const dispatch = (name, probes, extra = {}) =>
    host.listeners.get(name)({ target: { closest: (probe) => probes[probe] ?? null, ...extra } });
  const click = (probes) => dispatch("click", probes);
  const probe = (selector, value) => ({ [selector]: { dataset: {}, value } });
  const change = (selector, dataset, value, rowId) => dispatch("change", {
    "[data-inv-year]": null,
    [selector]: { dataset, value, closest: (p) => (p === "[data-inv]" && rowId ? row(rowId) : null) },
  });
  const type = (selector, dataset, value) => dispatch("input", { [selector]: { dataset, value } });
  return { view, host, calls, status, errors, opened, click, change, type, probe };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("loads the inventory and renders items with the on-balance total", async () => {
  const { view, host } = mount({ inventoryPages: [[laptop, headset]] });
  await view.renderInventory();
  assert.match(host.innerHTML, /Laptop/);
  assert.match(host.innerHTML, /Stereo Headset/);
  assert.match(host.innerHTML, /2 items/);
  assert.match(host.innerHTML, /on balance: €1,813\.58/);
  assert.match(host.innerHTML, /is-disposed/);
});

test("an empty inventory explains that purchases land automatically", async () => {
  const { view, host } = mount({ inventoryPages: [[]] });
  await view.renderInventory();
  assert.match(host.innerHTML, /No inventory yet/);
  assert.match(host.innerHTML, /land here automatically/);
});

test("the table has no per-row removal affordance", async () => {
  const { view, host } = mount({ inventoryPages: [[laptop]] });
  await view.renderInventory();
  assert.doesNotMatch(host.innerHTML, /data-inv-remove/);
  assert.doesNotMatch(host.innerHTML, /bk-inv-remove/);
});

test("each item links back to the invoice it came from", async () => {
  const { view, host, opened, click } = mount({ inventoryPages: [[laptop]] });
  await view.renderInventory();
  assert.match(host.innerHTML, /↳ invoice: MacBook Pro 14/);
  click({ "[data-inv-source]": { dataset: { invSource: "tx-1" } } });
  assert.deepEqual(opened, ["tx-1"]);
});

test("recording a sale sends a disposal with proceeds and derives the disposed status", async () => {
  const { view, host, calls, status, click, type } = mount({
    inventoryPages: [[laptop]],
    putResponses: [{ ...laptop, status: "disposed", disposedDate: "2037-03-15",
      disposals: [{ id: "d-9", kind: "sold", date: "2037-03-15", proceeds: "250", currency: "EUR" }] }],
  });
  await view.renderInventory();
  click({ "[data-inv-dispose]": { dataset: { invDispose: laptop.id, invKind: "sold" } } });
  assert.match(host.innerHTML, /bk-inv-dispose/);
  type("[data-inv-disposal]", { invDisposal: "proceeds" }, "250");
  click({ "[data-inv-disposal-save]": { dataset: {} } });
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

test("recording a return needs no proceeds and sends the returned kind", async () => {
  const { view, host, calls, status, click } = mount({
    inventoryPages: [[laptop]],
    putResponses: [{ ...laptop, status: "returned", returnedDate: "2037-03-15",
      disposals: [{ id: "d-7", kind: "returned", date: "2037-03-15" }] }],
  });
  await view.renderInventory();
  click({ "[data-inv-dispose]": { dataset: { invDispose: laptop.id, invKind: "returned" } } });
  assert.match(host.innerHTML, /value="returned"/);
  assert.doesNotMatch(host.innerHTML, /Proceeds/);
  click({ "[data-inv-disposal-save]": { dataset: {} } });
  await flush();
  assert.deepEqual(calls.at(-1), [`/inventory/${laptop.id}`, "PUT", {
    disposal: { kind: "returned", date: "2037-03-15" },
  }]);
  assert.match(status.at(-1), /Recorded the return\./);
  assert.match(host.innerHTML, /returned · 2037-03-15/);
});

test("a decommission form has no proceeds field and sends the decommissioned kind", async () => {
  const { view, host, calls, click, change } = mount({
    inventoryPages: [[laptop]],
    putResponses: [{ ...laptop, status: "disposed", disposedDate: "2037-03-15",
      disposals: [{ id: "d-8", kind: "decommissioned", date: "2037-03-15" }] }],
  });
  await view.renderInventory();
  click({ "[data-inv-dispose]": { dataset: { invDispose: laptop.id, invKind: "sold" } } });
  assert.match(host.innerHTML, /Proceeds/);
  change("[data-inv-disposal]", { invDisposal: "kind" }, "decommissioned");
  assert.doesNotMatch(host.innerHTML, /Proceeds/);
  click({ "[data-inv-disposal-save]": { dataset: {} } });
  await flush();
  assert.deepEqual(calls.at(-1), [`/inventory/${laptop.id}`, "PUT", {
    disposal: { kind: "decommissioned", date: "2037-03-15" },
  }]);
});

test("cancel closes the exit form without writing", async () => {
  const { view, calls, click } = mount({ inventoryPages: [[laptop]] });
  await view.renderInventory();
  click({ "[data-inv-dispose]": { dataset: { invDispose: laptop.id, invKind: "sold" } } });
  click({ "[data-inv-disposal-cancel]": { dataset: {} } });
  assert.deepEqual(calls.filter(([, method]) => method === "PUT"), []);
});

test("an exit without a date is rejected before any request", async () => {
  const { view, status, calls, click, type } = mount({ inventoryPages: [[laptop]] });
  await view.renderInventory();
  click({ "[data-inv-dispose]": { dataset: { invDispose: laptop.id, invKind: "sold" } } });
  type("[data-inv-disposal]", { invDisposal: "date" }, "");
  click({ "[data-inv-disposal-save]": { dataset: {} } });
  await flush();
  assert.match(status.at(-1), /Pick a date/);
  assert.deepEqual(calls.filter(([, method]) => method === "PUT"), []);
});

test("the usage select records whether an item is actively used", async () => {
  const { view, calls, change } = mount({ inventoryPages: [[laptop]] });
  await view.renderInventory();
  change("[data-inv-field]", { invField: "usage" }, "idle", laptop.id);
  await flush();
  assert.deepEqual(calls.at(-1), [`/inventory/${laptop.id}`, "PUT", { usage: "idle" }]);
});

test("removing the last exit record puts the item back on balance", async () => {
  const { view, host, calls, click } = mount({
    inventoryPages: [[headset]],
    putResponses: [{ ...headset, status: "in-use", disposedDate: undefined, disposals: [] }],
  });
  await view.renderInventory();
  assert.match(host.innerHTML, /<strong>sold<\/strong> 2026-09-01/);
  assert.match(host.innerHTML, /proceeds/);
  click({
    "[data-inv-disposal-remove]": { dataset: { invDisposalRemove: "d-1" }, closest: (p) => (p === "[data-inv]" ? row(headset.id) : null) },
  });
  await flush();
  assert.deepEqual(calls.at(-1), [`/inventory/${headset.id}`, "PUT", { removeDisposalId: "d-1" }]);
});

test("a picture is attached by link, shown as a thumbnail, and removable", async () => {
  const { view, host, calls, status, click, type } = mount({
    inventoryPages: [
      [laptop],
      [{ ...laptop, images: [{ url: "https://m.media-amazon.com/images/front.jpg", caption: "front" }] }],
      [{ ...laptop, images: [{ url: "https://m.media-amazon.com/images/front.jpg", caption: "front" }, { url: "https://example.com/back.jpg" }] }],
      [{ ...laptop, images: [{ url: "https://example.com/back.jpg" }] }],
    ],
  });
  await view.renderInventory();
  click({ "[data-inv-image-add]": { dataset: { invImageAdd: laptop.id } } });
  assert.match(host.innerHTML, /bk-inv-image-form/);
  // A malformed link is rejected before any request.
  type("[data-inv-image]", { invImage: "url" }, "not-a-url");
  click({ "[data-inv-image-save]": { dataset: {} } });
  await flush();
  assert.match(status.at(-1), /picture link/);
  assert.deepEqual(calls.filter(([, method]) => method === "PUT"), []);

  type("[data-inv-image]", { invImage: "url" }, "https://m.media-amazon.com/images/front.jpg");
  type("[data-inv-image]", { invImage: "caption" }, "front");
  click({ "[data-inv-image-save]": { dataset: {} } });
  await flush();
  assert.deepEqual(calls.at(-1), [`/inventory/${laptop.id}`, "PUT", {
    addImage: { url: "https://m.media-amazon.com/images/front.jpg", caption: "front" },
  }]);
  assert.match(status.at(-1), /Picture attached\./);
  await view.renderInventory();
  assert.match(host.innerHTML, /bk-inv-thumb/);
  assert.match(host.innerHTML, /front/);

  await view.renderInventory();
  click({ "[data-inv-image-remove]": { dataset: { invImageRemove: "https://m.media-amazon.com/images/front.jpg" }, closest: (p) => (p === "[data-inv]" ? row(laptop.id) : null) } });
  await flush();
  assert.deepEqual(calls.at(-1), [`/inventory/${laptop.id}`, "PUT", { removeImageUrl: "https://m.media-amazon.com/images/front.jpg" }]);
  assert.match(status.at(-1), /Picture removed\./);
});

test("clicking the record opens the invoice it came from", async () => {
  const { view, click, opened } = mount({ inventoryPages: [[laptop]] });
  await view.renderInventory();
  click({ "[data-inv]": { dataset: { inv: laptop.id } } });
  assert.deepEqual(opened, [laptop.source.transactionId]);
});

test("clicks inside the note or type controls never open the invoice", async () => {
  const { view, click, opened } = mount({ inventoryPages: [[laptop]] });
  await view.renderInventory();
  click({ "input, select, button, a": { dataset: {} } });
  assert.deepEqual(opened, []);
});

test("a record without an invoice source is not clickable", async () => {
  const orphan = { ...laptop, id: "inv-orphan", source: undefined };
  const { view, host, click, opened } = mount({ inventoryPages: [[laptop, orphan]] });
  await view.renderInventory();
  assert.doesNotMatch(host.innerHTML, /is-openable[^>]*data-inv="inv-orphan"/);
  click({ "[data-inv]": { dataset: { inv: "inv-orphan" } } });
  assert.deepEqual(opened, []);
});
