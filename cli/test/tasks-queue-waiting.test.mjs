import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { captureIo, fakePortal, isolateConfig } from "./helpers.mjs";

isolateConfig();
delete process.env.DATAOPS_CAPABILITIES;
const realFetch = globalThis.fetch;
const { run } = await import("../src/cli.mjs");
const day = "2026-10-23";
const task = (id, fields = {}) => ({ id, status: "waiting", version: 1,
  description: "Synthetic queue task", date: "2026-08-01", ...fields });
const tasks = [
  task("future", { followUpAt: "2026-10-24" }),
  task("berlin-tomorrow", { followUpAt: "2026-10-23T22:00:00Z" }),
  task("today", { followUpAt: "2026-10-23T21:59:59Z" }),
  task("earlier", { followUpAt: "2026-10-22T09:00:00Z" }),
  task("todo", { status: "todo", date: day }),
  task("overdue", { status: "todo", date: "2026-10-01" }),
  task("todo-followup", { status: "todo", followUpAt: "2026-10-24" }),
  task("snoozed", { followUpAt: day, snoozedUntil: "2026-10-25" }),
  task("timed", { followUpAt: day, notBeforeAt: "2026-11-01T00:00:00Z" }),
];

function portal() {
  return fakePortal({ "GET /api/tasks": ({ query }) => ({ tasks: tasks.filter((t) =>
    query.status ? t.status === query.status : query.date ? t.date === query.date : t.date < day),
  }) });
}

afterEach(() => { globalThis.fetch = realFetch; });

for (const flags of [[], ["--queue"], ["--mine", "--queue"], ["--queue", "--waiting"], ["--mine", "--queue", "--batches"]]) {
  test(`default queue hides future waits across lanes: ${flags.join(" ") || "no flags"}`, async () => {
    const calls = portal();
    const io = captureIo();
    assert.equal(await run(["tasks", "list", ...flags, "--as-of", day, "--json"], io), 0);
    assert.equal(io.json().view, "queue");
    assert.deepEqual(io.json().tasks.map((t) => t.id), ["overdue", "earlier", "today", "todo"]);
    assert.equal(calls.length, 3);
    if (flags.includes("--mine")) assert.ok(calls.every((c) => c.query.owner === "me"));
  });
}

test("--waiting explicitly includes parked follow-ups while respecting other wakeups", async () => {
  portal();
  const io = captureIo();
  assert.equal(await run(["tasks", "list", "--mine", "--waiting", "--as-of", day, "--json"], io), 0);
  assert.deepEqual(io.json().tasks.map((t) => t.id), ["earlier", "today", "future", "berlin-tomorrow"]);
});

test("explicit status inventory retains every waiting task", async () => {
  portal();
  const io = captureIo();
  assert.equal(await run(["tasks", "list", "--status", "waiting", "--as-of", day, "--json"], io), 0);
  assert.deepEqual(io.json().tasks.map((t) => t.id), tasks.filter((t) => t.status === "waiting").map((t) => t.id));
});
