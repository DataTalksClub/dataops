import assert from "node:assert/strict";
import { test } from "node:test";
import { run } from "../src/cli.mjs";

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
