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

  // Closing a dialog drops its params from the page's address; the page
  // under it stays as it was.
  function closeModal(route, names) {
    const params = new URLSearchParams(route.params);
    for (const name of names) params.delete(name);
    return navigateCanonicalWorkspace(route.path, params).ready;
  }

  function closeTaskPanel(options = {}) {
    const route = getActiveWorkspaceRoute();
    if (options.updateUrl === false || !route?.modalTaskId) {
      resetTaskPanel();
      return;
    }
    return closeModal(route, ["taskId"]);
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
      ...activePanel.querySelectorAll(`${FOCUSABLE_SELECTOR}, summary`),
    ].filter((el) => {
      if (el.offsetParent === null) return false;
      let child = el;
      for (let parent = el.parentElement; parent; parent = parent.parentElement) {
        if (parent.tagName === "DETAILS" && !parent.open && child.tagName !== "SUMMARY") {
          return false;
        }
        child = parent;
      }
      return true;
    });
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
    const route = getActiveWorkspaceRoute();
    if (options.updateUrl === false || !route?.modalCardId) {
      resetCardPanel();
      return;
    }
    return closeModal(route, [route.cardParam, "taskId"]);
  }

  // While a dialog is open the page behind it is inert: every sibling on the
  // way up to the app shell, so the toast and kit dialogs outside it stay
  // usable.
  let inertPage = [];
  function syncPageInert() {
    for (const element of inertPage) element.inert = false;
    inertPage = [];
    if (cardPanel.hidden && taskPanel.hidden) return;
    const modals = new Set([cardPanel, taskPanel]);
    for (
      let node = cardPanel;
      node.parentElement && node.parentElement !== body;
      node = node.parentElement
    ) {
      for (const sibling of node.parentElement.children) {
        if (sibling === node || modals.has(sibling) || sibling.inert) continue;
        sibling.inert = true;
        inertPage.push(sibling);
      }
    }
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
    syncPageInert();
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
    if (taskPanel.hidden) body.classList.remove("task-panel-open", "task-modal-open");
    syncPageInert();
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
    syncPageInert();
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
    syncPageInert();
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
