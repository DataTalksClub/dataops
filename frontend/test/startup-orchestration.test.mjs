import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parseWorkspaceLocation } from "../src/core/workspace.js";
import {
  SELF_LOADING_VIEWS,
  createStartupOrchestration,
  isStartupDeferredRoute,
} from "../src/shell/startup-orchestration.js";
import { createKnowledgeCatalog } from "../src/surfaces/knowledge/catalog.js";
import { initializeAppShell } from "../src/shell/bootstrap.js";
import { createNavigationShell } from "../src/shell/navigation.js";
import { canonicalWorkspaceUrl } from "../src/core/workspace.js";
import { emptyOperationsDocsSnapshot } from "../src/core/operations-model.js";
import { FakeDocument, FakeElement } from "./support/fake-dom.mjs";

function fakeLocation(pathname) {
  return { pathname, search: "" };
}

function routeFor(path) {
  const route = parseWorkspaceLocation(path, fakeLocation(path));
  assert.ok(!route.invalid, `${path} must parse`);
  return route;
}

function createRefreshSpies() {
  const calls = { work: [], recurring: [], quality: [] };
  return {
    calls,
    refreshOperationsWorkSnapshot: async (options) => {
      calls.work.push(options);
      return "work";
    },
    refreshOperationsRecurringSnapshot: async (options) => {
      calls.recurring.push(options);
      return "recurring";
    },
    refreshOperationsQualitySnapshot: async (options) => {
      calls.quality.push(options);
      return "quality";
    },
  };
}

describe("startup route classification", () => {
  test("defers every self-loading view and nothing else", () => {
    assert.deepEqual(
      [...SELF_LOADING_VIEWS].sort(),
      ["bookkeeping", "calendar", "finance", "newsletter", "podcast", "reconcile", "sponsors", "users"],
    );
    for (const view of SELF_LOADING_VIEWS) {
      assert.equal(isStartupDeferredRoute({ view }), true, view);
    }
    for (const path of ["/tasks", "/cards", "/templates", "/recurring", "/processes", "/admin"]) {
      assert.equal(isStartupDeferredRoute(routeFor(path)), false, path);
    }
    for (const path of [
      "/sponsors/pipeline",
      "/sponsors/companies",
      "/bookkeeping",
      "/finance",
      "/finance/reconcile/2026-09",
      "/calendar",
      "/newsletter",
      "/podcast",
      "/users",
    ]) {
      assert.equal(isStartupDeferredRoute(routeFor(path)), true, path);
    }
  });

  test("never defers invalid routes, documents, or Card/Task dialogs", () => {
    assert.equal(isStartupDeferredRoute(null), false);
    assert.equal(isStartupDeferredRoute(undefined), false);
    assert.equal(isStartupDeferredRoute({ invalid: true }), false);
    assert.equal(isStartupDeferredRoute({ view: "sponsors", invalid: true }), false);
    assert.equal(isStartupDeferredRoute({}), false);
    assert.equal(
      isStartupDeferredRoute({ ...routeFor("/sponsors/pipeline"), modalCardId: "card-1" }),
      false,
    );
    assert.equal(
      isStartupDeferredRoute({ ...routeFor("/sponsors/pipeline"), modalTaskId: "task-1" }),
      false,
    );
  });

  test("the repaint gate consumes the same canonical set", async () => {
    const { readFileSync } = await import("node:fs");
    const { default: path } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const repoRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../..",
    );
    const composition = readFileSync(
      path.join(repoRoot, "frontend/src/runtime/surface-composition.js"),
      "utf8",
    );
    assert.match(
      composition,
      /import \{ SELF_LOADING_VIEWS \} from "\.\.\/shell\/startup-orchestration\.js";/,
    );
    assert.doesNotMatch(composition, /const SELF_LOADING_VIEWS = new Set/);
  });
});

describe("startup orchestration dispatch", () => {
  test("bootstrap on CRM defers all three snapshots", async () => {
    const spies = createRefreshSpies();
    const orchestration = createStartupOrchestration(spies);
    const outcome = orchestration.dispatchBootstrapSnapshots(routeFor("/sponsors/pipeline"));
    assert.deepEqual(outcome, { work: null, recurring: null, quality: null });
    await Promise.resolve();
    assert.deepEqual(spies.calls, { work: [], recurring: [], quality: [] });
    assert.equal(orchestration.isSnapshotStarted("work"), false);
    assert.equal(orchestration.isSnapshotStarted("recurring"), false);
    assert.equal(orchestration.isSnapshotStarted("quality"), false);
  });

  test("bootstrap on Tasks starts every snapshot in the background", async () => {
    const spies = createRefreshSpies();
    const orchestration = createStartupOrchestration(spies);
    const outcome = await orchestration.dispatchBootstrapSnapshots(routeFor("/tasks")).work;
    assert.equal(outcome, "work");
    for (const name of ["work", "recurring", "quality"]) {
      assert.deepEqual(spies.calls[name], [{ background: true }], name);
      assert.equal(orchestration.isSnapshotStarted(name), true, name);
    }
  });

  test("bootstrap on unknown routes and documents starts everything", async () => {
    const spies = createRefreshSpies();
    const orchestration = createStartupOrchestration(spies);
    orchestration.dispatchBootstrapSnapshots(null);
    orchestration.dispatchBootstrapSnapshots({ invalid: true, reason: "unknown path" });
    await Promise.resolve();
    assert.equal(spies.calls.work.length, 1);
  });

  test("navigation to work surfaces starts deferred snapshots exactly once", async () => {
    const spies = createRefreshSpies();
    const orchestration = createStartupOrchestration(spies);
    orchestration.dispatchBootstrapSnapshots(routeFor("/sponsors/pipeline"));
    const first = orchestration.ensureSharedSnapshots(routeFor("/tasks"));
    assert.ok(first.work instanceof Promise);
    const second = orchestration.ensureSharedSnapshots(routeFor("/recurring"));
    assert.deepEqual(second, { work: null, recurring: null, quality: null });
    await first.work;
    assert.deepEqual(spies.calls.work, [{ background: true }]);
    assert.deepEqual(spies.calls.recurring, [{ background: true }]);
    assert.deepEqual(spies.calls.quality, [{ background: true }]);
  });

  test("self-loading navigation and rapid route changes never duplicate work", async () => {
    const spies = createRefreshSpies();
    const orchestration = createStartupOrchestration(spies);
    orchestration.dispatchBootstrapSnapshots(routeFor("/sponsors/pipeline"));
    assert.deepEqual(orchestration.ensureSharedSnapshots(routeFor("/sponsors/companies")), {
      work: null,
      recurring: null,
      quality: null,
    });
    assert.deepEqual(orchestration.ensureSharedSnapshots(routeFor("/sponsors/pipeline")), {
      work: null,
      recurring: null,
      quality: null,
    });
    await Promise.resolve();
    assert.deepEqual(spies.calls, { work: [], recurring: [], quality: [] });
  });

  test("explicit refreshes always refetch, even before initialization", async () => {
    const spies = createRefreshSpies();
    const orchestration = createStartupOrchestration(spies);
    assert.equal(await orchestration.refreshOperationsWorkSnapshot({ background: true }), "work");
    assert.equal(await orchestration.refreshOperationsWorkSnapshot({ rerender: true }), "work");
    assert.deepEqual(spies.calls.work, [{ background: true }, { rerender: true }]);
    assert.equal(orchestration.isSnapshotStarted("work"), true);
    // An explicit refresh counts as initialization: the later navigation
    // ensure must not fire the same snapshot again.
    assert.deepEqual(orchestration.ensureSharedSnapshots(routeFor("/tasks")).work, null);
    assert.deepEqual(spies.calls.work.length, 2);
  });

  test("a Task dialog over CRM initializes the shared snapshots", async () => {
    const spies = createRefreshSpies();
    const orchestration = createStartupOrchestration(spies);
    orchestration.dispatchBootstrapSnapshots(routeFor("/sponsors/pipeline"));
    const outcome = orchestration.ensureSharedSnapshots({
      ...routeFor("/sponsors/pipeline"),
      modalTaskId: "task-1",
    });
    assert.ok(outcome.work instanceof Promise);
    await outcome.work;
    assert.equal(spies.calls.work.length, 1);
  });
});

describe("catalog startup dispatch", () => {
  function createCatalogHarness(options = {}) {
    const dispatched = [];
    const spies = createRefreshSpies();
    const availability = [];
    const catalog = createKnowledgeCatalog(
      {
        apiUrl: (path) => new URL(path, "http://portal.test"),
        cleanPath: (value) => String(value).replace(/^content\//, ""),
        dispatchBootstrapSnapshots: (route) => {
          dispatched.push(route);
          return { work: null, recurring: null, quality: null };
        },
        knowledgeState: {
          allDocuments: [],
          documentIdMap: new Map(),
          selectedFolder: "",
        },
        refreshOperationsWorkSnapshot: spies.refreshOperationsWorkSnapshot,
        refreshOperationsRecurringSnapshot: spies.refreshOperationsRecurringSnapshot,
        refreshOperationsQualitySnapshot: spies.refreshOperationsQualitySnapshot,
        renderInBackground: () => {},
        request: options.request || (async () => ({ documents: [] })),
        setDocsAvailability: (snapshot) => availability.push(snapshot),
        showsSharedSnapshots: () => true,
      },
      { populateFilterOptions: () => {} },
    );
    return { catalog, dispatched, spies, availability };
  }

  test("explicit refresh keeps the historical snapshot fanout", async () => {
    const harness = createCatalogHarness();
    await harness.catalog.loadDocuments();
    assert.deepEqual(harness.dispatched, []);
    assert.deepEqual(harness.spies.calls.work, [{ background: true }]);
    assert.deepEqual(harness.spies.calls.recurring, [{ background: true }]);
    assert.deepEqual(harness.spies.calls.quality, [{ background: true }]);
    assert.equal(harness.availability[0].state, "loading");
    assert.equal(harness.availability.at(-1).state, "loaded");
  });

  test("bootstrap on CRM dispatches without the snapshot fanout", async () => {
    const harness = createCatalogHarness();
    await harness.catalog.loadDocuments(routeFor("/sponsors/pipeline"));
    assert.equal(harness.dispatched.length, 1);
    assert.deepEqual(harness.spies.calls, { work: [], recurring: [], quality: [] });
    // The docs catalog still loads: availability must not depend on routing.
    assert.equal(harness.availability[0].state, "loading");
    assert.equal(harness.availability.at(-1).state, "loaded");
  });

  test("a docs outage still reports unavailable on a deferred route", async () => {
    const harness = createCatalogHarness({
      request: async () => {
        throw new Error("Docs content root is unavailable: /tmp/missing");
      },
    });
    await harness.catalog.loadDocuments(routeFor("/sponsors/pipeline"));
    assert.equal(harness.dispatched.length, 1);
    assert.deepEqual(harness.spies.calls, { work: [], recurring: [], quality: [] });
    assert.equal(harness.availability.at(-1).state, "unavailable");
    assert.match(harness.availability.at(-1).error || "", /unavailable/);
  });
});

describe("bootstrap initial route forwarding", () => {
  test("passes the initial route to the documents loader in order", () => {
    const calls = [];
    const initialRoute = routeFor("/sponsors/pipeline");
    const documentsReady = Promise.resolve();
    const result = initializeAppShell({
      initialRoute,
      loadDocuments: (route) => {
        calls.push(["load-documents", route]);
        return documentsReady;
      },
      navigationShell: {
        initializeRouting: (ready) => {
          assert.equal(ready, documentsReady);
          calls.push(["routing"]);
        },
      },
      refreshChangesPanel: () => calls.push(["changes"]),
      refreshKnowledgeStatus: () => calls.push(["status"]),
      refreshOperationsWorkSnapshot: async () => "refreshed",
      refreshUsersSurface: async () => "users",
      showLibrary: () => calls.push(["library"]),
      updateSaveState: () => calls.push(["save-state"]),
      windowRef: {},
    });
    assert.equal(result.documentsReady, documentsReady);
    assert.deepEqual(calls[0], ["library"]);
    const loadIndex = calls.findIndex((entry) => entry[0] === "load-documents");
    assert.ok(loadIndex > 0);
    assert.equal(calls[loadIndex][1], initialRoute);
    assert.ok(calls.findIndex((entry) => entry[0] === "load-documents") < calls.findIndex(
      (entry) => entry[0] === "routing",
    ));
  });
});

describe("navigation snapshot ensure", () => {
  function createShellHarness(ensureSharedSnapshots) {
    const documentList = new FakeElement("main");
    const searchInput = new FakeElement("input");
    const body = new FakeElement("body");
    const document = new FakeDocument(body, documentList, searchInput);
    document.body = body;
    const location = fakeLocation("/sponsors/pipeline");
    const ensured = [];
    const shell = createNavigationShell({
      canLeaveCurrentDocument: async () => true,
      canonicalWorkspaceUrl,
      closeSettingsMenu: () => {},
      closeSidebar: () => {},
      closeWorkBellPanel: () => {},
      docPathFromLocation: () => "",
      documentList,
      documentRef: document,
      ensureSharedSnapshots,
      folderExists: () => false,
      folderPathFromLocation: () => "",
      getDocsAvailability: () => emptyOperationsDocsSnapshot(),
      getKnowledgeState: () => ({ allDocuments: [], selectedFolder: "" }),
      getTasksSectionForLegacyView: () => null,
      historyRef: {
        state: null,
        pushState() {},
        replaceState() {},
        back() {},
      },
      HTMLElementClass: FakeElement,
      hydrateCardPanel: async () => {},
      hydrateTaskPanel: async () => {},
      locationRef: location,
      openDocument: async () => {},
      parseWorkspaceLocation: (path) => parseWorkspaceLocation(path, location),
      prepareCardPanel: () => {},
      prepareTaskPanel: () => {},
      refreshDocuments: () => {},
      refreshPodcastEpisodes: async () => {},
      refreshUsersSurface: async () => {},
      restoreDocumentFilters: () => {},
      renderWorkspaceNav: () => ({}),
      requestAnimationFrameImpl: (callback) => callback(),
      resetCardPanel: () => {},
      resetTaskPanel: () => {},
      resolveTaskQueueRouteContext: async () => {},
      resolveTemplateRouteEntity: async () => {},
      searchInput,
      setActiveTasksSection: () => {},
      setActiveWorkspaceView: () => {},
      setRuntimeTemplateRoute: () => {},
      setTaskRouteContextFromRoute: () => {},
      setView: () => {},
      showLibrary: () => {},
      workspaceRouteFor: (path, params) => parseWorkspaceLocation(
        canonicalWorkspaceUrl(path, params),
        location,
      ),
    });
    return { ensured, location, shell };
  }

  test("committing a tasks route ensures snapshots with the committed route", async () => {
    const ensured = [];
    const harness = createShellHarness((route) => {
      ensured.push(route);
      return { work: null, recurring: null, quality: null };
    });
    harness.location.pathname = "/tasks";
    const { route } = harness.shell.navigateCanonicalWorkspace("/tasks");
    assert.equal(route.view, "tasks");
    assert.equal(ensured.length, 1);
    assert.equal(ensured[0].view, "tasks");
    assert.equal(ensured[0].path, "/tasks");
  });

  test("committing a CRM route still ensures (deferred inside the orchestration)", async () => {
    const ensured = [];
    const harness = createShellHarness((route) => {
      ensured.push(route);
      return { work: null, recurring: null, quality: null };
    });
    const { route } = harness.shell.navigateCanonicalWorkspace("/sponsors/pipeline");
    assert.equal(route.view, "sponsors");
    assert.equal(ensured.length, 1);
    assert.equal(ensured[0].view, "sponsors");
  });
});
