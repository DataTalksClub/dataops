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
      attach: { taskId: "task-existing", cardId: "", note: "Attach safely" },
      "convert-task": {
        date: "2026-08-12",
        assigneeId: "grace",
        cardId: "card-1",
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
  details.append(...fields);
  if (
    [
      "attach",
      "block",
      "prepare-assistant",
      "mark-duplicate",
      "ignore",
      "archive",
    ].includes(action)
  ) {
    const outer = decorateLazyQueries(new FakeElement("details"));
    outer.className = "intake-secondary-actions";
    outer.append(details);
  }
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
      cards: [],
      loaded: true,
      error: "",
    },
    intakeMutation: {
      itemId: "",
      action: "",
      values: {},
      focus: null,
      error: "",
      busy: false,
      status: "",
    },
    assistantQueue: { filter: "all", selectedJobId: null },
    assistantSnapshot: { loaded: true, jobs: [], errors: [] },
    artifactSnapshot: { loaded: true, artifacts: [], errors: [] },
    workSnapshot: { cards: [] },
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
    openCardPanel: (id) => openedCards.push(id),
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
    renderSurfaceHeader: (title, description) => {
      const header = new FakeElement("header");
      header.textContent = `${title}: ${description}`;
      return header;
    },
    reportError: (message) => errors.push(message),
    request: async (url, requestOptions = {}) => {
      const entry = { url, options: requestOptions };
      requests.push(entry);
      return options.request ? options.request(url, requestOptions, entry) : {};
    },
    scheduleAnimationFrame: (callback) => callback(),
    setRouteTitle() {},
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
  const documentRefreshes = [];
  let activeRouteToken = options.routeToken ?? 1;
  const api = createAdminSurface({
    apiUrl,
    buildOperationsHomeModel: () => ({ recurring: { configs: [] } }),
    clearSelectionButton,
    currentOperatorIdFromPayload: (payload) => payload?.id || "",
    documentList,
    getActiveWorkspaceView: () => options.view || "users",
    getActiveWorkspaceRouteToken: () => activeRouteToken,
    isWorkspaceRouteFresh: (token) =>
      options.isRouteFresh ? options.isRouteFresh(token) : token === activeRouteToken,
    getOperationsQualitySnapshot: () => ({}),
    getOperationsRecurringSnapshot: () => ({}),
    getOperationsWorkSnapshot: () => ({}),
    libraryTitle,
    listDraftPaths: () => [],
    refreshDocuments: async () => documentRefreshes.push("users"),
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
    setRouteTitle() {},
    settledPayload: (result) =>
      result.status === "fulfilled" ? result.value : null,
    showCreate() {},
    showWorkspaceSurface() {},
    surfaceDescription: (surface) => `${surface} surface`,
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
    documentRefreshes,
    setActiveRouteToken: (value) => {
      activeRouteToken = value;
    },
  };
}

function submitUserForm(root) {
  // The user form submits natively so Enter and the primary button share one
  // path; the test exercises that path rather than a synthetic click.
  const form = findAllByClass(root, "ops-user-form")[0];
  if (!form) throw new Error("User form is not rendered");
  return form.dispatch("submit");
}

function submitDeviceForm(root) {
  const form = findAllByClass(root, "device-form")[0];
  if (!form) throw new Error("Device form is not rendered");
  return form.dispatch("submit");
}

describe("Operations surface boundary", () => {
  test("directly imports production factories and exposes stable Operations and Admin facades", () => {
    assert.deepEqual(Object.keys(createOperationsHarness().api).sort(), [
      "refreshIntakeSnapshot",
      "refreshOperationsArtifactSnapshot",
      "refreshOperationsAssistantSnapshot",
      "renderArtifactsSurface",
      "renderAssistantsSurface",
      "renderDeviceSurfaceView",
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
      {
        id: "artifact-3",
        title: "Malformed link",
        status: "approved",
        storageUri: "https://example.test/edit%20%22%E2%80%8C%22",
      },
    ];
    const list = harness.api.renderArtifactsSurface();
    const open = findByText(list, "Open artifact", "a");
    assert.equal(open.href, "https://example.test/issue");
    assert.equal(open.target, "_blank");
    assert.equal(open.rel, "noopener");
    assert.equal(
      open.getAttribute("aria-label"),
      "Open Approved issue for task task-1",
    );
    assert.equal(findAllByClass(list, "ops-data-row").length, 3);
    assert.equal(list.querySelectorAll("a").length, 2);
    assert.equal(
      list.querySelectorAll("a")[1].href,
      "https://example.test/edit",
    );
  });

  test("restores Device code focus after validation rerenders", async () => {
    const harness = createOperationsHarness({
      route: { path: "/device", params: new URLSearchParams() },
    });
    harness.api.renderDeviceSurfaceView();
    const initialInput = findAllByClass(
      harness.documentList,
      "device-code-input",
    )[0];
    await submitDeviceForm(harness.documentList);

    const refreshedInput = findAllByClass(
      harness.documentList,
      "device-code-input",
    )[0];
    assert.notEqual(refreshedInput, initialInput);
    assert.equal(refreshedInput.focused, true);
  });

  test("shows Device lookup pending, failure, and decision state in the page itself", async () => {
    let resolveLookup;
    let resolveDecision;
    let lookupCalls = 0;
    const grant = {
      label: "test-machine",
      requestIp: "10.0.0.3",
      createdAt: "2026-08-12T09:10:00.000Z",
    };
    const harness = createOperationsHarness({
      request: async (url) => {
        if (String(url).includes("/api/auth/device/pending")) {
          lookupCalls += 1;
          if (lookupCalls > 1) return grant;
          return new Promise((resolve, reject) => {
            resolveLookup = { resolve, reject };
          });
        }
        if (String(url).includes("/api/auth/device/approve")) {
          return new Promise((resolve) => {
            resolveDecision = resolve;
          });
        }
        return { status: "approved" };
      },
      route: { path: "/device", params: new URLSearchParams() },
    });
    harness.api.renderDeviceSurfaceView();
    const summary = harness.documentList.querySelector(".surface-summary");
    assert.equal(summary.dataset.summaryId, "device");
    assert.match(summary.textContent, /Enter the code shown by the DataOps CLI/);
    assert.deepEqual(harness.statuses, [], "no hidden status writer is used");

    const input = findAllByClass(harness.documentList, "device-code-input")[0];
    input.value = "ABCD-1234";
    harness.document.activeElement = findByText(
      harness.documentList,
      "Continue",
      "button",
    );
    submitDeviceForm(harness.documentList);
    await nextTicks();
    const pending = harness.documentList.querySelector(".surface-summary");
    assert.equal(pending.dataset.summaryState, "loading");
    assert.match(pending.textContent, /Checking that code with the work API/);
    const pendingButton = findByText(
      harness.documentList,
      "Checking code…",
      "button",
    );
    assert.equal(pendingButton.disabled, true);
    assert.equal(pendingButton.getAttribute("aria-busy"), "true");
    assert.equal(
      pending.querySelector(".surface-summary-line").focused,
      true,
      "replacing the submitted control moves focus to the pending owner",
    );

    const notFound = new Error("Unknown code");
    notFound.status = 404;
    resolveLookup.reject(notFound);
    await nextTicks(4);
    const failure = findAllByClass(harness.documentList, "device-error")[0];
    assert.equal(failure.getAttribute("role"), "alert");
    assert.match(failure.textContent, /not waiting for confirmation/);
    assert.equal(
      findByText(harness.documentList, "Continue", "button").disabled,
      false,
    );
    const retriedInput = findAllByClass(
      harness.documentList,
      "device-code-input",
    )[0];
    assert.equal(
      retriedInput.focused,
      true,
      "a lookup failure returns keyboard ownership to the code field",
    );
    assert.deepEqual(harness.errors, [], "no global toast for a device failure");

    input.value = "ABCD-1234";
    await submitDeviceForm(harness.documentList);
    await nextTicks(4);
    const authorize = findByText(harness.documentList, "Authorize", "button");
    const deny = findByText(harness.documentList, "Deny", "button");
    assert.equal(authorize.disabled, false);
    assert.equal(deny.disabled, false);
    harness.document.activeElement = authorize;
    const decision = authorize.click();
    const pendingDecision = harness.documentList.querySelector(
      ".surface-summary-line",
    );
    assert.match(
      pendingDecision.textContent,
      /Sending your decision to the work API/,
    );
    assert.equal(pendingDecision.focused, true);
    assert.equal(
      findByText(harness.documentList, "Authorize", "button").disabled,
      true,
    );
    assert.equal(
      findByText(harness.documentList, "Deny", "button").disabled,
      true,
    );
    resolveDecision({ status: "approved" });
    await decision;
    await nextTicks(2);
    const approved = findAllByClass(harness.documentList, "device-outcome")[0];
    assert.equal(approved.getAttribute("role"), "status");
    assert.match(approved.textContent, /Device authorized/);
    assert.equal(approved.focused, true);
  });

  test("does not tell a signed-in operator to sign in when a device code is unknown", async () => {
    const harness = createOperationsHarness({
      request: async (url) => {
        if (String(url).includes("/api/auth/device/pending")) {
          const error = new Error("Unauthorized");
          error.status = 401;
          throw error;
        }
        throw new Error(`Unexpected request ${url}`);
      },
      route: { path: "/device", params: new URLSearchParams() },
    });
    harness.api.renderDeviceSurfaceView();
    const input = findAllByClass(harness.documentList, "device-code-input")[0];
    input.value = "ZZZZ-9999";
    await submitDeviceForm(harness.documentList);
    await nextTicks(4);

    const failure = findAllByClass(harness.documentList, "device-error")[0];
    assert.equal(failure.getAttribute("role"), "alert");
    assert.match(failure.textContent, /not waiting for confirmation/);
    assert.match(failure.textContent, /retry device registration/);
    assert.equal(
      failure.textContent.includes("Sign in to the portal"),
      false,
      "a signed-in operator is not told to sign in",
    );
    const retriedInput = findAllByClass(
      harness.documentList,
      "device-code-input",
    )[0];
    assert.equal(retriedInput.value, "ZZZZ-9999");
    assert.equal(
      findByText(harness.documentList, "Continue", "button").disabled,
      false,
    );
  });

  test("drops a stale Device lookup when the route moves to another code", async () => {
    const pending = [];
    const harness = createOperationsHarness({
      request: async (url) =>
        new Promise((resolve, reject) => {
          pending.push({ resolve, reject, url: String(url) });
        }),
      route: {
        path: "/device",
        params: new URLSearchParams({ userCode: "AAAA-1111" }),
      },
    });
    harness.api.renderDeviceSurfaceView();
    await nextTicks();
    assert.equal(pending.length, 1);
    assert.match(pending[0].url, /userCode=AAAA-1111/);

    harness.setRoute({
      path: "/device",
      params: new URLSearchParams({ userCode: "BBBB-2222" }),
    });
    harness.api.renderDeviceSurfaceView();
    await nextTicks();
    assert.equal(pending.length, 2);

    pending[0].resolve({
      label: "stale-machine",
      requestIp: "10.0.0.1",
      createdAt: "2026-08-12T09:00:00.000Z",
    });
    await nextTicks(4);
    assert.equal(
      harness.documentList.textContent.includes("stale-machine"),
      false,
      "an older lookup cannot overwrite the newer route",
    );
    assert.equal(
      harness.documentList.querySelector(".surface-summary").dataset
        .summaryState,
      "loading",
      "the newer lookup still owns the surface",
    );

    pending[1].resolve({
      label: "current-machine",
      requestIp: "10.0.0.2",
      createdAt: "2026-08-12T09:05:00.000Z",
    });
    await nextTicks(4);
    assert.equal(
      harness.documentList.textContent.includes("current-machine"),
      true,
    );
    assert.equal(
      harness.documentList.querySelector(".surface-summary").dataset
        .summaryState,
      "ready",
    );
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

  test("retries partial Admin diagnostics from its owning surface", async () => {
    let runs = 0;
    const releases = [];
    const harness = createAdminHarness({
      view: "admin",
      request: async () =>
        new Promise((resolve, reject) => {
          runs += 1;
          releases.push({ resolve, reject });
        }),
    });
    harness.api.renderAdminSurfaceView([]);
    const diagnostics = harness.documentList.querySelector(
      ".ops-admin-diagnostics",
    );
    const summary = diagnostics.querySelector(
      ".ops-admin-diagnostics-summary",
    );
    const retry = diagnostics.querySelector(".surface-summary-retry");

    assert.equal(runs, 3);
    assert.equal(retry.hidden, true);
    assert.equal(retry.disabled, true);
    for (const { reject } of releases.splice(0))
      reject(new Error("Synthetic diagnostics outage"));
    await nextTicks(3);

    assert.equal(summary.dataset.summaryState, "unavailable");
    assert.equal(summary.getAttribute("role"), "alert");
    assert.equal(summary.getAttribute("aria-live"), "assertive");
    assert.match(summary.textContent, /0 of 3 read-only diagnostics answered/);
    assert.equal(retry.hidden, false);
    assert.equal(retry.disabled, false);
    assert.equal(retry.getAttribute("aria-busy"), null);

    const retrying = retry.click();
    assert.equal(runs, 6);
    assert.equal(retry.disabled, true);
    assert.equal(retry.getAttribute("aria-busy"), "true");
    assert.match(retry.textContent, /Retrying diagnostics/);
    for (const [index, release] of releases.entries()) {
      if (index === 0)
        release.resolve({ summary: { total: 0 }, validationErrors: [] });
      else if (index === 1)
        release.resolve({ ok: true, count: 0, branch: "main" });
      else release.resolve({ commits: [{ hash: "abc" }] });
    }
    await nextTicks(4);

    assert.equal(summary.dataset.summaryState, "ready");
    assert.equal(summary.getAttribute("role"), "status");
    assert.equal(summary.getAttribute("aria-live"), "polite");
    assert.match(summary.textContent, /3 of 3 read-only diagnostics answered/);
    assert.equal(retry.hidden, true);
    assert.equal(retry.disabled, true);
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
        if (url === "/api/cards") return { cards: [] };
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
        if (url === "/api/cards") return { cards: [] };
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

  test("rehydrates an open Inbox action draft and focus across a background refresh", async () => {
    const item = { id: "intake-draft", title: "Draft request", status: "new" };
    let blockMutations = 0;
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
        if (url === "/api/intake") return { items: [item] };
        if (url === "/api/cards") return { cards: [] };
        if (url === "/api/intake/intake-draft/block") {
          blockMutations += 1;
          return { item: { ...item, status: "blocked" } };
        }
        throw new Error(`Unexpected request ${url} ${requestOptions.method || "GET"}`);
      },
    });
    harness.api.renderInboxSurface();
    const initialDetail = harness.documentList.querySelector(".intake-detail");
    const initialBlock = initialDetail
      .querySelectorAll("[data-intake-submit]")
      .find((button) => button.dataset.intakeSubmit === "block");
    const initialDisclosure = initialBlock.closest("details");
    const initialDisclosureGroup = initialDisclosure.parentElement;
    initialDisclosureGroup.open = true;
    await initialDisclosureGroup.dispatch("toggle");
    initialDisclosure.open = true;
    await initialDisclosure.dispatch("toggle");
    initialDisclosure.fields.reason.value = "Need exact confirmation";
    initialDisclosure.fields.waitingFor.value = "Named reviewer";
    initialDisclosure.fields.followUpAt.value = "2026-08-19";
    await initialDisclosure.fields.reason.dispatch("input");
    await initialDisclosure.fields.waitingFor.dispatch("input");
    await initialDisclosure.fields.followUpAt.dispatch("focus");
    await initialDisclosure.fields.followUpAt.dispatch("change");

    await harness.api.refreshIntakeSnapshot({ rerender: true });

    const refreshedDetail = harness.documentList.querySelector(".intake-detail");
    assert.notEqual(refreshedDetail, initialDetail);
    const refreshedBlock = refreshedDetail
      .querySelectorAll("[data-intake-submit]")
      .find((button) => button.dataset.intakeSubmit === "block");
    const refreshedDisclosure = refreshedBlock.closest("details");
    const refreshedDisclosureGroup = refreshedDisclosure.parentElement;
    assert.equal(
      refreshedDisclosureGroup.classList.contains("intake-secondary-actions"),
      true,
    );
    assert.equal(refreshedDisclosureGroup.open, true);
    assert.equal(refreshedDisclosure.open, true);
    assert.equal(
      refreshedDisclosure.fields.reason.value,
      "Need exact confirmation",
    );
    assert.equal(refreshedDisclosure.fields.waitingFor.value, "Named reviewer");
    assert.equal(refreshedDisclosure.fields.followUpAt.value, "2026-08-19");
    assert.equal(refreshedDisclosure.fields.followUpAt.focused, true);

    await refreshedBlock.click();
    const mutation = harness.requests.find(
      (entry) => entry.url === "/api/intake/intake-draft/block",
    );
    assert.deepEqual(jsonBody(mutation), {
      reason: "Need exact confirmation",
      waitingFor: "Named reviewer",
      followUpAt: "2026-08-19",
    });
    assert.equal(blockMutations, 1);
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
        if (url === "/api/cards") return { cards: [] };
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
        if (url === "/api/cards") return { cards: [] };
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

  test("reports Users load state, durable success, and row failure in the Users surface", async () => {
    let mode = "ok";
    const users = [
      {
        id: "alexey",
        name: "Alexey",
        email: "alexey@datatalks.club",
        role: "admin",
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
        if (url === "/api/users" && !requestOptions.method) {
          if (mode === "down") throw new Error("Synthetic route failure (503)");
          return { users };
        }
        if (url === "/api/me") return { id: "alexey" };
        if (url === "/api/users/grace" && requestOptions.method === "PATCH") {
          if (mode === "patch-fails") {
            throw new Error("Synthetic route failure (503)");
          }
          return {};
        }
        return {};
      },
    });

    harness.api.renderUsersSurfaceView();
    const loading = harness.documentList.querySelector(".surface-summary");
    assert.equal(loading.dataset.summaryState, "loading");
    assert.equal(loading.dataset.summaryId, "users");

    mode = "down";
    await harness.api.refreshUsersSurface();
    harness.api.renderUsersSurfaceView();
    const outage = harness.documentList.querySelector(".surface-summary");
    assert.equal(outage.dataset.summaryState, "unavailable");
    assert.equal(
      outage.querySelector(".surface-summary-line").getAttribute("role"),
      "alert",
    );
    assert.equal(
      outage.querySelector(".surface-summary-detail").textContent,
      "Synthetic route failure (503)",
    );

    mode = "ok";
    await outage.querySelector(".surface-summary-retry").dispatch("click");
    await nextTicks();
    harness.api.renderUsersSurfaceView();
    const ready = harness.documentList.querySelector(".surface-summary");
    assert.equal(ready.dataset.summaryState, "ready");
    assert.match(ready.textContent, /2 users\./);

    const graceRow = findAllByClass(harness.documentList, "ops-user-row").find(
      (row) => row.textContent.includes("Grace"),
    );
    const disable = findByText(graceRow, "Disable", "button");
    await disable.click();
    await nextTicks();
    harness.api.renderUsersSurfaceView();
    const outcome = harness.documentList.querySelector(".ops-users-outcome");
    assert.equal(outcome.getAttribute("role"), "status");
    assert.match(outcome.textContent, /Grace is now disabled\./);
    assert.equal(outcome.focused, true);

    harness.api.renderUsersSurfaceView();
    assert.equal(
      harness.documentList.querySelector(".ops-users-outcome"),
      null,
      "the confirmation is shown once against the refreshed list",
    );

    mode = "patch-fails";
    const retryRow = findAllByClass(harness.documentList, "ops-user-row").find(
      (row) => row.textContent.includes("Grace"),
    );
    await findByText(retryRow, "Disable", "button").click();
    await nextTicks(3);
    harness.api.renderUsersSurfaceView();
    const rowError = harness.documentList.querySelector(".ops-user-row-error");
    assert.equal(rowError.getAttribute("role"), "alert");
    assert.match(rowError.textContent, /Could not disable this account/);
    assert.match(rowError.textContent, /Select Disable to retry/);
    assert.deepEqual(harness.errors, [], "no global toast for a row failure");
  });

  test("confirms a saved user against the refreshed list", async () => {
    const users = [
      {
        id: "alexey",
        name: "Alexey",
        email: "alexey@datatalks.club",
        role: "admin",
      },
    ];
    const harness = createAdminHarness({
      request: async (url, requestOptions = {}) => {
        if (url === "/api/users" && requestOptions.method === "POST") {
          users.push({
            id: "synthetic-user",
            name: "Synthetic User",
            email: "synthetic-user@datatalks.club",
            role: "operator",
          });
          return { user: users.at(-1) };
        }
        if (url === "/api/users" && !requestOptions.method) return { users };
        if (url === "/api/me") return { id: "alexey" };
        throw new Error(`Unexpected request ${url}`);
      },
    });
    await harness.api.refreshUsersSurface();
    harness.api.renderUsersSurfaceView();
    await findByText(harness.documentList, "Add user", "button").click();
    const inputs = harness.documentList.querySelectorAll("input");
    inputs[0].value = "Synthetic User";
    inputs[1].value = "synthetic-user@datatalks.club";
    inputs[2].value = "1111";
    await submitUserForm(harness.documentList);
    await nextTicks(3);
    harness.api.renderUsersSurfaceView();

    const outcome = harness.documentList.querySelector(".ops-users-outcome");
    assert.equal(outcome.getAttribute("role"), "status");
    assert.match(outcome.textContent, /Synthetic User added\./);
    assert.equal(outcome.focused, true);
    assert.match(
      harness.documentList.textContent,
      /synthetic-user@datatalks.club/,
    );
  });

  test("refreshes a stale successful User mutation without replacing the current view", async () => {
    const users = [
      {
        id: "alexey",
        name: "Alexey",
        email: "alexey@datatalks.club",
        role: "admin",
      },
      {
        id: "grace",
        name: "Grace",
        email: "grace@datatalks.club",
        role: "operator",
      },
    ];
    let releasePatch;
    const harness = createAdminHarness({
      request: async (url, requestOptions = {}) => {
        if (url === "/api/users" && !requestOptions.method)
          return { users };
        if (url === "/api/me") return { id: "alexey" };
        if (url === "/api/users/grace" && requestOptions.method === "PATCH") {
          return new Promise((resolve) => {
            releasePatch = () => {
              users[1] = { ...users[1], disabled: true };
              resolve({});
            };
          });
        }
        return {};
      },
    });

    await harness.api.refreshUsersSurface();
    harness.api.renderUsersSurfaceView();
    const graceRow = findAllByClass(harness.documentList, "ops-user-row").find(
      (row) => row.textContent.includes("Grace"),
    );
    const disable = findByText(graceRow, "Disable", "button");

    const mutation = disable.click();
    assert.equal(disable.disabled, true);
    harness.setActiveRouteToken(2);
    releasePatch();
    await mutation;
    await nextTicks(3);

    const mutationIndex = harness.requests.findIndex(
      (entry) =>
        entry.url === "/api/users/grace" &&
        entry.options.method === "PATCH",
    );
    assert.equal(mutationIndex, 2);
    assert.deepEqual(
      harness.requests.slice(mutationIndex + 1).map((entry) => entry.url),
      ["/api/users", "/api/me"],
      "a stale success refreshes the authoritative Users snapshot",
    );
    assert.deepEqual(harness.documentRefreshes, []);
    assert.equal(disable.isConnected, true);
    assert.equal(disable.disabled, true);

    harness.api.renderUsersSurfaceView();
    assert.equal(
      findAllByClass(harness.documentList, "ops-user-row")
        .find((row) => row.textContent.includes("Grace"))
        ?.textContent.includes("disabled"),
      true,
    );
    assert.equal(
      harness.documentList.querySelector(".ops-users-outcome"),
      null,
      "a stale route does not inherit this mutation's confirmation",
    );
  });

  test("refreshes authoritative User data before rendering a conflict Cancel", async () => {
    let users = [
      {
        id: "alexey",
        name: "Alexey",
        email: "alexey@datatalks.club",
        role: "admin",
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
        if (url === "/api/users" && !requestOptions.method)
          return { users };
        if (url === "/api/me") return { id: "alexey" };
        if (
          url === "/api/users/grace" &&
          requestOptions.method === "PATCH"
        ) {
          users[1] = { ...users[1], role: "admin" };
          const error = new Error("Account changed elsewhere");
          error.status = 409;
          throw error;
        }
        throw new Error(`Unexpected request ${url}`);
      },
    });
    await harness.api.refreshUsersSurface();
    harness.api.renderUsersSurfaceView();
    const graceRow = findAllByClass(harness.documentList, "ops-user-row").find(
      (row) => row.textContent.includes("Grace"),
    );
    await findByText(graceRow, "Edit", "button").click();
    const roleSelect = harness.document.created
      .filter((element) => element.tagName === "SELECT")
      .at(-1);
    roleSelect.value = "admin";
    await submitUserForm(harness.documentList);
    await nextTicks();

    const feedback = harness.documentList.querySelector(".form-feedback");
    assert.equal(feedback.dataset.feedbackState, "conflict");
    assert.match(
      feedback.textContent,
      /Cancel to discard these changes and reload users/,
    );

    const mutationIndex = harness.requests.length - 1;
    await findByText(harness.documentList, "Cancel", "button").click();
    await nextTicks(3);
    assert.deepEqual(
      harness.requests.slice(mutationIndex + 1).map(({ url }) => url),
      ["/api/users", "/api/me"],
      "Cancel reads the account again instead of trusting stale form state",
    );
    assert.equal(findByText(harness.documentList, "Save changes", "button"), undefined);
    assert.match(
      findAllByClass(harness.documentList, "surface-summary")[0].textContent,
      /2 users\./,
    );
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
    await submitUserForm(harness.documentList);
    const validation = findAllByClass(harness.documentList, "field-error").filter(
      (node) => !node.hidden,
    );
    assert.deepEqual(
      validation.map((node) => node.textContent),
      ["Name is required.", "Email is required.", "Password is required."],
    );
    const inputs = harness.document.created.filter(
      (element) => element.tagName === "INPUT",
    );
    const [name, email, password] = inputs.slice(-3);
    assert.equal(name.getAttribute("aria-invalid"), "true");
    assert.equal(name.focused, true, "focus moves to the first invalid field");
    name.value = "Valeriia";
    email.value = "valeriia@datatalks.club";
    password.value = "temporary-password";
    await submitUserForm(harness.documentList);
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
    await submitUserForm(harness.documentList);
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
