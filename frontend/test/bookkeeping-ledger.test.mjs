import assert from "node:assert/strict";
import { test } from "node:test";

import {
  accountOf,
  accountsOf,
  detailMarkup,
  eurValue,
  filterEntries,
  filtersFromParams,
  groupByMonth,
  inLens,
  ledgerTableMarkup,
  needsCategory,
  originalValue,
  suggestionsMarkup,
  vocabulary,
} from "../src/surfaces/finance/bookkeeping-ledger.js";

const escapeHtml = (value) =>
  String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");

// Synthetic rows shaped like the imported sheet.
const rows = Object.freeze([
  { id: "a", transactionDate: "2026-09-02", paidDate: "2026-09-02", counterparty: "Cloudbase", description: "Cloud services",
    amount: "100.00", currency: "USD", amountEur: "86.00", entryType: "expense", statementRef: "Northbank",
    subtype: "Cloud purchase", category: "Infrastructure", period: "Monthly" },
  { id: "b", transactionDate: "2026-09-05", paidDate: "2026-09-07", counterparty: "Example Sponsor", description: "Newsletter sponsorship",
    amount: "2000", currency: "EUR", entryType: "income", statementRef: "Ledgerly", subtype: "Sponsorship", category: "", period: "One-time" },
  { id: "c", transactionDate: "2026-08-30", counterparty: "Ride Co", description: "Taxi", amount: "12.50", currency: "EUR",
    entryType: "expense", statementRef: "Card - statement-2026-08-Ride.pdf" },
  { id: "d", transactionDate: "2026-09-01", counterparty: "Scheduler", description: "Pro plan", amount: "15", currency: "USD",
    entryType: "expense", statementRef: "Northbank", subtype: "subscription ", category: "Work-related tools", period: "Monthly" },
]);

test("amounts split into a signed original-currency value and a signed EUR value", () => {
  assert.equal(eurValue(rows[0]), -86);
  assert.equal(originalValue(rows[0]), -100);
  assert.equal(eurValue(rows[1]), 2000, "income is positive and EUR rows carry no original value");
  assert.equal(originalValue(rows[1]), null);
  assert.equal(eurValue(rows[3]), null, "a foreign amount without a conversion has no EUR value");
});

test("the account is the statement's account part, and rows need a category until Type and Category are set", () => {
  assert.equal(accountOf(rows[2]), "Card");
  assert.equal(accountOf({}), "");
  assert.deepEqual(accountsOf(rows), ["Card", "Ledgerly", "Northbank"]);
  assert.deepEqual(rows.map(needsCategory), [false, true, true, false]);
});

test("dropdown vocabularies dedupe spelling variants and keep the common spelling", () => {
  const entries = [{ subtype: "Subscription" }, { subtype: "Subscription" }, { subtype: "subscription " }, { subtype: "Services" }, {}];
  assert.deepEqual(vocabulary(entries, "subtype"), ["Services", "Subscription"]);
});

test("filters come from the URL and compose", () => {
  const filters = filtersFromParams(new URLSearchParams("q=taxi&account=Card&dir=sideways&needs=category"));
  assert.deepEqual(filters, { q: "taxi", account: "Card", dir: "", category: "", needs: "category" });
  assert.deepEqual(filterEntries(rows, filters).map((e) => e.id), ["c"]);
  const receipts = filterEntries(rows, { ...filtersFromParams(new URLSearchParams()), needs: "receipt" }, { hasEvidence: (id) => id === "a" });
  assert.deepEqual(receipts.map((e) => e.id), ["b", "c", "d"]);
  assert.deepEqual(filterEntries(rows, { ...filters, q: "", account: "", needs: "", dir: "income" }).map((e) => e.id), ["b"]);
  assert.equal(inLens(rows[2], "2026-08"), true);
  assert.equal(inLens(rows[2], "2026"), true);
  assert.equal(inLens(rows[2], "2026-09"), false);
  assert.equal(inLens(rows[2], "all"), true);
});

test("month groups run newest first, rows oldest first, with EUR in/out totals", () => {
  const groups = groupByMonth(rows);
  assert.deepEqual(groups.map((g) => g.month), ["2026-09", "2026-08"]);
  assert.deepEqual(groups[0].entries.map((e) => e.id), ["d", "a", "b"]);
  assert.equal(groups[0].moneyIn, 2000);
  assert.equal(groups[0].moneyOut, -86);
  assert.equal(groups[0].unconverted, 1);
});

test("the table renders one compact row per transaction without changing stored values", () => {
  const before = JSON.stringify(rows);
  const vocab = { subtype: vocabulary(rows, "subtype"), category: vocabulary(rows, "category"), period: vocabulary(rows, "period") };
  const markup = ledgerTableMarkup({ groups: groupByMonth(rows), hasEvidence: (id) => id === "a", vocab, selectedId: "b", e: escapeHtml });
  assert.equal((markup.match(/class="bk-row/g) || []).length, 4);
  assert.match(markup, /−\$100\.00/);
  assert.match(markup, /−€86\.00/);
  assert.match(markup, /\+€2,000\.00/);
  assert.match(markup, /EUR\?/);
  assert.match(markup, /paid 7 Sept/, "the paid date shows only when it differs");
  assert.equal((markup.match(/paid /g) || []).length, 1);
  assert.match(markup, /class="bk-row is-uncategorised is-income"\s+data-tx="b" aria-selected="true"/);
  assert.match(markup, /<option value="Infrastructure" selected>/);
  assert.match(markup, /aria-label="No receipt"/);
  assert.match(markup, /out <span class="dk-mono">−€86\.00/);
  assert.equal(JSON.stringify(rows), before);
});

test("details show every field, attached files one click away, and an attach action", () => {
  const vocab = { subtype: ["Cloud purchase"], category: ["Infrastructure"], period: ["Monthly"] };
  const withFile = detailMarkup({
    entry: rows[0], documents: [{ id: "doc-1", documentType: "invoice", verifiedByteSize: 4096 }], vocab, e: escapeHtml,
  });
  for (const name of ["transactionDate", "paidDate", "counterparty", "description", "amount", "currency", "amountEur",
    "entryType", "statementRef", "subtype", "category", "period", "quantity", "vatAmount", "vatCurrency", "comment"])
    assert.match(withFile, new RegExp(`name="${name}"`), name);
  assert.match(withFile, /data-view-document="doc-1"/);
  assert.match(withFile, /invoice PDF · 4 KB/);
  assert.match(withFile, /data-attach-file/);
  const eurOnly = detailMarkup({ entry: rows[2], documents: [], vocab, e: escapeHtml });
  assert.doesNotMatch(eurOnly, /name="amountEur"/, "EUR rows have no separate EUR value");
  assert.match(eurOnly, /No receipt attached/);
});

test("suggested matches offer attaching a file or opening the sponsor deal", () => {
  assert.match(suggestionsMarkup({ suggestions: null, e: escapeHtml }), /Looking for matches/);
  assert.match(suggestionsMarkup({ suggestions: { documents: [], sponsor: { deals: [] } }, e: escapeHtml }), /No matching invoice or sponsor deal/);
  const markup = suggestionsMarkup({
    suggestions: {
      documents: [{ id: "doc-9", documentType: "invoice", facts: { counterparty: "Cloudbase <Inc>", amount: "86.00", currency: "EUR", transactionDate: "2026-09-02" }, reasons: ["same amount", "1 day apart"] }],
      sponsor: { deals: [{ dealId: "deal 1", organizationName: "Example Sponsor", outstanding: "2000", currency: "EUR", reasons: ["sponsor name matches"] }] },
    },
    e: escapeHtml,
  });
  assert.match(markup, /data-attach-suggestion="doc-9"/);
  assert.match(markup, /data-view-document="doc-9"/);
  assert.match(markup, /Cloudbase &lt;Inc>/);
  assert.match(markup, /Same amount, 1 day apart/);
  assert.match(markup, /href="\/sponsors\/deals\/deal%201"/);
  assert.match(markup, /€2,000\.00 outstanding/);
  const claimed = detailMarkup({ entry: { ...rows[1], sponsorDealId: "deal-7" }, documents: [], vocab: {}, e: escapeHtml });
  assert.match(claimed, /Payment for a sponsor deal/);
  assert.match(claimed, /href="\/sponsors\/deals\/deal-7"/);
  assert.match(claimed, /data-suggestions/);
});
