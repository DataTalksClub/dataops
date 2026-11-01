import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AUTO_MATCH_DATE_WINDOW_DAYS,
  normalizedAutoMatchVendor,
  planEvidenceAutoMatches,
  type AutoMatchDocument,
  type AutoMatchTransaction,
} from "../src/bookkeepingAutoMatch";

function transaction(
  id: string,
  overrides: Partial<AutoMatchTransaction> = {},
): AutoMatchTransaction {
  return {
    id,
    transactionDate: "2026-09-12",
    counterparty: "Go Daddy",
    amount: "178.49",
    currency: "EUR",
    entryType: "expense",
    ...overrides,
  };
}

function document(
  id: string,
  overrides: Partial<AutoMatchDocument> = {},
): AutoMatchDocument {
  return {
    id,
    status: "active",
    documentType: "invoice",
    facts: {
      counterparty: "GoDaddy",
      amount: "178.49",
      currency: "EUR",
      transactionDate: "2026-09-10",
    },
    ...overrides,
  };
}

describe("strict bookkeeping evidence auto-matching", () => {
  it("normalizes known company aliases and leaves unknown names exact", () => {
    const groups = [
      ["AWS EMEA SARL", "Amazon Web Services EMEA SARL"],
      ["Google Workspace", "Google One"],
      ["X Corp", "X Internet Unlimited Company"],
      ["Go Daddy", "GoDaddy"],
      ["OpenAI LLC", "ChatGPT"],
    ];
    for (const [left, right] of groups) {
      assert.equal(normalizedAutoMatchVendor(left), normalizedAutoMatchVendor(right));
    }
    assert.notEqual(normalizedAutoMatchVendor("Local Print Shop"), normalizedAutoMatchVendor("Local Printer"));
  });

  it("matches exact amount, currency and vendor within the date window", () => {
    const matches = planEvidenceAutoMatches(
      [transaction("tx-1")],
      [document("doc-1")],
      [],
    );
    assert.deepEqual(matches, [
      {
        transactionId: "tx-1",
        documentId: "doc-1",
        dateGapDays: 2,
        amount: "178.49",
        currency: "EUR",
      },
    ]);

    const atWindowEdge = planEvidenceAutoMatches(
      [transaction("tx-edge")],
      [
        document("doc-edge", {
          facts: {
            counterparty: "GoDaddy",
            amount: "178.49",
            currency: "EUR",
            transactionDate: "2026-09-02",
          },
        }),
      ],
      [],
    );
    assert.equal(atWindowEdge[0]?.dateGapDays, AUTO_MATCH_DATE_WINDOW_DAYS);
  });

  it("matches EUR invoice amounts to an exact EUR conversion", () => {
    const matches = planEvidenceAutoMatches(
      [transaction("tx-usd", { amount: "200.00", currency: "USD", amountEur: "178.49" })],
      [document("doc-eur")],
      [],
    );
    assert.equal(matches.length, 1);
    assert.equal(matches[0].currency, "EUR");
  });

  it("rejects near amounts, currency mismatches, wrong vendors, missing dates and distant dates", () => {
    const cases: Array<[string, AutoMatchTransaction, AutoMatchDocument]> = [
      ["near amount", transaction("tx-1"), document("doc-1", { facts: { ...document("d").facts, amount: "178.48" } })],
      ["wrong currency", transaction("tx-2"), document("doc-2", { facts: { ...document("d").facts, currency: "USD" } })],
      ["wrong vendor", transaction("tx-3"), document("doc-3", { facts: { ...document("d").facts, counterparty: "Different Vendor" } })],
      ["missing date", transaction("tx-4"), document("doc-4", { facts: { counterparty: "GoDaddy", amount: "178.49", currency: "EUR" } })],
      ["distant date", transaction("tx-5"), document("doc-5", { facts: { ...document("d").facts, transactionDate: "2026-08-31" } })],
    ];

    for (const [name, tx, invoice] of cases) {
      assert.deepEqual(planEvidenceAutoMatches([tx], [invoice], []), [], name);
    }
  });

  it("does not attach inactive, unsupported, review-flagged or already linked documents", () => {
    const docs = [
      document("inactive", { status: "pending" }),
      document("unsupported", { documentType: "bank-statement" }),
      document("review", { facts: { ...document("d").facts, extraction: { needsReview: true } } }),
      document("linked"),
    ];
    const links = [{ transactionId: "other-tx", documentId: "linked", coverageType: "evidence" }];
    assert.deepEqual(planEvidenceAutoMatches([transaction("tx-1")], docs, links), []);
  });

  it("does not attach an invoice to the opposite transaction direction", () => {
    assert.deepEqual(
      planEvidenceAutoMatches(
        [transaction("tx-expense")],
        [document("credit-note", {
          facts: {
            ...document("d").facts,
            extraction: { documentType: "credit_note", direction: "income", needsReview: false },
          },
        })],
        [],
      ),
      [],
    );
  });

  it("does not reattach rows or documents that already have evidence links", () => {
    const linkedTransaction = [{ transactionId: "tx-1", documentId: "doc-other", coverageType: "evidence" }];
    const linkedDocument = [{ transactionId: "tx-other", documentId: "doc-1", coverageType: "evidence" }];
    assert.deepEqual(
      planEvidenceAutoMatches([transaction("tx-1")], [document("doc-1")], linkedTransaction),
      [],
    );
    assert.deepEqual(
      planEvidenceAutoMatches([transaction("tx-1")], [document("doc-1")], linkedDocument),
      [],
    );
  });

  it("leaves sponsor-finance-claimed transactions unchanged", () => {
    assert.deepEqual(
      planEvidenceAutoMatches(
        [transaction("tx-claimed", { sponsorDealId: "deal-1" })],
        [document("doc-1")],
        [],
      ),
      [],
    );
  });

  it("leaves tied candidates unmatched and only accepts mutual closest pairs", () => {
    const tied = planEvidenceAutoMatches(
      [transaction("tx-1")],
      [document("doc-a"), document("doc-b")],
      [],
    );
    assert.deepEqual(tied, []);

    const mutual = planEvidenceAutoMatches(
      [transaction("tx-1"), transaction("tx-2", { transactionDate: "2026-09-19" })],
      [
        document("doc-a"),
        document("doc-b", { facts: { ...document("d").facts, transactionDate: "2026-09-18" } }),
      ],
      [],
    );
    assert.deepEqual(mutual.map(({ transactionId, documentId }) => [transactionId, documentId]), [
      ["tx-1", "doc-a"],
      ["tx-2", "doc-b"],
    ]);
  });
});
