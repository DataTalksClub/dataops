// Run from the repository root: node frontend/e2e/invoice-review.mjs
// Real integrated Finance component with sanitized provider responses; no live writes.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire(path.resolve("backend/package.json"));
const { chromium } = require("playwright");
const root = path.resolve("frontend");
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/fixture") {
      res.setHeader("content-type", "text/html");
      res.end('<html><head><link rel="stylesheet" href="/src/styles.css"></head><body data-workspace-view="bookkeeping"><main id="finance"></main></body></html>');
      return;
    }
    const file = path.resolve(root, `.${url.pathname}`);
    if (!file.startsWith(root + path.sep)) throw new Error("Invalid path");
    res.setHeader("content-type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "application/octet-stream");
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(`http://127.0.0.1:${server.address().port}/fixture`);
  await page.evaluate(async () => {
    const { createFinanceSurface } = await import("/src/surfaces/finance/index.js");
    let record = { id: "invoice-demo", revision: 1, status: "pending", fields: { transactionDate: "2026-10-01", counterparty: "Synthetic Cloud Vendor", description: "Cloud hosting", amount: "12.00", currency: "USD", invoiceNumber: "SYN-001", accountContext: "Synthetic business account", quantity: 1, archiveRequired: true }, extraction: { method: "deterministic-pdf-text", evidence: ["Invoice date and total labels"], issues: [] }, source: { intakeItemIds: ["intake-demo"], artifactId: "artifact-demo", checksum: "sanitized-document-checksum" }, missingEvidence: ["paidDate", "amountEur", "paymentEvidence"], publicationStatus: "not-confirmed", destinations: { dropbox: { state: "pending", operationId: "archive-demo" }, sheets: { state: "pending", operationId: "sheet-demo" } }, audit: [] };
    const initial = structuredClone(record);
    window.resetInvoiceFixture = () => { record = structuredClone(initial); window.invoiceCalls = []; };
    window.invoiceCalls = [];
    const request = async (url, options = {}) => {
      const body = options.body && JSON.parse(options.body);
      window.invoiceCalls.push({ url, method: options.method || "GET", body });
      if (!url.includes("/invoices")) return { items: [] };
      if (url.endsWith("/readiness")) return record.publicationStatus === "complete" ? { ready: true, checks: [{ name: "Spreadsheet headers", ready: true, message: "Writable header mapping verified" }] } : { ready: false, checks: [{ name: "Spreadsheet headers", ready: false, message: "Configure the writable header mapping" }] };
      if (url.endsWith("/process")) return { items: [record], issues: [] };
      if (options.method === "PUT") record = { ...record, revision: 2, fields: body.fields, missingEvidence: [] };
      if (url.endsWith("/verify") || (options.method === "PUT" && body.verified === true)) record = { ...record, status: "confirmed", publicationStatus: "incomplete", destinations: { dropbox: { state: "verified", operationId: "archive-demo", reference: "synthetic-file" }, sheets: { state: "blocked", operationId: "sheet-demo", error: "Configured header mapping is incompatible" } }, audit: [{ action: "confirmed", actor: "Synthetic Operator", revision: 2, at: "2026-10-02T10:00:00Z" }] };
      if (url.endsWith("/retry")) record = { ...record, publicationStatus: "complete", destinations: { ...record.destinations, sheets: { state: "verified", operationId: "sheet-demo", reference: "synthetic-row" } } };
      return url.endsWith("/invoices") ? { items: [record] } : record;
    };
    await createFinanceSurface({ documentList: document.querySelector("#finance"), request, workApiUrl: url => url, escapeHtml: value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;"), humanizeOptionLabel: value => value, setRouteTitle: () => {} }).renderBookkeepingSurface();
  });
  assert.match(await page.locator("[data-invoice-list]").innerText(), /1 invoice · 1 pending review/);
  const detail = page.locator("[data-invoice-detail]");
  await page.locator(".invoice-ledger tbody tr").first().click();
  assert.ok(await detail.getByRole("button", { name: "Re-extract from document" }).isVisible());
  await page.getByText("Publication readiness", { exact: true }).click();
  await page.screenshot({ path: ".tmp/screenshots/invoice-pending.png", fullPage: true });
  assert.match(await detail.innerText(), /Missing evidence: amountEur/);
  await detail.getByLabel("Actual date paid", { exact: true }).fill("2026-10-01");
  await detail.getByLabel("Actual EUR paid (positive)", { exact: true }).fill("10.50");
  await detail.getByLabel("Payment evidence / operator attestation", { exact: true }).fill("Operator verified synthetic bank payment");
  assert.equal(await detail.getByRole("button", { name: "Verify and publish automatically" }).isDisabled(), true);
  await detail.getByRole("button", { name: "Save corrections" }).click();
  await page.waitForFunction(() => document.querySelector("[data-invoice-detail]").textContent.includes("Revision 2"));
  await detail.getByRole("button", { name: "Verify and publish automatically" }).click();
  await page.waitForFunction(() => document.querySelector("[data-invoice-detail]").textContent.includes("Spreadsheet: blocked"));
  await page.screenshot({ path: ".tmp/screenshots/invoice-partial.png", fullPage: true });
  assert.match(await detail.innerText(), /Dropbox: verified/);
  await detail.getByRole("button", { name: "Reconcile and retry publication" }).click();
  await page.waitForFunction(() => document.querySelector("[data-invoice-detail]").textContent.includes("Spreadsheet: verified"));
  await page.screenshot({ path: ".tmp/screenshots/invoice-complete.png", fullPage: true });
  assert.equal(await detail.locator("[data-invoice-action]").count(), 0);
  const mutations = await page.evaluate(() => window.invoiceCalls.filter(call => call.method !== "GET"));
  assert.equal(mutations[0].body.fields.amount, "12.00");
  assert.equal(mutations[0].body.fields.amountEur, "10.50");
  assert.equal(mutations[0].body.fields.quantity, 1);
  assert.deepEqual(mutations.map(call => [call.method, call.body.revision]), [["PUT", 1], ["POST", 2], ["POST", 2]]);
  await page.evaluate(() => window.resetInvoiceFixture());
  await page.getByRole("button", { name: "Refresh invoices", exact: true }).click();
  assert.match(await page.locator("[data-invoice-list]").innerText(), /1 invoice · 1 pending review/);
  await page.locator("[data-review-invoice]").first().click();
  await detail.getByLabel("Actual date paid", { exact: true }).fill("2026-10-01");
  await detail.getByLabel("Actual EUR paid (positive)", { exact: true }).fill("10.50");
  await detail.getByLabel("Payment evidence / operator attestation", { exact: true }).fill("Operator verified synthetic bank payment");
  await detail.getByRole("checkbox", { name: "I verified invoice and actual payment values." }).check();
  await detail.getByRole("button", { name: "Save corrections" }).click();
  await page.waitForFunction(() => document.querySelector("[data-invoice-detail]").textContent.includes("Spreadsheet: blocked"));
  const savedVerified = await page.evaluate(() => window.invoiceCalls.filter(call => call.method !== "GET"));
  assert.equal(savedVerified.length, 1, "saving verified fields publishes without another approval request");
  assert.equal(savedVerified[0].method, "PUT");
  assert.equal(savedVerified[0].body.verified, true);
  assert.equal(savedVerified[0].body.fields.verified, undefined);
  assert.equal(savedVerified[0].body.fields.amountEur, "10.50");
  await page.screenshot({ path: ".tmp/screenshots/invoice-save-verified.png", fullPage: true });
  console.log("PASS: integrated Finance pending → payment correction → explicit field verification → independent partial failure → verified retry. Screenshots in .tmp/screenshots/.");
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
