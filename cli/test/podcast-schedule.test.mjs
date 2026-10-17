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

const episode = (fields) => ({ id: "ep-1", version: 4, status: "booked", title: "Synthetic", guests: [], ...fields });

describe("podcast spotify schedule hook", () => {
  test("update reports the timed verify task", async () => {
    const calls = fakePortal({
      "GET /api/podcast-episodes/ep-1": episode({}),
      "PUT /api/podcast-episodes/ep-1": ({ body }) => episode({
        version: 5,
        publication: body.publication,
        scheduleSync: { taskId: "v-1", notBeforeAt: "2026-10-23T17:00:00.000Z" },
      }),
    });
    const io = captureIo();
    assert.equal(
      await run(["podcast", "update", "ep-1", "--spotify-schedule", "2026-10-23T19:00:00+02:00", "--timezone", "Europe/Berlin"], io),
      0,
    );
    assert.equal(calls.at(-1).body.publication.audioSchedule.scheduledAt, "2026-10-23T17:00:00.000Z");
    assert.match(io.text(), /Verify Task v-1 now surfaces at 2026-10-23T17:00:00\.000Z/);
  });

  test("update reports the verify task back in the queue when unscheduled", async () => {
    fakePortal({
      "GET /api/podcast-episodes/ep-1": episode({
        publication: { audioSchedule: { scheduledAt: "2026-10-23T17:00:00.000Z", timezone: "Europe/Berlin", observedAt: "2026-10-17T08:00:00.000Z" } },
      }),
      "PUT /api/podcast-episodes/ep-1": episode({ version: 5, scheduleSync: { taskId: "v-1", notBeforeAt: null } }),
    });
    const io = captureIo();
    assert.equal(await run(["podcast", "update", "ep-1", "--spotify-schedule", "none"], io), 0);
    assert.match(io.text(), /Verify Task v-1 is back in the queue \(schedule removed\)/);
  });
});
