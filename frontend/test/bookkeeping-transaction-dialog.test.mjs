import assert from "node:assert/strict";
import { test } from "node:test";

import { escapeHtml } from "../src/core/html.js";
import {
  bookkeepingTransactionDialogMarkup,
  bookkeepingTransactionSummaryMarkup,
} from "../src/surfaces/finance/bookkeeping-transaction-dialog.js";

const amount = (value, currency) => `${Number(value).toFixed(2)} ${currency}`;

test("transaction dialog shell uses a native, labelled dialog with an explicit close control", () => {
  const markup = bookkeepingTransactionDialogMarkup({
    id: "transaction-details",
    title: "Go Daddy transaction",
    content: "<p>Summary</p>",
    escape: escapeHtml,
  });

  assert.match(markup, /^<dialog\b/);
  assert.match(markup, /aria-labelledby="transaction-details-title"/);
  assert.match(markup, /<h2 id="transaction-details-title">Go Daddy transaction<\/h2>/);
  assert.match(markup, /data-close-transaction-dialog/);
  assert.match(markup, /<div class="bk-transaction-dialog__content"><p>Summary<\/p><\/div>/);
});

test("transaction summary shows invoice, canonical and raw vendor, signed values, category and VAT", () => {
  const markup = bookkeepingTransactionSummaryMarkup({
    transaction: {
      id: "transaction-1",
      transactionDate: "2026-09-12",
      paidDate: "2026-09-13",
      entryType: "expense",
      counterparty: "Go Daddy",
      description: ".COM Domain Registration",
      amount: "178.49",
      currency: "EUR",
      category: "Software and web services",
      vatAmount: "28.50",
      vatCurrency: "EUR",
      vatRate: "20",
    },
    invoice: { id: "invoice-1", originalFilename: "domain-renewal.pdf" },
    escape: escapeHtml,
    formatAmount: amount,
  });

  assert.match(markup, /data-view-document="invoice-1"/);
  assert.match(markup, /Open invoice · domain-renewal\.pdf/);
  assert.match(markup, />GoDaddy<\/h4>/);
  assert.match(markup, /Raw bank name<\/dt><dd>Go Daddy<\/dd>/);
  assert.match(markup, /What for<\/span> Domain renewal/);
  assert.match(markup, /Date<\/dt><dd>2026-09-12<\/dd>/);
  assert.match(markup, /Paid date<\/dt><dd>2026-09-13<\/dd>/);
  assert.match(markup, /Original amount<\/dt><dd>-178\.49 EUR<\/dd>/);
  assert.match(markup, /EUR amount<\/dt><dd>-178\.49 EUR<\/dd>/);
  assert.match(markup, /Category<\/dt><dd>Software and web services<\/dd>/);
  assert.match(markup, /VAT<\/dt><dd>28\.50 EUR · 20%<\/dd>/);
});

test("summary clearly marks a missing invoice and presents conversion metadata", () => {
  const markup = bookkeepingTransactionSummaryMarkup({
    transaction: {
      entryType: "income",
      counterparty: "Example Ltd",
      transactionDate: "2026-09-20",
      amount: "100.00",
      currency: "USD",
      amountEur: "92.30",
      exchangeRate: "1.0834",
      exchangeRateDate: "2026-09-20",
      exchangeRateSource: "ecb",
    },
    escape: escapeHtml,
    formatAmount: amount,
  });

  assert.match(markup, /No invoice/);
  assert.match(markup, /Original amount<\/dt><dd>100\.00 USD<\/dd>/);
  assert.match(markup, /EUR amount<\/dt><dd>92\.30 EUR<\/dd>/);
  assert.match(markup, /1 EUR = 1\.0834 USD · 2026-09-20 · ecb/);
});

test("statement loading is distinct from an unmatched statement", () => {
  const markup = bookkeepingTransactionSummaryMarkup({
    transaction: { counterparty: "Vendor", amount: "10", currency: "EUR" },
    statementPending: true,
    escape: escapeHtml,
    formatAmount: amount,
  });
  assert.match(markup, /Checking the linked statement line/);
  assert.doesNotMatch(markup, /Not matched to a statement/);
});

test("matched statement summary is read-only and exposes the exact bank line and source row", () => {
  const transaction = {
    entryType: "expense",
    counterparty: "Go Daddy",
    amount: "178.49",
    currency: "EUR",
  };
  const statementLine = {
    accountLabel: "Revolut Business EUR",
    statementPeriod: "2026-08",
    bankKey: "revolut|row-1",
    statementRowIndex: 11,
    line: {
      date: "2026-09-12",
      amount: "-178.49",
      currency: "EUR",
      counterparty: "Go Daddy",
      reference: ".COM Domain Registration",
    },
  };
  const markup = bookkeepingTransactionSummaryMarkup({
    transaction,
    statementLink: {
      ...statementLine,
      statementArtifactId: "statement-artifact",
    },
    escape: escapeHtml,
    formatAmount: amount,
  });

  assert.match(markup, /Matched statement line/);
  assert.match(markup, /data-view-artifact="statement-artifact"/);
  assert.match(markup, /Open statement/);
  assert.match(markup, /Revolut Business EUR/);
  assert.match(markup, /2026-09/);
  assert.match(markup, /2026-08/);
  assert.match(markup, /-178\.49 EUR/);
  assert.match(markup, /Go Daddy/);
  assert.match(markup, /\.COM Domain Registration/);
  assert.match(markup, /Source parsed line<\/dt><dd>12<\/dd>/);
  assert.doesNotMatch(markup, /<input|<textarea|contenteditable/);
  const documentMarkup = bookkeepingTransactionSummaryMarkup({
    transaction,
    statementLink: { ...statementLine, statementDocumentId: "statement-document" },
    escape: escapeHtml,
    formatAmount: amount,
  });
  assert.match(documentMarkup, /data-view-document="statement-document"/);
});

test("unmatched transaction offers candidate statement rows and a link action", () => {
  const markup = bookkeepingTransactionSummaryMarkup({
    transaction: {
      entryType: "expense",
      counterparty: "Go Daddy",
      amount: "178.49",
      currency: "EUR",
    },
    statementCandidates: [{
      bankKey: "revolut|row-1",
      accountLabel: "Revolut Business EUR",
      line: {
        date: "2026-09-12",
        amount: "-178.49",
        currency: "EUR",
        counterparty: "Go Daddy",
        reference: ".COM Domain Registration",
      },
    }],
    escape: escapeHtml,
    formatAmount: amount,
  });

  assert.match(markup, /Not matched to a statement/);
  assert.match(markup, /<select data-statement-candidate/);
  assert.match(markup, /value="revolut\|row-1"/);
  assert.match(markup, /-178\.49 EUR · Go Daddy · \.COM Domain Registration/);
  assert.match(markup, /<button[^>]*data-link-statement-row/);
});

test("dynamic values are escaped before being inserted into the markup", () => {
  const markup = bookkeepingTransactionSummaryMarkup({
    transaction: {
      entryType: "expense",
      counterparty: "Bank <name>",
      description: "What <for>",
      amount: "1.00",
      currency: "EUR",
      category: 'Tools "and" services',
    },
    invoice: { id: 'invoice" onclick="alert(1)', filename: "receipt <one>.pdf" },
    escape: escapeHtml,
    formatAmount: amount,
  });

  assert.match(markup, /Bank &lt;name&gt;/);
  assert.match(markup, /Tools &quot;and&quot; services/);
  assert.match(markup, /What for<\/span> What &lt;for&gt;/);
  assert.match(markup, /data-view-document="invoice&quot; onclick=&quot;alert\(1\)"/);
  assert.doesNotMatch(markup, /data-view-document="invoice" onclick="alert\(1\)"/);
});

test("transaction summary markup renders allocated invoice rows with individual counterparties, descriptions, amounts, and PDF links", () => {
  const markup = bookkeepingTransactionSummaryMarkup({
    transaction: {
      entryType: "expense",
      transactionDate: "2026-10-18",
      counterparty: "Synthetic Card Settlement",
      description: "Combined settlement",
      amount: "420.84",
      currency: "EUR",
      category: "Tools",
      allocations: [
        {
          id: "alloc-1",
          documentId: "doc-399",
          invoiceNumber: "INV-399",
          counterparty: "Synthetic Compute GmbH",
          description: "Dedicated cluster October",
          amount: "399.00",
          currency: "EUR",
        },
        {
          id: "alloc-2",
          documentId: "doc-1499",
          invoiceNumber: "INV-1499",
          counterparty: "Synthetic Domains Ltd",
          description: "Domain renewal",
          amount: "14.99",
          currency: "EUR",
        },
        {
          id: "alloc-3",
          documentId: "doc-685",
          invoiceNumber: "INV-685",
          counterparty: "Synthetic Mail B.V.",
          description: "Transactional email usage",
          amount: "6.85",
          currency: "EUR",
        },
      ],
    },
    escape: escapeHtml,
    formatAmount: amount,
  });

  assert.match(markup, /Allocated invoice rows \(3\)/);
  assert.match(markup, /Synthetic Compute GmbH/);
  assert.match(markup, /Dedicated cluster October · #INV-399/);
  assert.match(markup, /-399\.00 EUR/);
  assert.match(markup, /Synthetic Domains Ltd/);
  assert.match(markup, /-14\.99 EUR/);
  assert.match(markup, /Synthetic Mail B\.V\./);
  assert.match(markup, /-6\.85 EUR/);
  assert.match(markup, /data-view-document="doc-399"/);
  assert.match(markup, /data-view-document="doc-1499"/);
  assert.match(markup, /data-view-document="doc-685"/);
});
