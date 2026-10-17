import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { captureIo, fakePortal, isolateConfig } from "./helpers.mjs";

isolateConfig();
delete process.env.DATAOPS_CAPABILITIES;
const realFetch = globalThis.fetch;
const { run } = await import("../src/cli.mjs");
const { addDays, berlinToday, isoDate, relativeDate } = await import("../src/format.mjs");

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env.DATAOPS_TOKEN = "dops_test";
  delete process.env.DATAOPS_CAPABILITIES;
  delete process.env.DATAOPS_TODAY;
});

describe("relative dates", () => {
  test("absolute dates pass through, impossible ones are rejected", () => {
    assert.equal(isoDate("2026-01-31", "date", { today: "2026-10-17" }), "2026-01-31");
    assert.throws(() => isoDate("2026-02-30", "date", { today: "2026-10-17" }), /must be a date like/);
  });

  test("+Nd, tomorrow, and weekday names resolve against the Berlin today", () => {
    assert.equal(isoDate("+7d", "date", { today: "2026-10-17" }), "2026-10-24");
    assert.equal(isoDate("+3d", "follow-up", { today: "2026-10-17" }), "2026-10-20");
    assert.equal(isoDate("tomorrow", "date", { today: "2026-10-17" }), "2026-10-18");
    // 2026-10-17 is a Saturday: mon is the 19th, sat is a week out.
    assert.equal(isoDate("mon", "date", { today: "2026-10-17" }), "2026-10-19");
    assert.equal(isoDate("sat", "date", { today: "2026-10-17" }), "2026-10-24");
    assert.equal(isoDate("MONDAY", "date", { today: "2026-10-17" }), "2026-10-19");
    assert.throws(() => isoDate("someday", "date", { today: "2026-10-17" }), /must be a date like/);
  });

  test("berlinToday is a civil date and addDays crosses month ends", () => {
    assert.match(berlinToday(new Date("2026-10-17T00:30:00Z")), /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(addDays("2026-10-31", 1), "2026-11-01");
    assert.equal(relativeDate("fri", "2026-10-17"), "2026-10-23");
  });

  test("tasks list sends the resolved date to the API", async () => {
    process.env.DATAOPS_TODAY = "2026-10-17";
    const calls = fakePortal({ "GET /api/tasks": { tasks: [] } });
    const io = captureIo();
    assert.equal(await run(["tasks", "list", "--date", "mon", "--json"], io), 0);
    assert.deepEqual(calls.map((call) => call.query), [{ date: "2026-10-19" }]);
  });

  test("tasks create defaults to the Berlin today and wait resolves +Nd", async () => {
    process.env.DATAOPS_TODAY = "2026-10-17";
    const calls = fakePortal({
      "POST /api/tasks": ({ body }) => ({ status: 201, body: { id: "t-1", description: body.description, date: body.date, version: 1 } }),
      "GET /api/tasks/t-1": { id: "t-1", version: 1, status: "todo" },
      "POST /api/tasks/t-1/actions/mark-waiting": ({ body }) => ({ id: "t-1", status: "waiting", ...body, version: 2 }),
    });
    assert.equal(await run(["tasks", "create", "--description", "D"], captureIo()), 0);
    assert.equal(calls[0].body.date, "2026-10-17");
    assert.equal(
      await run(["tasks", "wait", "t-1", "--for", "Sponsor", "--follow-up", "+3d", "--channel", "email", "--note", "Asked"], captureIo()),
      0,
    );
    assert.equal(calls.at(-1).body.followUpAt, "2026-10-20");
  });
});
