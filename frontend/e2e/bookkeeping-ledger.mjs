// Run from the repository root: node frontend/e2e/bookkeeping-ledger.mjs
// Real integrated Finance component with sanitized provider responses; no live writes.
// Covers #243 (split totals, signed amounts, typed entry dialog with local +
// API field validation, in-flow More filters, evidence-chip action, accounts
// done state) and #242 (month lens close state, needs-attention worklist with
// inline fixes, EUR conversion capture, package review-before-create, and the
// intake plumbing demoted off the page).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
      res.end('<html><head><link rel="stylesheet" href="/src/dakit/tokens.css"><link rel="stylesheet" href="/src/dakit/dakit.css"><link rel="stylesheet" href="/src/styles/base.css"><link rel="stylesheet" href="/src/styles/review.css"><link rel="stylesheet" href="/src/styles/chrome.css"><link rel="stylesheet" href="/src/styles/finance.css"><link rel="stylesheet" href="/src/styles/operations.css"><link rel="stylesheet" href="/src/styles/cards.css"><link rel="stylesheet" href="/src/styles/planner.css"><link rel="stylesheet" href="/src/styles/responsive.css"><link rel="stylesheet" href="/src/styles/refinements.css"><link rel="stylesheet" href="/src/styles/admin.css"><link rel="stylesheet" href="/src/styles/tasks-boards.css"><link rel="stylesheet" href="/src/styles/tasks-panels.css"><link rel="stylesheet" href="/src/styles/knowledge.css"><link rel="stylesheet" href="/src/styles/editor.css"><link rel="stylesheet" href="/src/styles/overrides.css"></head><body data-workspace-view="bookkeeping"><main id="finance"></main></body></html>');
      return;
    }
    const file = path.resolve(root, `.${url.pathname}`);
    if (!file.startsWith(root + path.sep)) throw new Error("Invalid path");
    res.setHeader("content-type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "application/octet-stream");
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
await mkdir(".tmp/screenshots", { recursive: true });
await writeFile(".tmp/e2e-fixture.pdf", Buffer.from("%PDF-1.4\n%synthetic bookkeeping evidence\n"));
const browser = await chromium.launch({ headless: true });
// Synthetic bookkeeping API: the same positive-decimal + entry-type contract
// as backend/src/routes/bookkeeping.ts, including its 400 fields array.
const mountScript = async () => {
  const { createFinanceSurface } = await import("/src/surfaces/finance/index.js");
  const entries = [
    { id: "entry-expense", transactionDate: "2026-09-02", counterparty: "Cloud GmbH", description: "Hosting", amount: "125.50", currency: "EUR", category: "Services", entryType: "Expense" },
    { id: "entry-income", transactionDate: "2026-09-05", counterparty: "Sponsor LLC", description: "Sponsorship", amount: "200.00", currency: "EUR", category: "Sponsorship", entryType: "income" },
    { id: "entry-untyped", transactionDate: "2026-09-07", counterparty: "Misc Payee", description: "Unclassified item", amount: "10.00", currency: "EUR" },
    { id: "entry-usd", transactionDate: "2026-09-12", counterparty: "X Payout", description: "Ad revenue payout", amount: "90.00", currency: "USD", entryType: "expense" },
  ];
  let documents = [{ id: "doc-1", originalFilename: "statement-sep.pdf", documentType: "invoice" }];
  let reports = [];
  window.__calls = [];
  window.__links = [];
  const request = async (url, options = {}) => {
    const method = options.method || "GET";
    const body = options.body ? JSON.parse(options.body) : null;
    window.__calls.push({ url: String(url), method, body });
    const path = new URL(String(url), "http://localhost").pathname;
    if (!path.startsWith("/api/bookkeeping") || path.includes("/invoices")) return { items: [] };
    // Serve snapshots, not the live arrays: over real HTTP the surface never
    // aliases server state, and aliasing here would double-count saves.
    if (path.endsWith("/transactions") && method === "GET") return { items: entries.map(entry => ({ ...entry })) };
    if (path.startsWith("/api/bookkeeping/transactions/") && method === "PUT") {
      const id = path.split("/").pop();
      const item = entries.find(entry => entry.id === id);
      Object.assign(item, body);
      return { ...item };
    }
    if (path === "/api/bookkeeping/transactions" && method === "POST") {
      if (body.description && body.description.length > 300) {
        const error = new Error("Validation failed");
        error.status = 400;
        error.payload = { error: "Validation failed", fields: ["description"] };
        throw error;
      }
      const item = { id: `entry-new-${entries.length + 1}`, ...body };
      entries.push(item);
      return { ...item };
    }
    if (path.endsWith("/documents/prepare")) return { outcome: "existing", document: documents[0] };
    if (path === "/api/bookkeeping/links" && method === "POST") {
      const link = { id: `link-${window.__calls.length}`, ...body };
      return link;
    }
    if (path.endsWith("/links")) return { items: window.__links || [] };
    if (path.endsWith("/documents")) return { items: documents };
    if (path.endsWith("/accounts/setup")) return { accounts: [{ id: "business-1", displayName: "Primary business account", kind: "business" }] };
    if (path.endsWith("/accounts")) return { items: [{ id: "business-1", displayName: "Primary business account", kind: "business" }] };
    if (path.includes("/reports/vat")) return { months: [], transactions: [] };
    if (path.endsWith("/reports/snapshot")) {
      reports = [{ id: "report-demo", month: body.month, status: "ready", reconciliation: { transactionCount: 4, excludedTransactionCount: 0, documentCount: 2 } }];
      return { report: { id: "report-demo", reconciliation: { excludedTransactionCount: 0 } }, warnings: {} };
    }
    if (path.includes("/archive")) return { downloadUrl: "https://private.test/package.zip", expiresIn: 300 };
    if (path.endsWith("/reports")) return { items: reports };
    return { items: [] };
  };
  const originalRequest = request;
  window.__mount = await createFinanceSurface({
    documentList: document.querySelector("#finance"),
    request: async (url, options = {}) => {
      const result = await originalRequest(url, options);
      const path = new URL(String(url), "http://localhost").pathname;
      const body = options.body ? JSON.parse(options.body) : null;
      if (path === "/api/bookkeeping/links" && (options.method || "GET") === "POST") window.__links.push(body);
      return result;
    },
    workApiUrl: url => url,
    escapeHtml: value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;"),
    humanizeOptionLabel: value => String(value || "").replaceAll("-", " ").replace(/\b\w/g, letter => letter.toUpperCase()),
    setRouteTitle: () => {},
    todayIsoDate: () => "2026-09-15",
  }).renderBookkeepingSurface();
};
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(`http://127.0.0.1:${server.address().port}/fixture`);
  await page.evaluate(mountScript);

  // The month lens opens on the latest month with activity and answers
  // "what is left for this month" with four counters and one CTA.
  assert.match(await page.$eval("[data-close-state]", el => el.textContent), /September 2026 close/);
  const counter = async label =>
    page.$eval("[data-close-state]", (el, label) => {
      const span = [...el.querySelectorAll(".bookkeeping-counter")].find(span => span.textContent.includes(label));
      return span?.querySelector("strong")?.textContent.trim() ?? null;
    }, label);
  assert.equal(await counter("transactions"), "4");
  assert.equal(await counter("evidence missing"), "4");
  assert.equal(await counter("EUR conversions open"), "1");
  assert.equal(await counter("package"), "—");
  assert.match(await page.$eval("[data-close-state]", el => el.textContent), /Review 6 open items/);

  // The page opens quiet: no status strip until the operator acts.
  assert.equal(await page.$eval("[data-bookkeeping-status]", el => el.textContent), "");
  assert.equal(await page.$eval("[data-bookkeeping-status]", el => !el.checkVisibility()), true);

  // Totals split by direction per currency; signed expense amounts.
  assert.equal(
    await page.$eval(".bookkeeping-totals", el => el.textContent),
    "EUR Income 200.00 · EUR Expenses 125.50 · EUR Unclassified 10.00 · USD Expenses 90.00",
  );
  const rowAmount = async rowText =>
    page.$$eval(".bookkeeping-ledger tbody tr", (rows, text) => {
      const row = rows.find(row => row.textContent.includes(text));
      return row?.querySelector(".ledger-amount")?.textContent.trim() ?? null;
    }, rowText);
  assert.equal(await rowAmount("Cloud GmbH"), "-125.50 EUR");
  assert.equal(await rowAmount("Sponsor LLC"), "200.00 EUR");
  assert.equal(await rowAmount("Misc Payee"), "10.00 EUR");
  assert.equal(await rowAmount("X Payout"), "-90.00 USD");

  // The worklist is the reconcile output: every open item with its fix.
  const worklistText = await page.$eval("[data-worklist]", el => el.textContent);
  assert.match(worklistText, /Attach evidence/);
  assert.match(worklistText, /Add EUR value/);
  assert.match(worklistText, /Classify/);
  // Package review pre-flight: one business account exists, so the statement
  // requirement reads as blocked before anything is created.
  const reviewText = await page.$eval("[data-package-review]", el => el.textContent);
  assert.match(reviewText, /September 2026 package/);
  assert.match(reviewText, /✗ Bank statement —\s*Primary business account/);

  // EUR conversion capture from the worklist; the ledger shows the value.
  await page.locator('[data-add-eur="entry-usd"]').click();
  const eurDialog = page.locator(".bookkeeping-eur-dialog");
  assert.match(await eurDialog.locator("[data-eur-context]").textContent(), /X Payout — 90\.00 USD/);
  await eurDialog.locator("input[name=amountEur]").fill("-5");
  await eurDialog.locator("[data-eur-save]").click();
  await page.waitForFunction(() =>
    document.querySelector(".bookkeeping-eur-dialog [data-eur-error]").textContent.includes("positive number"),
  );
  await eurDialog.locator("input[name=amountEur]").fill("81.20");
  await eurDialog.locator("[data-eur-save]").click();
  await page.waitForFunction(() => !document.querySelector(".bookkeeping-eur-dialog").open);
  assert.equal(await rowAmount("X Payout"), "-90.00 USD≈ 81.20 EUR");
  assert.equal(await counter("EUR conversions open"), "0");
  assert.match(await page.$eval("[data-bookkeeping-status]", el => el.textContent), /EUR value recorded/);

  // Classifying happens inline from the worklist row.
  await page.locator('[data-classify="entry-untyped"]').selectOption("expense");
  await page.waitForFunction(() =>
    document.querySelector("[data-close-state]").textContent.includes("Review 4 open items"),
  );
  assert.equal(await rowAmount("Misc Payee"), "-10.00 EUR");
  assert.equal(
    await page.$eval(".bookkeeping-totals", el => el.textContent),
    "EUR Income 200.00 · EUR Expenses 135.50 · USD Expenses 90.00",
  );

  // The expiry note lives next to the download actions.
  assert.match(
    await page.$eval(".bookkeeping-documents", el => el.textContent),
    /Downloads are private and expire after five minutes/,
  );

  // Accounts already exist: the setup action shows its done state.
  assert.equal(await page.$eval("[data-setup-accounts]", el => el.disabled), true);
  assert.match(await page.$eval("[data-setup-accounts]", el => el.textContent), /Business accounts ready/);

  // The forwarded-invoice intake sits below the monthly package; the
  // received-intake recovery form is off the page entirely (it lives on
  // Admin).
  assert.equal(
    await page.evaluate(() =>
      !!(document.querySelector("#bookkeeping-package").compareDocumentPosition(document.querySelector("[data-invoice-review]")) & Node.DOCUMENT_POSITION_FOLLOWING),
    ),
    true,
  );
  assert.equal(
    await page.evaluate(() => document.querySelector("[data-invoice-review]").textContent.includes("Process a received intake")),
    false,
  );

  await page.screenshot({ path: ".tmp/screenshots/bookkeeping-ledger-desktop-1440.png", fullPage: true });

  // More filters expands in flow: it covers no table row and adds no
  // horizontal overflow.
  const layout = async () =>
    page.evaluate(() => {
      const panel = document.querySelector(".bookkeeping-filter-more").getBoundingClientRect();
      const wrap = document.querySelector(".bookkeeping-table-wrap").getBoundingClientRect();
      const intersects = !(panel.right <= wrap.left || wrap.right <= panel.left || panel.bottom <= wrap.top || wrap.bottom <= panel.top);
      return { intersects, overflow: document.documentElement.scrollWidth > window.innerWidth };
    });
  await page.locator(".bookkeeping-filters details summary").click();
  assert.deepEqual(await layout(), { intersects: false, overflow: false });
  await page.locator(".bookkeeping-filters details summary").click();

  // The "Missing" chip is an action: scroll, preselect, focus, and open the
  // collapsed upload panel.
  await page.locator('.bookkeeping-ledger [data-attach-evidence="entry-untyped"]').click();
  await page.waitForFunction(() => document.querySelector("#bookkeeping-evidence").getBoundingClientRect().top < window.innerHeight);
  assert.equal(await page.$eval("[data-transaction]", el => el.value), "entry-untyped");
  assert.equal(await page.evaluate(() => document.querySelector(".bookkeeping-upload-panel").open), true);
  assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute("data-pdf") ?? false), true);

  // Uploading from that state links the document to the preset transaction.
  await page.setInputFiles("[data-pdf]", ".tmp/e2e-fixture.pdf");
  await page.locator("[data-upload]").click();
  await page.waitForFunction(() => document.querySelector("[data-bookkeeping-status]").textContent.includes("Matching PDF already verified."));
  const linkCalls = await page.evaluate(() => window.__links);
  assert.equal(linkCalls.length, 1);
  assert.equal(linkCalls[0].transactionId, "entry-untyped");
  assert.equal(linkCalls[0].coverageType, "evidence");
  assert.equal(await counter("evidence missing"), "3");

  // Entry dialog: explicit type choice, visible required marks, and the
  // local positive-amount rule firing before any request.
  await page.locator("[data-bookkeeping-add]").click();
  const dialog = page.locator(".bookkeeping-entry-dialog");
  const field = name => dialog.locator(`[name=${name}]`);
  assert.equal(await field("entryType").inputValue(), "expense");
  assert.equal(await field("transactionDate").inputValue(), "2026-09-01");
  assert.deepEqual(
    await dialog.locator("[name=entryType] option").evaluateAll(options => options.map(option => option.value)),
    ["", "expense", "income"],
  );
  assert.equal(await dialog.locator(".required-mark").count(), 5);
  // Optional details live behind a disclosure.
  assert.equal(await dialog.locator("label:has([name=paidDate])").isVisible(), false);
  await dialog.locator(".bookkeeping-entry-optional summary").click();
  assert.equal(await dialog.locator("label:has([name=paidDate])").isVisible(), true);
  // A non-EUR currency reveals the actual-EUR-value field.
  await field("currency").fill("USD");
  assert.equal(await dialog.locator("label:has([name=amountEur])").isVisible(), true);
  await field("currency").fill("eur");
  assert.equal(await dialog.locator("label:has([name=amountEur])").isVisible(), false);
  await field("transactionDate").fill("2026-09-10");
  await field("counterparty").fill("Paper Vendor");
  await field("description").fill("x".repeat(301));
  await field("amount").fill("-5");
  await field("currency").fill("eur");
  await field("entryType").selectOption("income");
  const postCount = () => page.evaluate(() => window.__calls.filter(call => call.method === "POST" && call.url.endsWith("/transactions")).length);
  await dialog.locator("[data-save]").click();
  assert.match(await dialog.locator("[data-form-error]").textContent(), /Amount must be a positive number/);
  assert.match(await dialog.locator('label:has([name=amount]) .field-error').textContent(), /positive number/);
  assert.equal(await postCount(), 0);
  await page.screenshot({ path: ".tmp/screenshots/bookkeeping-ledger-entry-dialog-errors.png" });

  // The API's 400 fields array surfaces as a readable per-field message.
  await field("amount").fill("42.00");
  await dialog.locator("[data-save]").click();
  await page.waitForFunction(() => {
    const dialog = document.querySelector(".bookkeeping-entry-dialog");
    return dialog.querySelector('label:has([name=description]) .field-error')?.textContent.includes("Description was rejected");
  });
  assert.match(await dialog.locator("[data-form-error]").textContent(), /The API rejected: Description/);
  assert.equal(await postCount(), 1);
  await page.screenshot({ path: ".tmp/screenshots/bookkeeping-ledger-entry-dialog.png" });

  // Fixing the rejected field saves; the row appears signed and the totals
  // re-split.
  await field("description").fill("Paper stock");
  await dialog.locator("[data-save]").click();
  await page.waitForFunction(() => !document.querySelector(".bookkeeping-entry-dialog").open);
  assert.equal(await rowAmount("Paper Vendor"), "42.00 EUR");
  assert.equal(
    await page.$eval(".bookkeeping-totals", el => el.textContent),
    "EUR Income 242.00 · EUR Expenses 135.50 · USD Expenses 90.00",
  );
  const saves = await page.evaluate(() => window.__calls.filter(call => call.method === "POST" && call.url.endsWith("/transactions")));
  assert.equal(saves.length, 2);
  assert.equal(saves[1].body.amount, "42.00");
  assert.equal(saves[1].body.entryType, "income");
  assert.equal(saves[1].body.currency, "EUR");

  // Package creation is a review step: create, then download explicitly from
  // the ready card.
  assert.equal(await page.$eval("[data-report-month]", el => el.value), "2026-09");
  await page.locator("[data-report]").click();
  await page.waitForFunction(() => document.querySelector("[data-bookkeeping-status]").textContent.includes("Package created."));
  const readyCard = page.locator(".bookkeeping-package-ready");
  assert.match(await readyCard.textContent(), /Package ready/);
  assert.match(await readyCard.textContent(), /Link expires after five minutes/);
  await readyCard.locator("[data-download-archive]").click();
  await page.waitForFunction(() =>
    window.__calls.some(call => call.url.includes("/archive") && call.method === "POST"),
  );
  await page.screenshot({ path: ".tmp/screenshots/bookkeeping-ledger-package-ready.png", fullPage: true });

  // The all-time lookup stays reachable; stepping months works both ways.
  await page.locator("[data-lens-toggle]").click();
  assert.match(await page.$eval("[data-close-state]", el => el.textContent), /All months — 5 transactions/);
  await page.locator("[data-lens-toggle]").click();
  assert.match(await page.$eval("[data-close-state]", el => el.textContent), /September 2026 close/);
  await page.locator("[data-lens-prev]").click();
  assert.match(await page.$eval("[data-close-state]", el => el.textContent), /August 2026 close/);
  assert.match(await page.$eval(".bookkeeping-ledger", el => el.textContent), /No bookkeeping entries in August 2026/);
  await page.locator("[data-lens-next]").click();
  assert.match(await page.$eval("[data-close-state]", el => el.textContent), /September 2026 close/);

  // Mobile 390: same page re-rendered; the in-flow filters panel must still
  // cover no row and add no horizontal overflow, and the worklist keeps its
  // fixes reachable.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`http://127.0.0.1:${server.address().port}/fixture`);
  await page.evaluate(mountScript);
  assert.match(await page.$eval("[data-close-state]", el => el.textContent), /September 2026 close/);
  assert.equal(await counter("evidence missing"), "4");
  assert.match(
    await page.$eval(".bookkeeping-totals", el => el.textContent),
    /EUR Income 200\.00/,
  );
  await page.locator(".bookkeeping-filters details summary").click();
  assert.deepEqual(await layout(), { intersects: false, overflow: false });
  await page.locator('[data-add-eur="entry-usd"]').click();
  assert.equal(await page.locator(".bookkeeping-eur-dialog").isVisible(), true);
  await page.keyboard.press("Escape");
  await page.screenshot({ path: ".tmp/screenshots/bookkeeping-ledger-mobile-390.png", fullPage: true });
  console.log("PASS: month lens close state, worklist fixes, EUR capture, classify, package review, typed dialog validation, evidence-chip action, in-flow filters, and demoted intake verified at 1440 and 390. Screenshots in .tmp/screenshots/.");
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
