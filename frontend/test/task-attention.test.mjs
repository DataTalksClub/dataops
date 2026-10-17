import assert from "node:assert/strict";
import { test } from "node:test";
import { isTaskActionable, isTaskDeferred, isTaskSnoozed, taskAttentionDate } from "../src/core/task-attention.js";
import { deriveScopedWorkState, isFollowUpDueTask, isTaskOverdue } from "../src/core/workspace.js";

const today = "2026-10-17";
const task = (fields = {}) => ({ id: "waiting", version: 1, taskHistory: [], status: "waiting", date: "2026-08-24", followUpAt: "2026-10-20T09:00:00Z", ...fields });

test("future waiting follow-up hides an old overdue deadline until its follow-up day", () => {
  const waiting = task();
  assert.equal(isTaskActionable(waiting, today), false);
  assert.equal(isTaskDeferred(waiting, today), true);
  assert.equal(isTaskOverdue(waiting, today), false);
  assert.equal(taskAttentionDate(waiting), "2026-10-20");
  assert.equal(isTaskActionable(waiting, "2026-10-20"), true);
  assert.equal(isFollowUpDueTask(waiting, "2026-10-20"), true);
  assert.equal(isFollowUpDueTask(waiting, "2026-10-21"), true);
});

test("manual snooze suppresses ordinary deadlines and follow-ups until its day", () => {
  const snoozed = task({ followUpAt: today, snoozedUntil: "2026-10-20" });
  assert.equal(isTaskSnoozed(snoozed, today), true);
  assert.equal(isFollowUpDueTask(snoozed, today), false);
  assert.equal(isTaskActionable(snoozed, today), false);
  assert.equal(isTaskActionable(snoozed, "2026-10-20"), true);
  assert.equal(isTaskOverdue(task({ status: "todo", followUpAt: null, snoozedUntil: "2026-10-20" }), today), false);
});

test("not-before scheduling compares exact moments, including timezone offsets", () => {
  const scheduled = task({ status: "todo", followUpAt: null, notBeforeAt: "2026-10-17T15:00:00+02:00" });
  assert.equal(isTaskActionable(scheduled, today, "2026-10-17T12:59:59Z"), false);
  assert.equal(isTaskActionable(scheduled, today, "2026-10-17T13:00:00Z"), true);
});

test("waiting without a scheduled follow-up remains discoverable and actionable", () => {
  assert.equal(isTaskActionable(task({ followUpAt: null }), today), true);
  assert.equal(taskAttentionDate(task({ followUpAt: null })), "");
  assert.equal(isTaskActionable(task({ status: "done" }), "2026-10-21"), false);
});

test("raw overdue payloads cannot put deferred tasks back into attention lanes", () => {
  const waiting = task();
  const snoozed = task({ id: "snoozed", status: "todo", followUpAt: null, snoozedUntil: "2026-10-20" });
  const state = deriveScopedWorkState({ loaded: true, overdueTasks: [waiting, snoozed], waitingTasks: [waiting], cardTasks: { card: [waiting, snoozed] } }, { today });
  assert.deepEqual(state.tasks.overdue, []);
  assert.deepEqual(state.tasks.followUps, []);
  assert.deepEqual(state.tasks.waiting.map((item) => item.id), ["waiting"]);
});


test("known deferred members are removed from raw counts without losing unseen-page totals", () => {
  const waiting = task();
  const active = task({ id: "active", status: "todo", followUpAt: null });
  const state = deriveScopedWorkState({ loaded: true, overdueTasks: [waiting], overdueTaskCount: 1 }, { today });
  assert.equal(state.counts.overdue, 0);
  const paginated = deriveScopedWorkState({ loaded: true, overdueTasks: [waiting, active], overdueTaskCount: 100 }, { today });
  assert.equal(paginated.counts.overdue, 99);
  assert.deepEqual(paginated.tasks.overdue.map((item) => item.id), ["active"]);
});
