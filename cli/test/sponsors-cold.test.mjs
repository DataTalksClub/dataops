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

test("sponsors cold lists quiet orgs and reminds idempotently", async () => {
  const restore = sessionEnv();
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, method: options.method, body: options.body && JSON.parse(options.body) });
    if (String(url).includes("/api/sponsor-crm/cold/remind")) {
      return new Response(JSON.stringify({ created: [{ organizationId: "org-quiet", taskId: "task-1" }], skipped: ["org-nagged"] }));
    }
    return new Response(JSON.stringify({
      today: "2026-07-01",
      thresholds: { talking: 14 },
      items: [{ kind: "organization", id: "org-quiet", name: "Quiet Corp", relationship: "talking", daysSince: 30, threshold: 14, lastOutboundAt: "2026-06-01" }],
    }));
  };
  const out = [];
  const io = { log: (value) => out.push(String(value)), error() {} };
  try {
    assert.equal(await run(["sponsors", "cold", "--json"], io), 0);
    const list = calls.find((call) => call.method === "GET");
    assert.ok(list.url.includes("/api/sponsor-crm/cold"));
    assert.equal(await run(["sponsors", "cold", "--days", "30", "--remind"], io), 0);
    assert.ok(calls.find((call) => call.method === "GET" && call.url.includes("days=30")));
    const remind = calls.find((call) => call.method === "POST");
    assert.deepEqual(remind.body, { days: 30 });
    assert.match(out.join("\n"), /Quiet Corp/);
    assert.match(out.join("\n"), /Reminder Task task-1 for org-quiet/);
    assert.match(out.join("\n"), /Already reminded: org-nagged/);
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("sponsors touch requires a kind, channel and id, then logs the outreach", async () => {
  const restore = sessionEnv();
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, method: options.method, body: options.body && JSON.parse(options.body) });
    return new Response(JSON.stringify({ organization: { id: "org-quiet", lastOutboundAt: "2026-07-01" }, messageId: "msg-1" }));
  };
  const errors = [];
  const io = { log() {}, error: (value) => errors.push(String(value)) };
  try {
    assert.equal(await run(["sponsors", "touch", "org", "org-quiet", "--channel", "email", "--json"], io), 2);
    assert.equal(await run(["sponsors", "touch", "organization", "org-quiet", "--json"], io), 2);
    assert.equal(await run(["sponsors", "touch", "organization", "org-quiet", "--channel", "smoke", "--json"], io), 2);
    assert.equal(calls.length, 0, "usage errors send nothing");
    assert.equal(await run(["sponsors", "touch", "contact", "contact-1", "--channel", "email", "--note", "check-in", "--date", "2026-07-01", "--json"], io), 0);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, { targetType: "contact", targetId: "contact-1", channel: "email", note: "check-in", touchedAt: "2026-07-01" });
    assert.ok(calls[0].url.endsWith("/api/sponsor-crm/touches"));
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});
