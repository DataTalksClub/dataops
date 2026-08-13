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
  let route =
    options.route ||
    {
      path: "/tasks",
      params: new URLSearchParams(),
      invalid: false,
    };
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
    if (url.startsWith("/api/files")) return { files: [] };
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
    fetchResource: async () => ({ ok: true, json: async () => ({}) }),
    FOCUSABLE_SELECTOR:
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    formatTaskDateMeta,
    getActiveTasksSection: () => "queue",
    getActiveWorkspaceRoute: () => route,
    getActiveWorkspaceView: () => "tasks",
    getAllDocuments: () => [],
    getCurrentOperator: () => ({ id: "alexey", name: "Alexey" }),
    hasApprovedArtifactEvidence,
    hasTaskFileEvidence,
    isArchivedWorkCard,
    isOpenWorkTask,
    isWorkspaceRouteFresh: () => fresh,
    labelizeWorkValue: (value) =>
      String(value || "")
        .split("-")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" "),
    localDocPathFromHref: (href) =>
      String(href).startsWith("/docs/") ? String(href) : "",
    navigateCanonicalWorkspace: (
      path,
      params = {},
      navigationOptions = {},
    ) => {
      navigations.push({ path, params, options: navigationOptions });
      return { ready: Promise.resolve() };
    },
    openDocument: (path, openOptions) =>
      openedDocuments.push({ path, options: openOptions }),
    openQualityFinding() {},
    parseWorkspaceHash: () => route,
    promptUser: options.promptUser || (() => "Vendor contact"),
    refreshDocuments: async () => {},
    refreshOperationsWorkSnapshot: async () => {},
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
    reportError: (message) => errors.push(message),
    request,
    scheduleAnimationFrame: (callback) => callback(),
    setStatus() {},
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
    const task = { id: "task-1", description: "Confirm the speaker" };
    const harness = createHarness({
      route: {
        path: "/tasks",
        params: new URLSearchParams("date=2026-08-12"),
        invalid: false,
      },
      request: async (url, requestOptions = {}) => {
        if (url === "/api/tasks/task-1" && !requestOptions.method) return task;
        if (url.startsWith("/api/files")) return { files: [] };
        if (url.startsWith("/api/artifacts")) return { artifacts: [] };
        return {};
      },
    });

    await harness.api.openTaskPanel(task.id);
    assert.equal(harness.navigations[0].path, "/tasks");
    assert.equal(harness.navigations[0].params.get("taskId"), task.id);
    assert.equal(
      harness.navigations[0].params.get("date"),
      "2026-08-12",
    );

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

  test("maps waiting, response-received, and follow-up actions to atomic request contracts", async () => {
    const todo = { id: "task-todo", description: "Ask for approval" };
    const waiting = {
      id: "task-waiting",
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
        if (url.startsWith("/api/files")) return { files: [] };
        if (url.startsWith("/api/artifacts")) return { artifacts: [] };
        return {};
      },
    });

    await hydrateTask(harness, todo);
    const markWaiting = findByText(
      harness.taskPanelBody,
      "Mark waiting",
      "button",
    );
    harness.api.resetTaskPanel();
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
    harness.api.resetTaskPanel();
    await response.click();
    await followUp.click();

    const responseRequest = harness.requests.find((entry) =>
      entry.url.endsWith("/actions/response-received"),
    );
    assert.deepEqual(jsonBody(responseRequest), {
      channel: "portal",
      note: "Response received in the Task panel",
    });
    const followUpRequest = harness.requests.find((entry) =>
      entry.url.endsWith("/actions/follow-up-sent"),
    );
    assert.deepEqual(jsonBody(followUpRequest), {
      nextFollowUpAt: "2026-08-20",
      channel: "portal",
      note: "Follow-up sent from the Task panel",
    });
  });

  test("blocks Task completion until required link, file, and approved artifact proof exist", async () => {
    const task = {
      id: "proof-task",
      description: "Publish the issue",
      requiredLinkName: "Newsletter URL",
      requiresFile: true,
      proofRequirement: { type: "artifact", required: true },
    };
    const harness = createHarness({
      request: async (url, requestOptions = {}) => {
        if (url === "/api/tasks/proof-task" && !requestOptions.method) {
          return task;
        }
        if (url.startsWith("/api/files")) return { files: [] };
        if (url.startsWith("/api/artifacts")) return { artifacts: [] };
        return {};
      },
    });

    await hydrateTask(harness, task);
    const complete = findByText(
      harness.taskPanelBody,
      "Mark done",
      "button",
    );
    assert.equal(complete.disabled, true);
    assert.equal(
      complete.title,
      "Fill in Newsletter URL; Upload required file; Approve an attached artifact",
    );
    assert.ok(
      findByText(
        harness.taskPanelBody,
        "No approved artifact attached.",
      ),
    );
  });

  test("hydrates active and archived Cards, updates stages, and opens nested Tasks canonically", async () => {
    const card = {
      id: "card-1",
      title: "August newsletter",
      stage: "preparation",
      references: [],
    };
    const archived = {
      id: "card-done",
      title: "July newsletter",
      status: "done",
    };
    const task = {
      id: "card-task",
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
    assert.deepEqual(jsonBody(stageRequest), { stage: "announced" });

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
        { action: "add", taskRef: "publish", targetLabel: "Publish recording", changes: [], operatorOverrideFields: [] },
        { action: "retain-completed", taskRef: "host", currentLabel: "Host event", changes: [], operatorOverrideFields: [] },
      ],
    };
    let statusLoads = 0;
    const harness = createHarness({
      cards: [card],
      request: async (url, requestOptions = {}) => {
        if (url === `/api/cards/${card.id}` && !requestOptions.method) return { card };
        if (url === `/api/tasks?cardId=${card.id}`) return { tasks: [task] };
        if (url === `/api/artifacts?cardId=${card.id}`) return { artifacts: [] };
        if (url === `/api/cards/${card.id}/template-update` && !requestOptions.method) {
          statusLoads += 1;
          return statusLoads === 1
            ? { preview }
            : { preview: { ...preview, state: "current", sourceTemplateVersion: 2 } };
        }
        if (url === `/api/cards/${card.id}/template-update` && requestOptions.method === "POST") {
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

    assert.match(harness.cardPanelBody.textContent, /Update available: Template v1 → v2/);
    await findByText(harness.cardPanelBody, "Review template update", "button").click();
    assert.match(harness.cardPanelBody.textContent, /Removed incomplete tasks are archived/);
    assert.match(harness.cardPanelBody.textContent, /1 operator override field will take/);
    assert.ok(findByText(harness.cardPanelBody, "Add Publish recording", "li"));
    assert.ok(findByText(harness.cardPanelBody, "Retain completed task: Host event", "li"));

    await findByText(harness.cardPanelBody, "Cancel", "button").click();
    assert.equal(findByText(harness.cardPanelBody, "Apply reviewed update", "button"), undefined);
    await findByText(harness.cardPanelBody, "Review template update", "button").click();
    await findByText(harness.cardPanelBody, "Apply reviewed update", "button").click();
    await nextTicks();

    const apply = harness.requests.find((entry) => (
      entry.url === `/api/cards/${card.id}/template-update`
      && entry.options.method === "POST"
    ));
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
      references: [],
    };
    const preview = {
      state: "update-available",
      sourceTemplateVersion: 1,
      targetTemplateVersion: 2,
      previewToken: "b".repeat(64),
      counts: { added: 1, updated: 0, archived: 0, retainedCompleted: 0, cardFields: 0, operatorOverrides: 0 },
      cardChanges: [],
      taskChanges: [{ action: "add", taskRef: "new", targetLabel: "New task", changes: [], operatorOverrideFields: [] }],
    };
    let previewLoads = 0;
    const harness = createHarness({
      cards: [card],
      request: async (url, requestOptions = {}) => {
        if (url === `/api/cards/${card.id}` && !requestOptions.method) return { card };
        if (url === `/api/tasks?cardId=${card.id}`) return { tasks: [] };
        if (url === `/api/artifacts?cardId=${card.id}`) return { artifacts: [] };
        if (url === `/api/cards/${card.id}/template-update` && !requestOptions.method) {
          previewLoads += 1;
          return { preview: { ...preview, previewToken: (previewLoads === 1 ? "b" : "c").repeat(64) } };
        }
        if (url === `/api/cards/${card.id}/template-update` && requestOptions.method === "POST") {
          const error = new Error("conflict");
          error.status = 409;
          throw error;
        }
        throw new Error(`Unexpected request ${url}`);
      },
    });
    harness.api.prepareCardPanel(card.id);
    await harness.api.hydrateCardPanel(card.id, 1);
    await findByText(harness.cardPanelBody, "Review template update", "button").click();
    await findByText(harness.cardPanelBody, "Apply reviewed update", "button").click();
    await nextTicks();

    assert.match(harness.cardPanelBody.textContent, /Your review is retained/);
    assert.ok(findByText(harness.cardPanelBody, "Add New task", "li"));
    assert.equal(previewLoads, 1);
    await findByText(harness.cardPanelBody, "Reload latest preview", "button").click();
    await nextTicks();
    assert.equal(previewLoads, 2);
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
        entry.url === "/api/cards/card-refs" &&
        entry.options.method === "PUT",
    );
    assert.deepEqual(jsonBody(referenceRequest), {
      references: [
        { name: "Internal launch process", url: "/docs/launch" },
      ],
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
      (entry) => entry.url === "/api/artifacts" && entry.options.method === "POST",
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
