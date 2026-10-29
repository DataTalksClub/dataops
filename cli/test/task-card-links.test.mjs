import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { captureIo, fakePortal, isolateConfig } from "./helpers.mjs";

isolateConfig();
const { run } = await import("../src/cli.mjs");

const TASK = "11111111-2222-3333-4444-555555555555";
const linkedCard = { id: "card-w1", title: "Workshop: Media agents", status: "active", stage: "preparation", url: "/cards?cardId=card-w1" };

describe("tasks link-card", () => {
  test("links a Task to a Card at its current version and prints the link", async () => {
    const calls = fakePortal({
      [`GET /api/tasks/${TASK}`]: { id: TASK, version: 4, description: "Workshop 1" },
      [`POST /api/tasks/${TASK}/actions/link-card`]: () => ({ id: TASK, description: "Workshop 1", linkedCardId: "card-w1", linkedCard }),
    });
    const io = captureIo();
    assert.equal(await run(["tasks", "link-card", TASK, "card-w1"], io), 0);
    const post = calls.find((call) => call.method === "POST");
    assert.deepEqual(post.body, { cardId: "card-w1", expectedVersion: 4 });
    assert.match(io.text(), /Linked Workshop 1 -> Workshop: Media agents \[active, preparation\] https:\/\/portal\.test\/cards\?cardId=card-w1/);
  });

  test("--unlink clears the link; a Card id and --unlink together are refused", async () => {
    const calls = fakePortal({
      [`GET /api/tasks/${TASK}`]: { id: TASK, version: 5, description: "Workshop 1" },
      [`POST /api/tasks/${TASK}/actions/link-card`]: { id: TASK, description: "Workshop 1" },
    });
    const io = captureIo();
    assert.equal(await run(["tasks", "link-card", TASK, "--unlink"], io), 0);
    assert.deepEqual(calls.find((call) => call.method === "POST").body, { cardId: null, expectedVersion: 5 });
    assert.match(io.text(), /Unlinked Workshop 1/);
    assert.notEqual(await run(["tasks", "link-card", TASK, "card-w1", "--unlink"], captureIo()), 0);
  });
});

describe("cards update --count", () => {
  const preview = {
    previewToken: "a".repeat(64),
    countFields: [{ id: "workshops", label: "Number of workshops", min: 0, max: 10 }],
    currentCounts: { workshops: 3 },
    targetCounts: { workshops: 1 },
    counts: { added: 0, removed: 1 },
    taskChanges: [{ action: "remove", taskId: "t3", taskRef: "workshop#3", currentLabel: "Workshop 3" }],
  };

  test("previews by default and applies only with --apply", async () => {
    const calls = fakePortal({
      "POST /api/cards/card-1/template-update": (call) => (call.body.previewOnly ? { preview } : { applied: true, card: { id: "card-1" } }),
    });
    const io = captureIo();
    assert.equal(await run(["cards", "update", "card-1", "--count", "workshops=1"], io), 0);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, { previewOnly: true, counts: { workshops: 1 } });
    assert.match(io.text(), /Number of workshops: 3 -> 1/);
    assert.match(io.text(), /remove {2}Workshop 3 \(t3\)/);
    assert.match(io.text(), /dataops cards update card-1 --count workshops=1 --apply/);

    const applyIo = captureIo();
    assert.equal(await run(["cards", "update", "card-1", "--count", "workshops=1", "--apply"], applyIo), 0);
    assert.deepEqual(calls.at(-1).body, { previewToken: preview.previewToken, counts: { workshops: 1 } });
    assert.match(applyIo.text(), /0 Task\(s\) added, 1 removed/);
  });

  test("rejects malformed counts and mixing --count with other edits", async () => {
    fakePortal({});
    assert.notEqual(await run(["cards", "update", "card-1", "--count", "workshops"], captureIo()), 0);
    assert.notEqual(await run(["cards", "update", "card-1", "--count", "workshops=2", "--title", "x"], captureIo()), 0);
  });
});
