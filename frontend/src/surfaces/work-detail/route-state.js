export function createRouteState(context) {
  const {
    body,
    cardPanel,
    cardPanelBody,
    cardPanelClose,
    cardPanelTitle,
    detail,
    FOCUSABLE_SELECTOR,
    getActiveTasksSection,
    getActiveWorkspaceRoute,
    getActiveWorkspaceView,
    getAllDocuments,
    isWorkspaceRouteFresh,
    navigateCanonicalWorkspace,
    parseWorkspaceHash,
    renderCardPanel,
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
      detail.taskPanelOrigin = null;
      resetTaskPanel();
      return;
    }
    if (route.params.has("taskId")) {
      const taskId = route.params.get("taskId");
      const origin = detail.taskPanelOrigin;
      detail.taskPanelOrigin = null;
      const params = new URLSearchParams(route.params);
      params.delete("taskId");
      const target = origin || {
        path: route.path,
        params,
        restoreFocus: {
          kind: "task",
          id: taskId,
          surface:
            route.path === "/cards" || route.path === "/cards/archive"
              ? "workflows"
              : "tasks",
        },
      };
      return navigateCanonicalWorkspace(target.path, target.params, {
        restoreFocus: target.restoreFocus,
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
      : !cardPanel.hidden
        ? cardPanel.querySelector(".workflow-modal-panel")
        : null;
    if (!activePanel) return;
    if (event.key === "Escape") {
      event.preventDefault();
      if (!taskPanel.hidden) closeTaskPanel();
      else closeCardPanel();
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

  function closeCardPanel(options = {}) {
    const route = parseWorkspaceHash();
    if (
      options.updateUrl === false ||
      !route ||
      route.invalid ||
      !["/cards", "/cards/archive"].includes(route.path)
    ) {
      resetCardPanel();
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
    const cardId = route?.params.get("cardId") || "";
    return {
      date,
      cardId,
      contextCardId: route?.params.get("contextCardId") || "",
      tasks: date || cardId ? [] : null,
      filterCard: null,
      contextCard: null,
      failures: [],
    };
  }

  function resetTaskPanel() {
    detail.activeTaskPanelId = null;
    detail.activeTaskPanelTask = null;
    detail.activeTaskPanelArtifacts = [];
    detail.activeTaskPanelDraft = null;
    detail.activeTaskPanelConflict = null;
    detail.activeTaskPanelFeedback = null;
    detail.activeTaskMutationBusy = false;
    taskPanel.hidden = true;
    if (!cardPanel.hidden) {
      cardPanel.inert = false;
      cardPanel.removeAttribute("aria-hidden");
      body.classList.add("task-panel-open", "task-modal-open");
    } else {
      body.classList.remove("task-panel-open", "task-modal-open");
    }
  }

  function resetCardPanel() {
    detail.activeCardPanelId = null;
    detail.activeCardPanelData = null;
    detail.activeCardPanelDraft = null;
    detail.activeCardPanelConflict = null;
    detail.activeCardPanelFeedback = null;
    detail.activeCardMutationBusy = false;
    detail.activeCardTemplateReviewOpen = false;
    detail.activeCardTemplateBusy = false;
    detail.activeCardTemplateMessage = "";
    cardPanel.hidden = true;
    body.classList.remove("task-panel-open");
    body.classList.remove("task-modal-open");
  }

  function prepareTaskPanel(taskId) {
    if (!taskId) return;
    detail.activeTaskPanelId = taskId;
    detail.activeTaskPanelTask = null;
    detail.activeTaskPanelArtifacts = [];
    detail.activeTaskPanelDraft = null;
    detail.activeTaskPanelConflict = null;
    detail.activeTaskPanelFeedback = null;
    detail.activeTaskMutationBusy = false;
    taskPanelTitle.textContent = "Loading task...";
    taskPanelBody.replaceChildren();
    taskPanel.hidden = false;
    body.classList.add("task-panel-open", "task-modal-open");
    if (!cardPanel.hidden) {
      cardPanel.inert = true;
      cardPanel.setAttribute("aria-hidden", "true");
    }
    renderEntityLoadingState(taskPanelBody, "task", taskId);
    taskPanelClose.focus();
  }

  function prepareCardPanel(cardId) {
    if (!cardId) return;
    detail.activeCardPanelId = cardId;
    detail.activeCardPanelData = null;
    detail.activeCardPanelDraft = null;
    detail.activeCardPanelConflict = null;
    detail.activeCardPanelFeedback = null;
    detail.activeCardMutationBusy = false;
    detail.activeCardTemplateReviewOpen = false;
    detail.activeCardTemplateBusy = false;
    detail.activeCardTemplateMessage = "";
    cardPanelTitle.textContent = "Loading card...";
    cardPanelBody.replaceChildren();
    cardPanel.inert = false;
    cardPanel.removeAttribute("aria-hidden");
    cardPanel.hidden = false;
    body.classList.add("task-panel-open", "task-modal-open");
    renderEntityLoadingState(cardPanelBody, "card", cardId);
    cardPanelClose.focus();
  }

  async function resolveTaskQueueRouteContext(route, token) {
    const context = detail.taskRouteContext;
    const { date, cardId, contextCardId } = context;
    const sources = [
      cardId
        ? {
            source: "filter-card",
            id: cardId,
            load: () =>
              request(
                workApiUrl(`/api/cards/${encodeURIComponent(cardId)}`),
              ),
          }
        : null,
      date || cardId
        ? {
            source: "task-query",
            id: [date, cardId].filter(Boolean).join(" · "),
            load: () => request(workApiUrl("/api/tasks", { date, cardId })),
          }
        : null,
      contextCardId
        ? {
            source: "return-context",
            id: contextCardId,
            load: () =>
              request(
                workApiUrl(
                  `/api/cards/${encodeURIComponent(contextCardId)}`,
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
      if (entry.source === "filter-card")
        context.filterCard = result.value.card || result.value;
      else if (entry.source === "task-query")
        context.tasks = tasksFromWorkPayload(result.value);
      else context.contextCard = result.value.card || result.value;
    });
    if (
      getActiveWorkspaceView() === "tasks" &&
      getActiveTasksSection() === "queue"
    )
      renderTasksSurface(getAllDocuments(), "queue");
    if (detail.activeTaskPanelTask && isWorkspaceRouteFresh(token))
      renderTaskPanel({ preserveDrafts: true });
  }

  return {
    closeCardPanel,
    closeTaskPanel,
    handleWorkspaceEntityModalKeydown,
    prepareCardPanel,
    prepareTaskPanel,
    resetCardPanel,
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
