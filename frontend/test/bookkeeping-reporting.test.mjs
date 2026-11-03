import assert from "node:assert/strict";
import { test } from "node:test";

import { escapeHtml } from "../src/core/html.js";
import { expandReportEntries, isReportExempt } from "../src/surfaces/finance/bookkeeping-format.js";
import { createBookkeepingReports } from "../src/surfaces/finance/bookkeeping-reporting.js";

test("current package preflight omits legacy accounts after their statement period", () => {
  let lens = "2026-10";
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
      { id: "finom", displayName: "Synthetic Business Account", kind: "business", active: true, statementRequiredFromMonth: "2026-10" },
    ],
    getDocuments: () => ["revolut", "finom"].map((accountId) => ({
      id: `${accountId}-statement`,
      documentType: "bank-statement",
      accountId,
      statementMonth: "2026-10",
    })),
    getLens: () => lens,
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
  assert.match(markup, /Synthetic Business Account/);
  assert.doesNotMatch(markup, /Primary legacy account|Secondary legacy account/);
  assert.doesNotMatch(markup, /needs each business account's statement/);
  assert.equal(nodes.get("[data-report]").disabled, false);
  for (const period of ["2026", "all"]) {
    lens = period;
    reports.renderPackageReview();
    assert.equal(nodes.get("[data-report]").disabled, true);
    assert.equal(nodes.get("[data-report-month]").value, "");
    assert.match(nodes.get("[data-package-review]").innerHTML, /Choose a month/);
  }
});
test("the package button stays disabled while a row has no EUR value", () => {
  const reportButton = { disabled: true };
  const nodes = new Map([
    ["[data-package-review]", { innerHTML: "" }],
    ["[data-report-month]", { value: "" }],
    ["[data-report]", reportButton],
  ]);
  const reports = createBookkeepingReports({
    api: async () => ({ months: [] }),
    escapeHtml,
    getAccounts: () => [
      { id: "revolut", displayName: "Revolut Business EUR", kind: "business", active: true, statementRequiredFromMonth: "2026-10" },
      { id: "finom", displayName: "Synthetic Business Account", kind: "business", active: true, statementRequiredFromMonth: "2026-10" },
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
    lensEntries: () => [
      { id: "usd-1", transactionDate: "2026-10-01", amount: "100.00", currency: "USD", entryType: "expense" },
    ],
    safeAction: async (action) => action(),
    surface: { querySelector: (selector) => nodes.get(selector) },
  });

  reports.renderPackageReview();
  assert.equal(reportButton.disabled, true);
  assert.match(nodes.get("[data-package-review]").innerHTML, /without a EUR value/);
});

test("package preview expands one payment into invoice rows while keeping exempt owner and tax rows out", () => {
  const entries = [
    {
      id: "synthetic-payment-123",
      transactionDate: "2026-10-18",
      paidDate: "2026-10-18",
      counterparty: "Synthetic Card Settlement",
      description: "Combined settlement",
      amount: "123.00",
      currency: "EUR",
      entryType: "expense",
      category: "Tools",
      statementRef: "Synthetic Business Account",
      allocations: [
        {
          id: "alloc-1",
          documentId: "synthetic-document-100",
          counterparty: "Synthetic Compute GmbH",
          description: "Dedicated cluster October",
          amount: "100.00",
          currency: "EUR",
          category: "Infrastructure",
          transactionDate: "2026-10-15",
        },
        {
          id: "alloc-2",
          documentId: "synthetic-document-20",
          counterparty: "Synthetic Domains Ltd",
          description: "Domain renewal",
          amount: "20.00",
          currency: "EUR",
          category: "Domains",
          transactionDate: "2026-10-16",
        },
        {
          id: "alloc-3",
          documentId: "synthetic-document-3",
          counterparty: "Synthetic Mail B.V.",
          description: "Transactional email usage",
          amount: "3.00",
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
      statementRef: "Synthetic Business Account",
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
      statementRef: "Synthetic Business Account",
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
      statementRef: "Synthetic Business Account",
    },
  ];

  assert.equal(isReportExempt(entries[1]), false);
  assert.equal(isReportExempt(entries[2]), true);
  assert.equal(isReportExempt(entries[3]), true);

  const reportRows = expandReportEntries(entries.filter((entry) => !isReportExempt(entry)));
  assert.equal(reportRows.length, 4, "three invoice children plus the ordinary consulting entry");
  assert.deepEqual(reportRows.slice(0, 3).map(({ counterparty, description, amount, sourceTransactionId }) =>
    [counterparty, description, amount, sourceTransactionId]), [
    ["Synthetic Compute GmbH", "Dedicated cluster October", "100.00", "synthetic-payment-123"],
    ["Synthetic Domains Ltd", "Domain renewal", "20.00", "synthetic-payment-123"],
    ["Synthetic Mail B.V.", "Transactional email usage", "3.00", "synthetic-payment-123"],
  ]);
  assert.equal(reportRows[3].counterparty, "Synthetic Tax Advisory GmbH");
  assert.equal(reportRows[3].amount, "238.00");
});


test("switching from a month to a year disables package creation", () => {
  let lens = "2026-10";
  const nodes = new Map([
    ["[data-package-review]", { innerHTML: "" }],
    ["[data-report-month]", { value: "" }],
    ["[data-report]", { disabled: true }],
  ]);
  const reports = createBookkeepingReports({
    escapeHtml, getAccounts: () => [], getDocuments: () => [], getLens: () => lens,
    getLinks: () => [], getReports: () => [], isReportExemptEntry: () => false,
    lensEntries: () => [], surface: { querySelector: (selector) => nodes.get(selector) },
  });
  reports.renderPackageReview();
  assert.equal(nodes.get("[data-report]").disabled, false);
  lens = "2026";
  reports.renderPackageReview();
  assert.equal(nodes.get("[data-report]").disabled, true);
  assert.match(nodes.get("[data-package-review]").innerHTML, /Choose a month/);
});
