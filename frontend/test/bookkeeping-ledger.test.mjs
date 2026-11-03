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
  linkedEvidenceDocuments,
  ledgerRowMarkup,
  ledgerTableMarkup,
  needsCategory,
  originalValue,
  suggestionsMarkup,
  vatPresentation,
  vocabulary,
} from "../src/surfaces/finance/bookkeeping-ledger.js";
import { createBookkeepingFinance, mandatoryPaymentsMarkup } from "../src/surfaces/finance/bookkeeping-vat.js";

import { escapeHtml } from "../src/core/html.js";

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
    entryType: "expense", statementRef: "Northbank", subtype: "subscription ", category: "Work-related", period: "Monthly" },
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
  assert.match(markup, /title="Original −\$100\.00"/, "hovering the EUR value reveals the original amount");
  assert.doesNotMatch(markup, /bk-col-original/, "the Original column is gone");
  assert.match(markup, /EUR<\/th>\s*<th[^>]*class="[^"]*bk-col-vat[^"]*"[^>]*>VAT/, "VAT sits right after EUR");
  assert.match(markup, /<span class="bk-unconverted" title="No EUR value recorded yet/);
  assert.match(markup, /bk-col-eur is-unconverted/);
  assert.match(markup, />−\$15\.00<\/span>/, "a row without EUR shows its original value highlighted");
  assert.match(markup, /paid 7 Sept/, "the paid date shows only when it differs");
  assert.equal((markup.match(/paid /g) || []).length, 1);
  assert.match(markup, /class="bk-row is-uncategorised is-income"\s+data-tx="b" aria-selected="true"/);
  assert.match(markup, /<option value="Infrastructure" selected>/);
  assert.match(markup, /No invoice/);
  assert.match(markup, /Invoice<\/th>/);
  assert.match(markup, /out <span class="dk-mono">−€86\.00/);
  assert.equal(JSON.stringify(rows), before);
});

test("the VAT column shows document VAT, a zero rate, and reverse charge distinctly", () => {
  const markup = ledgerTableMarkup({
    groups: groupByMonth(rows), hasEvidence: () => false, vocab: {}, selectedId: "",
    financeEntriesById: new Map([
      ["a", { vatAmount: "19.00", vatCurrency: "EUR", vatRate: "19", reverseCharge: false, zeroRated: false }],
      ["b", { vatAmount: "0.00", vatCurrency: "EUR", vatRate: "0", reverseCharge: false, zeroRated: true }],
      ["d", { vatAmount: "0.00", vatCurrency: "EUR", vatRate: "19", reverseCharge: true, zeroRated: false }],
    ]),
    e: escapeHtml,
  });
  assert.match(markup, /€19\.00/);
  assert.match(markup, />€0\.00<\/td>/);
  assert.match(markup, /title="Reverse charge — VAT is accounted by the recipient"/);
  assert.equal(vatPresentation({ vatAmount: "500.00", vatCurrency: "USD" }), "$500.00");
  assert.equal(vatPresentation({ vatAmount: "110.35", vatCurrency: "USD", vatEur: "98.12", vatRate: "0.19" }), "€98.12", "VAT shows in EUR");
});

test("ledger rows show stored Company and What instead of normalized vendor labels", () => {
  const entries = [
    { id: "aws", transactionDate: "2026-09-01", counterparty: "Aws Emea", description: "long invoice details that should not spill into the table", category: "Software", amount: "10", currency: "EUR", entryType: "expense" },
    { id: "google", transactionDate: "2026-09-02", counterparty: "Google Cloud", description: "Google Cloud", amount: "20", currency: "EUR", entryType: "expense" },
  ];
  const markup = ledgerTableMarkup({
    groups: groupByMonth(entries), hasEvidence: () => false, hasInvoice: (id) => id === "google",
    vocab: {}, selectedId: "", e: escapeHtml,
  });
  assert.match(markup, /Aws Emea/);
  assert.match(markup, /long invoice details that should not spill into the table/);
  assert.doesNotMatch(markup, /Amazon Web Services|Cloud hosting/);
  assert.match(markup, /Invoice attached/);
  assert.match(markup, /No invoice/);
  assert.deepEqual(
    filterEntries(entries, { q: "Amazon Web Services", account: "", dir: "", category: "", needs: "" }).map((entry) => entry.id),
    ["aws"],
  );
});

test("linked active receipt PDFs render direct View actions for every evidence link", () => {
  const entry = { id: "synthetic-payment", counterparty: "Synthetic Processor", amount: "30.00", currency: "EUR", entryType: "expense" };
  const documents = [1, 2, 3].map((number) => ({
    id: `synthetic-receipt-${number}`,
    status: "active",
    documentType: "receipt",
    originalFilename: `synthetic-invoice-${number}.pdf`,
  }));
  const links = documents.map((document) => ({
    id: `synthetic-link-${document.id}`,
    transactionId: entry.id,
    documentId: document.id,
    coverageType: "evidence",
  }));
  const invoiceDocuments = linkedEvidenceDocuments(entry, links, documents);
  assert.deepEqual(invoiceDocuments.map((document) => document.id), documents.map((document) => document.id));

  const markup = ledgerRowMarkup(entry, {
    hasEvidence: () => true,
    hasInvoice: () => invoiceDocuments,
    vocab: {},
    selectedId: "",
    e: escapeHtml,
  });
  for (const document of documents) {
    assert.match(markup, new RegExp(`data-view-document="${document.id}"`));
    assert.match(markup, new RegExp(`aria-label="View ${document.originalFilename}"`));
  }
  assert.equal((markup.match(/>View PDF<\/button>/g) || []).length, 3);
});

test("the month bottom section lists classified mandatory payments once with a subtotal", () => {
  const markup = mandatoryPaymentsMarkup([
    { id: "vat-april", month: "2026-04", date: "2026-04-14", direction: "out", line: "vat", mandatoryKind: "tax_debit", counterparty: "Finanzamt", description: "UMS.ST 2025", amount: "4581.14", currency: "EUR", eur: 4581.14 },
    { id: "tk-april", month: "2026-04", date: "2026-04-16", direction: "out", line: "health-insurance", mandatoryKind: "tk_debit", counterparty: "Techniker Krankenkasse", description: "Beiträge", amount: "1179.36", currency: "EUR", eur: 1179.36 },
    { id: "refund-april", month: "2026-04", date: "2026-04-20", direction: "in", line: "vat", mandatoryKind: "tax_debit", counterparty: "Finanzamt", description: "VAT refund", amount: "100", currency: "EUR", eur: 100 },
    { id: "tax-may", month: "2026-05", date: "2026-05-14", direction: "out", line: "taxes", mandatoryKind: "tax_debit", counterparty: "Finanzamt", description: "EINK.ST", amount: "200", currency: "EUR", eur: 200 },
  ], "2026-04", escapeHtml);

  assert.match(markup, /Mandatory payments · April 2026/);
  assert.match(markup, /Finanzamt/);
  assert.match(markup, /VAT \/ USt/);
  assert.match(markup, /Techniker Krankenkasse/);
  assert.match(markup, /Health insurance \/ TK/);
  assert.match(markup, /€5,760\.50/);
  assert.doesNotMatch(markup, /VAT refund|EINK\.ST/);
  assert.equal((markup.match(/<tr>/g) || []).length, 3, "two payments plus the table header");
  assert.equal(mandatoryPaymentsMarkup([], "2026", escapeHtml), "", "the section is specific to a selected month");
});

test("finance summary ensure shares and awaits an in-flight year load", async () => {
  let resolveLoad;
  let loadCount = 0;
  const refreshes = [];
  const finance = createBookkeepingFinance({
    loadYear: () => {
      loadCount += 1;
      return new Promise((resolve) => { resolveLoad = resolve; });
    },
    getLens: () => "2026-04",
    getEntries: () => [],
    getTodayIsoDate: () => "2026-11-01",
    refresh: () => refreshes.push(true),
  });
  const first = finance.ensure();
  const second = finance.ensure();
  assert.strictEqual(first, second);
  assert.equal(loadCount, 1);
  resolveLoad({ entries: [{ id: "vat-april", month: "2026-04", mandatoryKind: "tax_debit" }], months: [], totals: {} });
  await Promise.all([first, second]);
  assert.equal(finance.entries().length, 1);
  assert.equal(refreshes.length, 2, "one refresh starts the load and one publishes its result");
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
  assert.match(markup, /Cloudbase &lt;Inc&gt;/);
  assert.match(markup, /Same amount, 1 day apart/);
  assert.match(markup, /href="\/sponsors\/deals\/deal%201"/);
  assert.match(markup, /€2,000\.00 outstanding/);
  const confirming = suggestionsMarkup({
    suggestions: { documents: [], sponsor: { deals: [{ dealId: "deal-2", organizationName: "Example Sponsor", outstanding: "0", currency: "EUR", reasons: ["confirms the payment recorded on 2026-09-04"], replacesPaymentId: "a".repeat(32) }] } },
    e: escapeHtml,
  });
  assert.match(confirming, /Confirms the payment recorded on 2026-09-04/);
  assert.doesNotMatch(confirming, /outstanding/, "a paid deal shows no zero balance");
  const claimed = detailMarkup({ entry: { ...rows[1], sponsorDealId: "deal-7" }, documents: [], vocab: {}, e: escapeHtml });
  assert.match(claimed, /Payment for a sponsor deal/);
  assert.match(claimed, /href="\/sponsors\/deals\/deal-7"/);
  assert.match(claimed, /data-suggestions/);
});
