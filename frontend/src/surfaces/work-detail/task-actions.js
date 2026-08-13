import { isCanonicalWorkTask } from "../../core/workspace.js";

export function createTaskActions(context) {
  const {
    addDaysIso,
    detail,
    getActiveWorkspaceRouteToken = () => 0,
    isArchivedWorkCard,
    isWorkspaceRouteFresh,
    loadArtifactsForTask,
    navigateCanonicalWorkspace,
    promptUser,
    refreshOperationsWorkSnapshot,
    renderTaskPanel,
    reportError,
    request,
    showUndoToast,
    state,
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

  function displayedVersion(taskId, explicitVersion) {
    const version =
      explicitVersion ??
      (detail.activeTaskPanelTask?.id === taskId
        ? detail.activeTaskPanelTask.version
        : undefined);
    if (!Number.isInteger(version) || version < 1) {
      throw new Error("Reload this Task before changing it.");
    }
    return version;
  }

  async function submitTaskIntent(intent, expectedVersion) {
    if (detail.activeTaskMutationBusy) return null;
    const isActiveTask = detail.activeTaskPanelId === intent.taskId;
    if (isActiveTask) {
      detail.activeTaskPanelDraft = intent;
      detail.activeTaskMutationBusy = true;
      renderTaskPanel();
    }
    try {
      const updated = await request(workApiUrl(intent.path), {
        method: intent.method,
        body: JSON.stringify({ ...intent.payload, expectedVersion }),
      });
      if (!isCanonicalWorkTask(updated)) {
        throw new Error("Task response is not in the canonical versioned shape");
      }
      if (isActiveTask && updated?.id === intent.taskId) {
        detail.activeTaskPanelTask = updated;
        detail.activeTaskPanelDraft = null;
        detail.activeTaskPanelConflict = null;
        detail.activeTaskMutationBusy = false;
        renderTaskPanel();
      }
      await refreshOperationsWorkSnapshot({ rerender: true });
      return updated;
    } catch (err) {
      if (
        isActiveTask &&
        err?.status === 409 &&
        ["task_version_conflict", "card_lifecycle_conflict"].includes(err?.code) &&
        err?.payload?.currentTask?.id === intent.taskId
      ) {
        if (!isCanonicalWorkTask(err.payload.currentTask)) {
          detail.activeTaskMutationBusy = false;
          renderTaskPanel();
          throw new Error("Conflict response is missing the canonical current Task");
        }
        detail.activeTaskPanelConflict = err.payload;
        detail.activeTaskMutationBusy = false;
        renderTaskPanel();
        return null;
      }
      if (isActiveTask) {
        detail.activeTaskMutationBusy = false;
        renderTaskPanel();
      }
      reportError(`${intent.errorPrefix}: ${err.message || "request failed"}`);
      return null;
    }
  }

  async function handleTaskStatusSuccess(taskId, status, updated) {
    if (!updated?.version) return;
    let card = null;
    if (updated.cardId) {
      const payload = await request(
        workApiUrl(`/api/cards/${encodeURIComponent(updated.cardId)}`),
      );
      card = payload?.card || payload;
    }
    if (
      card
      && (
        detail.activeTaskPanelId === taskId
        || detail.activeCardPanelId === card.id
      )
    ) {
      const archived = isArchivedWorkCard(card);
      const route = archived ? "/cards/archive" : "/cards";
      await navigateCanonicalWorkspace(route, {
        cardId: card.id,
        taskId,
      }).ready;
      if (!archived && status !== "done") {
        showUndoToast(
          `Task reopened. Card restored to ${String(card.stage).replace("-", " ")}.`,
          () => updateTaskStatus(taskId, "done", updated.version),
        );
        return;
      }
    }
    showUndoToast(`Task marked ${status}.`, () =>
      updateTaskStatus(
        taskId,
        status === "done" ? "todo" : "done",
        updated.version,
      ),
    );
  }

  async function updateTaskStatus(taskId, status, explicitVersion) {
    try {
      const updated = await submitTaskIntent(
        {
          taskId,
          kind: "status",
          label: `Set status to ${status}`,
          method: "PUT",
          path: `/api/tasks/${encodeURIComponent(taskId)}`,
          payload: { status },
          errorPrefix: "Could not update task",
        },
        displayedVersion(taskId, explicitVersion),
      );
      await handleTaskStatusSuccess(taskId, status, updated);
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

  async function saveTaskLink(taskId, linkValue, explicitVersion) {
    try {
      await submitTaskIntent(
        {
          taskId,
          kind: "link",
          label: `Save link: ${linkValue}`,
          method: "PUT",
          path: `/api/tasks/${encodeURIComponent(taskId)}`,
          payload: { link: linkValue },
          errorPrefix: "Could not save link",
        },
        displayedVersion(taskId, explicitVersion),
      );
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
      await submitTaskIntent(
        {
          taskId,
          kind: "mark-waiting",
          label: `Mark waiting for ${waitingFor.trim()}; follow up ${followUp}`,
          method: "POST",
          path: `/api/tasks/${encodeURIComponent(taskId)}/actions/mark-waiting`,
          payload: {
            waitingFor: waitingFor.trim(),
            followUpAt: followUp,
            channel: "portal",
            note: "Marked waiting from the Task panel",
          },
          errorPrefix: "Could not mark task waiting",
        },
        displayedVersion(taskId),
      );
    } catch (err) {
      reportError(
        `Could not mark task waiting: ${err.message || "request failed"}`,
      );
    }
  }

  async function recordTaskResponseReceived(taskId) {
    try {
      await submitTaskIntent(
        {
          taskId,
          kind: "response-received",
          label: "Record response received",
          method: "POST",
          path: `/api/tasks/${encodeURIComponent(taskId)}/actions/response-received`,
          payload: {
            channel: "portal",
            note: "Response received in the Task panel",
          },
          errorPrefix: "Could not record response",
        },
        displayedVersion(taskId),
      );
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
      await submitTaskIntent(
        {
          taskId,
          kind: "follow-up-sent",
          label: `Record follow-up; next date ${nextDate}`,
          method: "POST",
          path: `/api/tasks/${encodeURIComponent(taskId)}/actions/follow-up-sent`,
          payload: {
            nextFollowUpAt: nextDate,
            channel: "portal",
            note: "Follow-up sent from the Task panel",
          },
          errorPrefix: "Could not record follow-up",
        },
        displayedVersion(taskId),
      );
    } catch (err) {
      reportError(
        `Could not record follow-up: ${err.message || "request failed"}`,
      );
    }
  }

  function adoptConflictCards(conflict) {
    const cards = conflict?.currentCard
      ? [conflict.currentCard]
      : Array.isArray(conflict?.currentCards)
        ? conflict.currentCards
        : [];
    for (const card of cards) {
      if (!card?.id) continue;
      state.workSnapshot.cardsById?.set(card.id, card);
      if (Array.isArray(state.workSnapshot.cards)) {
        const index = state.workSnapshot.cards.findIndex(({ id }) => id === card.id);
        if (index >= 0) state.workSnapshot.cards[index] = card;
      }
      if (detail.activeCardPanelId === card.id && detail.activeCardPanelData) {
        detail.activeCardPanelData = { ...detail.activeCardPanelData, card };
      }
    }
  }

  function reviewLatestTask() {
    const conflict = detail.activeTaskPanelConflict;
    const latest = conflict?.currentTask;
    if (!latest) return;
    detail.activeTaskPanelTask = latest;
    adoptConflictCards(conflict);
    renderTaskPanel();
  }

  async function retryTaskIntent() {
    const intent = detail.activeTaskPanelDraft;
    const latest = detail.activeTaskPanelConflict?.currentTask;
    if (!intent || !latest) return;
    const updated = await submitTaskIntent(intent, latest.version);
    if (intent.kind === "status") {
      await handleTaskStatusSuccess(intent.taskId, intent.payload.status, updated);
    }
  }

  function discardTaskIntent() {
    const conflict = detail.activeTaskPanelConflict;
    const latest = conflict?.currentTask;
    if (latest) detail.activeTaskPanelTask = latest;
    adoptConflictCards(conflict);
    detail.activeTaskPanelDraft = null;
    detail.activeTaskPanelConflict = null;
    renderTaskPanel();
  }

  // ---------- Card (workflow) detail panel ----------

  return {
    createTaskActionButton,
    defaultNextFollowUpDate,
    discardTaskIntent,
    markTaskWaiting,
    recordTaskFollowUpSent,
    recordTaskResponseReceived,
    reviewLatestTask,
    retryTaskIntent,
    refreshTaskPanel,
    saveTaskLink,
    updateTaskStatus,
  };
}
