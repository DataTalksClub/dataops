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
    "enhanceSelect",
    "humanizeOptionLabel",
    "populateFilterOptions",
    "updateCustomSelect",
    "closeCustomSelects",
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
    getRenderCalendarSurface,
    getRenderDocsSurface,
    getRenderNewsletterSurface,
    getRenderOperatingModel,
    getRenderReviewSurface,
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
    workspaceHashPath,
    workspaceNavButtons,
    workspaceState,
  } = context;

  function renderOperationsWorkspace(documents) {
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
    if (view === "device") return context.getRenderDeviceSurfaceView()();
    if (view === "bookkeeping") return getRenderBookkeepingSurface()();
    if (view === "sponsors") return getRenderSponsorCrmSurface()();
    if (view === "newsletter") return getRenderNewsletterSurface()();
    if (view === "calendar") return getRenderCalendarSurface()();
    if (view === "review") return getRenderReviewSurface()(documents);
    return getRenderTasksSurface()(documents, "queue");
  }

  function isOperationsWorkspaceVisible() {
    return (
      body.dataset.view === "library" &&
      !getKnowledgeSelectedFolder() &&
      !getSearchValue().trim()
    );
  }

  function workApiUrl(path, params = {}) {
    const url = apiUrl(`/work${path}`);
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
    workspaceState.recurringSnapshot =
      context.getNormalizeOperationsRecurringSnapshot()(snapshot);
    if (options.rerender && isOperationsWorkspaceVisible()) refreshDocuments();
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
    assistants: "assistants",
  };

  function legacyViewToTasksSection(view) {
    return tasksSectionByLegacyView[view] || null;
  }

  async function showWorkspaceSurface(view, options = {}) {
    const nextView = view || "tasks";
    if (!(await canLeaveCurrentDocument())) return undefined;
    const tasksSection = legacyViewToTasksSection(nextView);
    const path = tasksSection
      ? workspaceHashPath("tasks", tasksSection)
      : nextView === "tasks"
        ? "/tasks"
        : workspaceHashPath(
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
    mobileTitle.textContent = title;
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

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
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
    showWorkspaceSurface,
    syncWorkspaceNav,
    workApiUrl,
  };
}
