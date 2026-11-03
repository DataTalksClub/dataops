import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { getClient } from "../src/db/client";
import { handleBookkeepingTransactionRoutes } from "../src/routes/bookkeepingTransactions";
import { buildReport } from "../src/reconcile/service";
import { summarize } from "../src/finance/summary";
import { createTables, startLocal, stopLocal } from "../scripts/local-dynamodb";

const event = (body: Record<string, unknown>) => ({ body: JSON.stringify(body), headers: {} });
const post = (client: DynamoDBDocumentClient, body: Record<string, unknown>) =>
  handleBookkeepingTransactionRoutes("/api/bookkeeping/transactions", "POST", event(body), client);

const creditNote = {
  transactionDate: "2026-10-15",
  counterparty: "Synthetic Marketplace",
  description: "Synthetic credit note for a returned ticket, credited to the vendor balance.",
  amount: "59.99",
  currency: "EUR",
  entryType: "expense",
  subtype: "Refund",
  statementRef: "SYN-CREDIT-NOTE-0001",
  comment: "Synthetic credit note SYN-CREDIT-NOTE-0001, credited to the vendor balance, no bank transaction.",
  category: "Refund",
  sourceType: "credit-note",
  sourceKey: "credit-note:SYN-CREDIT-NOTE-0001",
};

describe("vendor credit note bookkeeping", () => {
  let client: DynamoDBDocumentClient;

  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
  });

  after(async () => {
    await stopLocal();
  });

  it("records a credit note once, stamps addedAt, and never lists it as a platform payout", async () => {
    const created = await post(client, creditNote);
    assert.equal(created?.statusCode, 201);
    const record = JSON.parse(created!.body);
    assert.match(record.addedAt, /^\d{4}-\d{2}-\d{2}$/);

    const duplicate = await post(client, creditNote);
    assert.equal(duplicate?.statusCode, 200);
    assert.equal(JSON.parse(duplicate!.body).id, record.id);

    const october = await buildReport(client, "2026-10");
    assert.deepEqual(october.platformPayouts, []);

    const rows = JSON.parse(
      (await handleBookkeepingTransactionRoutes("/api/bookkeeping/transactions", "GET", { headers: {} }, client))!.body,
    ).items as Array<Record<string, unknown>>;
    const summary = summarize({
      today: "2026-10-31",
      query: { month: "2026-10" },
      rates: () => null,
      rows,
    });
    const entry = summary.entries.find((item) => item.id === record.id)!;
    assert.equal(entry.refund, true);
    assert.equal(summary.totals.operatingExpenses, -59.99);
    assert.equal(summary.totals.operatingIncome, 0);
    assert.equal(summary.totals.moneyIn, 0);
    assert.equal(summary.totals.netProfitExVat, 59.99);
  });

  it("updates a credit note's free fields but rejects re-typing it as income", async () => {
    const created = await post(client, { ...creditNote, statementRef: "SYN-CREDIT-NOTE-0002", sourceKey: "credit-note:SYN-CREDIT-NOTE-0002" });
    assert.equal(created?.statusCode, 201);
    const record = JSON.parse(created!.body);

    const retyped = await handleBookkeepingTransactionRoutes(
      `/api/bookkeeping/transactions/${record.id}`, "PUT",
      event({ entryType: "income" }), client,
    );
    assert.equal(retyped?.statusCode, 400);
    assert.deepEqual(JSON.parse(retyped!.body).fields, ["entryType"]);

    const reworded = await handleBookkeepingTransactionRoutes(
      `/api/bookkeeping/transactions/${record.id}`, "PUT",
      event({ comment: "Synthetic credit note, corrected wording." }), client,
    );
    assert.equal(reworded?.statusCode, 200);
    assert.equal(JSON.parse(reworded!.body).subtype, "Refund");
  });

  it("rejects a misclassified or incomplete credit note", async () => {
    const cases: Array<[Record<string, unknown>, string[]]> = [
      [{ ...creditNote, statementRef: "SYN-CREDIT-NOTE-BAD1", sourceKey: "credit-note:SYN-CREDIT-NOTE-BAD1", entryType: "income" }, ["entryType"]],
      [{ ...creditNote, statementRef: "SYN-CREDIT-NOTE-BAD2", sourceKey: "platform-payout:SYN-CREDIT-NOTE-BAD2" }, ["sourceKey"]],
      [{ ...creditNote, statementRef: "SYN-CREDIT-NOTE-BAD3", sourceKey: "credit-note:" }, ["sourceKey"]],
      [{ ...creditNote, statementRef: "SYN-CREDIT-NOTE-BAD4", sourceKey: "credit-note:SYN-CREDIT-NOTE-BAD4", subtype: "Payout" }, ["subtype"]],
      [{ ...creditNote, statementRef: "SYN-CREDIT-NOTE-BAD5", sourceKey: "credit-note:SYN-CREDIT-NOTE-BAD5", amount: "0.00" }, ["amount"]],
    ];
    for (const [body, fields] of cases) {
      const response = await post(client, body);
      assert.equal(response?.statusCode, 400, JSON.stringify(fields));
      assert.deepEqual(JSON.parse(response!.body).fields.sort(), fields.sort());
    }
  });

  it("still validates platform payouts and ignores credit-note fields for them", async () => {
    const invalid = await post(client, {
      transactionDate: "2026-10-01",
      counterparty: "Synthetic Platform",
      description: "Synthetic affiliate payout",
      amount: "1.00",
      currency: "USD",
      entryType: "income",
      subtype: "Refund",
      sourceType: "platform-payout",
    });
    assert.equal(invalid?.statusCode, 400);
    assert.deepEqual(JSON.parse(invalid!.body).fields.sort(), ["incomePeriod", "sourceKey", "statementRef"]);
  });
});
