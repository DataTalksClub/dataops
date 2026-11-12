import assert from "node:assert/strict";
import { test } from "node:test";

import {
  accountOf,
  resolveAccountName,
  accountsOf,
  bankOnlyEntryFromMonthRow,
  displayRowCount,
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
import {
  createBookkeepingFinance,
  mandatoryPaymentsMarkup,
  monthlyLedgerEntries,
  ownerWithdrawalEntries,
  ownerWithdrawalsMarkup,
} from "../src/surfaces/finance/bookkeeping-vat.js";

import { escapeHtml } from "../src/core/html.js";
import { cashDate, formatFullCsv, isReportExempt, latestActivityMonth, monthOf } from "../src/surfaces/finance/bookkeeping-format.js";

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

test("account names resolve from the linked statement or a short label", () => {
  const links = new Map([
    ["a", { accountName: "Revolut Business", statementDocumentId: "doc-1", statementPeriod: "2026-09" }],
  ]);
  assert.equal(resolveAccountName({ id: "a", statementRef: "revolut EUR" }, links), "Revolut Business");
  assert.equal(resolveAccountName({ id: "zzz", statementRef: "revolut EUR" }, links), "Revolut");
  assert.equal(resolveAccountName({ id: "zzz", statementRef: "N96 - statement.pdf" }, links), "N26-personal");
  assert.equal(resolveAccountName({ id: "zzz", statementRef: "finom" }, links), "Finom");
  assert.equal(resolveAccountName({ id: "zzz", statementRef: "Paypal - x.pdf" }, links), "PayPal");
  assert.equal(resolveAccountName({ id: "zzz", statementRef: "" }, links), "");
  assert.equal(resolveAccountName({ id: "zzz", statementRef: "revolut:dtc:USD:stmt-abc:row-def" }, links), "");
  assert.deepEqual(accountsOf(rows, links), ["Card", "Ledgerly", "Northbank", "Revolut Business"], "linked names win over refs");
});

test("the account column sits last and links to the uploaded statement", () => {
  const links = new Map([
    ["a", { accountName: "Revolut Business", statementDocumentId: "doc-1", statementPeriod: "2026-09" }],
  ]);
  const markup = ledgerTableMarkup({
    groups: groupByMonth(rows), hasEvidence: () => false, vocab: {}, selectedId: "", statementLinks: links, e: escapeHtml,
  });
  assert.match(markup, /<th scope="col" class="bk-col-flag">Invoice<\/th>\s*<th scope="col" class="bk-col-account">Account<\/th>/);
  assert.match(markup, /<button[^>]*data-view-document="doc-1"[^>]*>Revolut Business<\/button>/);
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
  const paidMarkup = ledgerTableMarkup({ groups: groupByMonth([paidInCurrentMonth]), hasEvidence: () => false,
    vocab: {}, selectedId: "", e: escapeHtml });
  assert.match(paidMarkup, /<time datetime="2026-10-02">/, "the table date is the actual cash date");
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
  assert.match(markup, /<time datetime="2026-09-07">/, "the cash date is primary when transaction and paid dates differ");
  assert.equal((markup.match(/class="bk-date__paid"/g) || []).length, 0);
  assert.match(markup, /class="bk-row is-uncategorised is-income"\s+data-tx="b" aria-selected="true"/);
  assert.match(markup, /<option value="Infrastructure" selected>/);
  assert.match(markup, /No invoice/);
  assert.match(markup, /Invoice<\/th>/);
  assert.match(markup, /out <span class="dk-mono">−€86\.00/);
  assert.equal(JSON.stringify(rows), before);
});

test("allocated invoices replace the aggregate row while totals and payment drill-through remain singular", () => {
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
    statementLinks: new Map([[payment.id, {
      accountName: "Synthetic Revolut Business EUR",
      statementPeriod: "2026-10",
      statementDocumentId: "bank-statement-2026-10",
    }]]),
    vocab: {},
    selectedId: "",
    e: escapeHtml,
  });

  assert.equal(groups[0].month, "2026-10", "the child rows follow the payment month");
  assert.equal(groups[0].entries.length, 1, "one persisted bank payment remains one month entry");
  assert.equal(displayRowCount(groups[0].entries), 3, "one parent with three allocations is three visible rows");
  assert.equal(displayRowCount([...groups[0].entries, { id: "bank-only", reconciliationOnly: true }]), 4,
    "a bank-only row contributes one visible row");
  assert.equal(groups[0].moneyOut, -123, "the month total counts the parent payment once");
  assert.equal((markup.match(/class="bk-row/g) || []).length, 3, "the main table shows only the three invoice rows");
  assert.match(markup, /class="bk-month__count dk-mono">3<\/span>/, "the visible row count follows expanded rows");
  assert.doesNotMatch(markup, /Synthetic Card Settlement/, "the opaque payment total is not a fourth monetary row");
  assert.match(markup, /out <span class="dk-mono">−€123\.00/, "the month total still counts the payment once");
  assert.match(markup, /Synthetic Compute GmbH[\s\S]*Dedicated cluster[\s\S]*−€100\.00/);
  assert.match(markup, /Synthetic Domain Ltd[\s\S]*Domain renewal[\s\S]*−€20\.00/);
  assert.match(markup, /Synthetic Mail BV[\s\S]*Email service[\s\S]*−€3\.00/);
  for (const allocation of payment.allocations) {
    assert.match(markup, new RegExp(`data-allocation-document="${allocation.documentId}"`));
    assert.match(markup, new RegExp(`data-view-document="${allocation.documentId}"`));
  }
  assert.equal((markup.match(/data-open-tx="synthetic-payment"/g) || []).length, 3,
    "each invoice row drills through to the one original payment");
  assert.equal((markup.match(/class="bk-account-link" data-view-document="bank-statement-2026-10"/g) || []).length, 3,
    "each visible invoice row keeps the parent payment's linked statement account action");
  assert.equal((markup.match(/Synthetic Revolut Business EUR/g) || []).length, 3,
    "the account name remains visible on all expanded invoice rows");
  const header = markup.match(/<thead>([\s\S]*?)<\/thead>/)?.[1] || "";
  assert.ok(header.indexOf("bk-col-account") > header.indexOf("bk-col-flag"), "Account follows Invoice in the header");
  const childRows = [...markup.matchAll(/<tr class="bk-row bk-row--allocation-child[^>]*>([\s\S]*?)<\/tr>/g)]
    .map((match) => match[1]);
  assert.equal(childRows.length, 3);
  for (const row of childRows) {
    assert.equal((row.match(/<td class="bk-col-/g) || []).length, 9);
    assert.ok(row.indexOf("bk-col-account") > row.indexOf("bk-col-flag"), "Account is the last allocation cell");
  }
  assert.match(markup, /aria-label="Open original payment for Synthetic Compute GmbH"/);
});

test("allocated invoice Net and VAT use each child's VAT rather than the payment VAT", () => {
  const payment = {
    id: "synthetic-vat-payment",
    transactionDate: "2026-09-30",
    paidDate: "2026-10-05",
    counterparty: "Synthetic Bundle Settlement",
    description: "Synthetic payment with invoice VAT",
    amount: "146.00",
    currency: "EUR",
    entryType: "expense",
    vatAmount: "25.00",
    vatCurrency: "EUR",
    allocations: [
      { id: "alloc-vat-123", documentId: "invoice-vat-123", transactionDate: "2026-09-30", paidDate: "2026-09-30", counterparty: "Synthetic VAT Vendor A", description: "Gross 123 with VAT 23", amount: "123.00", currency: "EUR", vatAmount: "23.00", vatCurrency: "EUR" },
      { id: "alloc-vat-20", documentId: "invoice-vat-20", transactionDate: "2026-09-30", paidDate: "2026-09-30", counterparty: "Synthetic VAT Vendor B", description: "Gross 20 with VAT 2", amount: "20.00", currency: "EUR", vatAmount: "2.00", vatCurrency: "EUR" },
      { id: "alloc-vat-3", documentId: "invoice-vat-3", transactionDate: "2026-09-30", paidDate: "2026-09-30", counterparty: "Synthetic VAT Vendor C", description: "Gross 3 with no VAT", amount: "3.00", currency: "EUR" },
    ],
  };
  const markup = ledgerTableMarkup({
    groups: groupByMonth([payment]),
    hasEvidence: () => true,
    hasInvoice: () => [],
    vocab: {},
    selectedId: "",
    financeEntriesById: new Map([[payment.id, { vatEur: 25 }]]),
    e: escapeHtml,
  });
  const rows = [...markup.matchAll(/<tr class="bk-row bk-row--allocation-child[^>]*>([\s\S]*?)<\/tr>/g)]
    .map((match) => match[1]);
  assert.equal((markup.match(/<time datetime="2026-10-05">/g) || []).length, 3,
    "each invoice row shows its payment cash date, not the invoice date");
  const cells = rows.map((row) => ({
    net: row.match(/<td class="bk-col-money bk-col-eur[^>]*>([\s\S]*?)<\/td>/)?.[1].replace(/<[^>]*>/g, "").trim(),
    vat: row.match(/<td class="bk-col-vat[^>]*>([\s\S]*?)<\/td>/)?.[1].replace(/<[^>]*>/g, "").trim(),
  }));
  assert.deepEqual(cells, [
    { net: "−€100.00", vat: "€23.00" },
    { net: "−€18.00", vat: "€2.00" },
    { net: "−€3.00", vat: "—" },
  ]);
  assert.equal(payment.allocations[0].paidDate, "2026-09-30", "the stored invoice date remains untouched by projection");
  assert.match(markup, /out <span class="dk-mono">−€146\.00/, "the original payment remains the sole month-total source");
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
  const bankRow = markup.match(/<tr class="bk-row bk-row--statement-only[^>]*>([\s\S]*?)<\/tr>/)?.[1] || "";
  assert.equal((bankRow.match(/<td class="bk-col-/g) || []).length, 9);
  assert.ok(bankRow.indexOf("bk-col-account") > bankRow.indexOf("bk-col-flag"), "Account is the last bank-only cell");
  assert.match(markup, /Synthetic Owner Transfer[\s\S]*Owner withdrawal · confirmed/);
  assert.match(markup, /Monthly account fee[\s\S]*Bank fee · confirmed/);
  assert.match(markup, /Synthetic health insurance debit[\s\S]*TK health insurance debit · confirmed/);
  assert.doesNotMatch(markup, /data-tx=|data-open-tx=|data-inline-field=/, "statement projections cannot open or write a nonexistent ledger row");
  assert.equal(bankOnlyEntryFromMonthRow({ ...monthRows[0], ledger: { id: "already-recorded" } }), null,
    "matched bank activity is not shown twice");
  assert.equal(bankOnlyEntryFromMonthRow({ ...monthRows[1], ledger: { id: "recorded-fee" } }), null,
    "a fee already represented by its canonical ledger row is not projected twice");
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

test("the month tax section lists debits, refunds, and health insurance with signed totals", () => {
  const markup = mandatoryPaymentsMarkup([
    { id: "synthetic-vat-april", month: "2026-04", date: "2026-04-14", direction: "out", line: "vat", mandatoryKind: "tax_debit", counterparty: "Synthetic Tax Office", description: "Synthetic VAT debit", amount: "120.00", currency: "EUR", eur: 120 },
    { id: "synthetic-tk-april", month: "2026-04", date: "2026-04-16", direction: "out", line: "health-insurance", mandatoryKind: "tk_debit", counterparty: "Synthetic Health Fund", description: "Synthetic health-insurance debit", amount: "40.00", currency: "EUR", eur: 40 },
    { id: "synthetic-refund-april", month: "2026-04", date: "2026-04-20", direction: "in", line: "taxes", mandatoryKind: null, counterparty: "Synthetic Refund Office", description: "Synthetic tax credit", amount: "15.00", currency: "EUR", eur: 15 },
    { id: "synthetic-tax-may", month: "2026-05", date: "2026-05-14", direction: "out", line: "taxes", mandatoryKind: "tax_debit", counterparty: "Synthetic Tax Office", description: "Synthetic other-tax debit", amount: "20.00", currency: "EUR", eur: 20 },
  ], "2026-04", escapeHtml);

  assert.match(markup, /Taxes &amp; health insurance · April 2026/);
  assert.match(markup, /Synthetic Tax Office/);
  assert.match(markup, /VAT \/ USt/);
  assert.match(markup, /Synthetic Health Fund/);
  assert.match(markup, /Health insurance \/ TK/);
  assert.match(markup, /Other taxes refund/);
  assert.match(markup, /€15\.00/);
  assert.match(markup, /-€145\.00/);
  assert.doesNotMatch(markup, /Synthetic other-tax debit/);
  assert.equal((markup.match(/<tr>/g) || []).length, 4, "three current-month rows plus the table header");
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


test("monthly tax partition keeps consulting fees and allocation totals in the ordinary ledger", () => {
  const month = "2026-04";
  const rows = [
    { id: "synthetic-tax-debit", transactionDate: "2026-04-14", paidDate: "2026-04-14",
      counterparty: "Synthetic Tax Office", description: "Synthetic tax debit", amount: "120.00", amountEur: "120.00",
      currency: "EUR", entryType: "expense", category: "Taxes", statementRef: "Synthetic statement A" },
    { id: "synthetic-tax-refund", transactionDate: "2026-04-20", paidDate: "2026-04-20",
      counterparty: "Synthetic Refund Office", description: "Synthetic tax credit", amount: "25.00", amountEur: "25.00",
      currency: "EUR", entryType: "income", category: "Taxes", statementRef: "Synthetic statement B" },
    { id: "synthetic-health-debit", transactionDate: "2026-04-16", paidDate: "2026-04-16",
      counterparty: "Synthetic Health Fund", description: "Synthetic health-insurance debit", amount: "10.00", amountEur: "10.00",
      currency: "EUR", entryType: "expense", category: "Health Insurance", statementRef: "Synthetic statement C" },
    { id: "synthetic-consulting-fee", transactionDate: "2026-04-18", paidDate: "2026-04-18",
      counterparty: "Synthetic Compliance Advisor", description: "Synthetic monthly consulting fee", amount: "50.00", amountEur: "50.00",
      currency: "EUR", entryType: "expense", category: "Compliance & Taxes", statementRef: "Synthetic statement D" },
    { id: "synthetic-allocated-payment", transactionDate: "2026-04-22", paidDate: "2026-04-22",
      counterparty: "Synthetic Combined Settlement", description: "Synthetic payment for two invoices", amount: "30.00", amountEur: "30.00",
      currency: "EUR", entryType: "expense", category: "Infrastructure", allocations: [
        { id: "synthetic-allocation-a", documentId: "synthetic-invoice-a", counterparty: "Synthetic Cloud Vendor",
          description: "Synthetic compute charge", amount: "20.00", currency: "EUR", category: "Infrastructure" },
        { id: "synthetic-allocation-b", documentId: "synthetic-invoice-b", counterparty: "Synthetic Domain Vendor",
          description: "Synthetic domain charge", amount: "10.00", currency: "EUR", category: "Domains" },
      ] },
    { id: "synthetic-owner-draw", transactionDate: "2026-04-23", paidDate: "2026-04-23",
      counterparty: "Synthetic Owner Transfer", description: "Synthetic owner draw", amount: "11.00", amountEur: "11.00",
      currency: "EUR", entryType: "expense", category: "Owner pay", ownerPayType: "draw",
      statementRef: "Synthetic statement E" },
  ];
  rows.push(bankOnlyEntryFromMonthRow({
    date: "2026-04-24", counterparty: "Synthetic Statement Transfer", description: "Synthetic private withdrawal",
    bank: { key: "synthetic-owner-bank-key", date: "2026-04-24", amount: "-7.00", currency: "EUR", accountId: "synthetic-account" },
    exception: { kind: "owner_withdrawal", satisfied: true },
  }));
  const financeEntries = [
    { id: "synthetic-tax-debit", month, date: "2026-04-14", direction: "out", line: "vat",
      mandatoryKind: "tax_debit", refund: false, counterparty: "Synthetic Tax Office", amount: "120.00", currency: "EUR", eur: 120 },
    { id: "synthetic-tax-refund", month, date: "2026-04-20", direction: "in", line: "taxes",
      mandatoryKind: null, counterparty: "Synthetic Refund Office", amount: "25.00", currency: "EUR", eur: 25 },
    { id: "synthetic-health-debit", month, date: "2026-04-16", direction: "out", line: "health-insurance",
      mandatoryKind: "tk_debit", refund: false, counterparty: "Synthetic Health Fund", amount: "10.00", currency: "EUR", eur: 10 },
  ];
  const finance = new Map(financeEntries.map((entry) => [entry.id, entry]));
  const before = JSON.stringify(rows);
  const ordinary = monthlyLedgerEntries(rows, month, finance);

  assert.deepEqual(ordinary.map((entry) => entry.id), ["synthetic-consulting-fee", "synthetic-allocated-payment"]);
  assert.deepEqual(ordinary, rows.filter((entry) => !entry.reconciliationOnly && !isReportExempt(entry)),
    "ordinary source rows match the report-exemptions rule after allocation");
  const groups = groupByMonth(ordinary);
  assert.equal(groups[0].moneyOut, -80, "ordinary totals exclude all tax and health-insurance amounts");
  assert.equal(displayRowCount(groups[0].entries), 3, "two allocation rows and one consulting fee remain visible");
  const ordinaryMarkup = ledgerTableMarkup({
    groups, hasEvidence: () => false, vocab: {}, selectedId: "", e: escapeHtml,
  });
  assert.match(ordinaryMarkup, /Synthetic Compliance Advisor/);
  assert.doesNotMatch(ordinaryMarkup, /Synthetic Tax Office|Synthetic Refund Office|Synthetic Health Fund/);
  assert.equal((ordinaryMarkup.match(/bk-row--allocation-child/g) || []).length, 2);
  assert.match(ordinaryMarkup, /out <span class="dk-mono">−€80\.00/);

  const taxMarkup = mandatoryPaymentsMarkup(financeEntries, month, escapeHtml);
  assert.equal((taxMarkup.match(/<tr>/g) || []).length, 4, "one row per classified exception plus the table header");
  for (const counterparty of ["Synthetic Tax Office", "Synthetic Refund Office", "Synthetic Health Fund"])
    assert.equal((taxMarkup.match(new RegExp(counterparty, "g")) || []).length, 1, `${counterparty} appears once`);
  assert.match(taxMarkup, /Other taxes refund/);
  assert.match(taxMarkup, /-€120\.00/);
  assert.match(taxMarkup, /€25\.00/);
  assert.match(taxMarkup, /-€10\.00/);
  assert.match(taxMarkup, /-€105\.00/);
  assert.doesNotMatch(taxMarkup, /Synthetic Compliance Advisor|Synthetic Combined Settlement/);

  const withdrawals = ownerWithdrawalEntries(rows, month);
  assert.deepEqual(withdrawals.map((entry) => entry.id), [
    "synthetic-owner-draw", "bank-only:synthetic-owner-bank-key",
  ]);
  const ownerMarkup = ownerWithdrawalsMarkup(rows, month, {
    hasEvidence: () => false,
    hasInvoice: () => false,
    getAllocationDocument: () => null,
    vocab: {},
    selectedId: "",
    financeEntriesById: finance,
    statementLinks: new Map(),
    e: escapeHtml,
  });
  assert.match(ownerMarkup, /data-owner-withdrawals/);
  assert.match(ownerMarkup, /Owner withdrawals · April 2026/);
  assert.equal((ownerMarkup.match(/data-bank-only=/g) || []).length, 1,
    "the classified bank-only owner projection stays visible in the owner section");
  assert.equal((ownerMarkup.match(/data-tx="synthetic-owner-draw"/g) || []).length, 1,
    "the owner-pay draw stays visible in the owner section");
  assert.match(ownerMarkup, /Synthetic private withdrawal[\s\S]*Owner withdrawal · confirmed/);
  assert.doesNotMatch(ownerMarkup, /Synthetic Tax Office|Synthetic Refund Office|Synthetic Health Fund|Synthetic Compliance Advisor/);

  const fullCsv = formatFullCsv(rows.filter((entry) => !entry.reconciliationOnly));
  for (const counterparty of ["Synthetic Tax Office", "Synthetic Refund Office", "Synthetic Health Fund", "Synthetic Compliance Advisor"])
    assert.match(fullCsv, new RegExp(counterparty), `${counterparty} remains in the native export`);
  assert.match(fullCsv, /Synthetic Owner Transfer/);
  assert.equal((fullCsv.match(/Synthetic Combined Settlement/g) || []).length, 1,
    "the native export keeps the one source payment row for an allocated payment");
  assert.equal(JSON.stringify(rows), before, "the UI partition leaves source rows and statements unchanged");
  assert.deepEqual(monthlyLedgerEntries(rows, "2026", finance), rows, "year and all-record views retain their existing behavior");
});

test("unmatched mandatory statement row appears only in the mandatory section", async () => {
  const row = bankOnlyEntryFromMonthRow({
    date: "2026-04-16", bank: { key: "synthetic-bank-key", amount: "-123.45", currency: "EUR" },
    exception: { kind: "tk_debit", satisfied: true },
  });
  const finance = createBookkeepingFinance({
    loadYear: async () => ({ entries: [{
      id: "synthetic-statement:0", bankKey: "synthetic-bank-key", month: "2026-04",
      date: "2026-04-16", direction: "out", line: "health-insurance",
      mandatoryKind: "tk_debit", amount: "123.45", currency: "EUR", eur: 123.45,
    }], months: [], totals: {} }),
    getLens: () => "2026-04", getEntries: () => [], refresh: () => {},
  });
  assert.deepEqual(monthlyLedgerEntries([row], "2026-04", finance.entryMap()), [row],
    "while the summary has not loaded, retain the bank row");
  await finance.ensure();
  assert.deepEqual(monthlyLedgerEntries([row], "2026-04", finance.entryMap()), []);
  assert.match(finance.markup(escapeHtml), /Health insurance \/ TK/);
  assert.deepEqual(monthlyLedgerEntries([row], "2026", finance.entryMap()), [row]);
});

test("an expense-encoded tax refund moves to the separate section and reduces its net total", () => {
  const debit = { id: "synthetic-debit", month: "2026-04", date: "2026-04-16",
    direction: "out", line: "vat", mandatoryKind: "tax_debit", refund: false,
    counterparty: "Synthetic authority", amount: "100.00", currency: "EUR", eur: 100 };
  const refund = { ...debit, id: "synthetic-refund", refund: true,
    counterparty: "Synthetic refund", amount: "20.00", eur: 20 };
  const index = new Map([[debit.id, debit], [refund.id, refund]]);
  assert.deepEqual(monthlyLedgerEntries([{ id: debit.id }, { id: refund.id }], "2026-04", index),
    []);
  const markup = mandatoryPaymentsMarkup([debit, refund], "2026-04", escapeHtml);
  assert.match(markup, /Synthetic authority/);
  assert.match(markup, /Synthetic refund/);
  assert.match(markup, /VAT \/ USt refund/);
  const subtotal = markup.match(/bk-mandatory-payments__subtotal[\s\S]*?<strong>(.*?)<\/strong>/)?.[1];
  assert.ok(subtotal);
  assert.match(subtotal, /-€80\.00/);
});

test("the backend line alone classifies; a kind without one is not moved", () => {
  const entries = [
    { id: "synthetic-line-tax", month: "2026-04", direction: "in", line: "taxes", mandatoryKind: null,
      counterparty: "Synthetic tax refund", amount: "12.00", currency: "EUR", eur: 12 },
    { id: "synthetic-kind-only", month: "2026-04", direction: "out", mandatoryKind: "tax_debit",
      counterparty: "Synthetic classified debit", amount: "20.00", currency: "EUR", eur: 20 },
    { id: "synthetic-unrelated-line", month: "2026-04", direction: "out", line: "operating", mandatoryKind: "tax_debit",
      counterparty: "Synthetic operating payment", amount: "30.00", currency: "EUR", eur: 30 },
  ];
  const rows = entries.map(({ id }) => ({ id }));
  const index = new Map(entries.map((entry) => [entry.id, entry]));
  assert.deepEqual(monthlyLedgerEntries(rows, "2026-04", index), [rows[1], rows[2]],
    "only the explicit backend line moves a row out of the ordinary ledger");
  const markup = mandatoryPaymentsMarkup(entries, "2026-04", escapeHtml);
  assert.match(markup, /Synthetic tax refund/);
  assert.doesNotMatch(markup, /Synthetic classified debit|Synthetic operating payment/);
  assert.match(markup, /€12\.00/);
});

test("backend-classified ledger rows leave the ordinary ledger on the first render", () => {
  const month = "2026-10";
  const rows = [
    { id: "synthetic-tk-oct", transactionDate: "2026-10-16", paidDate: "2026-10-16",
      line: "health-insurance", counterparty: "Techniker Krankenkasse", description: "Health insurance",
      amount: "1179.36", currency: "EUR", entryType: "expense", category: "" },
    { id: "synthetic-finanzamt-oct", transactionDate: "2026-10-30", paidDate: "2026-10-30",
      line: "taxes", counterparty: "ZAHLUNGSVERKEHR BERLINER", description: "Finanzamt Einkommensteuer",
      amount: "500.00", currency: "EUR", entryType: "expense", category: "" },
    { id: "synthetic-client-oct", transactionDate: "2026-10-12", paidDate: "2026-10-12",
      line: "operating", counterparty: "Synthetic Sponsor", description: "Synthetic sponsorship",
      amount: "5000.00", currency: "EUR", entryType: "income", category: "Sponsorship" },
  ];
  const beforeSummary = monthlyLedgerEntries(rows, month, new Map());
  assert.deepEqual(beforeSummary.map((entry) => entry.id), ["synthetic-client-oct"],
    "tax and health-insurance rows never appear in the ordinary ledger, summary loaded or not");
  const afterSummary = monthlyLedgerEntries(rows, month, new Map([
    ["synthetic-tk-oct", { id: "synthetic-tk-oct", month, date: "2026-10-16", direction: "out", line: "health-insurance" }],
  ]));
  assert.deepEqual(afterSummary, beforeSummary, "loading the finance summary moves no row");
});
