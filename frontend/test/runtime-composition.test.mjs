import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createOperationKernel } from "../src/runtime/operation-kernel.js";
import {
  createSurfaceBridge,
  createSurfaceComposition,
} from "../src/runtime/surface-composition.js";
import { FakeDocument, FakeElement } from "./support/fake-dom.mjs";

function element(tagName = "div") {
  return new FakeElement(tagName);
}

function createSurfaceHarness(options = {}) {
  const calls = [];
  const body = element("body");
  body.dataset.view = options.bodyView || "library";
  const breadcrumb = element();
  const mobileTitle = element();
  const searchInput = element("input");
  searchInput.value = options.searchValue || "";
  const statusText = element();
  const tasksNavButton = element("button");
  const tasksNavSubmenu = element();
  const toolbarTitle = element();
  const workspaceNavButtons = ["home", "inbox", "docs"].map((view) => {
    const button = element("button");
    button.dataset.workspaceView = view;
    return button;
  });
  const tasksNavSectionButtons = ["queue", "cards", "templates"].map(
    (section) => {
      const button = element("button");
      button.dataset.tasksSection = section;
      return button;
    },
  );
  const workspaceState = {
    activeTasksSection: options.tasksSection || "cards",
    activeWorkspaceView: options.view || "home",
    recurringSnapshot: { loaded: false, recurringConfigs: [], errors: [] },
    workSnapshot: options.workSnapshot || {
      cardTasks: {
        alpha: [{ id: "task-card", status: "open" }],
      },
      overdueTasks: [{ id: "task-overdue", status: "open" }],
      todayTasks: [
        { id: "task-overdue", status: "open" },
        { id: "task-today", status: "open" },
      ],
      waitingTasks: [{ id: "task-waiting", status: "waiting" }],
    },
  };
  let financeLeave = options.financeLeave ?? true;
  let editorLeave = options.editorLeave ?? true;
  const scheduled = [];
  const cleared = [];
  const navigation = [];
  const renders = Object.fromEntries(
    [
      "admin",
      "bookkeeping",
      "calendar",
      "docs",
      "home",
      "inbox",
      "mailing-exports",
      "newsletter",
      "sponsors",
      "tasks",
      "users",
    ].map((name) => [name, (...args) => calls.push([`render:${name}`, ...args])]),
  );
  const context = {
    apiUrl: (path) => new URL(path, "https://portal.test"),
    body,
    breadcrumb,
    clearTimeoutImpl: (token) => cleared.push(token),
    dedupeWorkTasks: (tasks) => [
      ...new Map(tasks.map((task) => [task.id, task])).values(),
    ],
    emptyOperationsRecurringSnapshot: () => ({
      loaded: false,
      recurringConfigs: [],
      errors: [],
    }),
    getCanLeaveDocumentEditor: () => async () => editorLeave,
    getCanLeaveFinanceSurface: () => async (reason) => {
      calls.push(["leave:finance", reason]);
      return financeLeave;
    },
    getKnowledgeSelectedFolder: () => options.selectedFolder || "",
    getNormalizeOperationsRecurringSnapshot: () => (snapshot) => ({
      ...snapshot,
      normalized: true,
    }),
    getRenderAdminSurfaceView: () => renders.admin,
    getRenderBookkeepingSurface: () => renders.bookkeeping,
    getRenderCalendarSurface: () => renders.calendar,
    getRenderDocsSurface: () => renders.docs,
    getRenderInboxSurface: () => renders.inbox,
    getRenderMailingExportsSurface: () => renders["mailing-exports"],
    getRenderNewsletterSurface: () => renders.newsletter,
    getRenderOperationsHome: () => renders.home,
    getRenderSponsorCrmSurface: () => renders.sponsors,
    getRenderTasksSurface: () => renders.tasks,
    getRenderUsersSurfaceView: () => renders.users,
    getResizeDocumentTitle: () => () => calls.push(["resize-title"]),
    getSearchValue: () => searchInput.value,
    isOpenWorkTask: (task) => task.status !== "done",
    mobileTitle,
    navigateCanonicalWorkspace: (path, params, navigationOptions) => {
      navigation.push({ path, params, options: navigationOptions });
      return { ready: Promise.resolve(`ready:${path}`) };
    },
    recurringConfigsFromPayload: (payload) => payload.items,
    refreshDocuments: () => calls.push(["refresh-documents"]),
    request: async (url) => {
      calls.push(["request", String(url)]);
      if (options.requestError) throw new Error("recurring unavailable");
      return { items: [{ id: "weekly" }] };
    },
    searchInput,
    setTimeoutImpl: (callback, delay) => {
      const timer = { callback, delay };
      scheduled.push(timer);
      return timer;
    },
    statusText,
    tasksFromWorkPayload: (payload) => payload,
    tasksNavButton,
    tasksNavSectionButtons,
    tasksNavSubmenu,
    toolbarTitle,
    windowConsole: {
      warn: (message) => calls.push(["warn", message]),
    },
    workspaceHashPath: (view, section) =>
      section ? `/${view}/${section}` : `/${view}`,
    workspaceNavButtons,
    workspaceState,
  };
  const composition = createSurfaceComposition(context);
  return {
    body,
    breadcrumb,
    calls,
    cleared,
    composition,
    mobileTitle,
    navigation,
    scheduled,
    searchInput,
    setEditorLeave(value) {
      editorLeave = value;
    },
    setFinanceLeave(value) {
      financeLeave = value;
    },
    statusText,
    tasksNavButton,
    tasksNavSectionButtons,
    tasksNavSubmenu,
    toolbarTitle,
    workspaceNavButtons,
    workspaceState,
  };
}

describe("runtime surface composition", () => {
  test("bridges navigation, Knowledge, and editor surfaces without hidden globals", () => {
    const bridge = createSurfaceBridge();
    assert.equal(bridge.getActiveWorkspaceRoute(), null);
    assert.equal(bridge.getActiveWorkspaceRouteToken(), 0);
    assert.equal(bridge.isWorkspaceRouteFresh(), false);

    const calls = [];
    const knowledge = new Proxy(
      {},
      {
        get: (_target, name) => (...args) => {
          calls.push([`knowledge:${String(name)}`, ...args]);
          return `knowledge:${String(name)}`;
        },
      },
    );
    const editor = new Proxy(
      {},
      {
        get: (_target, name) => (...args) => {
          calls.push([`editor:${String(name)}`, ...args]);
          return `editor:${String(name)}`;
        },
      },
    );
    const navigation = new Proxy(
      {},
      {
        get: (_target, name) => (...args) => {
          calls.push([`navigation:${String(name)}`, ...args]);
          return `navigation:${String(name)}`;
        },
      },
    );
    bridge.setKnowledgeSurface(knowledge);
    bridge.setDocumentEditorSurface(editor);
    bridge.setNavigationShell(navigation);
    assert.equal(bridge.getKnowledgeSurface(), knowledge);
    assert.equal(bridge.getDocumentEditorSurface(), editor);
    assert.equal(bridge.getNavigationShell(), navigation);
    assert.equal(bridge.openDocument("content/guide.md"), "knowledge:openDocument");
    assert.equal(bridge.saveCurrentDocument(), "editor:saveCurrentDocument");
    assert.equal(bridge.navigateCanonicalWorkspace("/tasks"), "navigation:navigateCanonicalWorkspace");
    assert.deepEqual(calls, [
      ["knowledge:openDocument", "content/guide.md"],
      ["editor:saveCurrentDocument"],
      ["navigation:navigateCanonicalWorkspace", "/tasks"],
    ]);
  });

  test("dispatches every retained workspace view to its owned renderer", () => {
    const harness = createSurfaceHarness();
    const documents = [{ path: "content/process.md" }];
    for (const [view, expected] of [
      ["home", "home"],
      ["tasks", "tasks"],
      ["inbox", "inbox"],
      ["docs", "docs"],
      ["admin", "admin"],
      ["users", "users"],
      ["bookkeeping", "bookkeeping"],
      ["sponsors", "sponsors"],
      ["newsletter", "newsletter"],
      ["calendar", "calendar"],
      ["mailing-exports", "mailing-exports"],
      ["unknown", "home"],
    ]) {
      harness.workspaceState.activeWorkspaceView = view;
      harness.composition.renderOperationsWorkspace(documents);
      assert.equal(harness.calls.at(-1)[0], `render:${expected}`);
      if (["home", "tasks", "docs", "admin"].includes(view)) {
        assert.equal(harness.calls.at(-1)[1], documents);
      }
    }
  });

  test("builds API URLs and deduplicates open work from every source", () => {
    const harness = createSurfaceHarness();
    const url = harness.composition.workApiUrl("/api/tasks", {
      date: "2026-08-13",
      empty: "",
      page: 2,
      absent: null,
    });
    assert.equal(
      String(url),
      "https://portal.test/work/api/tasks?date=2026-08-13&page=2",
    );
    assert.deepEqual(
      harness.composition.allWorkTasks().map((task) => task.id),
      ["task-overdue", "task-today", "task-waiting", "task-card"],
    );
  });

  test("refreshes recurring configuration with honest success and failure", async () => {
    const success = createSurfaceHarness();
    await success.composition.refreshOperationsRecurringSnapshot({
      rerender: true,
    });
    assert.deepEqual(success.workspaceState.recurringSnapshot, {
      loaded: true,
      recurringConfigs: [{ id: "weekly" }],
      errors: [],
      normalized: true,
    });
    assert.deepEqual(success.calls, [
      ["request", "https://portal.test/work/api/recurring"],
      ["refresh-documents"],
    ]);

    const failure = createSurfaceHarness({ requestError: true });
    await failure.composition.refreshOperationsRecurringSnapshot({
      rerender: true,
    });
    assert.equal(failure.workspaceState.recurringSnapshot.loaded, false);
    assert.deepEqual(failure.workspaceState.recurringSnapshot.errors, [
      "recurring unavailable",
    ]);
  });

  test("short-circuits retained dirty-surface leave guards in stable order", async () => {
    const harness = createSurfaceHarness({ financeLeave: false });
    assert.equal(await harness.composition.canLeaveCurrentDocument(), false);
    assert.deepEqual(harness.calls, [["leave:finance", "navigation"]]);

    harness.calls.length = 0;
    harness.setFinanceLeave(true);
    harness.setEditorLeave(true);
    assert.equal(await harness.composition.canLeaveCurrentDocument(), true);
  });

  test("maps legacy Task sections and canonical history options", async () => {
    const harness = createSurfaceHarness();
    assert.equal(harness.composition.legacyViewToTasksSection("queue"), "queue");
    assert.equal(
      harness.composition.legacyViewToTasksSection("workflows"),
      "workflows",
    );
    assert.equal(harness.composition.legacyViewToTasksSection("other"), null);
    assert.equal(await harness.composition.showOperationsHome(), "ready:/");
    assert.equal(
      await harness.composition.showWorkspaceSurface("templates", {
        params: { templateId: "template-1" },
        replace: true,
      }),
      "ready:/tasks/templates",
    );
    assert.equal(
      await harness.composition.showWorkspaceSurface("processes", {
        updateUrl: false,
      }),
      "ready:/docs",
    );
    assert.deepEqual(harness.navigation, [
      { path: "/", params: {}, options: { history: "push" } },
      {
        path: "/tasks/templates",
        params: { templateId: "template-1" },
        options: { history: "replace" },
      },
      { path: "/docs", params: {}, options: { history: "none" } },
    ]);
  });

  test("synchronizes top-level and nested navigation state", () => {
    const harness = createSurfaceHarness({ view: "tasks", tasksSection: "cards" });
    harness.composition.syncWorkspaceNav();
    assert.equal(harness.body.dataset.workspaceView, "tasks");
    assert.equal(harness.searchInput.placeholder, "Search work and docs");
    assert.equal(harness.tasksNavButton.classList.contains("is-active"), true);
    assert.equal(harness.tasksNavButton.getAttribute("aria-current"), "page");
    assert.equal(harness.tasksNavButton.getAttribute("aria-expanded"), "true");
    assert.equal(harness.tasksNavSubmenu.hidden, false);
    assert.equal(
      harness.tasksNavSectionButtons[1].getAttribute("aria-current"),
      "page",
    );

    harness.workspaceState.activeWorkspaceView = "home";
    harness.composition.syncWorkspaceNav();
    assert.equal(harness.searchInput.placeholder, "Search");
    assert.equal(harness.workspaceNavButtons[0].getAttribute("aria-current"), "page");
    assert.equal(harness.tasksNavButton.getAttribute("aria-current"), null);
    harness.composition.setTasksNavExpanded(false);
    assert.equal(harness.tasksNavSubmenu.hidden, true);
  });

  test("updates shell copy and keeps shared path and HTML helpers deterministic", () => {
    const harness = createSurfaceHarness();
    harness.composition.setView("editor");
    harness.composition.setPageTitle("Process", "Docs / Process");
    harness.composition.setStatus("Saved");
    assert.equal(harness.body.dataset.view, "editor");
    assert.equal(harness.toolbarTitle.textContent, "Process");
    assert.equal(harness.mobileTitle.textContent, "Process");
    assert.equal(harness.breadcrumb.textContent, "Docs / Process");
    assert.equal(harness.statusText.textContent, "Saved");
    assert.equal(harness.composition.cleanPath("content/ops/start.md"), "ops/start.md");
    assert.equal(harness.composition.basename("content/ops/start-here.md"), "start here");
    assert.equal(harness.composition.cleanPath("external/path.md"), "external/path.md");
    assert.equal(harness.composition.cleanPath("external/path.md"), "external/path.md");
    assert.deepEqual(
      harness.calls.filter(([name]) => name === "warn"),
      [["warn", "Document path outside content/: external/path.md"]],
    );
    assert.equal(
      harness.composition.escapeHtml('<Task owner="Alexey">'),
      "&lt;Task owner=\"Alexey\"&gt;",
    );
  });

  test("debounces callbacks by replacing the prior timer", () => {
    const harness = createSurfaceHarness();
    const values = [];
    const debounced = harness.composition.debounce(
      (value) => values.push(value),
      120,
    );
    debounced("first");
    debounced("second");
    assert.equal(harness.scheduled.length, 2);
    assert.equal(harness.scheduled[1].delay, 120);
    assert.equal(harness.cleared[1], harness.scheduled[0]);
    harness.scheduled[1].callback();
    assert.deepEqual(values, ["second"]);
  });

  test("composes the operation model and overview into one facade", () => {
    const document = new FakeDocument();
    const kernel = createOperationKernel({
      basename: (path) => path.split("/").at(-1),
      cleanPath: (path) => path.replace(/^content\//, ""),
      documentRef: document,
      getRecurringConfigTitle: (item) => item.title,
      openCardPanel() {},
      openDocument() {},
      openTaskPanel() {},
      resolveAssigneeLabel: (task) => task.assigneeName || "Unassigned",
      resolveDocReference: () => null,
      showWorkspaceSurface() {},
      tasksSectionTitle: (section) => `Tasks · ${section}`,
      workspaceState: {
        overviewState: {
          artifactSnapshot: { loaded: false, artifacts: [] },
          assistantSnapshot: { loaded: false, jobs: [] },
          qualitySnapshot: { loaded: false, findings: [] },
        },
      },
    });
    assert.equal(typeof kernel.normalizeOperationsWorkSnapshot, "function");
    assert.equal(typeof kernel.renderHonestState, "function");
    assert.equal(kernel.operationsViewTitle("tasks", "cards"), "Tasks · cards");
    assert.equal(kernel.countLabel(1, "Task"), "1 Task");
    assert.equal(kernel.countLabel(2, "Task"), "2 Tasks");
  });
});
