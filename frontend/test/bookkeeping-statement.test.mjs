import assert from "node:assert/strict";
import { test } from "node:test";

import {
  statementLinkForTransaction,
  unmatchedStatementCandidates,
} from "../src/surfaces/finance/bookkeeping-statement.js";

const transaction = {
  id: "tx-1",
  transactionDate: "2026-09-12",
  entryType: "expense",
  counterparty: "Go Daddy",
  amount: "178.49",
  currency: "EUR",
};

const bank = {
  key: "revolut|row-1",
  accountId: "revolut",
  statementId: "statement-1",
  date: "2026-09-12",
  amount: "-178.49",
  currency: "EUR",
  counterparty: "Go Daddy",
  reference: ".COM Domain Registration",
};

test("a matched ledger row resolves its real statement and exact source line", () => {
  const month = {
    period: "2026-09",
    rows: [{ id: bank.key, ledger: { id: transaction.id }, bank }],
  };
  const statement = {
    statement: {
      id: "statement-1",
      accountId: "revolut",
      period: "2026-09",
      documentId: "document-1",
      filename: "revolut-september.csv",
      contentType: "text/csv",
      rows: [
        {
          date: "2026-09-10",
          amount: "-5.00",
          currency: "EUR",
          counterparty: "Coffee Shop",
        },
        {
          date: bank.date,
          amount: bank.amount,
          currency: bank.currency,
          counterparty: bank.counterparty,
          reference: bank.reference,
        },
      ],
    },
  };

  assert.deepEqual(statementLinkForTransaction(transaction, [month], statement), {
    accountId: "revolut",
    accountLabel: "Revolut Business EUR",
    statementId: "statement-1",
    statementPeriod: "2026-09",
    statementDocumentId: "document-1",
    statementFilename: "revolut-september.csv",
    statementContentType: "text/csv",
    bankKey: "revolut|row-1",
    line: {
      date: "2026-09-12",
      amount: "-178.49",
      currency: "EUR",
      counterparty: "Go Daddy",
      reference: ".COM Domain Registration",
    },
    statementRowIndex: 1,
  });
});

test("statement line index stays unknown when identical source rows are ambiguous", () => {
  const month = {
    rows: [{ id: bank.key, ledger: { id: transaction.id }, bank }],
  };
  const statement = {
    id: "statement-1",
    accountId: "revolut",
    period: "2026-09",
    rows: [
      { date: bank.date, amount: bank.amount, currency: bank.currency, counterparty: bank.counterparty, reference: bank.reference },
      { date: bank.date, amount: bank.amount, currency: bank.currency, counterparty: bank.counterparty, reference: bank.reference },
    ],
  };

  assert.equal(statementLinkForTransaction(transaction, month, statement)?.statementRowIndex, null);
});

test("statement link requires a unique matched row and the corresponding statement", () => {
  const paired = { id: bank.key, ledger: { id: transaction.id }, bank };
  const competingPair = {
    ...paired,
    id: "revolut|row-2",
    bank: { ...bank, key: "revolut|row-2" },
  };
  assert.equal(statementLinkForTransaction(transaction, { rows: [paired, competingPair] }, {
    id: "statement-1", accountId: "revolut", period: "2026-09", rows: [],
  }), null);
  assert.equal(statementLinkForTransaction(transaction, { rows: [paired] }, {
    id: "statement-other", accountId: "revolut", period: "2026-09", rows: [],
  }), null);
  assert.equal(statementLinkForTransaction(transaction, { rows: [paired] }, null), null);
});

test("manual statement picker shows only nearby exact amount and direction candidates", () => {
  const views = [
    {
      period: "2026-09",
      rows: [
        { id: "far", bank: { ...bank, key: "far", date: "2026-09-23" } },
        { id: "near", bank: { ...bank, key: "near", date: "2026-09-11" } },
        { id: "wrong-amount", bank: { ...bank, key: "wrong-amount", amount: "-178.48" } },
        { id: "wrong-direction", bank: { ...bank, key: "wrong-direction", amount: "178.49" } },
        { id: "already-paired", bank, ledger: { id: "other-tx" } },
        { id: "missing-statement", bank: { ...bank, key: "missing-statement", statementId: "" } },
      ],
    },
  ];

  const candidates = unmatchedStatementCandidates(transaction, views);
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0], {
    bankKey: "near",
    period: "2026-09",
    statementId: "statement-1",
    accountId: "revolut",
    accountLabel: "Revolut Business EUR",
    line: {
      date: "2026-09-11",
      amount: "-178.49",
      currency: "EUR",
      counterparty: "Go Daddy",
      reference: ".COM Domain Registration",
    },
    gapDays: 1,
  });
});

test("manual statement picker can match exact EUR conversion for a foreign transaction", () => {
  const foreign = { ...transaction, currency: "USD", amount: "200.00", amountEur: "178.49" };
  const candidates = unmatchedStatementCandidates(foreign, {
    rows: [{ id: bank.key, bank }],
  });
  assert.equal(candidates.length, 1);
});
