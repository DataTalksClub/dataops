import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import {
  createAdminSurface,
  createOperationsSurface,
} from "../src/surfaces/operations/index.js";
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

function jsonBody(entry) {
  return JSON.parse(entry.options.body || "{}");
}

function selectorDataset(selector) {
  const match = selector.match(/\[data-([\w-]+)(?:="([^"]+)")?\]/);
  if (!match) return null;
  return {
    name: match[1].replace(/-([a-z])/g, (_whole, letter) =>
      letter.toUpperCase(),
    ),
    value: match[2] || "",
  };
}

function intakeDetails(action) {
  const details = decorateLazyQueries(new FakeElement("details"));
  const fieldValues =
    {
      attach: { taskId: "task-existing", bundleId: "", note: "Attach safely" },
      "convert-task": {
        date: "2026-08-12",
        assigneeId: "grace",
        bundleId: "card-1",
      },
      block: {
        reason: "",
        waitingFor: "Sponsor",
        followUpAt: "2026-08-15",
      },
      "follow-up-sent": {
        note: "Sent another email",
        nextFollowUpAt: "2026-08-18",
      },
      "response-received": { note: "Received the requested copy" },
      "prepare-assistant": { assistantType: "podcast", createJob: "true" },
      "mark-duplicate": {
        duplicateOfIntakeItemId: "intake-original",
        reason: "Same request",
      },
      ignore: { reason: "Out of scope" },
      archive: { reason: "Historical" },
    }[action] || {};
  const requiredNames =
    {
      block: ["reason", "waitingFor", "followUpAt"],
      "follow-up-sent": ["note", "nextFollowUpAt"],
      "response-received": ["note"],
      "mark-duplicate": ["duplicateOfIntakeItemId", "reason"],
      ignore: ["reason"],
      archive: ["reason"],
    }[action] || [];
  const fields = Object.entries(fieldValues).map(([name, value]) => {
    const field = decorateLazyQueries(new FakeElement("input"));
    field.name = name;
    field.value = value;
    field.required = requiredNames.includes(name);
    return field;
  });
  const originalQueryAll = details.querySelectorAll;
  details.querySelectorAll = (selector) => {
    if (selector === "input,select,textarea") return fields;
    if (selector === "input[required],select[required],textarea[required]") {
      return fields.filter((field) => field.required);
    }
    if (selector === "[aria-invalid]") {
      return fields.filter((field) => field.getAttribute("aria-invalid"));
    }
    return originalQueryAll(selector);
  };
  details.fields = Object.fromEntries(
    fields.map((field) => [field.name, field]),
  );
  return details;
}

function decorateLazyQueries(element) {
  const lazy = new Map();
  const intakeDetailsByAction = new Map();
  const originalQuery = element.querySelector.bind(element);
  const originalQueryAll = element.querySelectorAll.bind(element);
  element.querySelector = (selector) => {
    const requestedData = selectorDataset(selector);
    if (
      requestedData?.name === "intakeSubmit" &&
      requestedData.value &&
      lazy.has("all:[data-intake-submit]")
    ) {
      return lazy
        .get("all:[data-intake-submit]")
        .find(
          (candidate) => candidate.dataset.intakeSubmit === requestedData.value,
        );
    }
    const existing = originalQuery(selector);
    if (existing) return existing;
    if (lazy.has(selector)) return lazy.get(selector);
    const tag =
      selector === "h3"
        ? "h3"
        : selector.includes("select")
          ? "select"
          : selector.includes("input")
            ? "input"
            : selector.includes("button") || selector.includes("data-")
              ? "button"
              : "span";
    const created = decorateLazyQueries(new FakeElement(tag));
    const data = requestedData;
    if (data) {
      created.dataset[data.name] = data.value;
      if (data.name === "intakeSubmit" && data.value) {
        const details =
          intakeDetailsByAction.get(data.value) || intakeDetails(data.value);
        intakeDetailsByAction.set(data.value, details);
        created.closest = (candidate) =>
          candidate === "details" ? details : null;
      }
    }
    if (selector.includes("data-intake-create-class"))
      created.value = "internal";
    if (selector.includes("data-assistant-type")) created.value = "podcast";
    if (selector.includes("data-assistant-edit-approval"))
      created.value = "true";
    lazy.set(selector, created);
    return created;
  };
  element.querySelectorAll = (selector) => {
    const existing = originalQueryAll(selector);
    if (existing.length) return existing;
    if (lazy.has(`all:${selector}`)) return lazy.get(`all:${selector}`);
    const data = selectorDataset(selector);
    if (!data) return [];
    const expression = new RegExp(
      `data-${data.name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}="([^"]+)"`,
      "g",
    );
    const matches = [...String(element.innerHTML || "").matchAll(expression)];
    const created = matches.map((match) => {
      const node = decorateLazyQueries(new FakeElement("button"));
      node.dataset[data.name] = match[1];
      if (data.name === "intakeSubmit") {
        const details =
          intakeDetailsByAction.get(match[1]) || intakeDetails(match[1]);
        intakeDetailsByAction.set(match[1], details);
        node.closest = (selector) => (selector === "details" ? details : null);
      }
      return node;
    });
    lazy.set(`all:${selector}`, created);
    return created;
  };
  return element;
}

class OperationsDocument extends FakeDocument {
  createElement(tagName) {
    return decorateLazyQueries(super.createElement(tagName));
  }
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

function operationState(overrides = {}) {
  return {
    intake: {
      filter: "actionable",
      selectedId: null,
      items: [],
      bundles: [],
      loaded: true,
      error: "",
    },
    intakeMutation: {
      itemId: "",
      action: "",
      values: {},
      error: "",
      busy: false,
      status: "",
    },
    assistantQueue: { filter: "all", selectedJobId: null },
    assistantSnapshot: { loaded: true, jobs: [], errors: [] },
    artifactSnapshot: { loaded: true, artifacts: [], errors: [] },
    workSnapshot: { bundles: [] },
    workspaceEntity: null,
    ...overrides,
  };
}

function createOperationsHarness(options = {}) {
  const documentList = new FakeElement("main");
  const libraryTitle = new FakeElement("h1");
  const clearSelectionButton = new FakeElement("button");
  const document = new OperationsDocument(documentList, libraryTitle);
  globalThis.document = document;
  const requests = [];
  const navigations = [];
  const errors = [];
  const statuses = [];
  const entityStates = [];
  const openedTasks = [];
  const openedCards = [];
  const state = operationState(options.state);
  let route = options.route || {
    path: "/inbox",
    params: new URLSearchParams(),
  };

  const api = createOperationsSurface({
    assistantJobsFromPayload: (payload) =>
      Array.isArray(payload) ? payload : payload?.jobs || [],
    clearSelectionButton,
    cssEscape: (value) => String(value),
    dedupeArtifacts: (artifacts) => [
      ...new Map((artifacts || []).map((item) => [item.id, item])).values(),
    ],
    defaultNextFollowUpDate: () => "2026-08-15",
    documentList,
    escapeHtml,
    getActiveWorkspaceRoute: () => route,
    getActiveWorkspaceView: () => route.path.slice(1),
    isMobileShell: () => false,
    isOperationsHomeVisible: () => true,
    isWorkspaceRouteFresh: () => options.fresh !== false,
    libraryTitle,
    navigateCanonicalWorkspace: (path, params = {}, navigationOptions = {}) => {
      navigations.push({ path, params, options: navigationOptions });
      return { ready: Promise.resolve() };
    },
    openBundlePanel: (id) => openedCards.push(id),
    openTaskPanel: (id) => openedTasks.push(id),
    promptUser: options.promptUser || (() => "Needs revision"),
    refreshDocuments: async () => {},
    renderEntityLoadState: (container, entity) => {
      entityStates.push(entity);
      const marker = new FakeElement("p");
      marker.textContent = `${entity.kind} ${entity.status}`;
      container.replaceChildren(marker);
    },
    renderHonestState: honestState,
    reportError: (message) => errors.push(message),
    request: async (url, requestOptions = {}) => {
      const entry = { url, options: requestOptions };
      requests.push(entry);
      return options.request ? options.request(url, requestOptions, entry) : {};
    },
    scheduleAnimationFrame: (callback) => callback(),
    setPageTitle() {},
    setStatus: (message) => statuses.push(message),
    showCreate() {},
    state,
    tasksFromWorkPayload: (payload) =>
      Array.isArray(payload) ? payload : payload?.tasks || [],
    todayIsoDate: () => "2026-08-12",
    workApiUrl: apiUrl,
    workTaskTitle: (task) => task.description || task.title || task.id,
  });

  return {
    api,
    clearSelectionButton,
    document,
    documentList,
    entityStates,
    errors,
    libraryTitle,
    navigations,
    openedCards,
    openedTasks,
    requests,
    setRoute: (value) => {
      route = value;
    },
    state,
    statuses,
  };
}

function createAdminHarness(options = {}) {
  const documentList = new FakeElement("main");
  const libraryTitle = new FakeElement("h1");
  const clearSelectionButton = new FakeElement("button");
  const document = new OperationsDocument(documentList, libraryTitle);
  globalThis.document = document;
  const requests = [];
  const errors = [];
  const statuses = [];
  const api = createAdminSurface({
    apiUrl,
    buildOperationsHomeModel: () => ({ recurring: { configs: [] } }),
    clearSelectionButton,
    currentOperatorIdFromPayload: (payload) => payload?.id || "",
    documentList,
    getActiveWorkspaceView: () => options.view || "users",
    getOperationsQualitySnapshot: () => ({}),
    getOperationsRecurringSnapshot: () => ({}),
    getOperationsWorkSnapshot: () => ({}),
    libraryTitle,
    listDraftPaths: () => [],
    refreshDocuments: async () => {},
    renderHonestState: honestState,
    renderSurfaceHeader: (title, description) => {
      const header = new FakeElement("header");
      header.textContent = `${title}: ${description}`;
      return header;
    },
    request: async (url, requestOptions = {}) => {
      const entry = { url, options: requestOptions };
      requests.push(entry);
      return options.request ? options.request(url, requestOptions, entry) : {};
    },
    setPageTitle() {},
    setStatus: (message) => statuses.push(message),
    settledPayload: (result) =>
      result.status === "fulfilled" ? result.value : null,
    showCreate() {},
    showErrorToast: (message) => errors.push(message),
    showWorkspaceSurface() {},
    surfaceDescription: (surface) => `${surface} surface`,
    surfaceStatusText: () => "Admin diagnostics",
    usersFromWorkPayload: (payload) =>
      Array.isArray(payload) ? payload : payload?.users || [],
    workApiUrl: apiUrl,
  });
  return {
    api,
    document,
    documentList,
    errors,
    requests,
    statuses,
  };
}

describe("Operations surface boundary", () => {
  test("directly imports production factories and exposes stable Operations and Admin facades", () => {
    assert.deepEqual(Object.keys(createOperationsHarness().api).sort(), [
      "refreshIntakeSnapshot",
      "refreshOperationsArtifactSnapshot",
      "refreshOperationsAssistantSnapshot",
      "renderArtifactsSurface",
      "renderAssistantsSurface",
      "renderInboxSurface",
      "resolveIntakeRouteEntity",
    ]);
    assert.deepEqual(Object.keys(createAdminHarness().api).sort(), [
      "refreshUsersSurface",
      "renderAdminSurface",
      "renderAdminSurfaceView",
      "renderUsersSurfaceView",
    ]);
  });

  test("renders unavailable, empty, and safe linked Artifact states", () => {
    const harness = createOperationsHarness();
    harness.state.artifactSnapshot = {
      loaded: false,
      artifacts: [],
      errors: ["artifact API offline"],
    };
    assert.ok(
      findByText(
        harness.api.renderArtifactsSurface(),
        "Artifact review index not connected",
        "strong",
      ),
    );

    harness.state.artifactSnapshot = {
      loaded: true,
      artifacts: [],
      errors: [],
    };
    assert.ok(
      findByText(
        harness.api.renderArtifactsSurface(),
        "No artifacts registered",
        "strong",
      ),
    );

    harness.state.artifactSnapshot.artifacts = [
      {
        id: "artifact-1",
        title: "Approved issue",
        status: "approved",
        type: "newsletter",
        taskId: "task-1",
        storageUri: "https://example.test/issue",
      },
      {
        id: "artifact-2",
        title: "Missing storage",
        status: "draft",
      },
    ];
    const list = harness.api.renderArtifactsSurface();
    const open = findByText(list, "Open", "a");
    assert.equal(open.href, "https://example.test/issue");
    assert.equal(open.target, "_blank");
    assert.equal(open.rel, "noopener");
    assert.equal(findAllByClass(list, "ops-data-row").length, 2);
    assert.equal(list.querySelectorAll("a").length, 1);
  });

  test("refreshes Artifact and Assistant snapshots honestly on list, invalid payload, and failure", async () => {
    let mode = "loaded";
    const harness = createOperationsHarness({
      request: async (url) => {
        if (url === "/api/artifacts") {
          if (mode === "failed") throw new Error("artifact timeout");
          if (mode === "invalid") return {};
          return {
            artifacts: [
              { id: "same", title: "old" },
              { id: "same", title: "new" },
            ],
          };
        }
        if (url === "/api/assistant-jobs") {
          if (mode === "failed") throw new Error("assistant timeout");
          return mode === "invalid" ? {} : { jobs: [{ id: "job-1" }] };
        }
        return {};
      },
    });
    await harness.api.refreshOperationsArtifactSnapshot();
    await harness.api.refreshOperationsAssistantSnapshot();
    assert.equal(harness.state.artifactSnapshot.loaded, true);
    assert.deepEqual(harness.state.artifactSnapshot.artifacts, [
      { id: "same", title: "new" },
    ]);
    assert.equal(harness.state.assistantSnapshot.loaded, true);

    mode = "invalid";
    await harness.api.refreshOperationsArtifactSnapshot();
    await harness.api.refreshOperationsAssistantSnapshot();
    assert.match(harness.state.artifactSnapshot.errors[0], /not connected/);
    assert.match(harness.state.assistantSnapshot.errors[0], /not connected/);

    mode = "failed";
    await harness.api.refreshOperationsArtifactSnapshot();
    await harness.api.refreshOperationsAssistantSnapshot();
    assert.deepEqual(harness.state.artifactSnapshot.errors, [
      "artifact timeout",
    ]);
    assert.deepEqual(harness.state.assistantSnapshot.errors, [
      "assistant timeout",
    ]);
  });

  test("renders Admin diagnostics while preserving success, empty, and failure truth", async () => {
    const harness = createAdminHarness({
      view: "admin",
      request: async (url) => {
        if (url === "/docs/process-quality") {
          return { summary: { total: 0 }, validationErrors: [] };
        }
        if (url === "/git/status") {
          return { ok: true, count: 0, branch: "main" };
        }
        if (url === "/git/log") throw new Error("History offline");
        return {};
      },
    });
    harness.api.renderAdminSurfaceView([]);
    const pendingDiagnostics = harness.documentList.querySelector(
      ".ops-admin-diagnostics",
    );
    assert.match(pendingDiagnostics.innerHTML, /Loading local validation/);
    assert.match(pendingDiagnostics.innerHTML, /Loading availability/);
    await nextTicks();
    const diagnostics = harness.documentList.querySelector(
      ".ops-admin-diagnostics",
    );
    assert.match(diagnostics.innerHTML, /Read-only diagnostics/);
    assert.match(
      diagnostics.querySelector('[data-diagnostic="quality"] span').textContent,
      /0 finding\(s\); 0 validation error/,
    );
    assert.equal(
      diagnostics.querySelector('[data-diagnostic="git-status"] span')
        .textContent,
      "0 changed file(s) on main.",
    );
    assert.equal(
      diagnostics.querySelector('[data-diagnostic="git-history"] span')
        .textContent,
      "Unavailable: History offline",
    );
  });

  test("filters Inbox new, blocked, and resolved items while preserving canonical detail navigation", async () => {
    const items = [
      { id: "new-1", title: "New request", status: "new" },
      {
        id: "blocked-1",
        title: "Waiting request",
        status: "blocked",
        waitingFor: "Sponsor",
        followUpAt: "2026-08-10",
      },
      {
        id: "resolved-1",
        title: "Archived request",
        status: "archived",
        resolutionReason: "Historical",
      },
    ];
    const harness = createOperationsHarness({
      state: {
        ...operationState(),
        intake: {
          ...operationState().intake,
          items,
          filter: "new",
        },
      },
    });
    harness.api.renderInboxSurface();
    assert.equal(findAllByClass(harness.documentList, "intake-row").length, 1);
    await findByText(harness.documentList, "Blocked", "button").click();
    assert.equal(harness.state.intake.filter, "blocked");
    assert.deepEqual(harness.navigations.at(-1), {
      path: "/inbox",
      params: {},
      options: {},
    });

    harness.state.intake.filter = "resolved";
    harness.state.intake.selectedId = "resolved-1";
    harness.api.renderInboxSurface();
    const detail = harness.documentList.querySelector(".intake-detail");
    assert.match(detail.innerHTML, /This item is archived and read-only/);
    assert.match(detail.innerHTML, /Historical/);
    assert.doesNotMatch(detail.innerHTML, /Convert to task/);
  });

  test("validates manual Inbox capture and preserves its canonical mutation payload", async () => {
    const harness = createOperationsHarness({
      request: async (url, requestOptions = {}) => {
        if (url === "/api/intake" && requestOptions.method === "POST")
          return {};
        if (url === "/api/intake") return { items: [] };
        if (url === "/api/bundles") return { bundles: [] };
        return {};
      },
    });
    harness.api.renderInboxSurface();
    const manualPanel = findAllByClass(harness.documentList, "intake-panel")[0];
    const capture = manualPanel.querySelector("[data-intake-create]");
    await capture.click();
    assert.equal(
      harness.errors.at(-1),
      "Add a note or title before capturing intake.",
    );

    manualPanel.querySelector("[data-intake-create-note]").value =
      "Please prepare the August issue\nWith the latest links";
    manualPanel.querySelector("[data-intake-create-title]").value =
      "August issue";
    manualPanel.querySelector("[data-intake-create-tags]").value =
      "newsletter, urgent";
    await capture.click();
    const request = harness.requests.find(
      (entry) => entry.url === "/api/intake" && entry.options.method === "POST",
    );
    assert.deepEqual(jsonBody(request), {
      source: "manual",
      title: "August issue",
      note: "Please prepare the August issue\nWith the latest links",
      dataClass: "internal",
      tags: ["newsletter", "urgent"],
    });
    assert.equal(harness.state.intake.filter, "actionable");
    assert.ok(harness.statuses.includes("Manual intake captured."));
  });

  test("validates and submits atomic Inbox block actions, retaining conflict recovery state", async () => {
    const item = { id: "intake-1", title: "Sponsor request", status: "new" };
    let reject = false;
    const harness = createOperationsHarness({
      state: {
        ...operationState(),
        intake: {
          ...operationState().intake,
          items: [item],
          selectedId: item.id,
        },
      },
      request: async (url, requestOptions = {}) => {
        if (url === "/api/intake/intake-1/block") {
          if (reject) throw new Error("Version conflict; reload the item");
          return { item: { ...item, status: "blocked" } };
        }
        if (url === "/api/intake") return { items: [item] };
        if (url === "/api/bundles") return { bundles: [] };
        return {};
      },
    });
    harness.api.renderInboxSurface();
    let block = harness.documentList
      .querySelector(".intake-detail")
      .querySelectorAll("[data-intake-submit]")
      .find((button) => button.dataset.intakeSubmit === "block");
    const details = block.closest("details");
    assert.ok((block.listeners.get("click") || []).length > 0);
    assert.equal(details.fields.reason.value, "");
    await block.click();
    assert.equal(harness.state.intakeMutation.error, "Reason is required.");
    assert.equal(details.fields.reason.focused, true);

    details.fields.reason.value = "Need confirmation";
    await block.click();
    const atomic = harness.requests.find(
      (entry) => entry.url === "/api/intake/intake-1/block",
    );
    assert.equal(atomic.options.method, "POST");
    assert.deepEqual(jsonBody(atomic), {
      reason: "Need confirmation",
      waitingFor: "Sponsor",
      followUpAt: "2026-08-15",
    });

    reject = true;
    harness.state.intake.selectedId = item.id;
    harness.api.renderInboxSurface();
    block = harness.documentList
      .querySelector(".intake-detail")
      .querySelectorAll("[data-intake-submit]")
      .find((button) => button.dataset.intakeSubmit === "block");
    block.closest("details").fields.reason.value = "Still waiting";
    await block.click();
    assert.equal(
      harness.state.intakeMutation.error,
      "Version conflict; reload the item",
    );
    assert.equal(harness.state.intakeMutation.busy, false);
  });

  test("maps blocked Inbox response and follow-up actions to atomic request contracts", async () => {
    const item = {
      id: "intake-blocked",
      title: "Waiting for sponsor",
      status: "blocked",
      waitingFor: "Sponsor",
      followUpAt: "2026-08-20",
    };
    const harness = createOperationsHarness({
      state: {
        ...operationState(),
        intake: {
          ...operationState().intake,
          items: [item],
          selectedId: item.id,
        },
      },
      request: async (url) => {
        if (url === "/api/intake") return { items: [item] };
        if (url === "/api/bundles") return { bundles: [] };
        return {};
      },
    });
    harness.api.renderInboxSurface();
    let detail = harness.documentList.querySelector(".intake-detail");
    let actionButtons = detail.querySelectorAll("[data-intake-submit]");
    await actionButtons
      .find((button) => button.dataset.intakeSubmit === "response-received")
      .click();
    const response = harness.requests.find((entry) =>
      entry.url.endsWith("/response-received"),
    );
    assert.deepEqual(jsonBody(response), {
      note: "Received the requested copy",
    });

    harness.state.intake.selectedId = item.id;
    harness.api.renderInboxSurface();
    detail = harness.documentList.querySelector(".intake-detail");
    actionButtons = detail.querySelectorAll("[data-intake-submit]");
    await actionButtons
      .find((button) => button.dataset.intakeSubmit === "follow-up-sent")
      .click();
    const followUp = harness.requests.find((entry) =>
      entry.url.endsWith("/follow-up-sent"),
    );
    assert.deepEqual(jsonBody(followUp), {
      note: "Sent another email",
      nextFollowUpAt: "2026-08-18",
      channel: "intake",
    });
  });

  test("recovers stale and not-found Inbox routes without inventing an item", async () => {
    const notFound = new Error("Intake missing");
    notFound.status = 404;
    const harness = createOperationsHarness({
      request: async (url) => {
        if (url === "/api/intake") return { items: [] };
        if (url === "/api/bundles") return { bundles: [] };
        if (url === "/api/intake/missing") throw notFound;
        return {};
      },
    });
    const route = {
      path: "/inbox",
      params: new URLSearchParams("intakeId=missing"),
    };
    harness.setRoute(route);
    await harness.api.resolveIntakeRouteEntity(route, 1);
    assert.deepEqual(harness.state.workspaceEntity, {
      kind: "intake",
      id: "missing",
      status: "not-found",
      error: "Intake missing",
    });
    assert.equal(harness.entityStates.at(-1).status, "not-found");
    harness.entityStates.at(-1).retry();
    assert.deepEqual(harness.navigations.at(-1).options, { history: "none" });
    harness.entityStates.at(-1).returnToList();
    assert.equal(harness.navigations.at(-1).path, "/inbox");
  });

  test("renders Assistant status action hierarchy and records approval plus retry request shapes", async () => {
    const waiting = {
      id: "job-review",
      title: "Review issue",
      assistantType: "podcast",
      status: "waiting_approval",
      attemptCount: 1,
      maxAttempts: 2,
    };
    const failed = {
      id: "job-failed",
      title: "Retry issue",
      assistantType: "podcast",
      status: "failed",
      attemptCount: 1,
      maxAttempts: 2,
    };
    const harness = createOperationsHarness({
      state: {
        ...operationState(),
        assistantSnapshot: {
          loaded: true,
          jobs: [waiting, failed],
          errors: [],
        },
        assistantQueue: { filter: "all", selectedJobId: waiting.id },
      },
      request: async (url, requestOptions = {}) => {
        if (url === "/api/assistant-jobs/job-review") {
          return { job: waiting, artifacts: [], events: [] };
        }
        if (url === "/api/assistant-jobs/job-failed") {
          return { job: failed, artifacts: [], events: [] };
        }
        if (url === "/api/assistant-jobs") return { jobs: [waiting, failed] };
        if (url.endsWith("/retry"))
          return { job: { ...failed, status: "retrying" } };
        return {};
      },
    });
    let surface = harness.api.renderAssistantsSurface();
    await nextTicks();
    let detail = surface.querySelector("[data-assistant-detail]");
    const hierarchy = detail
      .querySelectorAll("[data-assistant-lifecycle]")
      .map((button) => button.dataset.assistantLifecycle);
    assert.deepEqual(hierarchy, ["approve", "reject", "cancel"]);
    await detail
      .querySelectorAll("[data-assistant-lifecycle]")
      .find((button) => button.dataset.assistantLifecycle === "approve")
      .click();
    assert.ok(
      harness.requests.some(
        (entry) =>
          entry.url === "/api/assistant-jobs/job-review/approve" &&
          entry.options.method === "POST",
      ),
    );

    harness.state.assistantQueue.selectedJobId = failed.id;
    surface = harness.api.renderAssistantsSurface();
    await nextTicks();
    detail = surface.querySelector("[data-assistant-detail]");
    const retry = detail
      .querySelectorAll("[data-assistant-lifecycle]")
      .find((button) => button.dataset.assistantLifecycle === "retry");
    await retry.click();
    assert.ok(
      harness.requests.some(
        (entry) => entry.url === "/api/assistant-jobs/job-failed/retry",
      ),
    );
    assert.ok(
      harness.requests.some(
        (entry) => entry.url === "/api/assistant-jobs/job-failed/submit",
      ),
    );
  });

  test("renders Assistant detail failure with retry and canonical return recovery", async () => {
    const failure = new Error("Assistant runner offline");
    const harness = createOperationsHarness({
      state: {
        ...operationState(),
        assistantSnapshot: {
          loaded: true,
          jobs: [{ id: "job-error", status: "failed" }],
          errors: [],
        },
        assistantQueue: { filter: "all", selectedJobId: "job-error" },
      },
      request: async (url) => {
        if (url === "/api/assistant-jobs/job-error") throw failure;
        return { jobs: [] };
      },
    });
    harness.api.renderAssistantsSurface();
    await nextTicks();
    assert.equal(harness.entityStates.at(-1).kind, "assistant job");
    assert.equal(harness.entityStates.at(-1).status, "error");
    harness.entityStates.at(-1).retry();
    await nextTicks();
    assert.ok(
      harness.requests.filter(
        (entry) => entry.url === "/api/assistant-jobs/job-error",
      ).length >= 2,
    );
    harness.entityStates.at(-1).returnToList();
    assert.equal(harness.navigations.at(-1).path, "/assistants");
  });

  test("enforces Users admin denial, then validates create/edit/disable role controls", async () => {
    let users = [
      {
        id: "alexey",
        name: "Alexey",
        email: "alexey@datatalks.club",
        role: "operator",
      },
      {
        id: "grace",
        name: "Grace",
        email: "grace@datatalks.club",
        role: "operator",
      },
    ];
    const harness = createAdminHarness({
      request: async (url, requestOptions = {}) => {
        if (url === "/api/users" && !requestOptions.method) return { users };
        if (url === "/api/me") return { id: "alexey" };
        if (url === "/api/users" && requestOptions.method === "POST") return {};
        if (url === "/api/users/grace" && requestOptions.method === "PATCH")
          return {};
        return {};
      },
    });
    await harness.api.refreshUsersSurface();
    harness.api.renderUsersSurfaceView();
    assert.equal(
      findByText(harness.documentList, "Add user", "button"),
      undefined,
    );
    assert.equal(findByText(harness.documentList, "Edit", "button"), undefined);

    users = users.map((user) =>
      user.id === "alexey" ? { ...user, role: "admin" } : user,
    );
    await harness.api.refreshUsersSurface();
    harness.api.renderUsersSurfaceView();
    await findByText(harness.documentList, "Add user", "button").click();
    let create = findByText(harness.documentList, "Create user", "button");
    await create.click();
    assert.ok(
      findByText(harness.documentList, "Name and email are required.", "p"),
    );
    const inputs = harness.document.created.filter(
      (element) => element.tagName === "INPUT",
    );
    const [name, email, password] = inputs.slice(-3);
    name.value = "Valeriia";
    email.value = "valeriia@datatalks.club";
    password.value = "temporary-password";
    await create.click();
    const created = harness.requests.find(
      (entry) => entry.url === "/api/users" && entry.options.method === "POST",
    );
    assert.deepEqual(jsonBody(created), {
      name: "Valeriia",
      email: "valeriia@datatalks.club",
      role: "operator",
      password: "temporary-password",
    });

    harness.api.renderUsersSurfaceView();
    const graceRow = findAllByClass(harness.documentList, "ops-user-row").find(
      (row) => row.textContent.includes("Grace"),
    );
    await findByText(graceRow, "Edit", "button").click();
    const roleSelect = harness.document.created
      .filter((element) => element.tagName === "SELECT")
      .at(-1);
    roleSelect.value = "admin";
    await findByText(harness.documentList, "Save changes", "button").click();
    const edited = harness.requests.find(
      (entry) =>
        entry.url === "/api/users/grace" &&
        entry.options.method === "PATCH" &&
        jsonBody(entry).role === "admin",
    );
    assert.deepEqual(jsonBody(edited), {
      name: "Grace",
      email: "grace@datatalks.club",
      role: "admin",
    });

    harness.api.renderUsersSurfaceView();
    const refreshedGraceRow = findAllByClass(
      harness.documentList,
      "ops-user-row",
    ).find((row) => row.textContent.includes("Grace"));
    await findByText(refreshedGraceRow, "Disable", "button").click();
    const disabled = harness.requests.find(
      (entry) =>
        entry.url === "/api/users/grace" &&
        entry.options.method === "PATCH" &&
        jsonBody(entry).disabled === true,
    );
    assert.deepEqual(jsonBody(disabled), { disabled: true });
  });
});
