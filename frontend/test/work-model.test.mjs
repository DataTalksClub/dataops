import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  buildHomeAttentionItems,
  compareIsoDate,
  deriveHomeWorkState,
  formatHomeTaskTiming,
  groupCardItemsByStage,
  isActiveWorkCard,
  isArchivedWorkCard,
  isFollowUpDueTask,
  isOpenWorkTask,
  isTaskDueToday,
  isTaskOverdue,
  isWaitingOrFollowUpTask,
  partitionCardsByArchive,
  summarizeCardProgress,
  taskProofState,
  workflowTaskGroups,
} from "../src/core/workspace.js";

const TODAY = "2026-08-12";

describe("frontend work model", () => {
  test("directly imports the work model from the production workspace module", () => {
    assert.equal(typeof buildHomeAttentionItems, "function");
    assert.equal(typeof summarizeCardProgress, "function");
  });

  test("compares dates and formats operator timing deterministically", () => {
    assert.equal(compareIsoDate("2026-08-11", "2026-08-12"), -1);
    assert.equal(compareIsoDate("", "2026-08-12"), 1);
    assert.equal(formatHomeTaskTiming({ priority: "overdue", dueDate: "2026-08-11" }, TODAY), "Due yesterday");
    assert.equal(formatHomeTaskTiming({ priority: "today", dueDate: TODAY }, TODAY), "Due today");
    assert.equal(formatHomeTaskTiming({ priority: "follow-up", followUpDate: "2026-08-10" }, TODAY), "Follow-up 2 days overdue");
    assert.equal(formatHomeTaskTiming({ priority: "missing-proof" }, TODAY), "Proof required");
  });

  test("classifies open, done, due, overdue, waiting, and follow-up tasks", () => {
    const open = { id: "open", status: "todo", date: TODAY };
    const overdue = { id: "overdue", status: "todo", date: "2026-08-11" };
    const waiting = { id: "waiting", status: "waiting", followUpAt: "2026-08-12T09:00:00Z" };
    const done = { id: "done", status: "done", date: TODAY };
    assert.equal(isOpenWorkTask(open), true);
    assert.equal(isTaskDueToday(open, TODAY), true);
    assert.equal(isTaskOverdue(overdue, TODAY), true);
    assert.equal(isWaitingOrFollowUpTask(waiting), true);
    assert.equal(isFollowUpDueTask(waiting, TODAY), true);
    assert.equal(isOpenWorkTask(done), false);
    assert.equal(isTaskDueToday(done, TODAY), false);
  });

  test("orders and deduplicates Home attention by operator priority, date, and title", () => {
    const duplicate = { taskId: "same", title: "Shared", dueDate: "2026-08-11" };
    const model = {
      lanes: [
        { id: "today", items: [{ taskId: "today", title: "Today", dueDate: TODAY }, duplicate] },
        { id: "missing-proof", items: [{ taskId: "proof", title: "Proof" }, duplicate] },
        { id: "followups", items: [{ taskId: "follow", title: "Follow", followUpDate: "2026-08-10" }] },
        { id: "overdue", items: [{ taskId: "later", title: "Zeta", dueDate: "2026-08-10" }, duplicate] },
      ],
    };
    const items = buildHomeAttentionItems(model);
    assert.deepEqual(items.map((item) => item.taskId), ["later", "same", "follow", "today", "proof"]);
    assert.deepEqual(items.map((item) => item.exception), ["Overdue", "Overdue", "Follow-up due", "Due today", "Missing proof"]);
  });

  test("derives loaded Home lanes and counts from raw task snapshot data", () => {
    const state = deriveHomeWorkState({
      loaded: true,
      currentOperatorId: "alexey",
      tasks: [
        { id: "today-mine", status: "todo", date: TODAY, assigneeId: "alexey" },
        { id: "today-unassigned", status: "todo", date: TODAY },
        { id: "today-peer", status: "todo", date: TODAY, assigneeId: "grace" },
        { id: "overdue", status: "todo", date: "2026-08-11", requiredLinkName: "URL" },
        { id: "follow-up", status: "waiting", followUpAt: "2026-08-11T09:00:00Z" },
        { id: "waiting", status: "waiting", followUpAt: "2026-08-14T09:00:00Z" },
        { id: "done", status: "done", date: TODAY },
      ],
    }, { today: TODAY });
    assert.deepEqual(state.loaded, { today: true, overdue: true, waiting: true, tasks: true });
    assert.deepEqual(state.tasks.today.map((task) => task.id), ["today-mine", "today-unassigned"]);
    assert.deepEqual(state.tasks.overdue.map((task) => task.id), ["overdue"]);
    assert.deepEqual(state.tasks.followUps.map((task) => task.id), ["follow-up"]);
    assert.deepEqual(state.tasks.waiting.map((task) => task.id), ["waiting"]);
    assert.deepEqual(state.tasks.missingProof.map((task) => task.id), ["overdue"]);
    assert.deepEqual(state.counts, { today: 2, overdue: 1, waiting: 2, followUps: 1, missingProof: 1 });
  });

  test("keeps partial Home sources honest and does not invent unavailable lane data", () => {
    const state = deriveHomeWorkState({
      loaded: true,
      todayLoaded: true,
      overdueLoaded: false,
      waitingLoaded: false,
      todayTasks: [{ id: "today", status: "todo", date: TODAY }],
      overdueTasks: [{ id: "unavailable-overdue", status: "todo", date: "2026-08-11" }],
      waitingTasks: [{ id: "unavailable-waiting", status: "waiting", followUpAt: TODAY }],
    }, { today: TODAY });
    assert.deepEqual(state.loaded, { today: true, overdue: false, waiting: false, tasks: true });
    assert.deepEqual(state.tasks.today.map((task) => task.id), ["today"]);
    assert.deepEqual(state.tasks.overdue, []);
    assert.deepEqual(state.tasks.followUps, []);
    assert.deepEqual(state.tasks.waiting, []);
  });

  test("includes proof-missing Tasks known only through Card task collections", () => {
    const state = deriveHomeWorkState({
      loaded: true,
      cardTasks: {
        "card-1": [{
          id: "card-only-proof",
          status: "todo",
          cardId: "card-1",
          date: TODAY,
          requiredLinkName: "Publication URL",
        }],
      },
    }, { today: TODAY });
    assert.deepEqual(state.tasks.missingProof.map((task) => task.id), ["card-only-proof"]);
    assert.deepEqual(state.tasks.today, []);
    assert.equal(state.counts.missingProof, 1);
  });

  test("returns honest empty Home lanes when all sources are unavailable", () => {
    const state = deriveHomeWorkState({
      loaded: false,
      todayLoaded: false,
      overdueLoaded: false,
      waitingLoaded: false,
    }, { today: TODAY });
    assert.deepEqual(state.loaded, { today: false, overdue: false, waiting: false, tasks: false });
    assert.deepEqual(state.tasks, { today: [], overdue: [], followUps: [], waiting: [], missingProof: [] });
    assert.deepEqual(state.counts, { today: 0, overdue: 0, waiting: 0, followUps: 0, missingProof: 0 });
  });

  test("scopes every Home lane and count to the selected teammate", () => {
    const state = deriveHomeWorkState({
      loaded: true,
      currentOperatorId: "alexey",
      tasks: [
        { id: "grace-today", status: "todo", date: TODAY, assigneeId: "grace" },
        { id: "alexey-today", status: "todo", date: TODAY, assigneeId: "alexey" },
        { id: "grace-overdue", status: "todo", date: "2026-08-11", assigneeId: "grace" },
        { id: "grace-follow", status: "waiting", followUpAt: TODAY, assigneeId: "grace" },
        { id: "unassigned", status: "todo", date: TODAY },
      ],
      todayTaskCount: 99,
      overdueTaskCount: 99,
      waitingTaskCount: 99,
    }, { today: TODAY, selectedOwnerId: "grace", currentOperatorId: "alexey" });
    assert.deepEqual(state.tasks.today.map((task) => task.id), ["grace-today"]);
    assert.deepEqual(state.tasks.overdue.map((task) => task.id), ["grace-overdue"]);
    assert.deepEqual(state.tasks.followUps.map((task) => task.id), ["grace-follow"]);
    assert.deepEqual(state.counts, { today: 1, overdue: 1, waiting: 1, followUps: 1, missingProof: 0 });
  });

  test("classifies Cards into active board and archive without a Done column", () => {
    const cards = [
      { id: "prep", stage: "preparation", status: "active" },
      { id: "announced", stage: "announced", status: "active" },
      { id: "after", stage: "after-event", status: "active" },
      { id: "done-stage", stage: "done", status: "active" },
      { id: "done-status", stage: "after-event", status: "done" },
      { id: "archived", status: "archived" },
    ];
    const partition = partitionCardsByArchive(cards);
    assert.deepEqual(partition.active.map((card) => card.id), ["prep", "announced", "after"]);
    assert.deepEqual(partition.archived.map((card) => card.id), ["done-stage", "done-status", "archived"]);
    assert.equal(isActiveWorkCard(cards[0]), true);
    assert.equal(isArchivedWorkCard(cards[3]), true);
    const groups = groupCardItemsByStage(partition.active);
    assert.deepEqual(groups.map((group) => group.label), ["Preparation", "Announced", "After event"]);
    assert.equal(groups.some((group) => group.label === "Done"), false);
  });

  test("groups Card checklist Tasks into active, waiting, and history", () => {
    const tasks = [
      { id: "done", description: "Done task", status: "done", date: "2026-08-10" },
      { id: "waiting", description: "Waiting task", status: "waiting", date: "2026-08-11" },
      { id: "active", description: "Active task", status: "todo", date: TODAY },
    ];
    const groups = workflowTaskGroups(tasks, TODAY);
    assert.deepEqual(groups.map((group) => group.title), ["Active", "Waiting / follow-up", "Done / history"]);
    assert.deepEqual(groups.map((group) => group.tasks.map((task) => task.id)), [["active"], ["waiting"], ["done"]]);
  });

  test("reports missing link, file, and approved-artifact proof", () => {
    const missing = taskProofState({
      requiredLinkName: "Public URL",
      requiresFile: true,
      proofRequirement: { required: true, type: "artifact" },
    });
    assert.deepEqual(missing, {
      ok: false,
      label: "Missing proof: Public URL, required file, approved artifact",
      missing: ["Public URL", "required file", "approved artifact"],
    });
    assert.deepEqual(taskProofState({ requiredLinkName: "Public URL", link: "https://example.invalid" }), {
      ok: true,
      label: "Proof ready",
      missing: [],
    });
  });

  test("summarizes Card progress, evidence gaps, next Task, and risk", () => {
    const card = {
      id: "card-1",
      anchorDate: "2026-08-15",
      cardLinks: [{ name: "Public page", url: "" }],
    };
    const tasks = [
      { id: "done", description: "Completed", status: "done", date: "2026-08-10" },
      { id: "overdue", description: "Overdue", status: "todo", date: "2026-08-11", requiresFile: true },
      { id: "next", description: "Next", status: "todo", date: "2026-08-14" },
    ];
    const progress = summarizeCardProgress(card, tasks, TODAY);
    assert.deepEqual(
      {
        total: progress.total,
        done: progress.done,
        open: progress.open,
        overdue: progress.overdue,
        missingLinks: progress.missingLinks,
        missingFiles: progress.missingFiles,
        missingProof: progress.missingProof,
        percent: progress.percent,
        risk: progress.risk,
        next: progress.nextDueTask.id,
      },
      {
        total: 3,
        done: 1,
        open: 2,
        overdue: 1,
        missingLinks: 1,
        missingFiles: 1,
        missingProof: 2,
        percent: 33,
        risk: "high",
        next: "overdue",
      },
    );
  });
});
