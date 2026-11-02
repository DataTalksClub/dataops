import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { captureIo, fakePortal, isolateConfig } from "./helpers.mjs";

isolateConfig();
const realFetch = globalThis.fetch;
const { run } = await import("../src/cli.mjs");

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env.DATAOPS_TOKEN = "dops_test";
  delete process.env.DATAOPS_TODAY;
});

const checklist = [
  { id: "kb-1", text: "Review event details", checked: false, instructionDocId: "sop.event.review" },
  { id: "kb-2", text: "Notify participants", checked: false, instructionDocId: "sop.event.notify" },
];
const task = (fields = {}) => ({ id: "task-1", version: 2, status: "todo", description: "Move the event", checklistItems: checklist, ...fields });

describe("Task checklists", () => {
  test("create copies a KB checklist and keeps repeatable inline items", async () => {
    const calls = fakePortal({
      "POST /api/tasks": ({ body }) => task({ ...body, checklistItems: [...checklist, ...body.inlineChecklistItems.map((text, index) => ({ id: `inline-${index + 1}`, text, checked: false }))] }),
    });
    const io = captureIo();
    assert.equal(await run([
      "tasks", "create", "--description", "Move the event", "--checklist", "checklist.events.move",
      "--item", "Update the listing", "--item", "Notify attendees", "--json",
    ], io), 0);
    assert.equal(calls[0].body.checklistDocId, "checklist.events.move");
    assert.deepEqual(calls[0].body.inlineChecklistItems, ["Update the listing", "Notify attendees"]);
  });

  test("check and uncheck resolve row numbers, attach evidence, and show task state", async () => {
    const calls = fakePortal({
      "GET /api/tasks/task-1": task(),
      "POST /api/tasks/task-1/actions/checklist-check": ({ body }) => task({
        version: 3,
        checklistItems: checklist.map((item) => item.id === body.itemId
          ? { ...item, checked: true, link: body.link, note: body.note }
          : item),
      }),
      "POST /api/tasks/task-1/actions/checklist-uncheck": ({ body }) => task({
        version: 4,
        checklistItems: checklist.map((item) => item.id === body.itemId ? { ...item, checked: false } : item),
      }),
    });
    let io = captureIo();
    assert.equal(await run(["tasks", "check", "task-1", "1", "--link", "https://example.test/change", "--note", "Updated", "--json"], io), 0);
    assert.deepEqual(calls.at(-1).body, {
      expectedVersion: 2,
      itemId: "kb-1",
      link: "https://example.test/change",
      note: "Updated",
    });

    io = captureIo();
    assert.equal(await run(["tasks", "uncheck", "task-1", "kb-2", "--json"], io), 0);
    assert.equal(calls.at(-1).body.itemId, "kb-2");
    assert.equal(calls.at(-1).route, "/api/tasks/task-1/actions/checklist-uncheck");

    fakePortal({ "GET /api/tasks/task-1": task({ checklistItems: [{ ...checklist[0], checked: true }, checklist[1]] }) });
    io = captureIo();
    assert.equal(await run(["tasks", "show", "task-1"], io), 0);
    assert.match(io.text(), /checklist \(1\/2 complete\)/);
    assert.match(io.text(), /\[x\] Review event details/);
  });

  test("queue rows show checklist progress and done requires a reasoned force override", async () => {
    process.env.DATAOPS_TODAY = "2026-11-03";
    const queueTask = task({ checklistItems: [{ ...checklist[0], checked: true }, ...checklist.slice(1)] });
    fakePortal({ "GET /api/tasks": { tasks: [queueTask] } });
    const queueIo = captureIo();
    assert.equal(await run(["tasks", "list", "--queue", "--as-of", "2026-11-03"], queueIo), 0);
    assert.match(queueIo.text(), /1\/2/);

    const calls = fakePortal({
      "GET /api/tasks/task-1": task(),
      "PUT /api/tasks/task-1": ({ body }) => task({ ...body, version: 3, status: "done" }),
    });
    const io = captureIo();
    assert.equal(await run(["tasks", "done", "task-1", "--force", "--reason", "Event was cancelled", "--json"], io), 0);
    assert.deepEqual(calls.at(-1).body, {
      status: "done",
      expectedVersion: 2,
      force: true,
      reason: "Event was cancelled",
    });
  });

  test("done passes a reasoned force override through the waiting completion action", async () => {
    const calls = fakePortal({
      "GET /api/tasks/task-1": task({ status: "waiting" }),
      "POST /api/tasks/task-1/actions/resolve-done": ({ body }) => task({ ...body, status: "done", version: 3 }),
    });
    const io = captureIo();
    assert.equal(await run(["tasks", "done", "task-1", "--force", "--reason", "The event was cancelled", "--json"], io), 0);
    assert.equal(calls.at(-1).route, "/api/tasks/task-1/actions/resolve-done");
    assert.deepEqual(calls.at(-1).body, {
      expectedVersion: 2,
      note: "Completed from the DataOps CLI",
      force: true,
      reason: "The event was cancelled",
    });
  });
});
