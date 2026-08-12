export function createTaskActions(context) {
  const {
    addDaysIso,
    detail,
    getActiveWorkspaceRouteToken = () => 0,
    isWorkspaceRouteFresh,
    loadArtifactsForTask,
    promptUser,
    refreshOperationsWorkSnapshot,
    renderTaskPanel,
    reportError,
    request,
    showUndoToast,
    todayIsoDate,
    workApiUrl,
  } = context;

  function createTaskActionButton(label, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "task-action-btn";
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
  }

  function defaultNextFollowUpDate() {
    return addDaysIso(todayIsoDate(), 3);
  }

  async function updateTaskStatus(taskId, status) {
    try {
      await request(workApiUrl(`/api/tasks/${encodeURIComponent(taskId)}`), {
        method: "PUT",
        body: JSON.stringify({ status }),
      });
      showUndoToast(`Task marked ${status}.`, () =>
        updateTaskStatus(taskId, status === "done" ? "todo" : "done"),
      );
      await refreshOperationsWorkSnapshot({ rerender: true });
      await refreshTaskPanel(taskId);
    } catch (err) {
      reportError(`Could not update task: ${err.message || "request failed"}`);
    }
  }

  async function refreshTaskPanel(taskId) {
    if (detail.activeTaskPanelId !== taskId) return;
    const token = getActiveWorkspaceRouteToken();
    try {
      const payload = await request(
        workApiUrl(`/api/tasks/${encodeURIComponent(taskId)}`),
      );
      if (
        payload &&
        payload.id &&
        detail.activeTaskPanelId === taskId &&
        isWorkspaceRouteFresh(token)
      ) {
        detail.activeTaskPanelTask = payload;
        const artifacts = await loadArtifactsForTask(payload);
        if (
          !isWorkspaceRouteFresh(token) ||
          detail.activeTaskPanelId !== taskId
        )
          return;
        detail.activeTaskPanelArtifacts = artifacts;
        renderTaskPanel();
      }
    } catch {
      // keep the panel as-is; snapshot already refreshed
    }
  }

  async function saveTaskLink(taskId, linkValue) {
    try {
      await request(workApiUrl(`/api/tasks/${encodeURIComponent(taskId)}`), {
        method: "PUT",
        body: JSON.stringify({ link: linkValue }),
      });
      if (detail.activeTaskPanelTask)
        detail.activeTaskPanelTask.link = linkValue;
      await refreshOperationsWorkSnapshot({ rerender: true });
    } catch (err) {
      reportError(`Could not save link: ${err.message || "request failed"}`);
    }
  }

  async function markTaskWaiting(taskId) {
    const today = todayIsoDate();
    const followUp = defaultNextFollowUpDate();
    const existing = detail.activeTaskPanelTask?.waitingFor || "";
    const waitingFor =
      existing || promptUser("Who/what are you waiting for?", "") || "";
    if (!waitingFor.trim()) {
      reportError("Waiting tasks need a 'waiting for' description.");
      return;
    }
    try {
      await request(
        workApiUrl(
          `/api/tasks/${encodeURIComponent(taskId)}/actions/mark-waiting`,
        ),
        {
          method: "POST",
          body: JSON.stringify({
            waitingFor: waitingFor.trim(),
            followUpAt: followUp,
            channel: "portal",
            note: "Marked waiting from the Task panel",
          }),
        },
      );
      await refreshOperationsWorkSnapshot({ rerender: true });
      await refreshTaskPanel(taskId);
    } catch (err) {
      reportError(
        `Could not mark task waiting: ${err.message || "request failed"}`,
      );
    }
  }

  async function recordTaskResponseReceived(taskId) {
    try {
      await request(
        workApiUrl(
          `/api/tasks/${encodeURIComponent(taskId)}/actions/response-received`,
        ),
        {
          method: "POST",
          body: JSON.stringify({
            channel: "portal",
            note: "Response received in the Task panel",
          }),
        },
      );
      await refreshOperationsWorkSnapshot({ rerender: true });
      await refreshTaskPanel(taskId);
    } catch (err) {
      reportError(
        `Could not record response: ${err.message || "request failed"}`,
      );
    }
  }

  async function recordTaskFollowUpSent(taskId, nextDate) {
    if (!nextDate) {
      reportError("Choose the next follow-up date.");
      return;
    }
    try {
      await request(
        workApiUrl(
          `/api/tasks/${encodeURIComponent(taskId)}/actions/follow-up-sent`,
        ),
        {
          method: "POST",
          body: JSON.stringify({
            nextFollowUpAt: nextDate,
            channel: "portal",
            note: "Follow-up sent from the Task panel",
          }),
        },
      );
      await refreshOperationsWorkSnapshot({ rerender: true });
      await refreshTaskPanel(taskId);
    } catch (err) {
      reportError(
        `Could not record follow-up: ${err.message || "request failed"}`,
      );
    }
  }

  // ---------- Bundle (workflow) detail panel ----------

  return {
    createTaskActionButton,
    defaultNextFollowUpDate,
    markTaskWaiting,
    recordTaskFollowUpSent,
    recordTaskResponseReceived,
    refreshTaskPanel,
    saveTaskLink,
    updateTaskStatus,
  };
}
