import assert from "node:assert/strict";
import { test } from "node:test";

import { escapeHtml } from "../src/core/html.js";
import { formatReportCsv, formatReportTsv, isReportExempt } from "../src/surfaces/finance/bookkeeping-format.js";
import { createBookkeepingReports } from "../src/surfaces/finance/bookkeeping-reporting.js";

test("current package preflight omits legacy accounts after their statement period", () => {
  const nodes = new Map([
    ["[data-package-review]", { innerHTML: "" }],
    ["[data-report-month]", { value: "" }],
    ["[data-report]", { disabled: true }],
  ]);
  const reports = createBookkeepingReports({
    api: async () => ({ months: [] }),
    escapeHtml,
    getAccounts: () => [
      { id: "business-1", displayName: "Primary legacy account", kind: "business", active: true, statementRequiredThroughMonth: "2026-09" },
      { id: "business-2", displayName: "Secondary legacy account", kind: "business", active: true, statementRequiredThroughMonth: "2026-09" },
      { id: "revolut", displayName: "Revolut Business EUR", kind: "business", active: true, statementRequiredFromMonth: "2026-10" },
      { id: "finom", displayName: "Finom Business", kind: "business", active: true, statementRequiredFromMonth: "2026-10" },
    ],
    getDocuments: () => ["revolut", "finom"].map((accountId) => ({
      id: `${accountId}-statement`,
      documentType: "bank-statement",
      accountId,
      statementMonth: "2026-10",
    })),
    getLens: () => "2026-10",
    getLinks: () => [],
    getReports: () => [],
    isReportExemptEntry: () => false,
    lensEntries: () => [],
    safeAction: async (action) => action(),
    surface: { querySelector: (selector) => nodes.get(selector) },
  });

  reports.renderPackageReview();
  const markup = nodes.get("[data-package-review]").innerHTML;
  assert.match(markup, /Revolut Business EUR/);
  assert.match(markup, /Finom Business/);
  assert.doesNotMatch(markup, /Primary legacy account|Secondary legacy account/);
  assert.doesNotMatch(markup, /needs each business account's statement/);
});

test("formatReportCsv and formatReportTsv expand one 420.84 EUR payment into three invoice rows while respecting owner-withdrawal and true-tax exclusions", () => {
  const entries = [
    {
      id: "tx-42084",
      transactionDate: "2026-10-18",
      paidDate: "2026-10-18",
      counterparty: "Synthetic Card Settlement",
      description: "Combined settlement",
      amount: "420.84",
      currency: "EUR",
      entryType: "expense",
      category: "Tools",
      statementRef: "Finom Business",
      allocations: [
        {
          id: "alloc-1",
          documentId: "doc-399",
          counterparty: "Synthetic Compute GmbH",
          description: "Dedicated cluster October",
          amount: "399.00",
          currency: "EUR",
          category: "Infrastructure",
          transactionDate: "2026-10-15",
        },
        {
          id: "alloc-2",
          documentId: "doc-1499",
          counterparty: "Synthetic Domains Ltd",
          description: "Domain renewal",
          amount: "14.99",
          currency: "EUR",
          category: "Domains",
          transactionDate: "2026-10-16",
        },
        {
          id: "alloc-3",
          documentId: "doc-685",
          counterparty: "Synthetic Mail B.V.",
          description: "Transactional email usage",
          amount: "6.85",
          currency: "EUR",
          category: "Tools",
          transactionDate: "2026-10-17",
        },
      ],
    },
    {
      id: "tx-consulting",
      transactionDate: "2026-10-20",
      paidDate: "2026-10-20",
      counterparty: "Synthetic Tax Advisory GmbH",
      description: "Monthly compliance consulting fee",
      amount: "238.00",
      currency: "EUR",
      entryType: "expense",
      category: "Compliance & Taxes",
      subtype: "Services",
      statementRef: "Finom Business",
    },
    {
      id: "tx-owner",
      transactionDate: "2026-10-21",
      paidDate: "2026-10-21",
      counterparty: "Owner Person",
      description: "Owner withdrawal",
      amount: "1200.00",
      currency: "EUR",
      entryType: "expense",
      category: "Owner pay",
      ownerPayType: "draw",
      statementRef: "Finom Business",
    },
    {
      id: "tx-tax",
      transactionDate: "2026-10-22",
      paidDate: "2026-10-22",
      counterparty: "Finanzamt Example",
      description: "USt prepayment",
      amount: "1500.00",
      currency: "EUR",
      entryType: "expense",
      category: "Taxes",
      statementRef: "Finom Business",
    },
  ];

  assert.equal(isReportExempt(entries[1]), false);
  assert.equal(isReportExempt(entries[2]), true);
  assert.equal(isReportExempt(entries[3]), true);

  const csv = formatReportCsv(entries);
  const csvLines = csv.trim().split("\r\n");
  assert.equal(csvLines.length, 5);
  assert.match(csvLines[1], /"Synthetic Compute GmbH","Dedicated cluster October","-399\.00"/);
  assert.match(csvLines[2], /"Synthetic Domains Ltd","Domain renewal","-14\.99"/);
  assert.match(csvLines[3], /"Synthetic Mail B\.V\.","Transactional email usage","-6\.85"/);
  assert.match(csvLines[4], /"Synthetic Tax Advisory GmbH","Monthly compliance consulting fee","-238\.00"/);
  assert.doesNotMatch(csv, /Owner Person/);
  assert.doesNotMatch(csv, /Finanzamt Example/);

  const tsv = formatReportTsv(entries);
  assert.match(tsv, /Synthetic Compute GmbH\tDedicated cluster October\t-399\.00/);
  assert.match(tsv, /Synthetic Domains Ltd\tDomain renewal\t-14\.99/);
  assert.match(tsv, /Synthetic Mail B\.V\.\tTransactional email usage\t-6\.85/);
  assert.doesNotMatch(tsv, /Owner Person/);
});
