import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { createWorkspaceState } from "../src/runtime/workspace-state.js";
import { bindApplicationEvents } from "../src/runtime/application-events.js";
import { initializeAppShell } from "../src/shell/bootstrap.js";
import { queryAppDom } from "../src/shell/dom-bindings.js";
import { createApiClient, resolveApiBase } from "../src/shell/api.js";
import { createFeedbackShell } from "../src/shell/feedback.js";
import { createNotificationsShell } from "../src/shell/notifications.js";
import { createPreferencesShell } from "../src/shell/preferences.js";
import {
  FakeDocument,
  FakeElement,
  findByText,
  nextTicks,
} from "./support/fake-dom.mjs";

const originalCustomEvent = globalThis.CustomEvent;

afterEach(() => {
  if (originalCustomEvent === undefined) delete globalThis.CustomEvent;
  else globalThis.CustomEvent = originalCustomEvent;
});

class TestEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.set(
      type,
      (this.listeners.get(type) || []).filter((value) => value !== listener),
    );
  }

  async emit(type, values = {}) {
    const event = {
      type,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.propagationStopped = true;
      },
      target: this,
      ...values,
    };
    for (const listener of [...(this.listeners.get(type) || [])]) {
      await listener(event);
    }
    return event;
  }

  dispatchEvent(event) {
    return this.emit(event.type, event);
  }
}

class TestDocument extends FakeDocument {
  constructor(...roots) {
    super(...roots);
    this.listeners = new Map();
    this.activeElement = null;
    this.body = roots.find((root) => root.tagName === "BODY") || roots[0];
    const properties = new Map();
    this.documentElement = {
      style: {
        getPropertyValue: (name) => properties.get(name) || "",
        setProperty: (name, value) => properties.set(name, String(value)),
      },
    };
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.set(
      type,
      (this.listeners.get(type) || []).filter((value) => value !== listener),
    );
  }

  async emit(type, values = {}) {
    const event = {
      type,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.propagationStopped = true;
      },
      target: this,
      ...values,
    };
    for (const listener of [...(this.listeners.get(type) || [])]) {
      await listener(event);
    }
    return event;
  }

  dispatchEvent(event) {
    return this.emit(event.type, event);
  }
}

function element(id, tagName = "div") {
  const value = new FakeElement(tagName);
  value.id = id;
  value.setAttribute("id", id);
  value.focus = function focus() {
    this.focused = true;
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  };
  value.contains = function contains(candidate) {
    return candidate === this || this.querySelectorAll("*").includes(candidate);
  };
  return value;
}

function attachDocument(document, ...values) {
  for (const value of values) {
    value.ownerDocument = document;
    for (const child of value.children) attachDocument(document, child);
  }
}

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value)),
    values,
  };
}

function jsonResponse(payload, options = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    statusText: options.statusText ?? "OK",
    text: async () =>
      options.raw === undefined ? JSON.stringify(payload) : options.raw,
  };
}

function createWorkspaceHarness() {
  let entity = { status: "idle" };
  let account = { signedIn: { id: "alexey" }, scope: { id: "grace" } };
  const snapshots = {
    artifact: { source: "artifact", loaded: false },
    assistant: { source: "assistant", loaded: false },
    quality: { source: "quality", loaded: false },
    recurring: { source: "recurring", loaded: false },
    work: { source: "work", loaded: false },
  };
  const state = createWorkspaceState({
    emptyOperationsArtifactSnapshot: () => snapshots.artifact,
    emptyOperationsAssistantSnapshot: () => snapshots.assistant,
    emptyOperationsQualitySnapshot: () => snapshots.quality,
    emptyOperationsRecurringSnapshot: () => snapshots.recurring,
    emptyOperationsWorkSnapshot: () => snapshots.work,
    getAccountIdentityState: () => account,
    getWorkspaceEntityState: () => entity,
    setWorkspaceEntityState: (value) => {
      entity = value;
    },
  });
  return {
    get account() {
      return account;
    },
    set account(value) {
      account = value;
    },
    get entity() {
      return entity;
    },
    snapshots,
    state,
  };
}

function createPreferenceHarness(options = {}) {
  const body = element("body", "body");
  const sidebar = element("sidebar", "aside");
  const sidebarButton = element("sidebar-action", "button");
  sidebarButton.offsetParent = sidebar;
  sidebar.append(sidebarButton);
  const sidebarResize = element("sidebar-resize", "button");
  const sidebarScrim = element("sidebar-scrim");
  const mobileMenuButton = element("mobile-menu-button", "button");
  const mobileNewButton = element("mobile-new-button", "button");
  const pageShell = element("page-shell", "main");
  const sidebarExpandButton = element("sidebar-expand-button", "button");
  const themeToggleButton = element("theme-toggle-button", "button");
  const themeLabel = new FakeElement("span");
  themeLabel.className = "settings-theme-label";
  themeToggleButton.append(themeLabel);
  const bell = element("mobile-work-bell-button", "button");
  const document = new TestDocument(
    body,
    sidebar,
    sidebarResize,
    sidebarScrim,
    mobileMenuButton,
    mobileNewButton,
    pageShell,
    sidebarExpandButton,
    themeToggleButton,
    bell,
  );
  attachDocument(document, ...document.roots);
  const media = { matches: Boolean(options.mobile) };
  const store = storage(options.storage);
  let sidebarWidth = options.sidebarWidth || 268;
  sidebar.getBoundingClientRect = () => ({ width: sidebarWidth });
  sidebarResize.setPointerCapture = () => {};
  sidebarResize.releasePointerCapture = () => {};
  const shell = createPreferencesShell({
    body,
    documentRef: document,
    getMobileWorkBellButton: () => bell,
    HTMLElementClass: FakeElement,
    matchMedia: () => media,
    mobileMenuButton,
    mobileNewButton,
    pageShell,
    sidebar,
    sidebarExpandButton,
    sidebarResize,
    sidebarScrim,
    storage: store,
    themeToggleButton,
  });
  return {
    bell,
    body,
    document,
    media,
    mobileMenuButton,
    mobileNewButton,
    pageShell,
    setSidebarWidth: (value) => {
      sidebarWidth = value;
    },
    shell,
    sidebar,
    sidebarButton,
    sidebarExpandButton,
    sidebarResize,
    sidebarScrim,
    store,
    themeLabel,
    themeToggleButton,
  };
}

function createFeedbackHarness() {
  const ids = [
    "confirm-modal",
    "confirm-message",
    "confirm-backdrop",
    "confirm-ok",
    "confirm-cancel",
    "undo-toast",
    "undo-toast-text",
    "undo-toast-button",
    "error-toast",
    "error-toast-text",
    "error-toast-close",
  ];
  const values = Object.fromEntries(
    ids.map((id) => [id, element(id, id.includes("button") ? "button" : "div")]),
  );
  values["confirm-modal"].hidden = true;
  values["undo-toast"].hidden = true;
  values["error-toast"].hidden = true;
  const body = element("body", "body");
  const document = new TestDocument(body, ...Object.values(values));
  attachDocument(document, ...document.roots);
  const timers = [];
  const cleared = [];
  const statuses = [];
  const shell = createFeedbackShell({
    clearTimeoutImpl: (id) => cleared.push(id),
    documentRef: document,
    HTMLElementClass: FakeElement,
    labelizeWorkValue: (value) =>
      String(value || "").replace(/^./, (letter) => letter.toUpperCase()),
    requestAnimationFrameImpl: (callback) => callback(),
    setStatus: (message) => statuses.push(message),
    setTimeoutImpl: (callback, delay) => {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
  });
  return { cleared, document, shell, statuses, timers, values };
}

function createNotificationHarness(options = {}) {
  const desktop = element("work-bell-button", "button");
  const desktopCount = new FakeElement("span");
  desktopCount.className = "work-bell-count";
  desktop.append(desktopCount);
  const mobile = element("mobile-work-bell-button", "button");
  const mobileCount = new FakeElement("span");
  mobileCount.className = "work-bell-count";
  mobile.append(mobileCount);
  const panel = element("work-bell-panel");
  panel.hidden = true;
  const body = element("work-bell-body");
  const close = element("work-bell-close", "button");
  const documentBody = element("body", "body");
  const document = new TestDocument(
    documentBody,
    desktop,
    mobile,
    panel,
    body,
    close,
  );
  attachDocument(document, ...document.roots);
  const requests = [];
  const navigations = [];
  const openedTasks = [];
  const shell = createNotificationsShell({
    closeSettingsMenu() {},
    documentRef: document,
    encodeURIComponentImpl: encodeURIComponent,
    formatHomeShortDate: (date) => `short:${date}`,
    formatTaskDateMeta: (date) =>
      ({ "2026-08-12": "Yesterday", "2026-08-13": "Today", "2026-08-14": "Tomorrow" })[date] || "Later",
    HTMLElementClass: FakeElement,
    isWorkspaceRouteFresh: options.isWorkspaceRouteFresh || (() => true),
    isoDayDistance: (date) =>
      Math.round(
        (new Date(`${date}T00:00:00Z`) - new Date("2026-08-13T00:00:00Z")) /
          86400000,
      ),
    navigateCanonicalWorkspace: (path) => {
      navigations.push(path);
      return { ready: Promise.resolve() };
    },
    openTaskPanel: (id) => openedTasks.push(id),
    parseWorkspaceHash: options.parseWorkspaceHash || (() => ({ path: "/" })),
    request: async (url, requestOptions = {}) => {
      const entry = { url: String(url), options: requestOptions };
      requests.push(entry);
      return options.request ? options.request(url, requestOptions, entry) : [];
    },
    todayIsoDate: () => "2026-08-13",
    workApiUrl: (path) => new URL(path, "http://portal.test"),
  });
  return {
    body,
    close,
    desktop,
    desktopCount,
    document,
    mobile,
    mobileCount,
    navigations,
    openedTasks,
    panel,
    requests,
    shell,
  };
}

function createBindingDom() {
  const names = [
    "lintOpenButton",
    "lintBackdrop",
    "lintModalClose",
    "gitPullButton",
    "helpBackdrop",
    "helpClose",
    "helpButton",
    "docPinButton",
    "taskPanelClose",
    "taskModalBackdrop",
    "cardPanelClose",
    "cardModalBackdrop",
    "mobileMenuButton",
    "sidebarCloseButton",
    "sidebarScrim",
    "sidebarCollapseButton",
    "sidebarExpandButton",
    "themeToggleButton",
    "changesToggle",
    "changesSaveAll",
    "changesDiscardAll",
    "gitCommitButton",
    "gitCommitCancel",
    "gitCommitBackdrop",
    "cancelCommitButton",
    "gitCommitForm",
    "tasksNavButton",
    "newDocumentButton",
    "mobileNewButton",
    "backButton",
    "clearSelectionButton",
    "saveButton",
    "discardButton",
    "viewToggleButton",
    "docMenuButton",
    "documentTitle",
    "editor",
    "searchForm",
    "searchInput",
    "filterToggle",
    "filtersSection",
    "domainFilter",
    "typeFilter",
    "systemFilter",
    "tagFilter",
    "newDocForm",
    "cancelCreateButton",
    "diffBackdrop",
    "diffClose",
    "lightbox",
    "quickNavBackdrop",
    "quickNavInput",
  ];
  const dom = Object.fromEntries(names.map((name) => [name, element(name, "button")]));
  dom.body = element("body", "body");
  dom.changesSection = element("changes-section");
  dom.filterRow = element("filter-row");
  dom.helpModal = element("help-modal");
  dom.diffModal = element("diff-modal");
  dom.lightbox = element("lightbox");
  dom.quickNavInput = element("quick-nav-input", "input");
  dom.searchInput = element("search-input", "input");
  dom.editor = element("editor", "textarea");
  dom.documentTitle = element("document-title", "input");
  dom.workspaceNavButtons = [element("home-nav", "button")];
  dom.workspaceNavButtons[0].dataset.workspaceTarget = "home";
  dom.tasksNavSectionButtons = [element("cards-nav", "button")];
  dom.tasksNavSectionButtons[0].dataset.tasksSection = "cards";
  dom.tasksNavButton.setAttribute("aria-expanded", "false");
  dom.helpModal.hidden = true;
  dom.diffModal.hidden = true;
  dom.lightbox.hidden = true;
  dom.filtersSection.open = false;
  dom.filterRow.hidden = true;
  return dom;
}

describe("runtime and shell production behavior", () => {
  test("resolves and executes authenticated JSON API requests with stable failures", async () => {
    const metaDocument = {
      querySelector: () => ({ content: " https://api.example.test/base " }),
    };
    assert.equal(
      resolveApiBase({
        documentRef: metaDocument,
        windowRef: { location: { origin: "https://ignored.test" } },
      }),
      "https://api.example.test/base",
    );
    assert.equal(
      resolveApiBase({
        documentRef: { querySelector: () => null },
        windowRef: { location: { origin: "https://portal.test" } },
      }),
      "https://portal.test",
    );

    const calls = [];
    const store = storage({ dataops_token: "secret-token" });
    const client = createApiClient({
      apiBase: "https://portal.test",
      fetchImpl: async (url, options) => {
        calls.push({ url: String(url), options });
        return jsonResponse({ ok: true });
      },
      storage: store,
    });
    assert.equal(String(client.apiUrl("/work/api/tasks")), "https://portal.test/work/api/tasks");
    assert.deepEqual(await client.request(client.apiUrl("/work/api/tasks")), { ok: true });
    assert.equal(calls[0].options.headers.Authorization, "Bearer secret-token");
    assert.equal(calls[0].options.headers["content-type"], "application/json");

    const explicit = createApiClient({
      apiBase: "https://portal.test",
      fetchImpl: async (_url, options) => {
        assert.equal(options.headers.Authorization, "Bearer explicit");
        return jsonResponse(null, { raw: "" });
      },
      storage: store,
    });
    assert.deepEqual(
      await explicit.request(new URL("/work/api", "https://portal.test"), {
        headers: { Authorization: "Bearer explicit" },
      }),
      {},
    );

    for (const [response, message, status] of [
      [jsonResponse(null, { raw: "html" }), "Unexpected non-JSON API response", 200],
      [jsonResponse(null, { ok: false, raw: "bad", status: 502, statusText: "Bad Gateway" }), "HTTP 502 Bad Gateway", 502],
      [jsonResponse({ error: "Denied", code: "role_denied" }, { ok: false, status: 403 }), "Denied", 403],
    ]) {
      const failing = createApiClient({
        apiBase: "https://portal.test",
        fetchImpl: async () => response,
        storage: storage(),
      });
      await assert.rejects(
        failing.request(new URL("/work/api", "https://portal.test")),
        (error) => error.message === message && error.status === status,
      );
    }
  });

  test("keeps all workspace surface adapters synchronized without duplicating state", () => {
    const harness = createWorkspaceHarness();
    const { state, snapshots } = harness;
    assert.equal(state.workSnapshot, snapshots.work);
    assert.equal(state.homeSurfaceState.workSnapshot, snapshots.work);
    assert.equal(state.tasksSurfaceState.recurringSnapshot, snapshots.recurring);
    assert.equal(state.operationsSurfaceState.artifactSnapshot, snapshots.artifact);
    assert.equal(state.overviewState.qualitySnapshot, snapshots.quality);
    assert.deepEqual(state.knowledgeState.allDocuments, []);
    assert.equal(state.documentState.hasDraft, false);

    const work = { loaded: true, tasks: [{ id: "task-1" }] };
    const quality = { loaded: true, findings: [{ id: "finding-1" }] };
    const assistant = { loaded: true, jobs: [{ id: "job-1" }] };
    const artifact = { loaded: true, items: [{ id: "artifact-1" }] };
    state.homeSurfaceState.workSnapshot = work;
    state.qualitySnapshot = quality;
    state.operationsSurfaceState.assistantSnapshot = assistant;
    state.artifactSnapshot = artifact;
    assert.equal(state.workDetailState.workSnapshot, work);
    assert.equal(state.tasksSurfaceState.qualitySnapshot, quality);
    assert.equal(state.overviewState.assistantSnapshot, assistant);
    assert.equal(state.operationsSurfaceState.artifactSnapshot, artifact);

    const intake = { loaded: true, selectedId: "intake-1" };
    const mutation = { itemId: "intake-1", busy: true };
    const queue = { filter: "all", selectedJobId: "job-1" };
    state.operationsSurfaceState.intake = intake;
    state.intakeMutation = mutation;
    state.assistantQueue = queue;
    assert.equal(state.intake, intake);
    assert.equal(state.operationsSurfaceState.intakeMutation, mutation);
    assert.equal(state.operationsSurfaceState.assistantQueue, queue);

    const filters = { severity: "error" };
    state.qualityFiltersState.value = filters;
    state.activeTasksSection = "cards";
    state.activeWorkspaceView = "tasks";
    assert.equal(state.qualityFilters, filters);
    assert.equal(state.activeTasksSection, "cards");
    assert.equal(state.activeWorkspaceView, "tasks");

    const entity = { status: "ready", id: "task-1" };
    state.workDetailState.workspaceEntity = entity;
    assert.equal(harness.entity, entity);
    assert.equal(state.operationsSurfaceState.workspaceEntity, entity);

    const nextAccount = { signedIn: { id: "alexey" }, scope: { id: "valeriia" } };
    harness.account = nextAccount;
    assert.equal(state.homeSurfaceState.accountIdentity, nextAccount);
  });

  test("initializes shell preferences before routing and exposes a controlled work refresh", async () => {
    const calls = [];
    let resolveDocuments;
    const documentsReady = new Promise((resolve) => {
      resolveDocuments = resolve;
    });
    const windowRef = {};
    const result = initializeAppShell({
      attachSidebarResize: () => calls.push("resize"),
      enhanceSelect: (select) => calls.push(`enhance:${select}`),
      filterSelects: ["domain", "type"],
      loadDocuments: () => {
        calls.push("load-documents");
        return documentsReady;
      },
      navigationShell: {
        initializeRouting: (ready) => {
          assert.equal(ready, documentsReady);
          calls.push("routing");
        },
      },
      refreshChangesPanel: () => calls.push("changes"),
      refreshGitStatus: () => calls.push("git"),
      refreshOperationsWorkSnapshot: async (options) => {
        calls.push(`work:${options.rerender}`);
        return "refreshed";
      },
      restoreDarkMode: () => calls.push("theme"),
      restoreSidebarCollapsed: () => calls.push("collapsed"),
      restoreSidebarWidth: () => calls.push("width"),
      showLibrary: (options) => calls.push(`library:${options.updateUrl}`),
      syncSidebarShellState: () => calls.push("sidebar-state"),
      updateSaveState: () => calls.push("save-state"),
      windowRef,
    });
    assert.equal(result.documentsReady, documentsReady);
    assert.deepEqual(calls.slice(0, 8), [
      "enhance:domain",
      "enhance:type",
      "theme",
      "collapsed",
      "width",
      "resize",
      "sidebar-state",
      "library:false",
    ]);
    assert.ok(calls.indexOf("load-documents") < calls.indexOf("routing"));
    assert.equal(await windowRef.__dataopsRefreshWork(), "refreshed");
    assert.equal(calls.at(-1), "work:true");
    resolveDocuments();
  });

  test("persists theme, collapse, and bounded sidebar width", async () => {
    const harness = createPreferenceHarness({
      sidebarWidth: 320,
      storage: {
        "dtc-sidebar-collapsed": "1",
        "dtc-sidebar-width": "420",
        "dtc-theme": "dark",
      },
    });
    const { shell } = harness;
    shell.restoreDarkMode();
    assert.equal(harness.body.classList.contains("dark"), true);
    assert.equal(harness.themeLabel.textContent, "Light mode");
    assert.equal(harness.themeToggleButton.getAttribute("aria-pressed"), "true");
    shell.setDarkMode(false);
    assert.equal(harness.store.values.get("dtc-theme"), "light");

    shell.restoreSidebarCollapsed();
    assert.equal(harness.body.classList.contains("sidebar-collapsed"), true);
    assert.equal(harness.sidebarExpandButton.hidden, false);
    shell.setSidebarCollapsed(false);
    assert.equal(harness.store.values.get("dtc-sidebar-collapsed"), "0");

    shell.restoreSidebarWidth();
    assert.equal(
      harness.document.documentElement.style.getPropertyValue("--sidebar-width"),
      "420px",
    );
    harness.store.setItem("dtc-sidebar-width", "900");
    shell.restoreSidebarWidth();
    assert.equal(
      harness.document.documentElement.style.getPropertyValue("--sidebar-width"),
      "420px",
    );

    shell.attachSidebarResize();
    await harness.sidebarResize.dispatch("pointerdown", {
      clientX: 100,
      pointerId: 1,
    });
    await harness.sidebarResize.dispatch("pointermove", {
      clientX: 450,
      pointerId: 1,
    });
    assert.equal(
      harness.document.documentElement.style.getPropertyValue("--sidebar-width"),
      "560px",
    );
    harness.setSidebarWidth(560);
    await harness.sidebarResize.dispatch("pointerup", { pointerId: 1 });
    assert.equal(harness.store.values.get("dtc-sidebar-width"), "560");
  });

  test("opens the mobile sidebar as a modal, traps focus, and restores its opener", async () => {
    const harness = createPreferenceHarness({ mobile: true });
    harness.document.activeElement = harness.mobileMenuButton;
    harness.shell.openSidebar();
    assert.equal(harness.body.classList.contains("sidebar-open"), true);
    assert.equal(harness.sidebar.getAttribute("role"), "dialog");
    assert.equal(harness.sidebarScrim.hidden, false);
    assert.equal(harness.pageShell.inert, true);
    assert.equal(harness.mobileNewButton.inert, true);
    assert.equal(harness.sidebarButton.focused, true);

    const escape = await harness.document.emit("keydown", { key: "Escape" });
    assert.equal(escape.defaultPrevented, true);
    assert.equal(harness.body.classList.contains("sidebar-open"), false);
    assert.equal(harness.mobileMenuButton.focused, true);
    assert.equal(harness.sidebar.getAttribute("aria-hidden"), "true");

    harness.shell.openSidebar();
    harness.document.activeElement = harness.sidebarButton;
    const tab = await harness.document.emit("keydown", { key: "Tab" });
    assert.equal(tab.defaultPrevented, true);
    assert.equal(harness.sidebarButton.focused, true);

    harness.media.matches = false;
    harness.shell.syncSidebarShellState();
    assert.equal(harness.sidebar.getAttribute("role"), null);
    assert.equal(harness.pageShell.inert, false);
  });

  test("renders confirm, entity recovery, undo, and error feedback with focus safety", async () => {
    const harness = createFeedbackHarness();
    const opener = element("opener", "button");
    opener.ownerDocument = harness.document;
    harness.document.activeElement = opener;
    const confirmation = harness.shell.confirmDialog("Delete this item?", {
      danger: true,
      okText: "Delete",
    });
    assert.equal(harness.values["confirm-modal"].hidden, false);
    assert.equal(harness.values["confirm-message"].textContent, "Delete this item?");
    assert.equal(harness.values["confirm-ok"].classList.contains("is-danger"), true);
    await harness.values["confirm-ok"].click();
    assert.equal(await confirmation, true);
    assert.equal(opener.focused, true);

    const cancelled = harness.shell.confirmDialog("Leave?");
    await harness.document.emit("keydown", { key: "Escape" });
    assert.equal(await cancelled, false);

    const container = element("entity-state");
    let retried = 0;
    let returned = 0;
    const state = harness.shell.renderEntityLoadState(container, {
      error: "Request failed",
      id: "task-404",
      kind: "task",
      retry: () => {
        retried += 1;
      },
      returnToList: () => {
        returned += 1;
      },
      status: "not-found",
    });
    assert.equal(state.getAttribute("role"), "status");
    assert.equal(findByText(state, "Task not found", "h3").textContent, "Task not found");
    const stateButtons = state.querySelectorAll("button");
    await stateButtons[0].click();
    await stateButtons[1].click();
    assert.equal(retried, 1);
    assert.equal(returned, 1);
    assert.equal(state.focused, true);
    harness.shell.renderEntityLoadingState(container, "card", "card-1");
    assert.equal(container.textContent, "Loading card card-1…");

    let restored = 0;
    harness.shell.showUndoToast("Task completed", () => {
      restored += 1;
    });
    assert.equal(harness.values["undo-toast"].hidden, false);
    assert.equal(harness.timers.at(-1).delay, 8000);
    await harness.values["undo-toast-button"].click();
    assert.equal(restored, 1);
    assert.equal(harness.values["undo-toast"].hidden, true);

    harness.shell.reportError("Could not save");
    assert.deepEqual(harness.statuses, ["Could not save"]);
    assert.equal(harness.values["error-toast-text"].textContent, "Could not save");
    assert.equal(harness.timers.at(-1).delay, 10000);
    harness.timers.at(-1).callback();
    assert.equal(harness.values["error-toast"].hidden, true);
  });

  test("loads notifications, preserves stale state, and supports open and dismiss actions", async () => {
    let payload = {
      notifications: [
        {
          dueAt: "2026-08-12",
          id: "notification-1",
          message: "Task overdue",
          taskId: "task-1",
          type: "task-overdue",
        },
        {
          createdAt: "2026-08-13T10:00:00Z",
          id: "notification-2",
          message: "Recurring task generated: Weekly review for 2026-08-13",
          type: "recurring-due",
        },
      ],
    };
    const harness = createNotificationHarness({
      request: async (_url, options) => {
        if (options.method === "PUT") return {};
        return payload;
      },
    });
    await harness.shell.refreshWorkBell();
    assert.equal(harness.desktopCount.textContent, "2");
    assert.equal(harness.mobileCount.classList.contains("is-visible"), true);

    harness.document.activeElement = harness.desktop;
    harness.shell.openWorkBellPanel();
    assert.equal(harness.panel.hidden, false);
    assert.equal(harness.body.children.length, 2);
    assert.match(harness.body.children[0].className, /is-overdue/);
    assert.equal(harness.body.children[0].textContent.includes("Due yesterday"), true);
    assert.equal(
      harness.body.children[1].textContent.includes("Weekly review"),
      true,
    );
    assert.equal(
      harness.body.children[1].textContent.includes("for 2026-08-13"),
      false,
    );

    const openTask = findByText(harness.body.children[0], "Open task", "button");
    await openTask.click();
    assert.deepEqual(harness.openedTasks, ["task-1"]);
    assert.equal(harness.panel.hidden, true);

    harness.shell.openWorkBellPanel();
    const dismiss = harness.body
      .querySelectorAll("[data-dismiss-notification]")
      .find((button) => button.dataset.dismissNotification === "notification-1");
    await dismiss.click();
    await nextTicks();
    assert.equal(harness.desktopCount.textContent, "1");
    assert.match(harness.requests.at(-1).url, /notification-1\/dismiss$/);
    assert.equal(harness.requests.at(-1).options.method, "PUT");

    payload = [];
    await harness.shell.refreshWorkBell({ token: "stale" });
    assert.equal(harness.desktopCount.textContent, "0");
    harness.shell.openWorkBellPanel();
    assert.equal(harness.body.textContent.includes("all caught up"), false);
    assert.match(harness.body.children[0].innerHTML, /all caught up/);
  });

  test("keeps notification failures retryable and does not overwrite a newer route", async () => {
    let fresh = false;
    const stale = createNotificationHarness({
      isWorkspaceRouteFresh: () => fresh,
      request: async () => ({ notifications: [{ id: "ignored" }] }),
    });
    await stale.shell.refreshWorkBell({ token: "old" });
    assert.equal(stale.desktopCount.textContent, "");

    let failDismiss = true;
    const harness = createNotificationHarness({
      request: async (_url, options) => {
        if (options.method === "PUT" && failDismiss) {
          throw new Error("Dismiss unavailable");
        }
        if (options.method === "PUT") return {};
        return [{ id: "notification-1", message: "Review task" }];
      },
    });
    await harness.shell.refreshWorkBell();
    harness.shell.openWorkBellPanel();
    let dismiss = harness.body.querySelector("[data-dismiss-notification]");
    await dismiss.click();
    await nextTicks();
    assert.equal(harness.body.textContent.includes("Dismiss unavailable"), true);
    dismiss = harness.body.querySelector("[data-dismiss-notification]");
    failDismiss = false;
    await dismiss.click();
    await nextTicks();
    assert.equal(harness.desktopCount.textContent, "0");

    const unavailable = createNotificationHarness({
      request: async () => {
        throw new Error("Notifications offline");
      },
    });
    await unavailable.shell.refreshWorkBell();
    assert.equal(unavailable.desktopCount.textContent, "!");
    assert.equal(unavailable.desktopCount.classList.contains("is-error"), true);
    unavailable.shell.openWorkBellPanel();
    assert.match(unavailable.body.textContent, /Notifications offline/);
  });

  test("binds application events to canonical navigation, editor, and keyboard actions", async () => {
    globalThis.CustomEvent = class CustomEvent {
      constructor(type, options = {}) {
        this.type = type;
        this.detail = options.detail;
      }
    };
    const dom = createBindingDom();
    const roots = Object.values(dom).flat().filter((value) => value instanceof FakeElement);
    const document = new TestDocument(dom.body, ...roots);
    attachDocument(document, ...document.roots);
    const windowRef = new TestEventTarget();
    const calls = [];
    const callbacks = new Proxy(
      {
        debounce: (callback) => callback,
        handleWorkspaceEntityModalKeydown: (event) =>
          calls.push(["entity-key", event.key]),
        isSettingsMenuOpen: () => false,
        navigateCanonicalWorkspace: (path) => calls.push(["navigate", path]),
        setDarkMode: (value) => calls.push(["dark", value]),
        setTasksNavExpanded: (value) => calls.push(["tasks-expanded", value]),
        showWorkspaceSurface: (view) => calls.push(["workspace", view]),
        workspaceHashPath: (_view, section) => `/tasks/${section}`,
      },
      {
        get(target, property) {
          if (property in target) return target[property];
          return (...args) => calls.push([String(property), ...args]);
        },
      },
    );
    const workspaceState = {
      activeTasksSection: "queue",
      documentState: { currentDoc: { path: "process/example.md" } },
    };
    bindApplicationEvents({
      callbacks,
      documentRef: document,
      dom,
      navigationShell: {
        scheduleCurrentBrowserLocation: () => calls.push(["schedule-route"]),
      },
      notificationsShell: { isOpen: () => false },
      surfaceBridge: {
        getKnowledgeSurface: () => ({
          handleQuickNavKeydown: (event) => calls.push(["quick-key", event.key]),
        }),
      },
      windowRef,
      workspaceState,
    });

    await dom.themeToggleButton.click();
    assert.deepEqual(calls.at(-1), ["dark", true]);
    await dom.tasksNavButton.click();
    assert.deepEqual(calls.at(-1), ["tasks-expanded", true]);
    await dom.tasksNavSectionButtons[0].click();
    assert.deepEqual(calls.at(-1), ["navigate", "/tasks/cards"]);
    await dom.editor.dispatch("input");
    assert.equal(calls.some(([name]) => name === "storeDraft"), true);
    assert.equal(calls.some(([name]) => name === "updateSaveState"), true);

    const saveEvent = await document.emit("keydown", {
      ctrlKey: true,
      key: "s",
      metaKey: false,
      shiftKey: false,
    });
    assert.equal(saveEvent.defaultPrevented, true);
    assert.equal(calls.some(([name]) => name === "saveCurrentDocument"), true);
    const quickEvent = await document.emit("keydown", {
      ctrlKey: true,
      key: "p",
      metaKey: false,
    });
    assert.equal(quickEvent.defaultPrevented, true);
    assert.equal(calls.some(([name]) => name === "openQuickNav"), true);

    dom.quickNavInput.value = "newsletter";
    await dom.quickNavInput.dispatch("input");
    assert.equal(
      calls.some(
        ([name, value]) => name === "updateQuickNavMatches" && value === "newsletter",
      ),
      true,
    );
    await dom.quickNavInput.dispatch("keydown", { key: "ArrowDown" });
    assert.equal(calls.some(([name]) => name === "quick-key"), true);
    await windowRef.emit("popstate");
    assert.equal(calls.some(([name]) => name === "schedule-route"), true);
  });

  test("queries the canonical DOM registry and route button collections", () => {
    const body = element("body", "body");
    const sidebar = element("sidebar");
    const pageShell = element("page", "main");
    pageShell.className = "page-shell";
    const workspace = element("home", "button");
    workspace.dataset.workspaceView = "home";
    const submenu = element("tasks-nav-submenu");
    const cards = element("cards", "button");
    cards.dataset.tasksSection = "cards";
    submenu.append(cards);
    const document = new TestDocument(body, sidebar, pageShell, workspace, submenu);
    document.body = body;
    const dom = queryAppDom(document);
    assert.equal(dom.body, body);
    assert.equal(dom.sidebar, sidebar);
    assert.equal(dom.pageShell, pageShell);
    assert.deepEqual(dom.workspaceNavButtons, [workspace]);
    assert.deepEqual(dom.tasksNavSectionButtons, [cards]);
  });
});
