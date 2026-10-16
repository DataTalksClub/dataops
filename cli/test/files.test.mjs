import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, test } from "node:test";

import { captureIo, fakePortal, isolateConfig } from "./helpers.mjs";

isolateConfig();
const realFetch = globalThis.fetch;
const { run } = await import("../src/cli.mjs");

afterEach(() => {
  globalThis.fetch = realFetch;
});

const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function workDir() {
  return mkdtempSync(path.join(tmpdir(), "dataops-files-"));
}

const signedLink = "https://task-files.test/private/proof.png?X-Amz-Expires=300&X-Amz-Signature=secret-sig";

function portalWithObject(bytes, { link = signedLink, objectStatus = 200 } = {}) {
  const serveObject = () => {
    if (objectStatus !== 200) return new Response("expired", { status: objectStatus });
    return new Response(bytes, { status: 200, headers: { "content-type": "image/png" } });
  };
  return fakePortal({
    "GET /api/files/f-1": {
      file: {
        id: "f-1",
        filename: "proof.png",
        storageProvider: "s3",
        sizeBytes: bytes.length,
        checksum: sha256(bytes),
      },
    },
    "GET /api/files/f-1/download": { downloadUrl: link, expiresIn: 300 },
    "GET /private/proof.png": serveObject,
    "GET /api/files/f-1/content": serveObject,
  });
}

describe("files download over signed links", () => {
  test("downloads via the signed link and never sends the portal Authorization header to storage", async () => {
    const bytes = Buffer.from("proof-bytes");
    const calls = portalWithObject(bytes);
    const output = path.join(workDir(), "out.png");
    const io = captureIo();

    assert.equal(await run(["files", "download", "f-1", "--output", output], io), 0);
    assert.deepEqual(readFileSync(output), bytes);

    const objectCall = calls.find((call) => call.rawPath === "/private/proof.png");
    assert.ok(objectCall, "the CLI must fetch the signed object URL");
    assert.equal(
      Object.keys(objectCall.headers ?? {}).some((header) => header.toLowerCase() === "authorization"),
      false,
      "no portal Authorization header may ride on the storage request",
    );
    assert.ok(io.text().includes("out.png"));
  });

  test("resolves a relative local-dev link against the portal base, still without credentials", async () => {
    const bytes = Buffer.from("dev-bytes");
    const calls = portalWithObject(bytes, { link: "/api/files/f-1/content?expires=9999999999&mac=cafe" });
    const output = path.join(workDir(), "dev.bin");
    const io = captureIo();

    assert.equal(await run(["files", "download", "f-1", "--output", output], io), 0);
    const objectCall = calls.find((call) => call.route === "/api/files/f-1/content");
    assert.ok(objectCall, "the relative link resolves against the portal base");
    assert.equal(
      Object.keys(objectCall.headers ?? {}).some((header) => header.toLowerCase() === "authorization"),
      false,
    );
    assert.deepEqual(readFileSync(output), bytes);
  });

  test("a refused link writes no output and its signed query string never reaches the log", async () => {
    const bytes = Buffer.from("never-written");
    const calls = portalWithObject(bytes, { objectStatus: 403 });
    const output = path.join(workDir(), "expired.png");
    const io = captureIo();

    assert.notEqual(await run(["files", "download", "f-1", "--output", output], io), 0);
    assert.equal(existsSync(output), false, "a failed transfer must not leave an output file");
    const printed = `${io.text()}\n${io.errors.join("\n")}`;
    assert.match(printed, /403/);
    assert.equal(printed.includes("secret-sig"), false, "the signed query string must not leak");
    assert.equal(printed.includes("X-Amz"), false);
    assert.equal(calls.filter((call) => call.rawPath === "/private/proof.png").length, 1);
  });

  test("content that fails the stored checksum is not written", async () => {
    const bytes = Buffer.from("tampered-bytes");
    fakePortal({
      "GET /api/files/f-1": {
        file: { id: "f-1", filename: "wrong.png", storageProvider: "s3", sizeBytes: bytes.length, checksum: sha256(Buffer.from("other-bytes")) },
      },
      "GET /api/files/f-1/download": { downloadUrl: signedLink, expiresIn: 300 },
      "GET /private/proof.png": () => new Response(bytes, { status: 200 }),
    });
    const output = path.join(workDir(), "wrong.png");
    const io = captureIo();

    assert.notEqual(await run(["files", "download", "f-1", "--output", output], io), 0);
    assert.equal(existsSync(output), false);
    assert.match(io.errors.join("\n"), /checksum/);
  });

  test("content that fails the stored size is not written", async () => {
    const bytes = Buffer.from("short");
    fakePortal({
      "GET /api/files/f-1": {
        file: { id: "f-1", filename: "short.png", storageProvider: "s3", sizeBytes: bytes.length + 10, checksum: sha256(bytes) },
      },
      "GET /api/files/f-1/download": { downloadUrl: signedLink, expiresIn: 300 },
      "GET /private/proof.png": () => new Response(bytes, { status: 200 }),
    });
    const output = path.join(workDir(), "short.png");
    const io = captureIo();

    assert.notEqual(await run(["files", "download", "f-1", "--output", output], io), 0);
    assert.equal(existsSync(output), false);
    assert.match(io.errors.join("\n"), /bytes but/);
  });

  test("a file without a download link answers with a usage error", async () => {
    fakePortal({
      "GET /api/files/f-1": { file: { id: "f-1", filename: "x.png", storageProvider: "s3" } },
      "GET /api/files/f-1/download": { status: 409, body: { error: "File storage provider is unavailable", code: "file_storage_unavailable" } },
    });
    const output = path.join(workDir(), "x.png");
    const io = captureIo();

    assert.notEqual(await run(["files", "download", "f-1", "--output", output], io), 0);
    assert.equal(existsSync(output), false);
    assert.match(io.errors.join("\n"), /File storage provider is unavailable/);
  });
});
