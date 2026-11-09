import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

import { createApiClient } from "../src/shell/api.js";

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => JSON.stringify(payload),
  };
}

function createHarness() {
  const calls = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const client = createApiClient({
    apiBase: "https://ops.example.invalid",
    storage: { getItem: () => null },
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), method: options?.method });
      await gate;
      return jsonResponse({ url: String(url) });
    },
  });
  return { calls, client, release };
}

describe("createApiClient request coalescing", () => {
  test("shares one flight for identical concurrent GETs", async () => {
    const { calls, client, release } = createHarness();
    const first = client.request(new URL("https://ops.example.invalid/api/users"));
    const second = client.request(new URL("https://ops.example.invalid/api/users"));
    release();
    const [one, two] = await Promise.all([first, second]);
    assert.deepEqual(one, two);
    assert.equal(calls.length, 1);
  });

  test("does not coalesce different URLs or mutations", async () => {
    const { calls, client, release } = createHarness();
    const users = client.request(new URL("https://ops.example.invalid/api/users"));
    const cards = client.request(new URL("https://ops.example.invalid/api/cards"));
    const mutation = client.request(new URL("https://ops.example.invalid/api/users"), {
      method: "POST",
      body: "{}",
    });
    const mutationAgain = client.request(new URL("https://ops.example.invalid/api/users"), {
      method: "POST",
      body: "{}",
    });
    release();
    await Promise.all([users, cards, mutation, mutationAgain]);
    assert.equal(calls.length, 4);
  });

  test("fetches again after the shared flight settles", async () => {
    const { calls, client, release } = createHarness();
    const first = client.request(new URL("https://ops.example.invalid/api/users"));
    release();
    await first;
    await client.request(new URL("https://ops.example.invalid/api/users"));
    assert.equal(calls.length, 2);
  });
});

describe("createApiClient fail-loud", () => {
  function client(fetchImpl, timeoutMs = 20) {
    return createApiClient({
      apiBase: "https://ops.example.invalid",
      storage: { getItem: () => null },
      fetchImpl,
      timeoutMs,
    });
  }

  test("a hung request times out with a visible message and is reported", async () => {
    const reports = [];
    const { request } = client((url, options) => {
      if (String(url).endsWith("/api/client-errors")) {
        reports.push(JSON.parse(options.body));
        return Promise.resolve({});
      }
      return new Promise((_, reject) =>
        options.signal.addEventListener("abort", () => reject(options.signal.reason)),
      );
    });
    // AbortSignal.timeout timers are unref'd in Node; hold the loop open until it fires.
    const keepAlive = setTimeout(() => {}, 5000);
    after(() => clearTimeout(keepAlive));
    await assert.rejects(request(new URL("https://ops.example.invalid/api/me?x=1")), (error) => {
      assert.equal(error.status, "timeout");
      assert.match(error.message, /Could not load \/api\/me: it took too long/);
      return true;
    });
    assert.equal(reports[0].surface, "app-shell");
    assert.equal(reports[0].check, "/api/me");
  });

  test("a 5xx is reported and still rejects with the server error", async () => {
    const reports = [];
    const { request } = client((url, options) => {
      if (String(url).endsWith("/api/client-errors")) {
        reports.push(JSON.parse(options.body));
        return Promise.resolve({});
      }
      return Promise.resolve({
        ok: false,
        status: 503,
        statusText: "x",
        text: async () => JSON.stringify({ error: "down" }),
      });
    });
    await assert.rejects(request(new URL("https://ops.example.invalid/api/users")), /down/);
    assert.equal(reports[0].status, 503);
  });

  test("a 4xx is not reported", async () => {
    const reports = [];
    const { request } = client((url, options) => {
      if (String(url).endsWith("/api/client-errors")) reports.push(options.body);
      return Promise.resolve({ ok: false, status: 403, statusText: "", text: async () => "{}" });
    });
    await assert.rejects(request(new URL("https://ops.example.invalid/api/users")));
    assert.equal(reports.length, 0);
  });
});
