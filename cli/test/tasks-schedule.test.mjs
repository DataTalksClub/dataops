import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { captureIo, fakePortal, isolateConfig } from "./helpers.mjs";

isolateConfig();
delete process.env.DATAOPS_CAPABILITIES;
const realFetch = globalThis.fetch;
const { run } = await import("../src/cli.mjs");
const { civilToUtc, isValidTimezone, resolveDateTime } = await import("../src/format.mjs");
const { isScheduled, orderQueue, queueSegment } = await import("../src/commands/tasks.mjs");

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env.DATAOPS_TOKEN = "dops_test";
  delete process.env.DATAOPS_CAPABILITIES;
  delete process.env.DATAOPS_TODAY;
});

const task = (fields) => ({ status: "todo", version: 3, description: "Synthetic task", ...fields });

describe("tasks not-before datetimes", () => {
  test("civil datetimes resolve in the given timezone", () => {
    assert.equal(resolveDateTime("2026-10-23 19:00", "Europe/Berlin"), "2026-10-23T17:00:00.000Z");
    assert.equal(resolveDateTime("2026-10-23T19:00:00+02:00", "Europe/Berlin"), "2026-10-23T17:00:00.000Z");
    assert.equal(resolveDateTime("+7d", "Europe/Berlin", "2026-10-17"), "2026-10-23T22:00:00.000Z");
    assert.equal(resolveDateTime("2026-10-23", "Europe/Berlin"), "2026-10-22T22:00:00.000Z");
    assert.equal(resolveDateTime("someday", "Europe/Berlin", "2026-10-17"), undefined);
    assert.equal(civilToUtc("2026-01-23", "19:00:00", "Europe/Berlin"), "2026-01-23T18:00:00.000Z");
    assert.ok(isValidTimezone("Europe/Berlin"));
    assert.ok(!isValidTimezone("Mars/Base"));
  });

  test("a future moment hides the task from the queue until then", () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const past = new Date(Date.now() - 3600_000).toISOString();
    assert.ok(isScheduled(task({ notBeforeAt: future }), new Date().toISOString()));
    assert.ok(!isScheduled(task({ notBeforeAt: past }), new Date().toISOString()));
    assert.ok(!isScheduled(task({}), new Date().toISOString()));
    assert.equal(queueSegment(task({ id: "s", date: "2026-10-01", notBeforeAt: future }), "2026-10-17", new Date().toISOString()), "scheduled");
    const ordered = orderQueue(
      [task({ id: "s", date: "2026-10-01", notBeforeAt: future }), task({ id: "t", date: "2026-10-17" })],
      "2026-10-17",
      new Date().toISOString(),
    );
    assert.deepEqual(ordered.map((item) => item.id), ["t"]);
    const due = orderQueue(
      [task({ id: "s", date: "2026-10-01", notBeforeAt: past }), task({ id: "t", date: "2026-10-17" })],
      "2026-10-17",
      new Date().toISOString(),
    );
    assert.deepEqual(due.map((item) => [item.id, item.queueSegment]), [["s", "overdue"], ["t", "today"]]);
  });

  test("update --at sends the UTC instant with the timezone", async () => {
    const calls = fakePortal({
      "GET /api/tasks/t-1": task({ id: "t-1", version: 2 }),
      "PUT /api/tasks/t-1": ({ body }) => task({ id: "t-1", ...body, version: 3 }),
    });
    const io = captureIo();
    assert.equal(await run(["tasks", "update", "t-1", "--at", "2026-10-23 19:00", "--tz", "Europe/Berlin"], io), 0);
    assert.deepEqual(calls.at(-1).body, {
      notBeforeAt: "2026-10-23T17:00:00.000Z",
      timezone: "Europe/Berlin",
      expectedVersion: 2,
    });
    assert.match(io.text(), /Updated t-1/);
  });

  test("update --at takes +7d and none clears the moment", async () => {
    process.env.DATAOPS_TODAY = "2026-10-17";
    const calls = fakePortal({
      "GET /api/tasks/t-2": task({ id: "t-2", version: 2 }),
      "PUT /api/tasks/t-2": ({ body }) => task({ id: "t-2", ...body, version: 3 }),
    });
    assert.equal(await run(["tasks", "update", "t-2", "--at", "+7d"], captureIo()), 0);
    assert.equal(calls.at(-1).body.notBeforeAt, "2026-10-23T22:00:00.000Z");
    assert.equal(await run(["tasks", "update", "t-2", "--at", "none"], captureIo()), 0);
    assert.strictEqual(calls.at(-1).body.notBeforeAt, null);
  });

  test("--tz without --at, and unknown timezones, are usage errors", async () => {
    const calls = fakePortal({});
    let io = captureIo();
    assert.equal(await run(["tasks", "update", "t-3", "--tz", "Europe/Berlin"], io), 2);
    assert.match(io.errors.join("\n"), /--tz needs --at/);
    io = captureIo();
    assert.equal(await run(["tasks", "update", "t-3", "--at", "2026-10-23 19:00", "--tz", "Mars/Base"], io), 2);
    assert.match(io.errors.join("\n"), /must be an IANA timezone/);
    io = captureIo();
    assert.equal(await run(["tasks", "update", "t-3", "--at", "someday"], io), 2);
    assert.match(io.errors.join("\n"), /--at must be/);
    assert.equal(calls.length, 0);
  });

  test("show prints the moment", async () => {
    fakePortal({
      "GET /api/tasks/t-4": task({ id: "t-4", notBeforeAt: "2026-10-23T17:00:00.000Z" }),
    });
    const io = captureIo();
    assert.equal(await run(["tasks", "show", "t-4"], io), 0);
    assert.match(io.text(), /not before:\s+2026-10-23T17:00:00\.000Z/);
  });
});
