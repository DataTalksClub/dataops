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

test("report children are classified on their own category and text, never on the payment's markers or reference", () => {
  const payment = {
    id: "synthetic-mixed-payment", transactionDate: "2026-10-18", paidDate: "2026-10-18",
    counterparty: "Synthetic Card Settlement", description: "Combined settlement",
    amount: "240.00", currency: "EUR", entryType: "expense", category: "Health Insurance",
    subtype: "Insurance", mandatoryKind: "tk_debit", taxType: "health-insurance", ownerPayType: "unknown",
    reference: "Finanzamt monthly statement", statementRef: "Synthetic Bank", vatAmount: "40.00", vatCurrency: "EUR",
    allocations: [
      { id: "alloc-software", documentId: "synthetic-document-1", invoiceNumber: "INV-1", counterparty: "Synthetic Software GmbH", description: "Hosting", amount: "200.00", currency: "EUR", category: "Software" },
      { id: "alloc-tax", documentId: "synthetic-document-2", counterparty: "Finanzamt Example", description: "USt prepayment", amount: "40.00", currency: "EUR", vatAmount: "6.40", vatCurrency: "EUR" },
      { id: "alloc-incomplete", documentId: "synthetic-document-3" },
    ],
  };
  const { included, excluded } = selectReportEntries([payment], isReportExempt);

  assert.deepEqual(included.map((r) => [r.counterparty, r.amount, r.category, r.sourceTransactionId]), [
    ["Synthetic Software GmbH", "200.00", "Software", "synthetic-mixed-payment"],
  ]);
  assert.deepEqual(excluded.map((r) => [r.counterparty, r.category, r.vatAmount]), [
    ["Finanzamt Example", "Health Insurance", "6.40"],
  ]);
  const [child] = included;
  assert.equal(child.id, "synthetic-mixed-payment");
  for (const marker of ["mandatoryKind", "taxType", "ownerPayType", "kind", "reference", "allocations"])
    assert.equal(marker in child, false, marker);
  assert.equal(child.statementRef, "Synthetic Bank");
  assert.equal(child.vatAmount, undefined);
  assert.equal(child.subtype, "Insurance");
  assert.equal(child.allocationDocumentId, "synthetic-document-1");

  // Parent reference "Finanzamt monthly statement" must not drop a Software/Hosting child,
  // while an ordinary row with that reference stays exempt when the caller checks reference.
  const refPayment = {
    id: "mixed-ref", transactionDate: "2026-10-18", counterparty: "Card", description: "Combined",
    amount: "50.00", currency: "EUR", entryType: "expense", category: "Taxes",
    reference: "Finanzamt monthly statement", statementRef: "Synthetic Bank",
    allocations: [
      { id: "a1", documentId: "d1", counterparty: "Synthetic Host", description: "Hosting", amount: "20.00", currency: "EUR", category: "Software" },
      { id: "a2", documentId: "d2", counterparty: "Finanzamt Example", description: "Tax portion", amount: "30.00", currency: "EUR", category: "Taxes" },
    ],
  };
  const ordinaryWithRef = {
    id: "ordinary-ref", transactionDate: "2026-10-18", counterparty: "Other", description: "Fee",
    amount: "15.00", currency: "EUR", entryType: "expense", category: "Other", reference: "Finanzamt monthly statement",
  };
  const isExemptWithRef = (e) => isReportExempt(e) || /finanzamt/i.test(String(e?.reference || ""));
  const refResult = selectReportEntries([refPayment, ordinaryWithRef], isExemptWithRef);
  assert.deepEqual(refResult.included.map((r) => [r.counterparty, r.amount, r.statementRef]), [
    ["Synthetic Host", "20.00", "Synthetic Bank"],
  ]);
  assert.equal(refResult.excluded.length, 2);

  // A payment whose saved allocations are all incomplete stays one ordinary row.
  const incomplete = { ...payment, allocations: [{ id: "alloc-incomplete", documentId: "synthetic-document-3" }] };
  assert.deepEqual(selectReportEntries([incomplete], () => false), { included: [incomplete], excluded: [] });
  assert.deepEqual(selectReportEntries([incomplete], () => true), { included: [], excluded: [incomplete] });
});

// ---- package preview --------------------------------------------------------

const statementDocuments = ["revolut", "finom"].map((accountId) => ({
  id: `${accountId}-statement`, documentType: "bank-statement", accountId, statementMonth: "2026-10", status: "active",
}));
const doc = (id, overrides = {}) => ({ id, documentType: "invoice", status: "active", ...overrides });
const alloc = (id, documentId, counterparty, description, amount, extra = {}) => ({
  id, documentId, counterparty, description, amount, currency: "EUR", ...extra,
});
const tx = (id, counterparty, description, amount, category, extra = {}) => ({
  id, transactionDate: "2026-10-18", paidDate: "2026-10-18", counterparty, description,
  amount, currency: "EUR", entryType: "expense", category, ...extra,
});

function renderPreview({ entries, links = [], documents = [], reports = [] }) {
  const nodes = new Map([
    ["[data-package-review]", { innerHTML: "" }],
    ["[data-report-month]", { value: "" }],
    ["[data-report]", { disabled: true }],
  ]);
  createBookkeepingReports({
    api: async () => ({}),
    escapeHtml,
    getAccounts: () => ["revolut", "finom"].map((id) => ({ id, displayName: id, kind: "business", active: true })),
    getDocuments: () => [...statementDocuments, ...documents],
    getLens: () => "2026-10",
    getLinks: () => links,
    getReports: () => reports,
    isReportExemptEntry: (entry) => isReportExempt(entry) || entry.id === "tx-summary-tax",
    lensEntries: () => entries,
    safeAction: async (action) => action(),
    surface: { querySelector: (selector) => nodes.get(selector) },
  }).renderPackageReview();
  return { markup: nodes.get("[data-package-review]").innerHTML, button: nodes.get("[data-report]") };
}

function previewCounts(markup) {
  const preview = markup.match(/<p class="bookkeeping-package-preview">([\s\S]*?)<\/p>/)?.[1] || "";
  return [...preview.matchAll(/<span class="dk-mono">(\d+)<\/span>/g)].map((m) => Number(m[1]));
}

const mixedPayment = tx("synthetic-card-settlement", "Synthetic Card Settlement", "Combined settlement", "600.00", "Tools", {
  allocations: [
    alloc("alloc-compute", "doc-compute", "Synthetic Compute GmbH", "Dedicated cluster October", "500.00", { category: "Infrastructure" }),
    alloc("alloc-mail", "doc-mail", "Synthetic Mail B.V.", "Transactional email usage", "40.00", { category: "Tools" }),
    alloc("alloc-health", "doc-health", "Synthetic Health Insurance", "October premium", "60.00", { category: "Health Insurance" }),
  ],
});
const ordinaryEntries = [
  tx("tx-consulting", "Synthetic Tax Advisory GmbH", "Monthly compliance consulting fee", "238.00", "Compliance & Taxes"),
  tx("tx-owner", "Owner Person", "Owner withdrawal", "1200.00", "Owner pay", { ownerPayType: "draw" }),
  tx("tx-summary-tax", "Synthetic Bank", "Sweep transfer", "1500.00", "Bank"),
];

test("package preview lists reportable children, active allocation docs, and ignores parent links", () => {
  const { markup, button } = renderPreview({
    entries: [mixedPayment, ...ordinaryEntries],
    links: [
      { transactionId: "tx-consulting", documentId: "doc-consulting", coverageType: "evidence" },
      { transactionId: "synthetic-card-settlement", documentId: "doc-payment-proof", coverageType: "evidence" },
    ],
    documents: ["doc-compute", "doc-mail", "doc-health", "doc-consulting", "doc-payment-proof"].map((id) => doc(id)),
  });
  assert.deepEqual(previewCounts(markup), [3, 3, 3]);
  assert.doesNotMatch(markup, /without a EUR value/);
  assert.equal(button.disabled, false);

  // Counts only active allocation documents (voided excluded) and no parent-level links.
  const voidedCheck = renderPreview({
    entries: [tx("synthetic-evidence-payment", "Card", "Settlement", "120.00", "Tools", {
      allocations: [
        alloc("a-void", "doc-voided", "Voided GmbH", "Voided", "100.00"),
        alloc("a-live", "doc-live", "Live GmbH", "Live", "20.00"),
      ],
    })],
    links: [
      { transactionId: "synthetic-evidence-payment", documentId: "doc-parent-link", coverageType: "evidence" },
      { transactionId: "synthetic-evidence-payment", documentId: "doc-live", coverageType: "evidence" },
    ],
    documents: [doc("doc-voided", { status: "voided" }), doc("doc-live"), doc("doc-parent-link")],
  });
  assert.deepEqual(previewCounts(voidedCheck.markup), [2, 1, 0]);
  assert.equal(voidedCheck.button.disabled, false);
});

test("package preview handles exempt parent markers/reference, all-exempt children, and ready fallback", () => {
  const exemptParent = renderPreview({
    entries: [tx("p-exempt", "Card", "Split", "160.00", "Health Insurance", {
      mandatoryKind: "tk_debit", reference: "Finanzamt monthly statement",
      allocations: [
        alloc("a-h", "doc-health", "Health", "Premium", "60.00", { category: "Health Insurance" }),
        alloc("a-s", "doc-software", "Software GmbH", "Hosting", "100.00", { category: "Software" }),
      ],
    })],
    documents: [doc("doc-health"), doc("doc-software")],
  });
  assert.deepEqual(previewCounts(exemptParent.markup), [1, 1, 1]);
  assert.equal(exemptParent.button.disabled, false);

  const allExempt = renderPreview({
    entries: [tx("p-all-exempt", "Card", "Tax settlement", "90.00", "Bank", {
      allocations: [
        alloc("a-v", "doc-vat", "Card", "USt prepayment", "50.00", { category: "VAT" }),
        alloc("a-tk", "doc-tk", "Techniker Krankenkasse Example", "October premium", "40.00"),
      ],
    })],
    documents: [doc("doc-vat"), doc("doc-tk")],
  });
  assert.deepEqual(previewCounts(allExempt.markup), [0, 0, 2]);
  assert.equal(allExempt.button.disabled, false);

  const readyFallback = renderPreview({
    entries: [mixedPayment, ...ordinaryEntries],
    documents: ["doc-compute", "doc-mail", "doc-health"].map((id) => doc(id)),
    reports: [{ id: "report-1", month: "2026-10", status: "ready", transactionIds: ["synthetic-card-settlement"] }],
  });
  assert.match(readyFallback.markup, /Package ready\./);
  assert.match(readyFallback.markup, /<span class="dk-mono">3<\/span>&nbsp;transactions/);
});

test("package preview checks EUR values on reportable children, not on the payment", () => {
  const usdPayment = tx("synthetic-usd-payment", "Card", "USD settlement", "300.00", "Tools", {
    currency: "USD", amountEur: "250.00",
    allocations: [
      alloc("a-conv", "doc-converted", "Compute GmbH", "Cluster", "150.00", { currency: "USD", amountEur: "125.00" }),
      alloc("a-unconv", "doc-unconverted", "Mail B.V.", "Email", "150.00", { currency: "USD" }),
    ],
  });
  const blocked = renderPreview({ entries: [usdPayment], documents: [doc("doc-converted"), doc("doc-unconverted")] });
  assert.equal(blocked.button.disabled, true);
  assert.match(blocked.markup, /1 transaction without a EUR value/);
  assert.deepEqual(previewCounts(blocked.markup), [2, 2, 0]);

  const allowed = renderPreview({
    entries: [{ ...usdPayment, allocations: [usdPayment.allocations[0], { ...usdPayment.allocations[1], category: "Taxes" }] }],
    documents: [doc("doc-converted"), doc("doc-unconverted")],
  });
  assert.equal(allowed.button.disabled, false);
  assert.doesNotMatch(allowed.markup, /without a EUR value/);
  assert.deepEqual(previewCounts(allowed.markup), [1, 1, 1]);
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
