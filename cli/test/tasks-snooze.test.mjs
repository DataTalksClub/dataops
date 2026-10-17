import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { captureIo, fakePortal, isolateConfig } from "./helpers.mjs";

isolateConfig();
delete process.env.DATAOPS_CAPABILITIES;
const realFetch = globalThis.fetch;
const { run } = await import("../src/cli.mjs");
const { isSnoozed, orderQueue, queueSegment } = await import("../src/commands/tasks.mjs");

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env.DATAOPS_TOKEN = "dops_test";
  delete process.env.DATAOPS_CAPABILITIES;
  delete process.env.DATAOPS_TODAY;
});

const task = (fields) => ({ status: "todo", version: 3, description: "Synthetic task", ...fields });
const DAY = "2026-10-17";

describe("tasks snooze", () => {
  test("a snoozed task names its segment and stays out of the queue until then", () => {
    assert.equal(queueSegment(task({ id: "s", date: "2026-10-01", snoozedUntil: "2026-10-24" }), DAY), "snoozed");
    assert.ok(isSnoozed(task({ snoozedUntil: "2026-10-24" }), DAY));
    assert.ok(!isSnoozed(task({ snoozedUntil: "2026-10-17" }), DAY));
    assert.ok(!isSnoozed(task({}), DAY));
    const ordered = orderQueue(
      [
        task({ id: "s", date: "2026-10-01", snoozedUntil: "2026-10-24" }),
        task({ id: "t", date: DAY }),
      ],
      DAY,
    );
    assert.deepEqual(ordered.map((item) => item.id), ["t"]);
    const returned = orderQueue(
      [
        task({ id: "s", date: "2026-10-01", snoozedUntil: "2026-10-17" }),
        task({ id: "t", date: DAY }),
      ],
      DAY,
    );
    assert.deepEqual(returned.map((item) => [item.id, item.queueSegment]), [
      ["s", "overdue"],
      ["t", "today"],
    ]);
  });

  test("snooze sends the resolved date and the reason with the version", async () => {
    process.env.DATAOPS_TODAY = DAY;
    const calls = fakePortal({
      "GET /api/tasks/t-1": task({ id: "t-1", version: 2 }),
      "POST /api/tasks/t-1/actions/snooze": ({ body }) => task({ id: "t-1", ...body, version: 3 }),
    });
    const io = captureIo();
    assert.equal(await run(["tasks", "snooze", "t-1", "--until", "+7d", "--reason", "Waiting on sponsor"], io), 0);
    assert.deepEqual(calls.at(-1).body, { snoozedUntil: "2026-10-24", reason: "Waiting on sponsor", expectedVersion: 2 });
    assert.match(io.text(), /Snoozed t-1/);
    assert.equal(await run(["tasks", "snooze", "t-1", "--until", "+7d"], captureIo()), 2);
  });

  test("unsnooze returns the task to the queue", async () => {
    const calls = fakePortal({
      "GET /api/tasks/t-2": task({ id: "t-2", version: 5, snoozedUntil: "2026-10-24" }),
      "POST /api/tasks/t-2/actions/unsnooze": ({ body }) => task({ id: "t-2", ...body, version: 6 }),
    });
    const io = captureIo();
    assert.equal(await run(["tasks", "unsnooze", "t-2"], io), 0);
    assert.deepEqual(calls.at(-1).body, { expectedVersion: 5 });
    assert.match(io.text(), /Unsnoozed t-2/);
  });

  test("show prints the snooze fields", async () => {
    fakePortal({
      "GET /api/tasks/t-3": task({ id: "t-3", snoozedUntil: "2026-10-24", snoozeReason: "Waiting on sponsor" }),
    });
    const io = captureIo();
    assert.equal(await run(["tasks", "show", "t-3"], io), 0);
    assert.match(io.text(), /snoozed until:\s+2026-10-24/);
    assert.match(io.text(), /snooze reason:\s+Waiting on sponsor/);
  });

  test("the queue lanes leave snoozed tasks out", async () => {
    const calls = fakePortal({
      "GET /api/tasks": ({ query }) => ({
        tasks: query.date
          ? [task({ id: "today", date: query.date })]
          : query.status
            ? []
            : [task({ id: "late", date: "2026-10-01" }), task({ id: "snoozed", date: "2026-10-01", snoozedUntil: "2026-10-24" })],
      }),
    });
    const io = captureIo();
    assert.equal(await run(["tasks", "list", "--mine", "--as-of", DAY, "--json"], io), 0);
    assert.deepEqual(io.json().tasks.map((item) => item.id), ["late", "today"]);
    assert.equal(calls.length, 3);
  });
});
