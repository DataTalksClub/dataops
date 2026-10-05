import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import {
  createAdminSurface,
  createOperationsSurface,
} from "../src/surfaces/operations/index.js";
import { formatTaskDateMeta } from "../src/core/workspace.js";
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

function decorateLazyQueries(element) {
  const lazy = new Map();
  const originalQuery = element.querySelector.bind(element);
  const originalQueryAll = element.querySelectorAll.bind(element);
  element.querySelector = (selector) => {
    const requestedData = selectorDataset(selector);
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
    }
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
    assistantMutation: {
      target: "",
      action: "",
      values: {},
      error: "",
      busy: false,
      status: "",
      phase: "idle",
      routeToken: 1,
    },
    assistantQueue: { filter: "all", selectedJobId: null },
    assistantSnapshot: { loaded: true, jobs: [], errors: [] },
    workSnapshot: { cards: [] },
    workspaceEntity: null,
    ...overrides,
  };
}

function createOperationsHarness(options = {}) {
  const documentList = new FakeElement("main");
  const document = new OperationsDocument(documentList);
  globalThis.document = document;
  const requests = [];
  const navigations = [];
  const entityStates = [];
  const openedTasks = [];
  const openedCards = [];
  const state = operationState(options.state);
  let activeRouteToken = options.routeToken ?? 1;
  let route = options.route || {
    path: "/assistants",
    params: new URLSearchParams(),
  };

  const api = createOperationsSurface({
    assistantJobsFromPayload: (payload) =>
      Array.isArray(payload) ? payload : payload?.jobs || [],
    cssEscape: (value) => String(value),
    defaultNextFollowUpDate: () => "2026-08-15",
    documentList,
    escapeHtml,
    formatTaskDateMeta,
    getActiveWorkspaceRoute: () => route,
    getActiveWorkspaceRouteToken: () => activeRouteToken,
    getActiveWorkspaceView: () => route.path.slice(1),
    isMobileShell: () => false,
    isOperationsWorkspaceVisible: () => true,
    isWorkspaceRouteFresh: (token) =>
      options.fresh !== false && token === activeRouteToken,
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
    request: async (url, requestOptions = {}) => {
      const entry = { url, options: requestOptions };
      requests.push(entry);
      return options.request ? options.request(url, requestOptions, entry) : {};
    },
    scheduleAnimationFrame: (callback) => callback(),
    setRouteTitle() {},
    state,
    tasksFromWorkPayload: (payload) =>
      Array.isArray(payload) ? payload : payload?.tasks || [],
    todayIsoDate: () => "2026-08-12",
    workApiUrl: apiUrl,
    workTaskTitle: (task) => task.description || task.title || task.id,
  });

  return {
    api,
    document,
    documentList,
    entityStates,
    navigations,
    openedCards,
    openedTasks,
    requests,
    setRoute: (value) => {
      route = value;
    },
    setActiveRouteToken: (value) => {
      activeRouteToken = value;
    },
    state,
  };
}

function createAdminHarness(options = {}) {
  const documentList = new FakeElement("main");
  const document = new OperationsDocument(documentList);
  globalThis.document = document;
  const requests = [];
  const documentRefreshes = [];
  let activeRouteToken = options.routeToken ?? 1;
  const api = createAdminSurface({
    apiUrl,
    buildOperationsWorkModel: () => ({ recurring: { configs: [] } }),
    currentOperatorIdFromPayload: (payload) => payload?.id || "",
    documentList,
    getActiveWorkspaceView: () => options.view || "users",
    getActiveWorkspaceRouteToken: () => activeRouteToken,
    isWorkspaceRouteFresh: (token) =>
      options.isRouteFresh ? options.isRouteFresh(token) : token === activeRouteToken,
    getOperationsQualitySnapshot: () => ({}),
    getOperationsRecurringSnapshot: () => ({}),
    getOperationsWorkSnapshot: () => ({}),
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
      "refreshOperationsAssistantSnapshot",
      "renderAssistantsSurface",
      "renderDeviceSurfaceView",
    ]);
    assert.deepEqual(Object.keys(createAdminHarness().api).sort(), [
      "refreshUsersSurface",
      "renderAdminSurface",
      "renderAdminSurfaceView",
      "renderUsersSurfaceView",
    ]);
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

  test("renders Admin diagnostics while preserving success, empty, and failure truth", async () => {
    const harness = createAdminHarness({
      view: "admin",
      request: async (url) => {
        if (url === "/docs/process-quality") {
          return { summary: { total: 0 }, validationErrors: [] };
        }
        if (url === "/knowledge/status") {
          return { ok: true, count: 0, branch: "main" };
        }
        if (url === "/knowledge/publication") throw new Error("History offline");
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
      /0 quality findings; no validation errors/,
    );
    assert.equal(
      diagnostics.querySelector('[data-diagnostic="knowledge-status"] span')
        .textContent,
      "Daily GitHub export is current.",
    );
    assert.equal(
      diagnostics.querySelector('[data-diagnostic="knowledge-publication"] span')
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
    // All three answered: the answers speak for themselves, no mechanics
    // sentence is shown.
    assert.equal(summary.hidden, true);
    assert.equal(summary.textContent, "");
    assert.equal(retry.hidden, true);
    assert.equal(retry.disabled, true);
  });

  test("renders Assistant run-log moments on the Berlin business day, not the UTC clock", async () => {
    // 22:30Z on 12 Aug is 00:30 on 13 Aug in Berlin. The UTC formatter read
    // this minute-old job as "Today 22:30"; the operator's clock says
    // "Tomorrow 00:30". The morning event pins the ordinary same-day case.
    const job = {
      id: "job-clock",
      title: "Clock job",
      assistantType: "podcast",
      status: "draft",
      attemptCount: 0,
      maxAttempts: 2,
    };
    const harness = createOperationsHarness({
      state: {
        ...operationState(),
        assistantSnapshot: { loaded: true, jobs: [job], errors: [] },
        assistantQueue: { filter: "all", selectedJobId: job.id },
      },
      request: async (url) => {
        if (url === "/api/assistant-jobs") return { jobs: [job] };
        return {
          job,
          artifacts: [],
          events: [
            {
              action: "assistant-job-created",
              createdAt: "2026-08-12T22:30:00.000Z",
            },
            {
              action: "assistant-job-queued",
              createdAt: "2026-08-12T09:10:00.000Z",
            },
          ],
        };
      },
    });
    const surface = harness.api.renderAssistantsSurface();
    await nextTicks();
    const detail = surface.querySelector("[data-assistant-detail]");
    assert.match(
      detail.innerHTML,
      /assistant-job-created\s*<\/strong>\s*<span>\s*Tomorrow 00:30/,
      "midnight-crossing event must read Berlin time",
    );
    assert.match(
      detail.innerHTML,
      /assistant-job-queued\s*<\/strong>\s*<span>\s*Today 11:10/,
      "same-day event must read the Berlin clock",
    );
    assert.doesNotMatch(detail.innerHTML, /22:30/);
    assert.doesNotMatch(detail.innerHTML, /09:10/);
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

  test("keeps Assistant load and create feedback in the owning form", async () => {
    const card = { id: "card-assistant", title: "Podcast workflow" };
    const harness = createOperationsHarness({
      state: {
        ...operationState(),
        workSnapshot: { cards: [card] },
        assistantSnapshot: { loaded: false, jobs: [], errors: [] },
      },
      request: async (url, requestOptions = {}) => {
        if (url === "/api/tasks") return { tasks: [] };
        if (
          url === "/api/assistant-jobs" &&
          requestOptions.method === "POST"
        ) {
          const error = new Error("Synthetic route failure (503)");
          error.status = 503;
          throw error;
        }
        return { jobs: [] };
      },
    });

    let surface = harness.api.renderAssistantsSurface();
    let summary = surface.querySelector('[data-summary-id="assistants"]');
    assert.equal(summary.dataset.summaryState, "loading");

    harness.state.assistantSnapshot = {
      loaded: false,
      jobs: [],
      errors: ["Assistant API offline"],
    };
    surface = harness.api.renderAssistantsSurface();
    summary = surface.querySelector('[data-summary-id="assistants"]');
    assert.equal(summary.dataset.summaryState, "unavailable");
    assert.match(summary.textContent, /Assistant API offline/);
    assert.ok(summary.querySelector(".surface-summary-retry"));

    harness.state.assistantSnapshot = { loaded: true, jobs: [], errors: [] };
    surface = harness.api.renderAssistantsSurface();
    summary = surface.querySelector('[data-summary-id="assistants"]');
    assert.equal(summary.dataset.summaryState, "empty");
    const createPanel = findAllByClass(surface, "assistant-panel").find(
      (panel) => panel.className === "assistant-panel",
    );
    const createForm = createPanel.querySelector(".assistant-create-form");
    await createForm.dispatch("submit");
    surface = harness.api.renderAssistantsSurface();
    const validationPanel = findAllByClass(surface, "assistant-panel").find(
      (panel) => panel.className === "assistant-panel",
    );
    assert.match(
      validationPanel.querySelector(".assistant-create-feedback").textContent,
      /Select a Card or Task/,
    );
    const refreshedCreatePanel = findAllByClass(
      surface,
      "assistant-panel",
    ).find((panel) => panel.className === "assistant-panel");
    const cardSelect = refreshedCreatePanel.querySelector("[data-assistant-card]");
    const title = refreshedCreatePanel.querySelector("[data-assistant-title]");
    cardSelect.value = card.id;
    title.value = "Retain this assistant request";
    await cardSelect.dispatch("change");
    await refreshedCreatePanel
      .querySelector("[data-assistant-create]")
      .click();
    harness.api.renderAssistantsSurface();
    const failedCreatePanel = findAllByClass(
      harness.api.renderAssistantsSurface(),
      "assistant-panel",
    ).find((panel) => panel.className === "assistant-panel");
    assert.match(
      failedCreatePanel.querySelector(".assistant-create-feedback").textContent,
      /Synthetic route failure \(503\)/,
    );
    assert.equal(
      harness.state.assistantMutation.values.title,
      "Retain this assistant request",
    );
  });

  test("keeps Assistant lifecycle conflicts recoverable in job detail", async () => {
    const job = {
      id: "job-conflict",
      title: "Review conflict",
      assistantType: "podcast",
      status: "waiting_approval",
      attemptCount: 1,
      maxAttempts: 2,
    };
    const harness = createOperationsHarness({
      state: {
        ...operationState(),
        assistantSnapshot: { loaded: true, jobs: [job], errors: [] },
        assistantQueue: { filter: "all", selectedJobId: job.id },
      },
      request: async (url) => {
        if (url === "/api/assistant-jobs/job-conflict") {
          return { job, artifacts: [], events: [] };
        }
        if (url === "/api/assistant-jobs/job-conflict/approve") {
          const error = new Error("Synthetic route failure (409)");
          error.status = 409;
          throw error;
        }
        return { jobs: [job] };
      },
    });
    let surface = harness.api.renderAssistantsSurface();
    await nextTicks();
    let detail = surface.querySelector("[data-assistant-detail]");
    const approve = detail
      .querySelectorAll("[data-assistant-lifecycle]")
      .find((button) => button.dataset.assistantLifecycle === "approve");
    await approve.click();
    assert.match(harness.state.assistantMutation.error, /changed since it was loaded/);
    surface = harness.api.renderAssistantsSurface();
    await nextTicks();
    detail = surface.querySelector("[data-assistant-detail]");
    const feedback = detail.querySelector(".assistant-detail-feedback");
    assert.equal(feedback.querySelector(".form-feedback-error").getAttribute("role"), "alert");
    assert.match(feedback.textContent, /changed since it was loaded/);
    assert.ok(detail.querySelector('[aria-label="Assistant job recovery"]'));
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
