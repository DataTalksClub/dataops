import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  blockedReason,
  blockedSummary,
  blockingPrerequisites,
  prerequisiteStatusLabel,
  taskIsBlocked,
  nextDependsOn,
  prerequisiteChoices,
  taskPrerequisites,
  waitsOnTask,
} from "../src/core/task-dependencies.js";

const task = (fields) => ({ id: "t", version: 1, taskHistory: [], status: "todo", description: "Publish page", ...fields });
const prerequisite = (id, description, status) => ({ id, description, status });

describe("task dependency view model", () => {
  test("only unresolved prerequisites block; a skipped one unblocks like a done one", () => {
    const blocked = task({
      dependsOn: ["a", "b", "c"],
      prerequisites: [
        prerequisite("a", "Verify Spotify episode", "done"),
        prerequisite("b", "Review transcript", "skipped"),
        prerequisite("c", "Approve cover", "todo"),
        prerequisite("d", "Confirm guest", "waiting"),
      ],
    });
    assert.deepEqual(blockingPrerequisites(blocked).map(({ id }) => id), ["c", "d"]);
    assert.equal(taskIsBlocked(blocked), true);
    assert.equal(blockedReason(blocked), 'Complete or skip "Approve cover", "Confirm guest" first');
    assert.equal(blockedSummary(blocked), "Blocked by Approve cover +1 more");
    assert.equal(taskIsBlocked(task({ prerequisites: [prerequisite("b", "Skipped", "skipped")] })), false);
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
    assert.equal(prerequisiteStatusLabel("skipped"), "Skipped");
  });
});

describe("prerequisite choices", () => {
  const sibling = (id, description, status, dependsOn) => ({ id, description, status, ...(dependsOn ? { dependsOn } : {}) });

  test("lists the card's other tasks by name and greys those that wait on this task", () => {
    const subject = task({ id: "me", description: "Subject" });
    const siblings = [
      subject,
      sibling("a", "Verify Spotify episode", "done"),
      sibling("b", "Waits on me", "todo", ["me"]),
      sibling("c", "Waits on b", "todo", ["b"]),
      sibling("d", "Independent", "waiting"),
    ];
    const choices = prerequisiteChoices(subject, siblings);
    assert.deepEqual(choices.map(({ id }) => id), ["a", "b", "c", "d"]);
    assert.deepEqual(choices.map(({ unavailable }) => Boolean(unavailable)), [false, true, true, false]);
    assert.equal(waitsOnTask(siblings[3], subject, siblings), true);
    assert.equal(waitsOnTask(siblings[1], subject, siblings), false);
  });

  test("keeps the existing order and appends newly ticked ids", () => {
    assert.deepEqual(nextDependsOn(["b", "a"], ["a", "c", "b"]), ["b", "a", "c"]);
    assert.deepEqual(nextDependsOn(["a"], []), []);
  });
});
