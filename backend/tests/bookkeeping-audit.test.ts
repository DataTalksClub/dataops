import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { handler } from "../src/handler";
import { startLocal, stopLocal, createTables } from "../scripts/local-dynamodb";
import { getClient } from "../src/db/client";
import {
  BookkeepingTransactionLimitError,
  getBookkeepingItem,
  listBookkeepingItems,
  putBookkeepingItem,
  updateBookkeepingTransaction,
  type BookkeepingTransactItem,
} from "../src/db/bookkeeping";
import { BookkeepingAuditTooLargeError } from "../src/bookkeepingAudit";
import { handleBookkeepingTransactionRoutes } from "../src/routes/bookkeepingTransactions";
import { TABLE_BOOKKEEPING } from "../src/db/tableNames";
import { writePortableExport } from "../src/export/portable";
import { dryRunImport } from "../src/export/portableValidate";

const validTransaction = {
  transactionDate: "2026-10-01",
  counterparty: "Synthetic Vendor",
  description: "Synthetic bookkeeping audit test",
  amount: "10.00",
  currency: "EUR",
  sourceType: "manual",
  entryType: "expense",
};

let client: DynamoDBDocumentClient;

const invoke = (
  method: string,
  requestPath: string,
  body?: unknown,
  query?: Record<string, string>,
) => handler({
  httpMethod: method,
  path: requestPath,
  headers: {},
  body: body === undefined ? null : JSON.stringify(body),
  queryStringParameters: query || null,
}, {});

async function createTransaction() {
  const response = await invoke("POST", "/api/bookkeeping/transactions", validTransaction);
  assert.equal(response.statusCode, 201, response.body);
  return JSON.parse(response.body);
}

async function auditRows(transactionId: string) {
  const result = await client.send(new QueryCommand({
    TableName: TABLE_BOOKKEEPING,
    KeyConditionExpression: "PK = :pk",
    ExpressionAttributeValues: { ":pk": `BOOKKEEPING_AUDIT#${transactionId}` },
    ConsistentRead: true,
  }));
  return (result.Items || []) as Record<string, unknown>[];
}

describe("bookkeeping audit sidecar", () => {
  before(async () => {
    const port = await startLocal({ persistent: false });
    client = await getClient(port);
    await createTables(client);
  });

  after(async () => {
    await stopLocal();
  });

  it("migrates only present inline entries atomically and pages them through the existing audit shape", async () => {
    const transactionId = `legacy-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const inlineAudit = Array.from({ length: 100 }, (_, index) => ({
      action: "legacy-correction",
      actor: "synthetic-operator",
      at: `2026-10-01T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
      marker: `present-${index}`,
    }));
    await putBookkeepingItem(client, "bookkeeping", {
      ...validTransaction,
      id: transactionId,
      audit: inlineAudit,
    });

    const response = await invoke("PUT", `/api/bookkeeping/transactions/${transactionId}`, {
      comment: "post-migration edit",
    });
    assert.equal(response.statusCode, 200, response.body);
    const updated = JSON.parse(response.body);
    assert.equal(updated.audit.length, 100);
    assert.deepEqual(updated.audit.slice(0, 99), inlineAudit.slice(1));
    assert.equal(updated.audit[99].action, "updated");

    const raw = await client.send(new GetCommand({
      TableName: TABLE_BOOKKEEPING,
      Key: { PK: `BOOKKEEPING#${transactionId}`, SK: `BOOKKEEPING#${transactionId}` },
      ConsistentRead: true,
    }));
    assert.equal(raw.Item?.audit, undefined);
    assert.equal(raw.Item?.auditStorageVersion, 1);
    assert.equal(raw.Item?.auditSequence, 101);

    const rows = await auditRows(transactionId);
    const legacyRows = rows
      .filter((row) => row.recordType === "bookkeeping-audit-legacy-chunk")
      .sort((left, right) => Number(left.chunkIndex) - Number(right.chunkIndex));
    assert.equal(legacyRows.length, 1);
    const legacyEntries = JSON.parse(Buffer.from(
      legacyRows.map((row) => row.payload as string).join(""),
      "base64",
    ).toString("utf8"));
    assert.equal(legacyEntries.length, 99);
    assert.equal(legacyEntries[0].sequence, 2);
    assert.equal(rows.filter((row) => row.recordType === "bookkeeping-audit-event").length, 1);

    const secondEdit = await invoke("PUT", `/api/bookkeeping/transactions/${transactionId}`, {
      comment: "second post-migration edit",
    });
    assert.equal(secondEdit.statusCode, 200, secondEdit.body);
    const secondUpdated = JSON.parse(secondEdit.body);
    assert.equal(secondUpdated.audit.length, 100);
    assert.deepEqual(secondUpdated.audit.slice(0, 98), inlineAudit.slice(2));
    assert.equal(secondUpdated.audit[98].action, "updated");
    assert.equal(secondUpdated.audit[99].action, "updated");
    const afterSecondRows = await auditRows(transactionId);
    const afterSecondLegacyRows = afterSecondRows
      .filter((row) => row.recordType === "bookkeeping-audit-legacy-chunk")
      .sort((left, right) => Number(left.chunkIndex) - Number(right.chunkIndex));
    const afterSecondLegacyEntries = JSON.parse(Buffer.from(
      afterSecondLegacyRows.map((row) => row.payload as string).join(""),
      "base64",
    ).toString("utf8"));
    assert.equal(afterSecondLegacyEntries.length, 98);
    assert.equal(afterSecondLegacyEntries[0].sequence, 3);
    assert.equal(afterSecondRows.filter((row) => row.recordType === "bookkeeping-audit-event").length, 2);

    const firstPage = await invoke("GET", `/api/bookkeeping/transactions/${transactionId}/audit`, undefined, { limit: "30" });
    assert.equal(firstPage.statusCode, 200, firstPage.body);
    const pageOne = JSON.parse(firstPage.body);
    assert.equal(pageOne.items.length, 30);
    assert.ok(pageOne.nextCursor);
    const secondPage = await invoke("GET", `/api/bookkeeping/transactions/${transactionId}/audit`, undefined, {
      limit: "30",
      cursor: pageOne.nextCursor,
    });
    assert.equal(secondPage.statusCode, 200, secondPage.body);
    const pageTwo = JSON.parse(secondPage.body);
    assert.equal(pageTwo.items.length, 30);
    const thirdPage = await invoke("GET", `/api/bookkeeping/transactions/${transactionId}/audit`, undefined, {
      limit: "50",
      cursor: pageTwo.nextCursor,
    });
    assert.equal(thirdPage.statusCode, 200, thirdPage.body);
    const pageThree = JSON.parse(thirdPage.body);
    assert.equal(pageThree.items.length, 40);
    assert.equal(pageThree.nextCursor, null);
  });

  it("migrates a near-400 KiB inline audit into bounded chunks without losing entries", async () => {
    const transactionId = `near-limit-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const legacyEvent = { action: "legacy-note", payload: "x".repeat(380 * 1024) };
    await putBookkeepingItem(client, "bookkeeping", {
      ...validTransaction,
      id: transactionId,
      audit: [legacyEvent],
    });

    const response = await invoke("PUT", `/api/bookkeeping/transactions/${transactionId}`, {
      comment: "edit after near-limit audit migration",
    });
    assert.equal(response.statusCode, 200, response.body.slice(0, 500));
    const updated = JSON.parse(response.body);
    assert.deepEqual(updated.audit[0], legacyEvent);
    assert.equal(updated.audit[1].action, "updated");

    const raw = await client.send(new GetCommand({
      TableName: TABLE_BOOKKEEPING,
      Key: { PK: `BOOKKEEPING#${transactionId}`, SK: `BOOKKEEPING#${transactionId}` },
      ConsistentRead: true,
    }));
    assert.equal(raw.Item?.audit, undefined);
    assert.equal(raw.Item?.auditSequence, 2);

    const chunks = (await auditRows(transactionId))
      .filter((row) => row.recordType === "bookkeeping-audit-legacy-chunk")
      .sort((left, right) => Number(left.chunkIndex) - Number(right.chunkIndex));
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((row) => Buffer.byteLength(row.payload as string, "utf8") < 350 * 1024));
    const readback = await getBookkeepingItem(client, "bookkeeping", transactionId, true);
    assert.deepEqual(readback?.audit, updated.audit);
  });

  it("keeps the rolling 100-entry window even when its UTF-8 payload exceeds the former 128 KiB budget", async () => {
    const created = await createTransaction();
    for (let index = 0; index < 101; index += 1) {
      const current = await getBookkeepingItem(client, "bookkeeping", created.id, true);
      assert.ok(current);
      const comment = index < 40
        ? `${index}:${"λ".repeat(1900)}`
        : `short-${index}`;
      const event = {
        action: "updated",
        actor: "synthetic-operator",
        at: `2026-10-02T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
        changes: { comment: { from: current.comment ?? null, to: comment } },
      };
      const updated = await updateBookkeepingTransaction(client, created.id, String(current.updatedAt), {
        comment,
        audit: [...(Array.isArray(current.audit) ? current.audit : []), event],
      });
      assert.ok(updated);
    }

    const current = await getBookkeepingItem(client, "bookkeeping", created.id, true);
    assert.ok(current);
    assert.equal((current.audit as unknown[]).length, 100);
    assert.ok(Buffer.byteLength(JSON.stringify(current.audit), "utf8") > 128 * 1024);
    const raw = await client.send(new GetCommand({
      TableName: TABLE_BOOKKEEPING,
      Key: { PK: `BOOKKEEPING#${created.id}`, SK: `BOOKKEEPING#${created.id}` },
      ConsistentRead: true,
    }));
    assert.equal(raw.Item?.audit, undefined);
    assert.equal(raw.Item?.auditSequence, 101);
    assert.equal((await auditRows(created.id)).filter((row) => row.recordType === "bookkeeping-audit-event").length, 100);
  });

  it("serializes concurrent corrections with CAS so only one audit event commits", async () => {
    const created = await createTransaction();
    const current = await getBookkeepingItem(client, "bookkeeping", created.id, true);
    assert.ok(current);
    const event = (action: string) => ({
      action: "updated",
      actor: "synthetic-operator",
      at: `2026-10-03T00:00:0${action === "first" ? "1" : "2"}.000Z`,
      changes: { comment: { from: null, to: action } },
    });
    const results = await Promise.allSettled([
      updateBookkeepingTransaction(client, created.id, String(current.updatedAt), {
        comment: "first",
        audit: [event("first")],
      }),
      updateBookkeepingTransaction(client, created.id, String(current.updatedAt), {
        comment: "second",
        audit: [event("second")],
      }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const updated = await getBookkeepingItem(client, "bookkeeping", created.id, true);
    assert.ok(updated);
    assert.equal((updated.audit as unknown[]).length, 1);
    assert.equal(updated.auditSequence, 1);
    assert.equal((await auditRows(created.id)).filter((row) => row.recordType === "bookkeeping-audit-event").length, 1);
  });

  it("rejects an oversized new audit event before writing any part of the update", async () => {
    const created = await createTransaction();
    const before = await getBookkeepingItem(client, "bookkeeping", created.id, true);
    assert.ok(before);
    await assert.rejects(
      updateBookkeepingTransaction(client, created.id, String(before.updatedAt), {
        comment: "must not be stored",
        audit: [{ action: "updated", payload: "x".repeat(351 * 1024) }],
      }),
      (error: unknown) => error instanceof BookkeepingAuditTooLargeError,
    );
    const after = await getBookkeepingItem(client, "bookkeeping", created.id, true);
    assert.ok(after);
    assert.equal(after.updatedAt, before.updatedAt);
    assert.equal(after.comment, undefined);
    assert.equal(after.audit, undefined);
    assert.deepEqual(await auditRows(created.id), []);
  });

  it("rejects more than 100 final DynamoDB actions before writing any part of the update", async () => {
    const created = await createTransaction();
    const before = await getBookkeepingItem(client, "bookkeeping", created.id, true);
    assert.ok(before);
    const extraActions: BookkeepingTransactItem[] = Array.from({ length: 100 }, (_, index) => {
      const key = `SYNTHETIC_LIMIT#${created.id}#${index}`;
      return { Put: { TableName: TABLE_BOOKKEEPING, Item: { PK: key, SK: key } } };
    });
    await assert.rejects(
      updateBookkeepingTransaction(
        client,
        created.id,
        String(before.updatedAt),
        { comment: "must not be stored", audit: [{ action: "updated" }] },
        undefined,
        undefined,
        extraActions,
      ),
      (error: unknown) => error instanceof BookkeepingTransactionLimitError,
    );
    const after = await getBookkeepingItem(client, "bookkeeping", created.id, true);
    assert.ok(after);
    assert.equal(after.updatedAt, before.updatedAt);
    assert.equal(after.comment, undefined);
    assert.equal(after.audit, undefined);
    assert.deepEqual(await auditRows(created.id), []);
    assert.equal((await listBookkeepingItems(client, "synthetic-limit")).length, 0);
  });

  it("keeps allocation, audit, claim, link and reference-count changes atomic", async () => {
    const created = await createTransaction();
    const document = (await putBookkeepingItem(client, "document", {
      documentType: "invoice",
      status: "active",
      originalFilename: "synthetic-invoice.pdf",
      contentType: "application/pdf",
      byteSize: 12,
      sha256: createHash("sha256").update(`synthetic-${created.id}`).digest("hex"),
      s3Key: `documents/synthetic-${created.id}`,
    })).item;
    const allocationBody = {
      expectedUpdatedAt: created.updatedAt,
      reason: "synthetic allocation",
      allocations: [{
        documentId: document.id,
        counterparty: "Synthetic Vendor",
        description: "Synthetic service",
        amount: "10.00",
      }],
    };
    const allocated = await invoke("PUT", `/api/bookkeeping/transactions/${created.id}/allocations`, allocationBody);
    assert.equal(allocated.statusCode, 200, allocated.body);
    const allocatedItem = JSON.parse(allocated.body);
    assert.equal(allocatedItem.audit.at(-1).action, "allocations-updated");
    assert.equal((await listBookkeepingItems(client, "allocation-source-claim")).filter((item) => item.transactionId === created.id).length, 2);
    assert.equal((await listBookkeepingItems(client, "link")).filter((item) => item.transactionId === created.id).length, 1);

    const cleared = await invoke("DELETE", `/api/bookkeeping/transactions/${created.id}/allocations`, {
      expectedUpdatedAt: allocatedItem.updatedAt,
      reason: "synthetic clear",
    });
    assert.equal(cleared.statusCode, 200, cleared.body);
    const clearedItem = JSON.parse(cleared.body);
    assert.equal(clearedItem.audit.at(-1).action, "allocations-cleared");
    assert.equal((await listBookkeepingItems(client, "allocation-source-claim")).filter((item) => item.transactionId === created.id).length, 0);
    assert.equal((await listBookkeepingItems(client, "link")).filter((item) => item.transactionId === created.id).length, 0);

    const beforeFailure = await getBookkeepingItem(client, "bookkeeping", created.id, true);
    assert.ok(beforeFailure);
    const sourceClaim = `SPONSOR_FINANCE_CLAIM#transaction#${created.id}`;
    const baseSend = client.send.bind(client);
    let claimInserted = false;
    const guardedClient = Object.create(client) as DynamoDBDocumentClient;
    guardedClient.send = (async (command: unknown, ...args: unknown[]) => {
      if (!claimInserted && command instanceof TransactWriteCommand) {
        claimInserted = true;
        await baseSend(new PutCommand({
          TableName: TABLE_BOOKKEEPING,
          Item: { PK: sourceClaim, SK: sourceClaim, transactionId: created.id, dealId: "synthetic-deal" },
          ConditionExpression: "attribute_not_exists(PK)",
        }));
      }
      return (baseSend as (...parameters: unknown[]) => Promise<unknown>)(command, ...args);
    }) as DynamoDBDocumentClient["send"];

    const failure = await handleBookkeepingTransactionRoutes(
      `/api/bookkeeping/transactions/${created.id}/allocations`,
      "PUT",
      {
        httpMethod: "PUT",
        path: `/api/bookkeeping/transactions/${created.id}/allocations`,
        headers: {},
        body: JSON.stringify({
          expectedUpdatedAt: beforeFailure.updatedAt,
          allocations: [{
            documentId: document.id,
            counterparty: "Synthetic Vendor",
            description: "Synthetic service",
            amount: "10.00",
          }],
        }),
        queryStringParameters: null,
      },
      guardedClient,
    );
    assert.equal(failure?.statusCode, 409);
    const afterFailure = await getBookkeepingItem(client, "bookkeeping", created.id, true);
    assert.ok(afterFailure);
    assert.equal(afterFailure.updatedAt, beforeFailure.updatedAt);
    assert.equal((afterFailure.audit as unknown[]).length, (beforeFailure.audit as unknown[]).length);
    assert.equal(afterFailure.allocations, undefined);
    assert.equal((await listBookkeepingItems(client, "allocation-source-claim")).filter((item) => item.transactionId === created.id).length, 0);
    assert.equal((await listBookkeepingItems(client, "link")).filter((item) => item.transactionId === created.id).length, 0);
  });

  it("exports and dry-run restores transaction and sidecar audit rows together", async () => {
    const created = await createTransaction();
    const current = await getBookkeepingItem(client, "bookkeeping", created.id, true);
    assert.ok(current);
    await updateBookkeepingTransaction(client, created.id, String(current.updatedAt), {
      comment: "portable export synthetic",
      audit: [{ action: "updated", actor: "synthetic-operator", at: "2026-10-04T00:00:00.000Z", changes: {} }],
    });

    const exportDir = await fs.mkdtemp(path.join(os.tmpdir(), "dataops-bookkeeping-audit-"));
    try {
      const exported = await writePortableExport(client, exportDir, {
        generatedAt: "2026-10-05T00:00:00.000Z",
        sourceEnvironment: "test",
        sourceStack: "test-stack",
        sourceRegion: "eu-west-1",
        appGitSha: "test-sha",
      });
      assert.ok(exported.manifest.entity_counts.bookkeeping_records >= 2);
      const portable = await fs.readFile(path.join(exportDir, "bookkeeping_records.jsonl"), "utf8");
      assert.match(portable, new RegExp(`BOOKKEEPING_AUDIT#${created.id}`));
      const restored = await dryRunImport(exportDir);
      assert.equal(restored.valid, true, restored.errors.join("; "));
      assert.equal(restored.wouldWrite.bookkeeping_records, exported.manifest.entity_counts.bookkeeping_records);
    } finally {
      await fs.rm(exportDir, { recursive: true, force: true });
    }
  });

  it("rejects a portable export with an incomplete audit sequence", async () => {
    const created = await createTransaction();
    const current = await getBookkeepingItem(client, "bookkeeping", created.id, true);
    assert.ok(current);
    await updateBookkeepingTransaction(client, created.id, String(current.updatedAt), {
      comment: "make an audit row",
      audit: [{ action: "updated", actor: "synthetic-operator", at: "2026-10-06T00:00:00.000Z", changes: {} }],
    });
    const rows = await auditRows(created.id);
    const eventRow = rows.find((row) => row.recordType === "bookkeeping-audit-event");
    assert.ok(eventRow);
    await client.send(new DeleteCommand({
      TableName: TABLE_BOOKKEEPING,
      Key: { PK: eventRow.PK, SK: eventRow.SK },
    }));

    const exportDir = await fs.mkdtemp(path.join(os.tmpdir(), "dataops-bookkeeping-audit-incomplete-"));
    try {
      await assert.rejects(
        writePortableExport(client, exportDir, { generatedAt: "2026-10-07T00:00:00.000Z" }),
        /Portable export rejected: bookkeeping audit export is incomplete or inconsistent/,
      );
    } finally {
      await fs.rm(exportDir, { recursive: true, force: true });
    }
  });
});
