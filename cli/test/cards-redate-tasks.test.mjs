import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { captureIo, fakePortal, isolateConfig } from "./helpers.mjs";

isolateConfig();
const { run } = await import("../src/cli.mjs");

describe("cards redate-tasks and update error exit codes", () => {
  test("redate-tasks previews by default without writing, then applies with --apply", async () => {
    const previewBody = {
      cardId: "card-1",
      anchorDate: "2026-11-24",
      dryRun: true,
      changes: [
        {
          taskId: "t-1",
          description: "Actual stream",
          status: "todo",
          templateOffsetDays: 0,
          from: "2026-11-15",
          to: "2026-11-24",
        },
      ],
      updatedCount: 0,
    };
    const calls = fakePortal({
      "GET /api/cards/card-1/redate-tasks": previewBody,
      "POST /api/cards/card-1/redate-tasks": { ...previewBody, dryRun: false, updatedCount: 1 },
    });

    const previewIo = captureIo();
    assert.equal(await run(["cards", "redate-tasks", "card-1"], previewIo), 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "GET");
    assert.match(previewIo.text(), /Preview: 1 open Template Task\(s\) on card-1 \(anchorDate 2026-11-24\)/);
    assert.match(previewIo.text(), /2026-11-15 -> 2026-11-24/);
    assert.match(previewIo.text(), /--apply/);

    const applyIo = captureIo();
    assert.equal(await run(["cards", "redate-tasks", "card-1", "--apply"], applyIo), 0);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].method, "POST");
    assert.deepEqual(calls[1].body, { dryRun: false });
    assert.match(applyIo.text(), /Re-dated 1 open Template Task\(s\) on card-1/);
  });

  test("cards update exits non-zero (5) when the API rejects with 409 event_hold_owns_date", async () => {
    fakePortal({
      "GET /api/cards/card-1": { card: { id: "card-1", version: 3, anchorDate: "2026-11-24" } },
      "PUT /api/cards/card-1": {
        status: 409,
        body: {
          error: "Card date is owned by event hold hold_card-1. Use 'dataops event reschedule card-1 --date 2026-11-23' so the calendar hold and Card move together.",
          code: "event_hold_owns_date",
          holdId: "hold_card-1",
        },
      },
    });
    const io = captureIo();
    const exitCode = await run(["cards", "update", "card-1", "--date", "2026-11-23"], io);
    assert.equal(exitCode, 5);
    assert.match(io.errors.join("\n"), /error: Card date is owned by event hold hold_card-1/);
  });
});
