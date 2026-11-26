import assert from "node:assert/strict";
import { test } from "node:test";
import { run } from "../src/cli.mjs";

function sessionEnv() {
  const oldToken = process.env.DATAOPS_TOKEN;
  const oldUrl = process.env.DATAOPS_URL;
  process.env.DATAOPS_TOKEN = "sanitized-test-token";
  process.env.DATAOPS_URL = "https://portal.example.test";
  return () => {
    if (oldToken === undefined) delete process.env.DATAOPS_TOKEN; else process.env.DATAOPS_TOKEN = oldToken;
    if (oldUrl === undefined) delete process.env.DATAOPS_URL; else process.env.DATAOPS_URL = oldUrl;
  };
}

test("sponsors signals sends the Berlin window, source and cursor and prints coverage JSON", async () => {
  const restore = sessionEnv();
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url, options) => {
    urls.push({ url: String(url), method: options.method });
    return new Response(JSON.stringify({ items: [], nextCursor: "c2", complete: false, coverage: { matched: 0, returned: 0 } }));
  };
  const out = [];
  const io = { log: (value) => out.push(String(value)), error() {} };
  try {
    assert.equal(await run(["sponsors", "signals", "--from", "2026-11-16", "--before", "2026-11-23", "--source", "conference", "--limit", "20", "--cursor", "c1", "--json"], io), 0);
    const { url, method } = urls[0];
    assert.equal(method, "GET");
    const query = new URL(url).searchParams;
    assert.equal(new URL(url).pathname, "/api/sponsor-crm/signals");
    assert.deepEqual(Object.fromEntries(query), { from: "2026-11-16", before: "2026-11-23", source: "conference", limit: "20", cursor: "c1" });
    assert.equal(JSON.parse(out.join("")).nextCursor, "c2");
    assert.notEqual(await run(["sponsors", "signals", "--from", "2026-11-16", "--json"], io), 0);
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});
