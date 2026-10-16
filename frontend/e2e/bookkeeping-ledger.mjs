// Run from the repository root: node frontend/e2e/bookkeeping-ledger.mjs
// Real integrated Finance component against a synthetic bookkeeping API (no
// live data, no live writes). Covers the transaction table: one ~36px line
// per transaction with split original/EUR amounts, month groups, one filter
// row with URL-backed state, the "Needs category" / "No receipt" toggles,
// inline Type/Category/Period saves, the details pane with the receipt one
// click away, and the compact phone layout.
// Screenshots go to .tmp/screenshots (and BOOKKEEPING_SCREENSHOT_DIR if set).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire(path.resolve("backend/package.json"));
const { chromium } = require("playwright");
const root = path.resolve("frontend");
const styles = [
  "dakit/tokens.css", "dakit/dakit.css", "styles/base.css", "styles/chrome.css",
  "styles/finance.css", "styles/operations.css", "styles/cards.css", "styles/planner.css",
  "styles/responsive.css", "styles/refinements.css", "styles/admin.css", "styles/tasks-boards.css",
  "styles/tasks-panels.css", "styles/knowledge.css", "styles/editor.css", "styles/overrides.css",
  "styles/shell.css", "styles/period-nav.css", "styles/bookkeeping.css",
].map((href) => `<link rel="stylesheet" href="/src/${href}">`).join("");
const fixture = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${styles}
<style>html,body{margin:0;height:100%}.frame{display:flex;flex-direction:column;height:100vh}</style></head>
<body data-workspace-view="bookkeeping"><div class="frame"><main class="dk-main" style="flex:1 1 auto"><div class="dk-main__inner"><div id="document-list" class="document-list"></div></div></main></div>
<script src="/src/dakit/split.js"></script></body></html>`;
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/bookkeeping") {
      res.setHeader("content-type", "text/html");
      res.end(fixture);
      return;
    }
    const file = path.resolve(root, `.${url.pathname}`);
    if (!file.startsWith(root + path.sep)) throw new Error("Invalid path");
    res.setHeader("content-type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "application/octet-stream");
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const shots = path.resolve(".tmp/screenshots");
await mkdir(shots, { recursive: true });
const extra = process.env.BOOKKEEPING_SCREENSHOT_DIR;
if (extra) await mkdir(extra, { recursive: true });
async function shot(page, name, options = {}) {
  const file = path.join(shots, `bookkeeping-${name}.png`);
  await page.screenshot({ path: file, ...options });
  if (extra) await copyFile(file, path.join(extra, `bookkeeping-${name}.png`));
}
const browser = await chromium.launch({ headless: true });

// Synthetic ledger: fictional counterparties, sheet-shaped fields.
const mountScript = async () => {
  const { createFinanceSurface } = await import("/src/surfaces/finance/index.js");
  const vendors = [
    ["Cloudbase Hosting", "Cloud services", "USD", "Cloud purchase", "Infrastructure", "Monthly", "Northbank"],
    ["Wordsmith AI", "Assistant Pro subscription", "USD", "Subscription", "AI Tools", "Monthly", "Northbank"],
    ["Mailstream", "Newsletter platform plan", "EUR", "Subscription", "Newsletter platform", "Monthly", "Ledgerly"],
    ["Office Suite Co", "Workspace seats", "EUR", "Subscription", "Work-related", "Monthly", "Ledgerly"],
    ["Jane Example", "Podcast editing", "EUR", "Services", "Freelance & Contractors", "Monthly", "Northbank"],
    ["Ride Share GmbH", "Taxi to venue", "EUR", "", "", "", "Card - statement-2026-09-Ride.pdf"],
    ["Example Analytics Ltd", "Newsletter sponsorship (September 2026)", "EUR", "Sponsorship", "Newsletter", "One-time", "Northbank"],
    ["Data Vendor AG", "Workshop sponsorship, second installment with a long description that truncates", "EUR", "", "", "", "Northbank"],
    ["Hotel Example", "Conference stay", "EUR", "", "", "", "Northbank"],
    ["Scheduling App", "Pro plan", "USD", "Subscription", "Work-related", "Monthly", "Northbank"],
  ];
  const entries = [];
  let n = 0;
  for (const month of ["2026-07", "2026-08", "2026-09"]) {
    vendors.forEach(([counterparty, description, currency, subtype, category, period, statementRef], index) => {
      n += 1;
      const day = String(2 + index * 2).padStart(2, "0");
      const income = /sponsorship/i.test(description);
      const amount = income ? String(2000 + index * 450) : String((19 + index * 37.35).toFixed(2));
      const entry = {
        id: `tx-${n}`, sourceKey: `sheet:2026:r${n}`, transactionDate: `${month}-${day}`,
        paidDate: index === 4 ? `${month}-${String(Number(day) + 3).padStart(2, "0")}` : `${month}-${day}`,
        counterparty, description, amount, currency, entryType: income ? "income" : "expense",
        statementRef, quantity: 1, comment: "",
      };
      if (currency !== "EUR" && !(month === "2026-09" && index === 9)) entry.amountEur = (Number(amount) * 0.86).toFixed(2);
      if (subtype && !(month === "2026-09" && index === 1)) Object.assign(entry, { subtype, category, period });
      entries.push(entry);
    });
  }
  const documents = [
    { id: "doc-1", documentType: "invoice", status: "active", verifiedByteSize: 48213 },
    { id: "doc-2", documentType: "receipt", status: "active", verifiedByteSize: 20480 },
    { id: "doc-3", documentType: "bank-statement", status: "active", statementMonth: "2026-09", accountId: "business-1" },
    { id: "doc-4", documentType: "invoice", status: "active", verifiedByteSize: 30720 },
  ];
  const links = [
    { id: "link-1", documentId: "doc-1", transactionId: "tx-21", coverageType: "evidence" },
    { id: "link-2", documentId: "doc-2", transactionId: "tx-23", coverageType: "evidence" },
  ];
  window.__calls = [];
  window.__opened = [];
  window.open = () => {
    const tab = { location: { href: "" }, close() {}, opener: null };
    window.__opened.push(tab);
    return tab;
  };
  const request = async (url, options = {}) => {
    const method = options.method || "GET";
    const body = options.body ? JSON.parse(options.body) : null;
    const parsed = new URL(String(url), "http://localhost");
    window.__calls.push({ url: parsed.pathname + parsed.search, method, body });
    const p = parsed.pathname;
    if (p.endsWith("/transactions") && method === "GET") return { items: entries.map((entry) => ({ ...entry })) };
    if (p.startsWith("/api/bookkeeping/transactions/") && method === "PUT") {
      const item = entries.find((entry) => entry.id === p.split("/").pop());
      if (body.amount !== undefined && !/^(0|[1-9]\d{0,11})(\.\d{1,4})?$/.test(String(body.amount))) {
        const error = new Error("Validation failed");
        error.payload = { error: "Validation failed", fields: ["amount"] };
        throw error;
      }
      Object.assign(item, body);
      return { ...item };
    }
    if (p === "/api/bookkeeping/transactions/tx-28/suggestions") return {
      documents: [{ id: "doc-4", documentType: "invoice", facts: { counterparty: "Hotel Example", amount: "280.45", currency: "EUR", transactionDate: "2026-09-15" }, reasons: ["same amount", "provider matches"] }],
      sponsor: { linkedDealId: null, deals: [{ dealId: "deal-1", organizationName: "Example Analytics Ltd", dealTitle: "Newsletter", outstanding: "2000", currency: "EUR", reasons: ["same amount"] }] },
    };
    if (p.endsWith("/suggestions")) return { documents: [], sponsor: { linkedDealId: null, deals: [] } };
    if (p.endsWith("/links") && method === "POST") {
      links.push({ id: `link-${links.length + 1}`, ...body });
      return { outcome: "created" };
    }
    if (p.endsWith("/download")) return { downloadUrl: `https://private.test${p}?signed=1`, expiresIn: 300 };
    if (p.endsWith("/links")) return { items: links };
    if (p.endsWith("/documents")) return { items: documents };
    if (p.endsWith("/accounts")) return { items: [{ id: "business-1", displayName: "Primary business account", kind: "business" }] };
    if (p.endsWith("/invoices")) return { items: [{ id: "inv-1", status: "pending" }] };
    if (p.endsWith("/reports")) return { items: [] };
    if (p.includes("/reports/vat")) return { months: [] };
    return { items: [] };
  };
  await createFinanceSurface({
    documentList: document.querySelector("#document-list"),
    request,
    workApiUrl: (url) => url,
    escapeHtml: (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;"),
    humanizeOptionLabel: (value) => String(value || "").replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
    setRouteTitle: () => {},
    todayIsoDate: () => "2026-10-15",
  }).renderBookkeepingSurface();
};

const base = `http://127.0.0.1:${server.address().port}`;
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`${base}/bookkeeping`);
  await page.evaluate(mountScript);
  await page.waitForSelector(".bk-row");

  // Opens on the latest month with transactions, as one month group.
  assert.match(await page.$eval("[data-period-heading]", (el) => el.textContent), /September 2026/);
  assert.equal(await page.$$eval(".bk-month", (els) => els.length), 1);
  assert.equal(await page.$$eval(".bk-row", (rows) => rows.length), 10);
  // Nothing but the header, one filter row and the table on the page.
  for (const gone of ["[data-worklist]", ".bookkeeping-totals", "#bookkeeping-ledger-heading"])
    assert.equal(await page.$(gone), null, `${gone} is gone`);
  assert.equal(await page.$eval("#bookkeeping-evidence", (el) => el.hidden), true);
  assert.equal(await page.$eval("#bookkeeping-package", (el) => el.hidden), true);

  // Dense one-line rows.
  const heights = await page.$$eval(".bk-row", (rows) => rows.map((row) => row.getBoundingClientRect().height));
  assert.ok(heights.every((h) => h <= 40), `rows are one line: ${heights}`);

  // Split amounts: original currency column blank for EUR rows, signed EUR.
  const cells = (text) => page.$$eval(".bk-row", (rows, text) => {
    const row = rows.find((r) => r.textContent.includes(text));
    return { original: row.querySelector(".bk-col-original").textContent.trim(), eur: row.querySelector(".bk-col-eur").textContent.trim() };
  }, text);
  assert.deepEqual(await cells("Cloudbase Hosting"), { original: "−$19.00", eur: "−€16.34" });
  assert.deepEqual(await cells("Mailstream"), { original: "", eur: "−€93.70" });
  assert.equal((await cells("Example Analytics Ltd")).eur, "+€4,700.00");
  assert.equal((await cells("Scheduling App")).eur, "EUR?");
  // Paid date shows only when it differs.
  assert.match(await page.$eval('.bk-row[data-tx="tx-25"] .bk-col-date', (el) => el.textContent), /paid/);
  assert.doesNotMatch(await page.$eval('.bk-row[data-tx="tx-21"] .bk-col-date', (el) => el.textContent), /paid/);

  // Uncategorised rows are highlighted and counted.
  assert.equal(await page.$$eval(".bk-row.is-uncategorised", (rows) => rows.length), 4);
  assert.equal(await page.$eval('[data-needs-count="category"]', (el) => el.textContent), "4");
  await shot(page, "desktop");

  // Needs category filter, URL-backed.
  await page.click('[data-needs="category"]');
  assert.equal(await page.$$eval(".bk-row", (rows) => rows.length), 4);
  assert.match(await page.evaluate(() => location.search), /needs=category/);
  await shot(page, "needs-category");

  // Inline category save goes straight to the API and clears the highlight
  // once Type and Category are both set.
  await page.selectOption('.bk-row[data-tx="tx-26"] [data-inline-field="subtype"]', "Services");
  await page.selectOption('.bk-row[data-tx="tx-26"] [data-inline-field="category"]', "Freelance & Contractors");
  await page.waitForFunction(() => !document.querySelector('.bk-row[data-tx="tx-26"]').classList.contains("is-uncategorised"));
  const puts = await page.evaluate(() => window.__calls.filter((c) => c.method === "PUT"));
  assert.deepEqual(puts.map((c) => c.body), [{ subtype: "Services" }, { category: "Freelance & Contractors" }]);
  assert.equal(await page.$eval('[data-needs-count="category"]', (el) => el.textContent), "4", "counts refresh on the next render");

  // Search + account filter compose; clearing goes back to the month.
  await page.click('[data-needs="category"]');
  await page.fill('[data-filter="q"]', "workspace seats");
  assert.equal(await page.$$eval(".bk-row", (rows) => rows.length), 1);
  await page.fill('[data-filter="q"]', "");
  await page.selectOption('[data-filter="account"]', "Ledgerly");
  assert.equal(await page.$$eval(".bk-row", (rows) => rows.length), 2);
  assert.match(await page.evaluate(() => location.search), /account=Ledgerly/);
  await page.selectOption('[data-filter="account"]', "");

  // Clicking a row opens its details beside the table, URL-backed.
  await page.click('.bk-row[data-tx="tx-21"] .bk-col-date');
  await page.waitForSelector(".bk-detail:not([hidden]) [data-detail-form]");
  assert.match(await page.evaluate(() => location.search), /tx=tx-21/);
  assert.equal(await page.$eval('.bk-detail [name="counterparty"]', (el) => el.value), "Cloudbase Hosting");
  assert.equal(await page.$eval('.bk-detail [name="amountEur"]', (el) => el.value), "16.34");
  assert.match(await page.$eval(".bk-receipts", (el) => el.textContent), /Invoice PDF · 47 KB/);
  await shot(page, "detail");
  // View invoice: a signed inline URL in a new tab.
  await page.click("[data-view-document=doc-1]");
  await page.waitForFunction(() => window.__opened[0]?.location.href);
  assert.equal(await page.evaluate(() => window.__opened[0].location.href), "https://private.test/api/bookkeeping/documents/doc-1/download?signed=1");
  assert.ok(await page.evaluate(() => window.__calls.some((c) => c.url === "/api/bookkeeping/documents/doc-1/download?disposition=inline")));
  // Field edits save on change; invalid values stay local with a message.
  await page.fill('.bk-detail [name="amount"]', "-5");
  await page.press('.bk-detail [name="amount"]', "Tab");
  assert.match(await page.$eval('.bk-detail [data-field="amount"] [data-field-error]', (el) => el.textContent), /positive number/);
  await page.fill('.bk-detail [name="comment"]', "Synthetic note");
  await page.press('.bk-detail [name="comment"]', "Tab");
  await page.waitForFunction(() => window.__calls.some((c) => c.method === "PUT" && c.body.comment === "Synthetic note"));
  // A row without a receipt says so and offers attaching one.
  await page.click('.bk-row[data-tx="tx-28"] .bk-col-date');
  assert.match(await page.$eval(".bk-receipts__none", (el) => el.textContent), /No receipt/);
  assert.ok(await page.$(".bk-detail [data-attach-file]"));
  // Suggested matches: an unattached invoice to attach, a sponsor deal to open.
  await page.waitForSelector(".bk-detail [data-attach-suggestion=doc-4]");
  assert.match(await page.$eval("[data-suggestions]", (el) => el.textContent), /Same amount, provider matches/);
  assert.equal(await page.$eval("[data-suggestions] a[href]", (el) => el.getAttribute("href")), "/sponsors/deals/deal-1");
  await shot(page, "suggestions");
  await page.click("[data-attach-suggestion=doc-4]");
  await page.waitForFunction(() => window.__calls.some((c) => c.method === "POST" && c.url === "/api/bookkeeping/links" && c.body.documentId === "doc-4" && c.body.transactionId === "tx-28"));
  await page.waitForSelector(".bk-receipts [data-view-document=doc-4]");
  await page.click(".bk-detail__close");
  assert.equal(await page.$eval(".bk-detail", (el) => el.hidden), true);
  assert.doesNotMatch(await page.evaluate(() => location.search), /tx=/);

  // Whole year: month groups with EUR in/out per month, newest first.
  await page.click("[data-picker-toggle]");
  await page.click('[data-picker-shortcut="year"]');
  assert.deepEqual(await page.$$eval(".bk-month", (els) => els.map((el) => el.dataset.month)), ["2026-09", "2026-08", "2026-07"]);
  assert.match(await page.$eval(".bk-month__head", (el) => el.textContent), /out\s*−€/);

  // Secondary views live behind the ⋯ menu.
  await page.click(".bk-more > summary");
  assert.match(await page.$eval("[data-invoices-meta]", (el) => el.textContent), /1 to review/);
  await page.click('.bk-more [data-view-link="files"]');
  assert.equal(await page.$eval("#bookkeeping-evidence", (el) => el.hidden), false);
  assert.equal(await page.$eval("[data-bk-main]", (el) => el.hidden), true);
  assert.match(await page.evaluate(() => location.search), /view=files/);
  await page.click('#bookkeeping-evidence [data-view-link=""]');
  assert.equal(await page.$eval("[data-bk-main]", (el) => el.hidden), false);

  // A shared link restores lens, filters and the open transaction.
  const linked = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await linked.goto(`${base}/bookkeeping?month=2026-08&needs=receipt&tx=tx-12`);
  await linked.evaluate(mountScript);
  await linked.waitForSelector(".bk-detail:not([hidden])");
  assert.match(await linked.$eval("[data-period-heading]", (el) => el.textContent), /August 2026/);
  assert.equal(await linked.$eval('[data-needs="receipt"]', (el) => el.getAttribute("aria-pressed")), "true");
  assert.equal(await linked.$eval('.bk-detail [name="counterparty"]', (el) => el.value), "Wordsmith AI");
  await linked.close();

  // Phone: date, counterparty and amount per row; details full screen.
  const phone = await browser.newPage({ viewport: { width: 375, height: 760 }, isMobile: true, hasTouch: true });
  phone.on("pageerror", (error) => errors.push(String(error)));
  await phone.goto(`${base}/bookkeeping`);
  await phone.evaluate(mountScript);
  await phone.waitForSelector(".bk-row");
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "no horizontal page scroll");
  assert.equal(await phone.$eval(".bk-row .bk-col-account", (el) => getComputedStyle(el).display), "none");
  await shot(phone, "phone");
  await phone.click('.bk-row[data-tx="tx-21"] .bk-col-date');
  await phone.waitForSelector(".bk-detail:not([hidden])");
  assert.equal(await phone.$eval(".bk-split__list", (el) => getComputedStyle(el).display), "none");
  await shot(phone, "phone-detail");
  await phone.click(".bk-detail .dk-split__back");
  assert.equal(await phone.$eval(".bk-split__list", (el) => getComputedStyle(el).display), "flex");
  await phone.close();

  assert.deepEqual(errors, []);
  console.log("bookkeeping ledger e2e passed");
} finally {
  await browser.close();
  server.close();
}
