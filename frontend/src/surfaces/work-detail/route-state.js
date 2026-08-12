export function createRouteState(context) {
  const {
    body,
    bundlePanel,
    bundlePanelBody,
    bundlePanelClose,
    bundlePanelTitle,
    detail,
    FOCUSABLE_SELECTOR,
    getActiveTasksSection,
    getActiveWorkspaceRoute,
    getActiveWorkspaceView,
    getAllDocuments,
    isWorkspaceRouteFresh,
    navigateCanonicalWorkspace,
    parseWorkspaceHash,
    renderBundlePanel,
    renderEntityLoadingState,
    renderTaskPanel,
    renderTasksSurface,
    request,
    taskPanel,
    taskPanelBody,
    taskPanelClose,
    taskPanelTitle,
    tasksFromWorkPayload,
    workApiUrl,
  } = context;

  function closeTaskPanel(options = {}) {
    const route = parseWorkspaceHash();
    if (
      options.updateUrl === false ||
      !route ||
      route.invalid ||
      !route.params.has("taskId")
    ) {
      resetTaskPanel();
      return;
    }
    if (route.params.has("taskId")) {
      const taskId = route.params.get("taskId");
      const params = new URLSearchParams(route.params);
      params.delete("taskId");
      return navigateCanonicalWorkspace(route.path, params, {
        restoreFocus: {
          kind: "task",
          id: taskId,
          surface:
            route.path === "/cards" || route.path === "/cards/archive"
              ? "workflows"
              : "tasks",
        },
      }).ready;
    }
  }

  // Task detail can sit above workflow detail, so one handler selects the
  // top-most entity dialog. This prevents one Escape event from closing both
  // canonical route layers and keeps Tab/Shift+Tab inside the active dialog.

  function handleWorkspaceEntityModalKeydown(event) {
    if (event.defaultPrevented) return;
    const activePanel = !taskPanel.hidden
      ? taskPanel.querySelector(".task-modal-panel")
      : !bundlePanel.hidden
        ? bundlePanel.querySelector(".workflow-modal-panel")
        : null;
    if (!activePanel) return;
    if (event.key === "Escape") {
      event.preventDefault();
      if (!taskPanel.hidden) closeTaskPanel();
      else closeBundlePanel();
      return;
    }
    if (event.key !== "Tab") return;
    const focusables = [
      ...activePanel.querySelectorAll(FOCUSABLE_SELECTOR),
    ].filter((el) => el.offsetParent !== null);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !activePanel.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (
      !event.shiftKey &&
      (active === last || !activePanel.contains(active))
    ) {
      event.preventDefault();
      first.focus();
    }
  }

  function closeBundlePanel(options = {}) {
    const route = parseWorkspaceHash();
    if (
      options.updateUrl === false ||
      !route ||
      route.invalid ||
      !["/cards", "/cards/archive"].includes(route.path)
    ) {
      resetBundlePanel();
      return;
    }
    return navigateCanonicalWorkspace(
      route.path,
      {},
      {
        restoreFocus: {
          kind: "workflow",
          id: route.params.get("cardId"),
          surface: "workflows",
        },
      },
    ).ready;
  }

  function emptyTaskRouteContext(route = null) {
    const date = route?.params.get("date") || "";
    const bundleId = route?.params.get("bundleId") || "";
    return {
      date,
      bundleId,
      contextBundleId: route?.params.get("contextBundleId") || "",
      tasks: date || bundleId ? [] : null,
      filterBundle: null,
      contextBundle: null,
      failures: [],
    };
  }

  function resetTaskPanel() {
    detail.activeTaskPanelId = null;
    detail.activeTaskPanelTask = null;
    detail.activeTaskPanelArtifacts = [];
    taskPanel.hidden = true;
    if (!bundlePanel.hidden) {
      bundlePanel.inert = false;
      bundlePanel.removeAttribute("aria-hidden");
      body.classList.add("task-panel-open", "task-modal-open");
    } else {
      body.classList.remove("task-panel-open", "task-modal-open");
    }
  }

  function resetBundlePanel() {
    detail.activeBundlePanelId = null;
    detail.activeBundlePanelData = null;
    bundlePanel.hidden = true;
    body.classList.remove("task-panel-open");
    body.classList.remove("task-modal-open");
  }

  function prepareTaskPanel(taskId) {
    if (!taskId) return;
    detail.activeTaskPanelId = taskId;
    detail.activeTaskPanelTask = null;
    detail.activeTaskPanelArtifacts = [];
    taskPanelTitle.textContent = "Loading task...";
    taskPanelBody.replaceChildren();
    taskPanel.hidden = false;
    body.classList.add("task-panel-open", "task-modal-open");
    if (!bundlePanel.hidden) {
      bundlePanel.inert = true;
      bundlePanel.setAttribute("aria-hidden", "true");
    }
    renderEntityLoadingState(taskPanelBody, "task", taskId);
    taskPanelClose.focus();
  }

  function prepareBundlePanel(bundleId) {
    if (!bundleId) return;
    detail.activeBundlePanelId = bundleId;
    detail.activeBundlePanelData = null;
    bundlePanelTitle.textContent = "Loading card...";
    bundlePanelBody.replaceChildren();
    bundlePanel.inert = false;
    bundlePanel.removeAttribute("aria-hidden");
    bundlePanel.hidden = false;
    body.classList.add("task-panel-open", "task-modal-open");
    renderEntityLoadingState(bundlePanelBody, "card", bundleId);
    bundlePanelClose.focus();
  }

  async function resolveTaskQueueRouteContext(route, token) {
    const context = detail.taskRouteContext;
    const { date, bundleId, contextBundleId } = context;
    const sources = [
      bundleId
        ? {
            source: "filter-bundle",
            id: bundleId,
            load: () =>
              request(
                workApiUrl(`/api/bundles/${encodeURIComponent(bundleId)}`),
              ),
          }
        : null,
      date || bundleId
        ? {
            source: "task-query",
            id: [date, bundleId].filter(Boolean).join(" · "),
            load: () => request(workApiUrl("/api/tasks", { date, bundleId })),
          }
        : null,
      contextBundleId
        ? {
            source: "return-context",
            id: contextBundleId,
            load: () =>
              request(
                workApiUrl(
                  `/api/bundles/${encodeURIComponent(contextBundleId)}`,
                ),
              ),
          }
        : null,
    ].filter(Boolean);
    const results = await Promise.allSettled(
      sources.map((entry) => entry.load()),
    );
    if (!isWorkspaceRouteFresh(token) || detail.taskRouteContext !== context)
      return;
    results.forEach((result, index) => {
      const entry = sources[index];
      if (result.status === "rejected") {
        context.failures.push({
          source: entry.source,
          id: entry.id,
          status: result.reason?.status === 404 ? "not-found" : "error",
          error: result.reason?.message || "Request failed",
        });
        return;
      }
      if (entry.source === "filter-bundle")
        context.filterBundle = result.value.bundle || result.value;
      else if (entry.source === "task-query")
        context.tasks = tasksFromWorkPayload(result.value);
      else context.contextBundle = result.value.bundle || result.value;
    });
    if (
      getActiveWorkspaceView() === "tasks" &&
      getActiveTasksSection() === "queue"
    )
      renderTasksSurface(getAllDocuments(), "queue");
    if (detail.activeTaskPanelTask && isWorkspaceRouteFresh(token))
      renderTaskPanel();
  }

  return {
    closeBundlePanel,
    closeTaskPanel,
    handleWorkspaceEntityModalKeydown,
    prepareBundlePanel,
    prepareTaskPanel,
    resetBundlePanel,
    resetTaskPanel,
    resolveTaskQueueRouteContext,
    setTaskRouteContextFromRoute: (route) => {
      detail.taskRouteContext =
        route?.path === "/tasks"
          ? emptyTaskRouteContext(route)
          : emptyTaskRouteContext();
    },
  };
}
