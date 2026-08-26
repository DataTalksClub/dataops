import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { emptyOperationsDocsSnapshot } from "../src/core/operations-model.js";
import { cardsFromWorkPayload } from "../src/core/operations-model.js";
import {
  buildHomeAttentionItems,
  formatHomeTaskTiming,
  taskProofState,
} from "../src/core/workspace.js";
import { createHomeSurface } from "../src/surfaces/home.js";
import { createOperationsOverview } from "../src/surfaces/operations-overview.js";
import {
  FakeDocument,
  FakeElement,
  findAllByClass,
  findByText,
  nextTicks,
} from "./support/fake-dom.mjs";

const originalDocument = globalThis.document;

afterEach(() => {
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
});

function emptyWorkSnapshot() {
  return {
    activeCards: [],
    cardTasks: {},
    cards: [],
    cardsLoaded: false,
    cardsComplete: false,
    cardTasksComplete: false,
    currentOperatorId: "",
    errors: [],
    loaded: false,
    overdueLoaded: false,
    overdueTasks: [],
    tasks: [],
    todayLoaded: false,
    todayTasks: [],
    users: [],
    usersLoaded: false,
    waitingLoaded: false,
    waitingTasks: [],
  };
}

function emptyQualitySnapshot() {
  return {
    errors: [],
    findings: [],
    loaded: false,
    ok: true,
    summary: { total: 0 },
    validationErrors: [],
  };
}

function normalizeWork(input) {
  const snapshot = { ...emptyWorkSnapshot(), ...(input || {}) };
  snapshot.todayTasks = Array.isArray(snapshot.todayTasks) ? snapshot.todayTasks : [];
  snapshot.overdueTasks = Array.isArray(snapshot.overdueTasks)
    ? snapshot.overdueTasks
    : [];
  snapshot.waitingTasks = Array.isArray(snapshot.waitingTasks)
    ? snapshot.waitingTasks
    : [];
  snapshot.cards = Array.isArray(snapshot.cards) ? snapshot.cards : [];
  snapshot.cardTasks = snapshot.cardTasks || {};
  snapshot.errors = Array.isArray(snapshot.errors) ? snapshot.errors : [];
  snapshot.activeCards = snapshot.cards.filter(
    (card) => card.status !== "done" && card.archived !== true,
  );
  snapshot.tasks = [
    ...snapshot.todayTasks,
    ...snapshot.overdueTasks,
    ...snapshot.waitingTasks,
  ];
  return snapshot;
}

function deriveWork(work, options) {
  const owner = options.selectedOwnerId;
  const belongs = (task) =>
    !owner || !task.assigneeId || String(task.assigneeId) === String(owner);
  const today = work.todayTasks.filter(belongs);
  const overdue = work.overdueTasks.filter(belongs);
  const waiting = work.waitingTasks.filter(belongs);
  const all = [...today, ...overdue, ...waiting];
  const knownTasks = [...all, ...Object.values(work.cardTasks || {}).flat()];
  const followUps = waiting.filter((task) => task.followUpDate);
  const missingProof = knownTasks.filter(
    (task) => task.status !== "done" && !taskProofState(task).ok,
  );
  return {
    counts: {
      followUps: followUps.length,
      missingProof: missingProof.length,
      overdue: overdue.length,
      today: today.length,
      waiting: waiting.length,
    },
    tasks: { followUps, missingProof, overdue, today, waiting },
  };
}

function operationItem(task, options = {}) {
  const priority = options.overdue
    ? "overdue"
    : options.followUp
      ? "follow-up"
        : !taskProofState(task).ok
          ? "missing-proof"
          : "today";
  return {
    cardId: task.cardId || "",
    dueDate: task.dueDate || "",
    priority,
    followUpDate: task.followUpDate || "",
    nextAction: task.nextAction || "Open",
    taskId: task.id,
    title: task.title,
  };
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

function createHomeHarness(options = {}) {
  const documentList = new FakeElement("main");
  documentList.id = "document-list";
  const libraryTitle = new FakeElement("h1");
  const clearSelectionButton = new FakeElement("button");
  const body = new FakeElement("body");
  const document = new FakeDocument(
    body,
    documentList,
    libraryTitle,
    clearSelectionButton,
  );
  document.body = body;
  globalThis.document = document;

  const calls = {
    accountRefreshes: [],
    navigations: [],
    openedTasks: [],
    routeTitles: [],
    quickCards: 0,
    quickTasks: 0,
    refreshDocuments: 0,
    workBell: 0,
  };
  const users = options.users || [
    { email: "alexey@example.invalid", id: "alexey", name: "Alexey" },
    { email: "grace@example.invalid", id: "grace", name: "Grace" },
  ];
  const state = {
    accountIdentity: options.accountIdentity || {
      user: users[0],
      workOwner: options.owner || users[0],
    },
    docsSnapshot: options.docsSnapshot || emptyOperationsDocsSnapshot(),
    qualitySnapshot: options.qualitySnapshot || emptyQualitySnapshot(),
    recurringSnapshot: options.recurringSnapshot || {
      configs: [],
      enabled: [],
      errors: [],
      loaded: true,
    },
    workSnapshot: normalizeWork(options.workSnapshot),
  };
  const docRegistry = new Map(
    (options.documents || []).map((doc) => [doc.id, doc]),
  );
  const request = async (url) => {
    if (options.request) return options.request(url);
    return {};
  };

  const surface = createHomeSurface({
    activeWorkOwner: () => state.accountIdentity.workOwner,
    activeWorkOwnerId: () => state.accountIdentity.workOwner?.id || "",
    apiUrl: (path) => new URL(path, "http://portal.test"),
    addDaysIso: (date, offset) => {
      const value = new Date(`${date}T00:00:00Z`);
      value.setUTCDate(value.getUTCDate() + offset);
      return value.toISOString().slice(0, 10);
    },
    allWorkTasks: (work) => [
      ...work.todayTasks,
      ...work.overdueTasks,
      ...work.waitingTasks,
      ...Object.values(work.cardTasks || {}).flat(),
    ],
    buildHomeAttentionItems,
    buildOperationsFutureSections: () => [],
    buildOperationsReferenceLinks: () => [],
    cardsFromWorkPayload,
    clearSelectionButton,
    currentOperatorIdForTodayScope: (id) => id,
    currentOperatorIdFromPayload: (payload) => payload?.user?.id || "",
    dedupeOperationItems: (items) =>
      items.filter(
        (item, index) =>
          items.findIndex((candidate) => candidate.taskId === item.taskId) ===
          index,
      ),
    deriveHomeWorkState: deriveWork,
    documentList,
    emptyOperationsQualitySnapshot: emptyQualitySnapshot,
    emptyOperationsWorkSnapshot: emptyWorkSnapshot,
    formatHomeCalendarDate: (date) => `Thursday, ${date}`,
    formatHomeTaskTiming,
    getActiveWorkspaceRouteToken: () => 1,
    isActiveWorkCard: (card) => card.status !== "done",
    isOpenWorkTask: (task) => task.status !== "done",
    isOperationsHomeVisible: () => options.homeVisible !== false,
    isWorkflowTemplateDoc: (doc) => doc.type === "workflow-template",
    isWorkspaceRouteFresh: () => true,
    libraryTitle,
    listDraftPaths: () => [],
    navigateCanonicalWorkspace: (path) => {
      calls.navigations.push(path);
      return { ready: Promise.resolve() };
    },
    normalizeOperationsRecurringSnapshot: (snapshot) => ({
      configs: [],
      enabled: [],
      errors: [],
      loaded: true,
      ...(snapshot || {}),
    }),
    normalizeOperationsWorkSnapshot: normalizeWork,
    normalizeTemplateMatchValue: (value) =>
      String(value || "")
        .trim()
        .toLowerCase(),
    openQuickTaskForm: () => {
      calls.quickTasks += 1;
    },
    openQuickWorkflowForm: () => {
      calls.quickCards += 1;
    },
    openTaskPanel: (id) => calls.openedTasks.push(id),
    operationItemFromCard: (card) => ({
      cardId: card.id,
      priority: "card",
      title: card.title,
    }),
    operationItemFromTask: operationItem,
    operationItemFromTemplate: (template) => ({
      priority: "template",
      templateId: template.id,
      title: template.title,
    }),
    readLocalPreviewContext: async () => options.localContext || null,
    refreshAccountIdentity: async (...args) => calls.accountRefreshes.push(args),
    refreshDocuments: () => {
      calls.refreshDocuments += 1;
    },
    refreshWorkBell: () => {
      calls.workBell += 1;
    },
    // The production docs-availability renderer, so Home is checked against the
    // shared component instead of a test double.
    renderDocsAvailabilityState: createOperationsOverview({ document })
      .renderDocsAvailabilityState,
    renderHonestState: honestState,
    renderOperationsRuntimeState: (runtime) => {
      if (!runtime.errors.length) return null;
      return honestState("Some work is unavailable", runtime.errors.join(" "));
    },
    request,
    resolveCardLabel: (id) => `Card ${id}`,
    resolveDocReference: (id) => docRegistry.get(id) || null,
    setRouteTitle: (title) => calls.routeTitles.push(title),
    settledPayload: (result) =>
      result.status === "fulfilled" ? result.value : {},
    state,
    summarizeWorkflowTemplate: (doc) => ({
      id: doc.id,
      recurring: Boolean(doc.recurring),
      slug: doc.slug || doc.id,
      title: doc.title,
    }),
    tasksFromWorkPayload: (payload) => payload?.items || payload?.tasks || [],
    todayIsoDate: () => "2026-08-13",
    usersFromWorkPayload: (payload) => payload?.items || payload?.users || [],
    workApiUrl: (path, params = {}) => {
      const url = new URL(path, "http://portal.test");
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== "") url.searchParams.set(key, value);
      }
      return url;
    },
    workCardTitle: (card) => card.title || card.id,
    workTaskTitle: (task) => task.title || task.id,
    workflowPriority: () => 0,
  });

  return {
    calls,
    clearSelectionButton,
    document,
    documentList,
    libraryTitle,
    state,
    surface,
  };
}

describe("Home surface production behavior", () => {
  test("renders hydrated daily status, attention actions, and canonical quick actions", async () => {
    const harness = createHomeHarness({
      workSnapshot: {
        cards: [{ id: "card-1", status: "preparation", title: "Podcast" }],
        cardsLoaded: true,
        cardsComplete: true,
        cardTasksComplete: true,
        currentOperatorId: "alexey",
        loaded: true,
        overdueLoaded: true,
        overdueTasks: [
          {
            cardId: "card-1",
            dueDate: "2026-08-12",
            id: "task-overdue",
            nextAction: "Open",
            title: "Review preparation",
          },
        ],
        todayLoaded: true,
        todayTasks: [
          {
            dueDate: "2026-08-13",
            id: "task-today",
            nextAction: "Add approval note",
            title: "Approve draft",
          },
        ],
        usersLoaded: true,
        waitingLoaded: true,
        waitingTasks: [
          {
            followUpDate: "2026-08-13",
            id: "task-followup",
            title: "Check response",
          },
        ],
      },
    });
    harness.surface.renderOperationsHome([]);
    const root = harness.documentList.children[0];
    assert.equal(root.dataset.operationsWorkLoaded, "true");
    assert.equal(harness.libraryTitle.textContent, "Home");
    assert.deepEqual(harness.calls.routeTitles, ["Today"]);
    const summaryLine = root.querySelector(".surface-summary");
    assert.equal(summaryLine.dataset.summaryState, "ready");
    assert.match(
      summaryLine.textContent,
      /1 task due today · 1 task overdue · 1 task waiting · 1 active card\./,
    );
    assert.equal(summaryLine.querySelector(".surface-summary-retry"), null);

    const summary = root.querySelector(".home-status-strip");
    assert.deepEqual(
      findAllByClass(summary, "home-status-item").map(
        (item) => item.querySelector("strong").textContent,
      ),
      ["1", "1", "1"],
    );
    const rows = findAllByClass(root, "home-attention-row");
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((row) => row.querySelector(".home-task-state time").textContent),
      ["Due yesterday", "Follow up today", "Due today"],
    );
    assert.equal(root.querySelectorAll(".home-exception").length, 0);
    assert.equal(rows[0].textContent.includes("Review preparation"), true);
    const addProof = rows.find((row) => row.textContent.includes("Approve draft"));
    assert.equal(findByText(addProof, "Add proof", "button").textContent, "Add proof");
    await findByText(rows[0], "Open", "button").click();
    assert.deepEqual(harness.calls.openedTasks, ["task-overdue"]);

    const quickActions = root.querySelectorAll(".home-quick-action");
    await quickActions[0].click();
    await quickActions[1].click();
    assert.equal(harness.calls.quickTasks, 1);
    assert.equal(harness.calls.quickCards, 1);
    await findByText(root, "View all tasks", "button").click();
    assert.deepEqual(harness.calls.navigations, ["/tasks"]);
  });

  test("renders attention urgency with retained cues and no hidden badges", async () => {
    const harness = createHomeHarness({
      workSnapshot: {
        cards: [{ id: "card-proof", status: "preparation", title: "Proof workflow" }],
        cardsLoaded: true,
        cardsComplete: true,
        cardTasksComplete: true,
        cardTasks: {
          "card-proof": [{
            date: "2026-08-14",
            id: "task-proof",
            nextAction: "Add Evidence URL",
            requiredLinkName: "Evidence URL",
            title: "Collect evidence",
          }],
        },
        currentOperatorId: "alexey",
        loaded: true,
        overdueLoaded: true,
        overdueTasks: [
          {
            dueDate: "2026-08-12",
            id: "task-overdue",
            nextAction: "Mark done",
            title: "Overdue work",
          },
        ],
        todayLoaded: true,
        todayTasks: [
          {
            dueDate: "2026-08-13",
            id: "task-today",
            nextAction: "Mark done",
            title: "Today work",
          },
        ],
        usersLoaded: true,
        waitingLoaded: true,
        waitingTasks: [
          {
            followUpDate: "2026-08-11",
            id: "task-follow-up",
            nextAction: "Follow up",
            title: "Follow-up work",
          },
        ],
      },
    });

    harness.surface.renderOperationsHome([]);
    const root = harness.documentList.children[0];
    const rows = findAllByClass(root, "home-attention-row");
    const expected = [
      {
        action: "Open",
        className: "home-attention-overdue",
        date: "2026-08-12",
        taskId: "task-overdue",
        text: "Due yesterday",
        title: "Overdue work",
      },
      {
        action: "Follow up",
        className: "home-attention-follow-up",
        date: "2026-08-11",
        taskId: "task-follow-up",
        text: "Follow-up 2 days overdue",
        title: "Follow-up work",
      },
      {
        action: "Open",
        className: "home-attention-today",
        date: "2026-08-13",
        taskId: "task-today",
        text: "Due today",
        title: "Today work",
      },
      {
        action: "Add proof",
        className: "home-attention-missing-proof",
        date: "",
        taskId: "task-proof",
        text: "Proof required",
        title: "Collect evidence",
      },
    ];

    assert.equal(rows.length, expected.length);
    for (const [index, item] of expected.entries()) {
      const row = rows[index];
      assert.match(row.className, new RegExp(`\\b${item.className}\\b`));
      assert.equal(row.querySelector("strong").textContent, item.title);
      const timing = row.querySelector(".home-task-state time");
      assert.equal(timing.textContent, item.text);
      assert.equal(timing.dateTime || "", item.date);
      const marker = row.querySelector(".home-task-marker");
      assert.equal(marker.getAttribute("aria-hidden"), "true");
      const button = findByText(row, item.action, "button");
      assert.equal(button.getAttribute("aria-label"), `${item.action}: ${item.title}`);
      await button.click();
    }
    assert.deepEqual(harness.calls.openedTasks, expected.map((item) => item.taskId));
    assert.equal(root.querySelectorAll(".home-exception").length, 0);
    assert.equal(
      root.querySelectorAll("[class*='home-exception']").length,
      0,
    );
  });

  test("shows unavailable values and an honest empty action queue without false zeroes", () => {
    const harness = createHomeHarness();
    harness.surface.renderOperationsHome([]);
    const root = harness.documentList.children[0];
    assert.equal(root.dataset.operationsWorkLoaded, "false");
    const summary = root.querySelector(".home-status-strip");
    for (const item of findAllByClass(summary, "home-status-item")) {
      assert.equal(item.dataset.state, "unavailable");
      assert.equal(item.querySelector("strong").textContent, "—");
    }
    assert.equal(root.textContent.includes("Action queue unavailable"), true);
    assert.equal(
      root.textContent.includes("no false work items are shown"),
      true,
    );
  });

  test("distinguishes loading, unavailable, partial, and empty work in Home's own summary", async () => {
    const loading = createHomeHarness();
    loading.surface.renderOperationsHome([]);
    const loadingSummary =
      loading.documentList.children[0].querySelector(".surface-summary");
    assert.equal(loadingSummary.dataset.summaryState, "loading");
    assert.equal(loadingSummary.dataset.summaryId, "home");
    assert.equal(
      loadingSummary.querySelector(".surface-summary-line").getAttribute("role"),
      "status",
    );
    assert.match(loadingSummary.textContent, /Loading today's tasks and cards/);
    assert.equal(loadingSummary.querySelector(".surface-summary-retry"), null);

    const requests = [];
    const unavailable = createHomeHarness({
      request: async (url) => {
        requests.push(String(url));
        return {};
      },
      workSnapshot: { errors: ["Work API unreachable"] },
    });
    unavailable.surface.renderOperationsHome([]);
    const outage =
      unavailable.documentList.children[0].querySelector(".surface-summary");
    assert.equal(outage.dataset.summaryState, "unavailable");
    assert.equal(
      outage.querySelector(".surface-summary-line").getAttribute("role"),
      "alert",
    );
    assert.match(outage.textContent, /could not be loaded, so no counts are shown/);
    assert.equal(
      outage.querySelector(".surface-summary-detail").textContent,
      "Work API unreachable",
    );
    const retry = outage.querySelector(".surface-summary-retry");
    assert.equal(retry.textContent, "Retry loading work");
    await retry.click();
    await nextTicks();
    assert.equal(
      requests.some((url) => url.includes("/api/tasks")),
      true,
      "retry re-fetches the work snapshot from the summary that owns it",
    );

    const partial = createHomeHarness({
      workSnapshot: {
        errors: ["Waiting source unavailable"],
        loaded: true,
        overdueLoaded: true,
        todayLoaded: true,
        todayTasks: [{ dueDate: "2026-08-13", id: "task-today", title: "Approve" }],
      },
    });
    partial.surface.renderOperationsHome([]);
    const partialSummary =
      partial.documentList.children[0].querySelector(".surface-summary");
    assert.equal(partialSummary.dataset.summaryState, "partial");
    assert.match(partialSummary.textContent, /1 task due today/);
    assert.match(
      partialSummary.textContent,
      /waiting unknown/,
      "a lane that did not load has no count, not a zero",
    );
    assert.match(partialSummary.textContent, /Some work sources are unavailable/);
    assert.ok(partialSummary.querySelector(".surface-summary-retry"));

    const empty = createHomeHarness({
      workSnapshot: {
        cardsLoaded: true,
        cardsComplete: true,
        cardTasksComplete: true,
        loaded: true,
        overdueLoaded: true,
        todayLoaded: true,
        waitingLoaded: true,
      },
    });
    empty.surface.renderOperationsHome([]);
    const emptySummary =
      empty.documentList.children[0].querySelector(".surface-summary");
    assert.equal(emptySummary.dataset.summaryState, "empty");
    assert.equal(
      emptySummary.querySelector(".surface-summary-state").textContent,
      "Empty",
    );
    assert.match(emptySummary.textContent, /Nothing is overdue, due today, or waiting/);
    assert.equal(emptySummary.querySelector(".surface-summary-retry"), null);
  });

  test("reports a docs outage on Home without hiding work or inventing a docs banner", () => {
    const loading = createHomeHarness();
    loading.surface.renderOperationsHome([]);
    assert.equal(
      loading.documentList.children[0].querySelector("[data-docs-state]"),
      null,
    );

    const emptyCorpus = createHomeHarness({
      docsSnapshot: { state: "loaded", documentCount: 0, error: "", status: 0 },
    });
    emptyCorpus.surface.renderOperationsHome([]);
    assert.equal(
      emptyCorpus.documentList.children[0].querySelector("[data-docs-state]"),
      null,
    );

    const outage = createHomeHarness({
      docsSnapshot: {
        state: "unavailable",
        documentCount: 0,
        error: "Docs content root is unavailable: /missing/content",
        status: 503,
      },
    });
    outage.surface.renderOperationsHome([]);
    const root = outage.documentList.children[0];
    const banners = findAllByClass(root, "ops-docs-state");
    assert.equal(banners.length, 1);
    assert.equal(banners[0].dataset.docsState, "unavailable");
    assert.equal(
      banners[0].children[0].textContent,
      "Process documents are unavailable",
    );
    assert.equal(
      banners[0].children[1].textContent,
      "Docs content root is unavailable: /missing/content",
    );
    // Work content still renders next to the docs banner.
    assert.equal(root.querySelector(".home-status-strip") !== null, true);
    assert.equal(root.textContent.includes("Needs your attention"), true);
  });

  test("scopes the Home model to the selected teammate while preserving signed-in identity", () => {
    const grace = { id: "grace", name: "Grace" };
    const harness = createHomeHarness({
      accountIdentity: {
        user: { id: "alexey", name: "Alexey" },
        workOwner: grace,
      },
      owner: grace,
      workSnapshot: {
        currentOperatorId: "alexey",
        loaded: true,
        cardsComplete: true,
        cardTasksComplete: true,
        overdueLoaded: true,
        overdueTasks: [],
        todayLoaded: true,
        todayTasks: [
          { assigneeId: "alexey", id: "alexey-task", title: "Alexey work" },
          { assigneeId: "grace", id: "grace-task", title: "Grace work" },
          { id: "shared-task", title: "Unassigned work" },
        ],
        usersLoaded: true,
        waitingLoaded: true,
        waitingTasks: [],
      },
    });
    const model = harness.surface.buildOperationsHomeModel([], {
      workSnapshot: harness.state.workSnapshot,
    });
    assert.equal(model.scope.actor.name, "Alexey");
    assert.equal(model.scope.owner.name, "Grace");
    assert.equal(model.scope.isPeer, true);
    assert.equal(model.stats.todayTasks, 2);
    assert.deepEqual(
      model.lanes.find((lane) => lane.id === "today").items.map((item) => item.taskId),
      ["grace-task", "shared-task"],
    );
  });

  test("turns missing, external-only, and unclear proof instructions into blocking findings", () => {
    const harness = createHomeHarness({
      documents: [
        {
          aliases: ["publish-alias"],
          id: "publish-doc",
          path: "process/publish.md",
        },
      ],
    });
    const quality = harness.surface.buildProcessQualityModel(
      {
        findings: [
          {
            category: "doc-warning",
            docId: "publish-doc",
            id: "finding-doc",
            severity: "warning",
            summary: "Clarify validation.",
            title: "Document needs review",
          },
        ],
        loaded: true,
        ok: false,
      },
      normalizeWork({
        cardTasks: {
          "card-1": [
            {
              cardId: "card-1",
              id: "task-missing",
              instructionDocId: "missing-doc",
              status: "open",
              title: "Missing instructions",
            },
            {
              id: "task-external",
              instructionsUrl: "https://docs.google.com/document/d/example",
              status: "open",
              title: "External instructions",
            },
            {
              id: "task-proof",
              instructionDocId: "publish-doc",
              proofRequirement: { required: true },
              status: "open",
              title: "Unclear proof",
            },
          ],
        },
        loaded: true,
      }),
    );
    assert.equal(quality.activeBlockingCount, 4);
    assert.deepEqual(
      quality.activeFindings.map((finding) => finding.category).sort(),
      [
        "broken-doc-reference",
        "doc-warning",
        "legacy-external-only-doc",
        "missing-proof-instructions",
      ],
    );
    const panelFindings = harness.surface.buildTaskProcessQualityFindings(
      {
        id: "task-panel",
        instructionDocId: "publish-doc",
        title: "Panel task",
      },
      {
        findings: [
          {
            docPath: "process/publish.md",
            id: "panel-warning",
            severity: "info",
            title: "Panel warning",
          },
        ],
      },
    );
    assert.equal(panelFindings[0].severity, "blocking");
    assert.equal(panelFindings[0].taskId, "task-panel");
  });

  test("refreshes partial work sources honestly and keeps successful lanes available", async () => {
    const requests = [];
    const harness = createHomeHarness({
      request: async (url) => {
        requests.push(String(url));
        const value = new URL(url);
        if (value.pathname === "/api/me") {
          return { user: { id: "alexey" } };
        }
        if (value.pathname === "/api/users") {
          return { items: [{ id: "alexey", name: "Alexey" }] };
        }
        if (value.pathname === "/api/cards") {
          return {
            cards: {
              items: [{ id: "card-1", status: "preparation", title: "Card" }],
            },
          };
        }
        if (value.pathname === "/api/tasks" && value.searchParams.has("cardId")) {
          return { items: [{ cardId: "card-1", id: "card-task" }] };
        }
        if (value.pathname === "/api/tasks" && value.searchParams.get("status") === "waiting") {
          throw new Error("Waiting source unavailable");
        }
        if (value.pathname === "/api/tasks") {
          return { items: [{ id: value.searchParams.has("date") ? "today" : "overdue" }] };
        }
        return {};
      },
      workSnapshot: {},
    });
    await harness.surface.refreshOperationsWorkSnapshot({ rerender: true });
    assert.equal(harness.state.workSnapshot.loaded, true);
    assert.equal(harness.state.workSnapshot.todayLoaded, true);
    assert.equal(harness.state.workSnapshot.waitingLoaded, false);
    assert.deepEqual(harness.state.workSnapshot.todayTasks.map((task) => task.id), ["today"]);
    assert.equal(harness.state.workSnapshot.cardsComplete, true);
    assert.equal(harness.state.workSnapshot.cardTasksComplete, true);
    assert.deepEqual(
      harness.state.workSnapshot.cardTasks["card-1"].map((task) => task.id),
      ["card-task"],
    );
    assert.deepEqual(harness.state.workSnapshot.errors, ["Waiting source unavailable"]);
    assert.equal(harness.calls.accountRefreshes.length, 1);
    assert.equal(harness.calls.refreshDocuments, 1);
    assert.equal(harness.calls.workBell, 1);
    assert.equal(requests.some((url) => url.includes("cardId=card-1")), true);
  });

  test("keeps retained Cards visible without treating them as current when a reload fails", async () => {
    let cardsRequests = 0;
    const harness = createHomeHarness({
      request: async (url) => {
        const value = new URL(url);
        if (value.pathname === "/api/me") {
          return { user: { id: "alexey" } };
        }
        if (value.pathname === "/api/users") {
          return { items: [{ id: "alexey", name: "Alexey" }] };
        }
        if (value.pathname === "/api/cards") {
          cardsRequests += 1;
          if (cardsRequests === 2) throw new Error("Cards service unavailable");
          return {
            cards: {
              items: [{ id: "card-1", status: "preparation", title: "Card" }],
            },
          };
        }
        if (value.pathname === "/api/tasks" && value.searchParams.has("cardId")) {
          return { items: [{ cardId: "card-1", id: "card-task" }] };
        }
        if (value.pathname === "/api/tasks") {
          return { items: [] };
        }
        return {};
      },
      workSnapshot: {},
    });

    await harness.surface.refreshOperationsWorkSnapshot({ rerender: true });
    assert.equal(harness.state.workSnapshot.cardsComplete, true);

    await harness.surface.refreshOperationsWorkSnapshot({ rerender: true });
    const snapshot = harness.state.workSnapshot;
    assert.deepEqual(snapshot.cards.map((card) => card.id), ["card-1"]);
    assert.equal(snapshot.cardsLoaded, true);
    assert.equal(snapshot.cardsComplete, false);
    assert.equal(snapshot.cardTasksComplete, false);
    assert.deepEqual(snapshot.errors, ["Cards service unavailable"]);
  });

  test("refreshes process quality without replacing a healthy Home with invented data", async () => {
    let fail = false;
    const harness = createHomeHarness({
      request: async (url) => {
        assert.equal(new URL(url).pathname, "/docs/process-quality");
        if (fail) throw new Error("Quality service unavailable");
        return {
          findings: [{ id: "finding-1", severity: "info", title: "Review" }],
          ok: true,
          summary: { total: 1 },
        };
      },
    });
    await harness.surface.refreshOperationsQualitySnapshot({ rerender: true });
    assert.equal(harness.state.qualitySnapshot.loaded, true);
    assert.equal(harness.state.qualitySnapshot.findings.length, 1);
    assert.equal(harness.calls.refreshDocuments, 1);

    fail = true;
    await harness.surface.refreshOperationsQualitySnapshot({ rerender: true });
    assert.equal(harness.state.qualitySnapshot.loaded, false);
    assert.deepEqual(harness.state.qualitySnapshot.errors, ["Quality service unavailable"]);
    assert.equal(harness.calls.refreshDocuments, 2);
    await nextTicks();
  });
});
