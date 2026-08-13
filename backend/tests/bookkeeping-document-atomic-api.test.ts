import { after, before, describe, it } from "node:test";
import assert from "node:assert";
import { createHash } from "crypto";
import { Readable } from "stream";
import { UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { handler } from "../src/handler";
import { getClient } from "../src/db/client";
import { startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createTables } from "../scripts/local-dynamodb";
import { TABLE_BOOKKEEPING } from "../scripts/local-dynamodb";
import { setBookkeepingArchiveUploaderForTests, setBookkeepingStorageForTests } from "../src/routes/bookkeeping";
import { putBookkeepingItem } from "../src/db/bookkeeping";

const invoke = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  handler({ httpMethod: method, path, headers, body: body === undefined ? null : JSON.stringify(body) }, {});
const pdf = Buffer.from("%PDF-atomic-api-synthetic");
const sha256 = createHash("sha256").update(pdf).digest("hex");

describe("atomic bookkeeping document API", () => {
  let client: DynamoDBDocumentClient;
  const deletedVersions: string[] = [];
  const signedInputs: Record<string, unknown>[] = [];
  let objectBytes = pdf;
  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
    Object.assign(process.env, {
      SKIP_AUTH: "true",
      BOOKKEEPING_DOCUMENTS_BUCKET: "synthetic-versioned-bucket",
      BOOKKEEPING_DOCUMENTS_KMS_KEY: "synthetic-kms-key",
      BOOKKEEPING_UPLOAD_URL_SECONDS: "-1",
    });
    setBookkeepingStorageForTests(
      {
        send: async (command: any) => {
          const name = command.constructor.name;
          if (name === "GetObjectCommand") return { Body: Readable.from(objectBytes), VersionId: "version-1" };
          if (name === "HeadObjectCommand") return { ContentLength: objectBytes.length, ContentType: "application/pdf", VersionId: "version-1" };
          if (name === "DeleteObjectCommand") {
            deletedVersions.push(command.input.VersionId);
            return {};
          }
          return {};
        },
      } as any,
      async (_client, command: any) => {
        signedInputs.push(command.input);
        return "https://upload.invalid/signed";
      },
    );
  });
  after(async () => {
    await stopLocal();
    process.env.SKIP_AUTH = "true";
  });

  it("allows one concurrent hash owner and makes completion retry idempotent", async () => {
    const request = (requestId: string) =>
      invoke("POST", "/api/bookkeeping/documents/prepare", {
        sha256,
        byteSize: pdf.length,
        documentType: "receipt",
        idempotencyKey: `${requestId}-owner`,
        sourceRef: `${requestId}-source`,
      });
    const prepared = await Promise.all([request("concurrent-a"), request("concurrent-b")]);
    assert.deepEqual(prepared.map((response) => response.statusCode).sort(), [201, 409]);
    assert.equal(signedInputs.at(-1)?.IfNoneMatch, "*");
    const winner = prepared.find((response) => response.statusCode === 201)!;
    const body = JSON.parse(winner.body);
    const requestId = prepared[0] === winner ? "concurrent-a" : "concurrent-b";
    const ownership = { idempotencyKey: `${requestId}-owner` };
    const completed = await Promise.all([
      invoke("POST", `/api/bookkeeping/documents/${body.document.id}/complete`, ownership),
      invoke("POST", `/api/bookkeeping/documents/${body.document.id}/complete`, ownership),
    ]);
    assert.ok(completed.every((response) => response.statusCode === 200));
    assert.deepEqual(completed.map((response) => JSON.parse(response.body).outcome).sort(), ["created", "existing"]);
    const lookup = await invoke("POST", "/api/bookkeeping/documents/hash-lookup", { hashes: [sha256] });
    assert.equal(JSON.parse(lookup.body).results[0].state, "active");
    assert.equal((await invoke("GET", `/api/bookkeeping/documents/${body.document.id}/download`)).statusCode, 200);
    assert.match(String(signedInputs.at(-1)?.Key), /^documents\//);
  });

  it("creates exactly one link under concurrent tuple requests", async () => {
    const documentId = JSON.parse((await invoke("POST", "/api/bookkeeping/documents/hash-lookup", { hashes: [sha256] })).body).results[0].documentId;
    const transaction = JSON.parse((await invoke("POST", "/api/bookkeeping/transactions", {
      transactionDate: "2026-07-01", counterparty: "Synthetic", description: "Concurrent link", amount: "1.00", currency: "EUR",
    })).body);
    const body = { documentId, transactionId: transaction.id, coverageType: "evidence" };
    const responses = await Promise.all([
      invoke("POST", "/api/bookkeeping/links", body),
      invoke("POST", "/api/bookkeeping/links", body),
    ]);
    assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 201]);
    const payloads = responses.map((response) => JSON.parse(response.body));
    assert.deepEqual(payloads.map((item) => item.outcome).sort(), ["created", "existing"]);
    assert.equal(new Set(payloads.map((item) => item.link.id)).size, 1);
    const lookup = JSON.parse((await invoke("POST", "/api/bookkeeping/links/lookup", { tuples: [body] })).body);
    assert.deepEqual(lookup.results, [{ state: "active", id: payloads[0].link.id }]);
  });

  it("deletes the exact bad object version and releases a failed claim", async () => {
    const expected = Buffer.from("%PDF-expected-different");
    const expectedHash = createHash("sha256").update(expected).digest("hex");
    objectBytes = Buffer.from("%PDF-invalid-upload-value");
    const ownership = { idempotencyKey: "invalid-owner" };
    const prepared = await invoke("POST", "/api/bookkeeping/documents/prepare", {
      sha256: expectedHash,
      byteSize: objectBytes.length,
      documentType: "invoice",
      ...ownership,
      sourceRef: "invalid-source",
    });
    const document = JSON.parse(prepared.body).document;
    const completed = await invoke("POST", `/api/bookkeeping/documents/${document.id}/complete`, ownership);
    assert.equal(completed.statusCode, 400);
    assert.equal(deletedVersions.at(-1), "version-1");
    const lookup = await invoke("POST", "/api/bookkeeping/documents/hash-lookup", { hashes: [expectedHash] });
    assert.equal(JSON.parse(lookup.body).results[0].state, "absent");
    objectBytes = pdf;
  });

  it("defers invalid cleanup until signer expiry then lets the same owner recover", async () => {
    process.env.BOOKKEEPING_UPLOAD_URL_SECONDS = "60";
    const expected = Buffer.from("%PDF-deferred-A");
    objectBytes = Buffer.from("%PDF-deferred-B");
    const hash = createHash("sha256").update(expected).digest("hex");
    const ownership = { idempotencyKey: "deferred-owner" };
    const request = { sha256: hash, byteSize: expected.length, documentType: "receipt", ...ownership, sourceRef: "deferred-source" };
    const prepared = JSON.parse((await invoke("POST", "/api/bookkeeping/documents/prepare", request)).body);
    assert.equal((await invoke("POST", `/api/bookkeeping/documents/${prepared.document.id}/complete`, ownership)).statusCode, 409);
    const state = JSON.parse((await invoke("POST", "/api/bookkeeping/documents/hash-lookup", { hashes: [hash] })).body);
    assert.equal(state.results[0].state, "cleanup-required");
    await client.send(new UpdateCommand({
      TableName: TABLE_BOOKKEEPING,
      Key: { PK: `DOCUMENT#${prepared.document.id}`, SK: `DOCUMENT#${prepared.document.id}` },
      UpdateExpression: "SET uploadAuthorizationExpiresAt = :past",
      ExpressionAttributeValues: { ":past": new Date(Date.now() - 1000).toISOString() },
    }));
    objectBytes = expected;
    process.env.BOOKKEEPING_UPLOAD_URL_SECONDS = "-1";
    const recovered = await invoke("POST", "/api/bookkeeping/documents/prepare", request);
    assert.equal(recovered.statusCode, 201);
  });

  it("rejects all unauthorized probes with the same generic response", async () => {
    process.env.SKIP_AUTH = "false";
    try {
      const routes: Array<[string, string, unknown?]> = [
        ["POST", "/api/bookkeeping/transactions/resolve", { sourceKeys: ["absent"] }],
        ["POST", "/api/bookkeeping/documents/hash-lookup", { hashes: [sha256] }],
        ["POST", "/api/bookkeeping/documents/prepare", {}],
        ["POST", "/api/bookkeeping/documents/nonexistent/complete", {}],
        ["POST", "/api/bookkeeping/documents/nonexistent/cancel", {}],
        ["POST", "/api/bookkeeping/links/lookup", { tuples: [] }],
        ["GET", "/api/bookkeeping/documents"],
      ];
      const credentialHeaders = [
        {},
        { authorization: "Basic c3ludGhldGljOnNlY3JldA==" },
        { authorization: "Bearer eyJheader.payload.signature" },
        { "x-user-id": "fabricated-operator", "x-portal-auth": "true" },
      ];
      const probes = await Promise.all(
        credentialHeaders.flatMap((headers) => routes.map(([method, route, body]) => invoke(method, route, body, headers))),
      );
      assert.ok(probes.every((response) => response.statusCode === 401 && response.body === '{"error":"Unauthorized"}'));
    } finally {
      process.env.SKIP_AUTH = "true";
    }
  });

  it("retains cleanup-required state and never plain-deletes an unversioned archive", async () => {
    const report = (await putBookkeepingItem(client, "report", { month: "2026-11", status: "ready", transactionIds: [], documentIds: [] }, "synthetic-unversioned-report")).item;
    let deletes = 0;
    setBookkeepingArchiveUploaderForTests(async () => undefined);
    setBookkeepingStorageForTests(
      { send: async (command: any) => {
        if (command.constructor.name === "HeadObjectCommand") return {};
        if (command.constructor.name === "DeleteObjectCommand") deletes += 1;
        return {};
      } } as any,
      async () => "https://synthetic.invalid/signed",
    );
    const response = await invoke("POST", `/api/bookkeeping/reports/${report.id}/archive`);
    assert.equal(response.statusCode, 500);
    assert.equal(deletes, 0);
    const reports = JSON.parse((await invoke("GET", "/api/bookkeeping/reports")).body).items;
    assert.equal(reports.find((item: any) => item.id === report.id).status, "ready");
  });

});
