import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import {
  cardAnchorTone,
  cardsHeaderViewModel,
  compareIsoDate,
  formatCardAnchorLabel,
  formatTaskDateMeta,
  groupCardItemsByMonth,
  groupCardItemsByStage,
  isArchivedWorkCard,
  isFollowUpDueTask,
  isOpenWorkTask,
  isParkedWorkCard,
  isTaskDueToday,
  isTaskOverdue,
  isWaitingOrFollowUpTask,
  summarizeCardProgress,
  taskDate,
  taskProofState,
  tasksFromWorkPayload,
  tasksSectionTitle,
  workCardIssueNumber,
  workCardSubtitle,
  workCardTitle,
  workTaskTitle,
} from "../src/core/workspace.js";
import { createOperationsModel } from "../src/core/operations-model.js";
import { createTasksSurface } from "../src/surfaces/tasks/index.js";
import {
  FakeDocument,
  FakeElement,
  findAllByClass,
  findByText,
  nextTicks,
} from "./support/fake-dom.mjs";
import { readAppCss, uncommentCss } from "./support/app-css.mjs";

const originalDocument = globalThis.document;
const canonicalTask = (task) => ({
  version: 1,
  taskHistory: [],
  status: "todo",
  ...task,
});

afterEach(() => {
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
});

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function countLabel(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function honestState(title, detail) {
  const state = new FakeElement("div");
  state.className = "honest-state";
  const heading = new FakeElement("strong");
  heading.textContent = title;
  const description = new FakeElement("p");
  description.textContent = detail;
  state.append(heading, description);
  return state;
}

const { normalizeOperationsRecurringSnapshot } = createOperationsModel({});

// Surfaces read the normalized recurring snapshot, so fixtures build it the
// same way the runtime does instead of hand-rolling derived fields.
function recurringSnapshot(configs) {
  return normalizeOperationsRecurringSnapshot({
    loaded: true,
    recurringConfigs: configs,
  });
}

/** A config as the API returns it, with the schedule fields the server owns. */
function serverSchedule(config) {
  const cron = config.cronExpression || "0 9 * * *";
  const labels = {
    "0 9 * * 1": ["Every Monday at 09:00", "2026-08-17", "Mon 17 Aug"],
    "0 9 * * 2": ["Every Tuesday at 09:00", "2026-08-18", "Tue 18 Aug"],
  };
  const [scheduleLabel, nextRunDate, nextRunLabel] = labels[cron] || [
    "Every day at 09:00",
    "2026-08-12",
    "Today",
  ];
  return { ...config, scheduleLabel, nextRunDate, nextRunLabel };
}

function baseModel(overrides = {}) {
  return {
    stats: {
      followUpTasks: 0,
      missingProofTasks: 0,
      activeCards: 0,
      cardsLoaded: true,
      liveLoaded: true,
      workErrors: [],
    },
    runtime: null,
    templates: [],
    recurring: {
      loaded: true,
      configs: [],
      enabled: [],
      disabled: [],
      errors: [],
    },
    ...overrides,
  };
}

function createHarness(options = {}) {
  const documentList = new FakeElement("main");
  const shellBody = new FakeElement("body");
  const document = new FakeDocument(documentList, shellBody);
  globalThis.document = document;

  const requests = [];
  const navigations = [];
  const openedTasks = [];
  const openedCards = [];
  const undoToasts = [];
  const entityStates = [];
  const documentRefreshes = [];
  let route = options.route || {
    path: "/tasks",
    params: new URLSearchParams(),
  };
  let taskRouteContext = options.taskRouteContext || {
    date: "",
    tasks: null,
    cardId: "",
    filterCard: null,
    contextCardId: "",
    contextCard: null,
    failures: [],
  };
  let model = options.model || baseModel();
  let activeRouteToken = 1;
  const state = {
    workSnapshot: {
      tasks: [],
      todayLoaded: true,
      overdueLoaded: true,
      waitingLoaded: true,
      cardsLoaded: true,
      cards: [],
      activeCards: [],
      cardTasks: {},
      ...(options.workSnapshot || {}),
    },
    recurringSnapshot: {},
    qualitySnapshot: {},
  };
  let api;
  const refreshRecurring = async ({ rerender } = {}) => {
    if (options.refreshRecurring) {
      await options.refreshRecurring({ rerender });
    }
    if (rerender && api) api.renderTasksSurface([], "recurring");
  };
  api = createTasksSurface({
    addBeforeUnloadListener() {},
    allWorkTasks: (snapshot) => snapshot.tasks || [],
    buildOperationsWorkModel: () => model,
    cardsHeaderViewModel,
    compareIsoDate,
    confirmDialog: options.confirmDialog || (async () => true),
    countLabel,
    debounce: (callback) => callback,
    documentList,
    escapeHtml,
    formatTaskDateMeta,
    getActiveTasksSection: () => "templates",
    getActiveWorkspaceRoute: () => route,
    getActiveWorkspaceRouteToken: () => activeRouteToken,
    getAllDocuments: () => [],
    getPendingLegacyRoute: () => null,
    getTaskRouteContext: () => taskRouteContext,
    getWorkspaceEntityState: () => entityStates.at(-1) || null,
    groupCardItemsByMonth,
    groupCardItemsByStage,
    isArchivedWorkCard,
    isParkedWorkCard,
    isFollowUpDueTask,
    isOpenWorkTask,
    isOperationsWorkspaceVisible: () => true,
    isTaskDueToday,
    isTaskOverdue,
    isWaitingOrFollowUpTask,
    isWorkspaceRouteFresh: (token) => token === activeRouteToken,
    listDraftPaths: () => [],
    navigateCanonicalWorkspace: (path, params = {}, navigationOptions = {}) => {
      navigations.push({ path, params, options: navigationOptions });
      return { ready: Promise.resolve() };
    },
    openCardPanel: (id) => openedCards.push(id),
    openDocument() {},
    openTaskPanel: (id) => openedTasks.push(id),
    operationItemFromCard: (card, tasks) => {
      const progress = summarizeCardProgress(card, tasks, "2026-08-12");
      return {
        cardId: card.id,
        templateId: card.templateId || "",
        title: card.title,
        subtitle: workCardSubtitle(card),
        issueNumber: workCardIssueNumber(card),
        stage: card.stage,
        risk: progress.risk,
        meta: progress.label,
        anchorDate: card.anchorDate || "",
        completedAt: card.completedAt || "",
        anchorLabel: formatCardAnchorLabel(card.anchorDate, "2026-08-12"),
        anchorTone: cardAnchorTone(card.anchorDate, "2026-08-12"),
        progress,
      };
    },
    referenceCountLabel: (name, count) => `${count} ${name}`,
    refreshDocuments: async () => documentRefreshes.push("tasks"),
    refreshOperationsRecurringSnapshot: refreshRecurring,
    refreshOperationsWorkSnapshot: async (refreshOptions = {}) => {
      if (options.refreshWork) await options.refreshWork(refreshOptions);
    },
    renderEntityLoadState: (root, entity) => {
      const marker = new FakeElement("p");
      marker.textContent = `${entity.kind} ${entity.status}`;
      root.append(marker);
    },
    renderHonestState: honestState,
    renderOperationsRuntimeState: () => null,
    renderSurfaceHeader: (title, description) => {
      const header = new FakeElement("header");
      const heading = new FakeElement("h2");
      heading.textContent = title;
      const detail = new FakeElement("p");
      detail.textContent = description;
      header.append(heading, detail);
      return header;
    },
    request: async (url, requestOptions = {}) => {
      requests.push({ url, options: requestOptions });
      return options.request ? options.request(url, requestOptions) : {};
    },
    resolveAssigneeLabel: (id) => options.userNames?.[id] || id,
    scheduleAnimationFrame: (callback) => callback(),
    setRouteTitle() {},
    setWorkspaceEntityState: (entity) => entityStates.push(entity),
    shellBody,
    showUndoToast: (message, action) => undoToasts.push({ message, action }),
    sortWorkTasks: (tasks) => tasks,
    state,
    surfaceDescription: (section) => `${section} surface`,
    summarizeCardProgress,
    taskDate,
    taskNextActionLabel: () => "Continue work",
    taskProofState,
    taskSourceLabel: options.taskSourceLabel || (() => "DataOps"),
    tasksFromWorkPayload,
    tasksSectionTitle,
    todayIsoDate: () => "2026-08-12",
    workApiUrl: (path) => path,
    workCardTitle,
    workTaskTitle,
  });

  return {
    api,
    document,
    documentList,
    entityStates,
    navigations,
    openedCards,
    openedTasks,
    undoToasts,
    documentRefreshes,
    requests,
    shellBody,
    setActiveRouteToken: (value) => {
      activeRouteToken = value;
    },
    setModel: (value) => {
      model = value;
    },
    setRoute: (value) => {
      route = value;
    },
    setTaskRouteContext: (value) => {
      taskRouteContext = value;
    },
    state,
  };
}

function submitQuickForm(overlay) {
  // Quick forms submit natively, so keyboard Enter and the primary button take
  // the same path. Tests exercise that path instead of a synthetic click.
  return findAllByClass(overlay, "quick-form")[0].dispatch("submit");
}

function groupByHeading(root, heading) {
  return findAllByClass(root, "ops-queue-group").find((group) =>
    findByText(group, heading, "h3"),
  );
}

function queueRowTitles(root) {
  return findAllByClass(root, "ops-queue-row").map(
    (row) => row.querySelector("strong").textContent,
  );
}

// The Where column: the card a task belongs to, or where it did not come
// from. Its kind rides the cell so the test can tell a card from ad hoc work
// without matching on wording.
function queueOrigins(root) {
  return findAllByClass(root, "ops-queue-origin").map((cell) => ({
    label: cell.querySelector(".ops-queue-origin-label")?.textContent ?? cell.textContent,
    kind: cell.dataset.source,
    icon: cell.querySelector(".ops-queue-origin-icon")?.dataset.icon ?? "",
  }));
}

function queueTags(root) {
  return findAllByClass(root, "ops-queue-row").map(
    (row) => row.querySelector(".ops-queue-tag")?.textContent ?? "",
  );
}

function queueOwners(root) {
  return findAllByClass(root, "ops-queue-owner").map((cell) =>
    cell.dataset.assignee === "none" ? null : cell.textContent,
  );
}

function queueDueCells(root) {
  return findAllByClass(root, "ops-queue-due").map((cell) => ({
    label: cell.textContent,
    due: cell.dataset.due,
  }));
}

describe("Tasks surface boundary", () => {
  test("directly imports the production factory and exposes the stable Tasks facade", () => {
    const { api } = createHarness();
    assert.deepEqual(Object.keys(api).sort(), [
      "openQuickTaskForm",
      "openQuickWorkflowForm",
      "recurringConfigTitle",
      "refreshRuntimeTemplates",
      "renderTasksSurface",
      "resolveTemplateRouteEntity",
      "setRuntimeTemplateRoute",
    ]);
  });

  test("renders one queue with source indicators and keeps route-context recovery actions canonical", async () => {
    const cardTask = canonicalTask({
      id: "card-task",
      description: "Card checklist item",
      date: "2026-08-11",
      cardId: "card-1",
      assigneeId: "grace",
    });
    const tasks = [
      canonicalTask({
        id: "overdue",
        description: "Overdue",
        date: "2026-08-11",
        assigneeId: "alexey",
      }),
      cardTask,
      canonicalTask({
        id: "follow-up",
        description: "Follow up",
        status: "waiting",
        waitingFor: "reply",
        followUpAt: "2026-08-12",
      }),
      canonicalTask({
        id: "waiting",
        description: "Waiting",
        status: "waiting",
        waitingFor: "review",
        followUpAt: "2026-08-14",
      }),
      canonicalTask({ id: "today", description: "Today", date: "2026-08-12" }),
      canonicalTask({
        id: "done",
        description: "Done",
        status: "done",
        date: "2026-08-12",
      }),
    ];
    const { api, documentList, navigations, openedTasks } = createHarness({
      userNames: { alexey: "Alexey", grace: "Grace Meyer" },
      workSnapshot: {
        cardsById: new Map([
          ["card-1", { id: "card-1", title: "Weekly newsletter" }],
        ]),
      },
      taskRouteContext: {
        date: "2026-08-12",
        tasks,
        cardId: "missing-card",
        filterCard: null,
        contextCardId: "",
        contextCard: null,
        failures: [
          {
            source: "filter-card",
            status: "not-found",
            id: "missing-card",
            error: "Not found",
          },
        ],
      },
    });

    api.renderTasksSurface([], "queue");
    const header = documentList.querySelector(".dk-page-header");
    const createCard = findByText(header, "Create card", "button");
    assert.equal(createCard.className, "primary-button");
    assert.equal(findByText(header, "New task", "button").className, "quiet-button");

    // One queue: a single bordered list, no per-lane group cards.
    const board = documentList.querySelector(".ops-queue-board");
    assert.equal(board.dataset.loadState, "ready");
    assert.equal(findAllByClass(documentList, "ops-queue-group").length, 0);
    // Open work only, in urgency order; the done task folds into history.
    // Within the overdue segment the title breaks date ties.
    assert.deepEqual(queueRowTitles(documentList), [
      "Card checklist item",
      "Overdue",
      "Follow up",
      "Today",
      "Waiting",
    ]);
    // One checklist read as a table: the columns are named once, and the
    // heading row is the only place a column name appears.
    const head = board.querySelector(".ops-queue-head");
    assert.deepEqual(
      head.children.map((cell) => cell.textContent),
      ["", "Task", "", "Where", "Due", "Who", ""],
    );
    assert.equal(head.getAttribute("aria-hidden"), "true");
    // The Where column names the card, or says the task is not a card's.
    assert.deepEqual(queueOrigins(documentList)[0], {
      label: "Weekly newsletter",
      kind: "card",
      icon: "card",
    });
    for (const origin of queueOrigins(documentList).slice(1)) {
      assert.equal(origin.kind, "other");
      assert.equal(origin.label, "DataOps");
    }
    // Due is a quantity or a word, never a sentence.
    assert.deepEqual(queueDueCells(documentList), [
      { label: "1d late", due: "overdue" },
      { label: "1d late", due: "overdue" },
      { label: "—", due: "none" },
      { label: "Today", due: "today" },
      { label: "—", due: "none" },
    ]);
    // Whose it is: initials for a named owner, a dash for nobody's.
    assert.deepEqual(queueOwners(documentList), ["GM", "A", null, null, null]);
    // A task with nothing blocking it is one line: only stuck rows carry a
    // blocker note, so the list scans as a checklist.
    const notes = findAllByClass(documentList, "ops-queue-note").map(
      (note) => note.textContent,
    );
    assert.deepEqual(notes, ["Waiting for reply · Today", "Waiting for review · 14 Aug"]);
    assert.match(board.textContent, /5 open, most urgent first/);
    const history = documentList.querySelector(".ops-queue-history");
    assert.equal(history.tagName, "DETAILS");
    assert.match(history.textContent, /Recently completed/);
    assert.equal(
      history.querySelector("[data-queue-count]").textContent,
      "1",
    );
    await history.querySelector(".ops-queue-history-row").dispatch("click");
    assert.deepEqual(openedTasks, ["done"]);
    assert.match(documentList.textContent, /Filter card not found/);
    assert.match(documentList.textContent, /Requested value: missing-card/);

    await findByText(documentList, "Retry route context", "button").dispatch(
      "click",
    );
    await findByText(documentList, "Clear queue context", "button").dispatch(
      "click",
    );
    assert.equal(navigations[0].path, "/tasks");
    assert.equal(navigations[0].options.history, "none");
    assert.equal(navigations[1].path, "/tasks");
  });

  test("caps the visible queue and expands on demand without losing order", () => {
    const tasks = [];
    for (let index = 0; index < 30; index += 1) {
      tasks.push(
        canonicalTask({
          id: `task-${index}`,
          description: `Task ${String(index).padStart(2, "0")}`,
          date: "2026-08-12",
        }),
      );
    }
    const { api, documentList } = createHarness({
      taskRouteContext: {
        date: "",
        tasks,
        cardId: "",
        filterCard: null,
        contextCardId: "",
        contextCard: null,
        failures: [],
      },
    });

    api.renderTasksSurface([], "queue");
    const board = documentList.querySelector(".ops-queue-board");
    assert.equal(findAllByClass(board, "ops-queue-row").length, 25);
    assert.match(board.textContent, /Showing 25 of 30 open/);
    const more = findByText(board, "Show all 30", "button");
    more.dispatch("click");
    assert.equal(findAllByClass(board, "ops-queue-row").length, 30);
    assert.equal(board.querySelector(".ops-queue-more-wrap"), null);
    assert.match(board.textContent, /Showing 25 of 30 open/);
    assert.deepEqual(queueRowTitles(board).slice(-2), [
      "Task 28",
      "Task 29",
    ]);
  });

  test("ticking a queue checkbox marks the task done, refreshes, and offers undo", async () => {
    const task = canonicalTask({
      id: "tickable",
      description: "Tick me",
      date: "2026-08-12",
    });
    const refreshed = [];
    const {
      api,
      documentList,
      openedTasks,
      requests,
      undoToasts,
    } = createHarness({
      taskRouteContext: {
        date: "",
        tasks: [task],
        cardId: "",
        filterCard: null,
        contextCardId: "",
        contextCard: null,
        failures: [],
      },
      workSnapshot: {
        todayTasks: [{ ...task, status: "done", version: 2 }],
      },
      request: async (url) => {
        if (url === "/api/tasks/tickable")
          return { ...task, status: "done", version: 2 };
        return {};
      },
      refreshWork: async (refreshOptions) => refreshed.push(refreshOptions),
    });

    api.renderTasksSurface([], "queue");
    // The row is a group now: the title opens the task, the tick completes
    // it. Ticking never opens the panel as a side effect.
    const row = findAllByClass(documentList, "ops-queue-row")[0];
    assert.equal(row.tagName, "DIV");
    const open = findAllByClass(documentList, "ops-queue-main")[0];
    await open.dispatch("click");
    assert.deepEqual(openedTasks, ["tickable"]);

    const input = findAllByClass(documentList, "ops-queue-check-input")[0];
    assert.equal(input.disabled, false);
    assert.equal(input.getAttribute("aria-label"), "Mark Tick me as done");
    await input.dispatch("change");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/api/tasks/tickable");
    assert.deepEqual(JSON.parse(requests[0].options.body), {
      status: "done",
      expectedVersion: 1,
    });
    assert.deepEqual(refreshed, [{ rerender: true }]);
    assert.equal(undoToasts.length, 1);
    assert.equal(undoToasts[0].message, "Task marked done.");

    // Undo reopens with the refreshed snapshot version, then refreshes.
    await undoToasts[0].action();
    assert.equal(requests.length, 2);
    assert.deepEqual(JSON.parse(requests[1].options.body), {
      status: "todo",
      expectedVersion: 2,
    });
    assert.deepEqual(refreshed, [{ rerender: true }, { rerender: true }]);
  });

  test("a queue row skips its task through the reason dialog and undo unskips it", async () => {
    const task = canonicalTask({
      id: "skippable",
      description: "Not for this event",
      date: "2026-08-12",
      requiredLinkName: "Recording",
    });
    const refreshed = [];
    const { api, document, documentList, requests, shellBody, undoToasts } = createHarness({
      taskRouteContext: {
        date: "",
        tasks: [task],
        cardId: "",
        filterCard: null,
        contextCardId: "",
        contextCard: null,
        failures: [],
      },
      request: async (url) => {
        if (url.endsWith("/actions/skip")) {
          return { ...task, status: "skipped", skipReason: "Self-hosted", version: 2 };
        }
        if (url.endsWith("/actions/unskip")) return { ...task, version: 3 };
        return {};
      },
      refreshWork: async (refreshOptions) => refreshed.push(refreshOptions),
    });
    document.body = shellBody;
    const proto = Object.getPrototypeOf(shellBody);
    const saved = { showModal: proto.showModal, close: proto.close };
    proto.showModal = function showModal() { this.open = true; };
    proto.close = function close() {
      this.open = false;
      return this.dispatch("close");
    };
    try {
      api.renderTasksSurface([], "queue");
      const skip = findAllByClass(documentList, "ops-queue-skip")[0];
      assert.equal(skip.getAttribute("aria-label"), "Skip Not for this event…");
      await skip.dispatch("click");
      const dialog = shellBody.children.find((child) => child.dataset?.workDialog === "skip-task");
      assert.ok(dialog?.open);
      dialog.querySelector("textarea").value = "Self-hosted";
      await dialog.querySelector("form").dispatch("submit");
      assert.equal(requests[0].url, "/api/tasks/skippable/actions/skip");
      assert.deepEqual(JSON.parse(requests[0].options.body), { reason: "Self-hosted", expectedVersion: 1 });
      assert.deepEqual(refreshed, [{ rerender: true }]);
      assert.equal(undoToasts[0].message, "Task skipped.");
      assert.equal(dialog.open, false);

      await undoToasts[0].action();
      assert.equal(requests[1].url, "/api/tasks/skippable/actions/unskip");
      assert.deepEqual(JSON.parse(requests[1].options.body), { expectedVersion: 2 });
    } finally {
      proto.showModal = saved.showModal;
      proto.close = saved.close;
    }
  });

  test("a failed queue tick restores the checkbox and names the failure", async () => {
    const task = canonicalTask({
      id: "flaky",
      description: "Flaky",
      date: "2026-08-12",
    });
    const { api, documentList, requests, undoToasts } = createHarness({
      taskRouteContext: {
        date: "",
        tasks: [task],
        cardId: "",
        filterCard: null,
        contextCardId: "",
        contextCard: null,
        failures: [],
      },
      request: async () => {
        throw new Error("request failed");
      },
    });

    api.renderTasksSurface([], "queue");
    const input = findAllByClass(documentList, "ops-queue-check-input")[0];
    await input.dispatch("change");
    assert.equal(requests.length, 1);
    assert.equal(undoToasts.length, 0);
    assert.equal(input.disabled, false);
    assert.equal(input.checked, false);
    assert.match(input.title, /Could not update task/);
  });

  test("a blocked queue checkbox is disabled with reasons and sends nothing", async () => {
    const blocked = canonicalTask({
      id: "blocked",
      description: "Needs link",
      date: "2026-08-12",
      requiredLinkName: "PR link",
    });
    const waiting = canonicalTask({
      id: "waiting",
      description: "Waiting",
      status: "waiting",
      waitingFor: "reply",
      followUpAt: "2026-08-14",
    });
    const { api, documentList, requests } = createHarness({
      taskRouteContext: {
        date: "",
        tasks: [blocked, waiting],
        cardId: "",
        filterCard: null,
        contextCardId: "",
        contextCard: null,
        failures: [],
      },
    });

    api.renderTasksSurface([], "queue");
    const labels = findAllByClass(documentList, "ops-queue-check");
    const inputs = findAllByClass(documentList, "ops-queue-check-input");
    assert.equal(inputs.length, 2);
    for (const input of inputs) assert.equal(input.disabled, true);
    assert.match(labels[0].title, /Fill in PR link/);
    assert.match(labels[1].title, /Waiting for reply/);
    assert.equal(requests.length, 0);
  });

  test("marks ad hoc and card sources distinctly from imported sources", () => {
    const tasks = [
      canonicalTask({
        id: "adhoc",
        description: "Ad hoc task",
        date: "2026-08-12",
      }),
      canonicalTask({
        id: "cardless-template",
        description: "Imported",
        date: "2026-08-12",
        templateId: "tpl-1",
      }),
    ];
    const { api, documentList } = createHarness({
      taskSourceLabel: (task) =>
        task.cardId || task.templateId ? "Template" : "Manual",
      taskRouteContext: {
        date: "",
        tasks,
        cardId: "",
        filterCard: null,
        contextCardId: "",
        contextCard: null,
        failures: [],
      },
    });

    api.renderTasksSurface([], "queue");
    assert.deepEqual(queueOrigins(documentList), [
      { label: "Ad hoc", kind: "adhoc", icon: "adhoc" },
      { label: "Template", kind: "other", icon: "card" },
    ]);
  });

  test("shows the bracket tag as its own pill and keeps proof needs out of the queue", () => {
    const tasks = [
      canonicalTask({
        id: "tagged",
        description: "[Podcast page] Add a podcast episode",
        date: "2026-08-12",
        requiredLinkName: "Airtable record",
      }),
      canonicalTask({
        id: "field-tag",
        description: "Upload the emails",
        date: "2026-08-12",
        tags: ["Other tasks"],
      }),
    ];
    const { api, documentList } = createHarness({
      taskRouteContext: {
        date: "",
        tasks,
        cardId: "",
        filterCard: null,
        contextCardId: "",
        contextCard: null,
        failures: [],
      },
    });

    api.renderTasksSurface([], "queue");
    assert.deepEqual(queueRowTitles(documentList), [
      "Add a podcast episode",
      "Upload the emails",
    ]);
    assert.deepEqual(queueTags(documentList), ["Podcast page", "Other tasks"]);
    const notes = findAllByClass(documentList, "ops-queue-note").map(
      (note) => note.textContent,
    );
    assert.deepEqual(notes, []);
  });

  test("marks what each task needs and filters the queue by required resource", async () => {
    const resources = [
      { id: "youtube", name: "YouTube", icon: "video", access: "Channel" },
      { id: "luma", name: "Luma", icon: "ticket", access: "Calendar" },
      { id: "mailchimp", name: "Mailchimp", icon: "megaphone", access: "Audience" },
    ];
    const tasks = [
      canonicalTask({ id: "stream", description: "Actual stream", date: "2026-08-12", requires: ["youtube"] }),
      canonicalTask({ id: "event", description: "Create events on Luma", date: "2026-08-12", requires: ["luma", "youtube"] }),
      canonicalTask({ id: "think", description: "Plan the quarter", date: "2026-08-12" }),
    ];
    const { api, documentList } = createHarness({
      workSnapshot: {
        resources,
        resourcesById: new Map(resources.map((resource) => [resource.id, resource])),
      },
      taskRouteContext: {
        date: "",
        tasks,
        cardId: "",
        filterCard: null,
        contextCardId: "",
        contextCard: null,
        failures: [],
      },
    });

    api.renderTasksSurface([], "queue");
    const marks = findAllByClass(documentList, "ops-queue-row").map((row) =>
      findAllByClass(row, "ops-resource").map((mark) => mark.getAttribute("aria-label")),
    );
    assert.deepEqual(marks, [["YouTube"], ["Luma", "YouTube"], []]);
    const firstMark = findAllByClass(documentList, "ops-resource")[0];
    assert.equal(firstMark.title, "YouTube: Channel");
    assert.match(
      findAllByClass(documentList, "ops-queue-main")[1].getAttribute("aria-label"),
      /needs Luma, YouTube$/,
    );

    const filter = findAllByClass(documentList, "ops-queue-resource-filter")[0];
    const select = filter.querySelector("select");
    assert.deepEqual(
      select.children.map((option) => [option.value, option.textContent]),
      [["all", "Any resource"], ["youtube", "YouTube (2)"], ["luma", "Luma (1)"], ["none", "Nothing external (1)"]],
    );
    select.value = "luma";
    await select.dispatch("change");
    assert.deepEqual(queueRowTitles(documentList), ["Create events on Luma"]);
    const again = findAllByClass(documentList, "ops-queue-resource-filter")[0].querySelector("select");
    again.value = "none";
    await again.dispatch("change");
    assert.deepEqual(queueRowTitles(documentList), ["Plan the quarter"]);
    assert.equal(findAllByClass(documentList, "ops-queue-resource-filter").length, 1);
  });

  test("names recurring origin with its own icon", () => {
    const tasks = [
      canonicalTask({
        id: "recurring",
        description: "Weekly standup",
        date: "2026-08-12",
        recurringConfigId: "rc-1",
      }),
    ];
    const { api, documentList } = createHarness({
      taskSourceLabel: () => "Recurring",
      taskRouteContext: {
        date: "",
        tasks,
        cardId: "",
        filterCard: null,
        contextCardId: "",
        contextCard: null,
        failures: [],
      },
    });

    api.renderTasksSurface([], "queue");
    assert.deepEqual(queueOrigins(documentList), [
      { label: "Recurring", kind: "recurring", icon: "recurring" },
    ]);
  });

  test("names the card, its kind and its template icon in Where", () => {
    const tasks = [
      canonicalTask({
        id: "imported",
        cardId: "card-1",
        description: "[Emails] Send the reminder",
        date: "2026-08-12",
        tags: ["webinar"],
      }),
      canonicalTask({
        id: "legacy",
        cardId: "card-2",
        description: "Check the slides",
        date: "2026-08-12",
      }),
    ];
    const { api, documentList } = createHarness({
      workSnapshot: {
        cardsById: new Map([
          ["card-1", { id: "card-1", title: "LLM evals in practice", tags: ["webinar"] }],
          ["card-2", { id: "card-2", title: "Prompting 101", templateId: "tpl-workshop" }],
        ]),
        templates: [
          { id: "tpl-webinar", type: "webinar", name: "Webinar", icon: "video" },
          { id: "tpl-workshop", type: "workshop", name: "Workshop", icon: "wrench" },
        ],
      },
      taskRouteContext: {
        date: "",
        tasks,
        cardId: "",
        filterCard: null,
        contextCardId: "",
        contextCard: null,
        failures: [],
      },
    });

    api.renderTasksSurface([], "queue");
    assert.deepEqual(queueOrigins(documentList), [
      { label: "LLM evals in practice", kind: "card", icon: "video" },
      { label: "Prompting 101", kind: "card", icon: "wrench" },
    ]);
    assert.deepEqual(
      findAllByClass(documentList, "ops-queue-origin-type").map((cell) => cell.textContent),
      ["Webinar", "Workshop"],
    );
    assert.equal(findAllByClass(documentList, "ops-queue-origin")[0].title, "LLM evals in practice · Webinar");
    // A tag that only repeats the card's kind is not a pill; the checklist
    // prefix is.
    assert.deepEqual(queueTags(documentList), ["Emails", ""]);
  });

  test("puts instructions and links from the title behind one icon, not a note", () => {
    const tasks = [
      canonicalTask({
        id: "one",
        description: "Announce in Slack",
        date: "2026-08-12",
        instructionsUrl: "https://docs.google.com/document/d/abc123/edit",
      }),
      canonicalTask({
        id: "many",
        description: "Add the event to the webpage ( , [website](https://github.com/DataTalksClub/site))",
        date: "2026-08-12",
        instructionsUrl: "https://docs.google.com/document/d/sop1/edit",
      }),
      canonicalTask({ id: "none", description: "Plain work", date: "2026-08-12" }),
    ];
    const { api, documentList } = createHarness({
      taskRouteContext: {
        date: "",
        tasks,
        cardId: "",
        filterCard: null,
        contextCardId: "",
        contextCard: null,
        failures: [],
      },
    });

    api.renderTasksSurface([], "queue");
    assert.deepEqual(queueRowTitles(documentList), [
      "Add the event to the webpage",
      "Announce in Slack",
      "Plain work",
    ]);
    assert.deepEqual(findAllByClass(documentList, "ops-queue-note"), []);
    const cells = findAllByClass(documentList, "ops-queue-materials-cell");
    assert.equal(cells.length, 3);
    const menuTrigger = cells[0].querySelector("button");
    assert.equal(menuTrigger.getAttribute("aria-haspopup"), "menu");
    assert.match(menuTrigger.getAttribute("aria-label"), /^2 supporting materials/);
    const items = findAllByClass(cells[0], "dk-menu__item");
    assert.deepEqual(
      items.map((item) => [item.href, item.querySelector(".ops-queue-material-label").textContent]),
      [
        ["https://docs.google.com/document/d/sop1/edit", "Instructions"],
        ["https://github.com/DataTalksClub/site", "Website"],
      ],
    );
    const single = cells[1].querySelector("a");
    assert.equal(single.href, "https://docs.google.com/document/d/abc123/edit");
    assert.equal(single.getAttribute("aria-label"), "Open Instructions · Google Doc");
    assert.equal(cells[2].children.length, 0);
  });

  test("renders the active Cards board as exactly three columns and keeps Done in Archive", () => {
    const active = [
      {
        id: "prep",
        version: 1,
        title: "Prepare",
        stage: "preparation",
        status: "active",
        taskCount: 0,
        openTaskCount: 0,
      },
      {
        id: "announced",
        version: 1,
        title: "Announce",
        stage: "announced",
        status: "active",
        taskCount: 0,
        openTaskCount: 0,
      },
      {
        id: "after-event",
        version: 1,
        title: "Follow up",
        stage: "after-event",
        status: "active",
        taskCount: 0,
        openTaskCount: 0,
      },
    ];
    const archived = {
      id: "done",
      version: 2,
      title: "Completed",
      stage: "done",
      status: "archived",
      taskCount: 1,
      openTaskCount: 0,
      completedAt: "2026-08-05T12:00:00.000Z",
      completedBy: "operator",
      activeStageBeforeCompletion: "after-event",
    };
    const { api, documentList, setRoute, state } = createHarness({
      route: { path: "/cards", params: new URLSearchParams() },
      workSnapshot: {
        activeCards: active,
        cards: [...active, archived],
        cardTasks: {
          prep: [],
          announced: [],
          "after-event": [],
          done: [],
        },
      },
    });

    api.renderTasksSurface([], "workflows");
    const columns = findAllByClass(documentList, "workflow-board-column");
    assert.equal(columns.length, 3);
    assert.deepEqual(
      columns.map((column) => column.querySelector("h3").textContent),
      ["Preparation", "Announced", "After event"],
    );
    assert.doesNotMatch(documentList.textContent, /Completed/);
    assert.doesNotMatch(documentList.textContent, /Done/);
    assert.match(documentList.textContent, /Archive \(1\)/);

    setRoute({ path: "/cards/archive", params: new URLSearchParams() });
    api.renderTasksSurface([], "workflows");
    assert.equal(
      findAllByClass(documentList, "workflow-board-column").length,
      0,
    );
    assert.equal(findAllByClass(documentList, "cards-archive-grid").length, 1);
    assert.match(documentList.textContent, /Completed/);
    assert.match(documentList.textContent, /Back to board/);
    assert.equal(state.workSnapshot.activeCards.length, 3);
  });

  test("groups the archive into newest-first months", () => {
    const archived = [
      {
        id: "old",
        version: 2,
        title: "July card",
        status: "archived",
        stage: "done",
        taskCount: 1,
        openTaskCount: 0,
        completedAt: "2026-07-04T12:00:00.000Z",
        completedBy: "operator",
        activeStageBeforeCompletion: "preparation",
      },
      {
        id: "recent",
        version: 2,
        title: "August card",
        status: "archived",
        stage: "done",
        taskCount: 1,
        openTaskCount: 0,
        completedAt: "2026-08-02T12:00:00.000Z",
        completedBy: "operator",
        activeStageBeforeCompletion: "announced",
      },
    ];
    const { api, documentList } = createHarness({
      route: { path: "/cards/archive", params: new URLSearchParams() },
      workSnapshot: {
        activeCards: [],
        cards: archived,
        cardTasks: { old: [], recent: [] },
      },
    });

    api.renderTasksSurface([], "workflows");
    const months = findAllByClass(documentList, "cards-archive-month-title");
    assert.deepEqual(
      months.map((month) => month.textContent),
      ["August 20261 card", "July 20261 card"],
    );
    assert.deepEqual(
      findAllByClass(documentList, "workflow-board-card").map(
        (card) => card.dataset.cardId,
      ),
      ["recent", "old"],
    );
    assert.equal(findAllByClass(documentList, "cards-archive-grid").length, 2);
  });

  test("shows people, sponsors, and issue chips on board cards", () => {
    const active = [
      {
        id: "pod",
        title: "Playbook",
        stage: "announced",
        anchorDate: "2026-08-17",
        people: ["Tony Zeljkovic", "Juan Manuel Perafan"],
      },
      {
        id: "news",
        title: "Weekly email",
        stage: "preparation",
        anchorDate: "2026-10-20",
        sponsor: "Astronomer",
        issueNumber: "298",
      },
      {
        id: "plain",
        title: "Untitled work",
        stage: "preparation",
        anchorDate: "2026-08-10",
      },
    ];
    const { api, documentList } = createHarness({
      route: { path: "/cards", params: new URLSearchParams() },
      workSnapshot: {
        activeCards: active,
        cards: active,
        cardTasks: { pod: [], news: [], plain: [] },
      },
    });

    api.renderTasksSurface([], "workflows");
    const subtitles = findAllByClass(documentList, "workflow-card-subtitle");
    assert.deepEqual(
      subtitles.map((subtitle) => subtitle.textContent),
      ["Astronomer", "Tony Zeljkovic, Juan Manuel Perafan"],
    );
    const issueChips = findAllByClass(documentList, "workflow-card-issue");
    assert.deepEqual(
      issueChips.map((chip) => chip.textContent),
      ["#298"],
    );
  });

  test("splits the archive into Done and Parked categories", async () => {
    const done = {
      id: "done-1",
      version: 2,
      title: "Done card",
      status: "archived",
      stage: "done",
      taskCount: 1,
      openTaskCount: 0,
      anchorDate: "2026-08-01",
      completedAt: "2026-08-05T10:00:00.000Z",
      completedBy: "operator",
      activeStageBeforeCompletion: "after-event",
    };
    const parked = {
      id: "parked-1",
      version: 2,
      title: "Parked card",
      status: "parked",
      stage: "announced",
      taskCount: 2,
      openTaskCount: 1,
      anchorDate: "2026-09-01",
    };
    const { api, documentList } = createHarness({
      route: { path: "/cards/archive", params: new URLSearchParams() },
      workSnapshot: {
        activeCards: [],
        cards: [done, parked],
        cardTasks: { "done-1": [], "parked-1": [] },
        cardsComplete: true,
      },
    });

    api.renderTasksSurface([], "workflows");
    const tabs = findAllByClass(documentList, "archive-category-tab");
    assert.deepEqual(
      tabs.map((tab) => tab.textContent),
      ["Done1", "Parked1"],
    );
    assert.equal(tabs[0].getAttribute("role"), "radio");
    assert.equal(tabs[0].getAttribute("aria-checked"), "true");
    assert.deepEqual(
      findAllByClass(documentList, "workflow-board-card").map(
        (card) => card.dataset.cardId,
      ),
      ["done-1"],
    );

    await tabs[1].dispatch("click");
    api.renderTasksSurface([], "workflows");
    assert.equal(
      findAllByClass(documentList, "archive-category-tab")[1].getAttribute("aria-checked"),
      "true",
    );
    assert.deepEqual(
      findAllByClass(documentList, "workflow-board-card").map(
        (card) => card.dataset.cardId,
      ),
      ["parked-1"],
    );
    const [month] = findAllByClass(documentList, "cards-archive-month-title");
    assert.match(month.textContent, /September 2026/);
  });

  test("filters the board by the Template each Card was created from", async () => {
    const active = [
      {
        id: "news-1",
        title: "Newsletter card",
        stage: "preparation",
        anchorDate: "2026-08-10",
        templateId: "tpl-news",
      },
      {
        id: "news-2",
        title: "Second newsletter card",
        stage: "announced",
        anchorDate: "2026-08-11",
        templateId: "tpl-news",
      },
      {
        id: "pod-1",
        title: "Podcast card",
        stage: "after-event",
        anchorDate: "2026-08-03",
        templateId: "tpl-podcast",
      },
    ];
    const { api, documentList, state, requests } = createHarness({
      route: { path: "/cards", params: new URLSearchParams() },
      workSnapshot: {
        activeCards: active,
        cards: active,
        cardTasks: { "news-1": [], "news-2": [], "pod-1": [] },
      },
      request: async () => ({
        templates: [
          { id: "tpl-news", name: "Weekly email" },
          { id: "tpl-podcast", name: "Podcast episode" },
        ],
      }),
    });

    api.renderTasksSurface([], "workflows");
    // Template display names load from the same listing the create-card form
    // uses; the first render falls back to short ids until it answers.
    assert.deepEqual(
      requests.map((request) => request.url),
      ["/api/templates"],
    );
    await nextTicks();
    api.renderTasksSurface([], "workflows");
    const filterSelect = documentList.querySelector(
      ".workflow-board-filter select",
    );
    assert.equal(filterSelect.value, "");
    assert.deepEqual(
      filterSelect.children.map((option) => option.textContent),
      ["All templates", "Podcast episode", "Weekly email"],
    );

    filterSelect.value = "tpl-news";
    filterSelect.dispatch("change");
    api.renderTasksSurface([], "workflows");
    assert.deepEqual(
      findAllByClass(documentList, "workflow-board-card").map(
        (card) => card.dataset.cardId,
      ),
      ["news-1", "news-2"],
    );
    assert.doesNotMatch(documentList.textContent, /shown/);
    // The board's one create action sits in the toolbar beside the filter.
    const toolbar = documentList.querySelector(".workflow-board-filters");
    const create = findByText(toolbar, "Create card", "button");
    assert.equal(create.getAttribute("aria-keyshortcuts"), "c");
    assert.equal(documentList.querySelector(".dk-page-header__actions"), null);

    // A snapshot refresh that leaves no Card behind the chosen Template
    // heals the filter back to "All templates" instead of an empty board.
    const survivor = [active[2]];
    state.workSnapshot.activeCards = survivor;
    state.workSnapshot.cards = survivor;
    api.renderTasksSurface([], "workflows");
    const healedSelect = documentList.querySelector(
      ".workflow-board-filter select",
    );
    assert.equal(healedSelect.value, "");
    assert.equal(
      findAllByClass(documentList, "workflow-board-card").length,
      1,
    );
  });

  test("badges each card with its source Template and links the badge", async () => {
    const active = [
      {
        id: "news-1",
        title: "Weekly email #298 - Astronomer",
        stage: "preparation",
        anchorDate: "2026-10-20",
        templateId: "tpl-news",
      },
      {
        id: "plain",
        title: "Untagged card",
        stage: "preparation",
        anchorDate: "2026-08-10",
      },
    ];
    const { api, documentList, navigations, openedCards } = createHarness({
      route: { path: "/cards", params: new URLSearchParams() },
      workSnapshot: {
        activeCards: active,
        cards: active,
        cardTasks: { "news-1": [], plain: [] },
      },
      request: async () => ({
        templates: [
          { id: "tpl-news", name: "Newsletter", icon: "newspaper", type: "newsletter" },
        ],
      }),
    });

    api.renderTasksSurface([], "workflows");
    const preNews = findAllByClass(documentList, "workflow-board-card")
      .find((card) => card.dataset.cardId === "news-1");
    const [preBadge] = findAllByClass(preNews, "workflow-card-template");
    assert.equal(preBadge.textContent, "Template tpl-news");

    await nextTicks();
    api.renderTasksSurface([], "workflows");

    const cards = findAllByClass(documentList, "workflow-board-card");
    const news = cards.find((card) => card.dataset.cardId === "news-1");
    const plain = cards.find((card) => card.dataset.cardId === "plain");
    const [badge] = findAllByClass(news, "workflow-card-template");
    assert.equal(badge.textContent, "Newsletter");
    assert.equal(badge.querySelector("svg").dataset.icon, "newspaper");
    assert.equal(badge.title, "View Newsletter template");
    assert.equal(badge.dataset.templateType, "newsletter");
    assert.equal(
      findAllByClass(plain, "workflow-card-template").length,
      0,
    );

    await badge.dispatch("click", { stopPropagation() {} });
    assert.deepEqual(navigations.at(-1), {
      path: "/templates",
      params: { templateId: "tpl-news" },
      options: {},
    });
    assert.deepEqual(openedCards, []);
  });

  test("drops the template filter control when no Card carries a Template", () => {
    const active = [
      {
        id: "plain",
        title: "Imported card",
        stage: "preparation",
        anchorDate: "2026-08-10",
      },
    ];
    const { api, documentList, requests } = createHarness({
      route: { path: "/cards", params: new URLSearchParams() },
      workSnapshot: {
        activeCards: active,
        cards: active,
        cardTasks: { plain: [] },
      },
    });

    api.renderTasksSurface([], "workflows");
    assert.equal(
      findAllByClass(documentList, "workflow-board-filter").length,
      0,
    );
    // The toolbar still carries the board's actions.
    const toolbar = documentList.querySelector(".workflow-board-filters");
    assert.ok(findByText(toolbar, "Create card", "button"));
    assert.ok(findByText(toolbar, "Archive (0)", "button"));
    assert.deepEqual(requests, []);
  });

  test("does not present incomplete Cards or archive collections as empty", () => {
    const { api, documentList, setRoute } = createHarness({
      route: { path: "/cards", params: new URLSearchParams() },
      workSnapshot: {
        activeCards: [],
        cards: [],
        cardTasks: {},
        cardsLoaded: true,
        cardsComplete: false,
        cardTasksComplete: false,
      },
    });

    api.renderTasksSurface([], "workflows");
    assert.match(documentList.textContent, /Card availability is unknown/);
    assert.doesNotMatch(documentList.textContent, /No active cards/);
    assert.match(
      documentList.textContent,
      /remaining pages have not been evaluated/,
    );

    setRoute({ path: "/cards/archive", params: new URLSearchParams() });
    api.renderTasksSurface([], "workflows");
    assert.match(documentList.textContent, /Archive availability is unknown/);
    assert.doesNotMatch(documentList.textContent, /Archive is empty/);
  });

  test("shows the anchor date on each card and orders columns by anchor", () => {
    const active = [
      {
        id: "late",
        title: "Late",
        stage: "preparation",
        anchorDate: "2026-09-01",
      },
      { id: "undated", title: "Undated", stage: "preparation" },
      {
        id: "soon",
        title: "Soon",
        stage: "preparation",
        anchorDate: "2026-08-13",
      },
    ];
    const { api, documentList } = createHarness({
      route: { path: "/cards", params: new URLSearchParams() },
      workSnapshot: {
        activeCards: active,
        cards: active,
        cardTasks: { late: [], undated: [], soon: [] },
      },
    });

    api.renderTasksSurface([], "workflows");
    const cards = findAllByClass(documentList, "workflow-board-card");
    assert.deepEqual(
      cards.map((card) => card.dataset.cardId),
      ["soon", "late", "undated"],
    );
    const anchors = findAllByClass(documentList, "workflow-card-anchor");
    assert.deepEqual(
      anchors.map((anchor) => anchor.dataset.anchorDate),
      ["2026-08-13", "2026-09-01"],
    );
    assert.deepEqual(
      anchors.map((anchor) => anchor.textContent),
      ["Tomorrow", "1 Sept"],
    );
    assert.deepEqual(
      anchors.map((anchor) => anchor.className),
      ["workflow-card-anchor is-upcoming", "workflow-card-anchor is-upcoming"],
    );
  });

  test("summarizes card progress as a count and severity flags instead of one meta line", () => {
    const active = [
      {
        id: "risky",
        title: "Risky",
        stage: "preparation",
        anchorDate: "2026-08-10",
      },
    ];
    const { api, documentList } = createHarness({
      route: { path: "/cards", params: new URLSearchParams() },
      workSnapshot: {
        activeCards: active,
        cards: active,
        cardTasks: {
          risky: [
            canonicalTask({
              id: "a",
              description: "Done",
              status: "done",
              date: "2026-08-01",
            }),
            canonicalTask({
              id: "b",
              description: "Late",
              date: "2026-08-05",
              requiresFile: true,
            }),
            canonicalTask({
              id: "c",
              description: "Waiting",
              status: "waiting",
              waitingFor: "reply",
            }),
          ],
        },
      },
    });

    api.renderTasksSurface([], "workflows");
    const [card] = findAllByClass(documentList, "workflow-board-card");
    assert.equal(card.className.includes("ops-risk-high"), true);
    assert.equal(
      findAllByClass(card, "workflow-card-anchor")[0].className,
      "workflow-card-anchor is-past",
    );
    assert.equal(
      findAllByClass(card, "workflow-card-count")[0].textContent,
      "1/3 tasks",
    );
    assert.deepEqual(
      findAllByClass(card, "workflow-card-flag").map((flag) => [
        flag.className,
        flag.textContent,
      ]),
      [
        ["workflow-card-flag is-danger", "1 overdue"],
        ["workflow-card-flag is-waiting", "1 waiting"],
        ["workflow-card-flag is-warning", "1 missing proof"],
      ],
    );
    assert.equal(
      card.title,
      "1/3 tasks - 1 overdue - 1 waiting - 1 missing file - 1 missing proof",
    );
  });

  test("marks a fully completed Card with a completion flag instead of an empty last line", async () => {
    const active = [
      {
        id: "done-card",
        title: "Done",
        stage: "after-event",
        anchorDate: "2026-08-10",
      },
    ];
    const { api, documentList } = createHarness({
      route: { path: "/cards", params: new URLSearchParams() },
      workSnapshot: {
        activeCards: active,
        cards: active,
        cardTasks: {
          "done-card": [
            canonicalTask({
              id: "a",
              description: "Done first",
              status: "done",
              date: "2026-08-01",
            }),
            canonicalTask({
              id: "b",
              description: "Done second",
              status: "done",
              date: "2026-08-02",
            }),
          ],
        },
      },
    });

    api.renderTasksSurface([], "workflows");
    const [card] = findAllByClass(documentList, "workflow-board-card");
    assert.equal(
      findAllByClass(card, "workflow-card-count")[0].textContent,
      "2/2 tasks",
    );
    assert.deepEqual(
      findAllByClass(card, "workflow-card-flag").map((flag) => [
        flag.className,
        flag.textContent,
      ]),
      [["workflow-card-flag is-success", "completion"]],
    );
  });

  test("restores Template route state for found, list, and not-found entities", async () => {
    const template = {
      id: "template-1",
      name: "Newsletter",
      type: "workflow",
      version: 2,
      taskDefinitions: [
        { refId: "draft", description: "Draft", offsetDays: 0 },
      ],
    };
    const { api, entityStates } = createHarness({
      request: async (url) => {
        if (url === "/api/templates") return { templates: [template] };
        if (url === "/api/me") return { user: { role: "operator" } };
        if (url === "/api/templates/missing") {
          const error = new Error("Not found");
          error.status = 404;
          throw error;
        }
        throw new Error(`Unexpected request ${url}`);
      },
    });

    await api.resolveTemplateRouteEntity(
      { params: new URLSearchParams({ templateId: "template-1" }) },
      1,
    );
    assert.deepEqual(entityStates.at(-1), {
      kind: "template",
      id: "template-1",
      status: "ready",
    });

    await api.resolveTemplateRouteEntity({ params: new URLSearchParams() }, 1);
    assert.equal(entityStates.at(-1), null);

    await api.resolveTemplateRouteEntity(
      { params: new URLSearchParams({ templateId: "missing" }) },
      1,
    );
    assert.deepEqual(entityStates.at(-1), {
      kind: "template",
      id: "missing",
      status: "not-found",
      error: "Not found",
    });
  });

  test("renders Authored Template projections read-only for every role", async () => {
    const template = {
      id: "template-1",
      name: "Newsletter",
      type: "workflow",
      version: 2,
      sourcePath: "workflow-templates/newsletter.yaml",
      sourceRevision: "1234567890abcdef",
      taskDefinitions: [
        { refId: "draft", description: "Draft", offsetDays: 0 },
      ],
    };
    const harness = createHarness({
      request: async (url) => {
        if (url === "/api/templates") return { templates: [template] };
        throw new Error(`Unexpected request ${url}`);
      },
    });
    await harness.api.refreshRuntimeTemplates();
    harness.api.setRuntimeTemplateRoute(
      {
        tasksSection: "templates",
        params: new URLSearchParams({ templateId: "template-1" }),
      },
      { templateId: "template-1" },
    );
    harness.api.renderTasksSurface([], "templates");

    assert.match(harness.documentList.textContent, /Authored templates/);
    assert.match(
      harness.documentList.textContent,
      /This definition is projected from reviewed YAML/,
      "provenance note; mutation controls stay out of the Templates page",
    );
    assert.match(
      harness.documentList.textContent,
      /workflow-templates\/newsletter.yaml/,
    );
    assert.match(harness.documentList.textContent, /1234567890ab/);
    assert.ok(findByText(harness.documentList, "Start card", "button"));
    assert.equal(findByText(harness.documentList, "Create card", "button"), undefined);
    for (const mutation of [
      "New runtime template",
      "Save template",
      "Delete template",
    ]) {
      assert.equal(
        findByText(harness.documentList, mutation, "button"),
        undefined,
      );
    }
  });

  test("keeps one stable Templates shell from loading through ready", async () => {
    const template = {
      id: "template-1",
      name: "Newsletter",
      type: "workflow",
      version: 2,
      triggerType: "manual",
      taskDefinitions: [
        { refId: "draft", description: "Draft", offsetDays: 0 },
      ],
    };
    const harness = createHarness({
      request: async (url) => {
        if (url === "/api/templates") return { templates: [template] };
        throw new Error(`Unexpected request ${url}`);
      },
    });
    // Before the fetch resolves the shell is already the shell: header,
    // list, and detail regions exist, with a quiet loading note in the list.
    harness.api.renderTasksSurface([], "templates");
    const loading = harness.documentList.querySelector(".runtime-template-inspector");
    assert.ok(loading);
    assert.ok(loading.querySelector(".dk-split"));
    assert.ok(loading.querySelector(".dk-split__list"));
    assert.ok(loading.querySelector(".dk-split__detail"));
    assert.match(
      loading.querySelector(".dk-split__list").textContent,
      /Loading templates/,
    );

    await harness.api.refreshRuntimeTemplates();
    harness.api.renderTasksSurface([], "templates");
    const ready = harness.documentList.querySelector(".runtime-template-inspector");
    assert.ok(ready);
    assert.equal(
      ready.querySelectorAll(".runtime-template-row").length,
      1,
      "the list fills in; the shell does not swap",
    );
    for (const removed of [
      ".runtime-template-toolbar",
      ".runtime-template-search",
      ".runtime-template-sort",
      ".runtime-template-result-count",
      ".runtime-template-facts",
      ".runtime-template-support",
      ".ops-template-grid",
    ]) {
      assert.equal(
        harness.documentList.querySelector(removed),
        null,
        `${removed} stays out of the simplified surface`,
      );
    }
  });

  test("keeps the Template list scroll when a Template is selected", async () => {
    const templates = [
      {
        id: "template-1",
        name: "Newsletter",
        type: "workflow",
        version: 2,
        triggerType: "manual",
        taskDefinitions: [],
      },
      {
        id: "template-2",
        name: "Webinar",
        type: "workflow",
        version: 2,
        triggerType: "manual",
        taskDefinitions: [],
      },
    ];
    const harness = createHarness({
      request: async (url) => {
        if (url === "/api/templates") return { templates };
        throw new Error(`Unexpected request ${url}`);
      },
    });
    await harness.api.refreshRuntimeTemplates();
    harness.api.renderTasksSurface([], "templates");
    // The list pane's scroller (the first .dk-split__scroll in the split).
    const list = harness.documentList.querySelector(".dk-split__scroll");
    list.scrollTop = 142;
    await list.dispatch("scroll");

    const rows = harness.documentList.querySelectorAll(".runtime-template-row");
    assert.equal(rows.length, 2);
    await rows[1].click();
    assert.deepEqual(harness.navigations.at(-1).params, { templateId: "template-2" });

    // The route change re-renders the surface (and the fetch renders it
    // again); the list must not jump back to the top.
    harness.api.setRuntimeTemplateRoute(
      {
        tasksSection: "templates",
        params: new URLSearchParams({ templateId: "template-2" }),
      },
      { templateId: "template-2" },
    );
    harness.api.renderTasksSurface([], "templates");
    assert.equal(
      harness.documentList.querySelector(".dk-split__scroll").scrollTop,
      142,
    );
  });

  test("every Templates surface class has an app stylesheet rule", async () => {
    // Regression guard: the stylesheet split dropped the Templates design
    // CSS while the markup kept emitting its classes, so rows rendered with
    // collapsed names and jammed controls. Render the list and a selected
    // detail, collect every emitted class, and require a matching rule.
    const template = {
      id: "template-1",
      name: "Newsletter",
      type: "workflow",
      version: 2,
      sourceRevision: "rev-2",
      taskDefinitions: [
        { refId: "draft", description: "Draft", offsetDays: 0 },
        { refId: "send", description: "Send", offsetDays: 1 },
      ],
    };
    const liveCard = {
      id: "card-1",
      title: "Newsletter run",
      status: "open",
      templateId: "template-1",
      templateVersion: 2,
      templateSourceRevision: "rev-2",
      templateDefinitionSnapshot: { version: 2 },
      openTaskCount: 1,
      updatedAt: new Date().toISOString(),
    };
    const harness = createHarness({
      request: async (url) => {
        if (url === "/api/templates") return { templates: [template] };
        throw new Error(`Unexpected request ${url}`);
      },
      workSnapshot: {
        cards: [
          liveCard,
          {
            ...liveCard,
            id: "card-2",
            title: "Old newsletter run",
            templateSourceRevision: "rev-1",
          },
        ],
      },
    });
    await harness.api.refreshRuntimeTemplates();

    const renderedClasses = new Set();
    const collectClasses = (element) => {
      for (const token of String(element.className || "").split(/\s+/)) {
        if (token) renderedClasses.add(token);
      }
      for (const child of element.children || []) collectClasses(child);
    };
    harness.api.renderTasksSurface([], "templates");
    collectClasses(harness.documentList);
    harness.api.setRuntimeTemplateRoute(
      {
        tasksSection: "templates",
        params: new URLSearchParams({ templateId: "template-1" }),
      },
      { templateId: "template-1" },
    );
    harness.api.renderTasksSurface([], "templates");
    collectClasses(harness.documentList);

    // Intentionally rule-less by design: the icons are styled by descendant
    // selectors (.runtime-template-title > svg,
    // .runtime-template-row .dk-split__name > svg), the inspector is laid out
    // by the kit (.dk-fill, .dk-split), and the hooks gate behavior, not paint.
    const unstyledByDesign = new Set([
      "runtime-template-icon",
      "runtime-template-trigger-icon",
      "runtime-template-readonly",
      "runtime-template-inspector",
      "runtime-template-projection",
    ]);
    const styles = uncommentCss(readAppCss());
    for (const token of [...renderedClasses].sort()) {
      if (unstyledByDesign.has(token) || token.startsWith("dk-")) continue;
      assert.match(
        styles,
        new RegExp(`\\.${token}(?![\\w-])`),
        `no app stylesheet rule styles .${token} on the Templates surface`,
      );
    }
  });

  test("opens a template preview with one Start card action and navigates live cards", async () => {
    const template = {
      id: "template-1",
      name: "Newsletter",
      type: "workflow",
      version: 2,
    };
    const liveCard = {
      id: "card-1",
      title: "Newsletter run",
      status: "open",
      templateId: "template-1",
      templateVersion: 2,
      templateSourceRevision: "rev-2",
      templateDefinitionSnapshot: { version: 2 },
      openTaskCount: 1,
      updatedAt: new Date().toISOString(),
    };
    const harness = createHarness({
      request: async (url) => {
        if (url === "/api/templates") return { templates: [template] };
        throw new Error(`Unexpected request ${url}`);
      },
      workSnapshot: { cards: [liveCard] },
    });
    await harness.api.refreshRuntimeTemplates();
    harness.api.renderTasksSurface([], "templates");

    const row = harness.documentList.querySelector(".runtime-template-row");
    assert.equal(row.querySelector("button"), null, "a template row only opens the preview");
    assert.equal(findByText(harness.documentList, "Start card", "button"), undefined);
    const emptyPane = harness.documentList.querySelector(".dk-split__empty");
    assert.match(emptyPane.textContent, /Choose a template from the list/);
    await row.dispatch("click");
    assert.deepEqual(harness.navigations.at(-1), {
      path: "/templates",
      params: { templateId: "template-1" },
      options: {},
    });

    harness.api.setRuntimeTemplateRoute(
      {
        tasksSection: "templates",
        params: new URLSearchParams({ templateId: "template-1" }),
      },
      { templateId: "template-1" },
    );
    harness.api.renderTasksSurface([], "templates");

    const start = findByText(harness.documentList, "Start card", "button");
    assert.ok(start);
    assert.equal(
      harness.documentList.querySelectorAll("button").filter((button) => button.textContent === "Start card").length,
      1,
    );
    await start.dispatch("click");
    const overlay = findAllByClass(harness.shellBody, "quick-form-overlay")[0];
    assert.ok(overlay, "the preview action starts a card from the selected template");
    assert.equal(overlay.querySelector("select").value, template.id);
    overlay.remove();

    const liveCardsList = harness.documentList.querySelector(".runtime-template-live-cards");
    const liveCardBtn = liveCardsList.querySelector("li button");
    assert.ok(liveCardBtn, "live card row must be interactive button");
    await liveCardBtn.dispatch("click");
    assert.deepEqual(harness.navigations.at(-1), {
      path: "/cards",
      params: { cardId: "card-1" },
      options: {},
    });
  });

  test("labels template select options with the template name", async () => {
    const harness = createHarness({
      request: async (url) => {
        if (url === "/api/templates") {
          return {
            templates: [
              { id: "tpl-1", name: "Newsletter" },
              { id: "tpl-2", name: "Podcast" },
            ],
          };
        }
        throw new Error(`Unexpected request ${url}`);
      },
    });
    await harness.api.openQuickWorkflowForm();
    const overlay = findAllByClass(harness.shellBody, "quick-form-overlay")[0];
    const select = overlay.querySelector("select");
    const optionTexts = select.children.map((opt) => opt.textContent);
    assert.deepEqual(optionTexts, ["Select template...", "Newsletter", "Podcast"]);
    overlay.remove();
  });

  test("reviews explicit Card selections and reports partial batch conflicts without retrying", async () => {
    const template = {
      id: "template-1",
      name: "Newsletter",
      type: "workflow",
      version: 3,
      taskDefinitions: [
        { refId: "draft", description: "Draft", offsetDays: 0 },
      ],
    };
    const cards = [
      {
        id: "card-august",
        title: "August",
        templateId: template.id,
        status: "active",
      },
      {
        id: "card-september",
        title: "September",
        templateId: template.id,
        status: "active",
      },
      {
        id: "card-current",
        title: "October",
        templateId: template.id,
        status: "active",
      },
    ];
    let previewCalls = 0;
    let workRefreshes = 0;
    const calls = [];
    const previews = {
      results: [
        {
          cardId: "card-august",
          status: "ready",
          preview: {
            state: "update-available",
            targetTemplateVersion: 3,
            previewToken: "token-august",
            counts: { updated: 1 },
          },
        },
        {
          cardId: "card-september",
          status: "ready",
          preview: {
            state: "update-available",
            targetTemplateVersion: 3,
            previewToken: "token-september",
            counts: { added: 1, retainedCompleted: 1 },
          },
        },
        {
          cardId: "card-current",
          status: "ready",
          preview: {
            state: "current",
            targetTemplateVersion: 3,
            previewToken: "token-current",
            counts: {},
          },
        },
      ],
    };
    const harness = createHarness({
      workSnapshot: { cards },
      refreshWork: async () => {
        workRefreshes += 1;
      },
      request: async (url, options = {}) => {
        calls.push({ url, options });
        if (url === "/api/templates") return { templates: [template] };
        if (url === "/api/cards/template-updates/preview") {
          previewCalls += 1;
          return previews;
        }
        if (url === "/api/cards/template-updates/apply") {
          return {
            results: [
              { cardId: "card-august", status: "applied" },
              { cardId: "card-september", status: "failed" },
            ],
          };
        }
        throw new Error(`Unexpected request ${url}`);
      },
    });
    await harness.api.refreshRuntimeTemplates();
    harness.api.setRuntimeTemplateRoute(
      {
        tasksSection: "templates",
        params: new URLSearchParams({ templateId: template.id }),
      },
      { templateId: template.id },
    );
    harness.api.renderTasksSurface([], "templates");

    await findByText(
      harness.documentList,
      "Review 3 cards for updates",
      "button",
    ).dispatch("click");
    assert.equal(previewCalls, 1);
    assert.deepEqual(
      JSON.parse(
        calls.find(({ url }) => url.endsWith("/preview")).options.body,
      ),
      { cardIds: ["card-august", "card-september", "card-current"] },
    );
    assert.match(
      harness.documentList.textContent,
      /Nothing is selected automatically/,
    );
    assert.equal(
      findByText(harness.documentList, "Apply 0 selected cards", "button")
        .disabled,
      true,
    );
    const cardCheckbox = (label) =>
      harness.documentList
        .querySelectorAll("input")
        .find(
          (input) => input.getAttribute("aria-label") === `Select ${label}`,
        );
    assert.equal(cardCheckbox("October").disabled, true);

    let checkbox = cardCheckbox("August");
    checkbox.checked = true;
    await checkbox.dispatch("change");
    checkbox = cardCheckbox("September");
    checkbox.checked = true;
    await checkbox.dispatch("change");
    const apply = findByText(
      harness.documentList,
      "Apply 2 selected cards",
      "button",
    );
    assert.equal(apply.disabled, false);
    await apply.dispatch("click");

    const mutation = calls.find(({ url }) => url.endsWith("/apply"));
    assert.deepEqual(JSON.parse(mutation.options.body), {
      updates: [
        { cardId: "card-august", previewToken: "token-august" },
        { cardId: "card-september", previewToken: "token-september" },
      ],
    });
    assert.equal(workRefreshes, 1);
    assert.equal(previewCalls, 1);
    assert.match(
      harness.documentList.textContent,
      /1 card applied · 1 conflict needs a fresh preview/,
    );
    assert.match(
      harness.documentList.textContent,
      /September: conflict — reload before retrying/,
    );

    await findByText(
      harness.documentList,
      "Reload batch previews",
      "button",
    ).dispatch("click");
    assert.equal(previewCalls, 2);
  });

  test("renders Recurring empty/list states and maps pause plus protected-delete guidance", async () => {
    const recurring = recurringSnapshot([
      serverSchedule({
        id: "recurring-1",
        description: "Weekly newsletter",
        cronExpression: "0 9 * * 1",
      }),
    ]);
    const calls = [];
    const harness = createHarness({
      model: baseModel({ recurring }),
      request: async (url, options) => {
        calls.push({ url, options });
        if (url === "/api/recurring/recurring-1" && options.method === "PUT")
          return {};
        if (
          url === "/api/recurring/recurring-1" &&
          options.method === "DELETE"
        ) {
          const error = new Error("In use");
          error.status = 409;
          throw error;
        }
        throw new Error(`Unexpected request ${url}`);
      },
    });
    harness.api.renderTasksSurface([], "recurring");
    // Create rides on the Schedules list, not in the page header.
    assert.equal(harness.documentList.querySelector(".dk-page-header__actions"), null);
    const schedulesHeader = harness.documentList.querySelector(".collection-header");
    assert.match(schedulesHeader.textContent, /Schedules/);
    const create = findByText(schedulesHeader, "New schedule", "button");
    assert.ok(create);
    assert.equal(create.getAttribute("aria-keyshortcuts"), "c");
    assert.match(harness.documentList.textContent, /Every Monday/);
    assert.match(harness.documentList.textContent, /Next /);

    await findByText(harness.documentList, "Pause", "button").dispatch("click");
    assert.deepEqual(JSON.parse(calls.at(-1).options.body), { enabled: false });

    await findByText(harness.documentList, "Delete", "button").dispatch(
      "click",
    );
    await nextTicks();
    assert.equal(calls.at(-1).options.method, "DELETE");
    assert.match(
      harness.documentList.textContent,
      /cannot be deleted\. Pause it instead; generated tasks and notifications are preserved/,
    );

    harness.setModel(baseModel());
    harness.api.renderTasksSurface([], "recurring");
    assert.match(harness.documentList.textContent, /No recurring schedules yet/);
    assert.equal(harness.documentList.querySelector(".surface-summary"), null);
  });

  test("shows the recurring batch in Berlin time across winter and summer", () => {
    const harness = createHarness();
    for (const [date, expected] of [
      ["2026-01-12", /Next Mon 12 Jan at 09:00 CET/],
      ["2026-07-13", /Next Mon 13 Jul at 10:00 CEST/],
    ]) {
      harness.setModel(baseModel({ recurring: recurringSnapshot([{
        id: "berlin-schedule",
        description: "Weekly work",
        enabled: true,
        scheduleLabel: "Every Monday at 09:00",
        nextRunDate: date,
        nextRunLabel: date === "2026-01-12" ? "Mon 12 Jan" : "Mon 13 Jul",
      }]) }));
      harness.api.renderTasksSurface([], "recurring");
      assert.match(harness.documentList.textContent, expected);
      assert.match(harness.documentList.textContent, /Europe\/Berlin/);
      assert.equal(harness.documentList.textContent.includes("Every Monday at 09:00"), false);
    }
  });

  test("exposes recurring Active and Paused state as text without prohibited ARIA", () => {
    const harness = createHarness({
      model: baseModel({
        recurring: recurringSnapshot([
          serverSchedule({
            id: "active-schedule",
            description: "Active schedule",
            cronExpression: "0 9 * * 1",
          }),
          serverSchedule({
            id: "paused-schedule",
            description: "Paused schedule",
            cronExpression: "0 9 * * 2",
            enabled: false,
          }),
        ]),
      }),
    });

    harness.api.renderTasksSurface([], "recurring");
    const statuses = findAllByClass(harness.documentList, "recurring-status");
    assert.deepEqual(
      statuses.map((status) => status.textContent),
      ["Active", "Paused"],
    );
    assert.ok(
      statuses.every((status) => status.getAttribute("aria-label") === null),
    );
    assert.deepEqual(
      statuses.map(
        (status) => findAllByClass(status, "visually-hidden")[0]?.textContent,
      ),
      ["Active", "Paused"],
    );
  });

  test("creates and edits recurring schedules from the Recurring tab", async () => {
    const config = serverSchedule({
      id: "recurring-1",
      description: "Weekly newsletter",
      cronExpression: "0 9 * * 1",
      assigneeId: "user-grace",
    });
    const harness = createHarness({
      model: baseModel({ recurring: recurringSnapshot([config]) }),
      workSnapshot: {
        users: [
          { id: "user-grace", name: "Grace" },
          { id: "user-sam", name: "Sam" },
        ],
      },
    });
    harness.api.renderTasksSurface([], "recurring");

    await findByText(harness.documentList, "New schedule", "button").dispatch(
      "click",
    );
    const createOverlay = findAllByClass(
      harness.shellBody,
      "quick-form-overlay",
    )[0];
    const createInputs = createOverlay.querySelectorAll("input");
    createInputs[0].value = "Daily standup";
    const createSelects = createOverlay.querySelectorAll("select");
    const assigneeSelect = createSelects.at(-1);
    assert.deepEqual(
      assigneeSelect.querySelectorAll("option").map((o) => o.textContent),
      ["Unassigned", "Grace", "Sam"],
    );
    assigneeSelect.value = "user-sam";
    await submitQuickForm(createOverlay);
    await nextTicks();
    assert.equal(harness.requests.at(-1).url, "/api/recurring");
    assert.equal(harness.requests.at(-1).options.method, "POST");
    assert.deepEqual(JSON.parse(harness.requests.at(-1).options.body), {
      description: "Daily standup",
      cronExpression: "0 9 * * *",
      enabled: true,
      assigneeId: "user-sam",
    });

    harness.api.renderTasksSurface([], "recurring");
    await findByText(harness.documentList, "Edit", "button").dispatch("click");
    const editOverlay = findAllByClass(
      harness.shellBody,
      "quick-form-overlay",
    ).at(-1);
    const editInputs = editOverlay.querySelectorAll("input");
    assert.equal(editInputs[0].value, "Weekly newsletter");
    const editSelects = editOverlay.querySelectorAll("select");
    assert.equal(editSelects[0].value, "weekly");
    assert.equal(editSelects[1].value, "1");
    assert.equal(editSelects.at(-1).value, "user-grace");
    // The preview echoes the cron that will be sent; the next run is the
    // server's to compute once it stores the schedule.
    assert.match(editOverlay.textContent, /0 9 \* \* 1/);
    editInputs[0].value = "Weekly newsletter prep";
    await submitQuickForm(editOverlay);
    await nextTicks();
    assert.equal(harness.requests.at(-1).url, "/api/recurring/recurring-1");
    assert.equal(harness.requests.at(-1).options.method, "PUT");
    assert.deepEqual(JSON.parse(harness.requests.at(-1).options.body), {
      description: "Weekly newsletter prep",
      cronExpression: "0 9 * * 1",
      enabled: true,
      assigneeId: "user-grace",
    });
  });

  test("manages focus and dialog semantics for recurring create and edit forms", async () => {
    const config = serverSchedule({
      id: "recurring-focus",
      description: "Focus-safe schedule",
      cronExpression: "0 9 * * 1",
    });
    const harness = createHarness({
      model: baseModel({ recurring: recurringSnapshot([config]) }),
    });
    harness.api.renderTasksSurface([], "recurring");

    const createOpener = findByText(
      harness.documentList,
      "New schedule",
      "button",
    );
    harness.document.activeElement = createOpener;
    await createOpener.dispatch("click");
    const createOverlay = findAllByClass(
      harness.shellBody,
      "quick-form-overlay",
    )[0];
    const createPanel = createOverlay.querySelector('[role="dialog"]');
    const createTitle = createOverlay.querySelector("strong");
    assert.ok(createTitle.getAttribute("id"));
    assert.equal(
      createPanel.getAttribute("aria-labelledby"),
      createTitle.getAttribute("id"),
    );
    const createDescription = createOverlay.querySelector('input[type="text"]');
    assert.equal(createDescription.focused, true);

    const first = createOverlay.querySelector("button");
    const last = findByText(createOverlay, "Create schedule", "button");
    let prevented = false;
    harness.document.activeElement = last;
    await createOverlay.dispatch("keydown", {
      key: "Tab",
      shiftKey: false,
      preventDefault: () => {
        prevented = true;
      },
    });
    assert.equal(prevented, true);
    assert.equal(first.focused, true);

    prevented = false;
    harness.document.activeElement = first;
    await createOverlay.dispatch("keydown", {
      key: "Tab",
      shiftKey: true,
      preventDefault: () => {
        prevented = true;
      },
    });
    assert.equal(prevented, true);
    assert.equal(last.focused, true);

    harness.document.activeElement = createDescription;
    await createOverlay.dispatch("keydown", {
      key: "Escape",
      preventDefault() {},
    });
    assert.equal(createOverlay.removed, true);
    assert.equal(createOpener.focused, true);

    harness.api.renderTasksSurface([], "recurring");
    const editOpener = findByText(harness.documentList, "Edit", "button");
    harness.document.activeElement = editOpener;
    await editOpener.dispatch("click");
    const editOverlay = findAllByClass(
      harness.shellBody,
      "quick-form-overlay",
    ).at(-1);
    const editPanel = editOverlay.querySelector('[role="dialog"]');
    const editTitle = editOverlay.querySelector("strong");
    assert.equal(
      editPanel.getAttribute("aria-labelledby"),
      editTitle.getAttribute("id"),
    );
    assert.equal(editOverlay.querySelector('input[type="text"]').focused, true);

    await editOverlay.dispatch("keydown", {
      key: "Escape",
      preventDefault() {},
    });
    assert.equal(editOverlay.removed, true);
    assert.equal(editOpener.focused, true);
  });

  test("reports Queue load state in the Tasks surface instead of a hidden status line", async () => {
    const loading = createHarness({
      model: baseModel({
        stats: {
          activeCards: 0,
          followUpTasks: 0,
          liveLoaded: false,
          missingProofTasks: 0,
        },
      }),
    });
    loading.api.renderTasksSurface([], "queue");
    const loadingSummary =
      loading.documentList.querySelector(".surface-summary");
    assert.equal(loadingSummary.dataset.summaryState, "loading");
    assert.equal(loadingSummary.dataset.summaryId, "tasks-queue");
    assert.match(loadingSummary.textContent, /Loading tasks from the work API/);

    const refreshes = [];
    const failed = createHarness({
      model: baseModel({
        runtime: {
          connected: false,
          errors: ["Synthetic route failure (503)"],
        },
        stats: {
          activeCards: 0,
          followUpTasks: 0,
          liveLoaded: false,
          missingProofTasks: 0,
          workErrors: ["Synthetic route failure (503)"],
        },
      }),
      workSnapshot: {
        tasks: [],
        todayLoaded: false,
        overdueLoaded: false,
        waitingLoaded: false,
      },
      refreshWork: async (options) => refreshes.push(options),
    });
    failed.api.renderTasksSurface([], "queue");
    const outage = failed.documentList.querySelector(".surface-summary");
    assert.equal(outage.dataset.summaryState, "unavailable");
    assert.equal(
      outage.querySelector(".surface-summary-line").getAttribute("role"),
      "alert",
    );
    assert.equal(
      outage.querySelector(".surface-summary-detail").textContent,
      "Synthetic route failure (503)",
    );
    // The queue board names the outage where the rows would be; it never
    // renders an empty-looking list for data it does not have.
    const outageBoard = failed.documentList.querySelector(".ops-queue-board");
    assert.equal(outageBoard.dataset.loadState, "unavailable");
    assert.equal(
      outageBoard.querySelector(".ops-empty").dataset.state,
      "unavailable",
    );
    assert.equal(findAllByClass(outageBoard, "ops-queue-row").length, 0);
    await outage.querySelector(".surface-summary-retry").dispatch("click");
    await nextTicks();
    assert.deepEqual(refreshes, [{ rerender: false }]);
    assert.deepEqual(
      failed.documentRefreshes,
      ["tasks"],
      "the retry re-renders only through the owning-route callback",
    );

    const partial = createHarness({
      model: baseModel({
        runtime: { connected: true, errors: ["Waiting source unavailable"] },
        stats: {
          activeCards: 1,
          followUpTasks: 1,
          liveLoaded: true,
          missingProofTasks: 0,
          workErrors: ["Waiting source unavailable"],
        },
      }),
      workSnapshot: {
        tasks: [canonicalTask({ id: "task-1", description: "Ship" })],
      },
    });
    partial.api.renderTasksSurface([], "queue");
    const partialSummary =
      partial.documentList.querySelector(".surface-summary");
    assert.equal(partialSummary.dataset.summaryState, "partial");
    assert.match(partialSummary.textContent, /1 known work item/);
    assert.match(
      partialSummary.textContent,
      /follow-ups unknown/,
      "a source that did not answer has no count, not a zero",
    );
    assert.match(
      partialSummary.textContent,
      /Some task sources are unavailable/,
    );

    const empty = createHarness();
    empty.api.renderTasksSurface([], "queue");
    const emptySummary = empty.documentList.querySelector(".surface-summary");
    assert.equal(emptySummary.dataset.summaryState, "empty");
    assert.match(emptySummary.textContent, /No tasks are open in this queue/);
    assert.equal(emptySummary.querySelector(".surface-summary-retry"), null);
  });

  test("a failed queue renders an unavailable board, never zero work", () => {
    const failed = createHarness({
      model: baseModel({
        runtime: {
          connected: false,
          errors: ["Synthetic route failure (503)"],
        },
        stats: {
          activeCards: 0,
          followUpTasks: 0,
          liveLoaded: false,
          missingProofTasks: 0,
          todayLoaded: false,
          overdueLoaded: false,
          waitingLoaded: false,
          workErrors: ["Synthetic route failure (503)"],
        },
      }),
      workSnapshot: {
        tasks: [],
        todayLoaded: false,
        overdueLoaded: false,
        waitingLoaded: false,
      },
    });
    failed.api.renderTasksSurface([], "queue");
    const failedSummary = failed.documentList.querySelector(".surface-summary");
    assert.equal(failedSummary.dataset.summaryState, "unavailable");
    assert.equal(
      failedSummary.textContent.includes("0 known"),
      false,
      "unavailable work is not summarized as zero items",
    );
    const board = failed.documentList.querySelector(".ops-queue-board");
    assert.equal(board.dataset.loadState, "unavailable");
    const unavailable = board.querySelector(".ops-empty");
    assert.equal(unavailable.dataset.state, "unavailable");
    assert.match(unavailable.textContent, /Live work data unavailable/);
    assert.equal(findAllByClass(board, "ops-queue-row").length, 0);
    assert.equal(board.querySelector(".ops-queue-total"), null);
    assert.equal(
      board.querySelector(".ops-queue-history"),
      null,
      "a failed queue renders no counts, not zeros",
    );
    assert.equal(
      failed.documentList.textContent.includes(" 0 "),
      false,
      "failed sources are not interpreted as zero work",
    );

    const partialOutage = createHarness({
      model: baseModel({
        runtime: { connected: true, errors: ["Synthetic route failure (503)"] },
        stats: {
          activeCards: 0,
          followUpTasks: 0,
          liveLoaded: true,
          missingProofTasks: 0,
          todayLoaded: false,
          overdueLoaded: false,
          waitingLoaded: false,
          workErrors: ["Synthetic route failure (503)"],
        },
      }),
      workSnapshot: {
        tasks: [],
        todayLoaded: false,
        overdueLoaded: false,
        waitingLoaded: false,
      },
    });
    partialOutage.api.renderTasksSurface([], "queue");
    const partialSummary =
      partialOutage.documentList.querySelector(".surface-summary");
    assert.equal(partialSummary.dataset.summaryState, "partial");
    assert.match(partialSummary.textContent, /known work items unknown/);
    assert.equal(
      partialSummary.textContent.includes("0 known"),
      false,
      "a silent task source has no count, not a zero",
    );
  });

  test("reports Recurring and Templates load state in their own sections", async () => {
    const refreshes = [];
    const unavailable = createHarness({
      model: baseModel({
        recurring: {
          configs: [],
          disabled: [],
          enabled: [],
          errors: ["Recurring API request failed"],
          loaded: false,
        },
      }),
      refreshRecurring: async () => refreshes.push("recurring"),
    });
    unavailable.api.renderTasksSurface([], "recurring");
    const summary = unavailable.documentList.querySelector(".surface-summary");
    assert.equal(summary.dataset.summaryState, "unavailable");
    assert.equal(summary.dataset.summaryId, "tasks-recurring");
    assert.match(
      summary.textContent,
      /Recurring schedules could not be loaded/,
    );
    await summary.querySelector(".surface-summary-retry").dispatch("click");
    await nextTicks();
    assert.deepEqual(refreshes, ["recurring"]);

    const ready = createHarness({
      model: baseModel({
        recurring: recurringSnapshot([
          {
            id: "recurring-1",
            description: "Weekly newsletter",
            cronExpression: "0 9 * * 1",
            enabled: true,
          },
        ]),
      }),
    });
    ready.api.renderTasksSurface([], "recurring");
    const readySummary = ready.documentList.querySelector(".surface-summary");
    assert.equal(
      readySummary,
      null,
      "successful loads do not repeat in a READY sentence",
    );

    const templates = createHarness({
      request: async (url) => {
        if (url === "/api/templates") throw new Error("Templates unavailable");
        return {};
      },
    });
    await templates.api.refreshRuntimeTemplates();
    templates.api.renderTasksSurface([], "templates");
    const templateSummary =
      templates.documentList.querySelector(".surface-summary");
    assert.equal(templateSummary.dataset.summaryState, "partial");
    assert.equal(
      templateSummary.querySelector(".surface-summary-detail").textContent,
      "Templates unavailable",
    );
  });

  test("refreshes a stale Recurring row mutation without replacing the current view", async () => {
    const config = serverSchedule({
      id: "recurring-stale",
      description: "Weekly newsletter",
      cronExpression: "0 9 * * 1",
    });
    let releaseRequest;
    let completeMutation;
    const refreshes = [];
    const harness = createHarness({
      model: baseModel({
        recurring: recurringSnapshot([config]),
      }),
      refreshRecurring: async ({ rerender }) => {
        refreshes.push({ rerender });
        await new Promise((resolve) => {
          completeMutation = resolve;
        });
      },
      request: async () =>
        new Promise((resolve) => {
          releaseRequest = resolve;
        }),
    });
    harness.api.renderTasksSurface([], "recurring");
    const pause = findByText(harness.documentList, "Pause", "button");

    const mutation = pause.click();
    harness.setActiveRouteToken(2);
    await nextTicks();
    releaseRequest();
    await nextTicks();
    completeMutation();
    await mutation;
    await nextTicks();

    assert.deepEqual(refreshes, [{ rerender: false }]);
    assert.deepEqual(harness.documentRefreshes, []);
    assert.equal(
      pause.isConnected,
      true,
      "the stale mutation must not replace the newer view",
    );
  });

  test("keeps a stale Recurring summary retry from re-rendering the newer route", async () => {
    let finishRefresh;
    const refreshes = [];
    const harness = createHarness({
      model: baseModel({
        recurring: {
          configs: [],
          enabled: [],
          disabled: [],
          errors: ["Synthetic route failure (503)"],
          loaded: false,
        },
      }),
      refreshRecurring: async ({ rerender }) => {
        refreshes.push({ rerender });
        await new Promise((resolve) => {
          finishRefresh = resolve;
        });
      },
    });
    harness.api.renderTasksSurface([], "recurring");
    const retry = harness.documentList.querySelector(".surface-summary-retry");

    const retryClick = retry.click();
    harness.setActiveRouteToken(2);
    finishRefresh();
    await retryClick;
    await nextTicks();

    assert.deepEqual(refreshes, [{ rerender: false }]);
    assert.deepEqual(harness.documentRefreshes, []);
    assert.equal(retry.isConnected, true);
  });

  test("refreshes a stale successful quick Task without replacing the newer view", async () => {
    let releaseMutation;
    const refreshes = [];
    const harness = createHarness({
      request: (url) =>
        url === "/api/tasks"
          ? new Promise((resolve) => {
              releaseMutation = () => resolve({ task: { id: "task-created" } });
            })
          : {},
      refreshWork: async ({ rerender }) => {
        refreshes.push({ rerender });
      },
    });
    harness.api.openQuickTaskForm();
    const overlay = findAllByClass(harness.shellBody, "quick-form-overlay")[0];
    const inputs = overlay.querySelectorAll("input");
    inputs.find((input) => input.type === "text").value = "Prepare release";
    inputs.find((input) => input.type === "date").value = "2026-08-15";

    const mutation = submitQuickForm(overlay);
    await nextTicks();
    harness.setActiveRouteToken(2);
    releaseMutation();
    await mutation;
    await nextTicks();

    assert.deepEqual(refreshes, [{ rerender: false }]);
    assert.deepEqual(harness.openedTasks, []);
    assert.deepEqual(harness.documentRefreshes, []);
    assert.equal(overlay.removed, true);
  });

  test("offers optional task groups in the quick Card form", async () => {
    const bodies = [];
    const harness = createHarness({
      request: async (url, options = {}) => {
        if (url === "/api/templates")
          return {
            templates: [
              {
                id: "tpl-news",
                name: "Newsletter",
                taskDefinitions: [
                  { refId: "core", description: "Core", offsetDays: 0 },
                  { refId: "extra", description: "Extra", offsetDays: 1, optionalGroup: "secondary" },
                ],
              },
            ],
          };
        if (url === "/api/cards") {
          bodies.push(JSON.parse(options.body));
          return { card: { id: "card-1" } };
        }
        throw new Error(`Unexpected request ${url}`);
      },
    });
    await harness.api.openQuickWorkflowForm();
    const overlay = findAllByClass(harness.shellBody, "quick-form-overlay")[0];
    overlay.querySelector("select").value = "tpl-news";
    await overlay.querySelector("select").dispatch("change");
    const boxes = overlay.querySelectorAll('input[type="checkbox"]');
    assert.equal(boxes.length, 1);
    assert.match(boxes[0].parentElement.textContent, /secondary/);
    boxes[0].checked = true;

    await submitQuickForm(overlay);
    assert.deepEqual(bodies, [
      {
        templateId: "tpl-news",
        anchorDate: "2026-08-12",
        optionalGroups: ["secondary"],
      },
    ]);
    assert.deepEqual(harness.openedCards, ["card-1"]);
  });

  test("refreshes a stale successful quick Card without replacing the newer view", async () => {
    let releaseMutation;
    const refreshes = [];
    const harness = createHarness({
      request: async (url) => {
        if (url === "/api/templates")
          return { templates: [{ id: "template-uuid", name: "Newsletter" }] };
        if (url === "/api/cards") {
          return new Promise((resolve) => {
            releaseMutation = () => resolve({ card: { id: "card-created" } });
          });
        }
        throw new Error(`Unexpected request ${url}`);
      },
      refreshWork: async ({ rerender }) => {
        refreshes.push({ rerender });
      },
    });
    await harness.api.openQuickWorkflowForm();
    const overlay = findAllByClass(harness.shellBody, "quick-form-overlay")[0];
    overlay.querySelector("select").value = "template-uuid";
    const inputs = overlay.querySelectorAll("input");
    inputs[0].value = "August newsletter";
    inputs[1].value = "2026-08-20";

    const mutation = submitQuickForm(overlay);
    await nextTicks();
    harness.setActiveRouteToken(2);
    releaseMutation();
    await mutation;
    await nextTicks();

    assert.deepEqual(refreshes, [{ rerender: false }]);
    assert.deepEqual(harness.openedCards, []);
    assert.deepEqual(harness.documentRefreshes, []);
    assert.equal(overlay.removed, true);
  });

  test("refreshes a stale successful recurring form without replacing the newer view", async () => {
    let releaseMutation;
    let finishRefresh;
    const refreshes = [];
    const harness = createHarness({
      model: baseModel({
        recurring: recurringSnapshot([]),
      }),
      refreshRecurring: async ({ rerender }) => {
        refreshes.push({ rerender });
        await new Promise((resolve) => {
          finishRefresh = resolve;
        });
      },
      request: () =>
        new Promise((resolve) => {
          releaseMutation = resolve;
        }),
    });
    harness.api.renderTasksSurface([], "recurring");
    await findByText(harness.documentList, "New schedule", "button").dispatch(
      "click",
    );
    const overlay = findAllByClass(harness.shellBody, "quick-form-overlay")[0];
    overlay.querySelector('input[type="text"]').value = "Daily standup";

    const mutation = submitQuickForm(overlay);
    await nextTicks();
    harness.setActiveRouteToken(2);
    releaseMutation();
    await nextTicks();
    finishRefresh();
    await mutation;
    await nextTicks();

    assert.deepEqual(refreshes, [{ rerender: false }]);
    assert.deepEqual(harness.documentRefreshes, []);
    assert.equal(overlay.removed, true);
  });

  test("keeps a failed quick Task in its own form with retained input and no toast", async () => {
    const harness = createHarness({
      request: async () => {
        const error = new Error("Synthetic route failure (503)");
        error.status = 503;
        throw error;
      },
    });
    harness.api.openQuickTaskForm();
    const overlay = findAllByClass(harness.shellBody, "quick-form-overlay")[0];
    const create = findByText(overlay, "Create task", "button");
    const description = overlay
      .querySelectorAll("input")
      .find((input) => input.type === "text");
    description.value = "Prepare release";
    await submitQuickForm(overlay);
    await nextTicks();

    const feedback = overlay.querySelector(".form-feedback");
    assert.equal(feedback.dataset.feedbackState, "error");
    const alertNode = feedback.querySelector(".form-feedback-error");
    assert.equal(alertNode.getAttribute("role"), "alert");
    assert.match(alertNode.textContent, /Synthetic route failure \(503\)/);
    assert.match(alertNode.textContent, /Select Create task to retry/);
    assert.equal(alertNode.focused, true);
    assert.equal(description.value, "Prepare release", "input is retained");
    assert.equal(create.disabled, false);
    assert.equal(create.getAttribute("aria-busy"), null);
    assert.equal(overlay.removed, false);
  });

  test("gives a conflicting quick Task explicit reload, retry, and discard paths", async () => {
    const refreshes = [];
    const harness = createHarness({
      request: async (url) => {
        if (url !== "/api/tasks") throw new Error(`Unexpected request ${url}`);
        const error = new Error("Work queue moved");
        error.status = 409;
        throw error;
      },
      refreshWork: async ({ rerender }) => {
        refreshes.push({ rerender });
      },
    });
    harness.api.openQuickTaskForm();
    const overlay = findAllByClass(harness.shellBody, "quick-form-overlay")[0];
    const inputs = overlay.querySelectorAll("input");
    inputs[0].value = "Prepare release";
    inputs[1].value = "2026-08-15";
    await submitQuickForm(overlay);
    await nextTicks();

    const feedback = overlay.querySelector(".form-feedback");
    assert.equal(feedback.dataset.feedbackState, "conflict");
    assert.match(feedback.textContent, /conflict while creating this Task/);
    assert.match(feedback.textContent, /Create task to retry/);
    assert.match(feedback.textContent, /Close to discard this draft/);
    assert.equal(inputs[0].value, "Prepare release");

    await submitQuickForm(overlay);
    await nextTicks();
    const recoveryActions = overlay.querySelectorAll(".quick-form-retry");
    assert.equal(
      recoveryActions.length,
      1,
      "a repeated conflict replaces the previous recovery action",
    );

    await findByText(overlay, "Review current work", "button").click();
    await nextTicks();
    assert.deepEqual(refreshes, [{ rerender: true }]);
    assert.equal(overlay.removed, true);
  });

  test("moves initial focus into quick Task and Card dialogs", async () => {
    const taskHarness = createHarness();
    taskHarness.api.openQuickTaskForm();
    const taskOverlay = findAllByClass(
      taskHarness.shellBody,
      "quick-form-overlay",
    )[0];
    const description = taskOverlay
      .querySelectorAll("input")
      .find((input) => input.type === "text");
    assert.equal(description.focused, true);

    const cardHarness = createHarness({
      request: async (url) =>
        url === "/api/templates"
          ? { templates: [{ id: "template-uuid", name: "Newsletter" }] }
          : {},
    });
    await cardHarness.api.openQuickWorkflowForm();
    const cardOverlay = findAllByClass(
      cardHarness.shellBody,
      "quick-form-overlay",
    )[0];
    const title = cardOverlay
      .querySelectorAll("input")
      .find((input) => input.type === "text");
    assert.equal(title.focused, true);
  });

  test("returns a failed pause to the schedule row that started it", async () => {
    const recurring = recurringSnapshot([
      {
        id: "recurring-1",
        description: "Weekly newsletter",
        cronExpression: "0 9 * * 1",
        enabled: true,
      },
    ]);
    const harness = createHarness({
      model: baseModel({ recurring }),
      request: async () => {
        throw new Error("Synthetic route failure (503)");
      },
    });
    harness.api.renderTasksSurface([], "recurring");
    const pause = findByText(harness.documentList, "Pause", "button");
    await pause.dispatch("click");
    await nextTicks();

    const rowError = harness.documentList.querySelector(".recurring-row-error");
    assert.equal(rowError.getAttribute("role"), "alert");
    assert.match(rowError.textContent, /Could not pause this schedule/);
    assert.match(rowError.textContent, /Select Pause to retry/);
    assert.equal(rowError.focused, true);
    assert.equal(
      findByText(harness.documentList, "Pause", "button").disabled,
      false,
      "the retry control stays usable",
    );
  });

  test("authoritatively reloads a conflicting recurring schedule when Cancel is used", async () => {
    const config = {
      id: "recurring-conflict",
      description: "Weekly newsletter",
      cronExpression: "0 9 * * 1",
      enabled: true,
    };
    const refreshes = [];
    const harness = createHarness({
      model: baseModel({ recurring: recurringSnapshot([config]) }),
      request: async (url, options = {}) => {
        if (url !== "/api/recurring/recurring-conflict")
          throw new Error(`Unexpected request ${url}`);
        if (options.method !== "PUT") return {};
        const error = new Error("Schedule changed elsewhere");
        error.status = 409;
        throw error;
      },
      refreshRecurring: async ({ rerender }) => {
        refreshes.push({ rerender });
      },
    });
    harness.api.renderTasksSurface([], "recurring");
    await findByText(harness.documentList, "Edit", "button").dispatch("click");
    const overlay = findAllByClass(harness.shellBody, "quick-form-overlay")[0];
    overlay.querySelector('input[type="text"]').value =
      "Weekly newsletter prep";
    await submitQuickForm(overlay);
    await nextTicks();

    const feedback = overlay.querySelector(".form-feedback");
    assert.equal(feedback.dataset.feedbackState, "conflict");
    assert.match(
      feedback.textContent,
      /Cancel to discard this draft and reload schedules/,
    );

    await findByText(overlay, "Cancel", "button").click();
    await nextTicks(3);
    assert.deepEqual(refreshes, [{ rerender: false }]);
    assert.deepEqual(harness.documentRefreshes, ["tasks"]);
    assert.equal(overlay.removed, true);
  });

  test("validates and creates quick Tasks with the canonical mutation shape", async () => {
    const { api, openedTasks, requests, shellBody } = createHarness({
      request: async (url) =>
        url === "/api/tasks" ? { task: { id: "task-created" } } : {},
    });
    api.openQuickTaskForm();
    const overlay = findAllByClass(shellBody, "quick-form-overlay")[0];
    const create = findByText(overlay, "Create task", "button");
    await submitQuickForm(overlay);
    const validation = findAllByClass(overlay, "field-error").filter(
      (node) => !node.hidden,
    );
    assert.deepEqual(
      validation.map((node) => node.textContent),
      ["Task description is required."],
    );
    const description = overlay
      .querySelectorAll("input")
      .find((input) => input.type === "text");
    assert.equal(description.getAttribute("aria-invalid"), "true");
    assert.equal(
      description.getAttribute("aria-describedby"),
      validation[0].getAttribute("id"),
    );
    assert.equal(description.focused, true);
    assert.equal(
      overlay.querySelector(".form-feedback-error").hidden,
      true,
      "validation stays in the form, not in a global toast",
    );
    assert.equal(requests.length, 0);

    const inputs = overlay.querySelectorAll("input");
    inputs.find((input) => input.type === "text").value = "Prepare release";
    inputs.find((input) => input.type === "date").value = "2026-08-15";
    await submitQuickForm(overlay);
    await nextTicks();
    assert.equal(requests[0].url, "/api/tasks");
    assert.equal(requests[0].options.method, "POST");
    assert.deepEqual(JSON.parse(requests[0].options.body), {
      description: "Prepare release",
      date: "2026-08-15",
    });
    assert.deepEqual(openedTasks, ["task-created"]);
    assert.equal(overlay.removed, true);
  });

  test("validates and creates quick Cards from a live Template UUID", async () => {
    const calls = [];
    const harness = createHarness({
      request: async (url, options = {}) => {
        calls.push({ url, options });
        if (url === "/api/templates")
          return { templates: [{ id: "template-uuid", name: "Newsletter" }] };
        if (url === "/api/cards") return { card: { id: "card-created" } };
        throw new Error(`Unexpected request ${url}`);
      },
    });
    await harness.api.openQuickWorkflowForm();
    const overlay = findAllByClass(harness.shellBody, "quick-form-overlay")[0];
    const create = findByText(overlay, "Create card", "button");
    await submitQuickForm(overlay);
    const validation = findAllByClass(overlay, "field-error").filter(
      (node) => !node.hidden,
    );
    assert.deepEqual(
      validation.map((node) => node.textContent),
      ["Select a template."],
    );
    assert.equal(
      overlay.querySelector("select").getAttribute("aria-invalid"),
      "true",
    );
    assert.equal(calls.filter(({ url }) => url === "/api/cards").length, 0);

    const select = overlay.querySelector("select");
    select.value = "template-uuid";
    const inputs = overlay.querySelectorAll("input");
    inputs.find((input) => input.type === "text").value = "August newsletter";
    inputs.find((input) => input.type === "date").value = "2026-08-20";
    await submitQuickForm(overlay);
    await nextTicks();
    const mutation = calls.find(({ url }) => url === "/api/cards");
    assert.equal(mutation.options.method, "POST");
    assert.deepEqual(JSON.parse(mutation.options.body), {
      templateId: "template-uuid",
      anchorDate: "2026-08-20",
      title: "August newsletter",
    });
    assert.deepEqual(harness.openedCards, ["card-created"]);
    assert.equal(overlay.removed, true);
  });

  test("reloads quick Card conflicts into a fresh Template list while retaining intent", async () => {
    let cardsSubmitted = 0;
    const harness = createHarness({
      request: async (url, options = {}) => {
        if (url === "/api/templates") {
          return cardsSubmitted
            ? {
                templates: [
                  { id: "template-current", name: "Current newsletter" },
                ],
              }
            : { templates: [{ id: "template-old", name: "Old newsletter" }] };
        }
        if (url === "/api/cards" && options.method === "POST") {
          cardsSubmitted += 1;
          if (cardsSubmitted <= 2) {
            const error = new Error(
              "Template changed while the Card was being created.",
            );
            error.status = 409;
            error.code = "template_version_conflict";
            throw error;
          }
          return { card: { id: "card-created" } };
        }
        throw new Error(`Unexpected request ${url}`);
      },
    });
    await harness.api.openQuickWorkflowForm();
    const firstOverlay = findAllByClass(
      harness.shellBody,
      "quick-form-overlay",
    )[0];
    firstOverlay.querySelector("select").value = "template-old";
    const inputs = firstOverlay.querySelectorAll("input");
    inputs[0].value = "August newsletter";
    inputs[1].value = "2026-08-20";
    await submitQuickForm(firstOverlay);
    await nextTicks();

    const feedback = firstOverlay.querySelector(".form-feedback");
    assert.equal(feedback.dataset.feedbackState, "conflict");
    assert.match(
      feedback.textContent,
      /Template changed since this form was opened/,
    );
    assert.equal(inputs[0].value, "August newsletter");

    await submitQuickForm(firstOverlay);
    await nextTicks();
    assert.equal(
      firstOverlay.querySelectorAll(".quick-form-retry").length,
      1,
      "a repeated Card conflict replaces the previous recovery action",
    );

    await findByText(firstOverlay, "Review latest Templates", "button").click();
    await nextTicks(3);
    assert.equal(firstOverlay.removed, true);
    const secondOverlay = findAllByClass(
      harness.shellBody,
      "quick-form-overlay",
    ).at(-1);
    assert.notEqual(secondOverlay, firstOverlay);
    assert.equal(secondOverlay.querySelector("select").value, "");
    assert.match(secondOverlay.textContent, /Current newsletter/);

    secondOverlay.querySelector("select").value = "template-current";
    const retainedInputs = secondOverlay.querySelectorAll("input");
    assert.equal(retainedInputs[0].value, "August newsletter");
    assert.equal(retainedInputs[1].value, "2026-08-20");
  });
});
