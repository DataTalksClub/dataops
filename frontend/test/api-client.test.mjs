import assert from "node:assert/strict";
import { describe, test } from "node:test";

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
