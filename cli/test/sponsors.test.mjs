import assert from "node:assert/strict";
import { test } from "node:test";
import { run } from "../src/cli.mjs";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachInvoice, attachPaymentEvidence, receivePayment, correctPayment, approveSettlement, reverseSettlement, list } from "../src/commands/sponsors.mjs";

test("invoice evidence repair selects an already allocated receipt and previews the exact original", async () => {
  const originalFetch = globalThis.fetch, oldToken = process.env.DATAOPS_TOKEN;
  process.env.DATAOPS_TOKEN = "sanitized-test-token";
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, ...options });
    return new Response(JSON.stringify(url.endsWith("/finance") ? {
      finance: { version: 4 }, invoice: { id: "reviewed-original" }, payments: [{ id: "receipt", source: "ledger" }],
    } : { version: 1 }));
  };
  const args = { _: ["deal", "receipt"], url: "https://portal.example.test", json: true, idempotencyKey: "reviewed-evidence-012345" };
  try {
    const preview = await attachPaymentEvidence(args, {});
    assert.equal(preview.documentId, "reviewed-original");
    assert.deepEqual(preview.transactionIds, ["receipt"]);
    assert.ok(calls.every((call) => call.method === "GET"));
    await attachPaymentEvidence({ ...args, apply: true }, {});
    const mutation = calls.find((call) => call.method === "POST");
    assert.ok(mutation.url.endsWith("/finance/payment-evidence"));
    assert.deepEqual(JSON.parse(mutation.body), { dealVersion: 1, expectedVersion: 4, documentId: "reviewed-original", transactionIds: ["receipt"] });
    const writes = calls.filter((call) => call.method !== "GET").length;
    await assert.rejects(() => attachPaymentEvidence({ ...args, _: ["deal", "unrelated"], apply: true }, {}), /already allocated/);
    assert.equal(calls.filter((call) => call.method !== "GET").length, writes);
  } finally {
    globalThis.fetch = originalFetch;
    if (oldToken === undefined) delete process.env.DATAOPS_TOKEN; else process.env.DATAOPS_TOKEN = oldToken;
  }
});

test("invoice originals upload privately and attach without creating or settling a payment", async () => {
  const originalFetch = globalThis.fetch, oldToken = process.env.DATAOPS_TOKEN;
  process.env.DATAOPS_TOKEN = "sanitized-test-token";
  const directory = await mkdtemp(join(tmpdir(), "dataops-invoice-test-")), path = join(directory, "original.pdf");
  await writeFile(path, "%PDF-1.7\nSynthetic original invoice\n%%EOF");
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, ...options });
    let response = {};
    if (url.endsWith("/finance")) response = { finance: { version: 2 } };
    else if (url.endsWith("/deals/demo")) response = { version: 1 };
    else if (url.endsWith("/documents/prepare")) response = { document: { id: "original" }, uploadUrl: "https://private.example.test/object", uploadHeaders: { "content-type": "application/pdf" } };
    else if (url.endsWith("/complete")) response = { document: { id: "original" } };
    else if (url.includes("/candidates/invoices")) response = { items: [{ id: "original", identityToken: "verified-content-identity" }] };
    else if (url.endsWith("/finance/invoice")) response = { projection: { invoiceState: "issued" } };
    return new Response(JSON.stringify(response));
  };
  const args = { _: ["demo"], file: path, url: "https://portal.example.test", json: true };
  try {
    await attachInvoice(args, {});
    assert.equal(calls.filter((call) => call.method !== "GET").length, 0);
    const result = await attachInvoice({ ...args, apply: true }, {});
    assert.equal(result.documentId, "original");
    assert.equal(calls.filter((call) => call.url.endsWith("/complete")).length, 1);
    const upload = calls.find((call) => call.url === "https://private.example.test/object");
    assert.ok(Buffer.isBuffer(upload.body)); assert.equal(upload.headers.Authorization, undefined);
    const link = JSON.parse(calls.find((call) => call.url.endsWith("/finance/invoice")).body);
    assert.equal(link.identityToken, "verified-content-identity");
    assert.equal(link.sentOn, undefined); assert.equal(link.amount, undefined);
    assert.ok(calls.every((call) => !call.url.includes("/receipts") && !call.url.includes("/transactions")));
  } finally {
    globalThis.fetch = originalFetch;
    if (oldToken === undefined) delete process.env.DATAOPS_TOKEN; else process.env.DATAOPS_TOKEN = oldToken;
    await unlink(path); await rmdir(directory);
  }
});

test("receipt commands preview actual amounts and apply through the verified receipt API", async () => {
  const originalFetch = globalThis.fetch;
  const oldToken = process.env.DATAOPS_TOKEN;
  process.env.DATAOPS_TOKEN = "sanitized-test-token";
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, ...options, body: options.body && JSON.parse(options.body) });
    return new Response(JSON.stringify(options.method === "GET"
      ? (url.endsWith("/finance") ? { finance: { version: 4, amountDue: "100", currency: "EUR" } } : { version: 2 })
      : { projection: { paymentState: "partially-paid" } }));
  };
  const data = JSON.stringify({ receivedOn: "2026-10-01", amount: "95", currency: "EUR", counterparty: "Synthetic Sponsor", reference: "bank:account:txn-123", category: "Consulting" });
  const args = { _: ["demo"], data, url: "https://portal.example.test", token: "test", json: true };
  try {
    await receivePayment(args, {});
    assert.equal(calls.filter((call) => call.method !== "GET").length, 0);
    await receivePayment({ ...args, apply: true, idempotencyKey: "receipt-test-stable-012345" }, {});
    const create = calls.find((call) => call.method === "POST");
    assert.ok(create.url.endsWith("/finance/receipts"));
    assert.equal(create.body.amount, "95"); assert.equal(create.body.amountDue, undefined);
    assert.equal(create.body.expectedVersion, 4); assert.equal(create.body.dealVersion, 2);
    assert.equal(create.headers["Idempotency-Key"], "receipt-test-stable-012345");
    await correctPayment({ ...args, _: ["demo", "tx-demo"], apply: true }, {});
    assert.ok(calls.find((call) => call.method === "PUT").url.endsWith("/finance/receipts/tx-demo"));
  } finally {
    globalThis.fetch = originalFetch;
    if (oldToken === undefined) delete process.env.DATAOPS_TOKEN; else process.env.DATAOPS_TOKEN = oldToken;
  }
});

test("sponsor listing exhausts pages and reports explicit truncation", async () => {
  const originalFetch = globalThis.fetch;
  const oldToken = process.env.DATAOPS_TOKEN;
  process.env.DATAOPS_TOKEN = "sanitized-test-token";
  const values = Array.from({ length: 255 }, (_, index) => ({ id: `org-${index}` }));
  globalThis.fetch = async (url) => {
    const params = new URL(url).searchParams, start = Number(params.get("cursor") || 0), limit = Number(params.get("limit"));
    const end = Math.min(start + limit, values.length);
    return new Response(JSON.stringify({ items: values.slice(start, end), nextCursor: end < values.length ? String(end) : null }));
  };
  const args = { _: ["organizations"], url: "https://portal.example.test", token: "test", json: true };
  try {
    let result = await list(args, {});
    assert.equal(result.items.length, 255); assert.equal(result.complete, true); assert.equal(result.nextCursor, null);
    result = await list({ ...args, limit: "120" }, {});
    assert.equal(result.items.length, 120); assert.equal(result.complete, false); assert.equal(result.nextCursor, "120");
  } finally {
    globalThis.fetch = originalFetch;
    if (oldToken === undefined) delete process.env.DATAOPS_TOKEN; else process.env.DATAOPS_TOKEN = oldToken;
  }
});

test("unsupported sponsor invoice operations explain the working commands without a request", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error("Unexpected request"); };
  const errors = [];
  const io = { log() {}, error: (value) => errors.push(String(value)) };
  try {
    for (const action of ["list", "show", "create", "update"]) {
      assert.equal(await run(["sponsors", action, "invoices", "example", "--json"], io), 2);
    }
    assert.equal(calls, 0);
    assert.equal(errors.length, 4);
    for (const error of errors) {
      assert.match(error, /dataops invoices/);
      assert.match(error, /candidates\/invoices/);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sponsors update leads sends --reason as the lead's statusReason", async () => {
  const originalFetch = globalThis.fetch;
  const oldToken = process.env.DATAOPS_TOKEN;
  const oldUrl = process.env.DATAOPS_URL;
  process.env.DATAOPS_TOKEN = "sanitized-test-token";
  process.env.DATAOPS_URL = "https://portal.example.test";
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, method: options.method, body: options.body && JSON.parse(options.body) });
    return new Response(JSON.stringify({ id: "lead-demo", status: "ignored", statusReason: "House ad", version: 2 }));
  };
  const errors = [];
  const io = { log() {}, error: (value) => errors.push(value) };
  try {
    assert.equal(await run(["sponsors", "update", "leads", "lead-demo", "--data", '{"status":"ignored","version":1}', "--reason", "House ad", "--json"], io), 0);
    assert.equal(calls[0].method, "PATCH");
    assert.ok(calls[0].url.endsWith("/api/sponsor-crm/leads/lead-demo"));
    assert.deepEqual(calls[0].body, { status: "ignored", version: 1, statusReason: "House ad" });
    assert.equal(await run(["sponsors", "update", "deals", "deal-demo", "--data", '{"status":"won","version":1}', "--reason", "x"], io), 2);
    assert.equal(calls.length, 1, "--reason on a non-lead sends nothing");
    assert.ok(errors.some((value) => String(value).includes("leads only")));
  } finally {
    globalThis.fetch = originalFetch;
    if (oldToken === undefined) delete process.env.DATAOPS_TOKEN; else process.env.DATAOPS_TOKEN = oldToken;
    if (oldUrl === undefined) delete process.env.DATAOPS_URL; else process.env.DATAOPS_URL = oldUrl;
  }
});

test("sponsors link-payment links a transaction and replaces the payment recorded before it", async () => {
  const originalFetch = globalThis.fetch;
  const oldToken = process.env.DATAOPS_TOKEN;
  const oldUrl = process.env.DATAOPS_URL;
  process.env.DATAOPS_TOKEN = "sanitized-test-token";
  process.env.DATAOPS_URL = "https://portal.example.test";
  const calls = [];
  const finance = {
    finance: { version: 4, currency: "EUR" },
    payments: [{ id: "a".repeat(32), source: "recorded", amount: "500", currency: "EUR", effectiveDate: "2026-09-04" }],
  };
  const replies = {
    "GET /api/sponsor-crm/deals/deal-demo": { id: "deal-demo", version: 2 },
    "GET /api/sponsor-crm/deals/deal-demo/finance": finance,
    "GET /api/sponsor-crm/deals/deal-demo/finance/candidates/payments": (query) =>
      query.cursor
        ? { items: [{ id: "tx-demo", effectiveDate: "2026-09-05", amount: "500.00", currency: "EUR", identityToken: "token-demo" }] }
        : { items: [{ id: "tx-other", effectiveDate: "2026-01-01", amount: "1.00", currency: "EUR", identityToken: "x" }], nextCursor: "next" },
    "POST /api/sponsor-crm/deals/deal-demo/finance/payments": { projection: { paymentState: "paid" } },
  };
  globalThis.fetch = async (url, options) => {
    const parsed = new URL(url);
    const route = parsed.pathname.replace(/^\/work/, "");
    calls.push({ method: options.method, route, headers: options.headers, body: options.body && JSON.parse(options.body) });
    const reply = replies[`${options.method} ${route}`];
    const body = typeof reply === "function" ? reply(Object.fromEntries(parsed.searchParams)) : reply;
    return new Response(JSON.stringify(body));
  };
  const out = [];
  const io = { log: (value) => out.push(String(value)), error() {} };
  try {
    assert.equal(await run(["sponsors", "link-payment", "deal-demo", "tx-demo"], io), 0);
    assert.ok(!calls.some((call) => call.method === "POST"), "a dry run writes nothing");
    assert.match(out.join("\n"), /dry-run: link 2026-09-05 500\.00 EUR, replacing the payment recorded on 2026-09-04/);
    assert.equal(await run(["sponsors", "link-payment", "deal-demo", "tx-demo", "--apply"], io), 0);
    const post = calls.find((call) => call.method === "POST");
    assert.deepEqual(post.body, { dealVersion: 2, expectedVersion: 4, sourceId: "tx-demo", identityToken: "token-demo", replacesPaymentId: "a".repeat(32) });
    assert.match(post.headers["Idempotency-Key"], /^[A-Za-z0-9_-]{16,128}$/);
  } finally {
    globalThis.fetch = originalFetch;
    if (oldToken === undefined) delete process.env.DATAOPS_TOKEN; else process.env.DATAOPS_TOKEN = oldToken;
    if (oldUrl === undefined) delete process.env.DATAOPS_URL; else process.env.DATAOPS_URL = oldUrl;
  }
});

test("sponsors follow-up creates the payment follow-up Task with an Idempotency-Key", async () => {
  const originalFetch = globalThis.fetch;
  const oldToken = process.env.DATAOPS_TOKEN;
  const oldUrl = process.env.DATAOPS_URL;
  process.env.DATAOPS_TOKEN = "sanitized-test-token";
  process.env.DATAOPS_URL = "https://portal.example.test";
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const payload = options.body && JSON.parse(options.body);
    calls.push({ url, method: options.method, body: payload, headers: options.headers });
    if (String(url).endsWith("/finance")) {
      return new Response(JSON.stringify({ dealId: "deal-demo", finance: { version: 4 } }));
    }
    return new Response(JSON.stringify({ id: "deal-demo", version: 7, status: "agreed" }));
  };
  const logs = [];
  const io = { log: (value) => logs.push(String(value)), error() {} };
  try {
    assert.equal(await run(["sponsors", "follow-up", "deal-demo", "--date", "2026-10-20", "--json"], io), 0);
    assert.equal(calls.length, 3);
    assert.ok(calls[0].url.endsWith("/api/sponsor-crm/deals/deal-demo"));
    assert.ok(calls[1].url.endsWith("/api/sponsor-crm/deals/deal-demo/finance"));
    assert.ok(calls[2].url.endsWith("/api/sponsor-crm/deals/deal-demo/finance/follow-up"));
    assert.equal(calls[2].method, "POST");
    assert.deepEqual(calls[2].body, { dealVersion: 7, expectedVersion: 4, date: "2026-10-20" });
    assert.match(calls[2].headers["Idempotency-Key"], /^[A-Za-z0-9_-]{16,128}$/);
    assert.equal(calls[2].body.dealVersion, 7);
  } finally {
    globalThis.fetch = originalFetch;
    if (oldToken === undefined) delete process.env.DATAOPS_TOKEN; else process.env.DATAOPS_TOKEN = oldToken;
    if (oldUrl === undefined) delete process.env.DATAOPS_URL; else process.env.DATAOPS_URL = oldUrl;
  }
});


test("sponsors follow-up explicitly links existing work or submits the reviewed task versions", async () => {
  const originalFetch = globalThis.fetch;
  const oldToken = process.env.DATAOPS_TOKEN;
  const oldUrl = process.env.DATAOPS_URL;
  process.env.DATAOPS_TOKEN = "sanitized-test-token";
  process.env.DATAOPS_URL = "https://portal.example.test";
  const posts = [];
  globalThis.fetch = async (url, options) => {
    if (options.method === "POST") {
      posts.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ task: { id: "task-existing" } }));
    }
    return new Response(JSON.stringify(String(url).endsWith("/finance")
      ? { finance: { version: 4 }, paymentFollowUp: { existingTasks: [{ id: "task-existing", version: 3 }] } }
      : { id: "deal-demo", version: 7 }));
  };
  try {
    const io = { log() {}, error() {} };
    assert.equal(await run(["sponsors", "follow-up", "deal-demo", "--task", "task-existing", "--json"], io), 0);
    assert.deepEqual(posts[0], { dealVersion: 7, expectedVersion: 4, existingTaskId: "task-existing" });
    assert.equal(await run(["sponsors", "follow-up", "deal-demo", "--review-existing", "--json"], io), 0);
    assert.deepEqual(posts[1], { dealVersion: 7, expectedVersion: 4, reviewedOpenTasks: [{ id: "task-existing", version: 3 }] });
  } finally {
    globalThis.fetch = originalFetch;
    if (oldToken === undefined) delete process.env.DATAOPS_TOKEN; else process.env.DATAOPS_TOKEN = oldToken;
    if (oldUrl === undefined) delete process.env.DATAOPS_URL; else process.env.DATAOPS_URL = oldUrl;
  }
});


test("noncash approval and reversal preview first and preserve explicit proof and nominal restoration", async () => {
  const originalFetch = globalThis.fetch, oldToken = process.env.DATAOPS_TOKEN;
  process.env.DATAOPS_TOKEN = "sanitized-test-token";
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, ...options, body: options.body && JSON.parse(options.body) });
    return new Response(JSON.stringify(options.method === "GET"
      ? (url.endsWith("/finance") ? { finance: { version: 4, settlementAdjustment: { id: "approved" } } } : { version: 2 })
      : { financeVersion: 5 }));
  };
  const proof = { amount: "10", currency: "EUR", reason: "Approved conversion fee", approvedBy: "Owner", approvedOn: "2026-10-02",
    evidence: [{ kind: "document", ref: "owner-proof" }], replacesPaymentId: "reviewed-report",
    restoredInvoiceAmountDue: "1200", originalInvoiceDocumentId: "reviewed-original" };
  const args = { _: ["demo"], data: JSON.stringify(proof), url: "https://portal.example.test", json: true, idempotencyKey: "settlement-stable-012345" };
  try {
    await approveSettlement(args, {}); assert.equal(calls.filter((item) => item.method !== "GET").length, 0);
    await approveSettlement({ ...args, apply: true }, {});
    const approval = calls.find((item) => item.method === "POST");
    assert.ok(approval.url.endsWith("/finance/settlement-adjustment"));
    assert.deepEqual(approval.body, { ...proof, dealVersion: 2, expectedVersion: 4 });
    assert.equal(approval.headers["Idempotency-Key"], args.idempotencyKey);
    await reverseSettlement({ ...args, reason: "Owner revoked approval" }, {});
    assert.equal(calls.filter((item) => item.method === "DELETE").length, 0);
    await reverseSettlement({ ...args, reason: "Owner revoked approval", apply: true }, {});
    assert.deepEqual(calls.find((item) => item.method === "DELETE").body, { reason: "Owner revoked approval", dealVersion: 2, expectedVersion: 4 });
  } finally { globalThis.fetch = originalFetch; if (oldToken === undefined) delete process.env.DATAOPS_TOKEN; else process.env.DATAOPS_TOKEN = oldToken; }
});
