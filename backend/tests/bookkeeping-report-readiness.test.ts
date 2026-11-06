import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { getClient } from "../src/db/client";
import { createDocumentLink, getBookkeepingItem, listBookkeepingItems, putBookkeepingItem } from "../src/db/bookkeeping";
import { createTables, startLocal, stopLocal } from "../scripts/local-dynamodb";
import { attachProof } from "../src/reconcile/monthService";
import { handleBookkeepingReportRoutes } from "../src/routes/bookkeepingReports";
import * as storage from "../src/routes/bookkeepingShared";

describe("portal package payment readiness", () => {
  let client: DynamoDBDocumentClient;
  let writes = 0, signs = 0, objectOperations = 0, uploads = 0;
  const originalStorage = { s3: storage.s3, signUrl: storage.signUrl, uploadStream: storage.uploadStream };
  before(async () => {
    const underlying = await getClient(await startLocal());
    await createTables(underlying);
    client = { send: async (command: any) => {
      if (["PutCommand", "UpdateCommand", "DeleteCommand", "TransactWriteCommand"].includes(command.constructor.name)) writes++;
      return underlying.send(command);
    } } as unknown as DynamoDBDocumentClient;
    storage.setBookkeepingStorageForTests({ send: async () => { objectOperations++; return {}; } } as never,
      async () => { signs++; return "https://invented.example.test/archive"; });
    storage.setBookkeepingArchiveUploaderForTests(async () => { uploads++; return { VersionId: "invented-version" }; });
  });
  after(async () => {
    storage.setBookkeepingStorageForTests(originalStorage.s3, originalStorage.signUrl);
    storage.setBookkeepingArchiveUploaderForTests(originalStorage.uploadStream);
    await stopLocal();
  });
  const invoke = (path: string, body: unknown = {}) => handleBookkeepingReportRoutes(path, "POST", {
    httpMethod: "POST", path, body: JSON.stringify(body), headers: {},
  }, client);
  const payment = async (month: string, suffix: string) => (await putBookkeepingItem(client, "bookkeeping", {
    id: `invented-payment-${suffix}`, transactionDate: `${month}-06`, paidDate: `${month}-06`,
    counterparty: `Invented Vendor ${suffix}`, description: "Invented service", amount: "31.00", currency: "EUR", entryType: "expense",
  })).item;
  async function confirmPayment(transactionId: string, month: string) {
    const document = (await putBookkeepingItem(client, "document", {
      id: `invented-evidence-${transactionId}`, status: "active", documentType: "receipt", originalFilename: "invented-receipt.pdf",
    })).item;
    await createDocumentLink(client, { documentId: document.id, transactionId, coverageType: "evidence" });
    await attachProof(client, month, "invented-operator", transactionId, document.id);
  }
  async function statements(month: string) {
    for (const id of ["invented-business-one", "invented-business-two"]) {
      if (!await getBookkeepingItem(client, "account", id)) await putBookkeepingItem(client, "account", { id, kind: "business", active: true });
      await putBookkeepingItem(client, "document", { documentType: "bank-statement", status: "active", accountId: id, statementMonth: month });
    }
  }
  async function assertBlocked(path: string, month: string, transactionId: string, body: unknown = {}) {
    writes = signs = objectOperations = uploads = 0;
    const response = await invoke(path, body);
    assert.equal(response?.statusCode, 409);
    const result = JSON.parse(response!.body);
    assert.equal(result.reportPeriod, month);
    assert.ok(result.blockers.some((row: any) => row.rowId === `ledger:${transactionId}` && row.reason));
    assert.equal(result.report, undefined);
    assert.equal(result.downloadUrl, undefined);
    assert.deepEqual({ writes, signs, objectOperations, uploads }, { writes: 0, signs: 0, objectOperations: 0, uploads: 0 });
  }
  it("blocks new snapshots, ready duplicates, and fresh/cached archives before writes or S3 signing", async () => {
    const month = "2036-01", transaction = await payment(month, "unconfirmed");
    await assertBlocked("/api/bookkeeping/reports/snapshot", month, transaction.id, { month });
    assert.deepEqual(await listBookkeepingItems(client, "report"), []);
    const archive = (await putBookkeepingItem(client, "document", { id: "invented-cached-archive", status: "active", s3Key: "invented/archive.zip" })).item;
    const cached = (await putBookkeepingItem(client, "report", { id: "invented-cached-report", month, status: "generated", archiveDocumentId: archive.id, transactionIds: [transaction.id], documentIds: [] })).item;
    const ready = (await putBookkeepingItem(client, "report", { id: "invented-ready-report", month, status: "ready", transactionIds: [transaction.id], documentIds: [] })).item;
    await assertBlocked("/api/bookkeeping/reports/snapshot", month, transaction.id, { month });
    await assertBlocked(`/api/bookkeeping/reports/${cached.id}/archive`, month, transaction.id);
    await assertBlocked(`/api/bookkeeping/reports/${ready.id}/archive`, month, transaction.id);
    assert.equal((await getBookkeepingItem(client, "report", cached.id))?.archiveDocumentId, archive.id);
    await confirmPayment(transaction.id, month);
    const duplicate = await invoke("/api/bookkeeping/reports/snapshot", { month });
    assert.equal(duplicate?.statusCode, 200);
    assert.equal(JSON.parse(duplicate!.body).duplicate, true);
    const cachedResponse = await invoke(`/api/bookkeeping/reports/${cached.id}/archive`);
    assert.equal(cachedResponse?.statusCode, 200);
    assert.equal(JSON.parse(cachedResponse!.body).reportPeriod, month);
    assert.equal(signs, 1, "a resolved month may sign its cached archive");
    assert.equal(uploads, 0);
  });
  it("creates a snapshot for a verified paid month and retains the selected cash-month context", async () => {
    const month = "2036-04", transaction = await payment(month, "confirmed");
    await confirmPayment(transaction.id, month);
    await statements(month);
    const response = await invoke("/api/bookkeeping/reports/snapshot", { month });
    assert.equal(response?.statusCode, 201, response?.body);
    const result = JSON.parse(response!.body);
    assert.equal(result.reportPeriod, month);
    assert.deepEqual(result.report.transactionIds, [transaction.id]);
  });
  it("does not include an unconfirmed next-month cash payment merely because its invoice date is in the selected month", async () => {
    const month = "2036-05";
    await putBookkeepingItem(client, "bookkeeping", { id: "invented-future-cash", transactionDate: `${month}-31`, paidDate: "2036-06-02", counterparty: "Invented Future Cash Vendor", amount: "44.00", currency: "EUR", entryType: "expense" });
    await statements(month);
    const response = await invoke("/api/bookkeeping/reports/snapshot", { month });
    assert.equal(response?.statusCode, 201, response?.body);
    assert.deepEqual(JSON.parse(response!.body).report.transactionIds, []);
  });
  it("keeps invalid input and invalid stored report months at 400 without signing or writing", async () => {
    writes = signs = objectOperations = uploads = 0;
    for (const month of ["2036", "2036-00", "2036-13"]) {
      assert.equal((await invoke("/api/bookkeeping/reports/snapshot", { month }))?.statusCode, 400);
    }
    const invalid = (await putBookkeepingItem(client, "report", { id: "invented-invalid-month", month: "all", status: "generated", archiveDocumentId: "invented-cached-archive" })).item;
    writes = 0;
    assert.equal((await invoke(`/api/bookkeeping/reports/${invalid.id}/archive`))?.statusCode, 400);
    assert.deepEqual({ writes, signs, objectOperations, uploads }, { writes: 0, signs: 0, objectOperations: 0, uploads: 0 });
  });
});
