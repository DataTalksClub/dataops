import assert from "node:assert/strict";
import { test } from "node:test";

import {
  accountOf,
  accountsOf,
  bankOnlyEntryFromMonthRow,
  eurValue,
  filterEntries,
  filtersFromParams,
  groupByMonth,
  inLens,
  linkedEvidenceDocuments,
  ledgerRowMarkup,
  ledgerTableMarkup,
  needsCategory,
  netValue,
  originalValue,
  suggestionsMarkup,
  vatPresentation,
  vocabulary,
} from "../src/surfaces/finance/bookkeeping-ledger.js";
import { createBookkeepingFinance, mandatoryPaymentsMarkup } from "../src/surfaces/finance/bookkeeping-vat.js";

import { escapeHtml } from "../src/core/html.js";
import { cashDate, latestActivityMonth, monthOf } from "../src/surfaces/finance/bookkeeping-format.js";

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

test("the net column subtracts VAT from the gross EUR value", () => {
  const expense = { amount: "691.13", currency: "USD", amountEur: "614.63", entryType: "expense" };
  assert.equal(netValue(expense, { vatEur: 98.14 }), -516.49);
  assert.equal(netValue(expense, { vatEur: 0 }), -614.63, "VAT-free rows keep the gross value");
  assert.equal(netValue(expense, null), -614.63, "missing statement context keeps the gross value");
  assert.equal(netValue({ amount: "2700", currency: "EUR", entryType: "income" }, { vatEur: 0 }), 2700);
  assert.equal(netValue({ amount: "100", currency: "USD", entryType: "expense" }, { vatEur: 5 }), null, "no EUR value means no net value");
});

test("month groups run newest first, rows oldest first, with EUR in/out totals", () => {
  const groups = groupByMonth(rows);
  assert.deepEqual(groups.map((g) => g.month), ["2026-09", "2026-08"]);
  assert.deepEqual(groups[0].entries.map((e) => e.id), ["d", "a", "b"]);
  assert.equal(groups[0].moneyIn, 2000);
  assert.equal(groups[0].moneyOut, -86);
  assert.equal(groups[0].unconverted, 1);
});

test("cash month uses paid date only, falling back to the transaction booking date", () => {
  const paidInCurrentMonth = {
    id: "synthetic-invoice-paid-current",
    transactionDate: "2026-09-30",
    paidDate: "2026-10-02",
    counterparty: "Synthetic Invoice Vendor",
    description: "Invoice paid in October",
    amount: "10.00",
    currency: "EUR",
    entryType: "expense",
  };
  const bookingDateFallback = {
    id: "synthetic-booking-fallback",
    transactionDate: "2026-10-03",
    paidDate: "",
    amount: "20.00",
    currency: "EUR",
    entryType: "expense",
  };

  assert.equal(cashDate(paidInCurrentMonth), "2026-10-02");
  assert.equal(monthOf(paidInCurrentMonth), "2026-10");
  assert.equal(latestActivityMonth([paidInCurrentMonth], "2026-09"), "2026-10");
  assert.equal(inLens(paidInCurrentMonth, "2026-10"), true);
  assert.equal(inLens(paidInCurrentMonth, "2026-09"), false);
  assert.equal(cashDate(bookingDateFallback), "2026-10-03");
  assert.deepEqual(groupByMonth([bookingDateFallback, paidInCurrentMonth]).map(({ month, entries }) =>
    [month, entries.map((entry) => entry.id)]), [
    ["2026-10", ["synthetic-invoice-paid-current", "synthetic-booking-fallback"]],
  ]);
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
  assert.match(markup, /Net<\/th>\s*<th[^>]*class="[^"]*bk-col-vat[^"]*"[^>]*>VAT/, "VAT sits right after net");
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

test("allocated invoices render as visible child rows while month totals count the bank payment once", () => {
  const payment = {
    id: "synthetic-payment",
    transactionDate: "2026-09-30",
    paidDate: "2026-10-05",
    counterparty: "Synthetic Card Settlement",
    description: "Combined payment",
    amount: "123.00",
    currency: "EUR",
    entryType: "expense",
    allocations: [
      { id: "alloc-100", documentId: "invoice-100", counterparty: "Synthetic Compute GmbH", description: "Dedicated cluster", amount: "100.00", currency: "EUR", category: "Infrastructure" },
      { id: "alloc-20", documentId: "invoice-20", counterparty: "Synthetic Domain Ltd", description: "Domain renewal", amount: "20.00", currency: "EUR", category: "Domains" },
      { id: "alloc-3", documentId: "invoice-3", counterparty: "Synthetic Mail BV", description: "Email service", amount: "3.00", currency: "EUR", category: "Services" },
    ],
  };
  const groups = groupByMonth([payment]);
  const documents = new Map(payment.allocations.map((allocation) => [allocation.documentId, {
    id: allocation.documentId,
    status: "active",
    documentType: "receipt",
    originalFilename: `${allocation.documentId}.pdf`,
  }]));
  const markup = ledgerTableMarkup({
    groups,
    hasEvidence: () => true,
    hasInvoice: () => [],
    getAllocationDocument: (_entry, allocation) => documents.get(allocation.documentId),
    vocab: {},
    selectedId: "",
    e: escapeHtml,
  });

  assert.equal(groups[0].month, "2026-10", "the child rows follow the payment month");
  assert.equal(groups[0].entries.length, 1, "one persisted bank payment remains one month entry");
  assert.equal(groups[0].moneyOut, -123, "the month total counts the parent payment once");
  assert.equal((markup.match(/class="bk-row/g) || []).length, 4, "one parent and three visible invoice rows");
  assert.match(markup, /Synthetic Card Settlement/);
  assert.match(markup, /Synthetic Compute GmbH[\s\S]*Dedicated cluster[\s\S]*−€100\.00/);
  assert.match(markup, /Synthetic Domain Ltd[\s\S]*Domain renewal[\s\S]*−€20\.00/);
  assert.match(markup, /Synthetic Mail BV[\s\S]*Email service[\s\S]*−€3\.00/);
  for (const allocation of payment.allocations) {
    assert.match(markup, new RegExp(`data-allocation-document="${allocation.documentId}"`));
    assert.match(markup, new RegExp(`data-view-document="${allocation.documentId}"`));
  }
  assert.match(markup, /data-tx="synthetic-payment"/, "the original payment still opens in the detail panel");
});

test("classified owner, fee, and TK statement rows stay visible without becoming editable ledger records", () => {
  const monthRows = [
    { id: "owner", date: "2026-10-07", counterparty: "Synthetic Owner Transfer", description: "Synthetic private withdrawal",
      amount: "-44.25", currency: "EUR", bank: { key: "bank-owner", accountId: "synthetic-account", date: "2026-10-07", amount: "-44.25", currency: "EUR", counterparty: "Synthetic Owner Transfer" },
      exception: { kind: "owner_withdrawal", satisfied: true } },
    { id: "fee", date: "2026-10-08", counterparty: "Synthetic Bank", description: "Monthly account fee",
      amount: "-2.00", currency: "EUR", bank: { key: "bank-fee", accountId: "synthetic-account", date: "2026-10-08", amount: "-2.00", currency: "EUR", counterparty: "Synthetic Bank" },
      exception: { kind: "bank_fee", satisfied: true } },
    { id: "tk", date: "2026-10-09", counterparty: "Synthetic Health Fund", description: "Synthetic health insurance debit",
      amount: "-10.00", currency: "EUR", bank: { key: "bank-tk", accountId: "synthetic-account", date: "2026-10-09", amount: "-10.00", currency: "EUR", counterparty: "Synthetic Health Fund" },
      exception: { kind: "tk_debit", satisfied: true } },
  ];
  const projected = monthRows.map(bankOnlyEntryFromMonthRow);
  assert.deepEqual(projected.map((entry) => entry.category), ["Owner withdrawal", "Bank fee", "TK health insurance debit"]);
  const groups = groupByMonth(projected);
  assert.equal(groups[0].month, "2026-10");
  assert.equal(groups[0].entries.length, 3);
  assert.equal(groups[0].moneyOut, -56.25);
  const markup = ledgerTableMarkup({ groups, hasEvidence: () => true, vocab: {}, selectedId: "", e: escapeHtml });
  assert.equal((markup.match(/data-bank-only=/g) || []).length, 3);
  assert.match(markup, /Synthetic Owner Transfer[\s\S]*Owner withdrawal · confirmed/);
  assert.match(markup, /Monthly account fee[\s\S]*Bank fee · confirmed/);
  assert.match(markup, /Synthetic health insurance debit[\s\S]*TK health insurance debit · confirmed/);
  assert.doesNotMatch(markup, /data-tx=|data-open-tx=|data-inline-field=/, "statement projections cannot open or write a nonexistent ledger row");
  assert.equal(bankOnlyEntryFromMonthRow({ ...monthRows[0], ledger: { id: "already-recorded" } }), null,
    "matched bank activity is not shown twice");
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
});
