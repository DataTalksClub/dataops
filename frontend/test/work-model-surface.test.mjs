import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { emptyOperationsDocsSnapshot } from "../src/core/operations-model.js";
import { cardsFromWorkPayload } from "../src/core/operations-model.js";
import { taskProofState } from "../src/core/workspace.js";
import { createWorkModel } from "../src/core/work-model.js";
import { nextTicks } from "./support/fake-dom.mjs";

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
  snapshot.todayTasks = snapshot.todayTasks.map(canonicalTask);
  snapshot.overdueTasks = snapshot.overdueTasks.map(canonicalTask);
  snapshot.waitingTasks = snapshot.waitingTasks.map(canonicalTask);
  snapshot.cardTasks = Object.fromEntries(
    Object.entries(snapshot.cardTasks).map(([cardId, tasks]) => [
      cardId,
      tasks.map(canonicalTask),
    ]),
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

// The work model applies the real task predicates, so fixtures have to be
// canonical work tasks rather than permissive stubs.
function canonicalTask(task) {
  return {
    status: "todo",
    taskHistory: [],
    version: 1,
    ...task,
  };
}

// The work model applies the real active-card predicate, so card fixtures have
// to be canonical work cards rather than permissive stubs.
function canonicalCard(card) {
  return {
    openTaskCount: 1,
    stage: "preparation",
    status: "active",
    taskCount: 1,
    version: 1,
    ...card,
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
    dueDate: task.dueDate || task.date || "",
    priority,
    followUpDate: task.followUpDate || "",
    nextAction: task.nextAction || "Open",
    taskId: task.id,
    title: task.title,
  };
}

function createWorkModelHarness(options = {}) {
  const calls = {
    accountRefreshes: [],
    navigations: [],
    openedTasks: [],
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

  const model = createWorkModel({
    activeWorkOwner: () => state.accountIdentity.workOwner,
    activeWorkOwnerId: () => state.accountIdentity.workOwner?.id || "",
    allWorkTasks: (work) => [
      ...work.todayTasks,
      ...work.overdueTasks,
      ...work.waitingTasks,
      ...Object.values(work.cardTasks || {}).flat(),
    ],
    apiUrl: (path) => new URL(path, "http://portal.test"),
    buildOperationsFutureSections: () => [],
    buildOperationsReferenceLinks: () => [],
    compareQualityFindings: (left, right) =>
      String(left.id).localeCompare(String(right.id)),
    currentOperatorIdForTodayScope: (id) => id,
    currentOperatorIdFromPayload: (payload) => payload?.user?.id || "",
    dedupeQualityFindings: (findings) => findings,
    emptyOperationsQualitySnapshot: emptyQualitySnapshot,
    emptyOperationsWorkSnapshot: emptyWorkSnapshot,
    findingMatchesCard: () => false,
    isOperationsWorkspaceVisible: () => options.workspaceVisible !== false,
    isWorkflowTemplateDoc: (doc) => doc.type === "workflow-template",
    normalizeOperationsQualitySnapshot: (snapshot) => ({
      errors: [],
      findings: [],
      loaded: false,
      ok: true,
      summary: { total: 0 },
      validationErrors: [],
      ...(snapshot || {}),
    }),
    normalizeOperationsRecurringSnapshot: (snapshot) => ({
      configs: [],
      enabled: [],
      errors: [],
      loaded: true,
      ...(snapshot || {}),
    }),
    normalizeOperationsWorkSnapshot: normalizeWork,
    normalizeQualityFinding: (finding) => ({
      category: "",
      nextAction: "",
      severity: "info",
      source: "",
      summary: "",
      title: "",
      ...(finding || {}),
    }),
    normalizeTemplateMatchValue: (value) =>
      String(value || "")
        .trim()
        .toLowerCase(),
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
    request,
    resolveDocReference: (id) => docRegistry.get(id) || null,
    settledPayload: (result) =>
      result.status === "fulfilled" ? result.value : {},
    state,
    summarizeWorkflowTemplate: (doc) => ({
      id: doc.id,
      recurring: Boolean(doc.recurring),
      slug: doc.slug || doc.id,
      title: doc.title,
    }),
    taskHasClearProofInstruction: (task) => {
      if (task.requiredLinkName) return true;
      const proof = task.proofRequirement;
      if (proof && typeof proof === "object" && String(proof.label || "").trim())
        return true;
      const validation = task.validation;
      return Boolean(
        validation &&
          typeof validation === "object" &&
          String(validation.requiredEvidence || "").trim(),
      );
    },
    taskNeedsProofInstruction: (task) => {
      if (task.requiredLinkName || task.requiresFile) return true;
      const proof = task.proofRequirement;
      if (proof && typeof proof === "object" && proof.required !== false)
        return true;
      const validation = task.validation;
      return Boolean(
        validation &&
          typeof validation === "object" &&
          (validation.requiredEvidence || validation.requiredCardLinks),
      );
    },
    tasksFromWorkPayload: (payload) => payload?.items || payload?.tasks || [],
    usersFromWorkPayload: (payload) => payload?.items || payload?.users || [],
    workApiUrl: (path, params = {}) => {
      const url = new URL(path, "http://portal.test");
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== "") url.searchParams.set(key, value);
      }
      return url;
    },
    workflowPriority: () => 0,
  });

  return { calls, model, state };
}

describe("work model production behavior", () => {
  test("scopes the work model to the selected teammate while preserving signed-in identity", () => {
    const grace = { id: "grace", name: "Grace" };
    const harness = createWorkModelHarness({
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
    const model = harness.model.buildOperationsWorkModel([], {
      workSnapshot: harness.state.workSnapshot,
    });
    assert.equal(model.scope.actor.name, "Alexey");
    assert.equal(model.scope.owner.name, "Grace");
    assert.equal(model.scope.isPeer, true);
    // Selecting a teammate shows that teammate's own queue: an unassigned task
    // belongs to nobody's work, so it is not attributed to Grace.
    assert.equal(model.stats.todayTasks, 1);
    assert.deepEqual(
      model.lanes.find((lane) => lane.id === "today").items.map((item) => item.taskId),
      ["grace-task"],
    );
  });

  test("turns missing, external-only, and unclear proof instructions into blocking findings", () => {
    const harness = createWorkModelHarness({
      documents: [
        {
          aliases: ["publish-alias"],
          id: "publish-doc",
          path: "process/publish.md",
        },
      ],
    });
    const quality = harness.model.buildProcessQualityModel(
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
              status: "todo",
              taskHistory: [],
              title: "Missing instructions",
              version: 1,
            },
            {
              id: "task-external",
              instructionsUrl: "https://docs.google.com/document/d/example",
              status: "todo",
              taskHistory: [],
              title: "External instructions",
              version: 1,
            },
            {
              id: "task-proof",
              instructionDocId: "publish-doc",
              proofRequirement: { required: true },
              status: "todo",
              taskHistory: [],
              title: "Unclear proof",
              version: 1,
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
    const panelFindings = harness.model.buildTaskProcessQualityFindings(
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
    const harness = createWorkModelHarness({
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
              items: [canonicalCard({ id: "card-1", title: "Card" })],
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
    await harness.model.refreshOperationsWorkSnapshot({ rerender: true });
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
    const harness = createWorkModelHarness({
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
              items: [canonicalCard({ id: "card-1", title: "Card" })],
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

    await harness.model.refreshOperationsWorkSnapshot({ rerender: true });
    assert.equal(harness.state.workSnapshot.cardsComplete, true);

    await harness.model.refreshOperationsWorkSnapshot({ rerender: true });
    const snapshot = harness.state.workSnapshot;
    assert.deepEqual(snapshot.cards.map((card) => card.id), ["card-1"]);
    assert.equal(snapshot.cardsLoaded, true);
    assert.equal(snapshot.cardsComplete, false);
    assert.equal(snapshot.cardTasksComplete, false);
    assert.deepEqual(snapshot.errors, ["Cards service unavailable"]);
  });

  test("refreshes process quality without replacing a healthy snapshot with invented data", async () => {
    let fail = false;
    const harness = createWorkModelHarness({
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
    await harness.model.refreshOperationsQualitySnapshot({ rerender: true });
    assert.equal(harness.state.qualitySnapshot.loaded, true);
    assert.equal(harness.state.qualitySnapshot.findings.length, 1);
    assert.equal(harness.calls.refreshDocuments, 1);

    fail = true;
    await harness.model.refreshOperationsQualitySnapshot({ rerender: true });
    assert.equal(harness.state.qualitySnapshot.loaded, false);
    assert.deepEqual(harness.state.qualitySnapshot.errors, ["Quality service unavailable"]);
    assert.equal(harness.calls.refreshDocuments, 2);
    await nextTicks();
  });
});
