import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.mjs";
import { classifyFinance, recordInvoice, addEvidence, setWaiting } from "../src/commands/sponsorFinance.mjs";
import { attachInvoice } from "../src/commands/sponsors.mjs";

const args = (data, extra = {}) => ({ _: ["synthetic-deal"], data: JSON.stringify(data), url: "https://portal.example.test", json: true, ...extra });
const io = { print() {} };
async function mocked(finance, fn) {
  const originalFetch = globalThis.fetch, oldToken = process.env.DATAOPS_TOKEN;
  process.env.DATAOPS_TOKEN = "synthetic-test-token";
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const call = { url, ...options, body: options.body && JSON.parse(options.body) };
    calls.push(call);
    return new Response(JSON.stringify(options.method === "GET"
      ? url.endsWith("/finance") ? { finance } : { version: 3 }
      : { projection: { finance: { ...finance, version: 9 } } }));
  };
  try { await fn(calls); } finally {
    globalThis.fetch = originalFetch;
    if (oldToken === undefined) delete process.env.DATAOPS_TOKEN; else process.env.DATAOPS_TOKEN = oldToken;
  }
}

test("new finance classification previews only and applies with reviewed versions and an idempotency header", async () => {
  await mocked(undefined, async (calls) => {
    const data = { invoiceRequirement: "required", amountDue: "340", currency: "EUR", taxMode: "unknown" };
    const input = args(data, { idempotencyKey: "synthetic-classify-key" });
    const preview = await classifyFinance(input, io);
    assert.deepEqual(preview.request, { ...data, dealVersion: 3, expectedVersion: 0 });
    assert.ok(calls.every((call) => call.method === "GET"));
    await classifyFinance({ ...input, apply: true }, io);
    const write = calls.find((call) => call.method === "PUT");
    assert.ok(write.url.endsWith("/finance"));
    assert.deepEqual(write.body, preview.request);
    assert.equal(write.headers["Idempotency-Key"], preview.idempotencyKey);
  });
});

test("partial classification retains existing optional facts; explicit no-invoice classification discards money fields", async () => {
  await mocked({ version: 8, invoiceRequirement: "required", amountDue: "340", currency: "EUR", taxMode: "added", taxAmount: "40", requestBy: "2026-09-01" }, async () => {
    const preview = await classifyFinance(args({ expectedInvoiceBy: "2026-09-05" }), io);
    assert.equal(preview.request.taxAmount, "40");
    assert.equal(preview.request.requestBy, "2026-09-01");
    assert.equal(preview.request.expectedInvoiceBy, "2026-09-05");
    const noInvoice = await classifyFinance(args({ invoiceRequirement: "not-required" }), io);
    assert.deepEqual(noInvoice.request, { invoiceRequirement: "not-required", dealVersion: 3, expectedVersion: 8 });
  });
});

test("recording sent date preserves invoice number and chronology; explicit optional clearing is distinct from omission", async () => {
  await mocked({ version: 8, invoiceNumber: "DEMO/12", issuedOn: "2026-09-01", dueOn: "2026-10-01", sentOn: "2026-09-02" }, async (calls) => {
    const updated = await recordInvoice(args({ sentOn: "2026-09-03" }, { apply: true }), io);
    assert.deepEqual(updated.request, { invoiceNumber: "DEMO/12", issuedOn: "2026-09-01", dueOn: "2026-10-01", sentOn: "2026-09-03", dealVersion: 3, expectedVersion: 8 });
    assert.ok(calls.find((call) => call.method === "POST").url.endsWith("/finance/issue"));
    const cleared = await recordInvoice(args({ sentOn: null, invoiceNumber: null }), io);
    assert.equal(cleared.request.sentOn, "");
    assert.equal(cleared.request.invoiceNumber, "");
    await assert.rejects(recordInvoice(args({ dueOn: "2026-08-31" }), io), /must not precede/);
  });
});

test("evidence append/update preserves unrelated evidence, and waiting changes do not replace it", async () => {
  const existing = [{ kind: "document", ref: "synthetic-invoice" }, { kind: "email", ref: "synthetic-mail", label: "Invoice sent" }];
  await mocked({ version: 8, evidence: existing }, async (calls) => {
    const added = await addEvidence(args({ kind: "url", ref: "https://example.test/invoice" }), io);
    assert.deepEqual(added.request.evidence.slice(0, 2), existing);
    const updated = await addEvidence(args({ kind: "email", ref: "synthetic-mail", on: "2026-09-02" }), io);
    assert.equal(updated.request.evidence.length, 2);
    assert.equal(updated.request.evidence[1].label, "Invoice sent");
    const waiting = { party: "sponsor", reason: "invoice", since: "2026-09-02" };
    const result = await setWaiting(args(waiting, { apply: true }), io);
    assert.deepEqual(result.request, { waitingOn: waiting, dealVersion: 3, expectedVersion: 8 });
    assert.equal(calls.find((call) => call.method === "PUT").body.evidence, undefined);
    const cleared = await setWaiting(args(undefined, { data: undefined, clear: true }), io);
    assert.equal(cleared.request.waitingOn, null);
  });
});

test("reviewed version pins survive fresh state reads for exact idempotent retries; conflicts are surfaced without retry", async () => {
  await mocked({ version: 8, issuedOn: "2026-09-01", dueOn: "2026-10-01" }, async (calls) => {
    const result = await recordInvoice(args({ sentOn: "2026-09-02" }, { apply: true, expectedVersion: "7", dealVersion: "2", idempotencyKey: "synthetic-retry-key" }), io);
    assert.equal(result.request.expectedVersion, 7);
    assert.equal(result.request.dealVersion, 2);
    assert.equal(calls.filter((call) => call.method === "POST").length, 1);
    globalThis.fetch = async (url, options) => options.method === "POST"
      ? new Response(JSON.stringify({ error: "Finance state changed; reload and retry" }), { status: 409 })
      : new Response(JSON.stringify(url.endsWith("/finance") ? { finance: { version: 8, issuedOn: "2026-09-01", dueOn: "2026-10-01" } } : { version: 3 }));
    await assert.rejects(recordInvoice(args({ sentOn: "2026-09-02" }, { apply: true }), io), /Finance state changed/);
  });
});

test("missing issued metadata fails before uploading an original; verified dates allow atomic attachment and retry reuses upload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dataops-finance-cli-")), file = join(directory, "original.pdf");
  await writeFile(file, "%PDF-1.7\nSynthetic invoice\n%%EOF");
  try {
    await mocked({ version: 8 }, async (calls) => {
      await assert.rejects(attachInvoice(args(undefined, { data: undefined, file, apply: true }), io), /nothing was uploaded/);
      assert.ok(calls.every((call) => call.method === "GET"));
      await assert.rejects(attachInvoice(args(undefined, { data: undefined, file, issuedOn: "2026-09-01", apply: true }), io), /both/);
      const originalMock = globalThis.fetch;
      let prepares = 0;
      globalThis.fetch = async (url, options) => {
        if (url.endsWith("/documents/prepare")) { prepares++; return new Response(JSON.stringify({ outcome: "existing", document: { id: "stored-original" } })); }
        if (url.includes("/candidates/invoices")) return new Response(JSON.stringify({ items: [{ id: "stored-original", identityToken: "verified-source" }] }));
        if (url.endsWith("/finance/invoice")) {
          const data = JSON.parse(options.body);
          assert.equal(data.issuedOn, "2026-09-01"); assert.equal(data.dueOn, "2026-10-01");
          return new Response(JSON.stringify({ projection: { invoiceState: "issued" } }));
        }
        return originalMock(url, options);
      };
      const input = args(undefined, { data: undefined, file, issuedOn: "2026-09-01", dueOn: "2026-10-01", apply: true });
      assert.equal((await attachInvoice(input, io)).documentId, "stored-original");
      assert.equal((await attachInvoice(input, io)).documentId, "stored-original");
      assert.equal(prepares, 2); // prepare deduplicates by checksum; no PUT/complete repeated.
    });
  } finally { await rm(directory, { recursive: true }); }
});

test("all lifecycle commands are dispatched by the public CLI, with no browser fallback", async () => {
  const lines = [];
  const code = await run(["sponsors", "--help"], { log: (line) => lines.push(line), error: assert.fail });
  assert.equal(code, 0);
  for (const command of ["classify-finance", "record-invoice", "add-evidence", "set-waiting"]) assert.ok(lines.join("\n").includes(command));
  await mocked(undefined, async () => {
    const output = [];
    assert.equal(await run(["sponsors", "classify-finance", "synthetic-deal", "--data", '{"invoiceRequirement":"not-required"}', "--json"], { log: (line) => output.push(line), error: assert.fail }), 0);
    assert.equal(JSON.parse(output.join("\n")).request.invoiceRequirement, "not-required");
  });
});
