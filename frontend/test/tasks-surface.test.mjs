import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import {
  cardsHeaderViewModel,
  compareIsoDate,
  formatTaskDateMeta,
  groupCardItemsByStage,
  isArchivedWorkBundle,
  isFollowUpDueTask,
  isOpenWorkTask,
  isTaskDueToday,
  isTaskOverdue,
  isWaitingOrFollowUpTask,
  summarizeBundleProgress,
  taskDate,
  taskProofState,
  tasksFromWorkPayload,
  tasksSectionTitle,
  workBundleTitle,
  workTaskTitle,
} from "../src/core/workspace.js";
import { createTasksSurface } from "../src/surfaces/tasks.js";
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

function baseModel(overrides = {}) {
  return {
    stats: {
      followUpTasks: 0,
      missingProofTasks: 0,
      activeBundles: 0,
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
    bundleId: "",
    filterBundle: null,
    contextBundleId: "",
    contextBundle: null,
    failures: [],
  };
  let model = options.model || baseModel();
  const state = {
    workSnapshot: {
      tasks: [],
      todayLoaded: true,
      overdueLoaded: true,
      waitingLoaded: true,
      bundlesLoaded: true,
      bundles: [],
      activeBundles: [],
      bundleTasks: {},
      ...(options.workSnapshot || {}),
    },
    recurringSnapshot: {},
    qualitySnapshot: {},
  };
  let api;
  const refreshRecurring = async ({ rerender } = {}) => {
    if (options.refreshRecurring) await options.refreshRecurring();
    if (rerender && api) api.renderTasksSurface([], "templates");
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
    groupCardItemsByStage,
    isArchivedWorkBundle,
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
    openBundlePanel: (id) => openedCards.push(id),
    openDocument() {},
    openTaskPanel: (id) => openedTasks.push(id),
    operationItemFromBundle: (bundle, tasks) => ({
      bundleId: bundle.id,
      title: bundle.title,
      stage: bundle.stage,
      risk: "low",
      meta: `${tasks.length} tasks`,
      progress: { percent: 50 },
    }),
    referenceCountLabel: (name, count) => `${count} ${name}`,
    refreshDocuments: async () => {},
    refreshOperationsRecurringSnapshot: refreshRecurring,
    refreshOperationsWorkSnapshot: async () => {},
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
    summarizeBundleProgress,
    taskDate,
    taskNextActionLabel: () => "Continue work",
    taskProofState,
    taskSourceLabel: () => "DataOps",
    tasksFromWorkPayload,
    tasksSectionTitle,
    todayIsoDate: () => "2026-08-12",
    workApiUrl: (path) => path,
    workBundleTitle,
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
      "confirmLeaveRuntimeDraft",
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
      { id: "overdue", description: "Overdue", date: "2026-08-11" },
      {
        id: "follow-up",
        description: "Follow up",
        status: "waiting",
        waitingFor: "reply",
        followUpAt: "2026-08-12",
      },
      {
        id: "waiting",
        description: "Waiting",
        status: "waiting",
        waitingFor: "review",
        followUpAt: "2026-08-14",
      },
      { id: "today", description: "Today", date: "2026-08-12" },
      { id: "done", description: "Done", status: "done", date: "2026-08-12" },
    ];
    const { api, documentList, navigations } = createHarness({
      workSnapshot: { tasks },
      taskRouteContext: {
        date: "2026-08-12",
        tasks,
        bundleId: "missing-card",
        filterBundle: null,
        contextBundleId: "",
        contextBundle: null,
        failures: [
          {
            source: "filter-bundle",
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
      { id: "prep", title: "Prepare", stage: "preparation" },
      { id: "announced", title: "Announce", stage: "announced" },
      { id: "after-event", title: "Follow up", stage: "after-event" },
    ];
    const archived = { id: "done", title: "Completed", stage: "done" };
    const { api, documentList, setRoute, state } = createHarness({
      route: { path: "/cards", params: new URLSearchParams() },
      workSnapshot: {
        activeBundles: active,
        bundles: [...active, archived],
        bundleTasks: {
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
    assert.equal(state.workSnapshot.activeBundles.length, 3);
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

  test("tracks Template clean, dirty, validation, and conflict states without losing the draft", async () => {
    const template = {
      id: "template-1",
      name: "Newsletter",
      type: "workflow",
      version: 2,
      tags: [],
      phases: [],
      sourceDocIds: [],
      references: [],
      bundleLinkDefinitions: [],
      taskDefinitions: [
        { refId: "draft", description: "Draft", offsetDays: 0 },
      ],
    };
    let conflict = false;
    const harness = createHarness({
      request: async (url, options) => {
        if (url === "/api/templates") return { templates: [template] };
        if (url === "/api/me") return { user: { role: "admin" } };
        if (url === "/api/templates/template-1" && options.method === "PUT") {
          const error = new Error("Version conflict");
          error.status = 409;
          error.payload = { currentVersion: 3 };
          conflict = true;
          throw error;
        }
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

    let saveState = harness.document.querySelector(
      "[data-template-save-state]",
    );
    assert.equal(saveState.dataset.state, "clean");
    assert.equal(saveState.textContent, "No unsaved changes");
    const nameLabel = findByText(
      harness.documentList,
      "Name",
      "span",
    ).parentElement;
    const nameInput = nameLabel.querySelector("input");
    nameInput.value = "";
    await nameInput.dispatch("input");
    saveState = harness.document.querySelector("[data-template-save-state]");
    assert.equal(saveState.dataset.state, "dirty");
    assert.equal(saveState.textContent, "Unsaved changes");

    await findByText(harness.documentList, "Save template", "button").dispatch(
      "click",
    );
    await nextTicks();
    saveState = harness.document.querySelector("[data-template-save-state]");
    assert.equal(saveState.dataset.state, "validation");
    assert.match(
      harness.documentList.textContent,
      /Review the highlighted fields/,
    );
    assert.equal(conflict, false);

    const rerenderedName = findByText(
      harness.documentList,
      "Name",
      "span",
    ).parentElement.querySelector("input");
    rerenderedName.value = "Newsletter revised";
    await rerenderedName.dispatch("input");
    await findByText(harness.documentList, "Save template", "button").dispatch(
      "click",
    );
    await nextTicks();
    assert.equal(conflict, true);
    saveState = harness.document.querySelector("[data-template-save-state]");
    assert.equal(saveState.dataset.state, "conflict");
    assert.match(saveState.textContent, /Conflict/);
    assert.match(
      harness.documentList.textContent,
      /newer server version \(3\)/,
    );
    assert.ok(
      findByText(harness.documentList, "Reload server version", "button"),
    );
    assert.equal(
      harness.document
        .querySelector(".runtime-template-json")
        .value.includes("Newsletter revised"),
      true,
    );
  });

  test("renders Recurring empty/list states and maps pause plus protected-delete guidance", async () => {
    const recurring = {
      loaded: true,
      configs: [
        {
          id: "recurring-1",
          description: "Weekly newsletter",
          cronExpression: "0 9 * * 1",
          enabled: true,
        },
      ],
      enabled: [{ id: "recurring-1" }],
      disabled: [],
      errors: [],
    };
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
    harness.api.renderTasksSurface([], "templates");
    assert.match(harness.documentList.textContent, /1 enabled - 0 paused/);
    assert.match(harness.documentList.textContent, /Weekly on Monday at 09:00/);

    await findByText(harness.documentList, "Pause", "button").dispatch("click");
    assert.deepEqual(JSON.parse(calls.at(-1).options.body), { enabled: false });

    await findByText(
      harness.documentList,
      "Delete schedule",
      "button",
    ).dispatch("click");
    await nextTicks();
    assert.equal(calls.at(-1).options.method, "DELETE");
    assert.match(
      harness.documentList.textContent,
      /cannot be deleted\. Pause it instead; generated tasks and notifications are preserved/,
    );

    harness.setModel(baseModel());
    harness.api.renderTasksSurface([], "templates");
    assert.match(harness.documentList.textContent, /No recurring configs yet/);
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
        if (url === "/api/bundles") return { bundle: { id: "card-created" } };
        throw new Error(`Unexpected request ${url}`);
      },
    });
    await harness.api.openQuickWorkflowForm();
    const overlay = findAllByClass(harness.shellBody, "quick-form-overlay")[0];
    const create = findByText(overlay, "Create card", "button");
    await create.dispatch("click");
    assert.deepEqual(harness.errors, ["Select a template."]);
    assert.equal(calls.filter(({ url }) => url === "/api/bundles").length, 0);

    const select = overlay.querySelector("select");
    select.value = "template-uuid";
    const inputs = overlay.querySelectorAll("input");
    inputs.find((input) => input.type === "text").value = "August newsletter";
    inputs.find((input) => input.type === "date").value = "2026-08-20";
    await create.dispatch("click");
    await nextTicks();
    const mutation = calls.find(({ url }) => url === "/api/bundles");
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
