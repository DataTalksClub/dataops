import { afterEach, describe, it } from "node:test";
import assert from "node:assert";
import { createHash } from "crypto";
import { createServer, type Server } from "http";
import { Readable } from "stream";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { ZipFile } from "yazl";
import { BookkeepingApi } from "../src/bookkeeping-document-import/api";
import { inspectArchives, openArchiveMember } from "../src/bookkeeping-document-import/archive";
import { DEFAULT_LIMITS, ImportFailure, type Manifest } from "../src/bookkeeping-document-import/types";
import { validateManifest } from "../src/bookkeeping-document-import/manifest";
import { runImport } from "../scripts/import-bookkeeping-documents";

const temporary: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(temporary.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function workspace() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dataops-doc-import-"));
  temporary.push(directory);
  return directory;
}
async function zipFile(directory: string, members: { name: string; bytes: Buffer; mode?: number; compress?: boolean }[]) {
  const file = path.join(directory, "synthetic.zip");
  const zip = new ZipFile();
  for (const member of members)
    zip.addBuffer(member.bytes, member.name, { mode: member.mode, compress: member.compress });
  const chunks: Buffer[] = [];
  zip.outputStream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  const done = new Promise<void>((resolve, reject) => {
    zip.outputStream.once("end", resolve);
    zip.outputStream.once("error", reject);
  });
  zip.end();
  await done;
  await fs.writeFile(file, Buffer.concat(chunks));
  return file;
}

function markFirstZipMemberEncrypted(bytes: Buffer) {
  for (let offset = 0; offset <= bytes.length - 10; offset++) {
    const signature = bytes.readUInt32LE(offset);
    if (signature === 0x04034b50)
      bytes.writeUInt16LE(bytes.readUInt16LE(offset + 6) | 1, offset + 6);
    if (signature === 0x02014b50)
      bytes.writeUInt16LE(bytes.readUInt16LE(offset + 8) | 1, offset + 8);
  }
}
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function baseManifest(file: string, documents: Manifest["documents"], exclusions: Manifest["exclusions"] = []): Promise<Manifest> {
  return {
    schemaVersion: 1,
    archives: [{ alias: "year", year: 2026, sha256: digest(await fs.readFile(file)) }],
    documents,
    exclusions,
  };
}

describe("bookkeeping document archive safety", () => {
  it("streams PDFs, deduplicates content, and never opens explicit safe exclusions", async () => {
    const directory = await workspace();
    const pdf = Buffer.from("%PDF-synthetic-safe");
    const file = await zipFile(directory, [
      { name: "first.pdf", bytes: pdf },
      { name: "copy.pdf", bytes: pdf },
      { name: "preview.png", bytes: Buffer.from("not-opened-image") },
      { name: "package.zip", bytes: Buffer.from("not-opened-archive") },
    ]);
    const manifest = await baseManifest(
      file,
      [{ sha256: `sha256:${digest(pdf)}`, sources: [{ archive: "year", member: "first.pdf" }, { archive: "year", member: "copy.pdf" }], documentType: "receipt", transactions: [], unlinkedApproved: true }],
      [{ archive: "year", member: "preview.png", reason: "unsupported-image" }, { archive: "year", member: "package.zip", reason: "nested-packaging-archive" }],
    );
    const inventory = await inspectArchives([{ alias: "year", path: file }], manifest);
    assert.deepEqual({ occurrences: inventory.occurrenceCount, unique: inventory.uniqueCount, duplicates: inventory.duplicateCount, excluded: inventory.excluded.length }, { occurrences: 2, unique: 1, duplicates: 1, excluded: 2 });
  });

  it("fails closed for path, type, collision, magic, compression, exclusion, and fingerprint attacks", async () => {
    const pdf = Buffer.from("%PDF-hostile-fixture");
    const cases: { reason: string; members: { name: string; bytes: Buffer; mode?: number; compress?: boolean }[]; mutate?: (bytes: Buffer) => void; limits?: any; exclusions?: Manifest["exclusions"] }[] = [
      { reason: "unsafe-member-path", members: [{ name: "aaa.pdf", bytes: pdf }], mutate: (bytes) => { for (let at = bytes.indexOf("aaa.pdf"); at >= 0; at = bytes.indexOf("aaa.pdf", at + 1)) bytes.write("../x.pdf", at); } },
      { reason: "unsafe-member-path", members: [{ name: "aaa.pdf", bytes: pdf }], mutate: (bytes) => { for (let at = bytes.indexOf("aaa.pdf"); at >= 0; at = bytes.indexOf("aaa.pdf", at + 1)) bytes.write("/aa.pdf", at); } },
      { reason: "encrypted-member", members: [{ name: "secret.pdf", bytes: pdf }], mutate: markFirstZipMemberEncrypted },
      { reason: "non-regular-member", members: [{ name: "link.pdf", bytes: pdf, mode: 0o120777 }] },
      { reason: "normalized-path-collision", members: [{ name: "A.pdf", bytes: pdf }, { name: "a.pdf", bytes: pdf }] },
      { reason: "invalid-pdf-magic", members: [{ name: "bad.pdf", bytes: Buffer.from("not-pdf") }] },
      { reason: "compression-ratio-limit", members: [{ name: "bomb.pdf", bytes: Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(100_000)]), compress: true }], limits: { maxArchiveBytes: 1_000_000, maxMembers: 10, maxCompressedBytes: 1_000_000, maxMemberBytes: 1_000_000, maxTotalBytes: 1_000_000, maxCompressionRatio: 2 } },
      { reason: "invalid-exclusion", members: [{ name: "safe.pdf", bytes: pdf }], exclusions: [{ archive: "year", member: "safe.pdf", reason: "unsupported-image" }] },
    ];
    for (const fixture of cases) {
      const directory = await workspace();
      const file = await zipFile(directory, fixture.members);
      if (fixture.mutate) {
        const bytes = await fs.readFile(file);
        fixture.mutate(bytes);
        await fs.writeFile(file, bytes);
      }
      const sources = fixture.members.filter((item) => item.name.endsWith(".pdf") && !fixture.exclusions?.some((excluded) => excluded.member === item.name)).map((item) => ({ archive: "year", member: item.name }));
      const manifest = await baseManifest(file, sources.length ? [{ sha256: digest(fixture.members[0].bytes), sources, documentType: "receipt", transactions: [], unlinkedApproved: true }] : [], fixture.exclusions);
      await assert.rejects(() => inspectArchives([{ alias: "year", path: file }], manifest, fixture.limits), (error: ImportFailure) => error.reason === fixture.reason);
    }
  });

  it("enforces every archive, member, and aggregate resource bound before opening members", async () => {
    const pdfA = Buffer.from("%PDF-resource-limit-A-xxxxxxxxxxxxxxxx");
    const pdfB = Buffer.from("%PDF-resource-limit-B-yyyyyyyyyyyyyyyy");
    const fixtures: Array<{
      expected: string;
      members: { name: string; bytes: Buffer; compress?: boolean }[];
      limits: (archiveSize: number) => any;
    }> = [
      {
        expected: "archive-size-limit",
        members: [{ name: "one.pdf", bytes: pdfA, compress: false }],
        limits: (archiveSize) => ({ maxArchiveBytes: archiveSize - 1, maxCompressedBytes: archiveSize - 1 }),
      },
      {
        expected: "member-count-limit",
        members: [{ name: "one.pdf", bytes: pdfA }, { name: "two.pdf", bytes: pdfB }],
        limits: () => ({ maxMembers: 1 }),
      },
      {
        expected: "member-size-limit",
        members: [{ name: "one.pdf", bytes: pdfA, compress: false }],
        limits: () => ({ maxCompressedBytes: pdfA.length - 1 }),
      },
      {
        expected: "member-size-limit",
        members: [{ name: "one.pdf", bytes: pdfA }],
        limits: () => ({ maxMemberBytes: pdfA.length - 1 }),
      },
      {
        expected: "total-size-limit",
        members: [{ name: "one.pdf", bytes: pdfA }, { name: "two.pdf", bytes: pdfB }],
        limits: () => ({ maxTotalBytes: pdfA.length + pdfB.length - 1, maxMemberBytes: Math.max(pdfA.length, pdfB.length) }),
      },
    ];
    for (const fixture of fixtures) {
      const directory = await workspace();
      const file = await zipFile(directory, fixture.members);
      const documents = fixture.members.map((member) => ({
        sha256: digest(member.bytes),
        sources: [{ archive: "year", member: member.name }],
        documentType: "receipt" as const,
        transactions: [],
        unlinkedApproved: true as const,
      }));
      const manifest = await baseManifest(file, documents);
      const archiveSize = (await fs.stat(file)).size;
      await assert.rejects(
        () => inspectArchives([{ alias: "year", path: file }], manifest, { ...DEFAULT_LIMITS, ...fixture.limits(archiveSize) }),
        (error: ImportFailure) => error.reason === fixture.expected,
      );
    }
  });

  it("rejects malformed archives and hostile excluded members before applying exclusions", async () => {
    const malformedDirectory = await workspace();
    const malformed = path.join(malformedDirectory, "malformed.zip");
    await fs.writeFile(malformed, Buffer.from("not a zip central directory"));
    const malformedManifest = await baseManifest(malformed, []);
    await assert.rejects(
      () => inspectArchives([{ alias: "year", path: malformed }], malformedManifest),
      (error: ImportFailure) => error.reason === "malformed-archive",
    );

    const image = Buffer.from("synthetic-image-that-must-never-be-opened");
    const hostileFixtures: Array<{
      expected: string;
      mutate?: (bytes: Buffer) => void;
      limits?: any;
    }> = [
      { expected: "encrypted-member", mutate: markFirstZipMemberEncrypted },
      { expected: "member-size-limit", limits: { maxMemberBytes: image.length - 1 } },
    ];
    for (const fixture of hostileFixtures) {
      const directory = await workspace();
      const file = await zipFile(directory, [{ name: "preview.png", bytes: image }]);
      if (fixture.mutate) {
        const bytes = await fs.readFile(file);
        fixture.mutate(bytes);
        await fs.writeFile(file, bytes);
      }
      const manifest = await baseManifest(file, [], [
        { archive: "year", member: "preview.png", reason: "unsupported-image" },
      ]);
      await assert.rejects(
        () => inspectArchives([{ alias: "year", path: file }], manifest, { ...DEFAULT_LIMITS, ...fixture.limits }),
        (error: ImportFailure) => error.reason === fixture.expected,
      );
    }
  });

  it("rejects archive fingerprints and incomplete/conflicting source mappings", async () => {
    const directory = await workspace();
    const pdf = Buffer.from("%PDF-manifest");
    const file = await zipFile(directory, [{ name: "one.pdf", bytes: pdf }]);
    const manifest = await baseManifest(file, [{ sha256: digest(pdf), sources: [{ archive: "year", member: "one.pdf" }], documentType: "receipt", transactions: [], unlinkedApproved: true }]);
    manifest.archives[0].sha256 = "0".repeat(64);
    await assert.rejects(() => inspectArchives([{ alias: "year", path: file }], manifest), (error: ImportFailure) => error.reason === "archive-fingerprint-mismatch");
    manifest.archives[0].sha256 = digest(await fs.readFile(file));
    manifest.documents[0].sources = [];
    await assert.rejects(() => inspectArchives([{ alias: "year", path: file }], manifest), (error: ImportFailure) => error.reason === "manifest-source-coverage-mismatch");
  });

  it("revalidates the archive immediately before streaming an upload", async () => {
    const directory = await workspace();
    const pdf = Buffer.from("%PDF-before-change");
    const file = await zipFile(directory, [{ name: "one.pdf", bytes: pdf }]);
    const archiveSha256 = digest(await fs.readFile(file));
    await fs.appendFile(file, "changed");
    await assert.rejects(
      () => openArchiveMember(file, "one.pdf", { archiveSha256, sha256: digest(pdf), byteSize: pdf.length }),
      (error: ImportFailure) => error.reason === "archive-fingerprint-mismatch",
    );
  });

  it("runtime-validates exact manifest fields and statement coverage", () => {
    const statement: Manifest = {
      schemaVersion: 1,
      archives: [{ alias: "year", year: 2026, sha256: "a".repeat(64) }],
      documents: [{ sha256: "b".repeat(64), sources: [{ archive: "year", member: "statement.pdf" }], documentType: "bank-statement", accountId: "business-1", statementMonth: "2026-01", transactions: [{ sourceKey: "source", coverageType: "evidence" }] }],
      exclusions: [],
    };
    assert.throws(() => validateManifest(statement), (error: ImportFailure) => error.reason === "invalid-transaction-mapping");
    const extra = { ...statement, unexpectedPrivateField: "must-not-pass" } as Manifest;
    assert.throws(() => validateManifest(extra), (error: ImportFailure) => error.reason === "invalid-manifest");
    const excessiveArchives = {
      schemaVersion: 1,
      archives: Array.from({ length: 2_001 }, (_, index) => ({ alias: `year-${index}`, year: 2026, sha256: "a".repeat(64) })),
      documents: [],
      exclusions: [],
    } as Manifest;
    assert.throws(
      () => validateManifest(excessiveArchives),
      (error: ImportFailure) => error.reason === "invalid-manifest",
    );
  });
});

describe("operator authentication", () => {
  async function server(status = 200, redirect = false) {
    const instance = createServer((request, response) => {
      if (redirect) {
        response.writeHead(302, { location: "/login", "content-type": "application/json" });
        response.end("{}");
        return;
      }
      response.writeHead(status, { "content-type": "application/json" });
      response.end(status === 200 ? JSON.stringify({ user: { enabled: true } }) : JSON.stringify({ error: "Unauthorized" }));
    });
    await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
    servers.push(instance);
    const address = instance.address();
    return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  }

  it("accepts only a private, origin-bound, unexpired cookie file and does not follow redirects", async () => {
    const directory = await workspace();
    const origin = await server();
    const cookie = path.join(directory, "cookie.json");
    await fs.writeFile(cookie, JSON.stringify({ origin, expiresAt: new Date(Date.now() + 60_000).toISOString(), cookie: "opaque-session-token-1234567890" }), { mode: 0o600 });
    const api = await BookkeepingApi.create({ origin, cookieFile: cookie, allowTestOrigin: true });
    await api.preflight();
    await fs.chmod(cookie, 0o644);
    await assert.rejects(() => BookkeepingApi.create({ origin, cookieFile: cookie, allowTestOrigin: true }), (error: ImportFailure) => error.reason === "unsafe-cookie-file");
    const redirectedOrigin = await server(200, true);
    await fs.chmod(cookie, 0o600);
    await fs.writeFile(cookie, JSON.stringify({ origin: redirectedOrigin, expiresAt: new Date(Date.now() + 60_000).toISOString(), cookie: "opaque-session-token-1234567890" }), { mode: 0o600 });
    const redirected = await BookkeepingApi.create({ origin: redirectedOrigin, cookieFile: cookie, allowTestOrigin: true });
    await assert.rejects(() => redirected.preflight(), (error: ImportFailure) => error.reason === "unexpected-api-redirect");
  });

  it("validates cookie mode, owner, symlink, origin, and expiry independently", async () => {
    const directory = await workspace();
    const origin = await server();
    const cookie = path.join(directory, "cookie.json");
    const valid = { origin, expiresAt: new Date(Date.now() + 60_000).toISOString(), cookie: "opaque-session-token-1234567890" };
    const write = async (value: unknown = valid) => {
      await fs.rm(cookie, { force: true });
      await fs.writeFile(cookie, JSON.stringify(value), { mode: 0o600 });
    };

    await write();
    await fs.chmod(cookie, 0o640);
    await assert.rejects(() => BookkeepingApi.create({ origin, cookieFile: cookie, allowTestOrigin: true }), (error: ImportFailure) => error.reason === "unsafe-cookie-file");

    await write();
    const originalGetuid = process.getuid;
    Object.defineProperty(process, "getuid", { configurable: true, value: () => originalGetuid() + 1 });
    try {
      await assert.rejects(() => BookkeepingApi.create({ origin, cookieFile: cookie, allowTestOrigin: true }), (error: ImportFailure) => error.reason === "unsafe-cookie-file");
    } finally {
      Object.defineProperty(process, "getuid", { configurable: true, value: originalGetuid });
    }

    const target = path.join(directory, "cookie-target.json");
    await fs.rename(cookie, target);
    await fs.symlink(target, cookie);
    await assert.rejects(() => BookkeepingApi.create({ origin, cookieFile: cookie, allowTestOrigin: true }), (error: ImportFailure) => error.reason === "unsafe-cookie-file");

    await fs.rm(cookie);
    await write({ ...valid, origin: `${origin}/wrong` });
    await assert.rejects(() => BookkeepingApi.create({ origin, cookieFile: cookie, allowTestOrigin: true }), (error: ImportFailure) => error.reason === "invalid-cookie-file");

    await write({ ...valid, expiresAt: new Date(Date.now() - 1).toISOString() });
    await assert.rejects(() => BookkeepingApi.create({ origin, cookieFile: cookie, allowTestOrigin: true }), (error: ImportFailure) => error.reason === "invalid-cookie-file");
  });

  it("rejects wrong origins and unsafe auth modes while retaining opaque bearer compatibility", async () => {
    await assert.rejects(
      () => BookkeepingApi.create({ origin: "https://wrong.example.test", bearerToken: "opaque-session-token-1234567890" }),
      (error: ImportFailure) => error.reason === "invalid-api-origin",
    );
    await assert.rejects(
      () => BookkeepingApi.create({ origin: "https://ops.dtcdev.click", bearerToken: "eyJheader.payload.signature" }),
      (error: ImportFailure) => error.reason === "invalid-bearer-session",
    );
    await assert.rejects(
      () => BookkeepingApi.create({ origin: "https://ops.dtcdev.click", bearerToken: "Basic opaque-session-token" }),
      (error: ImportFailure) => error.reason === "invalid-bearer-session",
    );
    await assert.rejects(
      () => BookkeepingApi.create({ origin: "https://ops.dtcdev.click", bearerToken: "opaque-session-token-1234567890", cookieFile: "/unused" }),
      (error: ImportFailure) => error.reason === "invalid-auth-mode",
    );
    const origin = await server();
    const api = await BookkeepingApi.create({ origin, bearerToken: "opaque-session-token-1234567890", allowTestOrigin: true });
    await api.preflight();
  });

  it("retries only transient API responses and does not retry redirects or permanent auth failures", async () => {
    for (const fixture of [
      { statuses: [503, 503, 200], expectedCalls: 3, reason: undefined },
      { statuses: [401, 200], expectedCalls: 1, reason: "operator-auth-rejected" },
      { statuses: [400, 200], expectedCalls: 1, reason: "api-request-rejected" },
      { statuses: [302, 200], expectedCalls: 1, reason: "unexpected-api-redirect" },
    ]) {
      let calls = 0;
      const instance = createServer((_request, response) => {
        const status = fixture.statuses[Math.min(calls++, fixture.statuses.length - 1)];
        response.writeHead(status, {
          "content-type": "application/json",
          ...(status === 302 ? { location: "/login" } : {}),
        });
        response.end(status === 200 ? JSON.stringify({ user: { enabled: true } }) : JSON.stringify({ error: "rejected" }));
      });
      await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
      servers.push(instance);
      const address = instance.address();
      const origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
      const api = await BookkeepingApi.create({ origin, bearerToken: "opaque-session-token-1234567890", allowTestOrigin: true });
      if (fixture.reason)
        await assert.rejects(() => api.preflight(), (error: ImportFailure) => error.reason === fixture.reason);
      else
        await api.preflight();
      assert.equal(calls, fixture.expectedCalls);
    }
  });

  it("reopens upload streams for transient PUT retries and never retries permanent rejection", async () => {
    for (const fixture of [
      { statuses: [503, 429, 200], expectedCalls: 3, expectedOpens: 3, reason: undefined },
      { statuses: [400, 200], expectedCalls: 1, expectedOpens: 1, reason: "upload-rejected" },
      { statuses: [302, 200], expectedCalls: 1, expectedOpens: 1, reason: "upload-rejected" },
    ]) {
      let calls = 0;
      let opens = 0;
      const instance = createServer(async (request, response) => {
        for await (const _chunk of request) { /* consume the synthetic stream */ }
        const status = fixture.statuses[Math.min(calls++, fixture.statuses.length - 1)];
        response.writeHead(status, status === 302 ? { location: "/elsewhere" } : {});
        response.end();
      });
      await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
      servers.push(instance);
      const address = instance.address();
      const uploadUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/upload`;
      const api = await BookkeepingApi.create({ origin: await server(), bearerToken: "opaque-session-token-1234567890", allowTestOrigin: true });
      const upload = () => api.upload(uploadUrl, {}, async () => {
        opens += 1;
        return { stream: Readable.from(Buffer.from("synthetic-upload")), close: () => undefined };
      });
      if (fixture.reason)
        await assert.rejects(upload, (error: ImportFailure) => error.reason === fixture.reason);
      else
        assert.equal(await upload(), "uploaded");
      assert.deepEqual({ calls, opens }, { calls: fixture.expectedCalls, opens: fixture.expectedOpens });
    }
  });

  it("honors numeric and HTTP-date Retry-After delays with a two-second cap", async () => {
    const fixtures = [
      { retryAfter: "1", expected: 1_000 },
      { retryAfter: new Date(Date.now() + 1_500).toUTCString(), expected: "http-date" },
      { retryAfter: "999", expected: 2_000 },
    ] as const;
    for (const fixture of fixtures) {
      let calls = 0;
      const instance = createServer(async (request, response) => {
        for await (const _chunk of request) { /* consume */ }
        calls += 1;
        response.writeHead(calls === 1 ? 429 : 200, calls === 1 ? { "retry-after": fixture.retryAfter } : {});
        response.end();
      });
      await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
      servers.push(instance);
      const address = instance.address();
      const uploadUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/upload`;
      const delays: number[] = [];
      const api = await BookkeepingApi.create({
        origin: await server(),
        bearerToken: "opaque-session-token-1234567890",
        allowTestOrigin: true,
        sleep: async (milliseconds) => { delays.push(milliseconds); },
      });
      assert.equal(await api.upload(uploadUrl, {}, async () => ({ stream: Readable.from("retry-after"), close: () => undefined })), "uploaded");
      assert.equal(calls, 2);
      assert.equal(delays.length, 1);
      if (fixture.expected === "http-date")
        assert.ok(delays[0] > 100 && delays[0] <= 1_500);
      else
        assert.equal(delays[0], fixture.expected);
    }
  });

  it("preflights auth before reading manifest or archive input", async () => {
    let preflight = false;
    const fake = { origin: "https://example.invalid", preflight: async () => { preflight = true; throw new ImportFailure("operator-auth-rejected"); } } as BookkeepingApi;
    await assert.rejects(() => runImport({ archives: [{ alias: "missing", path: "/missing.zip" }], manifest: "/missing.json", write: false, rollback: false }, fake), (error: ImportFailure) => error.reason === "operator-auth-rejected");
    assert.equal(preflight, true);
  });

  it("rejects invalid run IDs before resolving an evidence path", async () => {
    const fake = { origin: "https://example.invalid", preflight: async () => undefined } as BookkeepingApi;
    await assert.rejects(
      () => runImport({ archives: [], write: false, rollback: true, runId: "../../escape" }, fake),
      (error: ImportFailure) => error.reason === "invalid-run-id",
    );
  });

  it("keeps storage SDKs out of the importer", async () => {
    const source = await fs.readFile(path.resolve("scripts/import-bookkeeping-documents.ts"), "utf8");
    assert.equal(/@aws-sdk|DynamoDB|S3Client|PutObjectCommand/.test(source), false);
    const packageJson = JSON.parse(await fs.readFile(path.resolve("package.json"), "utf8"));
    assert.equal(packageJson.dependencies.yauzl, "3.4.0");
  });

  it("persists rollback failure evidence before exit and retries idempotently", async () => {
    const runId = `rollback-checkpoint-${Date.now()}`;
    const evidence = path.resolve(process.cwd(), "../.tmp/bookkeeping-document-import", runId);
    const responses = [
      { links: 0, documents: 1, refusedDocuments: 0, deferredDocuments: 0 },
      { remainingDocuments: 1, remainingLinks: 0, failedDocuments: 1, refusedDocuments: 0 },
      { links: 0, documents: 1, refusedDocuments: 0, deferredDocuments: 0 },
      { remainingDocuments: 0, remainingLinks: 0, failedDocuments: 0, refusedDocuments: 0 },
    ];
    const api = {
      origin: "https://synthetic.example.test",
      preflight: async () => undefined,
      request: async () => responses.shift(),
    } as unknown as BookkeepingApi;
    const args = { archives: [], write: true, rollback: true, runId, confirmOrigin: api.origin, limits: { ...DEFAULT_LIMITS } };
    try {
      await assert.rejects(
        () => runImport(args, api),
        (error: ImportFailure) => error.reason === "rollback-reconciliation-mismatch",
      );
      const failed = JSON.parse(await fs.readFile(path.join(evidence, "rollback-result.json"), "utf8"));
      assert.deepEqual({ failed: failed.failedDocuments, remaining: failed.remainingDocuments }, { failed: 1, remaining: 1 });
      const retry = await runImport(args, api) as { remainingDocuments: number; failedDocuments: number };
      assert.deepEqual({ failed: retry.failedDocuments, remaining: retry.remainingDocuments }, { failed: 0, remaining: 0 });
      const journal = await fs.readFile(path.join(evidence, "journal.ndjson"), "utf8");
      assert.equal(journal.trim().split("\n").length, 4);
    } finally {
      await fs.rm(evidence, { recursive: true, force: true });
    }
  });
});
