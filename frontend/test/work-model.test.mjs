import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  addDaysIso,
  buildHomeAttentionItems,
  compareIsoDate,
  deriveHomeWorkState,
  formatCardMonthLabel,
  formatHomeCalendarDate,
  formatHomeShortDate,
  formatHomeTaskTiming,
  groupCardItemsByStage,
  isActiveWorkCard,
  isArchivedWorkCard,
  isCanonicalWorkTask,
  isFollowUpDueTask,
  isOpenWorkTask,
  isTaskDueToday,
  isTaskOverdue,
  isWaitingOrFollowUpTask,
  isoDayDistance,
  nextRecurringRunDate,
  parseIsoDateValue,
  partitionCardsByArchive,
  summarizeCardProgress,
  taskProofState,
  tasksFromWorkPayload,
  todayIsoDate,
  workflowTaskGroups,
} from "../src/core/workspace.js";

const TODAY = "2026-08-12";
const canonicalTask = (task) => ({ version: 1, taskHistory: [], status: "todo", ...task });

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

  test("keeps civil-date operations independent of the runtime zone", () => {
    assert.equal(parseIsoDateValue("2026-03-01").toISOString(), "2026-03-01T00:00:00.000Z");
    assert.equal(parseIsoDateValue("2025-02-29"), null);
    assert.equal(addDaysIso("2026-02-28", 1), "2026-03-01");
    assert.equal(addDaysIso("2026-12-31", 1), "2027-01-01");
    assert.equal(isoDayDistance("2026-03-01", "2026-02-28"), 1);
    assert.equal(formatHomeCalendarDate("2026-03-01"), "Sunday 1 March");
    assert.equal(formatHomeShortDate("2026-08-05"), "5 Aug");
    assert.equal(formatCardMonthLabel("2026-07-31T18:00:00.000Z"), "July 2026");
    assert.equal(nextRecurringRunDate("0 9 * * 1", "2026-02-28"), "2026-03-02");
    assert.equal(nextRecurringRunDate("0 9 * * 1", "2026-12-31"), "2027-01-04");
    assert.equal(formatHomeShortDate("2027-01-04"), "4 Jan");
  });

  test("converts the live instant through Europe/Berlin", () => {
    const RealDate = globalThis.Date;
    const fixedInstant = "2026-07-30T22:30:00.000Z";

    class FixedDate extends RealDate {
      constructor(...args) {
        super(...(args.length ? args : [fixedInstant]));
      }

      static now() {
        return RealDate.parse(fixedInstant);
      }
    }

    globalThis.Date = FixedDate;
    try {
      assert.equal(todayIsoDate(), "2026-07-31");
    } finally {
      globalThis.Date = RealDate;
    }
  });

  test("classifies open, done, due, overdue, waiting, and follow-up tasks", () => {
    const open = canonicalTask({ id: "open", status: "todo", date: TODAY });
    const overdue = canonicalTask({ id: "overdue", status: "todo", date: "2026-08-11" });
    const waiting = canonicalTask({ id: "waiting", status: "waiting", followUpAt: "2026-08-12T09:00:00Z" });
    const done = canonicalTask({ id: "done", status: "done", date: TODAY });
    assert.equal(isOpenWorkTask(open), true);
    assert.equal(isTaskDueToday(open, TODAY), true);
    assert.equal(isTaskOverdue(overdue, TODAY), true);
    assert.equal(isWaitingOrFollowUpTask(waiting), true);
    assert.equal(isFollowUpDueTask(waiting, TODAY), true);
    assert.equal(isOpenWorkTask(done), false);
    assert.equal(isTaskDueToday(done, TODAY), false);
  });

  test("rejects invalid Task response shapes instead of treating them as todo", () => {
    for (const invalid of [
      { id: "missing-status", version: 1, taskHistory: [] },
      { id: "unknown-status", version: 1, taskHistory: [], status: "open" },
      { id: "missing-version", status: "todo", taskHistory: [] },
      { id: "missing-history", version: 1, status: "todo" },
    ]) {
      assert.equal(isCanonicalWorkTask(invalid), false);
      assert.equal(isOpenWorkTask(invalid), false);
      assert.deepEqual(tasksFromWorkPayload([invalid]), []);
    }
  });

  test("orders and deduplicates Home attention by operator priority, date, and title", () => {
    const duplicate = {
      dueDate: "2026-08-11",
      nextAction: "Mark done",
      taskId: "same",
      title: "Shared",
    };
    const model = {
      lanes: [
        {
          id: "today",
          items: [
            { dueDate: TODAY, nextAction: "Mark done", taskId: "today", title: "Today" },
            duplicate,
          ],
        },
        {
          id: "missing-proof",
          items: [{ nextAction: "Add URL", taskId: "proof", title: "Proof" }],
        },
        {
          id: "followups",
          items: [{
            followUpDate: "2026-08-10",
            nextAction: "Follow up",
            taskId: "follow",
            title: "Follow",
          }],
        },
        {
          id: "overdue",
          items: [
            { dueDate: "2026-08-10", nextAction: "Mark done", taskId: "later", title: "Zeta" },
            duplicate,
          ],
        },
      ],
    };
    const items = buildHomeAttentionItems(model);
    assert.deepEqual(
      items.map(({ taskId, priority, dueDate, followUpDate, nextAction }) => ({
        taskId,
        priority,
        dueDate,
        followUpDate,
        nextAction,
      })),
      [
        { taskId: "later", priority: "overdue", dueDate: "2026-08-10", followUpDate: undefined, nextAction: "Mark done" },
        { taskId: "same", priority: "overdue", dueDate: "2026-08-11", followUpDate: undefined, nextAction: "Mark done" },
        { taskId: "follow", priority: "follow-up", dueDate: undefined, followUpDate: "2026-08-10", nextAction: "Follow up" },
        { taskId: "today", priority: "today", dueDate: TODAY, followUpDate: undefined, nextAction: "Mark done" },
        { taskId: "proof", priority: "missing-proof", dueDate: undefined, followUpDate: undefined, nextAction: "Add URL" },
      ],
    );
    assert.equal(items.some((item) => Object.hasOwn(item, "exception")), false);
  });

  test("derives loaded Home lanes and counts from raw task snapshot data", () => {
    const state = deriveHomeWorkState({
      loaded: true,
      currentOperatorId: "alexey",
      tasks: [
        canonicalTask({ id: "today-mine", date: TODAY, assigneeId: "alexey" }),
        canonicalTask({ id: "today-unassigned", date: TODAY }),
        canonicalTask({ id: "today-peer", date: TODAY, assigneeId: "grace" }),
        canonicalTask({ id: "overdue", date: "2026-08-11", requiredLinkName: "URL" }),
        canonicalTask({ id: "follow-up", status: "waiting", followUpAt: "2026-08-11T09:00:00Z" }),
        canonicalTask({ id: "waiting", status: "waiting", followUpAt: "2026-08-14T09:00:00Z" }),
        canonicalTask({ id: "done", status: "done", date: TODAY }),
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
      todayTasks: [canonicalTask({ id: "today", date: TODAY })],
      overdueTasks: [canonicalTask({ id: "unavailable-overdue", date: "2026-08-11" })],
      waitingTasks: [canonicalTask({ id: "unavailable-waiting", status: "waiting", followUpAt: TODAY })],
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
        "card-1": [canonicalTask({
          id: "card-only-proof",
          status: "todo",
          cardId: "card-1",
          date: TODAY,
          requiredLinkName: "Publication URL",
        })],
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
        canonicalTask({ id: "grace-today", date: TODAY, assigneeId: "grace" }),
        canonicalTask({ id: "alexey-today", date: TODAY, assigneeId: "alexey" }),
        canonicalTask({ id: "grace-overdue", date: "2026-08-11", assigneeId: "grace" }),
        canonicalTask({ id: "grace-follow", status: "waiting", followUpAt: TODAY, assigneeId: "grace" }),
        canonicalTask({ id: "unassigned", date: TODAY }),
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
      { id: "prep", version: 1, taskCount: 0, openTaskCount: 0, stage: "preparation", status: "active" },
      { id: "announced", version: 1, taskCount: 0, openTaskCount: 0, stage: "announced", status: "active" },
      { id: "after", version: 1, taskCount: 0, openTaskCount: 0, stage: "after-event", status: "active" },
      { id: "impossible-active", version: 1, taskCount: 1, openTaskCount: 0, stage: "preparation", status: "active" },
      { id: "invalid-done-stage", stage: "done", status: "active" },
      { id: "invalid-done-status", stage: "after-event", status: "done" },
      { id: "impossible-empty-archive", version: 2, stage: "done", status: "archived", taskCount: 0, openTaskCount: 0, completedAt: "2026-08-13T12:00:00.000Z", completedBy: "operator", activeStageBeforeCompletion: "after-event" },
      { id: "archived", version: 2, stage: "done", status: "archived", taskCount: 1, openTaskCount: 0, completedAt: "2026-08-13T12:00:00.000Z", completedBy: "operator", activeStageBeforeCompletion: "after-event" },
    ];
    const partition = partitionCardsByArchive(cards);
    assert.deepEqual(partition.active.map((card) => card.id), ["prep", "announced", "after"]);
    assert.deepEqual(partition.archived.map((card) => card.id), ["archived"]);
    assert.equal(isActiveWorkCard(cards[0]), true);
    assert.equal(isActiveWorkCard(cards.find((card) => card.id === "impossible-active")), false);
    assert.equal(isArchivedWorkCard(cards.find((card) => card.id === "invalid-done-stage")), false);
    assert.equal(isArchivedWorkCard(cards.find((card) => card.id === "impossible-empty-archive")), false);
    assert.equal(isArchivedWorkCard(cards.find((card) => card.id === "archived")), true);
    const groups = groupCardItemsByStage(partition.active);
    assert.deepEqual(groups.map((group) => group.label), ["Preparation", "Announced", "After event"]);
    assert.equal(groups.some((group) => group.label === "Done"), false);
  });

  test("groups Card checklist Tasks into active, waiting, and history", () => {
    const tasks = [
      canonicalTask({ id: "done", description: "Done task", status: "done", date: "2026-08-10" }),
      canonicalTask({ id: "retired", description: "Retired task", status: "archived", date: "2026-08-09", artifactRefs: [{ artifactId: "retained-evidence" }] }),
      canonicalTask({ id: "waiting", description: "Waiting task", status: "waiting", date: "2026-08-11" }),
      canonicalTask({ id: "active", description: "Active task", date: TODAY }),
    ];
    const groups = workflowTaskGroups(tasks, TODAY);
    assert.deepEqual(groups.map((group) => group.title), ["Active", "Waiting / follow-up", "Done / history"]);
    assert.deepEqual(groups.map((group) => group.tasks.map((task) => task.id)), [["active"], ["waiting"], ["retired", "done"]]);
    assert.deepEqual(groups[2].tasks[0].artifactRefs, [{ artifactId: "retained-evidence" }]);
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
      canonicalTask({ id: "done", description: "Completed", status: "done", date: "2026-08-10" }),
      canonicalTask({ id: "overdue", description: "Overdue", date: "2026-08-11", requiresFile: true }),
      canonicalTask({ id: "next", description: "Next", date: "2026-08-14" }),
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
