import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import {
  addDaysIso,
  formatTaskDateMeta,
  hasApprovedArtifactEvidence,
  hasTaskFileEvidence,
  isArchivedWorkCard,
  isOpenWorkTask,
  isParkedWorkCard,
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
  // Routes carry the dialogs they name, as parseWorkspaceLocation sets them.
  const withModals = (value) => {
    const cardParam = ["/cards", "/cards/archive"].includes(value.path) ? "cardId" : "card";
    const params = value.params instanceof URLSearchParams ? value.params : new URLSearchParams(value.params);
    return {
      cardParam,
      modalCardId: params.get(cardParam) || "",
      modalTaskId: params.get("taskId") || "",
      ...value,
    };
  };
  let route = withModals(options.route || {
    path: "/tasks",
    params: new URLSearchParams(),
    invalid: false,
  });
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
    getCurrentOperator: () => options.operator || ({ id: "alexey", name: "Alexey" }),
    hasApprovedArtifactEvidence,
    hasTaskFileEvidence,
    isArchivedWorkCard,
    isParkedWorkCard,
    isOpenWorkTask,
    isWorkspaceRouteFresh: (token) => fresh && token === routeToken,
    labelizeWorkValue: (value) =>
      String(value || "")
        .split("-")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" "),
    localDocPathFromHref: (href) =>
      /^\/?content\/.+\.md$/.test(String(href)) ? String(href).replace(/^\//, "") : "",
    navigateCanonicalWorkspace: (path, params = {}, navigationOptions = {}) => {
      navigations.push({ path, params, options: navigationOptions });
      return { ready: Promise.resolve() };
    },
    openQualityFinding() {},
    parseWorkspaceLocation: () => route,
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
    resolveDocReference: options.resolveDocReference || (() => null),
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
    requests,
    setFresh: (value) => {
      fresh = value;
    },
    setRouteToken: (value) => {
      routeToken = value;
    },
    setRoute: (value) => {
      route = withModals(value);
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
  });

  test("opens a Home task over Home and closes back to it", async () => {
    const harness = createHarness({
      route: { path: "/", params: new URLSearchParams(), invalid: false },
    });

    await harness.api.openTaskPanel("queue-task");
    assert.equal(harness.navigations.at(-1).path, "/");
    assert.equal(harness.navigations.at(-1).params.toString(), "taskId=queue-task");
    harness.setRoute({
      path: "/",
      params: new URLSearchParams("taskId=queue-task"),
      invalid: false,
    });
    await harness.api.closeTaskPanel();

    const close = harness.navigations.at(-1);
    assert.equal(close.path, "/");
    assert.equal(close.params.toString(), "");
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

  test("wraps Card dialog focus from a collapsed form summary back to Close", () => {
    const harness = createHarness();
    harness.api.prepareCardPanel("card-1");
    const details = new FakeElement("details");
    const summary = new FakeElement("summary");
    summary.textContent = "+ Add process reference";
    const hiddenInput = new FakeElement("input");
    details.append(summary, hiddenInput);
    harness.cardPanelClose.parentElement.append(details);
    harness.document.activeElement = summary;
    let prevented = false;
    harness.api.handleWorkspaceEntityModalKeydown({
      defaultPrevented: false,
      key: "Tab", shiftKey: false,
      preventDefault: () => { prevented = true; },
    });
    assert.equal(prevented, true);
    assert.equal(harness.cardPanelClose.focused, true);
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

  test("renders a skipped Task muted with its reason and an Unskip action", async () => {
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
      status: "skipped",
      skipReason: "Removed from the Card Template",
      skippedAt: "2026-08-12T10:00:00.000Z",
      skippedBy: "operator",
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
    assert.ok(findByText(harness.taskPanelBody, "Removed from the Card Template", "p"));
    assert.equal(findByText(harness.taskPanelBody, "Skip…", "button"), undefined);
    const unskip = findByText(harness.taskPanelBody, "Unskip", "button");
    assert.ok(unskip);
    await unskip.click();
    await nextTicks();
    const posted = harness.requests.find(({ url }) => url.endsWith("/actions/unskip"));
    assert.deepEqual(jsonBody(posted), { expectedVersion: 4 });
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
    assert.match(harness.taskPanelBody.querySelector(".task-status-badge").textContent, /waiting/i);
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
    assert.match(harness.taskPanelBody.querySelector(".task-status-badge").textContent, /todo/i);
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

  test("a retried final-Task conflict completes the Card without leaving the page", async () => {
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
    // Done keeps the operator where they are; the Card moved to the Archive.
    assert.equal(harness.navigations.some(({ path }) => path.startsWith("/cards")), false);
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

  function requiresHarness(task, resources, { snapshotResources = true } = {}) {
    return createHarness({
      workSnapshot: snapshotResources
        ? {
          resources,
          resourcesById: new Map(resources.map((resource) => [resource.id, resource])),
        }
        : {},
      request: async (url, requestOptions = {}) => {
        if (url === `/api/tasks/${task.id}` && !requestOptions.method) return task;
        if (url === "/api/resources") return { resources };
        if (url.startsWith("/api/files")) return { files: { items: [] } };
        if (url.startsWith("/api/artifacts")) return { artifacts: [] };
        if (url === `/api/tasks/${task.id}` && requestOptions.method === "PUT") {
          const body = JSON.parse(requestOptions.body);
          return { ...task, requires: body.requires, version: task.version + 1 };
        }
        return {};
      },
    });
  }

  const requiresResources = [
    { id: "youtube", name: "YouTube", icon: "video", access: "Channel" },
    { id: "luma", name: "Luma", icon: "ticket", access: "Calendar" },
    { id: "gmail", name: "Gmail", icon: "mail", access: "Mailbox" },
  ];

  function requiresTask(id) {
    return {
      id,
      version: 4,
      taskHistory: [],
      description: "Create events on Luma",
      status: "todo",
      requires: ["luma", "youtube"],
    };
  }

  async function typeAndAdd(field, text) {
    field.value = text;
    await field.dispatch("input");
    await field.dispatch("keydown", { key: "Enter" });
  }

  test("names what a Task needs and saves a tag-input edit once, with the Task version", async () => {
    const task = requiresTask("task-requires");
    const harness = requiresHarness(task, requiresResources);

    await hydrateTask(harness, task);
    let section = findAllByClass(harness.taskPanelBody, "task-requires")[0];
    assert.deepEqual(
      findAllByClass(section, "ops-resource-name").map((name) => name.textContent),
      ["Luma", "YouTube"],
    );
    assert.equal(section.querySelector("input"), null, "read-only until edited");
    await section.querySelector("[data-requires-edit]").click();

    section = findAllByClass(harness.taskPanelBody, "task-requires")[0];
    const field = section.querySelector('[data-panel-field="requires"]');
    assert.equal(field.getAttribute("role"), "combobox");
    assert.equal(harness.document.activeElement, field, "the editor takes focus");
    assert.deepEqual(
      findAllByClass(section, "dk-tag-input__chip").map((chip) => chip.dataset.value),
      ["luma", "youtube"],
    );
    await typeAndAdd(field, "GM");
    await findAllByClass(section, "dk-tag-input__remove")
      .find((button) => button.getAttribute("aria-label") === "Remove YouTube")
      .click();
    assert.deepEqual(
      findAllByClass(section, "dk-tag-input__chip").map((chip) => chip.dataset.value),
      ["luma", "gmail"],
    );
    assert.equal(
      harness.requests.filter((entry) => entry.options.method === "PUT").length,
      0,
      "nothing is written before Save",
    );

    await findByText(section, "Save", "button").click();
    await waitFor(
      () => harness.requests.find((entry) => entry.options.method === "PUT"),
      "requires write",
    );
    const writes = harness.requests.filter((entry) => entry.options.method === "PUT");
    assert.equal(writes.length, 1);
    assert.deepEqual(jsonBody(writes[0]), { requires: ["luma", "gmail"], expectedVersion: 4 });
    assert.deepEqual(harness.errors, []);
  });

  test("cancelling a Needs edit writes nothing and restores the read-only chips", async () => {
    const task = requiresTask("task-requires-cancel");
    const harness = requiresHarness(task, requiresResources);

    await hydrateTask(harness, task);
    await harness.taskPanelBody.querySelector("[data-requires-edit]").click();
    const field = harness.taskPanelBody.querySelector('[data-panel-field="requires"]');
    await typeAndAdd(field, "gmail");
    await findByText(harness.taskPanelBody, "Cancel", "button").click();

    const section = findAllByClass(harness.taskPanelBody, "task-requires")[0];
    assert.equal(section.querySelector('[data-panel-field="requires"]'), null);
    assert.deepEqual(
      findAllByClass(section, "ops-resource-name").map((name) => name.textContent),
      ["Luma", "YouTube"],
    );
    assert.equal(harness.document.activeElement, section.querySelector("[data-requires-edit]"));
    assert.equal(harness.requests.filter((entry) => entry.options.method === "PUT").length, 0);
  });

  test("a Task opened before the work snapshot loads fetches the vocabulary to edit Needs", async () => {
    const task = requiresTask("task-requires-deep-link");
    const harness = requiresHarness(task, requiresResources, { snapshotResources: false });

    await hydrateTask(harness, task);
    await harness.taskPanelBody.querySelector("[data-requires-edit]").click();
    await waitFor(
      () => harness.requests.find((entry) => entry.url === "/api/resources"),
      "vocabulary read",
    );
    const field = await waitFor(() => {
      const input = harness.taskPanelBody.querySelector('[data-panel-field="requires"]');
      return input && !input.disabled ? input : null;
    }, "enabled tag input");
    await typeAndAdd(field, "you");
    const chips = findAllByClass(harness.taskPanelBody, "dk-tag-input__chip");
    assert.deepEqual(chips.map((chip) => chip.dataset.value), ["luma", "youtube"], "YouTube is already chosen, so nothing is added");
    await typeAndAdd(field, "gm");
    assert.deepEqual(
      findAllByClass(harness.taskPanelBody, "dk-tag-input__chip").map((chip) => chip.textContent),
      ["Luma", "YouTube", "Gmail"],
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

  test("keeps a completed Task in the list, struck through, instead of moving it away", async () => {
    const card = {
      id: "card-complete-stays",
      version: 1,
      title: "Stay Card",
      status: "active",
      stage: "preparation",
      taskCount: 2,
      openTaskCount: 2,
      references: [],
    };
    const first = {
      id: "card-complete-first",
      cardId: card.id,
      version: 1,
      taskHistory: [],
      description: "First checklist item",
      status: "todo",
    };
    const second = {
      id: "card-complete-second",
      cardId: card.id,
      version: 1,
      taskHistory: [],
      description: "Second checklist item",
      status: "todo",
    };
    const harness = createHarness({
      cards: [card],
      request: async (url, requestOptions = {}) => {
        if (url === `/api/cards/${card.id}` && !requestOptions.method)
          return card;
        if (url === `/api/tasks?cardId=${card.id}`)
          return { tasks: [first, second] };
        if (url === `/api/artifacts?cardId=${card.id}`)
          return { artifacts: [] };
        if (url === `/api/tasks/${first.id}` && requestOptions.method === "PUT") {
          return { ...first, status: "done", version: 2, cardId: card.id };
        }
        return {};
      },
    });

    harness.api.prepareCardPanel(card.id);
    await harness.api.hydrateCardPanel(card.id, 1);
    const rows = () =>
      harness.cardPanelBody.querySelectorAll(".card-checklist-item");
    assert.equal(rows().length, 2);
    await rows()[0].querySelector('input[type="checkbox"]').dispatch("change");
    const doneRow = await waitFor(() => {
      const items = rows();
      if (items.length !== 2) return null;
      const last = items[items.length - 1];
      const box = last.querySelector('input[type="checkbox"]');
      return box.checked && last.querySelector(".card-checklist-label.is-done")
        ? last
        : null;
    }, "completed Task sinking struck through to the end of the list");
    assert.match(doneRow.textContent, /First checklist item/);
    assert.equal(
      rows()[0].querySelector('input[type="checkbox"]').checked,
      false,
    );
    assert.equal(
      rows()[0].querySelector(".card-checklist-label.is-done"),
      null,
    );
    assert.deepEqual(harness.errors, []);
  });

  test("shows only a real assignee, in one owner column on every checklist row", async () => {
    const card = {
      id: "card-owners",
      version: 1,
      title: "Owner Card",
      status: "active",
      stage: "preparation",
      taskCount: 3,
      openTaskCount: 3,
      references: [],
    };
    const assigned = {
      id: "card-owner-assigned",
      cardId: card.id,
      version: 1,
      taskHistory: [],
      description: "Fill up the Podcast block",
      status: "todo",
      assigneeId: "user-valeriia",
    };
    const mentioned = {
      id: "card-owner-mentioned",
      cardId: card.id,
      version: 1,
      taskHistory: [],
      description: "Ping Valeriia to fill her blocks",
      status: "todo",
    };
    const general = {
      id: "card-owner-general",
      cardId: card.id,
      version: 1,
      taskHistory: [],
      description: "Schedule the newsletter send",
      status: "todo",
    };
    const harness = createHarness({
      cards: [card],
      workSnapshot: {
        usersById: new Map([
          ["user-grace", { id: "user-grace", name: "Grace" }],
          ["user-valeriia", { id: "user-valeriia", name: "Valeriia" }],
        ]),
      },
      request: async (url, requestOptions = {}) => {
        if (url === `/api/cards/${card.id}` && !requestOptions.method)
          return card;
        if (url === `/api/tasks?cardId=${card.id}`)
          return { tasks: [assigned, mentioned, general] };
        if (url === `/api/artifacts?cardId=${card.id}`)
          return { artifacts: [] };
        return {};
      },
    });

    harness.api.prepareCardPanel(card.id);
    await harness.api.hydrateCardPanel(card.id, 1);
    // Every row has the owner slot so avatars line up; only the assigned
    // Task fills it. A name in the title or a default person is not an
    // assignment.
    const slots = harness.cardPanelBody.querySelectorAll(".card-checklist-owner");
    assert.equal(slots.length, 3);
    const owners = harness.cardPanelBody.querySelectorAll(".card-task-owner");
    assert.equal(owners.length, 1);
    assert.equal(owners[0].getAttribute("aria-label"), "Assigned to Valeriia");
    assert.equal(
      owners[0].querySelector(".card-task-owner-avatar").textContent,
      "V",
    );
    assert.deepEqual(harness.errors, []);
  });

  test("marks a skipped Task apart from done ones and keeps its reason on one muted line", async () => {
    const card = { id: "card-skipped-row", version: 1, title: "Skips", stage: "preparation", references: [] };
    const reason = "No longer applicable on 2026-10-15: Building an AI Platform: the guest already sent the invite";
    const tasks = [
      { id: "t-open", cardId: card.id, version: 1, taskHistory: [], description: "Publish the episode", status: "todo" },
      { id: "t-done", cardId: card.id, version: 1, taskHistory: [], description: "Prepare the doc", status: "done" },
      { id: "t-skip", cardId: card.id, version: 1, taskHistory: [], description: "Create a calendar invite", status: "skipped", skipReason: reason },
    ];
    const harness = createHarness({
      cards: [card],
      request: async (url) => {
        if (url === `/api/cards/${card.id}`) return card;
        if (url === `/api/tasks?cardId=${card.id}`) return { tasks };
        if (url === `/api/artifacts?cardId=${card.id}`) return { artifacts: [] };
        return {};
      },
    });
    harness.api.prepareCardPanel(card.id);
    await harness.api.hydrateCardPanel(card.id, 1);

    const rows = [...harness.cardPanelBody.querySelectorAll(".card-checklist-item")];
    assert.deepEqual(
      rows.map((row) => row.querySelector(".card-checklist-label").textContent),
      ["Publish the episode", "Prepare the doc", "Create a calendar invite"],
    );
    const skipped = rows[2];
    assert.equal(skipped.querySelector('input[type="checkbox"]'), null);
    assert.equal(skipped.querySelector(".card-checklist-skip").getAttribute("aria-label"), "Skipped");
    const label = skipped.querySelector(".card-checklist-label");
    assert.equal(label.classList.contains("is-skipped"), true);
    assert.equal(label.classList.contains("is-done"), false);
    const note = skipped.querySelector(".card-checklist-note");
    assert.equal(note.textContent, `Skipped · ${reason}`);
    assert.equal(note.title, `Skipped: ${reason}`);
    assert.ok(skipped.querySelector(".card-checklist-owner"));
    // Done stays a checked, struck-through checkbox row.
    assert.equal(rows[1].querySelector('input[type="checkbox"]').checked, true);
    assert.equal(rows[1].querySelector(".card-checklist-label").classList.contains("is-done"), true);
    // Skipped counts as resolved in the progress, as Card completion does.
    assert.equal(harness.cardPanelBody.querySelector(".card-checklist-percent").textContent, "67%");
  });

  test("renders description link dumps as subheadings with real anchors", async () => {
    const card = {
      id: "card-desc-links",
      version: 1,
      title: "Link Card",
      status: "active",
      stage: "preparation",
      taskCount: 0,
      openTaskCount: 0,
      references: [],
      description:
        'Overview docs:- [Process documents](https://docs.google.com/document/d/ABC123/edit "") - ' +
        '[Newsletter](https://docs.google.com/document/d/XYZ789/edit "") ' +
        "Links:- Sponsorship document: TODO - X link: TODO",
    };
    const harness = createHarness({
      cards: [card],
      request: async (url, requestOptions = {}) => {
        if (url === `/api/cards/${card.id}` && !requestOptions.method)
          return card;
        if (url === `/api/tasks?cardId=${card.id}`) return { tasks: [] };
        if (url === `/api/artifacts?cardId=${card.id}`)
          return { artifacts: [] };
        return {};
      },
    });

    harness.api.prepareCardPanel(card.id);
    await harness.api.hydrateCardPanel(card.id, 1);
    const anchors = harness.cardPanelBody.querySelectorAll(".card-inline-link");
    assert.equal(anchors.length, 2);
    assert.equal(
      anchors[0].getAttribute("href"),
      "https://docs.google.com/document/d/ABC123/edit",
    );
    assert.equal(anchors[0].textContent, "Process documents (opens in new tab)");
    assert.equal(anchors[0].target, "_blank");
    assert.equal(anchors[0].rel, "noopener noreferrer");
    assert.equal(
      anchors[1].getAttribute("href"),
      "https://docs.google.com/document/d/XYZ789/edit",
    );
    const subtitles = harness.cardPanelBody.querySelectorAll(
      ".workflow-description-subtitle",
    );
    assert.deepEqual(
      subtitles.map((subtitle) => subtitle.textContent),
      ["Overview docs:", "Links:"],
    );
    assert.ok(
      !harness.cardPanelBody.textContent.includes("[Process documents]("),
    );
    assert.deepEqual(harness.errors, []);
  });

  test("shows a loading skeleton before the Card content arrives", async () => {
    const card = {
      id: "card-loading",
      version: 1,
      title: "Loading Card",
      status: "active",
      stage: "preparation",
      taskCount: 0,
      openTaskCount: 0,
      references: [],
    };
    const harness = createHarness({ cards: [card] });

    harness.api.prepareCardPanel(card.id);
    const skeleton = harness.cardPanelBody.querySelector(
      ".card-loading-skeleton",
    );
    assert.ok(skeleton);
    assert.equal(skeleton.getAttribute("role"), "status");
    assert.equal(
      skeleton.querySelectorAll(".card-loading-block").length > 3,
      true,
    );
    assert.deepEqual(harness.errors, []);
  });

  test("lists Card artifacts above the Tasks checklist", async () => {
    const card = {
      id: "card-artifacts-first",
      version: 1,
      title: "Artifact Card",
      status: "active",
      stage: "preparation",
      taskCount: 1,
      openTaskCount: 1,
      references: [],
    };
    const task = {
      id: "card-artifacts-task",
      cardId: card.id,
      version: 1,
      taskHistory: [],
      description: "Checklist item below the artifacts",
      status: "todo",
    };
    const harness = createHarness({
      cards: [card],
      request: async (url, requestOptions = {}) => {
        if (url === `/api/cards/${card.id}` && !requestOptions.method)
          return card;
        if (url === `/api/tasks?cardId=${card.id}`) return { tasks: [task] };
        if (url === `/api/artifacts?cardId=${card.id}`) {
          return {
            artifacts: [
              {
                id: "artifact-1",
                title: "Sponsor proof document",
                storageUri: "https://files.example/sponsor-proof",
                status: "approved",
              },
            ],
          };
        }
        return {};
      },
    });

    harness.api.prepareCardPanel(card.id);
    await harness.api.hydrateCardPanel(card.id, 1);
    const main = harness.cardPanelBody.querySelector(".workflow-modal-main");
    const order = main.children.map((child) => child.className);
    const artifactsIndex = order.findIndex((names) =>
      names.includes("workflow-artifacts-section"),
    );
    const tasksIndex = order.findIndex((names) =>
      names.includes("workflow-checklist-section"),
    );
    assert.ok(artifactsIndex !== -1);
    assert.ok(tasksIndex !== -1);
    assert.ok(artifactsIndex < tasksIndex);
    assert.match(main.textContent, /Sponsor proof document/);
    const refs = harness.cardPanelBody.querySelector(
      ".workflow-references-section",
    );
    assert.ok(!refs.textContent.includes("Sponsor proof document"));
    assert.deepEqual(harness.errors, []);
  });

  test("opens process docs from a task and its card in a new tab", async () => {
    const card = {
      id: "card-doc",
      version: 1,
      title: "Podcast with Ada",
      references: [
        { name: "Guest prep", url: "content/process/podcast/guest-prep.md" },
        { name: "Show notes", url: "https://docs.google.com/document/d/notes/edit" },
      ],
    };
    const task = {
      id: "task-doc",
      version: 1,
      cardId: card.id,
      description: "Prepare the guest",
      taskHistory: [],
      instructionDocId: "process.podcast.guest-prep",
      status: "todo",
    };
    const harness = createHarness({
      cards: [card],
      resolveDocReference: (id) =>
        id === task.instructionDocId
          ? { id, title: "Guest prep", path: "content/process/podcast/guest-prep.md" }
          : null,
      request: async (url, requestOptions = {}) => {
        if (url === `/api/tasks/${task.id}` && !requestOptions.method) return task;
        if (url === `/api/cards/${card.id}`) return card;
        if (url === `/api/tasks?cardId=${card.id}`) return { tasks: [task] };
        if (url.startsWith("/api/files")) return { files: { items: [] } };
        if (url.startsWith("/api/artifacts")) return { artifacts: [] };
        return {};
      },
    });

    await hydrateTask(harness, task);
    const material = findAllByClass(harness.taskPanelBody.querySelector(".task-instructions"), "artifact-row-label")[0];
    assert.equal(material.tagName, "A");
    assert.equal(material.href, "/process/podcast/guest-prep.md");
    assert.equal(material.target, "_blank");
    assert.equal(material.rel, "noopener noreferrer");
    assert.equal(material.textContent, "Guest prep (opens in new tab)");
    const processDoc = findAllByClass(harness.taskPanelBody.querySelector(".task-instruction-doc"), "task-instruction-doc-link")[0];
    assert.equal(processDoc.tagName, "A");
    assert.equal(processDoc.href, "/process/podcast/guest-prep.md");
    assert.equal(processDoc.target, "_blank");

    harness.api.prepareCardPanel(card.id);
    await harness.api.hydrateCardPanel(card.id, 1);
    const references = harness.cardPanelBody.querySelector(".workflow-references-section").querySelectorAll("a");
    assert.deepEqual(
      references.map((link) => [link.href, link.target, link.rel]),
      [
        ["/process/podcast/guest-prep.md", "_blank", "noopener noreferrer"],
        ["https://docs.google.com/document/d/notes/edit", "_blank", "noopener noreferrer"],
      ],
    );
    assert.deepEqual(harness.errors, []);
  });

  test("names the sponsor deal a cardless task is about and opens it", async () => {
    const task = {
      id: "task-sponsor",
      version: 1,
      taskHistory: [],
      description: "Chase the signed order form",
      status: "todo",
      date: "2026-08-20",
      subject: { type: "sponsor-deal", id: "deal-1", label: "Synthetic Sponsor Co", href: "/sponsors/deals/deal-1" },
    };
    const harness = createHarness({
      request: async (url, requestOptions = {}) => {
        if (url === `/api/tasks/${task.id}` && !requestOptions.method) return task;
        if (url.startsWith("/api/files")) return { files: { items: [] } };
        if (url.startsWith("/api/artifacts")) return { artifacts: [] };
        return {};
      },
    });

    await hydrateTask(harness, task);
    const row = harness.taskPanelBody.querySelector(".task-context-card");
    assert.match(row.textContent, /Synthetic Sponsor Co/);
    assert.match(row.textContent, /Open deal/);
    await row.click();
    assert.equal(harness.navigations.at(-1).path, "/sponsors/deals/deal-1");
  });

  test("opens a task with its card context first and folds attachments and history", async () => {
    const card = { id: "card-ctx", version: 1, title: "LLM evals in practice", tags: ["webinar"] };
    const task = {
      id: "task-ctx",
      version: 1,
      cardId: card.id,
      taskHistory: [{ action: "reopened", createdAt: "2026-08-01T10:00:00Z" }],
      description: "[Emails] Announce in Slack",
      materials: [{ url: "https://docs.google.com/document/d/tpl1/edit", label: "template" }],
      tags: ["webinar"],
      instructionsUrl: "https://docs.google.com/document/d/sop1/edit",
      status: "todo",
      date: "2026-08-20",
    };
    const harness = createHarness({
      cards: [card],
      workSnapshot: { templates: [{ id: "tpl-webinar", type: "webinar", name: "Webinar", icon: "video" }] },
      request: async (url, requestOptions = {}) => {
        if (url === `/api/tasks/${task.id}` && !requestOptions.method) return task;
        if (url.startsWith("/api/files")) return { files: { items: [] } };
        if (url === `/api/artifacts?cardId=${card.id}`) {
          return { artifacts: [{ id: "card-link", cardId: card.id, status: "approved", storageUri: "https://luma.com/x", title: "x" }] };
        }
        if (url.startsWith("/api/artifacts")) return { artifacts: [] };
        return {};
      },
    });

    await hydrateTask(harness, task);
    const body = harness.taskPanelBody;
    assert.equal(harness.taskPanelTitle.textContent, "Announce in Slack");
    const context = body.querySelector(".task-context");
    assert.ok(context);
    assert.equal(body.children[0], context);
    const cardButton = context.querySelector(".task-context-card");
    assert.match(cardButton.textContent, /LLM evals in practice/);
    assert.match(cardButton.textContent, /Webinar card/);
    assert.equal(cardButton.querySelector("svg").dataset.icon, "video");
    const chips = findAllByClass(context, "task-context-chip").map((chip) => chip.textContent);
    assert.match(chips[0], /^Due /);
    assert.deepEqual(chips.slice(1), ["Unassigned", "Emails"]);
    const instructions = body.querySelector(".task-instructions");
    assert.deepEqual(
      findAllByClass(instructions, "artifact-row-label").map((link) => [link.textContent, link.href]),
      [
        ["Instructions (opens in new tab)", "https://docs.google.com/document/d/sop1/edit"],
        ["Template (opens in new tab)", "https://docs.google.com/document/d/tpl1/edit"],
      ],
    );
    for (const link of findAllByClass(instructions, "artifact-row-label")) assert.equal(link.target, "_blank");
    // The card's own links stay on the card; history and the optional
    // attachment controls fold into one disclosure.
    assert.ok(!body.textContent.includes("luma"));
    const more = body.querySelector(".task-panel-more");
    assert.equal(more.tagName, "DETAILS");
    assert.ok(findByText(more, "History"));
    assert.ok(more.querySelector('[data-panel-field="artifact-url"]'));
  });

  test("a rebuild before the disclosure's toggle event keeps it open", async () => {
    const task = {
      id: "task-more-race",
      version: 1,
      taskHistory: [{ action: "response-received", createdAt: "2026-08-01T10:00:00Z" }],
      description: "Synthetic disclosure race",
      status: "todo",
      date: "2026-08-20",
    };
    const harness = createHarness({
      request: async (url, requestOptions = {}) => {
        if (url === `/api/tasks/${task.id}` && !requestOptions.method) return task;
        if (url.startsWith("/api/files")) return { files: { items: [] } };
        if (url.startsWith("/api/artifacts")) return { artifacts: [] };
        return {};
      },
    });
    await hydrateTask(harness, task);
    // The click opens the disclosure; its toggle event has not fired yet when
    // a refreshed Task rebuilds the panel.
    harness.taskPanelBody.querySelector(".task-panel-more").open = true;
    await harness.api.hydrateTaskPanel(task.id, 1);
    await nextTicks();
    assert.equal(harness.taskPanelBody.querySelector(".task-panel-more").open, true);
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
    assert.ok(findByText(harness.taskPanelBody, `${title} (opens in new tab)`, "a"));
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

  test("names each prerequisite with its status and disables completion until all are done", async () => {
    const task = {
      id: "dependent-task",
      version: 2,
      taskHistory: [],
      description: "Publish podcast page",
      date: "2026-08-12",
      status: "todo",
      dependsOn: ["spotify", "transcript"],
      blocked: true,
      prerequisites: [
        { id: "spotify", description: "Verify Spotify episode", status: "done" },
        { id: "transcript", description: "Review transcript", status: "todo" },
        { id: "cover", description: "Approve cover", status: "skipped" },
      ],
    };
    const harness = createHarness({
      request: async (url) => {
        if (url === "/api/tasks/dependent-task") return task;
        if (url.startsWith("/api/files")) return { files: { items: [] } };
        if (url.startsWith("/api/artifacts")) return { artifacts: [] };
        return {};
      },
    });

    await hydrateTask(harness, task);
    const section = harness.taskPanelBody.querySelector(".task-prerequisites");
    assert.ok(section, "the Waiting on section renders");
    assert.match(section.textContent, /^Waiting on/);
    assert.match(section.textContent, /Verify Spotify episode/);
    assert.match(section.textContent, /Review transcript/);
    const rows = section.querySelectorAll(".task-dependency-row");
    assert.deepEqual(rows.map((row) => row.dataset.status), ["done", "todo", "skipped"]);
    assert.match(rows[2].textContent, /Skipped/);
    // Nothing waits on this task, so there is no Unblocks section.
    assert.equal(harness.taskPanelBody.querySelector(".task-dependents"), null);
    const why = harness.taskPanelBody.querySelector('[data-blocked="true"]');
    assert.equal(why.textContent, "Waiting on 1 task above");

    const complete = findByText(harness.taskPanelBody, "Mark done", "button");
    assert.equal(complete.disabled, true);
    assert.equal(complete.title, 'Complete or skip "Review transcript" first');
  });

  test("completes normally when every prerequisite is done or skipped", async () => {
    const task = {
      id: "ready-task",
      version: 2,
      taskHistory: [],
      description: "Publish podcast page",
      date: "2026-08-12",
      status: "todo",
      dependsOn: ["spotify"],
      blocked: false,
      prerequisites: [{ id: "spotify", description: "Verify Spotify episode", status: "done" }],
    };
    const harness = createHarness({
      request: async (url) => {
        if (url === "/api/tasks/ready-task") return task;
        if (url.startsWith("/api/files")) return { files: { items: [] } };
        if (url.startsWith("/api/artifacts")) return { artifacts: [] };
        return {};
      },
    });
    await hydrateTask(harness, task);
    assert.equal(harness.taskPanelBody.querySelector('[data-blocked="true"]'), null);
    assert.equal(findByText(harness.taskPanelBody, "Mark done", "button").disabled, false);
  });

  test("marks a blocked checklist row and disables its checkbox with the reason", async () => {
    const card = {
      id: "card-blocked-row",
      version: 1,
      title: "Episode",
      status: "active",
      stage: "preparation",
      taskCount: 2,
      openTaskCount: 2,
      references: [],
    };
    const first = { id: "row-first", cardId: card.id, version: 1, taskHistory: [], description: "Verify Spotify episode", status: "todo" };
    const second = {
      id: "row-second",
      cardId: card.id,
      version: 1,
      taskHistory: [],
      description: "Publish page",
      status: "todo",
      dependsOn: [first.id],
      blocked: true,
      prerequisites: [{ id: first.id, description: first.description, status: "todo" }],
    };
    const harness = createHarness({
      cards: [card],
      request: async (url, requestOptions = {}) => {
        if (url === `/api/cards/${card.id}` && !requestOptions.method) return card;
        if (url === `/api/tasks?cardId=${card.id}`) return { tasks: [first, second] };
        if (url === `/api/artifacts?cardId=${card.id}`) return { artifacts: [] };
        return {};
      },
    });
    harness.api.prepareCardPanel(card.id);
    await harness.api.hydrateCardPanel(card.id, 1);
    const rows = harness.cardPanelBody.querySelectorAll(".card-checklist-item");
    assert.equal(rows.length, 2);
    const [open, blocked] = rows;
    assert.equal(open.querySelector('input[type="checkbox"]').disabled, false);
    assert.equal(open.querySelector(".card-checklist-after"), null);
    assert.equal(open.classList.contains("is-blocked"), false);
    const box = blocked.querySelector('input[type="checkbox"]');
    assert.equal(box.disabled, true);
    assert.equal(box.title, 'Complete or skip "Verify Spotify episode" first');
    assert.equal(blocked.classList.contains("is-blocked"), true);
    const after = blocked.querySelector(".card-checklist-after");
    assert.equal(after.textContent, "after Verify Spotify episode");
    assert.equal(box.getAttribute("aria-describedby"), after.id);
    // The blocker's name links to it.
    const link = after.querySelector(".card-checklist-after-link");
    assert.equal(link.tagName, "A");
    assert.equal(link.href, `/cards?cardId=${card.id}&taskId=${first.id}`);
    assert.deepEqual(harness.errors, []);
  });

  test("edits prerequisites by task name and status, not raw ids", async () => {
    const card = { id: "card-edit-deps", version: 1, title: "Episode", status: "active", stage: "preparation", taskCount: 3, openTaskCount: 3, references: [] };
    const subject = { id: "page", cardId: card.id, version: 4, taskHistory: [], description: "Publish page", status: "todo", date: "2026-08-12" };
    const spotify = { id: "spotify-id", cardId: card.id, version: 1, taskHistory: [], description: "Verify Spotify episode", status: "done" };
    const promo = { id: "promo-id", cardId: card.id, version: 1, taskHistory: [], description: "Promote episode", status: "todo", dependsOn: ["page"] };
    const harness = createHarness({
      cards: [card],
      request: async (url, requestOptions = {}) => {
        if (url === "/api/tasks/page" && !requestOptions.method) return subject;
        if (url === "/api/tasks/page" && requestOptions.method === "PUT") {
          return { ...subject, version: 5, ...JSON.parse(requestOptions.body) };
        }
        if (url === `/api/tasks?cardId=${card.id}`) return { tasks: [subject, spotify, promo] };
        if (url.startsWith("/api/files")) return { files: { items: [] } };
        if (url.startsWith("/api/artifacts")) return { artifacts: [] };
        return {};
      },
    });
    await hydrateTask(harness, subject);
    await nextTicks(3);
    // No prerequisites: no Waiting on section, but the task can still gain
    // one from the dialog's secondary disclosure.
    assert.equal(harness.taskPanelBody.querySelector(".task-prerequisites"), null);
    const editor = harness.taskPanelBody.querySelector(".task-panel-more .task-prerequisite-editor");
    assert.ok(editor, "an unblocked task with a card can still gain prerequisites");
    assert.equal(editor.querySelector("summary").textContent, "Add a prerequisite");
    // Promote episode waits on this task, so the dialog says what it unblocks.
    const unblocks = harness.taskPanelBody.querySelector(".task-dependents");
    assert.ok(unblocks, "Unblocks lists the card's tasks that wait on this one");
    assert.deepEqual(
      unblocks.querySelectorAll(".task-dependency-name").map((name) => name.textContent),
      ["Promote episode"],
    );

    editor.open = true;
    await editor.dispatch("toggle");
    await nextTicks(3);
    const options = editor.querySelectorAll(".task-prerequisite-option");
    assert.deepEqual(
      options.map((option) => option.querySelector(".task-prerequisite-name").textContent),
      ["Verify Spotify episode", "Promote episode"],
    );
    assert.doesNotMatch(editor.textContent, /spotify-id|promo-id/);
    const [spotifyBox, promoBox] = options.map((option) => option.querySelector('input[type="checkbox"]'));
    assert.equal(promoBox.disabled, true, "a task that already waits on this one cannot be its prerequisite");
    assert.match(options[1].title, /Already waits on this task/);

    spotifyBox.checked = true;
    await findByText(editor, "Save prerequisites", "button").click();
    await nextTicks(3);
    const saved = harness.requests.find(({ url, options: o }) => url === "/api/tasks/page" && o?.method === "PUT");
    assert.deepEqual(jsonBody(saved), { dependsOn: ["spotify-id"], expectedVersion: 4 });
  });

  test("shows no dependency section on a task without edges", async () => {
    const card = { id: "card-no-deps", version: 1, title: "Episode", status: "active", stage: "preparation", taskCount: 2, openTaskCount: 2, references: [] };
    const subject = { id: "plain", cardId: card.id, version: 1, taskHistory: [], description: "Plain step", status: "todo", date: "2026-08-12" };
    const other = { id: "other", cardId: card.id, version: 1, taskHistory: [], description: "Other step", status: "todo" };
    const harness = createHarness({
      cards: [card],
      request: async (url) => {
        if (url === "/api/tasks/plain") return subject;
        if (url === `/api/tasks?cardId=${card.id}`) return { tasks: [subject, other] };
        if (url.startsWith("/api/files")) return { files: { items: [] } };
        if (url.startsWith("/api/artifacts")) return { artifacts: [] };
        return {};
      },
    });
    await hydrateTask(harness, subject);
    await nextTicks(3);
    assert.equal(harness.taskPanelBody.querySelector(".task-dependency-section"), null);
    assert.doesNotMatch(harness.taskPanelBody.textContent, /Prerequisites|Waiting on|Unblocks/);
  });

  test("offers no prerequisite editor on a completed or card-less Task", async () => {
    const done = { id: "done-task", cardId: "c", version: 2, taskHistory: [], description: "Done", status: "done" };
    const loose = { id: "loose-task", version: 1, taskHistory: [], description: "Loose", status: "todo" };
    for (const subject of [done, loose]) {
      const harness = createHarness({
        request: async (url) => {
          if (url === `/api/tasks/${subject.id}`) return subject;
          if (url.startsWith("/api/files")) return { files: { items: [] } };
          if (url.startsWith("/api/artifacts")) return { artifacts: [] };
          return {};
        },
      });
      await hydrateTask(harness, subject);
      assert.equal(harness.taskPanelBody.querySelector(".task-prerequisite-editor"), null, subject.id);
    }
  });

  test("downloads a Task file through the minted short-lived link", async () => {
    const task = {
      id: "task-file-download",
      version: 1,
      status: "todo",
      description: "Attach a proof",
      taskHistory: [],
    };
    const opens = [];
    const previousWindow = globalThis.window;
    globalThis.window = {
      location: { origin: "https://portal.test" },
      open: (url) => opens.push(url),
    };
    try {
      const harness = createHarness({
        request: async (url) => {
          if (url === `/api/tasks/${task.id}`) return task;
          if (url === "/api/files/file-1/download") {
            return {
              downloadUrl:
                "https://task-files.test/signed?X-Amz-Signature=secret",
              expiresIn: 300,
            };
          }
          if (url.startsWith("/api/files")) {
            return { files: { items: [{ id: "file-1", filename: "proof.pdf" }] } };
          }
          if (url.startsWith("/api/artifacts")) return { artifacts: [] };
          return {};
        },
      });
      await hydrateTask(harness, task);
      await nextTicks(3);
      const downloadButton = harness.taskPanelBody.querySelector(
        ".task-file-download",
      );
      assert.ok(downloadButton, "the file row exposes a download control");
      downloadButton.click();
      await nextTicks(3);
      assert.ok(
        harness.requests.some(
          (entry) => entry.url === "/api/files/file-1/download",
        ),
        "the download link is minted through the API",
      );
      assert.deepEqual(opens, [
        "https://task-files.test/signed?X-Amz-Signature=secret",
      ]);
    } finally {
      globalThis.window = previousWindow;
    }
  });

  test("a failed Task file link mint leaves the row without opening anything", async () => {
    const task = {
      id: "task-file-download-failure",
      version: 1,
      status: "todo",
      description: "Attach a proof that fails to open",
      taskHistory: [],
    };
    const opens = [];
    const previousWindow = globalThis.window;
    globalThis.window = {
      location: { origin: "https://portal.test" },
      open: (url) => opens.push(url),
    };
    try {
      const harness = createHarness({
        request: async (url) => {
          if (url === `/api/tasks/${task.id}`) return task;
          if (url === "/api/files/file-1/download") {
            throw new Error("link unavailable");
          }
          if (url.startsWith("/api/files")) {
            return { files: { items: [{ id: "file-1", filename: "proof.pdf" }] } };
          }
          if (url.startsWith("/api/artifacts")) return { artifacts: [] };
          return {};
        },
      });
      await hydrateTask(harness, task);
      await nextTicks(3);
      harness.taskPanelBody.querySelector(".task-file-download").click();
      await nextTicks(3);
      assert.deepEqual(opens, []);
      assert.ok(
        harness.taskPanelBody.querySelector(".task-file-download"),
        "the row stays so the download can be retried",
      );
    } finally {
      globalThis.window = previousWindow;
    }
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

    // Over a page, a Card opens as a dialog on that page's address.
    await harness.api.openCardPanel(archived.id);
    assert.equal(harness.navigations[0].path, "/tasks");
    assert.equal(harness.navigations[0].params.toString(), `card=${archived.id}`);
    // On the Cards pages it opens at its own address.
    harness.setRoute({ path: "/cards", params: new URLSearchParams(), invalid: false });
    await harness.api.openCardPanel(archived.id);
    assert.equal(harness.navigations.at(-1).path, "/cards/archive");
    assert.deepEqual(harness.navigations.at(-1).params, { cardId: archived.id });
    harness.setRoute({ path: "/cards", params: new URLSearchParams("cardId=card-1"), invalid: false });

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
    assert.equal(nested.params.toString(), "cardId=card-1&taskId=card-task");
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
      harness.cardPanelBody.querySelector(".link-row__label").textContent,
      card.cardLinks[0].name,
    );
    const savedLink = harness.cardPanelBody.querySelector(".link-row__link");
    assert.equal(savedLink.href, card.cardLinks[0].url);
    assert.equal(savedLink.title, card.cardLinks[0].url);
    assert.equal(
      savedLink.querySelector(".link-row__address").textContent,
      "example.test/…/path",
    );
    assert.equal(
      harness.cardPanelBody.querySelector(".card-checklist-label").textContent,
      task.description,
    );
    assert.equal(
      harness.cardPanelBody.querySelector(".workflow-references-section a")
        .textContent,
      `${card.references[0].name} (opens in new tab)`,
    );
    assert.ok(harness.cardPanelBody.querySelector("wbr"));
  });

  test("lists Card links compactly: filled first, mailto counts as present, edits open on demand", async () => {
    let card = {
      id: "card-links-compact",
      version: 1,
      title: "Podcast links",
      stage: "preparation",
      cardLinks: [
        { name: "Meetup", url: "" },
        { name: "Guest email", url: "mailto:guest@example.com" },
        { name: "Podcast document", url: "https://docs.google.com/document/d/abc123/edit" },
        { name: "Luma", url: "https://luma.com/ar4ggwep" },
      ],
      references: [],
    };
    const harness = createHarness({
      cards: [card],
      request: async (url, requestOptions = {}) => {
        if (url === `/api/cards/${card.id}` && requestOptions.method === "PUT") {
          const body = JSON.parse(requestOptions.body);
          card = { ...card, version: card.version + 1, cardLinks: body.cardLinks };
          return { card };
        }
        if (url === `/api/cards/${card.id}`) return { card };
        if (url === `/api/tasks?cardId=${card.id}`) return { tasks: [] };
        if (url === `/api/artifacts?cardId=${card.id}`) return { artifacts: [] };
        return {};
      },
    });
    harness.api.prepareCardPanel(card.id);
    await harness.api.hydrateCardPanel(card.id, 1);

    const labels = () => [...harness.cardPanelBody.querySelectorAll(".link-row__label")]
      .map((label) => label.textContent);
    assert.deepEqual(labels(), ["Guest email", "Podcast document", "Luma", "Meetup"]);
    assert.equal(harness.cardPanelBody.querySelector(".workflow-links-missing").textContent, "1 missing");
    // No text input until someone edits.
    assert.equal(harness.cardPanelBody.querySelector(".link-row__input"), null);

    // A mailto: value is present: it opens the mail client (no new tab) and
    // offers a copy, never the "missing" state.
    const [emailRow, docRow, , meetupRow] = harness.cardPanelBody.querySelectorAll(".link-row");
    assert.equal(emailRow.classList.contains("is-missing"), false);
    const email = emailRow.querySelector(".link-row__link");
    assert.equal(email.href, "mailto:guest@example.com");
    assert.equal(email.target, undefined);
    assert.equal(email.querySelector(".link-row__address").textContent, "guest@example.com");
    assert.equal(
      emailRow.querySelector(".link-row__copy").getAttribute("aria-label"),
      "Copy Guest email address",
    );

    const doc = docRow.querySelector(".link-row__link");
    assert.equal(doc.target, "_blank");
    assert.equal(doc.title, "https://docs.google.com/document/d/abc123/edit");
    assert.equal(doc.querySelector(".link-row__address").textContent, "docs.google.com/…/edit");
    assert.equal(meetupRow.classList.contains("is-missing"), true);

    // Escape closes the editor without saving and hands focus back.
    const add = meetupRow.querySelector(".link-row__add");
    assert.equal(add.getAttribute("aria-label"), "Add Meetup");
    await add.click();
    let input = meetupRow.querySelector(".link-row__input");
    assert.equal(input.getAttribute("aria-label"), "Meetup link");
    assert.equal(input.focused, true);
    input.value = "https://www.meetup.com/x/events/1";
    await input.dispatch("keydown", { key: "Escape" });
    assert.equal(meetupRow.querySelector(".link-row__input"), null);
    assert.equal(meetupRow.querySelector(".link-row__add").focused, true);
    assert.equal(harness.requests.filter((entry) => entry.options.method === "PUT").length, 0);

    // Enter saves through the Card intent and the row comes back as a link.
    await meetupRow.querySelector(".link-row__add").click();
    input = meetupRow.querySelector(".link-row__input");
    input.value = " https://www.meetup.com/x/events/1 ";
    await input.dispatch("keydown", { key: "Enter" });
    await nextTicks(4);
    const put = harness.requests.find((entry) => entry.options.method === "PUT");
    assert.deepEqual(
      jsonBody(put).cardLinks.find((link) => link.name === "Meetup"),
      { name: "Meetup", url: "https://www.meetup.com/x/events/1" },
    );
    const saved = [...harness.cardPanelBody.querySelectorAll(".link-row")]
      .find((row) => row.dataset.linkName === "Meetup");
    assert.equal(saved.querySelector(".link-row__address").textContent, "meetup.com/…/1");
    assert.equal(harness.cardPanelBody.querySelector(".workflow-links-missing"), null);
    assert.deepEqual(harness.errors, []);
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

  test("Sponsored option previews task activation before applying", async () => {
    const card = { id: "card-options", version: 1, title: "Workshop", templateId: "tpl", templateVersion: 1, references: [] };
    const current = { state: "current", sourceTemplateVersion: 1, targetTemplateVersion: 1,
      previewToken: "a".repeat(64), availableOptionalGroups: ["sponsored"], selectedOptionalGroups: [], targetOptionalGroups: [],
      counts: {}, cardChanges: [], taskChanges: [] };
    let applied = false;
    const harness = createHarness({ cards: [card], request: async (url, options = {}) => {
      if (url === `/api/cards/${card.id}`) return { card };
      if (url === `/api/tasks?cardId=${card.id}`) return { tasks: [] };
      if (url === `/api/artifacts?cardId=${card.id}`) return { artifacts: [] };
      if (url === `/api/cards/${card.id}/template-update`) {
        if (!options.method) return { preview: applied ? { ...current, selectedOptionalGroups: ["sponsored"], targetOptionalGroups: ["sponsored"] } : current };
        const body = JSON.parse(options.body);
        if (body.previewOnly) return { preview: { ...current, state: "update-available", previewToken: "b".repeat(64), targetOptionalGroups: body.optionalGroups,
          counts: { added: 1 }, taskChanges: [{ action: "add", taskRef: "invoice", targetLabel: "Invoice sponsor", changes: [], operatorOverrideFields: [] }] } };
        applied = true;
        return { applied: true, card: { ...card, version: 2, selectedOptionalGroups: ["sponsored"] }, tasks: [] };
      }
      throw new Error(`Unexpected request ${url}`);
    } });
    harness.api.prepareCardPanel(card.id);
    await harness.api.hydrateCardPanel(card.id, 1);
    assert.match(harness.cardPanelBody.textContent, /Sponsored/);
    const checkbox = harness.cardPanelBody.querySelector('input[type="checkbox"]');
    assert.equal(checkbox.checked, false);
    checkbox.checked = true;
    await findByText(harness.cardPanelBody, "Review option changes", "button").click();
    await nextTicks();
    assert.deepEqual(jsonBody(harness.requests.find((entry) => entry.options.method === "POST")), { previewOnly: true, optionalGroups: ["sponsored"] });
    assert.equal(applied, false);
    assert.match(harness.cardPanelBody.textContent, /Add Invoice sponsor/);
    const changedOption = harness.cardPanelBody.querySelector('input[type="checkbox"]');
    changedOption.checked = false;
    await changedOption.dispatch("change");
    assert.equal(findByText(harness.cardPanelBody, "Apply reviewed update", "button"), undefined, 'editing options invalidates the previous review');
    changedOption.checked = true;
    await findByText(harness.cardPanelBody, "Review option changes", "button").click();
    await nextTicks();
    await findByText(harness.cardPanelBody, "Apply reviewed update", "button").click();
    await nextTicks();
    const apply = harness.requests.find((entry) => entry.options.method === "POST" && !jsonBody(entry).previewOnly);
    assert.deepEqual(jsonBody(apply), { previewToken: "b".repeat(64), optionalGroups: ["sponsored"] });
    assert.equal(applied, true);
    assert.equal(harness.cardPanelBody.querySelector('input[type="checkbox"]').checked, true);
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
        skipped: 1,
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
      /Removed incomplete tasks are skipped/,
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
    assert.doesNotMatch(harness.cardPanelBody.textContent, /Template definition|Current at Template/);
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
    await findByText(harness.cardPanelBody, "Add", "button").click();
    harness.cardPanelBody.querySelector(".link-row__input").value =
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
      harness.cardPanelBody.querySelector(".link-row__input").value,
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
      harness.cardPanelBody.querySelector(".link-row__input").value,
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
        if (url === `/api/cards/${card.id}/template-update`) {
          if (initialPreview && !requestOptions.method) {
            initialPreview = false;
            return {
              preview: {
                state: "current",
                availableOptionalGroups: ["sponsored"],
                targetOptionalGroups: [],
              },
            };
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
      "Review option changes",
      "button",
    ).click();
    await nextTicks();
    harness.setRouteToken(2);
    harness.api.prepareCardPanel("new-card");
    releasePreview({ preview: { state: "current", targetTemplateVersion: 2 } });
    await reload;

    assert.equal(harness.cardPanelTitle.textContent, "Loading card...");
    const loading = harness.cardPanelBody.querySelector(
      ".card-loading-skeleton",
    );
    assert.ok(loading);
    assert.equal(loading.getAttribute("role"), "status");
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
    const loading = harness.cardPanelBody.querySelector(
      ".card-loading-skeleton",
    );
    assert.ok(loading);
    assert.equal(loading.getAttribute("role"), "status");
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
    assert.deepEqual(missing.navigations.at(-1).options, { history: "none", reload: true });
    await missing.entityStates.at(-1).returnToList();
    assert.equal(missing.navigations.at(-1).params.has("taskId"), false);
  });

  test("links the Card detail panel to its source Template", async () => {
    const { renderCardTemplateLink } = await import(
      "../src/surfaces/work-detail/card-summary.js"
    );
    globalThis.document = new FakeDocument(
      new FakeElement("main"),
      new FakeElement("body"),
    );
    const navigations = [];
    const row = renderCardTemplateLink(
      {
        navigateCanonicalWorkspace: (path, params) => {
          navigations.push({ path, params });
          return { ready: Promise.resolve() };
        },
        request: async () => ({
          template: { id: "tpl-news", name: "Newsletter", icon: "newspaper" },
        }),
        workApiUrl: (path) => path,
      },
      "tpl-news",
    );
    assert.equal(row.className, "card-template-link-row");
    const [link] = row.children;
    assert.equal(link.textContent, "Template · View template");
    await nextTicks();
    assert.equal(link.textContent, "Template: Newsletter · View template");
    assert.equal(link.querySelector("svg").dataset.icon, "newspaper");
    await link.dispatch("click");
    assert.deepEqual(navigations, [
      { path: "/templates", params: { templateId: "tpl-news" } },
    ]);
  });

  test("parks an active Card and resumes a parked Card through the panel", async () => {
    const active = {
      id: "card-park",
      version: 1,
      title: "Park me",
      status: "active",
      stage: "preparation",
      taskCount: 1,
      openTaskCount: 1,
      references: [],
    };
    const parked = {
      id: "card-resume",
      version: 3,
      title: "Resume me",
      status: "parked",
      stage: "announced",
      taskCount: 1,
      openTaskCount: 1,
      references: [],
    };
    const writes = [];
    const harness = createHarness({
      cards: [active, parked],
      request: async (url, requestOptions = {}) => {
        if (url === `/api/cards/${active.id}` && !requestOptions.method) return active;
        if (url === `/api/cards/${parked.id}` && !requestOptions.method) return parked;
        if (url === `/api/cards/${active.id}/park` && requestOptions.method === "POST") {
          writes.push({ url, body: JSON.parse(requestOptions.body) });
          return { card: { ...active, status: "parked", version: 2 } };
        }
        if (url === `/api/cards/${parked.id}/resume` && requestOptions.method === "POST") {
          writes.push({ url, body: JSON.parse(requestOptions.body) });
          return { card: { ...parked, status: "active", version: 4 } };
        }
        return {};
      },
    });

    harness.api.prepareCardPanel(active.id);
    await harness.api.hydrateCardPanel(active.id, 1);
    const parkButton = findByText(harness.cardPanelBody, "Park", "button");
    assert.ok(parkButton);
    await parkButton.click();
    assert.deepEqual(writes, [
      { url: `/api/cards/${active.id}/park`, body: { expectedVersion: 1 } },
    ]);
    const parkedFeedback = await waitFor(
      () => harness.cardPanelBody.querySelector('[data-card-mutation-feedback="success"]'),
      "Card park success feedback",
    );
    assert.match(parkedFeedback.textContent, /parked/);

    harness.api.prepareCardPanel(parked.id);
    await harness.api.hydrateCardPanel(parked.id, 1);
    assert.match(harness.cardPanelBody.textContent, /Parked/);
    const resumeButton = findByText(harness.cardPanelBody, "Resume", "button");
    assert.ok(resumeButton);
    await resumeButton.click();
    assert.deepEqual(writes[1], {
      url: `/api/cards/${parked.id}/resume`,
      body: { expectedVersion: 3 },
    });
  });

  test("shows people, sponsor bylines, and issue chips in the Card detail", async () => {
    const { createCardSummary } = await import(
      "../src/surfaces/work-detail/card-summary.js"
    );
    globalThis.document = new FakeDocument(
      new FakeElement("main"),
      new FakeElement("body"),
    );
    const base = {
      cardAnchorTone: () => "upcoming",
      detail: {},
      formatCardAnchorLabel: (value) => value,
      isArchivedWorkCard: () => false,
      labelizeWorkValue: (value) => value,
      progress: { total: 1, done: 0, overdue: 0, waiting: 0, missingProof: 0, nextDueTask: null },
      state: { workSnapshot: { usersById: new Map() } },
      today: "2026-08-12",
      updateCardStage: () => {},
      workCardIssueNumber: (card) => card.issueNumber || "",
      workCardSubtitle: (card) => (card.people || []).join(", ") || card.sponsor || "",
      workTaskTitle: (task) => task.description,
    };
    const people = createCardSummary({
      ...base,
      card: { id: "pod", title: "Playbook", people: ["Tony Zeljkovic", "Juan Manuel Perafan"] },
    });
    assert.match(people.textContent, /PeopleTony Zeljkovic, Juan Manuel Perafan/);
    const sponsor = createCardSummary({
      ...base,
      card: { id: "news", title: "Weekly email", sponsor: "Astronomer", issueNumber: "298" },
    });
    assert.match(sponsor.textContent, /SponsorAstronomer/);
    assert.match(sponsor.textContent, /#298/);
    const plain = createCardSummary({
      ...base,
      card: { id: "plain", title: "Untitled" },
    });
    assert.doesNotMatch(plain.textContent, /People|Sponsor/);
  });

  // Kit dialogs are mounted on document.body and opened with showModal; the
  // fake DOM has neither, so these tests provide both and close via close().
  function withDialogs(harness) {
    harness.document.body = harness.body;
    harness.document.addEventListener ??= () => {};
    harness.document.removeEventListener ??= () => {};
    const proto = Object.getPrototypeOf(harness.body);
    const saved = { showModal: proto.showModal, close: proto.close };
    proto.showModal = function showModal() { this.open = true; };
    proto.close = function close() {
      this.open = false;
      return this.dispatch("close");
    };
    const dialog = (name) => harness.body.children.find(
      (child) => child.dataset?.workDialog === name,
    );
    return {
      dialog,
      restore() {
        proto.showModal = saved.showModal;
        proto.close = saved.close;
      },
    };
  }

  test("skips an open Task through a reason dialog that refuses an empty reason", async () => {
    const task = {
      id: "task-skippable",
      version: 3,
      taskHistory: [],
      description: "Upload the recording",
      status: "todo",
      requiredLinkName: "Recording",
    };
    const skipped = {
      ...task,
      version: 4,
      status: "skipped",
      skipReason: "Self-hosted, no recording",
      skippedAt: "2026-08-12T10:00:00.000Z",
      skippedBy: "alexey",
    };
    const harness = createHarness({
      request: async (url, requestOptions = {}) => {
        if (url.endsWith("/actions/skip")) return skipped;
        if (url === `/api/tasks/${task.id}`) return task;
        if (url.startsWith("/api/files")) return { files: { items: [] } };
        if (url.startsWith("/api/artifacts")) return { artifacts: [] };
        return requestOptions.method ? {} : {};
      },
    });
    const dialogs = withDialogs(harness);
    try {
      await hydrateTask(harness, task);
      const skip = findByText(harness.taskPanelBody, "Skip…", "button");
      assert.ok(skip, "an open Task offers Skip…");
      await skip.click();
      const dialog = dialogs.dialog("skip-task");
      assert.ok(dialog?.open, "the reason dialog opens at once");
      assert.match(dialog.textContent, /Upload the recording/);

      assert.match(dialog.textContent, /Why are you skipping this\?/);
      const form = dialog.querySelector("form");
      const textarea = dialog.querySelector("textarea");
      const confirm = findByText(dialog, "Skip task", "button");
      // No reason, no confirm: the button waits for one, whitespace included.
      assert.equal(confirm.disabled, true);
      textarea.value = "   ";
      await textarea.dispatch("input");
      assert.equal(confirm.disabled, true);
      await form.dispatch("submit");
      assert.match(dialog.textContent, /A reason is required/);
      assert.equal(harness.requests.some(({ url }) => url.endsWith("/actions/skip")), false);

      textarea.value = "  Self-hosted, no recording ";
      await textarea.dispatch("input");
      assert.equal(confirm.disabled, false);
      await form.dispatch("submit");
      await nextTicks();
      const posted = harness.requests.find(({ url }) => url.endsWith("/actions/skip"));
      assert.equal(posted.options.method, "POST");
      assert.deepEqual(jsonBody(posted), { reason: "Self-hosted, no recording", expectedVersion: 3 });
      assert.equal(dialog.open, false);
    } finally {
      dialogs.restore();
    }
  });

  test("offers Delete card only to an admin and confirms with the live title and task count", async () => {
    const card = {
      id: "card-dup",
      version: 5,
      title: "Synthetic duplicate issue",
      stage: "preparation",
      status: "active",
      taskCount: 15,
      openTaskCount: 15,
      references: [],
    };
    const route = (url, requestOptions = {}) => {
      if (url === "/api/cards/card-dup" && requestOptions.method === "DELETE") {
        return { deleted: { cardId: card.id, title: card.title, deletedTaskIds: [] } };
      }
      if (url === "/api/cards/card-dup") return { card };
      if (url === "/api/tasks?cardId=card-dup") return { tasks: [] };
      if (url === "/api/artifacts?cardId=card-dup") return { artifacts: [] };
      return {};
    };

    const operator = createHarness({ cards: [card], request: async (url, o) => route(url, o) });
    operator.api.prepareCardPanel(card.id);
    await operator.api.hydrateCardPanel(card.id, 1);
    assert.equal(findByText(operator.cardPanelBody, "Delete card…", "button"), undefined);

    const harness = createHarness({
      cards: [card],
      operator: { id: "riley", name: "Riley", role: "admin" },
      request: async (url, o) => route(url, o),
      route: { path: "/calendar", params: new URLSearchParams("card=card-dup"), invalid: false },
    });
    const dialogs = withDialogs(harness);
    try {
      harness.api.prepareCardPanel(card.id);
      await harness.api.hydrateCardPanel(card.id, 1);
      const more = harness.cardPanelBody.querySelector(".card-overflow-trigger");
      assert.equal(more.getAttribute("aria-haspopup"), "menu");
      await more.click();
      assert.equal(more.getAttribute("aria-expanded"), "true");
      await findByText(harness.cardPanelBody, "Delete card…", "button").click();
      await waitFor(() => dialogs.dialog("delete-card")?.open, "delete confirm opens after the card loads");
      const dialog = dialogs.dialog("delete-card");
      assert.match(dialog.textContent, /Synthetic duplicate issue/);
      assert.match(dialog.textContent, /its 15 tasks/);
      assert.equal(harness.requests.some(({ options }) => options.method === "DELETE"), false);

      await findByText(dialog, "Delete card", "button").click();
      await nextTicks();
      const deleted = harness.requests.find(({ options }) => options.method === "DELETE");
      assert.equal(deleted.url, "/api/cards/card-dup");
      assert.deepEqual(jsonBody(deleted), { expectedVersion: 5 });
      assert.equal(dialog.open, false);
      // The Card closes over the page it was opened on.
      const close = harness.navigations.at(-1);
      assert.equal(close.path, "/calendar");
      assert.equal(close.params.toString(), "");
    } finally {
      dialogs.restore();
    }
  });
});
