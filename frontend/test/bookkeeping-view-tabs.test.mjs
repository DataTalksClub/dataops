import { test } from "node:test";
import assert from "node:assert/strict";
import { bookkeepingSurfaceMarkup } from "../src/surfaces/finance/bookkeeping-markup.js";

function shell() {
  globalThis.dakitCollection = {
    createButtonMarkup: ({ label, attributes = "" }) => `<button ${attributes}>${label}</button>`,
  };
  return bookkeepingSurfaceMarkup();
}

test("Inventory is a tab next to Transactions in the bookkeeping view bar", () => {
  const nav = shell().match(/<nav[^>]*data-bk-view-tabs[\s\S]*?<\/nav>/)?.[0] ?? "";
  assert.match(nav, /aria-label="Bookkeeping views"/);
  assert.match(nav, /data-view-link=""[^>]*>Transactions<\/button>/);
  assert.match(nav, /data-view-link="inventory"[^>]*>Inventory<\/button>/);
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

test("the inventory section has no back link: the tab bar navigates", () => {
  const section = shell().match(/<section id="bookkeeping-inventory"[\s\S]*?<\/section>/)?.[0] ?? "";
  assert.match(section, /data-secondary="inventory"/);
  assert.doesNotMatch(section, /bk-back/);
});
