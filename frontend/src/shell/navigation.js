export function createNavigationShell(context) {
  const {
    canLeaveCurrentDocument,
    canonicalWorkspaceUrl,
    closeSettingsMenu,
    closeSidebar,
    closeWorkBellPanel,
    documentList,
    documentRef,
    folderExists,
    folderPathFromLocation,
    getAssistantQueueState,
    getDocsAvailability,
    getIntakeSurfaceState,
    getKnowledgeState,
    getTasksSectionForLegacyView,
    historyRef,
    HTMLElementClass,
    hydrateCardPanel,
    hydrateTaskPanel,
    libraryTitle,
    locationRef,
    openDocument,
    openWorkBellPanel,
    operationsViewTitle,
    parseWorkspaceHash,
    prepareCardPanel,
    prepareTaskPanel,
    refreshDocuments,
    refreshOperationsArtifactSnapshot,
    refreshOperationsAssistantSnapshot,
    refreshUsersSurface,
    refreshWorkBell,
    restoreDocumentFilters,
    renderWorkspaceNav,
    requestAnimationFrameImpl,
    resetCardPanel,
    resetTaskPanel,
    resolveIntakeRouteEntity,
    resolveTaskQueueRouteContext,
    resolveTemplateRouteEntity,
    searchInput,
    setActiveTasksSection,
    setActiveWorkspaceView,
    setRuntimeTemplateRoute,
    setTaskRouteContextFromRoute,
    setView,
    showLibrary,
    showOperationsHome,
    workspaceRouteFor,
  } = context;
  let pendingLegacyRoute = null;
  let activeRouteToken = 0;
  let activeRoute = null;
  let workspaceEntityState = null;
  let initialRouteReady = false;
  let initialRouteReadyPromise = Promise.resolve();
  let locationRouteTimer = null;

  function getActiveWorkspaceRoute() {
    return activeRoute;
  }

  function getActiveWorkspaceRouteToken() {
    return activeRouteToken;
  }

  function getPendingLegacyRoute() {
    return pendingLegacyRoute;
  }

  function getWorkspaceEntityState() {
    return workspaceEntityState;
  }

  function setWorkspaceEntityState(snapshot) {
    workspaceEntityState = snapshot;
  }

  function isWorkspaceRouteFresh(token) {
    return token === activeRouteToken;
  }

  function beginDocumentNavigation() {
    activeRouteToken += 1;
    activeRoute = null;
    clearIntakeDraftForRoute(null);
    resetTaskPanel();
    resetCardPanel();
    closeWorkBellPanel({ updateUrl: false, restoreFocus: false });
  }

  function replaceWithWorkspaceHome() {
    const target = canonicalWorkspaceUrl("/");
    const current = `${locationRef.pathname}${locationRef.search}${
      locationRef.hash
    }`;
    if (current !== target) {
      historyRef.replaceState(
        { workspace: "home", tasksSection: "queue" },
        "",
        target,
      );
    }
    return parseWorkspaceHash("#/");
  }

  function visibleEntityFocusTarget(restoreFocus) {
    if (restoreFocus?.kind === "runtime-template-list") {
      const search = documentRef.querySelector(".runtime-template-search");
      return search instanceof HTMLElementClass &&
        search.isConnected &&
        search.offsetParent !== null
        ? search
        : null;
    }
    if (!restoreFocus?.id) return null;
    const candidates =
      restoreFocus.kind === "workflow"
        ? [
            ...documentRef.querySelectorAll(
              ".ops-workflow-card[data-card-id]",
            ),
          ]
        : restoreFocus.surface === "workflows"
          ? [
              ...documentRef.querySelectorAll(
                ".card-checklist-label[data-task-id]",
              ),
            ]
          : [
              ...documentRef.querySelectorAll(
                ".ops-queue-row[data-task-id]",
              ),
            ];
    const dataKey = restoreFocus.kind === "workflow" ? "cardId" : "taskId";
    return (
      candidates.find(
        (candidate) =>
          candidate.dataset[dataKey] === restoreFocus.id &&
          candidate.isConnected &&
          candidate.offsetParent !== null,
      ) || null
    );
  }

  function restoreWorkspaceEntityFocus(restoreFocus, token) {
    return new Promise((resolve) => {
      requestAnimationFrameImpl(() => {
        if (!isWorkspaceRouteFresh(token)) {
          resolve();
          return;
        }
        const routeHeading = documentList.querySelector("h1,h2,h3");
        const activeRouteControl = documentRef.querySelector(
          ".workspace-nav-button.is-active, .ops-subnav-tab.is-active",
        );
        const visibleFallbacks = [
          libraryTitle,
          routeHeading,
          activeRouteControl,
        ].filter(
          (candidate) =>
            candidate instanceof HTMLElementClass &&
            candidate.isConnected &&
            candidate.offsetParent !== null,
        );
        const target =
          visibleEntityFocusTarget(restoreFocus) || visibleFallbacks[0] || null;
        if (visibleFallbacks.includes(target)) target.tabIndex = -1;
        if (target instanceof HTMLElementClass && target.isConnected) {
          target.focus();
        }
        resolve();
      });
    });
  }

  function commitWorkspaceRoute(route, token, options = {}) {
    activeRoute = route;
    pendingLegacyRoute = { ...route, token };
    workspaceEntityState = null;
    if (route.view === "tasks") setActiveTasksSection(route.tasksSection);
    clearIntakeDraftForRoute(route);
    getIntakeSurfaceState().intake.selectedId =
      route.path === "/inbox" ? route.params.get("intakeId") : null;
    getAssistantQueueState().selectedJobId =
      route.tasksSection === "assistants"
        ? route.params.get("assistantJobId")
        : null;
    setRuntimeTemplateRoute(route, options.entity);
    setTaskRouteContextFromRoute(route);
    resetTaskPanel();
    resetCardPanel();
    closeWorkBellPanel({ updateUrl: false, restoreFocus: false });
    closeSettingsMenu();

    const requestedView =
      route.view === "tasks" && route.tasksSection !== "queue"
        ? route.tasksSection
        : route.view;
    const tasksSection = getTasksSectionForLegacyView(requestedView);
    if (tasksSection) {
      setActiveWorkspaceView("tasks");
      setActiveTasksSection(tasksSection);
    } else if (requestedView === "tasks") {
      setActiveWorkspaceView("tasks");
      setActiveTasksSection("queue");
    } else if (requestedView === "processes" || requestedView === "search") {
      setActiveWorkspaceView("docs");
    } else {
      setActiveWorkspaceView(requestedView || "home");
    }
    const { activeWorkspaceView, activeTasksSection } = renderWorkspaceNav();
    libraryTitle.textContent = operationsViewTitle(
      activeWorkspaceView,
      activeTasksSection,
    );
    getKnowledgeState().selectedFolder = "";
    const preserveComposer = Boolean(options.preserveDocumentComposer);
    if (!preserveComposer) searchInput.value = "";
    restoreDocumentFilters(route.params);
    setView("library");
    documentList.replaceChildren();
    refreshDocuments();
    if (!preserveComposer) closeSidebar();

    const cardId = ["/cards", "/cards/archive"].includes(route.path)
      ? route.params.get("cardId")
      : "";
    const taskId = route.params.get("taskId");
    if (cardId) prepareCardPanel(cardId);
    if (taskId) prepareTaskPanel(taskId);
    if (route.path === "/notifications") openWorkBellPanel();
  }

  function clearIntakeDraftForRoute(route) {
    const intakeState = getIntakeSurfaceState();
    const mutation = intakeState.intakeMutation;
    const assistantMutation = intakeState.assistantMutation;
    if (
      assistantMutation?.target &&
      assistantMutation.routeToken !== undefined &&
      assistantMutation.routeToken !== activeRouteToken
    ) {
      intakeState.assistantMutation = {
        target: "",
        action: "",
        values: {},
        error: "",
        busy: false,
        status: "",
        phase: "idle",
        routeToken: activeRouteToken,
      };
    }
    if (!mutation.itemId) return;
    const nextItemId =
      route?.path === "/inbox" ? route.params.get("intakeId") : null;
    if (nextItemId === mutation.itemId) return;
    intakeState.intakeMutation = {
      itemId: "",
      action: "",
      values: {},
      focus: null,
      error: "",
      busy: false,
      status: "",
      phase: "idle",
      routeToken: activeRouteToken,
    };
  }

  function hydrateWorkspaceRoute(route, token) {
    const jobs = [];
    if (route.path === "/inbox") {
      jobs.push(resolveIntakeRouteEntity(route, token));
    }
    if (route.path === "/tasks") {
      jobs.push(resolveTaskQueueRouteContext(route, token));
    }
    if (route.path === "/templates") {
      jobs.push(resolveTemplateRouteEntity(route, token));
    }
    if (route.path === "/assistants") {
      jobs.push(refreshOperationsAssistantSnapshot({ rerender: true, token }));
    }
    if (route.path === "/notifications") jobs.push(refreshWorkBell({ token }));
    if (route.path === "/artifacts") {
      jobs.push(refreshOperationsArtifactSnapshot({ rerender: true }));
    }
    if (route.path === "/users") {
      jobs.push(refreshUsersSurface({ rerender: true }));
    }
    const cardId = ["/cards", "/cards/archive"].includes(route.path)
      ? route.params.get("cardId")
      : "";
    const taskId = route.params.get("taskId");
    if (cardId) jobs.push(hydrateCardPanel(cardId, token));
    if (taskId) {
      jobs.push(
        hydrateTaskPanel(taskId, token, {
          expectedCardId: cardId || "",
        }),
      );
    }
    if (route.path === "/recurring") {
      requestAnimationFrameImpl(() => {
        if (!isWorkspaceRouteFresh(token)) return;
        const recurring = documentRef.querySelector(".ops-recurring-section");
        if (recurring) {
          recurring.tabIndex = -1;
          recurring.focus();
        }
      });
    }
    return Promise.allSettled(jobs);
  }

  function activateDocumentWorkspace() {
    setActiveWorkspaceView("docs");
    renderWorkspaceNav();
  }

  function navigateCanonicalWorkspace(path, params = {}, options = {}) {
    const route = options.route || workspaceRouteFor(path, params);
    if (!route || route.invalid) {
      return {
        route,
        token: activeRouteToken,
        ready: Promise.resolve(),
      };
    }
    const token = ++activeRouteToken;
    const visible = route.canonicalUrl;
    const current = `${locationRef.pathname}${locationRef.search}${
      locationRef.hash
    }`;
    const historyMode = options.history || "push";
    if (historyMode !== "none" && current !== visible) {
      historyRef[historyMode === "replace" ? "replaceState" : "pushState"](
        { workspace: route.view, tasksSection: route.tasksSection },
        "",
        visible,
      );
    }
    commitWorkspaceRoute(route, token, options);
    const hydration =
      options.hydrate === false
        ? Promise.resolve()
        : hydrateWorkspaceRoute(route, token);
    const ready = hydration.then(() =>
      options.restoreFocus
        ? restoreWorkspaceEntityFocus(options.restoreFocus, token)
        : undefined,
    );
    return { route, token, ready };
  }

  async function applyWorkspaceRoute(route) {
    if (!route || route.invalid) return;
    const previousRoute = activeRoute;
    if (initialRouteReady && !(await canLeaveCurrentDocument())) {
      if (previousRoute?.canonicalUrl) {
        historyRef.replaceState(
          {
            workspace: previousRoute.view,
            tasksSection: previousRoute.tasksSection,
          },
          "",
          previousRoute.canonicalUrl,
        );
      }
      return;
    }
    await navigateCanonicalWorkspace(route.path, route.params, {
      route,
      history: "none",
    }).ready;
  }

  async function openInitialRoute() {
    let workspaceRoute = parseWorkspaceHash();
    if (workspaceRoute && !workspaceRoute.invalid) {
      if (workspaceRoute.normalized) {
        historyRef.replaceState(
          historyRef.state,
          "",
          workspaceRoute.canonicalUrl,
        );
        workspaceRoute = parseWorkspaceHash();
      }
      await applyWorkspaceRoute(workspaceRoute);
      return;
    }
    if (locationRef.hash || locationRef.pathname === "/") {
      await applyWorkspaceRoute(replaceWithWorkspaceHome());
      return;
    }
    const docPath = context.docPathFromLocation();
    if (docPath) {
      const exists = getKnowledgeState().allDocuments.some(
        (doc) => doc.path === docPath,
      );
      // During a docs outage the catalog is empty for every document, so a
      // bookmarked document URL must still open the editor: it reports the
      // outage there instead of silently dropping the operator on Home.
      const docsUnavailable = getDocsAvailability().state === "unavailable";
      if (exists || docsUnavailable) {
        activateDocumentWorkspace();
        await openDocument(docPath, {
          updateUrl: false,
        });
      }
      return;
    }
    const folderPath = folderPathFromLocation();
    if (folderPath && folderExists(folderPath)) {
      getKnowledgeState().selectedFolder = folderPath;
      showLibrary({ updateUrl: false });
      refreshDocuments();
      return;
    }
    await showOperationsHome({ replace: true });
  }

  async function applyCurrentBrowserLocation() {
    let workspaceRoute = parseWorkspaceHash();
    if (workspaceRoute && !workspaceRoute.invalid) {
      if (workspaceRoute.normalized) {
        historyRef.replaceState(
          historyRef.state,
          "",
          workspaceRoute.canonicalUrl,
        );
        workspaceRoute = parseWorkspaceHash();
      }
      await applyWorkspaceRoute(workspaceRoute);
      return;
    }
    if (locationRef.hash || locationRef.pathname === "/") {
      await applyWorkspaceRoute(replaceWithWorkspaceHome());
      return;
    }
    const docPath = context.docPathFromLocation();
    if (docPath) {
      activateDocumentWorkspace();
      openDocument(docPath, { updateUrl: false });
      return;
    }
    getKnowledgeState().selectedFolder = folderPathFromLocation();
    showLibrary({ updateUrl: false });
    refreshDocuments();
  }

  function scheduleCurrentBrowserLocation() {
    if (!initialRouteReady) {
      initialRouteReadyPromise.then(scheduleCurrentBrowserLocation);
      return;
    }
    if (locationRouteTimer) clearTimeout(locationRouteTimer);
    locationRouteTimer = setTimeout(() => {
      locationRouteTimer = null;
      applyCurrentBrowserLocation();
    }, 0);
  }

  function initializeRouting(documentsReady) {
    initialRouteReadyPromise = Promise.resolve().then(() =>
      locationRef.hash || locationRef.pathname === "/"
        ? openInitialRoute()
        : documentsReady.then(openInitialRoute),
    );
    initialRouteReadyPromise.then(() => {
      initialRouteReady = true;
    });
    return initialRouteReadyPromise;
  }

  return {
    applyWorkspaceRoute,
    beginDocumentNavigation,
    getActiveWorkspaceRoute,
    getActiveWorkspaceRouteToken,
    getPendingLegacyRoute,
    getWorkspaceEntityState,
    initializeRouting,
    isWorkspaceRouteFresh,
    navigateCanonicalWorkspace,
    scheduleCurrentBrowserLocation,
    setWorkspaceEntityState,
  };
}
