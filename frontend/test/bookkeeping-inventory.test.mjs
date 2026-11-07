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

const laptop = {
  id: "inv-laptop", transactionId: "tx-1", name: "Laptop", type: "computer",
  vendor: "Amazon", acquisitionDate: "2026-03-19", amount: "1813.58",
  currency: "EUR", amountEur: "1813.58", status: "in-use",
};
const headset = {
  id: "inv-headset", transactionId: "tx-2", name: "Stereo Headset", type: "audio",
  vendor: "Amazon", acquisitionDate: "2025-06-18", amount: "35.40",
  currency: "EUR", amountEur: "35.40", status: "disposed", disposedDate: "2026-09-01",
};

function mount({ inventoryPages, putResponses = [], deletes = [] }) {
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
  });
  return { view, host, calls, status, errors, scanClick: () => host.listeners.get("scan:click")() };
}

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
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls[1], ["/inventory/import", "POST", { apply: true }]);
  assert.match(status.at(-1), /Added 1 item from the ledger\./);
  assert.match(host.innerHTML, /Laptop/);
});

test("marking disposed stamps today as the disposed date; un-disposing clears it", async () => {
  const { view, host, calls } = mount({
    inventoryPages: [[laptop]],
    putResponses: [{ ...laptop, status: "disposed", disposedDate: "2037-03-15" }],
  });
  await view.renderInventory();
  const field = { dataset: { invField: "status" }, value: "disposed", disabled: false, closest: (selector) => selector === "[data-inv]" ? { dataset: { inv: laptop.id } } : null };
  host.listeners.get("change")({ target: { closest: (selector) => selector === "[data-inv-year]" ? null : field } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls.at(-1), [`/inventory/${laptop.id}`, "PUT", { status: "disposed", disposedDate: "2037-03-15" }]);
  assert.match(host.innerHTML, /is-disposed/);
  assert.match(host.innerHTML, /2037-03-15/);
});

test("removal confirms first and drops the row", async () => {
  const { view, host, calls } = mount({ inventoryPages: [[laptop]] });
  const originalConfirm = globalThis.confirm;
  globalThis.confirm = () => true;
  try {
    await view.renderInventory();
    const button = { dataset: { invRemove: laptop.id }, closest: (selector) => selector === "[data-inv-remove]" ? button : null };
    host.listeners.get("click")({ target: { closest: (selector) => selector === "[data-inv-year]" ? null : button } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(calls.at(-1), [`/inventory/${laptop.id}`, "DELETE", undefined]);
    assert.doesNotMatch(host.innerHTML, /Laptop/);
  } finally {
    globalThis.confirm = originalConfirm;
  }
});

test("declined confirmation leaves the row in place", async () => {
  const { view, host, calls } = mount({ inventoryPages: [[laptop]] });
  const originalConfirm = globalThis.confirm;
  globalThis.confirm = () => false;
  try {
    await view.renderInventory();
    const button = { dataset: { invRemove: laptop.id }, closest: (selector) => selector === "[data-inv-remove]" ? button : null };
    host.listeners.get("click")({ target: { closest: (selector) => selector === "[data-inv-year]" ? null : button } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(calls.filter(([path, method]) => method === "DELETE"), []);
    assert.match(host.innerHTML, /Laptop/);
  } finally {
    globalThis.confirm = originalConfirm;
  }
});
