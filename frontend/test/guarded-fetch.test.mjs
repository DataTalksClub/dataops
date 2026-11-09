import assert from "node:assert/strict";
import test from "node:test";

import { guardedFetchJson } from "../src/core/guarded-fetch.js";

const opts = (fetchImpl, extra = {}) => ({ surface: "s", check: "c", what: "load the thing", fetchImpl, locationRef: { pathname: "/p" }, ...extra });

function recorder(handler) {
  const calls = [];
  const fetchImpl = (path, init) => {
    calls.push({ path, init });
    return path === "/api/client-errors" ? Promise.resolve({ status: 204 }) : handler(path, init);
  };
  return { calls, fetchImpl };
}

test("reports and explains a timeout", async () => {
  const { calls, fetchImpl } = recorder(() => Promise.reject(Object.assign(new Error("t"), { name: "TimeoutError" })));
  await assert.rejects(guardedFetchJson("/api/x", {}, opts(fetchImpl)), (error) => {
    assert.equal(error.status, "timeout");
    assert.match(error.message, /Could not load the thing.*too long.*Reload.*notified/);
    return true;
  });
  const report = JSON.parse(calls.find((c) => c.path === "/api/client-errors").init.body);
  assert.deepEqual({ surface: report.surface, status: report.status, message: report.message, page: report.page }, { surface: "s", status: null, message: "timeout", page: "/p" });
});

test("reports a 5xx but not an expected 4xx", async () => {
  const server = recorder(() => Promise.resolve({ status: 502, ok: false, json: async () => ({ error: "bad" }) }));
  await assert.rejects(guardedFetchJson("/api/x", {}, opts(server.fetchImpl)), /server returned an error \(502\)/);
  assert.equal(server.calls.filter((c) => c.path === "/api/client-errors").length, 1);

  const denied = recorder(() => Promise.resolve({ status: 403, ok: false, json: async () => ({ error: "no" }) }));
  const { response } = await guardedFetchJson("/api/x", {}, opts(denied.fetchImpl));
  assert.equal(response.status, 403);
  assert.equal(denied.calls.filter((c) => c.path === "/api/client-errors").length, 0);
});

test("a failing report never masks the visitor-facing error", async () => {
  const fetchImpl = (path) => (path === "/api/client-errors" ? Promise.reject(new Error("down")) : Promise.reject(new TypeError("net")));
  await assert.rejects(guardedFetchJson("/api/x", {}, opts(fetchImpl)), /connection failed/);
});
