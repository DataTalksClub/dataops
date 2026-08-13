import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import {
  cardAnchorTone,
  cardsHeaderViewModel,
  compareIsoDate,
  describeRecurringRun,
  formatCardAnchorLabel,
  formatTaskDateMeta,
  groupCardItemsByMonth,
  groupCardItemsByStage,
  isArchivedWorkCard,
  isFollowUpDueTask,
  isOpenWorkTask,
  isTaskDueToday,
  isTaskOverdue,
  isWaitingOrFollowUpTask,
  summarizeCardProgress,
  taskDate,
  taskProofState,
  tasksFromWorkPayload,
  tasksSectionTitle,
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

const originalDocument = globalThis.document;
const canonicalTask = (task) => ({ version: 1, taskHistory: [], status: "todo", ...task });

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

function baseModel(overrides = {}) {
  return {
    stats: {
      followUpTasks: 0,
      missingProofTasks: 0,
      activeCards: 0,
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
  const libraryTitle = new FakeElement("h1");
  const clearSelectionButton = new FakeElement("button");
  const document = new FakeDocument(documentList, shellBody, libraryTitle);
  globalThis.document = document;

  const requests = [];
  const navigations = [];
  const errors = [];
  const openedTasks = [];
  const openedCards = [];
  const entityStates = [];
  const status = [];
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
    if (options.refreshRecurring) await options.refreshRecurring();
    if (rerender && api) api.renderTasksSurface([], "recurring");
  };
  api = createTasksSurface({
    addBeforeUnloadListener() {},
    allWorkTasks: (snapshot) => snapshot.tasks || [],
    buildOperationsHomeModel: () => model,
    cardsHeaderViewModel,
    clearSelectionButton,
    compareIsoDate,
    confirmDialog: options.confirmDialog || (async () => true),
    countLabel,
    debounce: (callback) => callback,
    describeRecurringRun,
    documentList,
    escapeHtml,
    formatTaskDateMeta,
    getActiveTasksSection: () => "templates",
    getActiveWorkspaceRoute: () => route,
    getActiveWorkspaceRouteToken: () => 1,
    getAllDocuments: () => [],
    getPendingLegacyRoute: () => null,
    getTaskRouteContext: () => taskRouteContext,
    getWorkspaceEntityState: () => entityStates.at(-1) || null,
    groupCardItemsByMonth,
    groupCardItemsByStage,
    isArchivedWorkCard,
    isFollowUpDueTask,
    isOpenWorkTask,
    isOperationsHomeVisible: () => true,
    isTaskDueToday,
    isTaskOverdue,
    isWaitingOrFollowUpTask,
    isWorkspaceRouteFresh: () => true,
    libraryTitle,
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
        title: card.title,
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
    refreshDocuments: async () => {},
    refreshOperationsRecurringSnapshot: refreshRecurring,
    refreshOperationsWorkSnapshot: async (refreshOptions = {}) => {
      if (options.refreshWork) await options.refreshWork(refreshOptions);
    },
    renderArtifactsSurface: () => honestState("Artifacts", "Artifacts index"),
    renderAssistantsSurface: () => honestState("Assistants", "Assistant jobs"),
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
    reportError: (message) => errors.push(message),
    request: async (url, requestOptions = {}) => {
      requests.push({ url, options: requestOptions });
      return options.request ? options.request(url, requestOptions) : {};
    },
    resolveAssigneeLabel: (id) => id,
    scheduleAnimationFrame: (callback) => callback(),
    setPageTitle() {},
    setStatus: (message) => status.push(message),
    setWorkspaceEntityState: (entity) => entityStates.push(entity),
    shellBody,
    showErrorToast: (message) => errors.push(message),
    sortWorkTasks: (tasks) => tasks,
    state,
    surfaceDescription: (section) => `${section} surface`,
    summarizeCardProgress,
    taskDate,
    taskNextActionLabel: () => "Continue work",
    taskProofState,
    taskSourceLabel: () => "DataOps",
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
    errors,
    navigations,
    openedCards,
    openedTasks,
    requests,
    shellBody,
    status,
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

function groupByHeading(root, heading) {
  return findAllByClass(root, "ops-queue-group").find((group) =>
    findByText(group, heading, "h3"),
  );
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

  test("renders Queue lanes honestly and keeps route-context recovery actions canonical", async () => {
    const tasks = [
      canonicalTask({ id: "overdue", description: "Overdue", date: "2026-08-11" }),
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
      canonicalTask({ id: "done", description: "Done", status: "done", date: "2026-08-12" }),
    ];
    const { api, documentList, navigations } = createHarness({
      workSnapshot: { tasks },
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

    assert.equal(findAllByClass(documentList, "ops-queue-group").length, 6);
    assert.equal(
      findByText(groupByHeading(documentList, "Overdue"), "1", "span")
        .textContent,
      "1",
    );
    assert.equal(
      findByText(groupByHeading(documentList, "Follow-ups due"), "1", "span")
        .textContent,
      "1",
    );
    assert.equal(
      findByText(groupByHeading(documentList, "Waiting"), "1", "span")
        .textContent,
      "1",
    );
    assert.equal(
      findByText(groupByHeading(documentList, "Today"), "1", "span")
        .textContent,
      "1",
    );
    assert.equal(
      findByText(groupByHeading(documentList, "Done / history"), "1", "span")
        .textContent,
      "1",
    );
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

  test("renders the active Cards board as exactly three columns and keeps Done in Archive", () => {
    const active = [
      { id: "prep", version: 1, title: "Prepare", stage: "preparation", status: "active", taskCount: 0, openTaskCount: 0 },
      { id: "announced", version: 1, title: "Announce", stage: "announced", status: "active", taskCount: 0, openTaskCount: 0 },
      { id: "after-event", version: 1, title: "Follow up", stage: "after-event", status: "active", taskCount: 0, openTaskCount: 0 },
    ];
    const archived = { id: "done", version: 2, title: "Completed", stage: "done", status: "archived", taskCount: 1, openTaskCount: 0, completedAt: "2026-08-05T12:00:00.000Z", completedBy: "operator", activeStageBeforeCompletion: "after-event" };
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
      { id: "old", version: 2, title: "July card", status: "archived", stage: "done", taskCount: 1, openTaskCount: 0, completedAt: "2026-07-04T12:00:00.000Z", completedBy: "operator", activeStageBeforeCompletion: "preparation" },
      { id: "recent", version: 2, title: "August card", status: "archived", stage: "done", taskCount: 1, openTaskCount: 0, completedAt: "2026-08-02T12:00:00.000Z", completedBy: "operator", activeStageBeforeCompletion: "announced" },
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

  test("shows the anchor date on each card and orders columns by anchor", () => {
    const active = [
      { id: "late", title: "Late", stage: "preparation", anchorDate: "2026-09-01" },
      { id: "undated", title: "Undated", stage: "preparation" },
      { id: "soon", title: "Soon", stage: "preparation", anchorDate: "2026-08-13" },
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
      { id: "risky", title: "Risky", stage: "preparation", anchorDate: "2026-08-10" },
    ];
    const { api, documentList } = createHarness({
      route: { path: "/cards", params: new URLSearchParams() },
      workSnapshot: {
        activeCards: active,
        cards: active,
        cardTasks: {
          risky: [
            canonicalTask({ id: "a", description: "Done", status: "done", date: "2026-08-01" }),
            canonicalTask({ id: "b", description: "Late", date: "2026-08-05", requiresFile: true }),
            canonicalTask({ id: "c", description: "Waiting", status: "waiting", waitingFor: "reply" }),
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
        ["workflow-card-flag is-info", "1 waiting"],
        ["workflow-card-flag is-warning", "1 missing proof"],
      ],
    );
    assert.equal(
      card.title,
      "1/3 tasks - 1 overdue - 1 waiting - 1 missing file - 1 missing proof",
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

  test("renders Git-authored Template projections read-only for every role", async () => {
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

    assert.match(harness.documentList.textContent, /Git-authored templates/);
    assert.match(harness.documentList.textContent, /private knowledge repository/);
    assert.match(harness.documentList.textContent, /workflow-templates\/newsletter.yaml/);
    assert.match(harness.documentList.textContent, /1234567890ab/);
    assert.ok(findByText(harness.documentList, "Create card", "button"));
    for (const mutation of ["New runtime template", "Save template", "Delete template"]) {
      assert.equal(findByText(harness.documentList, mutation, "button"), undefined);
    }
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
      { id: "card-august", title: "August", templateId: template.id, status: "active" },
      { id: "card-september", title: "September", templateId: template.id, status: "active" },
      { id: "card-current", title: "October", templateId: template.id, status: "active" },
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
      "Review 3 Cards for updates",
      "button",
    ).dispatch("click");
    assert.equal(previewCalls, 1);
    assert.deepEqual(
      JSON.parse(calls.find(({ url }) => url.endsWith("/preview")).options.body),
      { cardIds: ["card-august", "card-september", "card-current"] },
    );
    assert.match(harness.documentList.textContent, /Nothing is selected automatically/);
    assert.equal(
      findByText(harness.documentList, "Apply 0 selected Cards", "button").disabled,
      true,
    );
    const cardCheckbox = (label) => harness.documentList
      .querySelectorAll("input")
      .find((input) => input.getAttribute("aria-label") === `Select ${label}`);
    assert.equal(
      cardCheckbox("October").disabled,
      true,
    );

    let checkbox = cardCheckbox("August");
    checkbox.checked = true;
    await checkbox.dispatch("change");
    checkbox = cardCheckbox("September");
    checkbox.checked = true;
    await checkbox.dispatch("change");
    const apply = findByText(
      harness.documentList,
      "Apply 2 selected Cards",
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
      /1 Card applied · 1 conflict needs a fresh preview/,
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
      {
        id: "recurring-1",
        description: "Weekly newsletter",
        cronExpression: "0 9 * * 1",
        enabled: true,
      },
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
    assert.match(harness.documentList.textContent, /Active1/);
    assert.match(harness.documentList.textContent, /Paused0/);
    assert.match(harness.documentList.textContent, /Every Monday at 09:00/);
    assert.match(harness.documentList.textContent, /Next /);

    await findByText(harness.documentList, "Pause", "button").dispatch("click");
    assert.deepEqual(JSON.parse(calls.at(-1).options.body), { enabled: false });

    await findByText(harness.documentList, "Delete", "button").dispatch("click");
    await nextTicks();
    assert.equal(calls.at(-1).options.method, "DELETE");
    assert.match(
      harness.documentList.textContent,
      /cannot be deleted\. Pause it instead; generated tasks and notifications are preserved/,
    );

    harness.setModel(baseModel());
    harness.api.renderTasksSurface([], "recurring");
    assert.match(harness.documentList.textContent, /No recurring configs yet/);
  });

  test("exposes recurring Active and Paused state as text without prohibited ARIA", () => {
    const harness = createHarness({
      model: baseModel({
        recurring: recurringSnapshot([
          {
            id: "active-schedule",
            description: "Active schedule",
            cronExpression: "0 9 * * 1",
            enabled: true,
          },
          {
            id: "paused-schedule",
            description: "Paused schedule",
            cronExpression: "0 9 * * 2",
            enabled: false,
          },
        ]),
      }),
    });

    harness.api.renderTasksSurface([], "recurring");
    const statuses = findAllByClass(
      harness.documentList,
      "recurring-status",
    );
    assert.deepEqual(
      statuses.map((status) => status.textContent),
      ["Active", "Paused"],
    );
    assert.ok(
      statuses.every((status) => status.getAttribute("aria-label") === null),
    );
    assert.deepEqual(
      statuses.map(
        (status) =>
          findAllByClass(status, "visually-hidden")[0]?.textContent,
      ),
      ["Active", "Paused"],
    );
  });

  test("creates and edits recurring schedules from the Recurring tab", async () => {
    const config = {
      id: "recurring-1",
      description: "Weekly newsletter",
      cronExpression: "0 9 * * 1",
      assigneeId: "user-grace",
      enabled: true,
    };
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
    await findByText(createOverlay, "Create schedule", "button").dispatch(
      "click",
    );
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
    assert.match(editOverlay.textContent, /Every Monday at 09:00/);
    editInputs[0].value = "Weekly newsletter prep";
    await findByText(editOverlay, "Save schedule", "button").dispatch("click");
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

  test("validates and creates quick Tasks with the canonical mutation shape", async () => {
    const { api, errors, openedTasks, requests, shellBody } = createHarness({
      request: async (url) =>
        url === "/api/tasks" ? { task: { id: "task-created" } } : {},
    });
    api.openQuickTaskForm();
    const overlay = findAllByClass(shellBody, "quick-form-overlay")[0];
    const create = findByText(overlay, "Create task", "button");
    await create.dispatch("click");
    assert.deepEqual(errors, ["Task description is required."]);
    assert.equal(requests.length, 0);

    const inputs = overlay.querySelectorAll("input");
    inputs.find((input) => input.type === "text").value = "Prepare release";
    inputs.find((input) => input.type === "date").value = "2026-08-15";
    await create.dispatch("click");
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
    await create.dispatch("click");
    assert.deepEqual(harness.errors, ["Select a template."]);
    assert.equal(calls.filter(({ url }) => url === "/api/cards").length, 0);

    const select = overlay.querySelector("select");
    select.value = "template-uuid";
    const inputs = overlay.querySelectorAll("input");
    inputs.find((input) => input.type === "text").value = "August newsletter";
    inputs.find((input) => input.type === "date").value = "2026-08-20";
    await create.dispatch("click");
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
});
