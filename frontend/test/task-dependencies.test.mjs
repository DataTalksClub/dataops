import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  blockedReason,
  blockedSummary,
  blockingPrerequisites,
  prerequisiteStatusLabel,
  taskIsBlocked,
  taskPrerequisites,
} from "../src/core/task-dependencies.js";

const task = (fields) => ({ id: "t", version: 1, taskHistory: [], status: "todo", description: "Publish page", ...fields });
const prerequisite = (id, description, status) => ({ id, description, status });

describe("task dependency view model", () => {
  test("only unfinished prerequisites block, and a skipped one does not unblock", () => {
    const blocked = task({
      dependsOn: ["a", "b", "c"],
      prerequisites: [
        prerequisite("a", "Verify Spotify episode", "done"),
        prerequisite("b", "Review transcript", "skipped"),
        prerequisite("c", "Approve cover", "todo"),
      ],
    });
    assert.deepEqual(blockingPrerequisites(blocked).map(({ id }) => id), ["b", "c"]);
    assert.equal(taskIsBlocked(blocked), true);
    assert.equal(blockedReason(blocked), 'Complete "Review transcript", "Approve cover" first');
    assert.equal(blockedSummary(blocked), "Blocked by Review transcript +1 more");
    assert.equal(blockedSummary(task({ prerequisites: [prerequisite("a", "Only one", "waiting")] })), "Blocked by Only one");
  });

  test("a satisfied, finished or independent Task is not blocked", () => {
    const done = [prerequisite("a", "A", "done")];
    assert.equal(taskIsBlocked(task({ prerequisites: done })), false);
    assert.equal(taskIsBlocked(task({})), false);
    // A completed or skipped Task is past blocking whatever its prerequisites say.
    assert.equal(taskIsBlocked(task({ status: "done", prerequisites: [prerequisite("a", "A", "todo")] })), false);
    assert.equal(taskIsBlocked(task({ status: "skipped", prerequisites: [prerequisite("a", "A", "todo")] })), false);
    assert.equal(blockedReason(task({})), "");
  });

  test("falls back to sibling Tasks, and treats an unknown id as missing", () => {
    const dependent = task({ dependsOn: ["a", "gone"] });
    const siblings = [{ id: "a", description: "Sibling A", status: "todo" }];
    assert.deepEqual(taskPrerequisites(dependent, siblings), [
      prerequisite("a", "Sibling A", "todo"),
      prerequisite("gone", "gone", "missing"),
    ]);
    assert.match(prerequisiteStatusLabel("missing"), /remove this dependency/);
    assert.match(prerequisiteStatusLabel("skipped"), /does not unblock/);
  });
});
