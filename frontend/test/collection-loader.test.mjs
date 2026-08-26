import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createCollectionLoader } from "../src/core/collection-loader.js";

function card(id) {
  return { id, title: `Card ${id}` };
}

describe("frontend collection loader", () => {
  test("requests bounded pages, accumulates nested items, and stops without a cursor", async () => {
    const calls = [];
    const payloads = [
      {
        cards: {
          items: [card("card-1"), card("card-2")],
          nextCursor: "cursor-1",
        },
      },
      {
        cards: {
          items: [card("card-2"), card("card-3")],
        },
      },
    ];
    const loader = createCollectionLoader({
      request: async () => payloads.shift(),
      createUrl: (parameters) => {
        calls.push(parameters);
        return new URL(
          `/api/cards?${new URLSearchParams(parameters)}`,
          "https://portal.test",
        );
      },
      collection: "cards",
    });

    const firstPage = await loader.load();
    assert.deepEqual(calls, [{ limit: 100 }]);
    assert.deepEqual(firstPage.items.map((item) => item.id), ["card-1", "card-2"]);
    assert.deepEqual(firstPage, {
      items: [card("card-1"), card("card-2")],
      cursor: "cursor-1",
      limit: 100,
      loaded: true,
      loading: false,
      loadingMore: false,
      moreAvailable: true,
      complete: false,
      failed: false,
      error: "",
    });

    const secondPage = await loader.loadMore();
    assert.deepEqual(calls, [
      { limit: 100 },
      { limit: 100, cursor: "cursor-1" },
    ]);
    assert.deepEqual(secondPage.items.map((item) => item.id), [
      "card-1",
      "card-2",
      "card-3",
    ]);
    assert.equal(secondPage.cursor, "");
    assert.equal(secondPage.moreAvailable, false);
    assert.equal(secondPage.complete, true);
    assert.equal(secondPage.failed, false);

    const terminal = await loader.loadMore();
    assert.deepEqual(calls.at(-1), { limit: 100, cursor: "cursor-1" });
    assert.deepEqual(terminal.items, secondPage.items);
  });

  test("preserves rows and the continuation cursor when another page fails, then retries cleanly", async () => {
    const payloads = [
      { files: { items: [{ id: "file-1" }], nextCursor: "keep-me" } },
      { message: "ignored after failure" },
      {
        files: {
          items: [{ id: "file-1" }, { id: "file-2" }],
        },
      },
    ];
    const requests = [];
    const loader = createCollectionLoader({
      request: async (url) => {
        requests.push(String(url));
        if (requests.length === 2) {
          payloads.shift();
          throw new Error("HTTP 503 Service Unavailable");
        }
        return payloads.shift();
      },
      createUrl: (parameters) =>
        new URL(
          `/api/files?${new URLSearchParams(parameters)}`,
          "https://portal.test",
        ),
      collection: "files",
    });

    await loader.load();
    const failed = await loader.loadMore();
    assert.deepEqual(failed.items.map((item) => item.id), ["file-1"]);
    assert.equal(failed.cursor, "keep-me");
    assert.equal(failed.moreAvailable, true);
    assert.equal(failed.complete, false);
    assert.equal(failed.failed, true);
    assert.equal(failed.error, "HTTP 503 Service Unavailable");

    const retried = await loader.loadMore();
    assert.match(requests[2], /cursor=keep-me/);
    assert.deepEqual(retried.items.map((item) => item.id), [
      "file-1",
      "file-2",
    ]);
    assert.equal(retried.failed, false);
    assert.equal(retried.error, "");
    assert.equal(retried.moreAvailable, false);
    assert.equal(retried.complete, true);
  });

  test("caps the requested page size and reports an invalid collection envelope without marking it loaded", async () => {
    const calls = [];
    const loader = createCollectionLoader({
      request: async () => ({ notifications: { items: "not-an-array" } }),
      createUrl: (parameters) => {
        calls.push(parameters);
        return new URL("https://portal.test/api/notifications");
      },
      collection: "notifications",
      limit: 500,
    });

    const failed = await loader.load();
    assert.deepEqual(calls, [{ limit: 200 }]);
    assert.deepEqual(failed.items, []);
    assert.equal(failed.limit, 200);
    assert.equal(failed.loaded, false);
    assert.equal(failed.failed, true);
    assert.equal(failed.error, "notifications collection response was invalid");
  });
});
