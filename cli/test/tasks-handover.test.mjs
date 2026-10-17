import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { captureIo, fakePortal, isolateConfig } from "./helpers.mjs";

isolateConfig();
delete process.env.DATAOPS_CAPABILITIES;
const realFetch = globalThis.fetch;
const { run } = await import("../src/cli.mjs");

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env.DATAOPS_TOKEN = "dops_test";
  delete process.env.DATAOPS_CAPABILITIES;
  delete process.env.DATAOPS_TODAY;
});

const task = (fields) => ({ status: "todo", version: 3, description: "Synthetic task", ...fields });

describe("tasks handover and queue", () => {
  test("--mine --queue is the queue view over the three lanes", async () => {
    const calls = fakePortal({
      "GET /api/tasks": ({ query }) => ({
        tasks: query.date ? [task({ id: "today", date: query.date })] : query.status ? [] : [task({ id: "late", date: "2026-10-01" })],
      }),
    });
    const io = captureIo();
    assert.equal(await run(["tasks", "list", "--mine", "--queue", "--as-of", "2026-10-14", "--json"], io), 0);
    assert.equal(io.json().view, "queue");
    assert.deepEqual(io.json().tasks.map((item) => item.id), ["late", "today"]);
    assert.equal(calls.length, 3);
  });

  test("handover --from --to moves every open task and skips the rest", async () => {
    const calls = fakePortal({
      "GET /api/tasks": {
        tasks: [
          task({ id: "a", version: 1 }),
          task({ id: "b", version: 2, status: "waiting" }),
          task({ id: "c", version: 3, status: "done" }),
        ],
      },
      "PUT /api/tasks/a": ({ body }) => task({ id: "a", ...body }),
      "PUT /api/tasks/b": ({ body }) => task({ id: "b", ...body }),
    });
    const io = captureIo();
    assert.equal(await run(["tasks", "handover", "--from", "u-ann", "--to", "u-orin"], io), 0);
    assert.deepEqual(calls[0].query, { owner: "u-ann" });
    assert.deepEqual(calls[1].body, { assigneeId: "u-orin", expectedVersion: 1 });
    assert.deepEqual(calls[2].body, { assigneeId: "u-orin", expectedVersion: 2 });
    assert.match(io.text(), /Handed over 2 open Task\(s\) from u-ann to u-orin\./);
  });

  test("handover of one task reassigns it with its version", async () => {
    const calls = fakePortal({
      "GET /api/tasks/t-5": task({ id: "t-5", version: 4 }),
      "PUT /api/tasks/t-5": ({ body }) => task({ id: "t-5", ...body }),
    });
    const io = captureIo();
    assert.equal(await run(["tasks", "handover", "t-5", "--to", "u-orin"], io), 0);
    assert.deepEqual(calls.at(-1).body, { assigneeId: "u-orin", expectedVersion: 4 });
    assert.match(io.text(), /Handed over t-5/);
  });

  test("handover without --to, or without a task or --from, is a usage error", async () => {
    const calls = fakePortal({});
    let io = captureIo();
    assert.equal(await run(["tasks", "handover", "--from", "u-ann"], io), 2);
    assert.match(io.errors.join("\n"), /--to is required/);
    io = captureIo();
    assert.equal(await run(["tasks", "handover", "--to", "u-orin"], io), 2);
    assert.match(io.errors.join("\n"), /Give a Task or --from/);
    assert.equal(calls.length, 0);
  });

  test("a forbidden bulk handover surfaces the refusal instead of an empty move", async () => {
    fakePortal({
      "GET /api/tasks": { tasks: [task({ id: "a", version: 1 })] },
      "PUT /api/tasks/a": { status: 403, body: { error: "Changing a Task assignee requires an admin" } },
    });
    const io = captureIo();
    assert.equal(await run(["tasks", "handover", "--from", "u-ann", "--to", "u-orin"], io), 3);
    assert.match(io.errors.join("\n"), /requires an admin/);
  });
});
