import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bookkeepingSurfaceMarkup } from "../src/surfaces/finance/bookkeeping-markup.js";

function shell() {
  globalThis.dakitCollection = {
    createButtonMarkup: ({ label, attributes = "" }) => `<button ${attributes}>${label}</button>`,
  };
  return bookkeepingSurfaceMarkup();
}

test("the sidebar hangs Inventory under Bookkeeping with the deep link", () => {
  const index = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const item = index.match(/<a[^>]*data-bookkeeping-view="inventory"[^>]*>[\s\S]*?<\/a>/)?.[0] ?? "";
  assert.match(item, /href="\/bookkeeping\?view=inventory"/);
  assert.match(item, /data-workspace-view="bookkeeping"/);
  assert.match(item, /dk-nav-item--sub/);
  assert.match(item, />Inventory<\/span>/);
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

test("the inventory section keeps its back link now that the tab bar is gone", () => {
  const section = shell().match(/<section id="bookkeeping-inventory"[\s\S]*?<\/section>/)?.[0] ?? "";
  assert.match(section, /data-secondary="inventory"/);
  assert.match(section, /bk-back/);
});
