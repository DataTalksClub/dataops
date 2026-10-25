import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { run } from "../src/cli.mjs";

test("invoice CLI follows reviewed revisions and exposes partial and verified destinations", async () => {
  const originalFetch = globalThis.fetch;
  const oldToken = process.env.DATAOPS_TOKEN;
  const oldUrl = process.env.DATAOPS_URL;
  process.env.DATAOPS_TOKEN = "sanitized-test-token";
  process.env.DATAOPS_URL = "https://portal.example.test";
  let record = { id: "invoice-demo", revision: 1, status: "pending", fields: {}, publicationStatus: "not-confirmed", destinations: {} };
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const body = options.body && JSON.parse(options.body);
    calls.push({ url, method: options.method, body });
    if (options.method === "PUT") { assert.equal(body.revision, 1); assert.equal(typeof body.fields.amount, "string"); assert.equal(typeof body.fields.amountEur, "string"); assert.equal(body.fields.quantity, 1); record = { ...record, revision: 2, fields: body.fields }; }
    if (url.endsWith("/verify")) {
      assert.equal(body.revision, 2);
      record = { ...record, status: "confirmed", publicationStatus: "incomplete", destinations: { dropbox: { state: "verified" }, sheets: { state: "blocked", error: "Verify configured headers" } } };
    }
    if (url.endsWith("/retry")) { assert.equal(body.revision, 2); record = { ...record, publicationStatus: "complete", destinations: { dropbox: { state: "verified" }, sheets: { state: "verified" } } }; }
    return new Response(JSON.stringify(url.endsWith("/process") ? { items: [record], issues: [] } : url.endsWith("/readiness") ? { ready: false, checks: [{ name: "mapping", ready: false, message: "Configure headers" }] } : url.endsWith("/invoices") ? { items: [record] } : record));
  };
  const out = [], errors = [];
  const io = { log: value => out.push(value), error: value => errors.push(value) };
  try {
    for (const args of [
      ["list"], ["detail", "invoice-demo"], ["readiness"],
      ["process", "--intake-item-id", "intake-demo"],
      ["edit", "invoice-demo", "--revision", "1", "--paid-date", "2026-10-01", "--amount", "12.00", "--amount-eur", "9.50", "--quantity", "1", "--payment-evidence", "Operator verified bank entry", "--archive-required", "true"],
      ["verify", "invoice-demo", "--revision", "2"], ["retry", "invoice-demo", "--revision", "2"],
      ["reextract", "invoice-demo", "--revision", "2"],
    ]) assert.equal(await run(["invoices", ...args, "--json"], io), 0);
    assert.ok(calls.some(call => call.url.endsWith("/reextract") && call.body.revision === 2));
    assert.equal(record.fields.amountEur, "9.50");
    assert.equal(record.fields.amount, "12.00");
    assert.equal(record.fields.archiveRequired, true);
    assert.ok(out.some(value => value.includes("Verify configured headers")));
    assert.equal(record.destinations.sheets.state, "verified");
    const before = calls.length;
    assert.equal(await run(["invoices", "verify", "invoice-demo"], io), 1);
    assert.equal(calls.length, before, "unreviewed verification cannot send a request");
    assert.ok(errors[0].includes("current reviewed revision"));
    assert.ok(calls.every(call => call.url.includes("/work/api/bookkeeping/invoices")));
  } finally {
    globalThis.fetch = originalFetch;
    if (oldToken === undefined) delete process.env.DATAOPS_TOKEN; else process.env.DATAOPS_TOKEN = oldToken;
    if (oldUrl === undefined) delete process.env.DATAOPS_URL; else process.env.DATAOPS_URL = oldUrl;
  }
});

test("edit --verified declares verification separately from decimal expense fields", async () => {
  const originalFetch = globalThis.fetch;
  const oldToken = process.env.DATAOPS_TOKEN;
  const oldUrl = process.env.DATAOPS_URL;
  process.env.DATAOPS_TOKEN = "sanitized-test-token";
  process.env.DATAOPS_URL = "https://portal.example.test";
  let sent;
  globalThis.fetch = async (_url, options) => {
    sent = JSON.parse(options.body);
    return new Response(JSON.stringify({ id: "invoice-demo", revision: 2, status: "confirmed", publicationStatus: "incomplete" }));
  };
  try {
    assert.equal(await run(["invoices", "edit", "invoice-demo", "--revision", "1", "--amount-eur", "10.50", "--verified", "--json"], { log() {}, error() {} }), 0);
    assert.deepEqual(sent, { revision: 1, fields: { amountEur: "10.50" }, verified: true });
    assert.equal(await run(["invoices", "edit", "invoice-demo", "--revision", "1", "--amount-eur", "10.50", "--verified=false", "--json"], { log() {}, error() {} }), 0);
    assert.deepEqual(sent, { revision: 1, fields: { amountEur: "10.50" } });
  } finally {
    globalThis.fetch = originalFetch;
    if (oldToken === undefined) delete process.env.DATAOPS_TOKEN; else process.env.DATAOPS_TOKEN = oldToken;
    if (oldUrl === undefined) delete process.env.DATAOPS_URL; else process.env.DATAOPS_URL = oldUrl;
  }
});

test("replace-document sends PDF and revision, supports re-extraction, reports conflicts and validates before requests", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dataops-replace-document-"));
  const originalFetch = globalThis.fetch;
  const oldToken = process.env.DATAOPS_TOKEN, oldUrl = process.env.DATAOPS_URL;
  process.env.DATAOPS_TOKEN = "synthetic-operator-token";
  process.env.DATAOPS_URL = "https://portal.example.test";
  const file = path.join(directory, "TEST.pdf");
  const bytes = Buffer.from("%PDF-synthetic-cli-fixture");
  const calls = [], errors = [], output = [];
  const io = { log: value => output.push(value), error: value => errors.push(value) };
  try {
    await writeFile(file, bytes);
    globalThis.fetch = async (url, options) => {
      const body = JSON.parse(options.body); calls.push({ url, body });
      return body.revision === 1
        ? new Response(JSON.stringify({ id: "test-draft", revision: 2, status: "pending" }))
        : new Response(JSON.stringify({ error: "Review changed: reload the current revision" }), { status: 409 });
    };
    assert.equal(await run(["invoices", "replace-document", "test-draft", "--file", file, "--revision", "1", "--json"], io), 0);
    assert.deepEqual(calls[0].body, { revision: 1, filename: "TEST.pdf", contentType: "application/pdf", contentBase64: bytes.toString("base64"), reextract: false });
    assert.ok(calls[0].url.endsWith("/work/api/bookkeeping/invoices/test-draft/replace-document"));
    assert.equal(await run(["invoices", "replace-document", "test-draft", "--file", file, "--revision", "1", "--reextract", "--json"], io), 0);
    assert.equal(calls[1].body.reextract, true);
    assert.equal(await run(["invoices", "replace-document", "test-draft", "--file", file, "--revision", "2", "--json"], io), 5);
    assert.ok(errors.some(value => value.includes("Review changed")));
    const count = calls.length;
    for (const flags of [["--file", file], ["--revision", "1"], ["--file", file, "--revision", "1", "--reextract=invalid"]])
      assert.equal(await run(["invoices", "replace-document", "test-draft", ...flags], io), 1);
    await writeFile(file, "not a PDF");
    assert.equal(await run(["invoices", "replace-document", "test-draft", "--file", file, "--revision", "1"], io), 1);
    assert.equal(calls.length, count);
    assert.equal(await run(["invoices", "replace-document", "--help"], io), 0);
    assert.ok(output.some(value => value.includes("--file <pdf> --revision N [--reextract]")));
  } finally {
    globalThis.fetch = originalFetch;
    if (oldToken === undefined) delete process.env.DATAOPS_TOKEN; else process.env.DATAOPS_TOKEN = oldToken;
    if (oldUrl === undefined) delete process.env.DATAOPS_URL; else process.env.DATAOPS_URL = oldUrl;
    await rm(directory, { recursive: true });
  }
});
