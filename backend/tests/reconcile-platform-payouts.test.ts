import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { getClient } from "../src/db/client";
import { handleBookkeepingTransactionRoutes } from "../src/routes/bookkeepingTransactions";
import { buildReport } from "../src/reconcile/service";
import { createTables, startLocal, stopLocal } from "../scripts/local-dynamodb";

const event = (body: Record<string, unknown>) => ({ body: JSON.stringify(body), headers: {} });

describe("platform payout bookkeeping and reconcile report", () => {
  let client: DynamoDBDocumentClient;

  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
  });

  after(async () => {
    await stopLocal();
  });

  it("records a platform payout once and lists it for its income and added months", async () => {
    const payout = {
      transactionDate: "2026-10-01",
      counterparty: "Synthetic Learning Platform",
      description: "Synthetic affiliate payout",
      amount: "17.25",
      currency: "USD",
      entryType: "income",
      statementRef: "synthetic-ref-2026-10-01",
      comment: "Synthetic test payout from a test wallet.",
      incomePeriod: "2026-10",
      category: "Affiliate income",
      sourceType: "platform-payout",
      sourceKey: "platform-payout:synthetic-ref-2026-10-01",
    };

    const created = await handleBookkeepingTransactionRoutes(
      "/api/bookkeeping/transactions", "POST", event(payout), client,
    );
    assert.equal(created?.statusCode, 201);
    const record = JSON.parse(created!.body);
    assert.match(record.addedAt, /^\d{4}-\d{2}-\d{2}$/);

    const duplicate = await handleBookkeepingTransactionRoutes(
      "/api/bookkeeping/transactions", "POST", event(payout), client,
    );
    assert.equal(duplicate?.statusCode, 200);
    assert.equal(JSON.parse(duplicate!.body).id, record.id);

    const october = await buildReport(client, "2026-10");
    assert.deepEqual(october.platformPayouts.map((item) => [item.counterparty, item.amount, item.currency, item.reference]), [
      ["Synthetic Learning Platform", "17.25", "USD", "synthetic-ref-2026-10-01"],
    ]);
    assert.equal(october.platformPayouts[0].incomePeriod, "2026-10");
    assert.equal(october.platformPayouts[0].addedAt, record.addedAt);

    const late = {
      ...payout,
      transactionDate: "2000-08-01",
      counterparty: "Synthetic Course Platform",
      statementRef: "synthetic-late-reference-1",
      comment: "Synthetic late payout",
      incomePeriod: "2000-08",
      sourceKey: "platform-payout:synthetic-late-reference-1",
    };
    const lateResponse = await handleBookkeepingTransactionRoutes(
      "/api/bookkeeping/transactions", "POST", event(late), client,
    );
    assert.equal(lateResponse?.statusCode, 201);
    const lateRecord = JSON.parse(lateResponse!.body);
    const addedMonth = lateRecord.addedAt.slice(0, 7);
    assert.ok((await buildReport(client, "2000-08")).platformPayouts.some((item) => item.id === lateRecord.id));
    assert.ok((await buildReport(client, addedMonth)).platformPayouts.some((item) => item.id === lateRecord.id));
  });

  it("requires a valid income period and reference for platform payouts", async () => {
    const invalid = await handleBookkeepingTransactionRoutes(
      "/api/bookkeeping/transactions", "POST", event({
        transactionDate: "2026-10-01",
        counterparty: "Synthetic Platform",
        description: "Synthetic affiliate payout",
        amount: "1.00",
        currency: "USD",
        entryType: "income",
        sourceType: "platform-payout",
      }), client,
    );
    assert.equal(invalid?.statusCode, 400);
    assert.deepEqual(JSON.parse(invalid!.body).fields.sort(), ["incomePeriod", "sourceKey", "statementRef"]);
  });
});
