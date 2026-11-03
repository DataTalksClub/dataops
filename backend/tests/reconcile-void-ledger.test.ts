import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { getClient } from "../src/db/client";
import { createUserWithId } from "../src/db/users";
import {
  createDocumentLink,
  deleteBookkeepingItem,
  getBookkeepingItem,
  getRawDocument,
  listBookkeepingItems,
  listTransactions,
  putBookkeepingItem,
} from "../src/db/bookkeeping";
import { buildReport } from "../src/reconcile/service";
import { attachProof, buildMonth, closeMonth, reopenMonth, restoreLedgerRow, voidLedgerRow } from "../src/reconcile/monthService";
import { handleBookkeepingReportRoutes } from "../src/routes/bookkeepingReports";
import { handleBookkeepingTransactionRoutes } from "../src/routes/bookkeepingTransactions";
import { handleReconcileRoutes } from "../src/routes/reconcile";
import { createTables, startLocal, stopLocal } from "../scripts/local-dynamodb";

const PERIOD = "2026-10";
const OPERATOR = "ledger-void-operator";
const ADMIN = "ledger-void-admin";
const payout = (sourceKey: string, over: Record<string, unknown> = {}) => ({
  transactionDate: "2026-10-01", paidDate: "2026-10-01", counterparty: "Teachable", description: "Synthetic payout",
  amount: "48.32", currency: "USD", entryType: "income", incomePeriod: PERIOD, category: "Affiliate income",
  sourceType: "platform-payout", statementRef: `ref-${sourceKey}`, sourceKey, ...over,
});

describe("reconcile void-ledger", () => {
  let client: DynamoDBDocumentClient;
  before(async () => {
    client = await getClient(await startLocal());
    await createTables(client);
    await createUserWithId(client, OPERATOR, { name: "Ledger operator", email: "ledger-operator@datatalks.club", role: "operator" });
    await createUserWithId(client, ADMIN, { name: "Ledger admin", email: "ledger-admin@datatalks.club", role: "admin" });
  });
  after(async () => { await stopLocal(); });

  const create = async (body: Record<string, unknown>) => {
    const response = await handleBookkeepingTransactionRoutes("/api/bookkeeping/transactions", "POST", { body: JSON.stringify(body), headers: {} }, client);
    assert.ok(response && response.statusCode < 300, response?.body);
    return JSON.parse(response.body).id as string;
  };
  const reconcileCall = (user: string, action: string, body: Record<string, unknown>) => {
    const path = `/api/reconcile/months/${PERIOD}/${action}`;
    return handleReconcileRoutes(path, "POST", {
      httpMethod: "POST", path, headers: { "x-user-id": user }, body: JSON.stringify(body), queryStringParameters: null,
    }, client);
  };
  const vatReport = async () => {
    const response = await handleBookkeepingReportRoutes("/api/bookkeeping/reports/vat", "GET", {
      httpMethod: "GET", path: "/api/bookkeeping/reports/vat", headers: {}, body: null, queryStringParameters: { year: "2026" },
    }, client);
    assert.ok(response && response.statusCode === 200, response?.body);
    return JSON.parse(response.body);
  };

  it("soft-voids only an exact duplicate, excludes it from totals, preserves links and restores it idempotently", async () => {
    const keep = await create(payout("platform-payout:void-keep", { counterparty: "Teachable, Inc." }));
    const duplicate = await create(payout("platform-payout:void-duplicate", { vatAmount: "3.00", vatCurrency: "USD" }));
    const unrelated = await create(payout("platform-payout:void-unrelated", { amount: "10.00" }));
    const proof = (await putBookkeepingItem(client, "document", {
      status: "active", documentType: "other-evidence", originalFilename: "synthetic-payout-proof.pdf", facts: {},
    })).item;
    await createDocumentLink(client, { documentId: proof.id, transactionId: keep, coverageType: "evidence" });
    await createDocumentLink(client, { documentId: proof.id, transactionId: duplicate, coverageType: "evidence" });
    await attachProof(client, PERIOD, "tester", keep, proof.id);

    const beforePayouts = (await buildReport(client, PERIOD)).platformPayouts.length;
    const beforeVat = await vatReport();
    const beforeVatTransactions = beforeVat.transactions.map((item: { id: string }) => item.id);
    assert.ok(beforeVatTransactions.includes(duplicate));
    assert.ok((await listTransactions(client)).some((item) => item.id === duplicate));
    assert.ok((await buildMonth(client, PERIOD)).rows.some((row) => row.id === `ledger:${duplicate}`));

    await assert.rejects(
      () => voidLedgerRow(client, "2026-09", "tester", duplicate, { reason: "duplicate", duplicateOf: keep, confirm: true }),
      /not in 2026-09/,
    );
    await assert.rejects(
      () => voidLedgerRow(client, PERIOD, "tester", duplicate, { reason: " ", duplicateOf: keep, confirm: true }),
      /reason is required/,
    );
    await assert.rejects(
      () => voidLedgerRow(client, PERIOD, "tester", duplicate, { reason: "wrong twin", duplicateOf: unrelated, confirm: true }),
      /not an exact duplicate/,
    );

    const preview = await voidLedgerRow(client, PERIOD, "tester", duplicate, { reason: "duplicate of retained row", duplicateOf: keep, confirm: false });
    assert.equal(preview.mode, "dry-run");
    assert.equal(preview.voided, false);
    assert.ok(await getBookkeepingItem(client, "bookkeeping", duplicate));

    const applied = await voidLedgerRow(client, PERIOD, "tester", duplicate, { reason: "duplicate of retained row", duplicateOf: keep, confirm: true });
    assert.equal(applied.mode, "voided");
    assert.equal(applied.voided, true);
    const stored = await getBookkeepingItem(client, "bookkeeping", duplicate);
    assert.equal(stored?.voidStatus, "voided");
    assert.equal((stored?.audit as Array<Record<string, unknown>>).at(-1)?.action, "ledger-voided");
    assert.equal((await getRawDocument(client, proof.id))?.linkRefCount, 2);
    assert.equal((await listBookkeepingItems(client, "link")).filter((link) => link.transactionId === duplicate).length, 1);
    assert.ok(!(await listTransactions(client)).some((item) => item.id === duplicate));
    assert.ok(!(await buildMonth(client, PERIOD)).rows.some((row) => row.id === `ledger:${duplicate}`));
    assert.equal((await buildReport(client, PERIOD)).platformPayouts.length, beforePayouts - 1);
    assert.ok(!(await vatReport()).transactions.some((item: { id: string }) => item.id === duplicate));

    const byId = await handleBookkeepingTransactionRoutes(`/api/bookkeeping/transactions/${duplicate}`, "GET", { body: null, headers: {} }, client);
    assert.equal(byId?.statusCode, 200);
    assert.equal(JSON.parse(byId!.body).voidStatus, "voided");
    const logged = await buildMonth(client, PERIOD);
    assert.equal(logged.log.filter((entry) => entry.action === "void-ledger" && entry.detail.transactionId === duplicate).length, 1);
    const retried = await voidLedgerRow(client, PERIOD, "tester", duplicate, { reason: "duplicate of retained row", duplicateOf: keep, confirm: true });
    assert.equal(retried.mode, "already-voided");
    assert.equal((await buildMonth(client, PERIOD)).log.filter((entry) => entry.action === "void-ledger" && entry.detail.transactionId === duplicate).length, 1);

    await deleteBookkeepingItem(client, "bookkeeping", unrelated);
    await closeMonth(client, PERIOD, "tester");
    await assert.rejects(
      () => restoreLedgerRow(client, PERIOD, "tester", duplicate, { reason: "restore after review", confirm: true }),
      /is closed/,
    );
    await reopenMonth(client, PERIOD, "tester", "restore after review");
    const restorePreview = await restoreLedgerRow(client, PERIOD, "tester", duplicate, { reason: "restore after review", confirm: false });
    assert.equal(restorePreview.mode, "dry-run");
    assert.equal(restorePreview.restored, false);
    const restored = await restoreLedgerRow(client, PERIOD, "tester", duplicate, { reason: "restore after review", confirm: true });
    assert.equal(restored.mode, "restored");
    assert.equal(restored.restored, true);
    const restoredItem = await getBookkeepingItem(client, "bookkeeping", duplicate);
    assert.equal(restoredItem?.voidStatus, "restored");
    assert.equal((restoredItem?.audit as Array<Record<string, unknown>>).at(-1)?.action, "ledger-restored");
    assert.ok((await listTransactions(client)).some((item) => item.id === duplicate));
    assert.ok((await buildMonth(client, PERIOD)).rows.some((row) => row.id === `ledger:${duplicate}`));
    assert.equal((await buildReport(client, PERIOD)).platformPayouts.length, beforePayouts - 1);
    assert.ok((await vatReport()).transactions.some((item: { id: string }) => item.id === duplicate));
    assert.equal((await getRawDocument(client, proof.id))?.linkRefCount, 2);
    const restoreRetry = await restoreLedgerRow(client, PERIOD, "tester", duplicate, { reason: "restore after review", confirm: true });
    assert.equal(restoreRetry.mode, "already-restored");
    assert.equal((await buildMonth(client, PERIOD)).log.filter((entry) => entry.action === "restore-ledger" && entry.detail.transactionId === duplicate).length, 1);
  });

  it("requires admin authorization and explicit confirmation through the API", async () => {
    const keep = await create(payout("platform-payout:api-void-keep"));
    const duplicate = await create(payout("platform-payout:api-void-duplicate"));
    const body = { transactionId: duplicate, duplicateOf: keep, reason: "duplicate of retained row", confirm: true };
    const denied = await reconcileCall(OPERATOR, "void-ledger", body);
    assert.equal(denied.statusCode, 403);
    assert.notEqual((await getBookkeepingItem(client, "bookkeeping", duplicate))?.voidStatus, "voided");

    const preview = await reconcileCall(ADMIN, "void-ledger", { ...body, confirm: false });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.equal(JSON.parse(preview.body).mode, "dry-run");
    assert.notEqual((await getBookkeepingItem(client, "bookkeeping", duplicate))?.voidStatus, "voided");

    const applied = await reconcileCall(ADMIN, "void-ledger", body);
    assert.equal(applied.statusCode, 200, applied.body);
    assert.equal(JSON.parse(applied.body).mode, "voided");
    const restoreDenied = await reconcileCall(OPERATOR, "restore-ledger", { transactionId: duplicate, reason: "restore after review", confirm: true });
    assert.equal(restoreDenied.statusCode, 403);
    const restored = await reconcileCall(ADMIN, "restore-ledger", { transactionId: duplicate, reason: "restore after review", confirm: true });
    assert.equal(restored.statusCode, 200, restored.body);
    assert.equal(JSON.parse(restored.body).mode, "restored");
  });
});
