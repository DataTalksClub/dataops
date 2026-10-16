import { modalParamNames } from "../core/route-patterns.js";

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
    getDocsAvailability,
    getKnowledgeState,
    getTasksSectionForLegacyView,
    historyRef,
    HTMLElementClass,
    hydrateCardPanel,
    hydrateTaskPanel,
    locationRef,
    openDocument,
    parseWorkspaceLocation,
    prepareCardPanel,
    prepareTaskPanel,
    refreshDocuments,
    refreshPodcastEpisodes,
    refreshUsersSurface,
    restoreDocumentFilters,
    renderWorkspaceNav,
    requestAnimationFrameImpl,
    resetCardPanel,
    resetTaskPanel,
    resolveTaskQueueRouteContext,
    resolveTemplateRouteEntity,
    searchInput,
    setActiveTasksSection,
    setActiveWorkspaceView,
    setRuntimeTemplateRoute,
    setTaskRouteContextFromRoute,
    setView,
    showLibrary,
    workspaceRouteFor,
  } = context;
  let pendingLegacyRoute = null;
  let activeRouteToken = 0;
  let activeRoute = null;
  let workspaceEntityState = null;
  let initialRouteReady = false;
  let initialRouteReadyPromise = Promise.resolve();
  let locationRouteTimer = null;
  // What had focus when each dialog opened, so closing it hands focus back.
  const modalOpeners = { card: null, task: null };

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
    resetTaskPanel();
    resetCardPanel();
    closeWorkBellPanel({ restoreFocus: false });
  }

  function replaceWithWorkQueue() {
    const target = canonicalWorkspaceUrl("/");
    const current = `${locationRef.pathname}${locationRef.search}${
      locationRef.hash
    }`;
    if (current !== target) {
      historyRef.replaceState(
        { workspace: "tasks", tasksSection: "queue" },
        "",
        target,
      );
    }
    return parseWorkspaceLocation("/");
  }

  function visibleEntityFocusTarget(restoreFocus) {
    if (restoreFocus?.kind === "split-list") {
      // Back from a list–detail pane lands focus on the row the operator
      // came from, or the first visible row.
      const rows = [...documentRef.querySelectorAll(".dk-split__item")].filter(
        (candidate) =>
          candidate instanceof HTMLElementClass &&
          candidate.isConnected &&
          candidate.offsetParent !== null,
      );
      return (
        rows.find((candidate) => candidate.getAttribute("aria-current") === "true")
        || rows[0]
        || null
      );
    }
    if (restoreFocus?.kind === "queue-task") {
      return (
        [...documentRef.querySelectorAll(".ops-queue-row[data-task-id], .queue-task-action[data-task-id]")].find(
          (candidate) =>
            candidate.dataset.taskId === restoreFocus.id &&
            candidate.isConnected &&
            candidate.offsetParent !== null,
        ) || null
      );
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
    setRuntimeTemplateRoute(route, options.entity);
    setTaskRouteContextFromRoute(route);
    resetTaskPanel();
    resetCardPanel();
    closeWorkBellPanel({ restoreFocus: false });
    for (const overlay of documentRef.querySelectorAll(".quick-form-overlay")) {
      overlay.close();
    }
    for (const dialog of documentRef.querySelectorAll("dialog[open]")) {
      dialog.close();
    }
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
      setActiveWorkspaceView(requestedView || "tasks");
    }
    renderWorkspaceNav();
    getKnowledgeState().selectedFolder = "";
    const preserveComposer = Boolean(options.preserveDocumentComposer);
    if (!preserveComposer) searchInput.value = "";
    restoreDocumentFilters(route.params);
    setView("library");
    documentList.replaceChildren();
    refreshDocuments();
    if (!preserveComposer) closeSidebar();

    modalOpeners.card = null;
    modalOpeners.task = null;
    if (route.modalCardId) prepareCardPanel(route.modalCardId);
    if (route.modalTaskId) prepareTaskPanel(route.modalTaskId);
  }

  function hydrateWorkspaceRoute(route, token) {
    const jobs = [];
    if (route.path === "/tasks") {
      jobs.push(resolveTaskQueueRouteContext(route, token));
    }
    if (route.path === "/templates") {
      jobs.push(resolveTemplateRouteEntity(route, token));
    }
    if (route.view === "podcast" && typeof refreshPodcastEpisodes === "function") {
      jobs.push(refreshPodcastEpisodes({ rerender: true }));
    }
    if (route.path === "/users") {
      jobs.push(refreshUsersSurface({ background: true }));
    }
    if (route.modalCardId) jobs.push(hydrateCardPanel(route.modalCardId, token));
    if (route.modalTaskId) {
      jobs.push(
        hydrateTaskPanel(route.modalTaskId, token, {
          expectedCardId: route.modalCardId,
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

  // The page a route shows, without the dialogs open over it.
  function pageKey(route) {
    const params = new URLSearchParams(route.params);
    for (const name of modalParamNames(route)) params.delete(name);
    params.sort();
    return `${route.path}?${params}`;
  }

  function samePage(current, next) {
    return Boolean(current && next && pageKey(current) === pageKey(next));
  }

  function sameModals(current, next) {
    return (
      current.modalCardId === next.modalCardId &&
      current.modalTaskId === next.modalTaskId
    );
  }

  function isVisible(element) {
    return (
      element instanceof HTMLElementClass &&
      element.isConnected &&
      element.offsetParent !== null &&
      !element.closest("[inert]")
    );
  }

  // Focus goes back to what opened the dialog; when a repaint replaced it,
  // to the same row or Card drawn again; when that is gone too (a finished
  // Task left the queue), to the page heading. The page does not scroll.
  function returnModalFocus(opener, fallback, token) {
    return new Promise((resolve) => {
      requestAnimationFrameImpl(() => {
        if (isWorkspaceRouteFresh(token)) {
          const heading = documentList.querySelector("h1,h2,h3");
          const target = isVisible(opener)
            ? opener
            : visibleEntityFocusTarget(fallback) || (isVisible(heading) ? heading : null);
          if (target === heading) target.tabIndex = -1;
          target?.focus({ preventScroll: true });
        }
        resolve();
      });
    });
  }

  // Only the dialogs changed: open, close or swap them over the page, which
  // keeps its filters, scroll position and focus memory. Closing a Task over
  // its Card reloads the Card, so its checklist shows what the Task became.
  function syncWorkspaceModals(previous, route, token) {
    const jobs = [];
    const focusAfter = [];
    const opener = documentRef.activeElement;
    const cardChanged = previous.modalCardId !== route.modalCardId;
    const taskChanged = previous.modalTaskId !== route.modalTaskId;
    if (cardChanged) {
      if (route.modalCardId) {
        if (!previous.modalCardId) modalOpeners.card = opener;
        prepareCardPanel(route.modalCardId);
        jobs.push(hydrateCardPanel(route.modalCardId, token));
      } else {
        resetCardPanel();
        focusAfter.push([modalOpeners.card, { kind: "workflow", id: previous.modalCardId }]);
        modalOpeners.card = null;
      }
    } else if (route.modalCardId && taskChanged) {
      jobs.push(hydrateCardPanel(route.modalCardId, token));
    }
    if (taskChanged) {
      if (route.modalTaskId) {
        if (!previous.modalTaskId || cardChanged) modalOpeners.task = cardChanged ? null : opener;
        prepareTaskPanel(route.modalTaskId);
        jobs.push(
          hydrateTaskPanel(route.modalTaskId, token, {
            expectedCardId: route.modalCardId,
          }),
        );
      } else {
        resetTaskPanel();
        if (!cardChanged || !route.modalCardId) {
          focusAfter.unshift([
            modalOpeners.task,
            {
              kind: "task",
              id: previous.modalTaskId,
              surface: route.modalCardId ? "workflows" : "tasks",
            },
          ]);
        }
        modalOpeners.task = null;
      }
    }
    const settled = Promise.allSettled(jobs);
    const [focus] = focusAfter;
    if (!focus) return settled;
    const [element, fallback] = focus;
    if (isVisible(element)) {
      element.focus({ preventScroll: true });
      return settled;
    }
    return settled.then(() => returnModalFocus(element, fallback, token));
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
    const previous = activeRoute;
    const modalsOnly = !options.reload && samePage(previous, route);
    // Back to the address already showing (a dialog's close followed by its
    // history entry popping) changes nothing.
    if (modalsOnly && sameModals(previous, route)) {
      activeRoute = route;
      return { route, token: activeRouteToken, ready: Promise.resolve() };
    }
    const token = ++activeRouteToken;
    const visible = route.canonicalUrl;
    const current = `${locationRef.pathname}${locationRef.search}${
      locationRef.hash
    }`;
    const historyMode = options.history || "push";
    // Closing a dialog that was opened on this page goes back one entry, so
    // Back afterwards leaves the page instead of reopening the dialog.
    const returnsToPage =
      modalsOnly &&
      historyMode === "push" &&
      historyRef.state?.modalReturn === visible;
    if (returnsToPage) {
      historyRef.back();
    } else if (historyMode !== "none" && current !== visible) {
      historyRef[historyMode === "replace" ? "replaceState" : "pushState"](
        {
          workspace: route.view,
          tasksSection: route.tasksSection,
          ...(options.restoreFocus ? { restoreFocus: options.restoreFocus } : {}),
          ...(modalsOnly && historyMode === "push" ? { modalReturn: current } : {}),
        },
        "",
        visible,
      );
    }
    if (modalsOnly) {
      activeRoute = route;
      return { route, token, ready: syncWorkspaceModals(previous, route, token) };
    }
    // A surface that already shows the entity (a list–detail selection opened
    // in place) only records it: the URL and the active route move, nothing
    // re-renders. Back/Forward still re-render through applyWorkspaceRoute.
    if (options.render === false) {
      activeRoute = route;
      return { route, token, ready: Promise.resolve() };
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
      restoreFocus: historyRef.state?.restoreFocus,
    }).ready;
  }

  function readCurrentWorkspaceRoute() {
    const pathRoute = parseWorkspaceLocation(locationRef.pathname || "/");
    // Document and folder paths need their content catalog before opening.
    if (pathRoute.invalid) return null;
    return parseWorkspaceLocation();
  }

  async function openInitialRoute() {
    const workspaceRoute = readCurrentWorkspaceRoute();
    if (workspaceRoute && !workspaceRoute.invalid) {
      if (workspaceRoute.normalized) {
        historyRef.replaceState(
          historyRef.state,
          "",
          workspaceRoute.canonicalUrl,
        );
      }
      await applyWorkspaceRoute(workspaceRoute);
      return;
    }
    if (workspaceRoute || (!context.docPathFromLocation() && !folderExists(folderPathFromLocation()))) {
      await applyWorkspaceRoute(replaceWithWorkQueue());
      return;
    }
    const docPath = context.docPathFromLocation();
    if (docPath) {
      const exists = getKnowledgeState().allDocuments.some(
        (doc) => doc.path === docPath,
      );
      // During a docs outage the catalog is empty for every document, so a
      // bookmarked document URL must still open the editor: it reports the
      // outage there instead of silently dropping the operator on the queue.
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
    await navigateCanonicalWorkspace("/").ready;
  }

  async function applyCurrentBrowserLocation() {
    const workspaceRoute = readCurrentWorkspaceRoute();
    if (workspaceRoute && !workspaceRoute.invalid) {
      if (workspaceRoute.normalized) {
        historyRef.replaceState(
          historyRef.state,
          "",
          workspaceRoute.canonicalUrl,
        );
      }
      await applyWorkspaceRoute(workspaceRoute);
      return;
    }
    if (workspaceRoute || (!context.docPathFromLocation() && !folderExists(folderPathFromLocation()))) {
      await applyWorkspaceRoute(replaceWithWorkQueue());
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
      readCurrentWorkspaceRoute()
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
