import { after, before, describe, it } from "node:test";
import assert from "node:assert";
import { createHash } from "crypto";
import { createServer } from "http";
import { Readable } from "stream";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { ZipFile } from "yazl";
import { DeleteCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { handler } from "../src/handler";
import { getClient, startLocal, stopLocal } from "../src/db/client";
import { createTables } from "../src/db/setup";
import { TABLE_BOOKKEEPING } from "../src/db/setup";
import { setBookkeepingArchiveUploaderForTests, setBookkeepingStorageForTests } from "../src/routes/bookkeeping";
import { addDocumentReportReference, putBookkeepingItem } from "../src/db/bookkeeping";
import { createUser } from "../src/db/users";
import { createBrowserSession, createSession, deleteSession } from "../src/db/sessions";
import { BookkeepingApi } from "../src/bookkeeping-document-import/api";
import { runImport } from "../scripts/import-bookkeeping-documents";

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
    const ready = await invoke("POST", "/api/bookkeeping/documents/hash-claims/backfill", { write: true });
    assert.equal(ready.statusCode, 200);
  });
  after(async () => {
    await stopLocal();
    process.env.SKIP_AUTH = "true";
  });

  it("allows one concurrent hash owner and makes completion retry idempotent", async () => {
    const request = (runId: string) =>
      invoke("POST", "/api/bookkeeping/documents/prepare", {
        sha256,
        byteSize: pdf.length,
        documentType: "receipt",
        idempotencyKey: `${runId}-owner`,
        runId,
        sourceRef: `${runId}-source`,
      });
    const prepared = await Promise.all([request("concurrent-a"), request("concurrent-b")]);
    assert.deepEqual(prepared.map((response) => response.statusCode).sort(), [201, 409]);
    assert.equal(signedInputs.at(-1)?.IfNoneMatch, "*");
    const winner = prepared.find((response) => response.statusCode === 201)!;
    const body = JSON.parse(winner.body);
    const runId = prepared[0] === winner ? "concurrent-a" : "concurrent-b";
    const ownership = { idempotencyKey: `${runId}-owner`, runId };
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
    const body = { documentId, transactionId: transaction.id, coverageType: "evidence", runId: "concurrent-link-run", sourceRef: "concurrent-link-source" };
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
    const ownership = { idempotencyKey: "invalid-owner", runId: "invalid-run" };
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
    const ownership = { idempotencyKey: "deferred-owner", runId: "deferred-run" };
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

  it("rolls back only run-owned resources and refuses external references", async () => {
    const tx = JSON.parse((await invoke("POST", "/api/bookkeeping/transactions", { transactionDate: "2026-07-01", counterparty: "Synthetic", description: "Synthetic", amount: "1.00", currency: "EUR" })).body);
    const tx2 = JSON.parse((await invoke("POST", "/api/bookkeeping/transactions", { transactionDate: "2026-07-02", counterparty: "Synthetic", description: "Synthetic", amount: "2.00", currency: "EUR" })).body);
    const runId = "rollback-run";
    const rollbackPdf = Buffer.from("%PDF-rollback-synthetic");
    objectBytes = rollbackPdf;
    const hash = createHash("sha256").update(rollbackPdf).digest("hex");
    const ownership = { idempotencyKey: "rollback-owner", runId };
    const prepared = JSON.parse((await invoke("POST", "/api/bookkeeping/documents/prepare", { sha256: hash, byteSize: rollbackPdf.length, documentType: "receipt", ...ownership, sourceRef: "rollback-source" })).body);
    await invoke("POST", `/api/bookkeeping/documents/${prepared.document.id}/complete`, ownership);
    const runLink = JSON.parse((await invoke("POST", "/api/bookkeeping/links", { documentId: prepared.document.id, transactionId: tx.id, coverageType: "evidence", runId, sourceRef: "run-link" })).body);
    assert.equal(runLink.createdByRunId, undefined);
    assert.equal(runLink.sourceRef, undefined);
    assert.equal(runLink.link.createdByRunId, undefined);
    const external = JSON.parse((await invoke("POST", "/api/bookkeeping/links", { documentId: prepared.document.id, transactionId: tx2.id, coverageType: "evidence" })).body);
    const preview = JSON.parse((await invoke("POST", `/api/bookkeeping/migration-runs/${runId}/rollback`, { write: false })).body);
    assert.deepEqual({ links: preview.links, documents: preview.documents, refused: preview.refusedDocuments }, { links: 1, documents: 1, refused: 1 });
    const refused = JSON.parse((await invoke("POST", `/api/bookkeeping/migration-runs/${runId}/rollback`, { write: true })).body);
    assert.equal(refused.remainingDocuments, 1);
    assert.equal((await invoke("DELETE", `/api/bookkeeping/links/${external.id}`)).statusCode, 204);
    const rolledBack = JSON.parse((await invoke("POST", `/api/bookkeeping/migration-runs/${runId}/rollback`, { write: true })).body);
    assert.equal(rolledBack.remainingDocuments, 0);
    assert.equal(deletedVersions.at(-1), "version-1");
    const retry = JSON.parse((await invoke("POST", `/api/bookkeeping/migration-runs/${runId}/rollback`, { write: true })).body);
    assert.deepEqual({ documents: retry.remainingDocuments, links: retry.remainingLinks }, { documents: 0, links: 0 });
    objectBytes = pdf;
  });

  it("paginates complete run reconciliation and rejects malformed tokens", async () => {
    const runId = `paged-run-${Date.now()}`;
    const created = [];
    for (let index = 0; index < 105; index++)
      created.push((await putBookkeepingItem(client, "link", {
        documentId: `synthetic-document-${index}`,
        transactionId: `synthetic-transaction-${index}`,
        coverageType: "evidence",
        createdByRunId: runId,
      }, `paged-link-${index}`)).item);
    try {
      const ids = new Set<string>();
      let nextToken: string | undefined;
      let pages = 0;
      do {
        const response = await invoke("POST", `/api/bookkeeping/migration-runs/${runId}/reconcile`, {
          kind: "link", limit: 17, ...(nextToken ? { nextToken } : {}),
        });
        assert.equal(response.statusCode, 200);
        const page = JSON.parse(response.body);
        page.items.forEach((item: { id: string }) => ids.add(item.id));
        nextToken = page.nextToken;
        pages += 1;
      } while (nextToken);
      assert.equal(ids.size, 105);
      assert.ok(pages > 1);
      assert.equal((await invoke("POST", `/api/bookkeeping/migration-runs/${runId}/reconcile`, { kind: "link", nextToken: "not-a-valid-token" })).statusCode, 400);
    } finally {
      await Promise.all(created.map((item) => client.send(new DeleteCommand({
        TableName: TABLE_BOOKKEEPING,
        Key: { PK: `LINK#${item.id}`, SK: `LINK#${item.id}` },
      }))));
    }
  });

  it("previews hash-claim readiness, writes claims, and fails closed on conflicts", async () => {
    const claimHash = createHash("sha256").update("synthetic-backfill").digest("hex");
    const first = (await putBookkeepingItem(client, "document", {
      status: "active", contentType: "application/pdf", documentType: "receipt", sha256: claimHash, byteSize: 20,
    }, "synthetic-backfill-first")).item;
    const second = (await putBookkeepingItem(client, "document", {
      status: "active", contentType: "application/pdf", documentType: "receipt", sha256: claimHash, byteSize: 20,
    }, "synthetic-backfill-second")).item;
    try {
      const conflict = await invoke("POST", "/api/bookkeeping/documents/hash-claims/backfill", { write: false });
      assert.equal(conflict.statusCode, 409);
      assert.ok(JSON.parse(conflict.body).conflicts > 0);
      await client.send(new DeleteCommand({ TableName: TABLE_BOOKKEEPING, Key: { PK: `DOCUMENT#${second.id}`, SK: `DOCUMENT#${second.id}` } }));
      const preview = JSON.parse((await invoke("POST", "/api/bookkeeping/documents/hash-claims/backfill", { write: false })).body);
      assert.equal(preview.created, 1);
      const written = JSON.parse((await invoke("POST", "/api/bookkeeping/documents/hash-claims/backfill", { write: true })).body);
      assert.equal(written.created, 1);
      assert.equal(written.ready, true);
      const repeat = JSON.parse((await invoke("POST", "/api/bookkeeping/documents/hash-claims/backfill", { write: false })).body);
      assert.equal(repeat.created, 0);
      assert.equal(repeat.existing >= 1, true);
    } finally {
      await Promise.all([
        client.send(new DeleteCommand({ TableName: TABLE_BOOKKEEPING, Key: { PK: `DOCUMENT#${first.id}`, SK: `DOCUMENT#${first.id}` } })),
        client.send(new DeleteCommand({ TableName: TABLE_BOOKKEEPING, Key: { PK: `DOCUMENT#${second.id}`, SK: `DOCUMENT#${second.id}` } })),
        client.send(new DeleteCommand({ TableName: TABLE_BOOKKEEPING, Key: { PK: `DOCUMENT_HASH#${claimHash}`, SK: `DOCUMENT_HASH#${claimHash}` } })),
      ]);
    }
  });

  it("serializes link/report reference races against rollback deletion", async () => {
    const activate = async (runId: string, value: Buffer) => {
      objectBytes = value;
      const hash = createHash("sha256").update(value).digest("hex");
      const ownership = { idempotencyKey: `${runId}-owner`, runId };
      const prepared = JSON.parse((await invoke("POST", "/api/bookkeeping/documents/prepare", {
        sha256: hash, byteSize: value.length, documentType: "receipt", ...ownership, sourceRef: `${runId}-source`,
      })).body);
      assert.equal((await invoke("POST", `/api/bookkeeping/documents/${prepared.document.id}/complete`, ownership)).statusCode, 200);
      return prepared.document.id as string;
    };
    const transaction = JSON.parse((await invoke("POST", "/api/bookkeeping/transactions", {
      transactionDate: "2026-07-09", counterparty: "Synthetic", description: "Rollback race", amount: "9.00", currency: "EUR",
    })).body);

    const linkRun = `link-race-${Date.now()}`;
    const linkDocument = await activate(linkRun, Buffer.from("%PDF-link-race"));
    const [linkResponse, linkRollbackResponse] = await Promise.all([
      invoke("POST", "/api/bookkeeping/links", {
        documentId: linkDocument, transactionId: transaction.id, coverageType: "evidence", runId: linkRun, sourceRef: "link-race-source",
      }),
      invoke("POST", `/api/bookkeeping/migration-runs/${linkRun}/rollback`, { write: true }),
    ]);
    const linkRollback = JSON.parse(linkRollbackResponse.body);
    assert.ok([0, 1].includes(linkRollback.remainingDocuments));
    const linkTruth = JSON.parse((await invoke("POST", "/api/bookkeeping/links/lookup", { tuples: [{ documentId: linkDocument, transactionId: transaction.id, coverageType: "evidence" }] })).body).results[0];
    assert.equal(linkTruth.state, linkRollback.remainingDocuments === 1 ? "active" : "absent");
    if (linkResponse.statusCode !== 201) assert.equal(linkRollback.remainingDocuments, 0);

    const reportRun = `report-race-${Date.now()}`;
    const reportDocument = await activate(reportRun, Buffer.from("%PDF-report-race"));
    const [referenceResult, reportRollbackResponse] = await Promise.allSettled([
      addDocumentReportReference(client, reportDocument, "synthetic-racing-report"),
      invoke("POST", `/api/bookkeeping/migration-runs/${reportRun}/rollback`, { write: true }),
    ]);
    assert.equal(reportRollbackResponse.status, "fulfilled");
    const reportRollback = JSON.parse(reportRollbackResponse.status === "fulfilled" ? reportRollbackResponse.value.body : "{}");
    if (referenceResult.status === "fulfilled" && referenceResult.value)
      assert.equal(reportRollback.remainingDocuments, 1);
    else
      assert.equal(reportRollback.remainingDocuments, 0);

    const refusedRun = `report-refusal-${Date.now()}`;
    const refusedDocument = await activate(refusedRun, Buffer.from("%PDF-report-refusal"));
    assert.equal(await addDocumentReportReference(client, refusedDocument, "synthetic-existing-report"), true);
    const refusedRollback = JSON.parse((await invoke("POST", `/api/bookkeeping/migration-runs/${refusedRun}/rollback`, { write: true })).body);
    assert.deepEqual(
      { refused: refusedRollback.refusedDocuments, remaining: refusedRollback.remainingDocuments },
      { refused: 1, remaining: 1 },
    );
    objectBytes = pdf;
  });

  it("checkpoints an exact-version rollback deletion failure and succeeds on retry", async () => {
    const runId = `delete-failure-${Date.now()}`;
    const value = Buffer.from("%PDF-exact-version-delete-failure");
    objectBytes = value;
    const hash = createHash("sha256").update(value).digest("hex");
    const ownership = { idempotencyKey: `${runId}-owner`, runId };
    const prepared = JSON.parse((await invoke("POST", "/api/bookkeeping/documents/prepare", {
      sha256: hash, byteSize: value.length, documentType: "receipt", ...ownership, sourceRef: `${runId}-source`,
    })).body);
    await invoke("POST", `/api/bookkeeping/documents/${prepared.document.id}/complete`, ownership);
    setBookkeepingStorageForTests({ send: async (command: any) => {
      if (command.constructor.name === "DeleteObjectCommand") {
        assert.equal(command.input.VersionId, "version-1");
        throw new Error("synthetic-delete-failure");
      }
      return {};
    } } as any, async () => "https://upload.invalid/signed");
    const failed = JSON.parse((await invoke("POST", `/api/bookkeeping/migration-runs/${runId}/rollback`, { write: true })).body);
    assert.deepEqual({ failed: failed.failedDocuments, remaining: failed.remainingDocuments }, { failed: 1, remaining: 1 });
    let retriedVersion = "";
    setBookkeepingStorageForTests({ send: async (command: any) => {
      if (command.constructor.name === "DeleteObjectCommand") retriedVersion = command.input.VersionId;
      return {};
    } } as any, async () => "https://upload.invalid/signed");
    const retried = JSON.parse((await invoke("POST", `/api/bookkeeping/migration-runs/${runId}/rollback`, { write: true })).body);
    assert.deepEqual({ failed: retried.failedDocuments, remaining: retried.remainingDocuments }, { failed: 0, remaining: 0 });
    assert.equal(retriedVersion, "version-1");
    objectBytes = pdf;
  });

  it("rejects all unauthorized probes with the same generic response", async () => {
    process.env.SKIP_AUTH = "false";
    try {
      process.env.BOOKKEEPING_INGESTION_SECRET = "synthetic-ingestion-only-secret";
      const routes: Array<[string, string, unknown?]> = [
        ["POST", "/api/bookkeeping/transactions/resolve", { sourceKeys: ["absent"] }],
        ["POST", "/api/bookkeeping/documents/hash-lookup", { hashes: [sha256] }],
        ["POST", "/api/bookkeeping/documents/hash-claims/backfill", { write: false }],
        ["POST", "/api/bookkeeping/documents/prepare", {}],
        ["POST", "/api/bookkeeping/documents/nonexistent/complete", {}],
        ["POST", "/api/bookkeeping/documents/nonexistent/cancel", {}],
        ["POST", "/api/bookkeeping/links/lookup", { tuples: [] }],
        ["GET", "/api/bookkeeping/documents"],
        ["POST", "/api/bookkeeping/migration-runs/nonexistent/rollback", { write: false }],
        ["POST", "/api/bookkeeping/migration-runs/nonexistent/reconcile", { kind: "document" }],
      ];
      const credentialHeaders = [
        {},
        { authorization: "Basic c3ludGhldGljOnNlY3JldA==" },
        { authorization: "Bearer eyJheader.payload.signature" },
        { "x-user-id": "fabricated-operator", "x-portal-auth": "true" },
        { "x-bookkeeping-ingestion-key": "synthetic-ingestion-only-secret" },
      ];
      const probes = await Promise.all(
        credentialHeaders.flatMap((headers) => routes.map(([method, route, body]) => invoke(method, route, body, headers))),
      );
      assert.ok(probes.every((response) => response.statusCode === 401 && response.body === '{"error":"Unauthorized"}'));
    } finally {
      delete process.env.BOOKKEEPING_INGESTION_SECRET;
      process.env.SKIP_AUTH = "true";
    }
  });

  it("authorizes every migration route with a browser cookie and rejects expired or revoked sessions", async () => {
    const saved = Object.fromEntries([
      "DATAOPS_DOCS_DOMAIN", "WORK_ENGINE_AUTH_MODE", "AUTH_BASE_URL", "AUTH_ISSUER",
      "AUTH_JWKS_URL", "AUTH_CLIENT_ID", "AUTH_CALLBACK_URL", "AUTH_LOGOUT_URL",
    ].map((key) => [key, process.env[key]]));
    process.env.SKIP_AUTH = "false";
    Object.assign(process.env, {
      DATAOPS_DOCS_DOMAIN: "true",
      WORK_ENGINE_AUTH_MODE: "portal",
      AUTH_BASE_URL: "https://auth.example.test",
      AUTH_ISSUER: "https://issuer.example.test/pool",
      AUTH_JWKS_URL: "https://issuer.example.test/pool/.well-known/jwks.json",
      AUTH_CLIENT_ID: "synthetic-client",
      AUTH_CALLBACK_URL: "https://ops.example.test/auth/callback",
      AUTH_LOGOUT_URL: "https://ops.example.test/",
    });
    try {
      const user = await createUser(client, { name: "Browser importer", email: `browser-${Date.now()}@example.test`, role: "operator" });
      const active = await createBrowserSession(client, user.id, { lifetimeSeconds: 3600 });
      const headers = { cookie: `dataops_session=${active.token}` };
      const routes: Array<[string, string, unknown?]> = [
        ["POST", "/api/bookkeeping/transactions/resolve", { sourceKeys: ["absent"] }],
        ["POST", "/api/bookkeeping/documents/hash-lookup", { hashes: [sha256] }],
        ["POST", "/api/bookkeeping/documents/hash-claims/backfill", { write: false }],
        ["POST", "/api/bookkeeping/documents/prepare", {}],
        ["POST", "/api/bookkeeping/documents/nonexistent/complete", {}],
        ["POST", "/api/bookkeeping/documents/nonexistent/cancel", { idempotencyKey: "synthetic-owner", runId: "synthetic-run" }],
        ["POST", "/api/bookkeeping/links/lookup", { tuples: [] }],
        ["GET", "/api/bookkeeping/documents"],
        ["POST", "/api/bookkeeping/migration-runs/nonexistent/rollback", { write: false }],
        ["POST", "/api/bookkeeping/migration-runs/nonexistent/reconcile", { kind: "document" }],
      ];
      const authorized = await Promise.all(routes.map(([method, route, body]) => invoke(method, route, body, headers)));
      assert.ok(authorized.every((response) => response.statusCode !== 401));

      const expired = await createBrowserSession(client, user.id, { lifetimeSeconds: -1 });
      const revoked = await createBrowserSession(client, user.id, { lifetimeSeconds: 3600 });
      await deleteSession(client, revoked.token);
      for (const token of [expired.token, revoked.token]) {
        const response = await invoke("POST", "/api/bookkeeping/documents/hash-lookup", { hashes: [sha256] }, { cookie: `dataops_session=${token}` });
        assert.equal(response.statusCode, 401);
        assert.equal(response.body, '{"error":"Unauthorized"}');
      }
    } finally {
      process.env.SKIP_AUTH = "true";
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
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

  it("resumes an interrupted HTTP import and proves a no-op rerun", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dataops-http-import-"));
    const firstPdf = Buffer.from("%PDF-http-first"), secondPdf = Buffer.from("%PDF-http-second");
    const zip = new ZipFile(), chunks: Buffer[] = [];
    zip.addBuffer(firstPdf, "first.pdf");
    zip.addBuffer(secondPdf, "second.pdf");
    zip.outputStream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    const ended = new Promise<void>((resolve) => zip.outputStream.once("end", resolve));
    zip.end();
    await ended;
    const archive = path.join(directory, "year.zip");
    await fs.writeFile(archive, Buffer.concat(chunks));
    const archiveHash = createHash("sha256").update(await fs.readFile(archive)).digest("hex");
    const firstHash = createHash("sha256").update(firstPdf).digest("hex"), secondHash = createHash("sha256").update(secondPdf).digest("hex");
    const sourceKey = "http-import-transaction";
    await invoke("POST", "/api/bookkeeping/transactions", { transactionDate: "2026-07-03", counterparty: "Synthetic", description: "Synthetic", amount: "3.00", currency: "EUR", sourceKey });
    const manifestPath = path.join(directory, "manifest.json");
    await fs.writeFile(manifestPath, JSON.stringify({
      schemaVersion: 1,
      archives: [{ alias: "year", year: 2026, sha256: archiveHash }],
      documents: [
        { sha256: firstHash, sources: [{ archive: "year", member: "first.pdf" }], documentType: "receipt", transactions: [{ sourceKey, coverageType: "evidence" }] },
        { sha256: secondHash, sources: [{ archive: "year", member: "second.pdf" }], documentType: "invoice", transactions: [], unlinkedApproved: true },
      ],
      exclusions: [],
    }));
    const user = await createUser(client, { name: "Importer", email: "importer@example.test", role: "operator" });
    const session = await createSession(client, user.id);
    let uploads = 0, remainingSecondFailures = 3;
    const server = createServer(async (request, response) => {
      if (request.method === "PUT" && request.url === "/signed-upload") {
        uploads += 1;
        const body: Buffer[] = [];
        for await (const chunk of request) body.push(Buffer.from(chunk));
        if (uploads >= 2 && remainingSecondFailures > 0) {
          remainingSecondFailures -= 1;
          response.writeHead(503);
          response.end();
          return;
        }
        objectBytes = Buffer.concat(body);
        response.writeHead(200);
        response.end();
        return;
      }
      const body: Buffer[] = [];
      for await (const chunk of request) body.push(Buffer.from(chunk));
      const result = await handler({ httpMethod: request.method || "GET", path: new URL(request.url || "/", `http://${request.headers.host}`).pathname, headers: Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, String(value)])), body: body.length ? Buffer.concat(body).toString() : null }, {});
      response.writeHead(result.statusCode, result.headers);
      response.end(result.body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      const origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
      setBookkeepingStorageForTests(
        {
          send: async (command: any) => {
            const name = command.constructor.name;
            if (name === "GetObjectCommand") return { Body: Readable.from(objectBytes), VersionId: "version-http" };
            if (name === "HeadObjectCommand") return { ContentLength: objectBytes.length, ContentType: "application/pdf", VersionId: "version-http" };
            if (name === "DeleteObjectCommand") return {};
            return {};
          },
        } as any,
        async () => `${origin}/signed-upload`,
      );
      const api = await BookkeepingApi.create({ origin, bearerToken: session.token, allowTestOrigin: true });
      const runId = `http-resume-${Date.now()}`;
      const common = { archives: [{ alias: "year", path: archive }], manifest: manifestPath, write: false, rollback: false, runId };
      const dry = await runImport(common, api) as any;
      assert.deepEqual({ unique: dry.unique, links: dry.links }, { unique: 2, links: 1 });
      const approval = path.resolve(process.cwd(), "../.tmp/bookkeeping-document-import", runId, "approval.json");
      const approvedPlan = JSON.parse(await fs.readFile(approval, "utf8")).plan;
      assert.deepEqual(approvedPlan.documentOutcomes, { create: 2, reuse: 0 });
      assert.deepEqual(approvedPlan.linkOutcomes, { create: 1, reuse: 0 });
      assert.equal(approvedPlan.documents.length, 2);
      assert.equal(approvedPlan.linkTuples.length, 1);
      assert.deepEqual(approvedPlan.categories.rejectedReasons, {});
      const approvedArchive = await fs.readFile(archive);
      await fs.appendFile(archive, "changed-after-approval");
      await assert.rejects(
        () => runImport({ ...common, write: true, approval, confirmOrigin: origin }, api),
        (error: Error) => error.message === "archive-fingerprint-mismatch",
      );
      await fs.writeFile(archive, approvedArchive);
      await assert.rejects(() => runImport({ ...common, write: true, approval, confirmOrigin: origin }, api), (error: Error) => error.message === "upload-transient-failure");
      const checkpointPath = path.join(path.dirname(approval), "checkpoint.json");
      const checkpoint = JSON.parse(await fs.readFile(checkpointPath, "utf8"));
      const originalId = checkpoint.documents[firstHash].id;
      checkpoint.documents[firstHash].id = "stale-checkpoint-document";
      await fs.writeFile(checkpointPath, JSON.stringify(checkpoint), { mode: 0o600 });
      const resumed = await runImport({ ...common, write: true, approval, confirmOrigin: origin }, api) as any;
      assert.deepEqual({ documents: resumed.documents, links: resumed.links }, { documents: 2, links: 1 });
      const repaired = JSON.parse(await fs.readFile(checkpointPath, "utf8"));
      assert.equal(repaired.documents[firstHash].id, originalId);
      const rerun = await runImport({ ...common, write: true, approval, confirmOrigin: origin }, api) as any;
      assert.deepEqual({ createdDocuments: rerun.createdDocuments, createdLinks: rerun.createdLinks }, { createdDocuments: 0, createdLinks: 0 });
      assert.equal(rerun.noOpExecution, true);
      const reconciliation = JSON.parse(await fs.readFile(path.join(path.dirname(approval), "reconciliation.json"), "utf8"));
      assert.deepEqual(reconciliation.outcomes.documents, approvedPlan.documentOutcomes);
      assert.deepEqual(reconciliation.outcomes.links, approvedPlan.linkOutcomes);
      assert.equal(reconciliation.documents.length, 2);
      assert.equal(reconciliation.links.length, 1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(directory, { recursive: true, force: true });
      const evidenceRoot = path.resolve(process.cwd(), "../.tmp/bookkeeping-document-import");
      for (const entry of await fs.readdir(evidenceRoot).catch(() => []))
        if (entry.startsWith("http-resume-"))
          await fs.rm(path.join(evidenceRoot, entry), { recursive: true, force: true });
      objectBytes = pdf;
    }
  });
});
