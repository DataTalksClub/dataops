import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bookkeepingSurfaceMarkup } from "../src/surfaces/finance/bookkeeping-markup.js";
import { inventorySurfaceMarkup } from "../src/surfaces/finance/inventory.js";
import { WORKSPACE_PATH_BY_VIEW, WORKSPACE_ROUTE_DEFINITIONS } from "../src/core/workspace.js";

function shell() {
  globalThis.dakitCollection = {
    createButtonMarkup: ({ label, attributes = "" }) => `<button ${attributes}>${label}</button>`,
  };
  return bookkeepingSurfaceMarkup();
}

test("Inventory is its own top-level nav entry addressed at /invertory", () => {
  const index = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const item = index.match(/<a[^>]*id="inventory-nav-button"[^>]*>[\s\S]*?<\/a>/)?.[0] ?? "";
  assert.match(item, /href="\/invertory"/);
  assert.match(item, /data-workspace-view="inventory"/);
  assert.doesNotMatch(item, /data-workspace-view="bookkeeping"/);
  assert.doesNotMatch(item, /data-bookkeeping-view/);
  assert.match(item, /class="dk-nav-item workspace-nav-button"/);
  assert.doesNotMatch(item, /dk-nav-item--sub/);
  assert.match(item, />Inventory<\/span>/);
});

test("/invertory resolves to its own inventory view, not a bookkeeping sub-view", () => {
  assert.equal(WORKSPACE_ROUTE_DEFINITIONS["/invertory"].view, "inventory");
  assert.equal(WORKSPACE_PATH_BY_VIEW.inventory, "/invertory");
});

test("the bookkeeping surface has no in-page view tabs: the sidebar navigates", () => {
  assert.doesNotMatch(shell(), /data-bk-view-tabs/);
});

test("the ⋯ menu keeps the accountant actions and other views but drops Inventory", () => {
  const menu = shell().match(/<div class="dk-menu bk-more__menu"[\s\S]*?<\/div>/)?.[0] ?? "";
  assert.match(menu, /data-export-report-csv/);
  assert.match(menu, /data-view-link="files"/);
  assert.match(menu, /data-view-link="package"/);
  assert.match(menu, /data-view-link="tuition"/);
  assert.match(menu, /data-view-link="invoices"/);
  assert.doesNotMatch(menu, /data-view-link="inventory"/);
});

test("the bookkeeping surface has no inventory section left", () => {
  const markup = shell();
  assert.doesNotMatch(markup, /data-secondary="inventory"/);
  assert.doesNotMatch(markup, /data-inventory-scan/);
  assert.doesNotMatch(markup, /data-inventory\b/);
});

test("the inventory surface owns its scan action, table host and record dialog", () => {
  const markup = inventorySurfaceMarkup();
  assert.match(markup, /data-inventory-scan/);
  assert.match(markup, /data-inventory\b/);
  assert.match(markup, /<dialog[^>]*data-inventory-transaction-dialog/);
});
