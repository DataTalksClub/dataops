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
