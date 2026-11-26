import assert from "node:assert/strict";
import { test } from "node:test";

import { escapeHtml } from "../src/core/html.js";
import {
  expandReportEntries,
  isReportExempt,
  selectReportEntries,
} from "../src/surfaces/finance/bookkeeping-format.js";
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

test("report rows expand one payment into invoice rows while keeping exempt owner and tax rows out", () => {
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

test("report children are classified on their own category and text, never on the payment's markers", () => {
  const payment = {
    id: "synthetic-mixed-payment",
    transactionDate: "2026-10-18",
    paidDate: "2026-10-18",
    counterparty: "Synthetic Card Settlement",
    description: "Combined settlement",
    amount: "240.00",
    currency: "EUR",
    entryType: "expense",
    category: "Health Insurance",
    subtype: "Insurance",
    mandatoryKind: "tk_debit",
    taxType: "health-insurance",
    ownerPayType: "unknown",
    vatAmount: "40.00",
    vatCurrency: "EUR",
    allocations: [
      {
        id: "alloc-software",
        documentId: "synthetic-document-1",
        invoiceNumber: "INV-1",
        counterparty: "Synthetic Software GmbH",
        description: "November seats",
        amount: "200.00",
        currency: "EUR",
        category: "Software",
      },
      {
        id: "alloc-tax",
        documentId: "synthetic-document-2",
        counterparty: "Finanzamt Example",
        description: "USt prepayment",
        amount: "40.00",
        currency: "EUR",
        vatAmount: "6.40",
        vatCurrency: "EUR",
      },
      { id: "alloc-incomplete", documentId: "synthetic-document-3" },
    ],
  };
  const { included, excluded } = selectReportEntries([payment], isReportExempt);

  // The incomplete allocation is not a row; the other two are classified one by one.
  assert.deepEqual(included.map(({ counterparty, amount, category, sourceTransactionId }) =>
    [counterparty, amount, category, sourceTransactionId]), [
    ["Synthetic Software GmbH", "200.00", "Software", "synthetic-mixed-payment"],
  ]);
  assert.deepEqual(excluded.map(({ counterparty, category, vatAmount }) =>
    [counterparty, category, vatAmount]), [
    ["Finanzamt Example", "Health Insurance", "6.40"],
  ]);
  // The listed child keeps the payment's id, carries no parent-only markers,
  // and has VAT only from its own allocation.
  const [child] = included;
  assert.equal(child.id, "synthetic-mixed-payment");
  for (const marker of ["mandatoryKind", "taxType", "ownerPayType", "kind", "allocations"])
    assert.equal(marker in child, false, marker);
  assert.equal(child.vatAmount, undefined);
  assert.equal(child.subtype, "Insurance");
  assert.equal(child.allocationDocumentId, "synthetic-document-1");

  // A payment whose saved allocations are all incomplete stays one ordinary row.
  const incomplete = { ...payment, allocations: [{ id: "alloc-incomplete", documentId: "synthetic-document-3" }] };
  assert.deepEqual(selectReportEntries([incomplete], () => false), {
    included: [incomplete],
    excluded: [],
  });
  assert.deepEqual(selectReportEntries([incomplete], () => true), { included: [], excluded: [incomplete] });
});

// ---- package preview --------------------------------------------------------

const statementDocuments = ["revolut", "finom"].map((accountId) => ({
  id: `${accountId}-statement`,
  documentType: "bank-statement",
  accountId,
  statementMonth: "2026-10",
  status: "active",
}));

function renderPreview({ entries, links = [], documents = [], reports = [] }) {
  const nodes = new Map([
    ["[data-package-review]", { innerHTML: "" }],
    ["[data-report-month]", { value: "" }],
    ["[data-report]", { disabled: true }],
  ]);
  createBookkeepingReports({
    api: async () => ({}),
    escapeHtml,
    getAccounts: () => ["revolut", "finom"].map((accountId) => ({
      id: accountId, displayName: accountId, kind: "business", active: true,
    })),
    getDocuments: () => [...statementDocuments, ...documents],
    getLens: () => "2026-10",
    getLinks: () => links,
    getReports: () => reports,
    // The surface's rule for entries without allocations, including its
    // finance-summary lookup: `tx-summary-tax` is mandatory only there.
    isReportExemptEntry: (entry) => isReportExempt(entry) || entry.id === "tx-summary-tax",
    lensEntries: () => entries,
    safeAction: async (action) => action(),
    surface: { querySelector: (selector) => nodes.get(selector) },
  }).renderPackageReview();
  return { markup: nodes.get("[data-package-review]").innerHTML, button: nodes.get("[data-report]") };
}

// [transactions, linked documents, entries kept out] as the preview line counts them.
function previewCounts(markup) {
  const preview = markup.match(/<p class="bookkeeping-package-preview">([\s\S]*?)<\/p>/)?.[1] || "";
  return [...preview.matchAll(/<span class="dk-mono">(\d+)<\/span>/g)].map((match) => Number(match[1]));
}

function document(id, overrides = {}) {
  return { id, documentType: "invoice", status: "active", ...overrides };
}

const mixedPayment = {
  id: "synthetic-card-settlement",
  transactionDate: "2026-10-18",
  paidDate: "2026-10-18",
  counterparty: "Synthetic Card Settlement",
  description: "Combined settlement",
  amount: "600.00",
  currency: "EUR",
  entryType: "expense",
  category: "Tools",
  allocations: [
    {
      id: "alloc-compute",
      documentId: "doc-compute",
      counterparty: "Synthetic Compute GmbH",
      description: "Dedicated cluster October",
      amount: "500.00",
      currency: "EUR",
      category: "Infrastructure",
    },
    {
      id: "alloc-mail",
      documentId: "doc-mail",
      counterparty: "Synthetic Mail B.V.",
      description: "Transactional email usage",
      amount: "40.00",
      currency: "EUR",
      category: "Tools",
    },
    {
      id: "alloc-health",
      documentId: "doc-health",
      counterparty: "Synthetic Health Insurance",
      description: "October premium",
      amount: "60.00",
      currency: "EUR",
      category: "Health Insurance",
    },
  ],
};

const ordinaryEntries = [
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
  },
  {
    id: "tx-summary-tax",
    transactionDate: "2026-10-22",
    paidDate: "2026-10-22",
    counterparty: "Synthetic Bank",
    description: "Sweep transfer",
    amount: "1500.00",
    currency: "EUR",
    entryType: "expense",
    category: "Bank",
  },
];

test("package preview lists reportable allocation children where an ordinary entry is still one row", () => {
  const { markup, button } = renderPreview({
    entries: [mixedPayment, ...ordinaryEntries],
    links: [
      { transactionId: "tx-consulting", documentId: "doc-consulting", coverageType: "evidence" },
      // Not attributable to any child of the allocated payment.
      { transactionId: "synthetic-card-settlement", documentId: "doc-payment-proof", coverageType: "evidence" },
    ],
    documents: [
      "doc-compute",
      "doc-mail",
      "doc-health",
      "doc-consulting",
      "doc-payment-proof",
    ].map((id) => document(id)),
  });

  // Two reportable children plus consulting; the consulting link and the two
  // children's allocation documents; the health child, the owner draw and the
  // summary-only mandatory entry.
  assert.deepEqual(previewCounts(markup), [3, 3, 3]);
  assert.match(markup, /3<\/span>&nbsp;transactions/);
  assert.doesNotMatch(markup, /without a EUR value/);
  assert.equal(button.disabled, false);
});

test("package preview lists the reportable child of a payment whose own markers are exempt", () => {
  const { markup, button } = renderPreview({
    entries: [
      {
        id: "synthetic-mandatory-payment",
        transactionDate: "2026-10-18",
        paidDate: "2026-10-18",
        counterparty: "Synthetic Card Settlement",
        description: "Split settlement",
        amount: "160.00",
        currency: "EUR",
        entryType: "expense",
        category: "Health Insurance",
        mandatoryKind: "tk_debit",
        allocations: [
          {
            id: "alloc-health",
            documentId: "doc-health",
            counterparty: "Synthetic Health Insurance",
            description: "October premium",
            amount: "60.00",
            currency: "EUR",
            category: "Health Insurance",
          },
          {
            id: "alloc-software",
            documentId: "doc-software",
            counterparty: "Synthetic Software GmbH",
            description: "November seats",
            amount: "100.00",
            currency: "EUR",
            category: "Software",
          },
        ],
      },
    ],
    documents: [document("doc-health"), document("doc-software")],
  });

  assert.equal(isReportExempt({ category: "Health Insurance", mandatoryKind: "tk_debit" }), true);
  assert.deepEqual(previewCounts(markup), [1, 1, 1]);
  assert.equal(button.disabled, false);
});

test("package preview keeps a payment out only when every child is kept out", () => {
  const { markup, button } = renderPreview({
    entries: [
      {
        id: "synthetic-tax-payment",
        transactionDate: "2026-10-18",
        paidDate: "2026-10-18",
        counterparty: "Synthetic Card Settlement",
        description: "Tax settlement",
        amount: "90.00",
        currency: "EUR",
        entryType: "expense",
        category: "Bank",
        allocations: [
          {
            id: "alloc-vat",
            documentId: "doc-vat",
            counterparty: "Synthetic Card Settlement",
            description: "USt prepayment",
            amount: "50.00",
            currency: "EUR",
            category: "VAT",
          },
          {
            id: "alloc-health",
            documentId: "doc-health",
            counterparty: "Techniker Krankenkasse Example",
            description: "October premium",
            amount: "40.00",
            currency: "EUR",
          },
        ],
      },
    ],
    documents: [document("doc-vat"), document("doc-health")],
  });

  assert.deepEqual(previewCounts(markup), [0, 0, 2]);
  assert.equal(button.disabled, false);
});

test("package preview checks EUR values on reportable children, not on the payment", () => {
  const usdPayment = {
    id: "synthetic-usd-payment",
    transactionDate: "2026-10-18",
    paidDate: "2026-10-18",
    counterparty: "Synthetic Card Settlement",
    description: "USD settlement",
    amount: "300.00",
    currency: "USD",
    amountEur: "250.00",
    entryType: "expense",
    category: "Tools",
    allocations: [
      {
        id: "alloc-converted",
        documentId: "doc-converted",
        counterparty: "Synthetic Compute GmbH",
        description: "Cluster",
        amount: "150.00",
        currency: "USD",
        amountEur: "125.00",
      },
      {
        id: "alloc-unconverted",
        documentId: "doc-unconverted",
        counterparty: "Synthetic Mail B.V.",
        description: "Email usage",
        amount: "150.00",
        currency: "USD",
      },
    ],
  };

  // The payment itself has an EUR value; its unconverted reportable child blocks the package.
  const blocked = renderPreview({
    entries: [usdPayment],
    documents: [document("doc-converted"), document("doc-unconverted")],
  });
  assert.equal(blocked.button.disabled, true);
  assert.match(blocked.markup, /1 transaction without a EUR value/);
  assert.deepEqual(previewCounts(blocked.markup), [2, 2, 0]);

  // An exempt child without an EUR value is kept out and does not block.
  const exemptChild = {
    ...usdPayment,
    allocations: [
      usdPayment.allocations[0],
      { ...usdPayment.allocations[1], category: "Taxes" },
    ],
  };
  const allowed = renderPreview({
    entries: [exemptChild],
    documents: [document("doc-converted"), document("doc-unconverted")],
  });
  assert.equal(allowed.button.disabled, false);
  assert.doesNotMatch(allowed.markup, /without a EUR value/);
  assert.deepEqual(previewCounts(allowed.markup), [1, 1, 1]);
});

test("package preview counts only active allocation documents and no parent-level links of an allocated payment", () => {
  const { markup, button } = renderPreview({
    entries: [
      {
        id: "synthetic-evidence-payment",
        transactionDate: "2026-10-18",
        paidDate: "2026-10-18",
        counterparty: "Synthetic Card Settlement",
        description: "Evidence settlement",
        amount: "120.00",
        currency: "EUR",
        entryType: "expense",
        category: "Tools",
        allocations: [
          {
            id: "alloc-voided",
            documentId: "doc-voided",
            counterparty: "Synthetic Voided GmbH",
            description: "Voided invoice",
            amount: "100.00",
            currency: "EUR",
          },
          {
            id: "alloc-live",
            documentId: "doc-live",
            counterparty: "Synthetic Live GmbH",
            description: "Live invoice",
            amount: "20.00",
            currency: "EUR",
          },
        ],
      },
    ],
    links: [
      { transactionId: "synthetic-evidence-payment", documentId: "doc-parent-link", coverageType: "evidence" },
      // The payment's id is shared with its children; its links stay theirs.
      { transactionId: "synthetic-evidence-payment", documentId: "doc-live", coverageType: "evidence" },
    ],
    documents: [
      document("doc-voided", { status: "voided" }),
      document("doc-live"),
      document("doc-parent-link"),
    ],
  });

  assert.deepEqual(previewCounts(markup), [2, 1, 0]);
  assert.equal(button.disabled, false);
});

test("a package ready without stored counts falls back to the reportable rows", () => {
  const { markup } = renderPreview({
    entries: [mixedPayment, ...ordinaryEntries],
    documents: ["doc-compute", "doc-mail", "doc-health"].map((id) => document(id)),
    reports: [{ id: "report-1", month: "2026-10", status: "ready", transactionIds: ["synthetic-card-settlement"] }],
  });

  assert.match(markup, /Package ready\./);
  assert.match(markup, /<span class="dk-mono">3<\/span>&nbsp;transactions/);
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
