import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { emptyOperationsDocsSnapshot } from "../src/core/operations-model.js";
import { createKnowledgeSurface } from "../src/surfaces/knowledge/index.js";
import { createOperationsOverview } from "../src/surfaces/operations-overview.js";
import {
  FakeDocument,
  FakeElement,
  findAllByClass,
  findByText,
  nextTicks,
} from "./support/fake-dom.mjs";

const originalDocument = globalThis.document;
const originalOption = globalThis.Option;
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

afterEach(() => {
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
  if (originalOption === undefined) delete globalThis.Option;
  else globalThis.Option = originalOption;
});

class FakeOption extends FakeElement {
  constructor(text, value) {
    super("option");
    this.textContent = text;
    this.value = value;
  }
}

function decorateKnowledgeElement(element) {
  element.replaceWith = (replacement) => {
    if (!element.parentElement) return;
    const parent = element.parentElement;
    const index = parent.children.indexOf(element);
    if (index < 0) return;
    replacement.parentElement = parent;
    parent.children.splice(index, 1, replacement);
    element.parentElement = null;
  };
  element.select = () => {
    element.selected = true;
  };
  return element;
}

class KnowledgeDocument extends FakeDocument {
  createElement(tagName) {
    return decorateKnowledgeElement(super.createElement(tagName));
  }
}

function createDocumentRow() {
  const row = new FakeElement("article");
  row.className = "document-card";
  const title = new FakeElement("h3");
  const summary = new FakeElement("p");
  const path = new FakeElement("span");
  path.className = "doc-path";
  const domain = new FakeElement("span");
  domain.className = "doc-domain";
  const type = new FakeElement("span");
  type.className = "doc-type";
  row.append(title, summary, path, domain, type);
  row.cloneNode = () => createDocumentRow();
  return row;
}

function apiUrl(path) {
  return new URL(path, "http://portal.test");
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function surfaceHeader(title, description) {
  const header = new FakeElement("header");
  header.textContent = `${title}: ${description}`;
  return header;
}

function createKnowledgeHarness(options = {}) {
  const elements = Object.fromEntries(
    [
      "clearSelectionButton",
      "clearFiltersButton",
      "diffBody",
      "diffModal",
      "diffTitle",
      "docContextReturn",
      "docMenuButton",
      "docState",
      "documentList",
      "documentPath",
      "documentTitle",
      "domainFilter",
      "editor",
      "editorView",
      "emptyNote",
      "filterCount",
      "filtersSection",
      "libraryTitle",
      "quickNav",
      "quickNavInput",
      "quickNavResults",
      "renderedView",
      "searchInput",
      "systemFilter",
      "tagFilter",
      "typeFilter",
    ].map((name) => [name, new FakeElement("div")]),
  );
  for (const name of [
    "documentTitle",
    "domainFilter",
    "editor",
    "quickNavInput",
    "searchInput",
    "systemFilter",
    "tagFilter",
    "typeFilter",
  ]) {
    elements[name].value = "";
  }
  elements.editorView.dataset.mode = "rendered";
  elements.filtersSection.open = false;

  const body = new FakeElement("body");
  body.dataset.view = "library";
  const document = new KnowledgeDocument(
    undefined,
    body,
    ...Object.values(elements),
  );
  document.body = body;
  globalThis.document = document;
  globalThis.Option = FakeOption;

  const knowledgeState = {
    allDocuments: [],
    visibleDocuments: [],
    selectedFolder: "",
    documentIdMap: new Map(),
    searchController: null,
    activeSearchSources: [],
    docReturnContext: null,
    documentFilters: {
      domain: "",
      type: "",
      system: "",
      tag: "",
    },
    ...options.knowledgeState,
  };
  knowledgeState.documentFilters = {
    domain: "",
    type: "",
    system: "",
    tag: "",
    ...options.knowledgeState?.documentFilters,
  };
  const documentState = {
    currentDoc: null,
    currentParsed: null,
    currentWarnings: [],
    lastSavedContent: "",
    hasDraft: false,
    ...options.documentState,
  };
  const location = {
    origin: "http://portal.test",
    pathname: "/",
    search: "",
    hash: "",
    ...options.location,
  };
  // The production docs-availability renderer, so surfaces are checked against
  // the shared component instead of a test double.
  const { renderDocsAvailabilityState, renderHonestState } =
    createOperationsOverview({ document });
  let docsAvailability =
    options.docsAvailability || emptyOperationsDocsSnapshot();
  const storageValues = new Map(Object.entries(options.storage || {}));
  const requests = [];
  const documentNavigationEvents = [];
  const statuses = [];
  const routeTitles = [];
  const views = [];
  const history = [];
  const refreshes = [];
  const openedTasks = [];
  const openedCards = [];
  const navigations = [];
  let renderedWorkspace = 0;
  let renderedWorkspaceDocuments;
  let sidebarCloses = 0;
  let operationsHomeReturns = 0;

  const request = async (url, requestOptions = {}) => {
    const entry = { url: String(url), options: requestOptions };
    requests.push(entry);
    documentNavigationEvents.push({ type: "request", url: entry.url });
    if (options.request) return options.request(url, requestOptions, entry);
    return {};
  };
  const qualityFiltersState = options.qualityFiltersState || {
    value: { severity: "", category: "", workflow: "", document: "" },
  };
  const refresh = (name) => (refreshOptions) => {
    refreshes.push({ name, options: refreshOptions });
    return Promise.resolve();
  };
  const api = createKnowledgeSurface({
    apiUrl,
    assistantJobsFromPayload: (payload) => payload?.jobs || [],
    basename: (path) => String(path || "").split("/").at(-1) || "",
    buildOperationsHomeModel: () => ({
      quality: options.operationsQualityModel || {
        loaded: true,
        activeWorkLoaded: true,
        totalFindings: 0,
        summary: { blocking: 0 },
        maintainerFindings: [],
        errors: [],
      },
    }),
    buildOperationsReferenceLinks: () => [
      { title: "Process catalog", description: "Internal Process Docs" },
    ],
    buildProcessQualityModel: () => ({ findings: [] }),
    beginDocumentNavigation() {
      documentNavigationEvents.push({ type: "begin" });
    },
    cardsFromWorkPayload: (payload) => payload?.cards || [],
    canLeaveCurrentDocument: async () => true,
    cleanPath: (path) => String(path || "").replace(/^\/+|\/+$/g, ""),
    closeSidebar: () => {
      sidebarCloses += 1;
    },
    closeWorkBellPanel() {},
    confirmDialog: async () => true,
    customSelects: [],
    documentIdMapUnused: new Map(),
    documentRowTemplate: {
      content: { firstElementChild: createDocumentRow() },
    },
    documentState,
    draftKey: (path) => `draft:${path}`,
    enterRenderedMode() {},
    escapeRegex: (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    getActiveWorkspaceRoute: () => options.activeRoute || null,
    getActiveTasksSection: () => "queue",
    getActiveWorkspaceView: () => "docs",
    getDocsAvailability: () => docsAvailability,
    getOperationsQualitySnapshot: () => ({ loaded: true, findings: [] }),
    getOperationsRecurringSnapshot: () => ({ loaded: true, configs: [] }),
    getOperationsWorkSnapshot: () => ({ loaded: true, tasks: [] }),
    historyAdapter: {
      pushState: (state, _unused, url) => history.push({ state, url }),
    },
    knowledgeState,
    labelizeWorkValue: (value) =>
      String(value || "")
        .split("-")
        .map((part) => part[0]?.toUpperCase() + part.slice(1))
        .join(" "),
    listDraftPaths: () => [],
    locationAdapter: location,
    navigateCanonicalWorkspace: (path, params, navigationOptions = {}) => {
      navigations.push({ path, params, options: navigationOptions });
      return { ready: Promise.resolve() };
    },
    openCardPanel: (id) => openedCards.push(id),
    openQuickWorkflowForm() {},
    openTaskPanel: (id) => openedTasks.push(id),
    operationsViewTitle: (view) => view,
    promptUser: () => "",
    qualityFiltersState,
    refreshChangesPanel() {},
    refreshGitStatus() {},
    refreshOperationsArtifactSnapshot: refresh("artifacts"),
    refreshOperationsAssistantSnapshot: refresh("assistants"),
    refreshOperationsQualitySnapshot: refresh("quality"),
    refreshOperationsRecurringSnapshot: refresh("recurring"),
    refreshOperationsWorkSnapshot: refresh("work"),
    renameCurrentDoc() {},
    deleteCurrentDoc() {},
    renderDocsAvailabilityState,
    renderHonestState,
    renderOperationsReference: (reference) => {
      const node = new FakeElement("a");
      node.textContent = reference.title;
      return node;
    },
    renderOperationsWorkspace(documents) {
      renderedWorkspace += 1;
      renderedWorkspaceDocuments = documents;
    },
    renderQualityFindingRow: () => new FakeElement("div"),
    renderSurfaceHeader: surfaceHeader,
    reportError() {},
    request,
    resetCardPanel() {},
    resetTaskPanel() {},
    resizeDocumentTitle() {},
    scheduleAnimationFrame: (callback) => callback(),
    setDocsAvailability: (snapshot) => {
      docsAvailability = snapshot;
    },
    setRouteTitle: (title) => routeTitles.push(title),
    setSaveState: (value) => statuses.push(`save:${value}`),
    setStatus: (value) => statuses.push(value),
    setView: (value) => {
      body.dataset.view = value;
      views.push(value);
    },
    showOperationsHome: async () => {
      operationsHomeReturns += 1;
    },
    showWorkspaceSurface() {},
    storage: {
      getItem: (key) => storageValues.get(key) ?? null,
      setItem: (key, value) => storageValues.set(key, String(value)),
      removeItem: (key) => storageValues.delete(key),
    },
    surfaceDescription: (surface) => `${surface} surface`,
    surfaceStatusText: () => "Process Docs ready",
    tasksFromWorkPayload: (payload) => payload?.tasks || [],
    titleFromMarkdown: () => "Loaded process",
    updateGithubLink() {},
    updateSaveState() {},
    updateViewToggleAvailability() {},
    viewportWidth: () => 390,
    workApiUrl: apiUrl,
    body,
    ...elements,
  });

  return {
    api,
    body,
    docsAvailability: () => docsAvailability,
    document,
    documentNavigationEvents,
    documentState,
    elements,
    history,
    knowledgeState,
    location,
    navigations,
    openedCards,
    openedTasks,
    operationsHomeReturns: () => operationsHomeReturns,
    routeTitles,
    refreshes,
    renderedWorkspace: () => renderedWorkspace,
    renderedWorkspaceDocuments: () => renderedWorkspaceDocuments,
    requests,
    sidebarCloses: () => sidebarCloses,
    statuses,
    storageValues,
    views,
  };
}

describe("Knowledge surface boundary", () => {
  test("keeps shell status ownership out of the four Knowledge feedback owners", () => {
    for (const file of ["catalog.js", "search.js", "process-docs.js", "navigation.js"]) {
      const source = readFileSync(
        path.join(repoRoot, "frontend/src/surfaces/knowledge", file),
        "utf8",
      );
      assert.doesNotMatch(source, /\bsetStatus\b/, file);
    }
  });

  test("directly imports production factory and exposes the stable Knowledge facade", () => {
    assert.deepEqual(Object.keys(createKnowledgeHarness().api).sort(), [
      "clearDocumentFilters",
      "clearSelection",
      "closeCustomSelects",
      "closeQuickNav",
      "docPathFromLocation",
      "enhanceSelect",
      "fetchBacklinksForCurrentDoc",
      "filterDocuments",
      "folderExists",
      "folderPathFromLocation",
      "getAllDocuments",
      "getSelectedFolder",
      "handleQuickNavKeydown",
      "humanizeOptionLabel",
      "labelForPath",
      "loadDocuments",
      "localDocPathFromHref",
      "onFilterChange",
      "openDocMenu",
      "openDocument",
      "openQuickNav",
      "populateFilterOptions",
      "refreshDocuments",
      "renderDocsSurface",
      "renderGithubRawFooter",
      "renderLoomBlock",
      "renderProcessesSurface",
      "renderRelatedDocsBlock",
      "renderUnifiedSearchSurface",
      "renderWarningsBlock",
      "resolveDocReference",
      "resolveMarkdownDocLink",
      "restoreDocumentFilters",
      "searchFilterParams",
      "setFolderUrl",
      "setSelectedFolder",
      "showLibrary",
      "syncLibraryRouteTitle",
      "updateFilterSummary",
      "updateQuickNavMatches",
      "visibleDocUrl",
    ]);
  });

  test("loads the Process Docs catalog while independent work sources refresh", async () => {
    let releaseDocs;
    const docsReady = new Promise((resolve) => {
      releaseDocs = resolve;
    });
    const documents = [
      {
        id: "process-onboarding",
        aliases: ["onboarding"],
        path: "content/operations/onboarding.md",
        title: "Onboarding",
        domain: "operations",
        doc_type: "process",
        systems: ["portal"],
        tags: ["people"],
      },
    ];
    const harness = createKnowledgeHarness({
      request: async (url) => {
        if (new URL(url).pathname === "/docs") return docsReady;
        return {};
      },
    });

    const loading = harness.api.loadDocuments();
    assert.deepEqual(
      harness.refreshes.map((entry) => entry.name),
      ["work", "recurring", "artifacts", "assistants", "quality"],
    );
    assert.ok(
      harness.refreshes.every((entry) => entry.options.rerender === true),
    );
    assert.equal(harness.docsAvailability().state, "loading");
    assert.equal(harness.statuses.includes("Loading documents..."), false);

    releaseDocs({ documents });
    await loading;
    assert.deepEqual(harness.api.getAllDocuments(), documents);
    assert.equal(harness.api.resolveDocReference("onboarding"), documents[0]);
    assert.equal(
      harness.api.resolveDocReference("content/operations/onboarding.md"),
      documents[0],
    );
    assert.equal(harness.api.folderExists("content/operations"), true);
    assert.equal(harness.renderedWorkspace(), 1);
    assert.deepEqual(harness.renderedWorkspaceDocuments(), documents);
  });

  test("ignores a stale catalog response after a newer load starts", async () => {
    const firstResponse = deferred();
    let docsRequestCount = 0;
    const current = {
      path: "content/current.md",
      title: "Current catalog document",
    };
    const stale = {
      path: "content/stale.md",
      title: "Stale catalog document",
    };
    const harness = createKnowledgeHarness({
      request: async (url) => {
        if (new URL(url).pathname !== "/docs") return {};
        docsRequestCount += 1;
        return docsRequestCount === 1
          ? firstResponse.promise
          : { documents: [current] };
      },
    });

    const first = harness.api.loadDocuments();
    await nextTicks();
    const second = harness.api.loadDocuments();
    await second;
    firstResponse.resolve({ documents: [stale] });
    await first;

    assert.deepEqual(harness.api.getAllDocuments(), [current]);
    assert.equal(harness.docsAvailability().documentCount, 1);
  });

  test("keeps empty and failed catalog truth explicit without blocking work refreshes", async () => {
    const empty = createKnowledgeHarness({
      request: async () => ({ documents: [] }),
    });
    await empty.api.loadDocuments();
    assert.deepEqual(empty.api.getAllDocuments(), []);
    assert.deepEqual(empty.docsAvailability(), {
      state: "loaded",
      documentCount: 0,
      error: "",
      status: 0,
    });
    assert.equal(empty.renderedWorkspace(), 1);
    assert.deepEqual(empty.renderedWorkspaceDocuments(), []);

    const failed = createKnowledgeHarness({
      request: async () => {
        const error = new Error(
          "Docs content root is unavailable: /missing/content",
        );
        error.status = 503;
        throw error;
      },
    });
    await failed.api.loadDocuments();
    // The failure is now carried by the shared snapshot, not by the
    // permanently hidden #status-text element.
    assert.deepEqual(failed.docsAvailability(), {
      state: "unavailable",
      documentCount: 0,
      error: "Docs content root is unavailable: /missing/content",
      status: 503,
    });
    assert.equal(
      failed.statuses.includes("Docs content root is unavailable: /missing/content"),
      false,
    );
    assert.deepEqual(failed.api.getAllDocuments(), []);
    assert.deepEqual(
      failed.refreshes.map((entry) => entry.name),
      ["work", "recurring", "artifacts", "assistants", "quality"],
    );
    // A failed load repaints the surface the operator is already looking at.
    assert.equal(failed.renderedWorkspace(), 1);
  });

  test("marks docs as loading before the bootstrap catalog request settles", async () => {
    let releaseDocs;
    const harness = createKnowledgeHarness({
      docsAvailability: {
        state: "loaded",
        documentCount: 4,
        error: "",
        status: 0,
      },
      request: () =>
        new Promise((resolve) => {
          releaseDocs = resolve;
        }),
    });

    const loading = harness.api.loadDocuments();
    assert.equal(harness.docsAvailability().state, "loading");
    harness.api.renderDocsSurface([]);
    const loadingState =
      harness.elements.documentList.querySelector("[data-docs-state]");
    assert.equal(loadingState.dataset.docsState, "loading");
    assert.equal(loadingState.getAttribute("role"), "status");

    releaseDocs({ documents: [] });
    await loading;
    assert.equal(harness.docsAvailability().state, "loaded");
  });

  test("falls back to an explicit reason when a docs failure carries no message", async () => {
    const harness = createKnowledgeHarness({
      request: async () => {
        throw new Error("");
      },
    });
    await harness.api.loadDocuments();
    assert.deepEqual(harness.docsAvailability(), {
      state: "unavailable",
      documentCount: 0,
      error: "Process documents could not be loaded and the server gave no reason.",
      status: 0,
    });
  });

  test("separates an unreachable corpus from an empty one on the Docs surface", async () => {
    const outage = createKnowledgeHarness({
      docsAvailability: {
        state: "unavailable",
        documentCount: 0,
        error: "Docs content root is unavailable: /missing/content",
        status: 503,
      },
    });
    outage.api.renderDocsSurface([]);
    const outageState =
      outage.elements.documentList.querySelector("[data-docs-state]");
    assert.equal(outageState.dataset.docsState, "unavailable");
    assert.equal(
      outageState.children[0].textContent,
      "Process documents are unavailable",
    );
    assert.equal(
      outageState.children[1].textContent,
      "Docs content root is unavailable: /missing/content",
    );
    assert.equal(
      outage.elements.documentList.textContent.includes(
        "No process documents yet",
      ),
      false,
    );
    // The outage state precedes the quality drill-down on the surface.
    const surface = outage.elements.documentList.children[0].children[1];
    assert.deepEqual(
      surface.children.map((child) => child.className),
      [
        "ops-honest-state",
        "ops-honest-state ops-docs-state",
        "ops-section ops-quality-drilldown",
        "ops-reference-grid",
      ],
    );

    const emptyCorpus = createKnowledgeHarness({
      docsAvailability: {
        state: "loaded",
        documentCount: 0,
        error: "",
        status: 0,
      },
    });
    emptyCorpus.api.renderDocsSurface([]);
    const emptyState =
      emptyCorpus.elements.documentList.querySelector("[data-docs-state]");
    assert.equal(emptyState.dataset.docsState, "empty");
    assert.equal(
      emptyState.children[0].textContent,
      "No process documents yet",
    );
    assert.equal(
      emptyCorpus.elements.documentList.textContent.includes(
        "Process documents are unavailable",
      ),
      false,
    );

    const healthy = createKnowledgeHarness({
      docsAvailability: {
        state: "loaded",
        documentCount: 2,
        error: "",
        status: 0,
      },
    });
    healthy.api.renderDocsSurface([]);
    assert.equal(
      healthy.elements.documentList.querySelector("[data-docs-state]"),
      null,
    );
  });

  test("opens the docs outage state in the editor instead of a blank document", async () => {
    const harness = createKnowledgeHarness({
      request: async () => {
        const error = new Error(
          "Docs content root is unavailable: /missing/content",
        );
        error.status = 503;
        throw error;
      },
    });

    await harness.api.openDocument("content/reference/schedule.md");
    assert.equal(harness.body.dataset.view, "editor");
    assert.equal(harness.elements.docState.hidden, false);
    const state = harness.elements.docState.children[0];
    assert.equal(state.dataset.docsState, "unavailable");
    assert.equal(
      state.textContent.includes(
        "Docs content root is unavailable: /missing/content",
      ),
      true,
    );
    assert.equal(harness.elements.editor.disabled, true);
    assert.equal(harness.elements.documentTitle.disabled, true);
    assert.equal(harness.documentState.currentDoc, null);
    assert.equal(harness.docsAvailability().state, "loading");
    assert.equal(
      harness.statuses.includes(
        "Docs content root is unavailable: /missing/content",
      ),
      false,
    );

    // The single-document route answers 404 while the whole content root is
    // missing, so the shared snapshot is what tells an outage from one missing
    // document, and the outage keeps the server's message.
    const knownOutage = createKnowledgeHarness({
      docsAvailability: {
        state: "unavailable",
        documentCount: 0,
        error: "Docs content root is unavailable: /missing/content",
        status: 503,
      },
      request: async () => {
        const error = new Error("Document not found");
        error.status = 404;
        throw error;
      },
    });
    await knownOutage.api.openDocument("content/reference/schedule.md");
    const notice = knownOutage.elements.docState.children[0];
    assert.equal(notice.dataset.docsState, "unavailable");
    assert.equal(
      notice.children[1].textContent,
      "Docs content root is unavailable: /missing/content",
    );
    assert.equal(knownOutage.statuses.includes("Document not found"), false);
  });

  test("keeps a single-document outage local so a successful retry preserves the catalog", async () => {
    let available = false;
    const harness = createKnowledgeHarness({
      docsAvailability: {
        state: "loaded",
        documentCount: 1,
        error: "",
        status: 0,
      },
      request: async () => {
        if (!available) {
          const error = new Error("Synthetic document route unavailable");
          error.status = 503;
          throw error;
        }
        return {
          path: "content/retry.md",
          content: "# Retry succeeds",
          updated: 1,
        };
      },
    });

    await harness.api.openDocument("content/retry.md");
    assert.equal(harness.docsAvailability().state, "loaded");
    assert.equal(harness.elements.docState.hidden, false);
    assert.equal(
      harness.elements.docState.children[0].dataset.documentState,
      "unavailable",
    );

    available = true;
    await findByText(
      harness.elements.docState,
      "Retry document",
      "button",
    ).click();
    assert.equal(harness.docsAvailability().state, "loaded");
    assert.equal(harness.elements.docState.hidden, true);
    assert.equal(harness.elements.editor.disabled, false);
  });

  test("renders the Process Docs route with executable quality and reference context", () => {
    const harness = createKnowledgeHarness({
      docsAvailability: {
        state: "loaded",
        documentCount: 1,
        error: "",
        status: 0,
      },
    });
    const documents = [
      {
        path: "content/processes/newsletter.md",
        title: "Newsletter process",
      },
    ];

    harness.api.renderDocsSurface(documents);
    assert.equal(harness.elements.libraryTitle.textContent, "Docs");
    assert.equal(
      harness.elements.documentList.classList.contains("is-operations-home"),
      true,
    );
    assert.equal(harness.routeTitles.at(-1), "Docs");
    assert.ok(
      findByText(
        harness.elements.documentList,
        "Processes support work",
        "strong",
      ),
    );
    assert.ok(
      findByText(harness.elements.documentList, "Process catalog", "a"),
    );
    assert.equal(
      harness.elements.documentList.querySelector("[data-docs-state]"),
      null,
    );
  });

  test("shows filter-empty guidance without replacing the Process Docs controls", () => {
    const harness = createKnowledgeHarness({
      docsAvailability: {
        state: "loaded",
        documentCount: 2,
        error: "",
        status: 0,
      },
      knowledgeState: {
        documentFilters: { domain: "operations" },
      },
    });

    harness.api.renderDocsSurface([]);
    const state = harness.elements.documentList.querySelector(
      '[data-docs-state="filter-empty"]',
    );
    assert.ok(state);
    assert.equal(state.getAttribute("role"), "status");
    assert.match(state.textContent, /catalog contains 2 process documents/);
    assert.match(state.textContent, /Clear filters/);
    assert.ok(findByText(harness.elements.documentList, "New process doc", "button"));
    assert.equal(harness.elements.clearSelectionButton.hidden, true);
  });

  test("separates filtered Process Docs empty-state guidance semantically", () => {
    const harness = createKnowledgeHarness({
      operationsQualityModel: {
        loaded: true,
        activeWorkLoaded: true,
        totalFindings: 2,
        summary: { blocking: 1 },
        maintainerFindings: [
          { id: "missing-proof", severity: "blocking", category: "proof" },
          {
            id: "stale-owner",
            severity: "warning",
            category: "maintenance",
          },
        ],
        errors: [],
      },
      qualityFiltersState: {
        value: {
          severity: "warning",
          category: "proof",
          workflow: "",
          document: "",
        },
      },
    });

    harness.api.renderDocsSurface([]);
    const list = harness.elements.documentList.querySelector(".ops-quality-list");
    const state = list.querySelector(".ops-honest-state");

    assert.equal(list.children.length, 1);
    assert.equal(state.children.length, 2);
    assert.equal(state.children[0].tagName, "STRONG");
    assert.equal(state.children[0].textContent, "No findings match filters");
    assert.equal(state.children[1].tagName, "SPAN");
    assert.equal(
      state.children[1].textContent,
      "Change filters to inspect other process quality findings.",
    );
    assert.equal(
      state.textContent,
      `${state.children[0].textContent}${state.children[1].textContent}`,
    );
  });

  test("renders an honest folder list state and preserves a canonical mobile return URL", async () => {
    const harness = createKnowledgeHarness({
      knowledgeState: {
        allDocuments: [
          {
            path: "content/operations/onboarding.md",
            title: "Onboarding",
          },
        ],
        selectedFolder: "empty",
      },
    });

    await harness.api.refreshDocuments();
    assert.ok(
      findByText(
        harness.elements.documentList,
        "No documents in this folder yet.",
        "div",
      ),
    );
    assert.equal(harness.elements.clearSelectionButton.hidden, false);
    assert.equal(harness.elements.documentList.children.length, 1);

    harness.api.showLibrary();
    assert.equal(harness.body.dataset.view, "library");
    assert.equal(harness.sidebarCloses(), 1);
    assert.deepEqual(harness.history.at(-1), {
      state: { folder: "empty" },
      url: "/empty",
    });
  });

  test("opens a filtered Process Docs document", async () => {
    const document = {
      path: "content/operations/onboarding.md",
      title: "Onboarding",
      description: "Start a new operator safely",
      domain: "operations",
      doc_type: "process",
    };
    const harness = createKnowledgeHarness({
      knowledgeState: {
        allDocuments: [document],
        selectedFolder: "content/operations",
      },
      request: async () => ({
        path: document.path,
        content: "# Onboarding",
      }),
    });

    await harness.api.refreshDocuments();
    assert.equal(
      harness.elements.documentList.querySelector(".doc-path").textContent,
      document.path,
    );
    assert.equal(
      harness.elements.documentList.querySelector(".doc-domain").textContent,
      "operations",
    );
    const documentRow = harness.elements.documentList.querySelector(
      ".document-card",
    );
    await documentRow.click();
    assert.equal(harness.documentState.currentDoc.path, document.path);
    assert.equal(harness.body.dataset.view, "editor");
  });

  test("keeps Process Docs filters canonical across controls, routes, and search", async () => {
    const activeRoute = { path: "/" };
    const documents = [
      {
        path: "content/operations/onboarding.md",
        title: "Onboarding",
        domain: "operations",
        doc_type: "process",
        systems: ["portal"],
        tags: ["people"],
      },
      {
        path: "content/product/design.md",
        title: "Design review",
        domain: "product",
        doc_type: "reference",
        systems: ["figma"],
        tags: ["design"],
      },
    ];
    const harness = createKnowledgeHarness({
      activeRoute,
      knowledgeState: { allDocuments: documents },
    });

    for (const [name, value] of [
      ["tagFilter", "people"],
      ["systemFilter", "portal"],
      ["typeFilter", "process"],
      ["domainFilter", "operations"],
    ]) {
      harness.elements[name].value = value;
    }

    await harness.api.onFilterChange();
    assert.deepEqual(harness.knowledgeState.documentFilters, {
      domain: "operations",
      type: "process",
      system: "portal",
      tag: "people",
    });
    assert.deepEqual(harness.api.filterDocuments(documents), [documents[0]]);
    assert.equal(harness.navigations.at(-1).path, "/processes");
    assert.deepEqual(
      [...harness.navigations.at(-1).params],
      [
        ["domain", "operations"],
        ["type", "process"],
        ["system", "portal"],
        ["tag", "people"],
      ],
    );
    assert.deepEqual(harness.navigations.at(-1).options, {
      history: "push",
      preserveDocumentComposer: true,
    });
    activeRoute.path = "/processes";
    assert.equal(harness.elements.filterCount.hidden, false);
    assert.equal(harness.elements.filterCount.textContent, "4");

    const restored = new URLSearchParams([
      ["unsupported", "ignore"],
      ["tag", "people"],
      ["system", "portal"],
      ["type", "process"],
      ["domain", "operations"],
    ]);
    harness.api.restoreDocumentFilters(restored);
    assert.deepEqual(harness.knowledgeState.documentFilters, {
      domain: "operations",
      type: "process",
      system: "portal",
      tag: "people",
    });
    assert.equal(harness.elements.filterCount.textContent, "4");
    assert.equal(harness.elements.domainFilter.value, "operations");
    assert.equal(harness.elements.typeFilter.value, "process");
    assert.equal(harness.elements.systemFilter.value, "portal");
    assert.equal(harness.elements.tagFilter.value, "people");

    harness.api.clearDocumentFilters();
    assert.deepEqual(harness.knowledgeState.documentFilters, {
      domain: "",
      type: "",
      system: "",
      tag: "",
    });
    assert.equal(harness.navigations.at(-1).path, "/processes");
    assert.equal([...harness.navigations.at(-1).params].length, 0);
    assert.deepEqual(harness.navigations.at(-1).options, {
      history: "replace",
      preserveDocumentComposer: true,
    });
    assert.equal(harness.elements.filterCount.hidden, true);
    assert.equal(harness.elements.filterCount.textContent, "");
    for (const name of ["domainFilter", "typeFilter", "systemFilter", "tagFilter"]) {
      assert.equal(harness.elements[name].value, "");
    }

    const searching = createKnowledgeHarness({
      knowledgeState: { allDocuments: documents },
    });
    for (const [name, value] of [
      ["domainFilter", "operations"],
      ["typeFilter", "process"],
      ["systemFilter", "portal"],
      ["tagFilter", "people"],
    ]) {
      searching.elements[name].value = value;
    }
    await searching.api.onFilterChange();
    searching.elements.searchInput.value = "launch";
    await searching.api.refreshDocuments();
    assert.equal(String(searching.requests[0].url),
      "http://portal.test/search?q=launch&limit=80&domain=operations&doc_type=process&system=portal&tag=people&source=docs");
  });

  test("groups unified search results and keeps partial source failures visible", async () => {
    const harness = createKnowledgeHarness({
      request: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/search") {
          return {
            results: [
              {
                type: "doc",
                path: "content/processes/launch.md",
                title: "Launch process",
                context: "Release checklist",
                source: "docs",
                source_label: "Process Docs",
                route: { kind: "doc", path: "content/processes/launch.md" },
              },
            ],
            sources: [{ source: "docs", status: "ok", count: 1 }],
          };
        }
        if (parsed.pathname === "/api/tasks") {
          return {
            tasks: [
              {
                id: "task-launch",
                description: "Launch newsletter",
                status: "open",
              },
            ],
          };
        }
        if (parsed.pathname === "/api/artifacts") {
          throw new Error("artifact index offline");
        }
        return {};
      },
    });
    harness.elements.searchInput.value = "launch";

    await harness.api.refreshDocuments();
    assert.equal(
      harness.elements.documentList.classList.contains("is-unified-search"),
      true,
    );
    assert.ok(
      findByText(
        harness.elements.documentList,
        "Partial search results",
        "strong",
      ),
    );
    assert.ok(findByText(harness.elements.documentList, "Tasks", "h3"));
    assert.ok(
      findByText(harness.elements.documentList, "Process Docs", "h3"),
    );
    assert.equal(
      findAllByClass(
        harness.elements.documentList,
        "unified-search-group",
      ).length,
      2,
    );
    const sourceState = findAllByClass(
      harness.elements.documentList,
      "search-source-state",
    )[0];
    assert.equal(sourceState.dataset.searchState, "partial");
    assert.ok(findByText(harness.elements.documentList, "Retry search", "button"));
    assert.equal(
      harness.statuses.includes("2 search results · 1 source issues."),
      false,
    );

    const taskRow = findAllByClass(
      harness.elements.documentList,
      "result-task",
    )[0];
    await taskRow.click();
    assert.deepEqual(harness.openedTasks, ["task-launch"]);
  });

  test("attributes an unavailable docs search source to process documents", async () => {
    const harness = createKnowledgeHarness({
      request: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/search") {
          const error = new Error(
            "Docs content root is unavailable: /missing/content",
          );
          error.status = 503;
          throw error;
        }
        return {};
      },
    });
    harness.elements.searchInput.value = "launch";

    await harness.api.refreshDocuments();
    const banner = findAllByClass(
      harness.elements.documentList,
      "search-source-state",
    )[0];
    assert.equal(
      banner.textContent.includes("Process documents could not load."),
      true,
    );
    assert.equal(banner.textContent.includes("work sources"), false);
    assert.equal(
      banner.textContent.includes(
        "process documents: Docs content root is unavailable: /missing/content",
      ),
      true,
    );
  });

  test("renders query loading, query-empty, and filter-empty search feedback", async () => {
    const pending = deferred();
    const query = createKnowledgeHarness({
      request: async (url) => {
        if (new URL(url).pathname === "/search") return pending.promise;
        return {};
      },
    });
    query.elements.searchInput.value = "missing synthetic result";

    const loading = query.api.refreshDocuments();
    const loadingState = query.elements.documentList.querySelector(
      '[data-search-state="loading"]',
    );
    assert.ok(loadingState);
    assert.equal(loadingState.getAttribute("role"), "status");

    pending.resolve({
      results: [],
      sources: [{ source: "docs", status: "ok", count: 0 }],
    });
    await loading;
    const queryEmpty = query.elements.documentList.querySelector(
      '[data-search-state="query-empty"]',
    );
    assert.ok(queryEmpty);
    assert.match(queryEmpty.textContent, /No work or process context matches this search/);

    const filtered = createKnowledgeHarness({
      knowledgeState: { documentFilters: { domain: "operations" } },
      request: async (url) => {
        if (new URL(url).pathname === "/search") {
          const parsed = new URL(url);
          if (!parsed.searchParams.has("domain")) {
            return {
              results: [
                {
                  type: "doc",
                  path: "content/unfiltered-match.md",
                  title: "Unfiltered synthetic match",
                  source: "docs",
                },
              ],
              sources: [{ source: "docs", status: "ok", count: 1 }],
            };
          }
          return {
            results: [],
            sources: [{ source: "docs", status: "ok", count: 0 }],
          };
        }
        return {};
      },
    });
    filtered.elements.searchInput.value = "synthetic";
    await filtered.api.refreshDocuments();
    const filterEmpty = filtered.elements.documentList.querySelector(
      '[data-search-state="filter-empty"]',
    );
    assert.ok(filterEmpty);
    assert.equal(filterEmpty.getAttribute("role"), "status");
    assert.match(filterEmpty.textContent, /active metadata filter/);

    const filteredQueryEmpty = createKnowledgeHarness({
      knowledgeState: { documentFilters: { domain: "operations" } },
      request: async (url) => {
        if (new URL(url).pathname === "/search") {
          return {
            results: [],
            sources: [{ source: "docs", status: "ok", count: 0 }],
          };
        }
        return {};
      },
    });
    filteredQueryEmpty.elements.searchInput.value = "not anywhere";
    await filteredQueryEmpty.api.refreshDocuments();
    assert.ok(
      filteredQueryEmpty.elements.documentList.querySelector(
        '[data-search-state="query-empty"]',
      ),
    );
    assert.equal(
      filteredQueryEmpty.elements.documentList.querySelector(
        '[data-search-state="filter-empty"]',
      ),
      null,
    );
  });

  test("names every unavailable search source and retries the same query and filters", async () => {
    let available = false;
    const harness = createKnowledgeHarness({
      knowledgeState: { documentFilters: { tag: "synthetic" } },
      request: async (url) => {
        const parsed = new URL(url);
        if (!available) {
          const error = new Error(`${parsed.pathname} unavailable`);
          error.status = 503;
          throw error;
        }
        if (parsed.pathname === "/search") {
          return {
            results: [
              {
                type: "doc",
                path: "content/synthetic/retry.md",
                title: "Synthetic retry result",
                context: "Public-safe retry fixture",
                source: "docs",
              },
            ],
            sources: [{ source: "docs", status: "ok", count: 1 }],
          };
        }
        return {};
      },
    });
    harness.elements.searchInput.value = "retry fixture";

    await harness.api.refreshDocuments();
    const unavailable = harness.elements.documentList.querySelector(
      '[data-search-state="unavailable"]',
    );
    assert.ok(unavailable);
    assert.equal(unavailable.querySelectorAll("li").length, 6);
    for (const source of [
      "process documents",
      "tasks",
      "workflows",
      "templates",
      "artifacts",
      "assistant-jobs",
    ]) {
      assert.match(unavailable.textContent, new RegExp(source));
    }

    available = true;
    const retry = findByText(
      harness.elements.documentList,
      "Retry search",
      "button",
    );
    assert.ok(retry);
    await retry.click();
    assert.equal(
      harness.knowledgeState.visibleDocuments[0].title,
      "Synthetic retry result",
    );
    const searchRequest = harness.requests.find((entry) =>
      entry.url.includes("/search?q=retry+fixture"),
    );
    assert.match(searchRequest.url, /tag=synthetic/);
    assert.equal(harness.elements.searchInput.value, "retry fixture");
  });

  test("ignores stale unified-search results after the query changes", async () => {
    const firstResponse = deferred();
    const secondResponse = deferred();
    const pending = new Map([
      ["first", firstResponse],
      ["second", secondResponse],
    ]);
    const harness = createKnowledgeHarness({
      request: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/search") {
          return pending.get(parsed.searchParams.get("q")).promise;
        }
        return {};
      },
    });

    harness.elements.searchInput.value = "first";
    const first = harness.api.refreshDocuments();
    await nextTicks();
    harness.elements.searchInput.value = "second";
    const second = harness.api.refreshDocuments();
    await nextTicks();
    secondResponse.resolve({
      results: [
        {
          type: "doc",
          path: "content/second.md",
          title: "Second query result",
          source: "docs",
        },
      ],
      sources: [{ source: "docs", status: "ok", count: 1 }],
    });
    await second;
    firstResponse.resolve({
      results: [
        {
          type: "doc",
          path: "content/first.md",
          title: "First query result",
          source: "docs",
        },
      ],
      sources: [{ source: "docs", status: "ok", count: 1 }],
    });
    await first;

    assert.equal(
      harness.knowledgeState.visibleDocuments[0].title,
      "Second query result",
    );
  });

  test("normalizes document and folder deep links and rejects stale references", () => {
    const documentRoute = createKnowledgeHarness({
      location: { pathname: "/operations/onboarding.md" },
      knowledgeState: {
        allDocuments: [
          { path: "content/operations/onboarding.md", title: "Onboarding" },
        ],
      },
    });
    assert.equal(
      documentRoute.api.docPathFromLocation(),
      "content/operations/onboarding.md",
    );
    assert.equal(
      documentRoute.api.localDocPathFromHref(
        "http://portal.test/operations/onboarding.md#review",
      ),
      "content/operations/onboarding.md",
    );
    assert.equal(
      documentRoute.api.visibleDocUrl("content/operations/onboarding.md"),
      "/operations/onboarding.md",
    );
    assert.equal(documentRoute.api.resolveDocReference("removed-process"), null);
    assert.equal(documentRoute.api.folderExists("content/removed"), false);

    const folderRoute = createKnowledgeHarness({
      location: { pathname: "/content/operations" },
    });
    assert.equal(folderRoute.api.folderPathFromLocation(), "operations");
    folderRoute.api.setFolderUrl("operations");
    assert.deepEqual(folderRoute.history.at(-1), {
      state: { folder: "operations" },
      url: "/operations",
    });
  });

  test("keeps document loading and non-404 failure feedback visible and disables editing", async () => {
    const pending = deferred();
    const loading = createKnowledgeHarness({
      request: async () => pending.promise,
    });
    const opening = loading.api.openDocument("content/loading.md");
    await nextTicks();
    const loadingState = loading.elements.docState.children[0];
    assert.equal(loading.elements.docState.hidden, false);
    assert.equal(loadingState.dataset.documentState, "loading");
    assert.equal(loading.elements.editor.disabled, true);
    assert.equal(loading.elements.documentTitle.disabled, true);

    pending.resolve({
      path: "content/loading.md",
      content: "# Loaded after wait",
      updated: 10,
    });
    await opening;
    assert.equal(loading.elements.docState.hidden, true);

    const failed = createKnowledgeHarness({
      request: async () => {
        const error = new Error("Document service timed out");
        error.status = 500;
        throw error;
      },
    });
    await failed.api.openDocument("content/temporary.md");
    const errorState = failed.elements.docState.children[0];
    assert.equal(errorState.dataset.documentState, "error");
    assert.match(errorState.textContent, /Document service timed out/);
    assert.ok(findByText(failed.elements.docState, "Retry document", "button"));
    assert.equal(failed.elements.editor.disabled, true);
    assert.equal(failed.elements.documentTitle.disabled, true);
  });

  test("ignores a stale Process Doc response after a newer document opens", async () => {
    const firstResponse = deferred();
    const secondResponse = deferred();
    const pending = new Map([
      ["content/first.md", firstResponse],
      ["content/second.md", secondResponse],
    ]);
    const harness = createKnowledgeHarness({
      request: async (url) => {
        const path = new URL(url).searchParams.get("path");
        return pending.get(path).promise;
      },
    });

    const first = harness.api.openDocument("content/first.md");
    await nextTicks();
    const second = harness.api.openDocument("content/second.md");
    await nextTicks();
    secondResponse.resolve({
      path: "content/second.md",
      content: "# Second document",
      updated: 2,
    });
    await second;
    firstResponse.resolve({
      path: "content/first.md",
      content: "# First document",
      updated: 1,
    });
    await first;

    assert.deepEqual(harness.documentState.currentDoc, {
      path: "content/second.md",
      updated: 2,
    });
    assert.equal(harness.elements.editor.value, "# Second document");
    assert.equal(harness.history.at(-1).url, "/second.md");
    assert.equal(harness.elements.docState.hidden, true);
  });

  test("opens canonical Process Docs and exposes recoverable not-found state", async () => {
    const loaded = createKnowledgeHarness({
      request: async (url) => {
        const parsed = new URL(url);
        assert.equal(parsed.searchParams.get("path"), "content/runbook.md");
        return {
          path: "content/runbook.md",
          updated: 123,
          content: "# Runbook\n\nDo the work.",
          parsed: { sections: [] },
        };
      },
    });
    await loaded.api.openDocument("content/runbook.md", {
      returnContext: { type: "task", id: "task-7", title: "Review work" },
    });
    assert.deepEqual(loaded.documentNavigationEvents.slice(0, 2), [
      { type: "begin" },
      {
        type: "request",
        url: "http://portal.test/docs?path=content%2Frunbook.md",
      },
    ]);
    assert.deepEqual(loaded.history.at(-1), {
      state: { path: "content/runbook.md" },
      url: "/runbook.md",
    });
    assert.deepEqual(loaded.documentState.currentDoc, {
      path: "content/runbook.md",
      updated: 123,
    });
    assert.equal(loaded.elements.editor.value, "# Runbook\n\nDo the work.");
    assert.equal(loaded.body.dataset.view, "editor");
    assert.ok(
      findByText(
        loaded.elements.docContextReturn,
        "Opened from task: Review work",
        "span",
      ),
    );
    const back = findByText(
      loaded.elements.docContextReturn,
      "Back to Task",
      "button",
    );
    await back.click();
    await nextTicks();
    assert.equal(loaded.operationsHomeReturns(), 1);
    assert.deepEqual(loaded.openedTasks, ["task-7"]);

    const missing = createKnowledgeHarness({
      request: async () => {
        const error = new Error("Document not found");
        error.status = 404;
        throw error;
      },
    });
    await missing.api.openDocument("content/removed.md");
    assert.equal(missing.statuses.includes("Document not found"), false);
    assert.equal(missing.elements.docState.hidden, false);
    assert.equal(
      missing.elements.docState.children[0].dataset.documentState,
      "not-found",
    );
    assert.equal(
      missing.elements.docState.children[0].getAttribute("role"),
      "alert",
    );
    assert.equal(missing.documentState.currentDoc, null);
    assert.deepEqual(missing.history, []);
    assert.equal(missing.elements.editor.disabled, true);
  });

  test("renders related Process Docs and hides or lists backlinks truthfully", async () => {
    const host = new FakeElement("section");
    host.id = "backlinks-host";
    const harness = createKnowledgeHarness({
      documentState: {
        currentDoc: { path: "content/processes/newsletter.md" },
      },
      request: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/docs/backlinks") {
          return {
            backlinks: [
              { path: "content/tasks/send.md", title: "Send newsletter" },
            ],
          };
        }
        return {};
      },
    });
    harness.elements.renderedView.append(host);

    const related = harness.api.renderRelatedDocsBlock({
      related_docs: ["../policies/review.md"],
    });
    assert.ok(findByText(related, "Related docs (1)", "h3"));
    assert.ok(findByText(related, "../policies/review.md", "button"));

    await harness.api.fetchBacklinksForCurrentDoc();
    assert.equal(host.hidden, false);
    assert.ok(findByText(host, "Referenced by (1)", "h3"));
    assert.ok(findByText(host, "Send newsletter", "button"));

    const unavailable = createKnowledgeHarness({
      documentState: { currentDoc: { path: "content/missing.md" } },
      request: async () => {
        throw new Error("Backlinks unavailable");
      },
    });
    const unavailableHost = new FakeElement("section");
    unavailableHost.id = "backlinks-host";
    unavailable.elements.renderedView.append(unavailableHost);
    await unavailable.api.fetchBacklinksForCurrentDoc();
    assert.equal(unavailableHost.hidden, true);
  });
});
