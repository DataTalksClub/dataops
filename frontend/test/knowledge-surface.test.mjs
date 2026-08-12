import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { createKnowledgeSurface } from "../src/surfaces/knowledge.js";
import {
  FakeDocument,
  FakeElement,
  findAllByClass,
  findByText,
  nextTicks,
} from "./support/fake-dom.mjs";

const originalDocument = globalThis.document;
const originalOption = globalThis.Option;

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

function surfaceHeader(title, description) {
  const header = new FakeElement("header");
  header.textContent = `${title}: ${description}`;
  return header;
}

function createKnowledgeHarness(options = {}) {
  const elements = Object.fromEntries(
    [
      "clearSelectionButton",
      "diffBody",
      "diffModal",
      "diffTitle",
      "docContextReturn",
      "docMenuButton",
      "docPinButton",
      "docTree",
      "documentList",
      "documentPath",
      "documentTitle",
      "domainFilter",
      "editor",
      "editorView",
      "emptyNote",
      "filterCount",
      "filterRow",
      "filterToggle",
      "filtersSection",
      "libraryTitle",
      "pinnedList",
      "pinnedSection",
      "quickNav",
      "quickNavInput",
      "quickNavResults",
      "recentList",
      "recentlyViewedList",
      "recentlyViewedSection",
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

  const skeleton = new FakeElement("div");
  skeleton.id = "tree-skeleton";
  const body = new FakeElement("body");
  body.dataset.view = "library";
  const document = new KnowledgeDocument(
    skeleton,
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
    currentTreePath: "",
    documentIdMap: new Map(),
    searchController: null,
    activeSearchSources: [],
    docReturnContext: null,
    ...options.knowledgeState,
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
  const storageValues = new Map(Object.entries(options.storage || {}));
  const requests = [];
  const statuses = [];
  const pageTitles = [];
  const views = [];
  const history = [];
  const refreshes = [];
  const openedTasks = [];
  const openedCards = [];
  const navigations = [];
  let renderedWorkspace = 0;
  let sidebarCloses = 0;
  let operationsHomeReturns = 0;

  const request = async (url, requestOptions = {}) => {
    const entry = { url: String(url), options: requestOptions };
    requests.push(entry);
    if (options.request) return options.request(url, requestOptions, entry);
    return {};
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
      quality: {
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
    beginDocumentNavigation() {},
    bundlesFromWorkPayload: (payload) => payload?.bundles || [],
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
    getActiveTasksSection: () => "queue",
    getActiveWorkspaceView: () => "docs",
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
    navigateCanonicalWorkspace: (path, params) => {
      navigations.push({ path, params });
      return { ready: Promise.resolve() };
    },
    openBundlePanel: (id) => openedCards.push(id),
    openQuickWorkflowForm() {},
    openTaskPanel: (id) => openedTasks.push(id),
    operationsViewPath: (view) => `/${view}`,
    operationsViewTitle: (view) => view,
    promptUser: () => "",
    qualityFiltersState: {
      value: { severity: "", category: "", workflow: "", document: "" },
    },
    refreshChangesPanel() {},
    refreshGitStatus() {},
    refreshOperationsArtifactSnapshot: refresh("artifacts"),
    refreshOperationsAssistantSnapshot: refresh("assistants"),
    refreshOperationsQualitySnapshot: refresh("quality"),
    refreshOperationsRecurringSnapshot: refresh("recurring"),
    refreshOperationsWorkSnapshot: refresh("work"),
    renameCurrentDoc() {},
    deleteCurrentDoc() {},
    renderHonestState: honestState,
    renderOperationsReference: (reference) => {
      const node = new FakeElement("a");
      node.textContent = reference.title;
      return node;
    },
    renderOperationsWorkspace() {
      renderedWorkspace += 1;
    },
    renderQualityFindingRow: () => new FakeElement("div"),
    renderSurfaceHeader: surfaceHeader,
    reportError() {},
    request,
    resetBundlePanel() {},
    resetTaskPanel() {},
    scheduleAnimationFrame: (callback) => callback(),
    setPageTitle: (...args) => pageTitles.push(args),
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
    document,
    documentState,
    elements,
    history,
    knowledgeState,
    location,
    navigations,
    openedCards,
    openedTasks,
    operationsHomeReturns: () => operationsHomeReturns,
    pageTitles,
    refreshes,
    renderedWorkspace: () => renderedWorkspace,
    requests,
    sidebarCloses: () => sidebarCloses,
    skeleton,
    statuses,
    storageValues,
    views,
  };
}

describe("Knowledge surface boundary", () => {
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
      "restoreFiltersExpanded",
      "setFiltersExpanded",
      "setFolderUrl",
      "setSelectedFolder",
      "showLibrary",
      "syncLibraryPageTitle",
      "toggleCurrentDocPin",
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
    assert.equal(harness.skeleton.hidden, false);
    assert.deepEqual(
      harness.refreshes.map((entry) => entry.name),
      ["work", "recurring", "artifacts", "assistants", "quality"],
    );
    assert.ok(
      harness.refreshes.every((entry) => entry.options.rerender === true),
    );
    assert.equal(harness.statuses[0], "Loading documents...");

    releaseDocs({ documents });
    await loading;
    assert.equal(harness.skeleton.hidden, true);
    assert.deepEqual(harness.api.getAllDocuments(), documents);
    assert.equal(harness.api.resolveDocReference("onboarding"), documents[0]);
    assert.equal(
      harness.api.resolveDocReference("content/operations/onboarding.md"),
      documents[0],
    );
    assert.equal(harness.api.folderExists("content/operations"), true);
    assert.equal(harness.renderedWorkspace(), 1);
  });

  test("keeps empty and failed catalog truth explicit without blocking work refreshes", async () => {
    const empty = createKnowledgeHarness({
      request: async () => ({ documents: [] }),
    });
    await empty.api.loadDocuments();
    assert.deepEqual(empty.api.getAllDocuments(), []);
    assert.equal(empty.renderedWorkspace(), 1);
    assert.equal(empty.skeleton.hidden, true);

    const failed = createKnowledgeHarness({
      request: async () => {
        throw new Error("Process Docs unavailable");
      },
    });
    await failed.api.loadDocuments();
    assert.equal(failed.statuses.at(-1), "Process Docs unavailable");
    assert.deepEqual(failed.api.getAllDocuments(), []);
    assert.deepEqual(
      failed.refreshes.map((entry) => entry.name),
      ["work", "recurring", "artifacts", "assistants", "quality"],
    );
    assert.equal(failed.skeleton.hidden, true);
  });

  test("renders the Process Docs route with executable quality and reference context", () => {
    const harness = createKnowledgeHarness();
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
    assert.deepEqual(harness.pageTitles.at(-1), ["Docs", "Docs"]);
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
    assert.equal(harness.statuses.at(-1), "Process Docs ready");
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

  test("keeps the Process Docs tree and filtered list aligned", async () => {
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
    const treeFile = harness.elements.docTree.querySelector(".tree-file");
    assert.equal(treeFile.dataset.path, document.path);
    await treeFile.click();
    assert.equal(harness.documentState.currentDoc.path, document.path);
    assert.equal(harness.body.dataset.view, "editor");
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
    assert.equal(harness.statuses.at(-1), "2 search results · 1 source issues.");

    const taskRow = findAllByClass(
      harness.elements.documentList,
      "result-task",
    )[0];
    await taskRow.click();
    assert.deepEqual(harness.openedTasks, ["task-launch"]);
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
        throw new Error("Document not found");
      },
    });
    await missing.api.openDocument("content/removed.md");
    assert.equal(missing.statuses.at(-2), "Document not found");
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
