import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import {
  addDaysIso,
  formatTaskDateMeta,
  hasApprovedArtifactEvidence,
  hasTaskFileEvidence,
  isArchivedWorkCard,
  isOpenWorkTask,
  summarizeCardProgress,
  taskDate,
  taskProofState,
  taskRequiresApprovedArtifact,
  tasksFromWorkPayload,
  todayIsoDate,
  workCardTitle,
  workflowTaskGroups,
  workTaskTitle,
} from "../src/core/workspace.js";
import { createWorkDetailSurface } from "../src/surfaces/work-detail/index.js";
import {
  FakeDocument,
  FakeElement,
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

function apiUrl(path, params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== "") {
      query.set(key, String(value));
    }
  }
  return query.size ? `${path}?${query}` : path;
}

function jsonBody(request) {
  return JSON.parse(request.options.body || "{}");
}

function elementContains(root, target) {
  if (root === target) return true;
  return root.children.some((child) => elementContains(child, target));
}

function createHarness(options = {}) {
  const body = new FakeElement("body");
  const taskPanel = new FakeElement("div");
  taskPanel.hidden = true;
  const taskModal = new FakeElement("section");
  taskModal.className = "task-modal-panel";
  taskModal.contains = (element) => elementContains(taskModal, element);
  const taskPanelTitle = new FakeElement("h2");
  const taskPanelBody = new FakeElement("div");
  const taskPanelClose = new FakeElement("button");
  taskPanelClose.textContent = "Close";
  taskModal.append(taskPanelTitle, taskPanelBody, taskPanelClose);
  taskPanel.append(taskModal);

  const cardPanel = new FakeElement("div");
  cardPanel.hidden = true;
  const cardModal = new FakeElement("section");
  cardModal.className = "workflow-modal-panel";
  cardModal.contains = (element) => elementContains(cardModal, element);
  const cardPanelTitle = new FakeElement("h2");
  const cardPanelBody = new FakeElement("div");
  const cardPanelClose = new FakeElement("button");
  cardPanelClose.textContent = "Close";
  cardModal.append(cardPanelTitle, cardPanelBody, cardPanelClose);
  cardPanel.append(cardModal);

  body.append(taskPanel, cardPanel);
  const document = new FakeDocument(body);
  globalThis.document = document;

  const requests = [];
  const navigations = [];
  const entityStates = [];
  const errors = [];
  const undo = [];
  const openedDocuments = [];
  let route = options.route || {
    path: "/tasks",
    params: new URLSearchParams(),
    invalid: false,
  };
  let routeToken = options.routeToken ?? 1;
  let fresh = options.fresh ?? true;
  const cards = options.cards || [];
  const state = {
    workSnapshot: {
      todayTasks: [],
      overdueTasks: [],
      waitingTasks: [],
      cardTasks: {},
      cards,
      cardsById: new Map(cards.map((card) => [card.id, card])),
      usersById: new Map(),
      ...(options.workSnapshot || {}),
    },
    qualitySnapshot: {},
    assistantSnapshot: { loaded: false },
  };

  const defaultRequest = async (url, requestOptions) => {
    if (requestOptions.method) return {};
    if (url.startsWith("/api/files")) return { files: { items: [] } };
    if (url.startsWith("/api/artifacts")) return { artifacts: [] };
    return {};
  };
  const request = async (url, requestOptions = {}) => {
    const entry = { url, options: requestOptions };
    requests.push(entry);
    if (options.request) return options.request(url, requestOptions, entry);
    return defaultRequest(url, requestOptions);
  };

  const api = createWorkDetailSurface({
    addDaysIso,
    body,
    buildTaskProcessQualityFindings: () => [],
    cardPanel,
    cardPanelBody,
    cardPanelClose,
    cardPanelTitle,
    escapeHtml,
    fetchResource:
      options.fetchResource ||
      (async () => ({ ok: true, json: async () => ({}) })),
    FOCUSABLE_SELECTOR:
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    formatTaskDateMeta,
    getActiveTasksSection: () => "queue",
    getActiveWorkspaceRoute: () => route,
    getActiveWorkspaceRouteToken: () => routeToken,
    getActiveWorkspaceView: () => "tasks",
    getAllDocuments: () => [],
    getCurrentOperator: () => ({ id: "alexey", name: "Alexey" }),
    hasApprovedArtifactEvidence,
    hasTaskFileEvidence,
    isArchivedWorkCard,
    isOpenWorkTask,
    isWorkspaceRouteFresh: (token) => fresh && token === routeToken,
    labelizeWorkValue: (value) =>
      String(value || "")
        .split("-")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" "),
    localDocPathFromHref: (href) =>
      String(href).startsWith("/docs/") ? String(href) : "",
    navigateCanonicalWorkspace: (path, params = {}, navigationOptions = {}) => {
      navigations.push({ path, params, options: navigationOptions });
      return { ready: Promise.resolve() };
    },
    openDocument: (path, openOptions) =>
      openedDocuments.push({ path, options: openOptions }),
    openQualityFinding() {},
    parseWorkspaceHash: () => route,
    promptUser: options.promptUser || (() => "Vendor contact"),
    refreshDocuments: async () => {},
    refreshOperationsWorkSnapshot:
      options.refreshOperationsWorkSnapshot || (async () => {}),
    refreshWorkBell: async () => {},
    renderEntityLoadState: (container, entity) => {
      entityStates.push(entity);
      const marker = new FakeElement("p");
      marker.className = `entity-${entity.status}`;
      marker.textContent = `${entity.kind} ${entity.status}`;
      container.replaceChildren(marker);
    },
    renderHonestState: (title, detail) => {
      const marker = new FakeElement("p");
      marker.textContent = `${title}: ${detail}`;
      return marker;
    },
    renderTasksSurface() {},
    request,
    scheduleAnimationFrame:
      options.scheduleAnimationFrame || ((callback) => setTimeout(callback, 0)),
    settledPayload: (result) =>
      result?.status === "fulfilled" ? result.value : null,
    showUndoToast: (message, action) => undo.push({ message, action }),
    state,
    summarizeCardProgress,
    taskDate,
    taskPanel,
    taskPanelBody,
    taskPanelClose,
    taskPanelTitle,
    taskProofState,
    taskRequiresApprovedArtifact,
    tasksFromWorkPayload,
    todayIsoDate: () => "2026-08-12",
    workApiUrl: apiUrl,
    workCardTitle,
    workTaskTitle,
    workflowTaskGroups,
  });

  return {
    api,
    body,
    cardPanel,
    cardPanelBody,
    cardPanelClose,
    cardPanelTitle,
    document,
    entityStates,
    errors,
    navigations,
    openedDocuments,
    requests,
    setFresh: (value) => {
      fresh = value;
    },
    setRouteToken: (value) => {
      routeToken = value;
    },
    setRoute: (value) => {
      route = value;
    },
    state,
    taskModal,
    taskPanel,
    taskPanelBody,
    taskPanelClose,
    taskPanelTitle,
    undo,
  };
}

async function hydrateTask(harness, task, options = {}) {
  harness.api.prepareTaskPanel(task.id);
  const originalRequestCount = harness.requests.length;
  await harness.api.hydrateTaskPanel(task.id, 1, options);
  await nextTicks();
  assert.ok(harness.requests.length > originalRequestCount);
}

async function waitFor(predicate, description) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const value = predicate();
    if (value) return value;
    await nextTicks(3);
    // Let deferred paint callbacks run without draining them inside hydration.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

describe("Work Detail surface boundary", () => {
  test("directly imports the production factory and exposes the stable Work Detail facade", () => {
    const { api } = createHarness();

    assert.deepEqual(Object.keys(api).sort(), [
      "closeCardPanel",
      "closeTaskPanel",
      "dedupeArtifacts",
      "defaultNextFollowUpDate",
      "getTaskRouteContext",
      "handleWorkspaceEntityModalKeydown",
      "hydrateCardPanel",
      "hydrateTaskPanel",
      "openCardPanel",
      "openTaskPanel",
      "prepareCardPanel",
      "prepareTaskPanel",
      "renderArtifactList",
      "resetCardPanel",
      "resetTaskPanel",
      "resolveAssigneeLabel",
      "resolveCardLabel",
      "resolveTaskQueueRouteContext",
      "setTaskRouteContextFromRoute",
    ]);
    assert.equal(api.defaultNextFollowUpDate(), "2026-08-15");
  });

  test("opens, hydrates, and closes a Task modal through its canonical route", async () => {
    const task = {
      id: "task-1",
      version: 1,
      taskHistory: [],
      description: "Confirm the speaker",
      date: "2026-08-12",
      status: "todo",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    };
    const harness = createHarness({
      route: {
        path: "/tasks",
        params: new URLSearchParams("date=2026-08-12"),
        invalid: false,
      },
      request: async (url, requestOptions = {}) => {
        if (url === "/api/tasks/task-1" && !requestOptions.method) return task;
        if (url.startsWith("/api/files")) return { files: { items: [] } };
        if (url.startsWith("/api/artifacts")) return { artifacts: [] };
        return {};
      },
    });

    await harness.api.openTaskPanel(task.id);
    assert.equal(harness.navigations[0].path, "/tasks");
    assert.equal(harness.navigations[0].params.get("taskId"), task.id);
    assert.equal(harness.navigations[0].params.get("date"), "2026-08-12");

    harness.api.prepareTaskPanel(task.id);
    assert.equal(harness.taskPanel.hidden, false);
    assert.equal(harness.taskPanelTitle.textContent, "Loading task...");
    await harness.api.hydrateTaskPanel(task.id, 1);
    await nextTicks();
    assert.equal(harness.taskPanelTitle.textContent, "Confirm the speaker");
    assert.ok(findByText(harness.taskPanelBody, "Mark done", "button"));

    harness.setRoute({
      path: "/tasks",
      params: new URLSearchParams(
        "date=2026-08-12&taskId=task-1&contextCardId=card-2",
      ),
      invalid: false,
    });
    await harness.api.closeTaskPanel();
    const close = harness.navigations.at(-1);
    assert.equal(close.path, "/tasks");
    assert.equal(close.params.has("taskId"), false);
    assert.equal(close.params.get("date"), "2026-08-12");
    assert.equal(close.params.get("contextCardId"), "card-2");
    assert.deepEqual(close.options.restoreFocus, {
      kind: "task",
      id: "task-1",
      surface: "tasks",
    });
  });

  test("returns a Home task to its originating action with focus restored", async () => {
    const harness = createHarness({
      route: { path: "/", params: new URLSearchParams(), invalid: false },
    });

    await harness.api.openTaskPanel("home-task");
    harness.setRoute({
      path: "/tasks",
      params: new URLSearchParams("taskId=home-task"),
      invalid: false,
    });
    await harness.api.closeTaskPanel();

    const close = harness.navigations.at(-1);
    assert.equal(close.path, "/");
    assert.deepEqual(close.params, {});
    assert.deepEqual(close.options.restoreFocus, {
      kind: "home-task",
      id: "home-task",
    });
  });

  test("keeps keyboard focus in the top Task modal and Escape closes only that route layer", async () => {
    const harness = createHarness({
      route: {
        path: "/cards",
        params: new URLSearchParams("cardId=card-1&taskId=task-1"),
        invalid: false,
      },
    });
    harness.api.prepareCardPanel("card-1");
    harness.api.prepareTaskPanel("task-1");
    const last = new FakeElement("input");
    harness.taskModal.append(last);
    harness.document.activeElement = last;

    let prevented = false;
    harness.api.handleWorkspaceEntityModalKeydown({
      defaultPrevented: false,
      key: "Tab",
      shiftKey: false,
      preventDefault: () => {
        prevented = true;
      },
    });
    assert.equal(prevented, true);
    assert.equal(harness.taskPanelClose.focused, true);

    harness.api.handleWorkspaceEntityModalKeydown({
      defaultPrevented: false,
      key: "Escape",
      preventDefault() {},
    });
    await nextTicks(1);
    const close = harness.navigations.at(-1);
    assert.equal(close.path, "/cards");
    assert.equal(close.params.get("cardId"), "card-1");
    assert.equal(close.params.has("taskId"), false);
    assert.equal(harness.cardPanel.hidden, false);
  });

  test("requires canonical Task history and presents comments separately from transition history", async () => {
    const canonical = {
      id: "task-history",
      version: 2,
      taskHistory: [
        {
          id: "event-1",
          taskId: "task-history",
          action: "completed",
          note: "Published",
          createdAt: "2026-08-12T10:00:00.000Z",
        },
        {
          id: "history-template-retired",
          taskId: "task-history",
          action: "template-retired",
          actorId: "system:task-lifecycle",
          createdAt: "2026-08-12T11:00:00.000Z",
        },
      ],
      description: "Publish the update",
      date: "2026-08-12",
      status: "done",
      comment: "Operator note",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-12T10:00:00.000Z",
    };
    const canonicalHarness = createHarness({
      request: async (url) => {
        if (url === `/api/tasks/${canonical.id}`) return canonical;
        if (url.startsWith("/api/files")) return { files: { items: [] } };
        if (url.startsWith("/api/artifacts")) return { artifacts: [] };
        return {};
      },
    });
    await hydrateTask(canonicalHarness, canonical);
    assert.ok(findByText(canonicalHarness.taskPanelBody, "Comment"));
    assert.ok(findByText(canonicalHarness.taskPanelBody, "Operator note"));
    assert.ok(findByText(canonicalHarness.taskPanelBody, "History"));
    assert.match(
      canonicalHarness.taskPanelBody.textContent,
      /Task completed — Published/,
    );
    assert.match(
      canonicalHarness.taskPanelBody.textContent,
      /Task retired by Template update/,
    );

    const historyless = { ...canonical, id: "task-historyless" };
    delete historyless.taskHistory;
    const historylessHarness = createHarness({
      request: async (url) => {
        if (url === `/api/tasks/${historyless.id}`) return historyless;
        return {};
      },
    });
    await hydrateTask(historylessHarness, historyless);
    assert.equal(
      historylessHarness.taskPanelTitle.textContent,
      "Task unavailable",
    );
    assert.equal(historylessHarness.entityStates.at(-1).status, "error");
  });

  test("maps waiting, response-received, and follow-up actions to atomic request contracts", async () => {
    const todo = {
      id: "task-todo",
      version: 1,
      taskHistory: [],
      status: "todo",
      description: "Ask for approval",
    };
    const waiting = {
      id: "task-waiting",
      version: 1,
      taskHistory: [],
      description: "Wait for approval",
      status: "waiting",
      waitingFor: "Sponsor",
      followUpAt: "2026-08-13",
    };
    let activeTask = todo;
    const harness = createHarness({
      request: async (url, requestOptions = {}) => {
        if (url === `/api/tasks/${activeTask.id}` && !requestOptions.method) {
          return activeTask;
        }
        if (url.startsWith("/api/files")) return { files: { items: [] } };
        if (url.startsWith("/api/artifacts")) return { artifacts: [] };
        if (requestOptions.method) {
          return { ...activeTask, version: activeTask.version + 1 };
        }
        return {};
      },
    });

    await hydrateTask(harness, todo);
    const markWaiting = findByText(
      harness.taskPanelBody,
      "Mark waiting",
      "button",
    );
    await markWaiting.click();
    const waitingRequest = harness.requests.find((entry) =>
      entry.url.endsWith("/actions/mark-waiting"),
    );
    assert.equal(waitingRequest.options.method, "POST");
    assert.deepEqual(jsonBody(waitingRequest), {
      waitingFor: "Vendor contact",
      followUpAt: "2026-08-15",
      channel: "portal",
      note: "Marked waiting from the Task panel",
      expectedVersion: 1,
    });

    activeTask = waiting;
    await hydrateTask(harness, waiting);
    const response = findByText(
      harness.taskPanelBody,
      "Response received",
      "button",
    );
    const followUp = findByText(
      harness.taskPanelBody,
      "Follow-up sent",
      "button",
    );
    const nextDate = harness.taskPanelBody
      .querySelectorAll("input")
      .find((input) => input.type === "date");
    nextDate.value = "2026-08-20";
    await response.click();
    await followUp.click();

    const responseRequest = harness.requests.find((entry) =>
      entry.url.endsWith("/actions/response-received"),
    );
    assert.deepEqual(jsonBody(responseRequest), {
      channel: "portal",
      note: "Response received in the Task panel",
      expectedVersion: 1,
    });
    const followUpRequest = harness.requests.find((entry) =>
      entry.url.endsWith("/actions/follow-up-sent"),
    );
    assert.deepEqual(jsonBody(followUpRequest), {
      nextFollowUpAt: "2026-08-20",
      channel: "portal",
      note: "Follow-up sent from the Task panel",
      expectedVersion: 2,
    });
  });

  test("renders Template-retired archived Tasks as non-actionable history", async () => {
    const archived = {
      id: "task-template-retired",
      version: 4,
      taskHistory: [
        {
          id: "retired-event",
          taskId: "task-template-retired",
          action: "template-retired",
          actorId: "operator",
          createdAt: "2026-08-12T10:00:00.000Z",
        },
      ],
      description: "Retired Task",
      status: "archived",
      date: "2026-08-12",
      templateRetiredAt: "2026-08-12T10:00:00.000Z",
      templateRetiredReason: "removed",
    };
    const harness = createHarness({
      request: async (url) => {
        if (url === `/api/tasks/${archived.id}`) return archived;
        if (url.startsWith("/api/files")) return { files: { items: [] } };
        if (url.startsWith("/api/artifacts")) return { artifacts: [] };
        return {};
      },
    });
    await hydrateTask(harness, archived);
    assert.equal(
      findByText(harness.taskPanelBody, "Reopen", "button"),
      undefined,
    );
    assert.ok(
      findByText(
        harness.taskPanelBody,
        "Retired Tasks can only be restored by a reviewed Template update.",
        "p",
      ),
    );
    assert.match(
      harness.taskPanelBody.textContent,
      /Task retired by Template update/,
    );
  });

  test("keeps a focused Evidence URL draft through a background artifact rerender", async () => {
    const task = {
      id: "task-evidence-draft",
      version: 3,
      taskHistory: [],
      description: "Attach the published evidence",
      status: "todo",
      requiredLinkName: "Evidence URL",
      link: "",
    };
    const draft = "https://example.invalid/synthetic-evidence";
    let releaseArtifacts;
    const artifactsHeld = new Promise((resolve) => {
      releaseArtifacts = resolve;
    });
    const harness = createHarness({
      request: async (url, requestOptions = {}) => {
        if (url === `/api/tasks/${task.id}` && !requestOptions.method)
          return task;
        if (url.startsWith("/api/files")) return { files: { items: [] } };
        if (url.startsWith("/api/artifacts")) {
          await artifactsHeld;
          return { artifacts: [] };
        }
        if (
          url === `/api/tasks/${task.id}` &&
          requestOptions.method === "PUT"
        ) {
          return {
            ...task,
            ...jsonBody({ options: requestOptions }),
            version: task.version + 1,
          };
        }
        return {};
      },
    });

    harness.api.prepareTaskPanel(task.id);
    const hydrated = harness.api.hydrateTaskPanel(task.id, 1);
    await nextTicks();

    // The operator types an Evidence URL and has not left the field yet.
    const typedInput = harness.taskPanelBody.querySelector(
      '[data-panel-field="required-link"]',
    );
    assert.ok(typedInput);
    typedInput.focus();
    typedInput.value = draft;
    typedInput.setSelectionRange(draft.length, draft.length);
    assert.equal(harness.document.activeElement, typedInput);

    // Delayed artifact hydration rebuilds the panel underneath that draft.
    releaseArtifacts();
    await hydrated;
    await nextTicks();

    const rerenderedInput = harness.taskPanelBody.querySelector(
      '[data-panel-field="required-link"]',
    );
    assert.ok(rerenderedInput);
    assert.notEqual(
      rerenderedInput,
      typedInput,
      "the background rerender must really rebuild the Task form",
    );
    assert.equal(rerenderedInput.value, draft);
    assert.equal(rerenderedInput.selectionStart, draft.length);
    assert.equal(rerenderedInput.selectionEnd, draft.length);
    assert.equal(rerenderedInput.focused, true);
    assert.equal(harness.document.activeElement, rerenderedInput);
    assert.deepEqual(
      harness.requests.filter((entry) => entry.options.method === "PUT"),
      [],
      "a background rerender must not submit a half-typed draft",
    );

    // The operator's own blur still saves exactly what they typed.
    await rerenderedInput.dispatch("blur");
    await nextTicks();

    const writes = harness.requests.filter(
      (entry) =>
        entry.url === `/api/tasks/${task.id}` && entry.options.method === "PUT",
    );
    assert.deepEqual(writes.map(jsonBody), [
      { link: draft, expectedVersion: 3 },
    ]);
    assert.deepEqual(harness.errors, []);
    assert.equal(
      harness.taskPanelBody.querySelector('[data-panel-field="required-link"]')
        .value,
      draft,
    );
  });

  test("keeps sibling Task-panel drafts through a background artifact rerender", async () => {
    const task = {
      id: "task-sibling-draft",
      version: 2,
      taskHistory: [],
      description: "Register external evidence",
      status: "todo",
    };
    const titleDraft = "Synthetic launch recording";
    const urlDraft = "https://example.invalid/synthetic-recording";
    let releaseArtifacts;
    const artifactsHeld = new Promise((resolve) => {
      releaseArtifacts = resolve;
    });
    const harness = createHarness({
      request: async (url) => {
        if (url === `/api/tasks/${task.id}` && !url.includes("?")) return task;
        if (url.startsWith("/api/files")) return { files: { items: [] } };
        if (url.startsWith("/api/artifacts")) {
          await artifactsHeld;
          return { artifacts: [] };
        }
        return {};
      },
    });

    harness.api.prepareTaskPanel(task.id);
    const hydrated = harness.api.hydrateTaskPanel(task.id, 1);
    await nextTicks();

    const typedTitle = harness.taskPanelBody.querySelector(
      '[data-panel-field="artifact-title"]',
    );
    const typedUrl = harness.taskPanelBody.querySelector(
      '[data-panel-field="artifact-url"]',
    );
    assert.ok(typedTitle && typedUrl);
    typedTitle.value = titleDraft;
    typedUrl.focus();
    typedUrl.value = urlDraft;
    typedUrl.setSelectionRange(urlDraft.length, urlDraft.length);

    releaseArtifacts();
    await hydrated;
    await nextTicks();

    const rerenderedTitle = harness.taskPanelBody.querySelector(
      '[data-panel-field="artifact-title"]',
    );
    const rerenderedUrl = harness.taskPanelBody.querySelector(
      '[data-panel-field="artifact-url"]',
    );
    assert.ok(rerenderedTitle && rerenderedUrl);
    assert.notEqual(rerenderedTitle, typedTitle);
    assert.notEqual(rerenderedUrl, typedUrl);
    assert.equal(rerenderedTitle.value, titleDraft);
    assert.equal(rerenderedUrl.value, urlDraft);
    assert.equal(rerenderedUrl.focused, true);
    assert.equal(harness.document.activeElement, rerenderedUrl);
    assert.deepEqual(
      harness.requests.filter((entry) => entry.options.method === "POST"),
      [],
      "a background rerender must not register a half-typed artifact",
    );

    await rerenderedUrl.dispatch("blur");
    await findByText(harness.taskPanelBody, "Register", "button").click();
    await nextTicks();

    const writes = harness.requests.filter(
      (entry) =>
        entry.url === "/api/artifacts" && entry.options.method === "POST",
    );
    assert.deepEqual(writes.map(jsonBody), [
      {
        type: "external-link",
        title: titleDraft,
        storageUri: urlDraft,
        storageProvider: "external-url",
        dataClass: "internal",
        sourceType: "manual-link",
        status: "needs-review",
        taskId: task.id,
      },
    ]);
    assert.deepEqual(harness.errors, []);
  });

  test("retains an exact Task link draft across review and repeated conflicts", async () => {
    const task = {
      id: "task-conflict",
      version: 1,
      taskHistory: [],
      description: "Publish the final link",
      status: "todo",
      requiredLinkName: "Published URL",
    };
    let writeAttempt = 0;
    const harness = createHarness({
      request: async (url, requestOptions = {}) => {
        if (url === `/api/tasks/${task.id}` && !requestOptions.method)
          return task;
        if (url.startsWith("/api/files")) return { files: { items: [] } };
        if (url.startsWith("/api/artifacts")) return { artifacts: [] };
        if (
          url === `/api/tasks/${task.id}` &&
          requestOptions.method === "PUT"
        ) {
          writeAttempt += 1;
          if (writeAttempt <= 2) {
            const currentVersion = writeAttempt + 1;
            const error = new Error(
              "Task changed; review the current task and retry",
            );
            error.status = 409;
            error.code = "task_version_conflict";
            error.payload = {
              code: "task_version_conflict",
              expectedVersion: currentVersion - 1,
              currentVersion,
              currentTask: {
                ...task,
                version: currentVersion,
                status: writeAttempt === 1 ? "waiting" : "todo",
              },
            };
            throw error;
          }
          return {
            ...task,
            ...jsonBody({ options: requestOptions }),
            version: 4,
          };
        }
        return {};
      },
    });

    await hydrateTask(harness, task);
    const draft = "  https://example.com/final?draft=1  ";
    const linkInput = harness.taskPanelBody
      .querySelectorAll("input")
      .find((input) => input.type === "url");
    linkInput.value = draft;
    await linkInput.dispatch("change");

    const alert = harness.taskPanelBody.querySelector('[role="alert"]');
    assert.ok(alert);
    assert.equal(alert.focused, true);
    assert.match(
      alert.textContent,
      /Latest server state: version 2, status waiting/,
    );
    assert.match(
      alert.textContent,
      new RegExp(draft.trim().replace(/[?]/g, "\\?")),
    );
    assert.equal(
      harness.taskPanelBody.querySelector('input[type="url"]')?.value ||
        harness.taskPanelBody
          .querySelectorAll("input")
          .find((input) => input.type === "url").value,
      draft,
    );

    await findByText(alert, "Review latest", "button").click();
    assert.match(harness.taskPanelBody.textContent, /Version 2/);
    assert.equal(
      harness.taskPanelBody
        .querySelectorAll("input")
        .find((input) => input.type === "url").value,
      draft,
    );

    await findByText(
      harness.taskPanelBody,
      "Retry my change",
      "button",
    ).click();
    assert.match(
      harness.taskPanelBody.textContent,
      /Latest server state: version 3/,
    );
    assert.equal(
      harness.taskPanelBody
        .querySelectorAll("input")
        .find((input) => input.type === "url").value,
      draft,
    );
    await findByText(
      harness.taskPanelBody,
      "Discard my change",
      "button",
    ).click();
    assert.equal(
      findByText(harness.taskPanelBody, "Retry my change", "button"),
      undefined,
    );
    assert.match(harness.taskPanelBody.textContent, /Version 3/);
    assert.equal(
      harness.taskPanelBody
        .querySelectorAll("input")
        .find((input) => input.type === "url").value,
      "",
    );

    const latestLinkInput = harness.taskPanelBody
      .querySelectorAll("input")
      .find((input) => input.type === "url");
    latestLinkInput.value = draft;
    await latestLinkInput.dispatch("change");

    const writes = harness.requests.filter(
      (entry) =>
        entry.url === `/api/tasks/${task.id}` && entry.options.method === "PUT",
    );
    assert.deepEqual(writes.map(jsonBody), [
      { link: draft, expectedVersion: 1 },
      { link: draft, expectedVersion: 2 },
      { link: draft, expectedVersion: 3 },
    ]);
    assert.equal(
      findByText(harness.taskPanelBody, "Retry my change", "button"),
      undefined,
    );
  });

  test("navigates a retried final-Task conflict to the completed Card in Archive", async () => {
    const card = {
      id: "card-final-conflict",
      version: 2,
      title: "Final conflict Card",
      status: "active",
      stage: "after-event",
      taskCount: 1,
      openTaskCount: 1,
    };
    const task = {
      id: "task-final-conflict",
      cardId: card.id,
      version: 1,
      taskHistory: [],
      description: "Complete after review",
      status: "todo",
    };
    const archived = {
      ...card,
      version: 3,
      status: "archived",
      stage: "done",
      openTaskCount: 0,
      completedAt: "2026-08-12T12:00:00.000Z",
      completedBy: "alexey",
      activeStageBeforeCompletion: "after-event",
    };
    let attempt = 0;
    let harness;
    harness = createHarness({
      cards: [card],
      refreshOperationsWorkSnapshot: async () => {
        // Deliberately stale list/Scan result after the transaction.
        harness.state.workSnapshot.cards = [card];
        harness.state.workSnapshot.cardsById.set(card.id, card);
      },
      request: async (url, requestOptions = {}) => {
        if (url === `/api/tasks/${task.id}` && !requestOptions.method)
          return task;
        if (url.startsWith("/api/files")) return { files: { items: [] } };
        if (url.startsWith("/api/artifacts")) return { artifacts: [] };
        if (url === `/api/cards/${card.id}` && !requestOptions.method) {
          return { card: archived };
        }
        if (
          url === `/api/tasks/${task.id}` &&
          requestOptions.method === "PUT"
        ) {
          attempt += 1;
          if (attempt === 1) {
            const error = new Error("Card changed");
            error.status = 409;
            error.code = "card_lifecycle_conflict";
            error.payload = {
              code: "card_lifecycle_conflict",
              currentTask: task,
              currentCard: card,
            };
            throw error;
          }
          return { ...task, status: "done", version: 2 };
        }
        return {};
      },
    });

    await hydrateTask(harness, task);
    await findByText(harness.taskPanelBody, "Mark done", "button").click();
    await findByText(harness.taskPanelBody, "Review latest", "button").click();
    await findByText(
      harness.taskPanelBody,
      "Retry my change",
      "button",
    ).click();
    assert.deepEqual(harness.navigations.at(-1), {
      path: "/cards/archive",
      params: { cardId: card.id, taskId: task.id },
      options: {},
    });
    assert.equal(harness.undo.at(-1).message, "Task marked done.");
  });

  test("disables duplicate Task submissions only while the write is in flight", async () => {
    const task = {
      id: "task-in-flight",
      version: 1,
      taskHistory: [],
      description: "Complete once",
      status: "todo",
    };
    let resolveWrite;
    const pendingWrite = new Promise((resolve) => {
      resolveWrite = resolve;
    });
    const harness = createHarness({
      request: async (url, requestOptions = {}) => {
        if (url === `/api/tasks/${task.id}` && !requestOptions.method)
          return task;
        if (url.startsWith("/api/files")) return { files: { items: [] } };
        if (url.startsWith("/api/artifacts")) return { artifacts: [] };
        if (
          url === `/api/tasks/${task.id}` &&
          requestOptions.method === "PUT"
        ) {
          return pendingWrite;
        }
        return {};
      },
    });

    await hydrateTask(harness, task);
    const firstButton = findByText(
      harness.taskPanelBody,
      "Mark done",
      "button",
    );
    const firstClick = firstButton.click();
    await nextTicks();
    assert.equal(
      harness.taskPanelBody.querySelector(
        '[data-task-mutation-feedback="pending"]',
      )?.getAttribute("role"),
      "status",
    );
    assert.equal(
      findByText(harness.taskPanelBody, "Mark done", "button").disabled,
      true,
    );
    await firstButton.click();
    assert.strictEqual(
      harness.requests.filter((entry) => entry.options.method === "PUT").length,
      1,
    );

    resolveWrite({ ...task, status: "done", version: 2 });
    await firstClick;
    assert.equal(
      findByText(harness.taskPanelBody, "Reopen", "button").disabled,
      false,
    );
  });

  test("keeps generic Task failures in the owning panel and retries the retained link intent", async () => {
    const task = {
      id: "task-generic-failure",
      version: 1,
      taskHistory: [],
      description: "Publish the synthetic update",
      status: "todo",
      requiredLinkName: "Published URL",
    };
    let attempt = 0;
    const harness = createHarness({
      request: async (url, requestOptions = {}) => {
        if (url === `/api/tasks/${task.id}` && !requestOptions.method)
          return task;
        if (url.startsWith("/api/files")) return { files: { items: [] } };
        if (url.startsWith("/api/artifacts")) return { artifacts: [] };
        if (
          url === `/api/tasks/${task.id}` &&
          requestOptions.method === "PUT"
        ) {
          attempt += 1;
          if (attempt === 1) {
            const error = new Error("Synthetic route failure (503)");
            error.status = 503;
            throw error;
          }
          const body = JSON.parse(requestOptions.body);
          return { ...task, link: body.link, version: 2 };
        }
        return {};
      },
    });

    await hydrateTask(harness, task);
    const draft = "https://synthetic.example/published?attempt=1";
    const linkInput = harness.taskPanelBody.querySelector(
      '[data-panel-field="required-link"]',
    );
    linkInput.value = draft;
    await linkInput.dispatch("change");

    const failure = harness.taskPanelBody.querySelector(
      '[data-task-mutation-feedback="error"]',
    );
    assert.ok(failure);
    assert.equal(failure.getAttribute("role"), "alert");
    assert.equal(failure.focused, true);
    assert.match(failure.textContent, /Could not save link: Synthetic route failure/);
    assert.equal(
      harness.taskPanelBody.querySelector('[data-panel-field="required-link"]').value,
      draft,
    );
    assert.ok(findByText(failure, "Retry change", "button"));
    assert.ok(findByText(failure, "Reload current Task", "button"));
    assert.ok(findByText(failure, "Discard change", "button"));
    assert.deepEqual(harness.errors, []);

    await findByText(failure, "Retry change", "button").click();
    const success = await waitFor(
      () => harness.taskPanelBody.querySelector(
        '[data-task-mutation-feedback="success"]',
      ),
      "Task link success feedback",
    );
    assert.equal(success.getAttribute("role"), "status");
    assert.match(success.textContent, /saved in the refreshed Task/);
    assert.equal(
      harness.taskPanelBody.querySelector('[data-panel-field="required-link"]').value,
      draft,
    );
    const writes = harness.requests.filter(
      (entry) =>
        entry.url === `/api/tasks/${task.id}` && entry.options.method === "PUT",
    );
    assert.deepEqual(writes.map(jsonBody), [
      { link: draft, expectedVersion: 1 },
      { link: draft, expectedVersion: 1 },
    ]);
    assert.deepEqual(harness.errors, []);
  });

  test("keeps generic Card failures in the Card panel and confirms retry after refresh", async () => {
    const card = {
      id: "card-generic-failure",
      version: 1,
      title: "Synthetic release Card",
      status: "active",
      stage: "preparation",
      taskCount: 0,
      openTaskCount: 0,
      references: [],
    };
    let attempt = 0;
    const harness = createHarness({
      cards: [card],
      request: async (url, requestOptions = {}) => {
        if (url === `/api/cards/${card.id}` && !requestOptions.method)
          return card;
        if (url === `/api/tasks?cardId=${card.id}`) return { tasks: [] };
        if (url === `/api/artifacts?cardId=${card.id}`)
          return { artifacts: [] };
        if (
          url === `/api/cards/${card.id}` &&
          requestOptions.method === "PUT"
        ) {
          attempt += 1;
          if (attempt === 1) {
            const error = new Error("Synthetic Card failure (503)");
            error.status = 503;
            throw error;
          }
          return {
            ...card,
            ...JSON.parse(requestOptions.body),
            version: 2,
          };
        }
        return {};
      },
    });

    harness.api.prepareCardPanel(card.id);
    await harness.api.hydrateCardPanel(card.id, 1);
    const stage = harness.cardPanelBody.querySelector("select");
    stage.value = "announced";
    await stage.dispatch("change");

    const failure = harness.cardPanelBody.querySelector(
      '[data-card-mutation-feedback="error"]',
    );
    assert.ok(failure);
    assert.equal(failure.getAttribute("role"), "alert");
    assert.equal(failure.focused, true);
    assert.match(failure.textContent, /Could not update stage: Synthetic Card failure/);
    assert.equal(
      harness.cardPanelBody.querySelector("select").querySelectorAll("option")
        .find((option) => option.selected)?.value,
      "announced",
    );
    assert.ok(findByText(failure, "Retry change", "button"));
    assert.ok(findByText(failure, "Reload current Card", "button"));
    assert.ok(findByText(failure, "Discard change", "button"));
    assert.deepEqual(harness.errors, []);

    await findByText(failure, "Retry change", "button").click();
    const success = await waitFor(
      () => harness.cardPanelBody.querySelector(
        '[data-card-mutation-feedback="success"]',
      ),
      "Card stage success feedback",
    );
    assert.equal(success.getAttribute("role"), "status");
    assert.match(success.textContent, /saved in the refreshed Card/);
    assert.equal(
      harness.cardPanelBody.querySelector("select").querySelectorAll("option")
        .find((option) => option.selected)?.value,
      "announced",
    );
    const writes = harness.requests.filter(
      (entry) =>
        entry.url === `/api/cards/${card.id}` && entry.options.method === "PUT",
    );
    assert.deepEqual(writes.map(jsonBody), [
      { stage: "announced", expectedVersion: 1 },
      { stage: "announced", expectedVersion: 1 },
    ]);
    assert.deepEqual(harness.errors, []);
  });

  test("routes Card-owned Task failures to the Card checklist and retries only that Task intent", async () => {
    const card = {
      id: "card-task-failure",
      version: 1,
      title: "Synthetic checklist Card",
      status: "active",
      stage: "preparation",
      taskCount: 1,
      openTaskCount: 1,
      references: [],
    };
    const task = {
      id: "card-task-failure-item",
      cardId: card.id,
      version: 1,
      taskHistory: [],
      description: "Complete the synthetic checklist item",
      status: "todo",
    };
    let attempt = 0;
    const harness = createHarness({
      cards: [card],
      request: async (url, requestOptions = {}) => {
        if (url === `/api/cards/${card.id}` && !requestOptions.method)
          return card;
        if (url === `/api/tasks?cardId=${card.id}`) return { tasks: [task] };
        if (url === `/api/artifacts?cardId=${card.id}`)
          return { artifacts: [] };
        if (url === `/api/tasks/${task.id}` && requestOptions.method === "PUT") {
          attempt += 1;
          if (attempt === 1) {
            const error = new Error("Synthetic checklist failure (503)");
            error.status = 503;
            throw error;
          }
          return { ...task, status: "done", version: 2 };
        }
        return {};
      },
    });

    harness.api.prepareCardPanel(card.id);
    await harness.api.hydrateCardPanel(card.id, 1);
    const checkbox = harness.cardPanelBody.querySelector(
      '.card-checklist-item input[type="checkbox"]',
    );
    await checkbox.dispatch("change");
    const failure = await waitFor(
      () => harness.cardPanelBody.querySelector(
        '[data-card-mutation-feedback="error"]',
      ),
      "Card-owned Task failure feedback",
    );
    assert.match(
      failure.textContent,
      /Could not update task: Synthetic checklist failure/,
    );
    assert.ok(findByText(failure, "Retry change", "button"));
    assert.ok(findByText(failure, "Reload current Card", "button"));
    assert.ok(findByText(failure, "Discard change", "button"));
    assert.deepEqual(harness.errors, []);

    await findByText(failure, "Retry change", "button").click();
    const success = await waitFor(
      () => harness.cardPanelBody.querySelector(
        '[data-card-mutation-feedback="success"]',
      ),
      "Card-owned Task success feedback",
    );
    assert.equal(success.getAttribute("role"), "status");
    assert.match(success.textContent, /now done in the refreshed Task/);
    assert.equal(
      harness.cardPanelBody.querySelector(
        '.card-checklist-item input[type="checkbox"]',
      ).checked,
      true,
    );
    assert.equal(
      harness.requests.filter(
        (entry) =>
          entry.url === `/api/tasks/${task.id}` && entry.options.method === "PUT",
      ).length,
      2,
    );
    assert.deepEqual(harness.errors, []);
  });

  test("keeps evidence registration failures in the Task panel and recovers with retained fields", async () => {
    const task = {
      id: "task-evidence-failure",
      version: 1,
      taskHistory: [],
      description: "Register synthetic evidence",
      status: "todo",
    };
    const artifact = {
      id: "artifact-synthetic",
      title: "Synthetic evidence",
      storageUri: "https://synthetic.example/evidence",
      status: "needs-review",
    };
    let attempt = 0;
    const harness = createHarness({
      request: async (url, requestOptions = {}) => {
        if (url === `/api/tasks/${task.id}` && !requestOptions.method)
          return task;
        if (url === `/api/files?taskId=${task.id}`)
          return { files: { items: [] } };
        if (url === `/api/artifacts?taskId=${task.id}`)
          return { artifacts: attempt >= 2 ? [artifact] : [] };
        if (url === "/api/artifacts" && requestOptions.method === "POST") {
          attempt += 1;
          if (attempt === 1) {
            const error = new Error("Synthetic evidence route failure (503)");
            error.status = 503;
            throw error;
          }
          return artifact;
        }
        return {};
      },
    });

    await hydrateTask(harness, task);
    const title = "Synthetic evidence";
    const url = "https://synthetic.example/evidence";
    harness.taskPanelBody.querySelector('[data-panel-field="artifact-title"]').value = title;
    harness.taskPanelBody.querySelector('[data-panel-field="artifact-url"]').value = url;
    await findByText(harness.taskPanelBody, "Register", "button").click();

    const failure = harness.taskPanelBody.querySelector(
      '[data-task-mutation-feedback="error"]',
    );
    assert.ok(failure);
    assert.match(failure.textContent, /Could not register artifact: Synthetic evidence route failure/);
    assert.equal(
      harness.taskPanelBody.querySelector('[data-panel-field="artifact-title"]').value,
      title,
    );
    assert.equal(
      harness.taskPanelBody.querySelector('[data-panel-field="artifact-url"]').value,
      url,
    );
    assert.ok(findByText(failure, "Retry change", "button"));
    assert.deepEqual(harness.errors, []);

    await findByText(failure, "Retry change", "button").click();
    const success = await waitFor(
      () => harness.taskPanelBody.querySelector(
        '[data-task-mutation-feedback="success"]',
      ),
      "evidence registration success feedback",
    );
    assert.equal(success.getAttribute("role"), "status");
    assert.match(success.textContent, /confirmed in the refreshed Task/);
    assert.ok(findByText(harness.taskPanelBody, title, "a"));
    assert.equal(
      harness.requests.filter(
        (entry) => entry.url === "/api/artifacts" && entry.options.method === "POST",
      ).length,
      2,
    );
    assert.deepEqual(harness.errors, []);
  });

  test("keeps Task file upload failures local and retries the retained synthetic file", async () => {
    const task = {
      id: "task-file-failure",
      version: 1,
      taskHistory: [],
      description: "Attach synthetic evidence file",
      status: "todo",
      requiresFile: true,
    };
    let uploadAttempt = 0;
    let uploaded = false;
    const harness = createHarness({
      fetchResource: async () => {
        uploadAttempt += 1;
        if (uploadAttempt === 1) {
          return {
            ok: false,
            status: 503,
            text: async () => JSON.stringify({ error: "Synthetic upload outage" }),
          };
        }
        uploaded = true;
        return { ok: true, status: 201, json: async () => ({ id: "file-synthetic" }) };
      },
      request: async (url, requestOptions = {}) => {
        if (url === `/api/tasks/${task.id}` && !requestOptions.method)
          return task;
        if (url.startsWith("/api/artifacts")) return { artifacts: [] };
        if (url.startsWith(`/api/files?taskId=${task.id}`)) {
          return {
            files: {
              items: uploaded
                ? [{ id: "file-synthetic", filename: "synthetic.txt" }]
                : [],
            },
          };
        }
        return {};
      },
    });

    await hydrateTask(harness, task);
    const fileInput = harness.taskPanelBody.querySelector('input[type="file"]');
    fileInput.files = [new Blob(["synthetic fixture"], { type: "text/plain" })];
    await fileInput.dispatch("change");
    const failure = await waitFor(
      () => harness.taskPanelBody.querySelector(
        '[data-task-mutation-feedback="error"]',
      ),
      "file upload failure feedback",
    );
    assert.match(failure.textContent, /Upload failed: Synthetic upload outage/);
    assert.ok(findByText(failure, "Retry change", "button"));
    assert.deepEqual(harness.errors, []);

    await findByText(failure, "Retry change", "button").click();
    const success = await waitFor(
      () => harness.taskPanelBody.querySelector(
        '[data-task-mutation-feedback="success"]',
      ),
      "file upload success feedback",
    );
    assert.equal(success.getAttribute("role"), "status");
    assert.match(success.textContent, /File is attached in the refreshed Task/);
    await waitFor(
      () => harness.taskPanelBody.querySelector(".task-file-item"),
      "uploaded synthetic file",
    );
    assert.equal(uploadAttempt, 2);
    assert.deepEqual(harness.errors, []);
  });

  test("does not announce artifact success when the owning Task cannot refresh", async () => {
    const task = {
      id: "task-artifact-refresh-failure",
      version: 1,
      taskHistory: [],
      description: "Confirm refreshed artifact state",
      status: "todo",
    };
    let registered = false;
    const harness = createHarness({
      request: async (url, requestOptions = {}) => {
        if (url === `/api/tasks/${task.id}` && !requestOptions.method) {
          return task;
        }
        if (url === `/api/artifacts?taskId=${task.id}`) {
          if (registered) throw new Error("Synthetic artifact refresh outage");
          return { artifacts: [] };
        }
        if (url === "/api/artifacts" && requestOptions.method === "POST") {
          registered = true;
          return { id: "artifact-refresh-failure" };
        }
        return {};
      },
    });

    await hydrateTask(harness, task);
    const urlInput = harness.taskPanelBody.querySelector(
      '[data-panel-field="artifact-url"]',
    );
    urlInput.value = "https://example.invalid/refresh-failure";
    await findByText(harness.taskPanelBody, "Register", "button").click();

    const failure = await waitFor(
      () => harness.taskPanelBody.querySelector(
        '[data-task-mutation-feedback="error"]',
      ),
      "artifact refresh failure feedback",
    );
    assert.match(failure.textContent, /Task artifacts could not be refreshed/);
    assert.equal(
      harness.taskPanelBody.querySelector(
        '[data-task-mutation-feedback="success"]',
      ),
      null,
    );
    assert.deepEqual(harness.errors, []);
  });

  test("serializes evidence mutations with Task status changes", async () => {
    const task = {
      id: "task-evidence-serialization",
      version: 1,
      taskHistory: [],
      description: "Do not race evidence and status",
      status: "todo",
      requiresFile: true,
    };
    let releaseUpload;
    const upload = new Promise((resolve) => {
      releaseUpload = resolve;
    });
    let uploaded = false;
    const harness = createHarness({
      fetchResource: () => upload.then((response) => {
        uploaded = true;
        return response;
      }),
      request: async (url) => {
        if (url === `/api/tasks/${task.id}`) return task;
        if (url.startsWith("/api/files")) {
          return {
            files: {
              items: uploaded
                ? [{ id: "file-serialization", filename: "evidence.txt" }]
                : [],
            },
          };
        }
        if (url.startsWith("/api/artifacts")) return { artifacts: [] };
        return {};
      },
    });

    await hydrateTask(harness, task);
    const fileInput = harness.taskPanelBody.querySelector('input[type="file"]');
    fileInput.files = [new Blob(["synthetic fixture"], { type: "text/plain" })];
    const uploadRequest = fileInput.dispatch("change");
    await nextTicks();

    assert.equal(
      findByText(harness.taskPanelBody, "Mark done", "button").disabled,
      true,
    );
    assert.equal(
      harness.requests.filter((entry) => entry.options.method === "PUT").length,
      0,
    );

    releaseUpload({
      ok: true,
      status: 201,
      json: async () => ({ id: "file-serialization" }),
    });
    await uploadRequest;
    await waitFor(
      () => harness.taskPanelBody.querySelector(
        '[data-task-mutation-feedback="success"]',
      ),
      "serialized evidence upload completion",
    );
  });

  test("retains waiting action fields and retries only that intent", async () => {
    const task = {
      id: "task-wait-conflict",
      version: 5,
      taskHistory: [],
      description: "Wait for assets",
      status: "todo",
    };
    let attempt = 0;
    const harness = createHarness({
      promptUser: () => "Vendor contact",
      request: async (url, requestOptions = {}) => {
        if (url === `/api/tasks/${task.id}` && !requestOptions.method)
          return task;
        if (url.startsWith("/api/files")) return { files: { items: [] } };
        if (url.startsWith("/api/artifacts")) return { artifacts: [] };
        if (url.endsWith("/actions/mark-waiting")) {
          attempt += 1;
          if (attempt === 1) {
            const error = new Error("Task changed");
            error.status = 409;
            error.code = "task_version_conflict";
            error.payload = {
              currentVersion: 6,
              currentTask: { ...task, version: 6, comment: "Concurrent note" },
            };
            throw error;
          }
          return {
            ...task,
            version: 7,
            status: "waiting",
            waitingFor: "Vendor contact",
            followUpAt: "2026-08-15",
          };
        }
        return {};
      },
    });

    await hydrateTask(harness, task);
    await findByText(harness.taskPanelBody, "Mark waiting", "button").click();
    assert.match(
      harness.taskPanelBody.textContent,
      /Your retained change: Mark waiting for Vendor contact; follow up 2026-08-15/,
    );
    await findByText(
      harness.taskPanelBody,
      "Retry my change",
      "button",
    ).click();
    const writes = harness.requests.filter((entry) =>
      entry.url.endsWith("/actions/mark-waiting"),
    );
    assert.deepEqual(writes.map(jsonBody), [
      {
        waitingFor: "Vendor contact",
        followUpAt: "2026-08-15",
        channel: "portal",
        note: "Marked waiting from the Task panel",
        expectedVersion: 5,
      },
      {
        waitingFor: "Vendor contact",
        followUpAt: "2026-08-15",
        channel: "portal",
        note: "Marked waiting from the Task panel",
        expectedVersion: 6,
      },
    ]);
  });

  test("blocks Task completion until required link, file, and approved artifact proof exist", async () => {
    const task = {
      id: "proof-task",
      version: 1,
      taskHistory: [],
      description: "Publish the issue",
      date: "2026-08-12",
      status: "todo",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      requiredLinkName: "Newsletter URL",
      requiresFile: true,
      proofRequirement: { type: "artifact", required: true },
    };
    const harness = createHarness({
      request: async (url, requestOptions = {}) => {
        if (url === "/api/tasks/proof-task" && !requestOptions.method) {
          return task;
        }
        if (url.startsWith("/api/files")) return { files: { items: [] } };
        if (url.startsWith("/api/artifacts")) return { artifacts: [] };
        return {};
      },
    });

    await hydrateTask(harness, task);
    const complete = findByText(harness.taskPanelBody, "Mark done", "button");
    assert.equal(complete.disabled, true);
    assert.equal(
      complete.title,
      "Fill in Newsletter URL; Upload required file; Approve an attached artifact",
    );
    assert.ok(
      findByText(harness.taskPanelBody, "No approved artifact attached."),
    );
  });

  test("loads every required-file page before enabling completion", async () => {
    const task = {
      id: "task-paged-files",
      version: 1,
      status: "todo",
      description: "Attach paged evidence",
      taskHistory: [],
      requiresFile: true,
    };
    const fileUrls = [];
    const paintCallbacks = [];
    const harness = createHarness({
      request: async (url) => {
        if (url === `/api/tasks/${task.id}`) return task;
        if (url.startsWith("/api/files")) {
          fileUrls.push(url);
          if (fileUrls.length === 1) {
            return {
              files: {
                items: [{ id: "file-1", filename: "first.pdf" }],
                nextCursor: "file-cursor",
              },
            };
          }
          return {
            files: {
              items: [
                { id: "file-1", filename: "first.pdf" },
                { id: "file-2", filename: "second.pdf" },
              ],
            },
          };
        }
        return { artifacts: [] };
      },
      scheduleAnimationFrame: (callback) => paintCallbacks.push(callback),
    });

    await hydrateTask(harness, task);
    await waitFor(
      () =>
        harness.taskPanelBody.querySelectorAll(".task-file-item").length ===
          1 && findByText(harness.taskPanelBody, "Mark done", "button"),
      "the first evidence page and completion gate",
    );
    const completeBefore = findByText(
      harness.taskPanelBody,
      "Mark done",
      "button",
    );
    assert.match(completeBefore.title, /Upload required file/);
    assert.deepEqual(
      harness.taskPanelBody
        .querySelectorAll(".task-file-item")
        .map((item) => item.textContent),
      ["first.pdfRemove"],
    );
    assert.equal(paintCallbacks.length, 1);
    paintCallbacks.shift()();
    await waitFor(
      () =>
        harness.taskPanelBody.querySelectorAll(".task-file-item").length ===
          2 &&
        !findByText(harness.taskPanelBody, "Mark done", "button")?.title?.match(
          /Upload required file/,
        ),
      "the completed evidence page",
    );
    assert.match(fileUrls[0], /taskId=task-paged-files/);
    assert.match(fileUrls[0], /limit=100/);
    assert.doesNotMatch(fileUrls[0], /cursor=/);
    assert.match(fileUrls[1], /cursor=file-cursor/);
    assert.equal(
      findByText(harness.taskPanelBody, ".task-file-error"),
      undefined,
    );
    assert.deepEqual(
      harness.taskPanelBody
        .querySelectorAll(".task-file-item")
        .map((item) => item.textContent),
      ["first.pdfRemove", "second.pdfRemove"],
    );
    const completeAfter = findByText(
      harness.taskPanelBody,
      "Mark done",
      "button",
    );
    assert.equal(completeAfter.disabled, false);
    if (completeAfter.title) {
      assert.doesNotMatch(completeAfter.title, /Upload required file/);
    }
  });

  test("keeps an empty paginated Files page in continuation and exposes failure accessibly", async () => {
    const task = {
      id: "task-empty-paged-files",
      version: 1,
      status: "todo",
      description: "Attach paged evidence",
      taskHistory: [],
      requiresFile: true,
    };
    let continuationOnline = false;
    let fileRequestCount = 0;
    const paintCallbacks = [];
    const harness = createHarness({
      request: async (url) => {
        if (url === `/api/tasks/${task.id}`) return task;
        if (url.startsWith("/api/files")) {
          fileRequestCount += 1;
          if (fileRequestCount === 1) {
            return {
              files: {
                items: [],
                nextCursor: "empty-file-cursor",
              },
            };
          }
          if (!continuationOnline)
            throw new Error("Files continuation offline");
          return { files: { items: [] } };
        }
        return { artifacts: [] };
      },
      scheduleAnimationFrame: (callback) => paintCallbacks.push(callback),
    });

    await hydrateTask(harness, task);
    await waitFor(
      () => harness.taskPanelBody.querySelector(".task-file-loading"),
      "the empty Files page continuation",
    );
    const pending = harness.taskPanelBody.querySelector(".task-file-loading");
    assert.equal(pending.textContent, "Loading remaining files...");
    assert.equal(pending.getAttribute("role"), "status");
    assert.equal(pending.getAttribute("aria-live"), "polite");
    assert.equal(harness.taskPanelBody.querySelector(".task-file-empty"), null);
    assert.equal(
      findByText(harness.taskPanelBody, "Mark done", "button").disabled,
      true,
    );
    assert.equal(paintCallbacks.length, 1);

    paintCallbacks.shift()();
    const continuationError = await waitFor(
      () => harness.taskPanelBody.querySelector(".task-file-error"),
      "the failed empty Files continuation",
    );
    assert.match(
      continuationError.textContent,
      /More files are available, but loading failed: Files continuation offline/,
    );
    assert.equal(continuationError.getAttribute("role"), "alert");
    assert.equal(continuationError.getAttribute("aria-live"), "assertive");
    assert.ok(findByText(continuationError, "Retry loading files", "button"));
    assert.equal(harness.taskPanelBody.querySelector(".task-file-empty"), null);
    assert.match(
      harness.requests.filter((entry) => entry.url.startsWith("/api/files"))[1]
        .url,
      /cursor=empty-file-cursor/,
    );
    assert.match(
      findByText(harness.taskPanelBody, "Mark done", "button").title,
      /Upload required file/,
    );

    continuationOnline = true;
    await findByText(
      continuationError,
      "Retry loading files",
      "button",
    ).click();
    await waitFor(
      () => harness.taskPanelBody.querySelector(".task-file-empty"),
      "the terminal empty Files page",
    );
    assert.equal(
      harness.taskPanelBody.querySelector(".task-file-empty").textContent,
      "No files attached.",
    );
    assert.equal(harness.taskPanelBody.querySelector(".task-file-error"), null);
    assert.equal(
      findByText(harness.taskPanelBody, "Mark done", "button").disabled,
      true,
    );
    assert.equal(fileRequestCount, 3);
  });

  test("exposes a failed continuation while retaining visible Files", async () => {
    let continuationOnline = false;
    let fileRequestCount = 0;
    const paintCallbacks = [];
    const task = {
      id: "task-visible-paged-files",
      version: 1,
      status: "todo",
      description: "Attach paged evidence",
      taskHistory: [],
      requiresFile: true,
    };
    const harness = createHarness({
      request: async (url) => {
        if (url === `/api/tasks/${task.id}`) return task;
        if (url.startsWith("/api/files")) {
          fileRequestCount += 1;
          if (fileRequestCount === 1) {
            return {
              files: {
                items: [{ id: "file-a", filename: "first.pdf" }],
                nextCursor: "visible-file-cursor",
              },
            };
          }
          if (!continuationOnline)
            throw new Error("Files continuation offline");
          return {
            files: {
              items: [
                { id: "file-a", filename: "first.pdf" },
                { id: "file-b", filename: "second.pdf" },
              ],
            },
          };
        }
        return { artifacts: [] };
      },
      scheduleAnimationFrame: (callback) => paintCallbacks.push(callback),
    });

    await hydrateTask(harness, task);
    await waitFor(
      () =>
        harness.taskPanelBody.querySelector(".task-file-item") &&
        harness.taskPanelBody.querySelector(".task-file-loading"),
      "the first Files page and scheduled continuation",
    );
    paintCallbacks.shift()();
    const continuationError = await waitFor(
      () => harness.taskPanelBody.querySelector(".task-file-error"),
      "the failed non-empty Files continuation",
    );
    assert.match(
      continuationError.textContent,
      /More files are available, but loading failed: Files continuation offline/,
    );
    assert.deepEqual(
      harness.taskPanelBody
        .querySelectorAll(".task-file-item")
        .map((item) => item.textContent),
      ["first.pdfRemove"],
    );
    assert.equal(paintCallbacks.length, 0);

    continuationOnline = true;
    await findByText(
      continuationError,
      "Retry loading files",
      "button",
    ).click();
    await waitFor(
      () =>
        harness.taskPanelBody.querySelectorAll(".task-file-item").length ===
          2 && !harness.taskPanelBody.querySelector(".task-file-error"),
      "the duplicate-free recovered Files list",
    );
    assert.deepEqual(
      harness.taskPanelBody
        .querySelectorAll(".task-file-item")
        .map((item) => item.textContent),
      ["first.pdfRemove", "second.pdfRemove"],
    );
    assert.equal(fileRequestCount, 3);
  });

  test("shows an accessible pending state before the first Files page settles", async () => {
    const task = {
      id: "task-initial-files-loading",
      version: 1,
      status: "todo",
      description: "Attach evidence",
      taskHistory: [],
      requiresFile: true,
    };
    let resolveFiles;
    const paintCallbacks = [];
    const harness = createHarness({
      request: async (url) => {
        if (url === `/api/tasks/${task.id}`) return task;
        if (url.startsWith("/api/files")) {
          await new Promise((resolve) => {
            resolveFiles = resolve;
          });
          return { files: { items: [] } };
        }
        return { artifacts: [] };
      },
      scheduleAnimationFrame: (callback) => paintCallbacks.push(callback),
    });

    const hydration = hydrateTask(harness, task);
    const pending = await waitFor(
      () => harness.taskPanelBody.querySelector(".task-file-loading"),
      "the initial Files loading state",
    );
    assert.equal(pending.textContent, "Loading files...");
    assert.equal(pending.getAttribute("role"), "status");
    assert.equal(pending.getAttribute("aria-live"), "polite");
    assert.equal(harness.taskPanelBody.querySelector(".task-file-empty"), null);

    resolveFiles();
    await hydration;
    await waitFor(
      () =>
        harness.taskPanelBody.querySelector(".task-file-empty") &&
        !harness.taskPanelBody.querySelector(".task-file-loading"),
      "the terminal empty Files state",
    );
    assert.equal(paintCallbacks.length, 0);
  });

  test("distinguishes an initial file outage from a failed continuation and retries cleanly", async () => {
    const task = {
      id: "task-file-outage",
      version: 1,
      status: "todo",
      description: "Recover file evidence",
      taskHistory: [],
      requiresFile: true,
    };
    let filesOnline = false;
    const harness = createHarness({
      request: async (url) => {
        if (url === `/api/tasks/${task.id}`) return task;
        if (url.startsWith("/api/files")) {
          if (!filesOnline) throw new Error("Files offline");
          return { files: { items: [{ id: "file-recovered" }] } };
        }
        return { artifacts: [] };
      },
    });

    await hydrateTask(harness, task);
    const outage = await waitFor(
      () => harness.taskPanelBody.querySelector(".task-file-error"),
      "the initial Files outage",
    );
    assert.match(
      outage.textContent,
      /Files could not be loaded: Files offline/,
    );

    filesOnline = true;
    await harness.taskPanelBody
      .querySelector("[data-retry-task-files]")
      .click();
    await waitFor(
      () =>
        !harness.taskPanelBody.querySelector(".task-file-error") &&
        harness.taskPanelBody.querySelector(".task-file-item"),
      "recovered Files",
    );
    assert.equal(harness.taskPanelBody.querySelector(".task-file-error"), null);
    assert.match(
      harness.taskPanelBody.querySelector(".task-file-item").textContent,
      /file-recovered/,
    );
  });

  test("hydrates active and archived Cards, updates stages, and opens nested Tasks canonically", async () => {
    const card = {
      id: "card-1",
      version: 1,
      title: "August newsletter",
      stage: "preparation",
      status: "active",
      taskCount: 1,
      openTaskCount: 1,
      references: [],
    };
    const archived = {
      id: "card-done",
      version: 2,
      title: "July newsletter",
      status: "archived",
      stage: "done",
      taskCount: 1,
      openTaskCount: 0,
      completedAt: "2026-07-31T12:00:00.000Z",
      completedBy: "operator",
      activeStageBeforeCompletion: "after-event",
    };
    const task = {
      id: "card-task",
      version: 1,
      taskHistory: [],
      cardId: card.id,
      description: "Collect links",
      status: "todo",
    };
    const harness = createHarness({
      cards: [card, archived],
      request: async (url, requestOptions = {}) => {
        if (url === "/api/cards/card-1" && !requestOptions.method) {
          return card;
        }
        if (url === "/api/tasks?cardId=card-1") return { tasks: [task] };
        if (url === "/api/artifacts?cardId=card-1") {
          return { artifacts: [] };
        }
        if (url === "/api/cards/card-1" && requestOptions.method === "PUT") {
          return { ...card, ...JSON.parse(requestOptions.body) };
        }
        return {};
      },
    });

    await harness.api.openCardPanel(archived.id);
    assert.equal(harness.navigations[0].path, "/cards/archive");
    assert.deepEqual(harness.navigations[0].params, { cardId: archived.id });

    harness.api.prepareCardPanel(card.id);
    await harness.api.hydrateCardPanel(card.id, 1);
    assert.equal(harness.cardPanelTitle.textContent, "August newsletter");
    assert.ok(findByText(harness.cardPanelBody, "Tasks", "div"));

    const stage = harness.cardPanelBody.querySelector("select");
    stage.value = "announced";
    await stage.dispatch("change");
    const stageRequest = harness.requests.find(
      (entry) =>
        entry.url === "/api/cards/card-1" &&
        entry.options.method === "PUT" &&
        jsonBody(entry).stage,
    );
    assert.deepEqual(jsonBody(stageRequest), {
      stage: "announced",
      expectedVersion: 1,
    });

    const nestedTask = findByText(
      harness.cardPanelBody,
      "Collect links",
      "button",
    );
    await nestedTask.click();
    const nested = harness.navigations.at(-1);
    assert.equal(nested.path, "/cards");
    assert.deepEqual(nested.params, {
      cardId: "card-1",
      taskId: "card-task",
    });
  });

  test("keeps long Card detail values breakable without changing their text or URL values", async () => {
    const card = {
      id: "card-narrow",
      title: "Narrow Card",
      description:
        "Review the long Card description and keep every operator-provided detail readable on a phone.",
      stage: "preparation",
      cardLinks: [
        {
          name: "Long external publication destination",
          url: "https://example.test/publication/destination/with/a/long/path",
        },
      ],
      references: [
        {
          name: "External reference with a long operator-provided label",
          url: "https://example.test/process/reference",
        },
      ],
    };
    const task = {
      id: "task-narrow",
      version: 1,
      taskHistory: [],
      cardId: card.id,
      description:
        "Review the long checklist item title without forcing the Card detail panel wider than the viewport.",
      status: "todo",
    };
    const harness = createHarness({
      cards: [card],
      request: async (url) => {
        if (url === `/api/cards/${card.id}`) return card;
        if (url === `/api/tasks?cardId=${card.id}`) return { tasks: [task] };
        if (url === `/api/artifacts?cardId=${card.id}`)
          return { artifacts: [] };
        return {};
      },
    });

    harness.api.prepareCardPanel(card.id);
    await harness.api.hydrateCardPanel(card.id, 1);

    assert.equal(harness.cardPanelTitle.textContent, card.title);
    assert.equal(
      harness.cardPanelBody.querySelector(".workflow-description").textContent,
      card.description,
    );
    assert.equal(
      harness.cardPanelBody.querySelector(".card-link-name").textContent,
      card.cardLinks[0].name,
    );
    assert.equal(
      harness.cardPanelBody.querySelector(".card-link-input").value,
      card.cardLinks[0].url,
    );
    assert.equal(
      harness.cardPanelBody.querySelector(".card-checklist-label").textContent,
      task.description,
    );
    assert.equal(
      harness.cardPanelBody.querySelector(".workflow-references-section a")
        .textContent,
      card.references[0].name,
    );
    assert.ok(harness.cardPanelBody.querySelector("wbr"));
  });

  test("retains Card drafts through review, repeated conflict, retry, and discard", async () => {
    const card = {
      id: "card-conflict",
      version: 1,
      title: "Conflict Card",
      status: "active",
      stage: "preparation",
      taskCount: 0,
      openTaskCount: 0,
      references: [],
    };
    let putAttempt = 0;
    const conflictError = (currentCard) => {
      const error = new Error("Card changed");
      error.status = 409;
      error.code = "card_version_conflict";
      error.payload = { code: error.code, currentCard };
      return error;
    };
    const harness = createHarness({
      cards: [card],
      request: async (url, requestOptions = {}) => {
        if (url === "/api/cards/card-conflict" && !requestOptions.method)
          return card;
        if (url === "/api/tasks?cardId=card-conflict") return { tasks: [] };
        if (url === "/api/artifacts?cardId=card-conflict")
          return { artifacts: [] };
        if (
          url === "/api/cards/card-conflict" &&
          requestOptions.method === "PUT"
        ) {
          putAttempt += 1;
          if (putAttempt === 1) {
            throw conflictError({ ...card, version: 2, stage: "announced" });
          }
          if (putAttempt === 2) {
            throw conflictError({ ...card, version: 3, stage: "after-event" });
          }
          return {
            ...card,
            ...jsonBody({ options: requestOptions }),
            version: 4,
          };
        }
        return {};
      },
    });
    harness.api.prepareCardPanel(card.id);
    await harness.api.hydrateCardPanel(card.id, 1);

    const firstSelect = harness.cardPanelBody.querySelector("select");
    firstSelect.value = "announced";
    await firstSelect.dispatch("change");
    let alert = harness.cardPanelBody.querySelector('[role="alert"]');
    assert.ok(alert);
    assert.match(alert.textContent, /version 2/);
    assert.match(alert.textContent, /Set stage to Announced/);
    assert.deepEqual(jsonBody(harness.requests.at(-1)), {
      stage: "announced",
      expectedVersion: 1,
    });

    await findByText(alert, "Review latest", "button").click();
    assert.match(harness.cardPanelBody.textContent, /version 2/);
    await findByText(
      harness.cardPanelBody,
      "Retry my change",
      "button",
    ).click();
    alert = harness.cardPanelBody.querySelector('[role="alert"]');
    assert.match(alert.textContent, /version 3/);
    assert.deepEqual(jsonBody(harness.requests.at(-1)), {
      stage: "announced",
      expectedVersion: 2,
    });

    await findByText(alert, "Discard my change", "button").click();
    assert.equal(harness.cardPanelBody.querySelector('[role="alert"]'), null);
    const latestSelect = harness.cardPanelBody.querySelector("select");
    assert.equal(
      latestSelect.querySelectorAll("option").find((option) => option.selected)
        ?.value,
      "after-event",
    );
    latestSelect.value = "preparation";
    await latestSelect.dispatch("change");
    assert.deepEqual(jsonBody(harness.requests.at(-1)), {
      stage: "preparation",
      expectedVersion: 3,
    });
  });

  test("reviews, cancels, and applies a Card Template update without hiding retention rules", async () => {
    const card = {
      id: "card-template-update",
      version: 3,
      title: "Template-backed Card",
      stage: "preparation",
      templateId: "template-1",
      templateVersion: 1,
      references: [],
    };
    const task = {
      id: "task-existing",
      version: 2,
      cardId: card.id,
      description: "Existing task",
      status: "todo",
    };
    const preview = {
      state: "update-available",
      sourceTemplateVersion: 1,
      targetTemplateVersion: 2,
      previewToken: "a".repeat(64),
      counts: {
        cardFields: 1,
        added: 1,
        updated: 1,
        archived: 1,
        retainedCompleted: 1,
        operatorOverrides: 1,
      },
      cardChanges: [{ field: "tags", operatorOverride: false }],
      taskChanges: [
        {
          action: "add",
          taskRef: "publish",
          targetLabel: "Publish recording",
          changes: [],
          operatorOverrideFields: [],
        },
        {
          action: "retain-completed",
          taskRef: "host",
          currentLabel: "Host event",
          changes: [],
          operatorOverrideFields: [],
        },
      ],
    };
    let statusLoads = 0;
    const harness = createHarness({
      cards: [card],
      request: async (url, requestOptions = {}) => {
        if (url === `/api/cards/${card.id}` && !requestOptions.method)
          return { card };
        if (url === `/api/tasks?cardId=${card.id}`) return { tasks: [task] };
        if (url === `/api/artifacts?cardId=${card.id}`)
          return { artifacts: [] };
        if (
          url === `/api/cards/${card.id}/template-update` &&
          !requestOptions.method
        ) {
          statusLoads += 1;
          return statusLoads === 1
            ? { preview }
            : {
                preview: {
                  ...preview,
                  state: "current",
                  sourceTemplateVersion: 2,
                },
              };
        }
        if (
          url === `/api/cards/${card.id}/template-update` &&
          requestOptions.method === "POST"
        ) {
          return {
            applied: true,
            card: { ...card, version: 4, templateVersion: 2 },
            tasks: [task],
          };
        }
        throw new Error(`Unexpected request ${url}`);
      },
    });
    harness.api.prepareCardPanel(card.id);
    await harness.api.hydrateCardPanel(card.id, 1);

    assert.match(
      harness.cardPanelBody.textContent,
      /Update available: Template v1 → v2/,
    );
    await findByText(
      harness.cardPanelBody,
      "Review template update",
      "button",
    ).click();
    assert.match(
      harness.cardPanelBody.textContent,
      /Removed incomplete tasks are archived/,
    );
    assert.match(
      harness.cardPanelBody.textContent,
      /1 operator override field will take/,
    );
    assert.ok(findByText(harness.cardPanelBody, "Add Publish recording", "li"));
    assert.ok(
      findByText(
        harness.cardPanelBody,
        "Retain completed task: Host event",
        "li",
      ),
    );

    await findByText(harness.cardPanelBody, "Cancel", "button").click();
    assert.equal(
      findByText(harness.cardPanelBody, "Apply reviewed update", "button"),
      undefined,
    );
    await findByText(
      harness.cardPanelBody,
      "Review template update",
      "button",
    ).click();
    await findByText(
      harness.cardPanelBody,
      "Apply reviewed update",
      "button",
    ).click();
    await nextTicks();

    const apply = harness.requests.find(
      (entry) =>
        entry.url === `/api/cards/${card.id}/template-update` &&
        entry.options.method === "POST",
    );
    assert.deepEqual(jsonBody(apply), { previewToken: "a".repeat(64) });
    assert.match(harness.cardPanelBody.textContent, /Current at Template v2/);
  });

  test("retains the open review after a stale preview and reloads only on request", async () => {
    const card = {
      id: "card-template-conflict",
      version: 3,
      title: "Conflicted Card",
      templateId: "template-1",
      templateVersion: 1,
      cardLinks: [{ name: "Draft output", url: "" }],
      references: [],
    };
    const preview = {
      state: "update-available",
      sourceTemplateVersion: 1,
      targetTemplateVersion: 2,
      previewToken: "b".repeat(64),
      counts: {
        added: 1,
        updated: 0,
        archived: 0,
        retainedCompleted: 0,
        cardFields: 0,
        operatorOverrides: 0,
      },
      cardChanges: [],
      taskChanges: [
        {
          action: "add",
          taskRef: "new",
          targetLabel: "New task",
          changes: [],
          operatorOverrideFields: [],
        },
      ],
    };
    let previewLoads = 0;
    const harness = createHarness({
      cards: [card],
      request: async (url, requestOptions = {}) => {
        if (url === `/api/cards/${card.id}` && !requestOptions.method)
          return { card };
        if (url === `/api/tasks?cardId=${card.id}`) return { tasks: [] };
        if (url === `/api/artifacts?cardId=${card.id}`)
          return { artifacts: [] };
        if (
          url === `/api/cards/${card.id}/template-update` &&
          !requestOptions.method
        ) {
          previewLoads += 1;
          return {
            preview: {
              ...preview,
              previewToken: (previewLoads === 1 ? "b" : "c").repeat(64),
            },
          };
        }
        if (
          url === `/api/cards/${card.id}/template-update` &&
          requestOptions.method === "POST"
        ) {
          const error = new Error("conflict");
          error.status = 409;
          throw error;
        }
        throw new Error(`Unexpected request ${url}`);
      },
    });
    harness.api.prepareCardPanel(card.id);
    await harness.api.hydrateCardPanel(card.id, 1);
    await findByText(
      harness.cardPanelBody,
      "Review template update",
      "button",
    ).click();
    harness.cardPanelBody.querySelector(".card-link-input").value =
      "https://example.test/draft";
    harness.cardPanelBody.querySelector(".card-ref-name").value =
      "Typed reference";
    await findByText(
      harness.cardPanelBody,
      "Apply reviewed update",
      "button",
    ).click();
    await nextTicks();

    assert.match(harness.cardPanelBody.textContent, /Your review is retained/);
    assert.ok(findByText(harness.cardPanelBody, "Add New task", "li"));
    assert.equal(
      harness.cardPanelBody.querySelector(".card-link-input").value,
      "https://example.test/draft",
    );
    assert.equal(
      harness.cardPanelBody.querySelector(".card-ref-name").value,
      "Typed reference",
    );
    assert.equal(previewLoads, 1);
    await findByText(
      harness.cardPanelBody,
      "Reload latest preview",
      "button",
    ).click();
    await nextTicks();
    assert.equal(previewLoads, 2);
    assert.equal(
      harness.cardPanelBody.querySelector(".card-link-input").value,
      "https://example.test/draft",
    );
    assert.equal(
      harness.cardPanelBody.querySelector(".card-ref-name").value,
      "Typed reference",
    );
  });

  test("ignores a Card template response from an older route token", async () => {
    const card = {
      id: "card-stale-template",
      version: 1,
      title: "Stale template Card",
      templateId: "template-1",
      templateVersion: 1,
      references: [],
    };
    let initialPreview = true;
    let releasePreview;
    const delayedPreview = new Promise((resolve) => {
      releasePreview = resolve;
    });
    const harness = createHarness({
      cards: [card],
      request: async (url, requestOptions = {}) => {
        if (url === `/api/cards/${card.id}` && !requestOptions.method) {
          return { card };
        }
        if (url === `/api/tasks?cardId=${card.id}`) return { tasks: [] };
        if (url === `/api/artifacts?cardId=${card.id}`) return { artifacts: [] };
        if (
          url === `/api/cards/${card.id}/template-update` &&
          !requestOptions.method
        ) {
          if (initialPreview) {
            initialPreview = false;
            throw new Error("Synthetic preview unavailable");
          }
          return delayedPreview;
        }
        throw new Error(`Unexpected request ${url}`);
      },
    });

    harness.api.prepareCardPanel(card.id);
    await harness.api.hydrateCardPanel(card.id, 1);
    const reload = findByText(
      harness.cardPanelBody,
      "Reload template status",
      "button",
    ).click();
    await nextTicks();
    harness.setRouteToken(2);
    harness.api.prepareCardPanel("new-card");
    releasePreview({ preview: { state: "current", targetTemplateVersion: 2 } });
    await reload;

    assert.equal(harness.cardPanelTitle.textContent, "Loading card...");
    assert.equal(harness.cardPanelBody.textContent, "Loading card new-card…");
  });

  test("does not apply a stale Card artifact refresh to a re-entered panel", async () => {
    const card = {
      id: "card-stale-artifacts",
      version: 1,
      title: "Stale artifacts Card",
      stage: "preparation",
      references: [],
    };
    let cardArtifactLoads = 0;
    let releaseRefresh;
    const delayedRefresh = new Promise((resolve) => {
      releaseRefresh = resolve;
    });
    const harness = createHarness({
      cards: [card],
      request: async (url, requestOptions = {}) => {
        if (url === `/api/cards/${card.id}` && !requestOptions.method) {
          return { card };
        }
        if (url === `/api/tasks?cardId=${card.id}`) return { tasks: [] };
        if (url === `/api/artifacts?cardId=${card.id}`) {
          cardArtifactLoads += 1;
          return cardArtifactLoads === 1
            ? { artifacts: [] }
            : delayedRefresh;
        }
        if (url === "/api/artifacts" && requestOptions.method === "POST") {
          return { id: "stale-artifact" };
        }
        return {};
      },
    });

    harness.api.prepareCardPanel(card.id);
    await harness.api.hydrateCardPanel(card.id, 1);
    const urlInput = harness.cardPanelBody.querySelector(
      '[data-panel-field="artifact-url"]',
    );
    urlInput.value = "https://example.invalid/stale-artifact";
    const registration = findByText(
      harness.cardPanelBody,
      "Register",
      "button",
    ).click();
    await nextTicks();
    harness.setRouteToken(2);
    harness.api.prepareCardPanel("new-card");
    releaseRefresh({ artifacts: [{ id: "stale-artifact" }] });
    await registration;

    assert.equal(harness.cardPanelTitle.textContent, "Loading card...");
    assert.equal(harness.cardPanelBody.textContent, "Loading card new-card…");
  });

  test("registers Card references and registers plus approves external artifacts", async () => {
    const card = {
      id: "card-refs",
      title: "Conference launch",
      stage: "preparation",
      references: [],
    };
    const harness = createHarness({
      cards: [card],
      request: async (url, requestOptions = {}) => {
        if (url === "/api/cards/card-refs" && !requestOptions.method) {
          return card;
        }
        if (url === "/api/tasks?cardId=card-refs") return { tasks: [] };
        if (url === "/api/artifacts?cardId=card-refs") {
          return { artifacts: [] };
        }
        if (url === "/api/cards/card-refs" && requestOptions.method === "PUT") {
          return { ...card, ...JSON.parse(requestOptions.body) };
        }
        return {};
      },
    });
    harness.api.prepareCardPanel(card.id);
    await harness.api.hydrateCardPanel(card.id, 1);

    const name = harness.cardPanelBody.querySelector(".card-ref-name");
    const url = harness.cardPanelBody.querySelector(".card-ref-url");
    name.value = "Internal launch process";
    url.value = "/docs/launch";
    await findByText(harness.cardPanelBody, "Add", "button").click();
    const referenceRequest = harness.requests.find(
      (entry) =>
        entry.url === "/api/cards/card-refs" && entry.options.method === "PUT",
    );
    assert.deepEqual(jsonBody(referenceRequest), {
      references: [{ name: "Internal launch process", url: "/docs/launch" }],
    });

    const artifact = harness.api.renderArtifactList({
      ownerType: "task",
      ownerId: "task-proof",
      artifacts: [
        {
          id: "artifact-1",
          title: "Draft announcement",
          storageUri: "https://example.com/draft",
          status: "needs-review",
        },
      ],
    });
    const inputs = artifact.querySelectorAll("input");
    inputs[0].value = "Published announcement";
    inputs[1].value = "https://example.com/published";
    await findByText(artifact, "Register", "button").click();
    await findByText(artifact, "Approve", "button").click();

    const register = harness.requests.find(
      (entry) =>
        entry.url === "/api/artifacts" && entry.options.method === "POST",
    );
    assert.deepEqual(jsonBody(register), {
      type: "external-link",
      title: "Published announcement",
      storageUri: "https://example.com/published",
      storageProvider: "external-url",
      dataClass: "internal",
      sourceType: "manual-link",
      status: "needs-review",
      taskId: "task-proof",
    });
    const approve = harness.requests.find(
      (entry) =>
        entry.url === "/api/artifacts/artifact-1" &&
        entry.options.method === "PUT",
    );
    assert.deepEqual(jsonBody(approve), { status: "approved" });
  });

  test("ignores stale Task responses and exposes not-found retry plus return recovery", async () => {
    let resolveStale;
    const staleResponse = new Promise((resolve) => {
      resolveStale = resolve;
    });
    const stale = createHarness({
      request: (url) =>
        url === "/api/tasks/stale-task"
          ? staleResponse
          : Promise.resolve({ artifacts: [] }),
    });
    stale.api.prepareTaskPanel("stale-task");
    const hydration = stale.api.hydrateTaskPanel("stale-task", 1);
    stale.setFresh(false);
    resolveStale({ id: "stale-task", description: "Old response" });
    await hydration;
    assert.equal(stale.taskPanelTitle.textContent, "Loading task...");
    assert.equal(stale.entityStates.length, 0);

    const notFoundError = new Error("Missing task");
    notFoundError.status = 404;
    const missing = createHarness({
      routeToken: 2,
      route: {
        path: "/tasks",
        params: new URLSearchParams("taskId=missing-task"),
        invalid: false,
      },
      request: async (url) => {
        if (url === "/api/tasks/missing-task") throw notFoundError;
        return {};
      },
    });
    missing.api.prepareTaskPanel("missing-task");
    await missing.api.hydrateTaskPanel("missing-task", 2);
    assert.equal(missing.taskPanelTitle.textContent, "Task not found");
    assert.equal(missing.entityStates.at(-1).status, "not-found");

    missing.entityStates.at(-1).retry();
    assert.deepEqual(missing.navigations.at(-1).options, { history: "none" });
    await missing.entityStates.at(-1).returnToList();
    assert.equal(missing.navigations.at(-1).params.has("taskId"), false);
  });
});
