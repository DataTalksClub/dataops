import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { createHomeSurface } from "../src/surfaces/home.js";
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
  const followUps = waiting.filter((task) => task.followUpDate);
  const missingProof = all.filter((task) => task.missingProof);
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
      : task.missingProof
        ? "proof"
        : "today";
  return {
    cardId: task.cardId || "",
    dueDate: task.dueDate || "",
    exception:
      priority === "overdue"
        ? "Overdue"
        : priority === "follow-up"
          ? "Follow-up"
          : priority === "proof"
            ? "Proof missing"
            : "Due today",
    followUpDate: task.followUpDate || "",
    nextAction: task.nextAction || "Open",
    priority,
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
    pageTitles: [],
    quickCards: 0,
    quickTasks: 0,
    refreshDocuments: 0,
    status: [],
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
    buildHomeAttentionItems: (model) =>
      ["overdue", "followups", "today", "missing-proof"]
        .flatMap((id) => model.lanes.find((lane) => lane.id === id)?.items || [])
        .filter(
          (item, index, items) =>
            items.findIndex((candidate) => candidate.taskId === item.taskId) ===
            index,
        ),
    buildOperationsFutureSections: () => [],
    buildOperationsReferenceLinks: () => [],
    cardsFromWorkPayload: (payload) => payload?.items || payload?.cards || [],
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
    formatHomeTaskTiming: (item) =>
      item.priority === "overdue"
        ? "Overdue"
        : item.followUpDate
          ? `Follow up ${item.followUpDate}`
          : `Due ${item.dueDate}`,
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
    renderHonestState: honestState,
    renderOperationsRuntimeState: (runtime) => {
      if (!runtime.errors.length) return null;
      return honestState("Some work is unavailable", runtime.errors.join(" "));
    },
    request,
    resolveCardLabel: (id) => `Card ${id}`,
    resolveDocReference: (id) => docRegistry.get(id) || null,
    setPageTitle: (...args) => calls.pageTitles.push(args),
    setStatus: (message) => calls.status.push(message),
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
    assert.deepEqual(harness.calls.pageTitles, [["Today", "Today"]]);
    assert.match(harness.calls.status.at(-1), /1 today · 1 overdue · 1 waiting/);

    const summary = root.querySelector(".home-status-strip");
    assert.deepEqual(
      summary.children.map((item) => item.querySelector("strong").textContent),
      ["1", "1", "1"],
    );
    const rows = findAllByClass(root, "home-attention-row");
    assert.equal(rows.length, 3);
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

  test("shows unavailable values and an honest empty action queue without false zeroes", () => {
    const harness = createHomeHarness();
    harness.surface.renderOperationsHome([]);
    const root = harness.documentList.children[0];
    assert.equal(root.dataset.operationsWorkLoaded, "false");
    const summary = root.querySelector(".home-status-strip");
    for (const item of summary.children) {
      assert.equal(item.dataset.state, "unavailable");
      assert.equal(item.querySelector("strong").textContent, "—");
    }
    assert.equal(root.textContent.includes("Action queue unavailable"), true);
    assert.equal(
      root.textContent.includes("no false work items are shown"),
      true,
    );
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
            items: [{ id: "card-1", status: "preparation", title: "Card" }],
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
