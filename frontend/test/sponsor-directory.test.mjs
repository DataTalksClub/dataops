import assert from "node:assert/strict";
import { test } from "node:test";
import { readSponsorDirectory } from "../src/surfaces/finance/sponsors.js";

test("sponsor directory includes records beyond the first 100, with opaque cursors", async () => {
  const requests = [];
  const result = await readSponsorDirectory(async (path) => {
    requests.push(path);
    const url = new URL(path, "https://example.test");
    if (!url.searchParams.has("cursor")) return {
      items: Array.from({ length: 100 }, (_, i) => ({ id: `company-${i}` })),
      nextCursor: "opaque+/=cursor",
    };
    assert.equal(url.searchParams.get("cursor"), "opaque+/=cursor");
    return { items: [{ id: "later-company" }] };
  }, "organizations");
  assert.equal(requests.length, 2);
  assert.equal(result.items.length, 101);
  assert.equal(result.items.at(-1).id, "later-company");
});

test("empty filtered pages with cursors do not end the directory", async () => {
  let calls = 0;
  const result = await readSponsorDirectory(async () => ++calls === 1
    ? { items: [], nextCursor: "next" }
    : { items: [{ id: "contact" }] }, "contacts");
  assert.deepEqual(result.items, [{ id: "contact" }]);
});

test("a later page failure never returns a partial directory as complete", async () => {
  let calls = 0;
  await assert.rejects(readSponsorDirectory(async () => {
    if (++calls === 1) return { items: [{ id: "deal" }], nextCursor: "next" };
    throw new Error("provider unavailable");
  }, "deals"), /provider unavailable/);
});

test("repeated cursors and malformed pages fail visibly", async () => {
  await assert.rejects(readSponsorDirectory(async () => ({ items: [], nextCursor: "same" }), "deals"), /Repeated/);
  for (const value of [{}, { items: [], nextCursor: 123 }, { items: [{}] }]) {
    await assert.rejects(readSponsorDirectory(async () => value, "deals"), /Invalid/);
  }
});

test("pagination overlap keeps one current record per identity", async () => {
  let calls = 0;
  const result = await readSponsorDirectory(async () => ++calls === 1
    ? { items: [{ id: "deal", version: 1 }], nextCursor: "next" }
    : { items: [{ id: "deal", version: 2 }] }, "deals");
  assert.deepEqual(result.items, [{ id: "deal", version: 2 }]);
});

test("a nonterminating directory fails at a bounded limit", async () => {
  let calls = 0;
  await assert.rejects(readSponsorDirectory(async () => ({
    items: [], nextCursor: `cursor-${++calls}`,
  }), "deals"), /directory is incomplete/);
  assert.equal(calls, 100);
});
