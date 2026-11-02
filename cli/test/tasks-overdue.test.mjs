import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { captureIo, fakePortal, isolateConfig } from "./helpers.mjs";

isolateConfig();
delete process.env.DATAOPS_CAPABILITIES;
const realFetch = globalThis.fetch;
const { run } = await import("../src/cli.mjs");
const day = "2026-10-31";
const todo = (id, date) => ({ id, status: "todo", version: 1, description: "Synthetic", date });

afterEach(() => { globalThis.fetch = realFetch; });

test("--overdue asks for open work only and follows nextCursor to every past-due todo", async () => {
  const calls = fakePortal({
    "GET /api/tasks": ({ query }) => query.cursor
      ? { tasks: [todo("late-2", "2026-10-19")] }
      : { tasks: [todo("late-1", "2026-10-02")], nextCursor: "page-2" },
  });
  const io = captureIo();
  assert.equal(await run(["tasks", "list", "--overdue", "--as-of", day, "--json"], io), 0);
  assert.deepEqual(io.json().tasks.map((t) => t.id), ["late-1", "late-2"]);
  assert.ok(calls.every((c) => c.query.status === "todo"));
  assert.equal(calls.length, 2);
});

test("--mine --queue includes overdue todos beyond the first page", async () => {
  fakePortal({
    "GET /api/tasks": ({ query }) => query.endDate
      ? (query.cursor ? { tasks: [todo("late-2", "2026-10-19")] } : { tasks: [todo("late-1", "2026-10-02")], nextCursor: "p2" })
      : { tasks: [] },
  });
  const io = captureIo();
  assert.equal(await run(["tasks", "list", "--mine", "--queue", "--as-of", day, "--json"], io), 0);
  assert.deepEqual(io.json().tasks.map((t) => t.id), ["late-1", "late-2"]);
});

test("followed-up, wait and snooze forward the email ref or raised card", async () => {
  const calls = fakePortal({
    "GET /api/tasks/t1": { id: "t1", status: "waiting", version: 3 },
    "POST /api/tasks/t1/actions/follow-up-sent": { id: "t1", status: "waiting", version: 4 },
    "POST /api/tasks/t1/actions/snooze": { id: "t1", status: "waiting", version: 4 },
  });
  const io = captureIo();
  assert.equal(await run(["tasks", "followed-up", "t1", "--channel", "email", "--note", "chased", "--email-ref", "msg-1", "--json"], io), 0);
  assert.equal(await run(["tasks", "snooze", "t1", "--until", "+7d", "--reason", "r", "--card", "card-9", "--json"], io), 0);
  const posts = calls.filter((c) => c.method === "POST");
  assert.equal(posts[0].body.emailRef, "msg-1");
  assert.equal(posts[0].body.nextFollowUpAt, undefined);
  assert.equal(posts[1].body.raisedCardId, "card-9");
});
