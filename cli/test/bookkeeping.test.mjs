import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { captureIo, fakePortal, isolateConfig } from "./helpers.mjs";

isolateConfig();
const { run } = await import("../src/cli.mjs");
const sheet = await import("../src/bookkeepingSheet.mjs");

// Sanitized fixtures: invented providers and amounts in the sheet's layouts.
const CURRENT = [
  'Date sent,Date paid,Provider,What,"Price, $","Price, EUR",Statement,Count,Comment,Entry Type,Type,Period,Category',
  "2 Sep 2026,2 Sep 2026,Example Cloud,Cloud services,-120.50,-110.25,Bank A,1,,Expense,Cloud purchase,Monthly,Infrastructure",
  '3 Sep 2026,3 Sep 2026,Example Sponsor,"Sponsorship, part 1",,"5,000",Bank A,1,,Income,,,',
  "4 Sep 2026,4 Sep 2026,Example Tool,Yearly plan,,-99.00,Bank B,1,,Expense,Subscription,Anually,Work-related tools ",
  "5 Sep 2026,5 Sep 2026,Example Host,Hosting,-TODO,-TODO,,,,,,,",
].join("\n");
const OLD = ['Date,Date paid,Provider,What,"Price, $","Price, EUR",Notes', "2024-07-10,2024-07-10,Example Cafe,Business lunch,,\"-63,00\",1"].join("\n");
const TAXES = ["2024-08-12,Example Tax Office,Quarterly VAT,47.40", "2024-08-15,Example Health Fund,,,-900.10", ",Example Tax Office ..."].join("\n");

function exportDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "bookkeeping-sheet-"));
  writeFileSync(path.join(dir, "2026.csv"), CURRENT);
  writeFileSync(path.join(dir, "2024.csv"), OLD);
  writeFileSync(path.join(dir, "taxes.csv"), TAXES);
  return dir;
}

test("sheet amounts and dates parse in every format the sheet uses", () => {
  assert.deepEqual(sheet.sheetAmount("-290.66"), { value: "290.66", negative: true });
  assert.deepEqual(sheet.sheetAmount("1,492.25"), { value: "1492.25", negative: false });
  assert.equal(sheet.sheetAmount("-12,240").value, "12240.00");
  assert.equal(sheet.sheetAmount("- 109,76").value, "109.76");
  assert.equal(sheet.sheetAmount("-5.086.00").value, "5086.00");
  assert.equal(sheet.sheetAmount("-247.76999999999998").value, "247.77");
  assert.equal(sheet.sheetAmount("N/A"), null);
  assert.equal(sheet.sheetAmount("-TODO"), null);
  assert.equal(sheet.sheetDate("2 Jan 2026"), "2026-01-02");
  assert.equal(sheet.sheetDate("Sep 30, 2026"), "2026-09-30");
  assert.equal(sheet.sheetDate("2024-07-15"), "2024-07-15");
  assert.equal(sheet.sheetDate("31 Feb 2026"), "");
  assert.deepEqual(sheet.parseCsv('a,"b, ""c""\nd",e\n'), [["a", 'b, "c"\nd', "e"]]);
});

test("rows map to transactions with content keys that survive reordering", () => {
  const rows = sheet.readTab("2026", sheet.parseCsv(CURRENT));
  const [cloud, sponsor, tool, todo] = rows;
  assert.deepEqual(cloud.record, {
    transactionDate: "2026-09-02", paidDate: "2026-09-02", counterparty: "Example Cloud", description: "Cloud services",
    amount: "120.50", currency: "USD", amountEur: "110.25", entryType: "expense", statementRef: "Bank A", quantity: 1,
    subtype: "Cloud purchase", period: "Monthly", category: "Infrastructure",
  });
  assert.equal(sponsor.record.entryType, "income");
  assert.equal(sponsor.record.amount, "5000.00");
  assert.equal(tool.record.period, "Annually", "spelling variants collapse to one value");
  assert.equal(tool.record.category, "Work-related", "trimmed, and the old long spelling merges into the short one");
  assert.deepEqual(todo, { tab: "2026", row: 5, skip: "no amount" });
  const lines = CURRENT.split("\n");
  const reordered = sheet.readTab("2026", sheet.parseCsv([lines[0], lines[3], lines[1], lines[2]].join("\n")));
  assert.deepEqual(new Set(reordered.map((row) => row.sourceKey)), new Set(rows.filter((row) => row.record).map((row) => row.sourceKey)));
  const twice = sheet.readTab("2026", sheet.parseCsv([lines[0], lines[1], lines[1]].join("\n")));
  assert.notEqual(twice[0].sourceKey, twice[1].sourceKey, "identical rows keep separate keys");
});

test("classification variants merge into one spelling", () => {
  assert.equal(sheet.canonical("period", "One-time purchase"), "One-time");
  assert.equal(sheet.canonical("category", " Work-related tools"), "Work-related");
  assert.equal(sheet.canonical("category", "Course Workshop"), "Workshop");
  assert.equal(sheet.canonical("category", "Course Module"), "Course Module", "other values keep their spelling");
});

test("old tabs and the headerless taxes tab map their own layouts", () => {
  const [lunch] = sheet.readTab("2024", sheet.parseCsv(OLD));
  assert.equal(lunch.record.amount, "63.00");
  assert.equal(lunch.record.quantity, 1, "the old Notes column is the invoice count");
  const taxes = sheet.readTab("taxes", sheet.parseCsv(TAXES));
  assert.equal(taxes[0].record.counterparty, "Example Tax Office");
  assert.equal(taxes[0].record.description, "Quarterly VAT");
  assert.equal(taxes[0].record.entryType, "income");
  assert.equal(taxes[0].record.category, "Taxes");
  assert.equal(taxes[1].record.category, "Health Insurance");
  assert.equal(taxes[1].record.amount, "900.10");
  assert.equal(taxes[2].skip, "no date");
});

test("the plan adds missing rows, updates differing fields and never clears or deletes", () => {
  const rows = sheet.readTab("2026", sheet.parseCsv(CURRENT));
  const [cloud, sponsor, tool] = rows;
  const existing = [
    { id: "t-cloud", sourceType: "spreadsheet", sourceKey: cloud.sourceKey, ...cloud.record, statementRef: "Bank B" },
    // Classified in DataOps; the sheet has no Type yet, so it stays.
    { id: "t-sponsor", sourceType: "spreadsheet", sourceKey: sponsor.sourceKey, ...sponsor.record, subtype: "Sponsorship", period: "Reccurent" },
    // The sheet corrected the amount: re-paired by date and provider, not duplicated.
    { id: "t-tool", sourceType: "spreadsheet", sourceKey: "sheet:2026:stale", ...tool.record, amount: "9900.00" },
    { id: "t-gone", sourceType: "spreadsheet", sourceKey: "sheet:2026:removed", transactionDate: "2026-01-01", counterparty: "Example Gone", amount: "1.00", currency: "EUR" },
    { id: "t-manual", sourceType: "manual", sourceKey: "manual-1", transactionDate: "2026-09-02", counterparty: "Example Cloud", amount: "120.50", currency: "USD" },
  ];
  const plan = sheet.planSync(rows, existing);
  assert.equal(plan.creates.length, 0);
  assert.equal(plan.unchanged, 0);
  const byId = Object.fromEntries(plan.updates.map((update) => [update.id, update.changes]));
  assert.deepEqual(byId["t-cloud"], { statementRef: "Bank A" });
  assert.deepEqual(byId["t-sponsor"], { period: "Recurrent" }, "DataOps-only values keep, with the canonical spelling");
  assert.deepEqual(byId["t-tool"], { amount: "99.00", sourceKey: tool.sourceKey });
  assert.deepEqual(plan.orphans.map((item) => item.id), ["t-gone"]);
  assert.deepEqual(plan.skipped.map((item) => item.row), [5]);
  const later = sheet.planSync(rows, [
    // Same content under an older key: matched, and the key moves to the content key.
    { id: "t-old-key", sourceType: "spreadsheet", sourceKey: "sheet:2026:r2", ...cloud.record },
    // A sponsor deal holds this payment: differences are reported, never written.
    { id: "t-claimed", sourceType: "spreadsheet", sourceKey: "sheet:2026:r3", sponsorDealId: "deal-1", ...sponsor.record, description: "Old text" },
  ]);
  assert.deepEqual(later.updates.map((update) => [update.id, update.changes]), [["t-old-key", { sourceKey: cloud.sourceKey }]]);
  assert.deepEqual(later.locked.map((entry) => [entry.id, entry.changes]), [["t-claimed", { description: "Sponsorship, part 1" }]]);
  assert.deepEqual(later.creates.map((entry) => entry.row), [4]);
  const fresh = sheet.planSync(rows, []);
  assert.equal(fresh.creates.length, 3);
  assert.equal(fresh.creates[0].record.sourceType, "spreadsheet");
});

test("classification fills only from agreeing history of the same provider and direction", () => {
  const item = (id, fields) => ({ id, transactionDate: "2026-09-01", entryType: "expense", ...fields });
  const plan = sheet.planClassification([
    item("a", { counterparty: "Example Tool", subtype: "Subscription", category: "Work-related tools", period: "Monthly" }),
    item("b", { counterparty: "example tool", subtype: "Subscription", category: "Work-related tools", period: "Yearly" }),
    item("c", { counterparty: "Example Tool" }),
    item("d", { counterparty: "Example Unknown" }),
    item("e", { counterparty: "Example Tool", entryType: "income" }),
    item("f", { counterparty: "Example Tool", transactionDate: "2024-01-01" }),
    item("g", { counterparty: "Example Tool", sponsorDealId: "deal-1" }),
  ], { since: "2025-01-01" });
  assert.deepEqual(plan.locked.map((entry) => entry.id), ["g"]);
  assert.deepEqual(plan.fills, [{ id: "c", transactionDate: "2026-09-01", counterparty: "Example Tool", changes: { subtype: "Subscription", category: "Work-related" } }]);
  assert.deepEqual(plan.unresolved.map((entry) => entry.id), ["d", "e"]);
});

test("sync is a dry run until --apply, then creates and updates through the API", async () => {
  const dir = exportDir();
  let calls = fakePortal({ "GET /api/bookkeeping/transactions": { items: [] } });
  let io = captureIo();
  assert.equal(await run(["bookkeeping", "sync", dir], io), 0);
  assert.ok(calls.every((call) => call.method === "GET"), "a dry run writes nothing");
  assert.match(io.text(), /dry-run: sheetRows 6, create 6, update 0, locked 0, unchanged 0, orphans 0, skipped 2/);

  calls = fakePortal({
    "GET /api/bookkeeping/transactions": { items: [] },
    "POST /api/bookkeeping/transactions": ({ body }) => ({ status: 201, body: { id: "new", ...body } }),
  });
  io = captureIo();
  assert.equal(await run(["bookkeeping", "sync", dir, "--apply", "--json"], io), 0);
  const result = io.json();
  assert.deepEqual(result.applied, { created: 6, updated: 0 });
  assert.equal(calls.filter((call) => call.method === "POST").length, 6);
});

test("sync --sheet reads every tab through the Sheets API with the dapier token", async () => {
  const google = [];
  const portal = fakePortal({ "GET /api/bookkeeping/transactions": { items: [] } });
  const portalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    if (!String(url).startsWith("https://sheets.googleapis.com/")) return portalFetch(url, options);
    google.push({ url: String(url), auth: options.headers?.Authorization });
    if (String(url).includes("?fields=")) return new Response(JSON.stringify({ sheets: [{ properties: { title: "2026" } }] }));
    return new Response(JSON.stringify({ valueRanges: [{ values: sheet.parseCsv(CURRENT).map((row) => row.map((cell) => (/^-?\d+(\.\d+)?$/.test(cell) ? Number(cell) : cell))) }] }));
  };
  process.env.DAPIER_ACCESS_TOKEN = "google-test-token";
  try {
    const io = captureIo();
    assert.equal(await run(["bookkeeping", "sync", "--sheet", "sheet-id", "--json"], io), 0);
    assert.equal(io.json().counts.create, 3);
    assert.ok(google.every((call) => call.auth === "Bearer google-test-token"));
    assert.match(google[1].url, /UNFORMATTED_VALUE/);
    assert.equal(portal.length, 1);
  } finally {
    delete process.env.DAPIER_ACCESS_TOKEN;
  }
});

test("classify --apply writes only the filled fields", async () => {
  const calls = fakePortal({
    "GET /api/bookkeeping/transactions": {
      items: [
        { id: "a", transactionDate: "2026-08-01", entryType: "expense", counterparty: "Example Tool", subtype: "Subscription", category: "AI Tools" },
        { id: "b", transactionDate: "2026-09-01", entryType: "expense", counterparty: "Example Tool" },
      ],
    },
    "PUT /api/bookkeeping/transactions/b": ({ body }) => ({ id: "b", ...body }),
  });
  const io = captureIo();
  assert.equal(await run(["bookkeeping", "classify", "--apply"], io), 0);
  assert.deepEqual(calls.find((call) => call.method === "PUT").body, { subtype: "Subscription", category: "AI Tools" });
  assert.match(io.text(), /applied: updated 1, failed 0/);
});

test("facts reads only unattached invoices and receipts that were not read yet", async () => {
  const calls = fakePortal({
    "GET /api/bookkeeping/documents": {
      items: [
        { id: "d-new", status: "active", documentType: "invoice", linkRefCount: 0 },
        { id: "d-read", status: "active", documentType: "invoice", linkRefCount: 0, facts: { method: "deterministic-text" } },
        { id: "d-attached", status: "active", documentType: "receipt", linkRefCount: 1 },
        { id: "d-statement", status: "active", documentType: "bank-statement", linkRefCount: 0 },
      ],
    },
    "POST /api/bookkeeping/documents/d-new/facts": { id: "d-new", facts: { method: "deterministic-stripe" } },
  });
  let io = captureIo();
  assert.equal(await run(["bookkeeping", "facts"], io), 0);
  assert.match(io.text(), /dry-run: 1 unattached/);
  assert.equal(calls.filter((call) => call.method === "POST").length, 0);
  io = captureIo();
  assert.equal(await run(["bookkeeping", "facts", "--apply"], io), 0);
  assert.match(io.text(), /applied: read 1 \(deterministic-stripe 1\), failed 0/);
});
