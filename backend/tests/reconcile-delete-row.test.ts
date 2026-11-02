import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { getClient } from "../src/db/client";
import { handleBookkeepingTransactionRoutes } from "../src/routes/bookkeepingTransactions";
import { createDocumentLink, getBookkeepingItem, putBookkeepingItem } from "../src/db/bookkeeping";
import { buildReport } from "../src/reconcile/service";
import { buildMonth, deleteLedgerRow } from "../src/reconcile/monthService";
import { createTables, startLocal, stopLocal } from "../scripts/local-dynamodb";

const payout = (sourceKey: string, over: Record<string, unknown> = {}) => ({
  transactionDate: "2026-10-01", paidDate: "2026-10-01", counterparty: "Synthetic Course Platform", description: "Synthetic payout",
  amount: "48.32", currency: "USD", entryType: "income", incomePeriod: "2026-10", category: "Affiliate income",
  sourceType: "platform-payout", statementRef: `ref-${sourceKey}`, sourceKey, ...over,
});

describe("reconcile delete-row", () => {
  let client: DynamoDBDocumentClient;
  before(async () => { client = await getClient(await startLocal()); await createTables(client); });
  after(async () => { await stopLocal(); });

  const create = async (body: Record<string, unknown>) => {
    const response = await handleBookkeepingTransactionRoutes("/api/bookkeeping/transactions", "POST", { body: JSON.stringify(body), headers: {} }, client);
    assert.ok(response && response.statusCode < 300, response?.body);
    return JSON.parse(response.body).id as string;
  };

  it("dry-runs, refuses a non-duplicate with a hold, deletes an exact duplicate and audits it", async () => {
    const keep = await create(payout("platform-payout:dup-a", { counterparty: "Synthetic Course Platform, Inc." }));
    const dup = await create(payout("platform-payout:dup-b", { counterparty: "synthetic course platform inc" }));
    const other = await create(payout("platform-payout:other", { amount: "10.00" }));
    assert.equal((await buildMonth(client, "2026-10")).counters.rows, 3);

    const dry = await deleteLedgerRow(client, "2026-10", "tester", dup, { reason: "same payout twice", duplicateOf: keep, apply: false });
    assert.equal(dry.deleted, false);
    assert.deepEqual(dry.blockers, []);
    assert.ok(await getBookkeepingItem(client, "bookkeeping", dup));

    const notExact = await deleteLedgerRow(client, "2026-10", "tester", dup, { reason: "x", duplicateOf: other, apply: false });
    assert.match(notExact.blockers[0], /not an exact duplicate/);
    await assert.rejects(() => deleteLedgerRow(client, "2026-10", "tester", dup, { reason: "x", duplicateOf: other, apply: true }), /not deleted/);
    await assert.rejects(() => deleteLedgerRow(client, "2026-10", "tester", dup, { reason: " ", apply: true }), /reason is required/);

    const done = await deleteLedgerRow(client, "2026-10", "tester", dup, { reason: "same payout twice", duplicateOf: keep, apply: true });
    assert.equal(done.deleted, true);
    assert.equal(await getBookkeepingItem(client, "bookkeeping", dup), null);
    const view = await buildMonth(client, "2026-10");
    assert.equal(view.counters.rows, 2);
    assert.ok(!view.rows.some((row) => row.id === `ledger:${dup}`));
    const entry = view.log.at(-1)!;
    assert.equal(entry.action, "delete-row");
    assert.equal(entry.detail.duplicateOf, keep);
    assert.equal(entry.detail.reason, "same payout twice");
    assert.equal((await buildReport(client, "2026-10")).platformPayouts.length, 2);
  });

  it("refuses a row that holds an invoice link unless it is the named exact duplicate", async () => {
    const linked = await create(payout("platform-payout:linked", { transactionDate: "2026-10-05", paidDate: "2026-10-05", amount: "99.00" }));
    const document = (await putBookkeepingItem(client, "document", { status: "active", documentType: "invoice", originalFilename: "synthetic.pdf", facts: {} })).item;
    await createDocumentLink(client, { documentId: document.id, transactionId: linked, coverageType: "evidence" });
    const plain = await deleteLedgerRow(client, "2026-10", "tester", linked, { reason: "cleanup", apply: false });
    assert.match(plain.blockers[0], /1 linked document/);
    await assert.rejects(() => deleteLedgerRow(client, "2026-10", "tester", linked, { reason: "cleanup", apply: true }), /not deleted/);
    assert.ok(await getBookkeepingItem(client, "bookkeeping", linked));
  });
});
