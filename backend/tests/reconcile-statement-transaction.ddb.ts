// Executed by the existing sponsor-finance DynamoDB Local CI transaction harness.
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createTables } from "../scripts/local-dynamodb";
import { getClient, usesLocalTransactionEmulation } from "../src/db/client";
import { prepareStatementImport } from "../src/reconcile/statementImport";
import { getMonth, mutateMonth } from "../src/reconcile/monthService";
import { listStatementHistory, listStatements } from "../src/reconcile/service";
import type { ParsedStatement } from "../src/reconcile/parsers";

const source = (id: string) => ({ documentId: id, contentType: "text/plain", filename: "invented-transaction-input.txt" });
const parsed = (period: string): ParsedStatement => ({
  period: { from: `${period}-01`, to: `${period}-31` }, issueDate: "2032-04-05", bankAccounts: { "main|EUR": "invented-native-account", "USD|USD": "invented-native-usd-account" },
  rows: [{ date: `${period}-12`, amount: "-23.50", currency: "EUR", counterparty: "Example Hosting" }, { date: `${period}-13`, amount: "8.00", currency: "USD", wallet: "USD", counterparty: "Example Client" }],
  openingBalances: [{ asOf: `${period}-01`, amount: "100.00", currency: "EUR" }, { asOf: `${period}-01`, amount: "10.00", currency: "USD", wallet: "USD" }],
  balances: [{ asOf: `${period}-31`, amount: "76.50", currency: "EUR" }, { asOf: `${period}-31`, amount: "18.00", currency: "USD", wallet: "USD" }], warnings: [],
});

describe("native statement source transactions", () => {
  let client: DynamoDBDocumentClient;
  before(async () => {
    assert.match(process.env.DYNAMODB_ENDPOINT || "", /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(usesLocalTransactionEmulation(), false, "must exercise DynamoDB Local TransactWriteItems");
    client = await getClient(); await createTables(client);
  });
  it("keeps one active monthly source under concurrent first uploads", async () => {
    const candidates = await Promise.allSettled(["native-first-a", "native-first-b"].map((id) => prepareStatementImport(client, source(id), "revolut", parsed("2032-01"), {})));
    assert.equal(candidates.filter((result) => result.status === "fulfilled" && result.value.committed).length, 1);
    assert.equal((await listStatementHistory(client)).filter((item) => item.period === "2032-01").length, 1, "losing transaction must not leave an extra historical or active statement");
    assert.equal((await listStatements(client)).filter((item) => item.period === "2032-01").length, 1);
    assert.equal(Object.keys((await getMonth(client, "2032-01")).statementSelection!).length, 2, "both wallets share one source write and atomic month selection");
  });
  it("rejects stale replacement and preserves every wallet and source until a fresh confirmation", async () => {
    await prepareStatementImport(client, source("native-original"), "revolut", parsed("2032-03"), {});
    const review = await prepareStatementImport(client, source("native-replacement"), "revolut", parsed("2032-03"), { preview: true });
    await mutateMonth(client, "2032-03", "synthetic-reviewer", "summary", {}, () => {});
    await assert.rejects(prepareStatementImport(client, source("native-replacement"), "revolut", parsed("2032-03"), { replace: true, previewDigest: review.preview.digest }), /stale|changed/);
    assert.equal((await listStatementHistory(client)).filter((item) => item.period === "2032-03").length, 1);
    const current = await prepareStatementImport(client, source("native-replacement"), "revolut", parsed("2032-03"), { preview: true });
    await prepareStatementImport(client, source("native-replacement"), "revolut", parsed("2032-03"), { replace: true, previewDigest: current.preview.digest });
    assert.equal((await listStatementHistory(client)).filter((item) => item.period === "2032-03").length, 2, "source history remains intact");
    const active = (await listStatements(client)).filter((item) => item.period === "2032-03");
    assert.equal(active.length, 1); assert.equal(active[0].documentId, "native-replacement"); assert.equal(active[0].rows.length, 2);
  });
});
