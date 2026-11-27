import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/surfaces/finance/invoices.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/styles/overrides.css", import.meta.url), "utf8");

test("only a ledger-opened draft focuses the screen; the queue route, rows and failures clear it", () => {
  assert.match(source, /async function openInvoice\(id\)[\s\S]*?dataset\.invoiceFocus = "draft"[\s\S]*?else delete host\.dataset\.invoiceFocus/);
  assert.match(source, /function openRow\(row\)\s*\{\s*delete host\.dataset\.invoiceFocus/);
  assert.match(source, /function closeInvoice\(\)\s*\{\s*delete host\.dataset\.invoiceFocus/);
});

test("the focus state hides the queue chrome but keeps the status line and the record", () => {
  assert.match(css, /\[data-invoice-focus\] > :not\(\[data-invoice-status\]\):not\(\[data-invoice-detail\]\) \{ display: none; \}/);
});
