import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import {
  canonicalWorkspaceUrl,
  parseWorkspaceHash,
  workspaceRouteFor,
} from "../src/core/workspace.js";
import { emptyOperationsDocsSnapshot } from "../src/core/operations-model.js";
import { createNavigationShell } from "../src/shell/navigation.js";
import { FakeDocument, FakeElement, nextTicks } from "./support/fake-dom.mjs";

const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;

afterEach(() => {
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
});

function visibleButton(className, dataset) {
  const button = new FakeElement("button");
  button.className = className;
  Object.assign(button.dataset, dataset);
  button.offsetParent = {};
  return button;
}

function createNavigationHarness(options = {}) {
  const libraryTitle = new FakeElement("h1");
  libraryTitle.offsetParent = options.libraryTitleVisible === false ? null : {};
  const documentList = new FakeElement("main");
  const routeHeading = new FakeElement("h2");
  routeHeading.textContent = "Current route";
  routeHeading.offsetParent = {};
  documentList.append(routeHeading);
  const searchInput = new FakeElement("input");
  const runtimeTemplateSearch = visibleButton("runtime-template-search", {});
  const taskButton = visibleButton("ops-queue-row", { taskId: "task-1" });
  const nestedTask = visibleButton("card-checklist-label", {
    taskId: "task-nested",
  });
  const cardButton = visibleButton("ops-workflow-card", { cardId: "card-1" });
  const recurring = new FakeElement("section");
  recurring.className = "ops-recurring-section";
  const body = new FakeElement("body");
  const document = new FakeDocument(
    body,
    libraryTitle,
    documentList,
    searchInput,
    runtimeTemplateSearch,
    taskButton,
    nestedTask,
    cardButton,
    recurring,
  );
  document.body = body;
  document.activeElement = null;
  for (const node of document.roots) {
    node.focus = function focus() {
      this.focused = true;
      document.activeElement = this;
    };
  }

  const location = {
    hash: options.hash ?? "#/",
    pathname: options.pathname ?? "/",
    search: options.search ?? "",
  };
  const history = {
    pushed: [],
    replaced: [],
    state: null,
    pushState(state, _unused, url) {
      this.state = state;
      this.pushed.push({ state, url });
    },
    replaceState(state, _unused, url) {
      this.state = state;
      this.replaced.push({ state, url });
    },
  };
  const intake = { selectedId: null };
  const intakeSurfaceState = {
    intake,
    intakeMutation: options.intakeMutation || {
      itemId: "",
      action: "",
      values: {},
      focus: null,
      error: "",
      busy: false,
      status: "",
    },
  };
  const assistantQueue = { selectedJobId: null };
  const knowledge = {
    allDocuments: options.documents || [],
    selectedFolder: "existing-folder",
  };
  const active = { tasksSection: "queue", view: "home" };
  const calls = [];
  let allowLeave = options.allowLeave ?? true;
  const shell = createNavigationShell({
    canLeaveCurrentDocument: async () => allowLeave,
    canonicalWorkspaceUrl,
    clearDocumentFilters: () => calls.push(["clear-filters"]),
    closeSettingsMenu: () => calls.push(["close-settings"]),
    closeSidebar: () => calls.push(["close-sidebar"]),
    closeWorkBellPanel: (value) => calls.push(["close-bell", value]),
    docPathFromLocation: () => options.docPath || "",
    documentList,
    documentRef: document,
    folderExists: (path) => path === "known-folder",
    folderPathFromLocation: () => options.folderPath || "",
    getAssistantQueueState: () => assistantQueue,
    getDocsAvailability: () =>
      options.docsAvailability || emptyOperationsDocsSnapshot(),
    getIntakeSurfaceState: () => intakeSurfaceState,
    getKnowledgeState: () => knowledge,
    getTasksSectionForLegacyView: (view) =>
      ({
        artifacts: "artifacts",
        assistants: "assistants",
        cards: "workflows",
        templates: "templates",
        workflows: "workflows",
      })[view],
    historyRef: history,
    HTMLElementClass: FakeElement,
    hydrateCardPanel: async (id, token) => calls.push(["hydrate-card", id, token]),
    hydrateTaskPanel: async (id, token, value) =>
      calls.push(["hydrate-task", id, token, value]),
    libraryTitle,
    locationRef: location,
    openDocument: async (...args) => calls.push(["open-doc", ...args]),
    openWorkBellPanel: () => calls.push(["open-bell"]),
    operationsViewTitle: (view, section) => `${view}:${section}`,
    parseWorkspaceHash: (hash) => parseWorkspaceHash(hash, location),
    prepareCardPanel: (id) => calls.push(["prepare-card", id]),
    prepareTaskPanel: (id) => calls.push(["prepare-task", id]),
    refreshDocuments: () => {
      calls.push(["refresh-docs"]);
      documentList.append(routeHeading);
    },
    refreshOperationsArtifactSnapshot: async (value) => calls.push(["artifacts", value]),
    refreshOperationsAssistantSnapshot: async (value) => calls.push(["assistants", value]),
    refreshUsersSurface: async (value) => calls.push(["users", value]),
    refreshWorkBell: async (value) => calls.push(["refresh-bell", value]),
    renderWorkspaceNav: () => ({
      activeTasksSection: active.tasksSection,
      activeWorkspaceView: active.view,
    }),
    requestAnimationFrameImpl: (callback) => callback(),
    resetCardPanel: () => calls.push(["reset-card"]),
    resetTaskPanel: () => calls.push(["reset-task"]),
    resolveIntakeRouteEntity: async (...args) => calls.push(["resolve-intake", ...args]),
    resolveTaskQueueRouteContext: async (...args) => calls.push(["resolve-queue", ...args]),
    resolveTemplateRouteEntity: async (...args) => calls.push(["resolve-template", ...args]),
    searchInput,
    setActiveTasksSection: (value) => {
      active.tasksSection = value;
      calls.push(["tasks-section", value]);
    },
    setActiveWorkspaceView: (value) => {
      active.view = value;
      calls.push(["workspace-view", value]);
    },
    setRuntimeTemplateRoute: (...args) => calls.push(["template-route", ...args]),
    setTaskRouteContextFromRoute: (route) => calls.push(["task-context", route.path]),
    setView: (view) => calls.push(["set-view", view]),
    showLibrary: (value) => calls.push(["show-library", value]),
    showOperationsHome: async (value) => calls.push(["show-home", value]),
    workspaceRouteFor: (path, params) => workspaceRouteFor(path, params, location),
  });
  return {
    active,
    assistantQueue,
    calls,
    cardButton,
    document,
    documentList,
    history,
    intake,
    intakeSurfaceState,
    knowledge,
    libraryTitle,
    location,
    nestedTask,
    recurring,
    routeHeading,
    runtimeTemplateSearch,
    searchInput,
    setAllowLeave: (value) => {
      allowLeave = value;
    },
    shell,
    taskButton,
  };
}

describe("canonical navigation shell behavior", () => {
  test("commits canonical entity routes before hydrating their panels", async () => {
    const harness = createNavigationHarness();
    const result = harness.shell.navigateCanonicalWorkspace("/cards", {
      cardId: "card-1",
      taskId: "task-nested",
    });
    assert.equal(result.route.canonicalUrl, "/#/cards?cardId=card-1&taskId=task-nested");
    assert.equal(result.token, 1);
    assert.equal(harness.history.pushed[0].url, result.route.canonicalUrl);
    assert.equal(harness.active.view, "tasks");
    assert.equal(harness.active.tasksSection, "workflows");
    assert.equal(harness.libraryTitle.textContent, "tasks:workflows");
    assert.equal(harness.knowledge.selectedFolder, "");
    assert.equal(harness.searchInput.value, "");
    assert.ok(
      harness.calls.findIndex(([name]) => name === "prepare-card") <
        harness.calls.findIndex(([name]) => name === "hydrate-card"),
    );
    await result.ready;
    assert.deepEqual(
      harness.calls.find(([name]) => name === "hydrate-task"),
      ["hydrate-task", "task-nested", 1, { expectedCardId: "card-1" }],
    );
    assert.equal(harness.shell.getPendingLegacyRoute().token, 1);
    assert.equal(harness.shell.isWorkspaceRouteFresh(1), true);
  });

  test("hydrates only the APIs owned by each canonical route", async () => {
    const cases = [
      ["/inbox", { intakeId: "intake-1" }, "resolve-intake"],
      ["/tasks", { taskId: "task-1" }, "resolve-queue"],
      ["/templates", { templateId: "template-1" }, "resolve-template"],
      ["/assistants", { assistantJobId: "job-1" }, "assistants"],
      ["/notifications", {}, "refresh-bell"],
      ["/artifacts", {}, "artifacts"],
      ["/users", {}, "users"],
    ];
    for (const [path, params, expected] of cases) {
      const harness = createNavigationHarness();
      await harness.shell.navigateCanonicalWorkspace(path, params).ready;
      assert.equal(harness.calls.some(([name]) => name === expected), true, path);
      if (path === "/inbox") assert.equal(harness.intake.selectedId, "intake-1");
      if (path === "/assistants") {
        assert.equal(harness.assistantQueue.selectedJobId, "job-1");
      }
      if (path === "/notifications") {
        assert.equal(harness.calls.some(([name]) => name === "open-bell"), true);
      }
    }

    const recurring = createNavigationHarness();
    await recurring.shell.navigateCanonicalWorkspace("/recurring").ready;
    assert.equal(recurring.recurring.focused, true);
    assert.equal(recurring.recurring.tabIndex, -1);
  });

  test("rejects invalid programmatic destinations without changing history or state", async () => {
    const harness = createNavigationHarness();
    const result = harness.shell.navigateCanonicalWorkspace("/not-a-route");
    await result.ready;
    assert.equal(result.route.invalid, true);
    assert.equal(result.token, 0);
    assert.deepEqual(harness.history.pushed, []);
    assert.equal(harness.shell.getActiveWorkspaceRoute(), null);
  });

  test("preserves the prior canonical route when a dirty surface cancels browser navigation", async () => {
    const harness = createNavigationHarness({ hash: "#/tasks" });
    await harness.shell.initializeRouting(Promise.resolve());
    harness.setAllowLeave(false);
    const incoming = workspaceRouteFor("/calendar", {}, harness.location);
    await harness.shell.applyWorkspaceRoute(incoming);
    assert.equal(harness.shell.getActiveWorkspaceRoute().path, "/tasks");
    assert.equal(harness.history.replaced.at(-1).url, "/#/tasks");
  });

  test("restores focus to visible Task, Card, nested Task, and Template list controls", async () => {
    const cases = [
      ["/tasks", { taskId: "task-1" }, { id: "task-1", kind: "task" }, "taskButton"],
      ["/cards", { cardId: "card-1" }, { id: "card-1", kind: "workflow" }, "cardButton"],
      [
        "/cards",
        { cardId: "card-1", taskId: "task-nested" },
        { id: "task-nested", kind: "task", surface: "workflows" },
        "nestedTask",
      ],
      ["/templates", {}, { kind: "runtime-template-list" }, "runtimeTemplateSearch"],
    ];
    for (const [path, params, restoreFocus, targetName] of cases) {
      const harness = createNavigationHarness();
      await harness.shell.navigateCanonicalWorkspace(path, params, { restoreFocus }).ready;
      assert.equal(harness[targetName].focused, true, targetName);
    }

    const fallback = createNavigationHarness();
    await fallback.shell.navigateCanonicalWorkspace("/tasks", {}, {
      restoreFocus: { id: "missing", kind: "task" },
    }).ready;
    assert.equal(fallback.libraryTitle.focused, true);
    assert.equal(fallback.libraryTitle.tabIndex, -1);

    const headingFallback = createNavigationHarness({
      libraryTitleVisible: false,
    });
    await headingFallback.shell.navigateCanonicalWorkspace("/tasks", {}, {
      restoreFocus: { id: "missing", kind: "task" },
    }).ready;
    assert.equal(headingFallback.libraryTitle.focused, false);
    assert.equal(headingFallback.routeHeading.focused, true);
    assert.equal(headingFallback.routeHeading.tabIndex, -1);
  });

  test("starts document navigation by invalidating route work and closing overlays", () => {
    const harness = createNavigationHarness();
    harness.shell.navigateCanonicalWorkspace("/tasks", {}, { hydrate: false });
    const priorToken = harness.shell.getActiveWorkspaceRouteToken();
    harness.shell.beginDocumentNavigation();
    assert.equal(harness.shell.getActiveWorkspaceRoute(), null);
    assert.equal(harness.shell.isWorkspaceRouteFresh(priorToken), false);
    assert.equal(harness.calls.filter(([name]) => name === "reset-task").length, 2);
    assert.equal(harness.calls.filter(([name]) => name === "reset-card").length, 2);
  });

  test("keeps an Inbox draft on same-item refresh and discards it across navigation", async () => {
    const harness = createNavigationHarness({
      intakeMutation: {
        itemId: "intake-draft",
        action: "block",
        values: { reason: "Waiting for review" },
        focus: { field: "reason" },
        error: "",
        busy: false,
        status: "",
      },
    });

    await harness.shell.navigateCanonicalWorkspace(
      "/inbox",
      { intakeId: "intake-draft" },
      { hydrate: false },
    ).ready;
    assert.equal(harness.intakeSurfaceState.intakeMutation.action, "block");

    await harness.shell.navigateCanonicalWorkspace("/tasks", {}, {
      hydrate: false,
    }).ready;
    assert.deepEqual(harness.intakeSurfaceState.intakeMutation, {
      itemId: "",
      action: "",
      values: {},
      focus: null,
      error: "",
      busy: false,
      status: "",
    });

    await harness.shell.navigateCanonicalWorkspace(
      "/inbox",
      { intakeId: "intake-draft" },
      { hydrate: false },
    ).ready;
    assert.equal(harness.intakeSurfaceState.intakeMutation.itemId, "");

    harness.intakeSurfaceState.intakeMutation = {
      itemId: "intake-draft",
      action: "block",
      values: { reason: "Second draft" },
      focus: null,
      error: "",
      busy: false,
      status: "",
    };
    harness.shell.beginDocumentNavigation();
    assert.equal(harness.intakeSurfaceState.intakeMutation.itemId, "");
  });

  test("normalizes malformed Home URLs and opens known document or folder URLs", async () => {
    const malformed = createNavigationHarness({ hash: "#/unknown" });
    await malformed.shell.initializeRouting(Promise.resolve());
    assert.equal(malformed.history.replaced.at(-1).url, "/#/ ".replace(" ", ""));
    assert.equal(malformed.shell.getActiveWorkspaceRoute().path, "/");

    const doc = createNavigationHarness({
      documents: [{ path: "process/example.md" }],
      docPath: "process/example.md",
      hash: "",
      pathname: "/process/example.md",
    });
    await doc.shell.initializeRouting(Promise.resolve());
    assert.deepEqual(doc.calls.find(([name]) => name === "open-doc"), [
      "open-doc",
      "process/example.md",
      { updateUrl: false },
    ]);

    // A healthy corpus that simply does not contain the document keeps today's
    // behavior; only a docs outage opens the document anyway.
    const unknownDoc = createNavigationHarness({
      documents: [],
      docPath: "process/example.md",
      hash: "",
      pathname: "/process/example.md",
    });
    await unknownDoc.shell.initializeRouting(Promise.resolve());
    assert.equal(
      unknownDoc.calls.some(([name]) => name === "open-doc"),
      false,
    );

    const outageDoc = createNavigationHarness({
      docsAvailability: {
        state: "unavailable",
        documentCount: 0,
        error: "Docs content root is unavailable: /missing/content",
        status: 503,
      },
      documents: [],
      docPath: "process/example.md",
      hash: "",
      pathname: "/process/example.md",
    });
    await outageDoc.shell.initializeRouting(Promise.resolve());
    assert.deepEqual(outageDoc.calls.find(([name]) => name === "open-doc"), [
      "open-doc",
      "process/example.md",
      { updateUrl: false },
    ]);

    const folder = createNavigationHarness({
      folderPath: "known-folder",
      hash: "",
      pathname: "/known-folder/",
    });
    await folder.shell.initializeRouting(Promise.resolve());
    assert.equal(folder.knowledge.selectedFolder, "known-folder");
    assert.equal(folder.calls.some(([name]) => name === "show-library"), true);
  });

  test("coalesces browser location changes after initial routing is ready", async () => {
    const timers = [];
    globalThis.setTimeout = (callback) => {
      const timer = { callback, cleared: false };
      timers.push(timer);
      return timer;
    };
    globalThis.clearTimeout = (timer) => {
      timer.cleared = true;
    };
    const harness = createNavigationHarness({ hash: "#/tasks" });
    const ready = harness.shell.initializeRouting(Promise.resolve());
    await ready;
    harness.location.hash = "#/calendar";
    harness.shell.scheduleCurrentBrowserLocation();
    harness.shell.scheduleCurrentBrowserLocation();
    assert.equal(timers.length, 2);
    assert.equal(timers[0].cleared, true);
    timers[1].callback();
    await nextTicks();
    assert.equal(harness.shell.getActiveWorkspaceRoute().path, "/calendar");
  });
});
