import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { captureIo, fakePortal, isolateConfig } from "./helpers.mjs";

isolateConfig();
const realFetch = globalThis.fetch;
const { run } = await import("../src/cli.mjs");

afterEach(() => {
  globalThis.fetch = realFetch;
});

const item = {
  id: "q-0123456789abcdef01234567",
  source: "aisl",
  kind: "event.updated",
  title: "Evals in CI moved",
  status: "new",
  receivedAt: "2026-11-15T10:00:00.000Z",
  idempotencyKey: "event-42-v3",
  payload: { eventId: 42 },
  links: [{ label: "Event", url: "https://aishippinglabs.com/events/evals-in-ci" }],
  history: [{ at: "2026-11-15T10:00:00.000Z", status: "new", by: "aisl" }],
};

describe("dataops queue", () => {
  test("list shows open items and forwards filters", async () => {
    const portal = fakePortal({ "GET /api/queue": () => ({ items: [item], count: 1 }) });
    const io = captureIo();
    assert.equal(await run(["queue", "list", "--source", "aisl"], io), 0);
    assert.match(io.text(), /q-0123456789abcdef01234567/);
    assert.match(io.text(), /event\.updated/);
    assert.equal(portal[0].query.source, "aisl");
  });

  test("show prints payload and links", async () => {
    fakePortal({ [`GET /api/queue/${item.id}`]: () => ({ item }) });
    const io = captureIo();
    assert.equal(await run(["queue", "show", item.id], io), 0);
    assert.match(io.text(), /aishippinglabs\.com/);
    assert.match(io.text(), /"eventId": 42/);
  });

  test("done requires a note and sends it", async () => {
    const portal = fakePortal({ [`PUT /api/queue/${item.id}/status`]: ({ body }) => ({ item: { ...item, status: body.status } }) });
    assert.equal(await run(["queue", "done", item.id], captureIo()), 2);
    assert.equal(portal.length, 0);
    assert.equal(await run(["queue", "done", item.id, "--note", "Card re-anchored"], captureIo()), 0);
    assert.deepEqual(portal[0].body, { status: "done", note: "Card re-anchored" });
  });

  test("ack marks an item acked", async () => {
    const portal = fakePortal({ [`PUT /api/queue/${item.id}/status`]: ({ body }) => ({ item: { ...item, status: body.status } }) });
    assert.equal(await run(["queue", "ack", item.id], captureIo()), 0);
    assert.equal(portal[0].body.status, "acked");
  });
});
