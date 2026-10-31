import { escapeHtml } from "../core/html.js";
import { SELF_LOADING_VIEWS } from "../shell/startup-orchestration.js";

export function createSurfaceBridge() {
  let knowledgeSurface;
  let documentEditorSurface;
  let navigationShell;

  const navigationCall = (name, args, fallback) =>
    navigationShell ? navigationShell[name](...args) : fallback;
  const knowledgeCall = (name, args) => knowledgeSurface[name](...args);
  const editorCall = (name, args) => documentEditorSurface[name](...args);
  const bridge = {
    getActiveWorkspaceRoute: (...args) =>
      navigationCall("getActiveWorkspaceRoute", args, null),
    getActiveWorkspaceRouteToken: (...args) =>
      navigationCall("getActiveWorkspaceRouteToken", args, 0),
    getPendingLegacyRoute: (...args) =>
      navigationCall("getPendingLegacyRoute", args, null),
    getWorkspaceEntityState: (...args) =>
      navigationCall("getWorkspaceEntityState", args, null),
    setWorkspaceEntityState: (...args) =>
      navigationCall("setWorkspaceEntityState", args),
    isWorkspaceRouteFresh: (...args) =>
      navigationCall("isWorkspaceRouteFresh", args, false),
    navigateCanonicalWorkspace: (...args) =>
      navigationCall("navigateCanonicalWorkspace", args),
    applyWorkspaceRoute: (...args) =>
      navigationCall("applyWorkspaceRoute", args),
    beginDocumentNavigation: (...args) =>
      navigationCall("beginDocumentNavigation", args),
    setKnowledgeSurface(surface) {
      knowledgeSurface = surface;
    },
    setDocumentEditorSurface(surface) {
      documentEditorSurface = surface;
    },
    setNavigationShell(surface) {
      navigationShell = surface;
    },
    getKnowledgeSurface: () => knowledgeSurface,
    getDocumentEditorSurface: () => documentEditorSurface,
    getNavigationShell: () => navigationShell,
  };

  for (const name of [
    "loadDocuments",
    "refreshDocuments",
    "renderDocsSurface",
    "renderProcessesSurface",
    "renderUnifiedSearchSurface",
    "resolveDocReference",
    "openDocument",
    "localDocPathFromHref",
    "docPathFromLocation",
    "folderPathFromLocation",
    "folderExists",
    "setFolderUrl",
    "showLibrary",
    "syncLibraryRouteTitle",
    "clearDocumentFilters",
    "restoreDocumentFilters",
    "humanizeOptionLabel",
    "populateFilterOptions",
    "onFilterChange",
    "updateFilterSummary",
    "openDocMenu",
    "openQuickNav",
    "labelForPath",
    "resolveMarkdownDocLink",
    "visibleDocUrl",
    "closeQuickNav",
    "updateQuickNavMatches",
  ]) {
    bridge[name] = (...args) => knowledgeCall(name, args);
  }
  for (const name of [
    "saveCurrentDocument",
    "discardDraft",
    "createDocument",
    "syncTitleToMarkdown",
    "resizeDocumentTitle",
    "storeDraft",
    "updateSaveState",
    "canLeaveDocumentEditor",
    "showCreate",
    "setSaveState",
    "titleFromMarkdown",
    "listDraftPaths",
    "refreshChangesPanel",
    "saveAllDrafts",
    "discardAllDrafts",
    "renameCurrentDoc",
    "deleteCurrentDoc",
    "refreshKnowledgeStatus",
    "openHistory",
    "closeHistory",
    "toggleViewMode",
    "enterRenderedMode",
    "updateViewToggleAvailability",
    "emptyNote",
    "escapeRegex",
    "openLintReport",
    "handleClipboardPaste",
    "closeDiff",
    "closeLightbox",
  ]) {
    bridge[name] = (...args) => editorCall(name, args);
  }
  return bridge;
}

export function createSurfaceComposition(context) {
  const {
    apiUrl,
    body,
    clearTimeoutImpl,
    dedupeWorkTasks,
    getCanLeaveDocumentEditor,
    getCanLeaveFinanceSurface,
    getKnowledgeSelectedFolder,
    getRenderAdminSurfaceView,
    getRenderBookkeepingSurface,
    getRenderFinanceOverviewSurface,
    getRenderCalendarSurface,
    getRenderDocsSurface,
    getRenderNewsletterSurface,
    getRenderOperatingModel,
    getRenderPodcastSurface,
    getRenderSponsorCrmSurface,
    getRenderTasksSurface,
    getSearchValue,
    isOpenWorkTask,
    mobileTitle,
    navigateCanonicalWorkspace,
    refreshDocuments,
    recurringConfigsFromPayload,
    request,
    searchInput,
    setTimeoutImpl,
    tasksNavSectionButtons,
    tasksFromWorkPayload,
    windowConsole,
    workspacePath,
    workspaceNavButtons,
    workspaceState,
  } = context;

  function renderOperationsWorkspace(documents) {
    // Whatever asked for this render, the surface now shows the latest data.
    context.settleBackgroundRender();
    syncWorkspaceNav();
    const view = workspaceState.activeWorkspaceView;
    if (view === "operating-model") return getRenderOperatingModel()();
    if (view === "tasks") {
      return getRenderTasksSurface()(
        documents,
        workspaceState.activeTasksSection,
      );
    }
    if (view === "docs") return getRenderDocsSurface()(documents);
    if (view === "admin") return getRenderAdminSurfaceView()(documents);
    if (view === "users") return context.getRenderUsersSurfaceView()();
    if (view === "device") return window.location.assign("/device");
    if (view === "bookkeeping") return getRenderBookkeepingSurface()();
    if (view === "finance") return getRenderFinanceOverviewSurface()();
    if (view === "sponsors") return getRenderSponsorCrmSurface()();
    if (view === "newsletter") return getRenderNewsletterSurface()();
    if (view === "calendar") return getRenderCalendarSurface()();
    if (view === "podcast") return getRenderPodcastSurface()();
    return getRenderTasksSurface()(documents, "queue");
  }

  function isOperationsWorkspaceVisible() {
    return (
      body.dataset.view === "library" &&
      !getKnowledgeSelectedFolder() &&
      !getSearchValue().trim()
    );
  }

  // Surfaces that fetch and own their data. The shared bootstrap snapshots
  // (work, recurring, quality, docs catalog) never feed them, so a snapshot
  // landing must not repaint them: the repaint would rebuild the page under
  // the operator, refetch it, and drop the tab or filter they had chosen.
  // The set itself is canonical in shell/startup-orchestration.js, shared
  // with the startup dispatch.

  // Whether what is on screen renders from the shared snapshots, so a
  // background snapshot refresh has something to repaint.
  function showsSharedSnapshots() {
    return !(
      isOperationsWorkspaceVisible() &&
      SELF_LOADING_VIEWS.has(workspaceState.activeWorkspaceView)
    );
  }

  function workApiUrl(path, params = {}) {
    const url = apiUrl(path);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    return url;
  }

  function allWorkTasks(work = workspaceState.workSnapshot) {
    return dedupeWorkTasks([
      ...tasksFromWorkPayload(work.todayTasks || []),
      ...tasksFromWorkPayload(work.overdueTasks || []),
      ...tasksFromWorkPayload(work.waitingTasks || []),
      ...Object.values(work.cardTasks || {}).flatMap((tasks) =>
        tasksFromWorkPayload(tasks),
      ),
    ]);
  }

  async function refreshOperationsRecurringSnapshot(options = {}) {
    const snapshot = context.emptyOperationsRecurringSnapshot();
    try {
      const payload = await request(workApiUrl("/api/recurring"));
      snapshot.loaded = true;
      snapshot.recurringConfigs = recurringConfigsFromPayload(payload);
    } catch (error) {
      snapshot.errors = [
        error?.message || "Recurring API request failed",
      ];
    }
    const previous = workspaceState.recurringSnapshot;
    workspaceState.recurringSnapshot =
      context.getNormalizeOperationsRecurringSnapshot()(snapshot);
    if (options.background) {
      context.renderInBackground({
        previous,
        next: workspaceState.recurringSnapshot,
        initial: !previous?.loaded,
        when: () => isOperationsWorkspaceVisible() && showsSharedSnapshots(),
      });
    } else if (options.rerender && isOperationsWorkspaceVisible()) {
      refreshDocuments();
    }
  }

  async function canLeaveCurrentDocument() {
    if (!(await getCanLeaveFinanceSurface()("navigation"))) return false;
    return getCanLeaveDocumentEditor()();
  }

  const tasksSectionByLegacyView = {
    queue: "queue",
    workflows: "workflows",
    templates: "templates",
    recurring: "recurring",
  };

  function legacyViewToTasksSection(view) {
    return tasksSectionByLegacyView[view] || null;
  }

  async function showWorkspaceSurface(view, options = {}) {
    const nextView = view || "tasks";
    if (!(await canLeaveCurrentDocument())) return undefined;
    const tasksSection = legacyViewToTasksSection(nextView);
    const path = tasksSection
      ? workspacePath("tasks", tasksSection)
      : nextView === "tasks"
        ? "/tasks"
        : workspacePath(
            nextView === "processes" || nextView === "search"
              ? "docs"
              : nextView,
          );
    return navigateCanonicalWorkspace(path, options.params || {}, {
      history:
        options.updateUrl === false
          ? "none"
          : options.replace
            ? "replace"
            : "push",
    }).ready;
  }

  function syncWorkspaceNav() {
    const activeView = workspaceState.activeWorkspaceView;
    body.dataset.workspaceView = activeView;
    searchInput.placeholder = "Search work and docs";
    for (const button of workspaceNavButtons) {
      const active = button.dataset.workspaceView === activeView;
      button.classList.toggle("is-active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
    const tasksActive = activeView === "tasks";
    for (const button of tasksNavSectionButtons) {
      const active =
        tasksActive &&
        button.dataset.tasksSection === workspaceState.activeTasksSection;
      button.classList.toggle("is-active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
  }

  function setView(view) {
    body.dataset.view = view;
  }

  function setRouteTitle(title) {
    mobileTitle.textContent = "DataOps";
    mobileTitle.title = title;
  }

  const warnedOutsideContent = new Set();
  function cleanPath(value) {
    if (!value.startsWith("content/") && !warnedOutsideContent.has(value)) {
      warnedOutsideContent.add(value);
      windowConsole.warn(`Document path outside content/: ${value}`);
    }
    return value.replace(/^content\//, "");
  }

  function basename(value) {
    return cleanPath(value)
      .split("/")
      .pop()
      .replace(/\.md$/, "")
      .replaceAll("-", " ");
  }

  function debounce(callback, delay) {
    let timeout;
    return (...args) => {
      clearTimeoutImpl(timeout);
      timeout = setTimeoutImpl(() => callback(...args), delay);
    };
  }

  return {
    allWorkTasks,
    basename,
    canLeaveCurrentDocument,
    cleanPath,
    debounce,
    escapeHtml,
    isOperationsWorkspaceVisible,
    legacyViewToTasksSection,
    refreshOperationsRecurringSnapshot,
    renderOperationsWorkspace,
    setRouteTitle,
    setView,
    showsSharedSnapshots,
    showWorkspaceSurface,
    syncWorkspaceNav,
    workApiUrl,
  };
}
