import { isCanonicalWorkTask } from "../../core/workspace.js";

export function createTaskActions(context) {
  const {
    addDaysIso,
    cardPanelBody,
    detail,
    getActiveWorkspaceRoute,
    getActiveWorkspaceRouteToken = () => 0,
    isArchivedWorkCard,
    isWorkspaceRouteFresh,
    loadArtifactsForTask,
    navigateCanonicalWorkspace,
    promptUser,
    refreshOperationsWorkSnapshot,
    renderCardPanel,
    renderTaskPanel,
    request,
    showUndoToast,
    state,
    taskPanelBody,
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

  function routeIsFresh(token) {
    return token === undefined || token === null || isWorkspaceRouteFresh(token);
  }

  function taskCardId(taskId, explicitCardId) {
    if (explicitCardId) return explicitCardId;
    if (detail.activeTaskPanelTask?.id === taskId) {
      return detail.activeTaskPanelTask.cardId || "";
    }
    const cardTask = detail.activeCardPanelData?.tasks?.find(
      (task) => task?.id === taskId,
    );
    return cardTask?.cardId || detail.activeCardPanelData?.card?.id || "";
  }

  function taskIntentOwner(intent) {
    if (detail.activeTaskPanelId === intent.taskId) return "task";
    const card = detail.activeCardPanelData?.card;
    if (
      detail.activeCardPanelId &&
      card &&
      (!intent.cardId || card.id === intent.cardId)
    ) {
      return "card";
    }
    return null;
  }

  function taskOwnerIsCurrent(owner, intent, token) {
    if (!routeIsFresh(token)) return false;
    if (owner === "task") return detail.activeTaskPanelId === intent.taskId;
    if (owner === "card") {
      return detail.activeCardPanelId === intent.cardId;
    }
    return false;
  }

  function renderTaskOwner(owner, options = {}) {
    if (owner === "task") renderTaskPanel(options);
    else if (owner === "card") renderCardPanel(options);
  }

  function setOwnerFeedback(owner, feedback, options = {}) {
    const value = { ...feedback, owner };
    if (owner === "task" && detail.activeTaskPanelId) {
      detail.activeTaskPanelFeedback = value;
      renderTaskPanel({
        preserveDrafts: options.preserveDrafts !== false,
      });
      return true;
    }
    if (owner === "card" && detail.activeCardPanelId) {
      detail.activeCardPanelFeedback = value;
      renderCardPanel({
        preserveDrafts: options.preserveDrafts !== false,
      });
      return true;
    }
    return false;
  }

  function clearOwnerFeedback(owner) {
    if (owner === "task") detail.activeTaskPanelFeedback = null;
    if (owner === "card") detail.activeCardPanelFeedback = null;
  }

  function focusOwnerPanel(owner) {
    const panel = owner === "card" ? cardPanelBody : taskPanelBody;
    const target = Array.from(
      panel?.querySelectorAll("button, input, select, textarea") || [],
    ).find((element) => !element.disabled);
    target?.focus();
  }

  function snapshotTask(taskId) {
    const snapshot = state?.workSnapshot;
    const candidates = [
      ...(snapshot?.todayTasks || []),
      ...(snapshot?.overdueTasks || []),
      ...(snapshot?.waitingTasks || []),
    ];
    for (const tasks of Object.values(snapshot?.cardTasks || {})) {
      if (Array.isArray(tasks)) candidates.push(...tasks);
    }
    return candidates.find((task) => task?.id === taskId) || null;
  }

  function taskMutationMatches(task, intent, minimumVersion) {
    if (!isCanonicalWorkTask(task) || task.id !== intent.taskId) return false;
    if (
      Number.isInteger(minimumVersion) &&
      task.version < minimumVersion
    ) {
      return false;
    }
    const expected = intent.kind === "status"
      ? { status: intent.payload.status }
      : intent.kind === "link"
        ? { link: intent.payload.link }
        : intent.kind === "mark-waiting"
          ? {
              status: "waiting",
              waitingFor: intent.payload.waitingFor,
              followUpAt: intent.payload.followUpAt,
            }
          : intent.kind === "response-received"
            ? { status: "todo", waitingFor: null, followUpAt: null }
            : intent.kind === "follow-up-sent"
              ? {
                  status: "waiting",
                  followUpAt: intent.payload.nextFollowUpAt,
                }
              : {};
    return Object.entries(expected).every(
      ([field, value]) => task[field] === value,
    );
  }

  async function confirmTaskMutation(
    intent,
    updated,
    previousSnapshot,
    routeToken,
  ) {
    await refreshOperationsWorkSnapshot({ rerender: true });
    if (!routeIsFresh(routeToken)) return null;

    const errors = state?.workSnapshot?.errors;
    if (Array.isArray(errors) && errors.length > 0) {
      throw new Error(`Refreshed work view is incomplete: ${errors[0]}`);
    }

    const refreshedFromSnapshot = snapshotTask(intent.taskId);
    if (
      state?.workSnapshot !== previousSnapshot &&
      taskMutationMatches(refreshedFromSnapshot, intent, updated.version)
    ) {
      return refreshedFromSnapshot;
    }

    // Test doubles and local preview adapters may deliberately leave the
    // shared snapshot untouched. The mutation response is still authoritative
    // in that case; a real refresh always replaces this snapshot above.
    if (state?.workSnapshot === previousSnapshot) {
      if (!taskMutationMatches(updated, intent, updated.version)) {
        throw new Error("Task response did not retain the requested change");
      }
      return updated;
    }

    const payload = await request(
      workApiUrl(`/api/tasks/${encodeURIComponent(intent.taskId)}`),
    );
    if (!routeIsFresh(routeToken)) return null;
    const refreshed = payload?.task || payload;
    if (!taskMutationMatches(refreshed, intent, updated.version)) {
      throw new Error("Task refresh did not confirm the requested change");
    }
    return refreshed;
  }

  function intentFailureMessage(intent, error) {
    return `${intent.errorPrefix}: ${error?.message || "request failed"}`;
  }

  function showIntentFailure(owner, intent, error, expectedVersion) {
    if (!owner) return false;
    return setOwnerFeedback(owner, {
      phase: "error",
      message: intentFailureMessage(intent, error),
      intent,
      expectedVersion,
    });
  }

  function setTaskPanelFeedback(feedback = {}) {
    return setOwnerFeedback("task", feedback);
  }

  function setCardPanelFeedback(feedback = {}) {
    return setOwnerFeedback("card", feedback);
  }

  async function submitTaskIntent(intent, expectedVersion) {
    if (
      detail.activeTaskMutationBusy ||
      detail.activeCardMutationBusy ||
      detail.activeCardTemplateBusy
    ) return null;
    const routeToken = getActiveWorkspaceRouteToken();
    intent.entity = "task";
    intent.cardId = taskCardId(intent.taskId, intent.cardId);
    intent.owner = taskIntentOwner(intent);
    intent.expectedVersion = expectedVersion;
    const owner = intent.owner;
    if (!owner) return null;
    detail.activeTaskPanelConflict = null;
    if (owner === "task") {
      detail.activeTaskPanelDraft = intent;
      detail.activeTaskMutationBusy = true;
      detail.activeTaskPanelFeedback = {
        owner,
        phase: "pending",
        message: intent.pendingMessage || `${intent.label}…`,
        intent,
      };
      renderTaskPanel();
    } else if (owner === "card") {
      detail.activeTaskPanelDraft = intent;
      detail.activeTaskMutationBusy = true;
      detail.activeCardPanelFeedback = {
        owner,
        phase: "pending",
        message: intent.pendingMessage || `${intent.label}…`,
        intent,
      };
      renderCardPanel();
    }
    try {
      const updated = await request(workApiUrl(intent.path), {
        method: intent.method,
        body: JSON.stringify({ ...intent.payload, expectedVersion }),
      });
      if (!isCanonicalWorkTask(updated)) {
        throw new Error("Task response is not in the canonical versioned shape");
      }
      if (
        !taskOwnerIsCurrent(owner, intent, routeToken) &&
        owner !== null
      ) {
        return null;
      }
      if (owner === "task" && updated?.id === intent.taskId) {
        detail.activeTaskPanelTask = updated;
        renderTaskPanel({ preserveDrafts: true });
      } else if (owner === "card" && updated?.id === intent.taskId) {
        const tasks = detail.activeCardPanelData?.tasks || [];
        detail.activeCardPanelData = {
          ...detail.activeCardPanelData,
          tasks: tasks.map((task) =>
            task.id === intent.taskId ? updated : task,
          ),
        };
        renderCardPanel({ preserveDrafts: true });
      }
      const confirmed = await confirmTaskMutation(
        intent,
        updated,
        state?.workSnapshot,
        routeToken,
      );
      if (!confirmed || !taskOwnerIsCurrent(owner, intent, routeToken)) {
        return null;
      }
      if (owner === "task") {
        detail.activeTaskPanelTask = confirmed;
      } else {
        const tasks = detail.activeCardPanelData?.tasks || [];
        detail.activeCardPanelData = {
          ...detail.activeCardPanelData,
          tasks: tasks.map((task) =>
            task.id === intent.taskId ? confirmed : task,
          ),
        };
      }
      detail.activeTaskPanelDraft = null;
      detail.activeTaskPanelConflict = null;
      clearOwnerFeedback(owner);
      detail.activeTaskMutationBusy = false;
      setOwnerFeedback(owner, {
        phase: "success",
        message:
          intent.successMessage ||
          `${intent.label} is confirmed in the refreshed work view.`,
      }, { preserveDrafts: false });
      return confirmed;
    } catch (err) {
      if (
        owner &&
        taskOwnerIsCurrent(owner, intent, routeToken) &&
        err?.status === 409 &&
        ["task_version_conflict", "card_lifecycle_conflict"].includes(err?.code) &&
        err?.payload?.currentTask?.id === intent.taskId
      ) {
        if (!isCanonicalWorkTask(err.payload.currentTask)) {
          detail.activeTaskMutationBusy = false;
          showIntentFailure(
            owner,
            intent,
            new Error("Conflict response is missing the canonical current Task"),
            expectedVersion,
          );
          return null;
        }
        detail.activeTaskPanelConflict = { ...err.payload, owner };
        clearOwnerFeedback(owner);
        detail.activeTaskMutationBusy = false;
        renderTaskOwner(owner, { preserveDrafts: true });
        return null;
      }
      if (owner && taskOwnerIsCurrent(owner, intent, routeToken)) {
        detail.activeTaskMutationBusy = false;
        showIntentFailure(owner, intent, err, expectedVersion);
      }
      return null;
    }
  }

  async function handleTaskStatusSuccess(taskId, status, updated) {
    if (!updated?.version) return;
    const routeToken = getActiveWorkspaceRouteToken();
    let card = null;
    if (updated.cardId) {
      const payload = await request(
        workApiUrl(`/api/cards/${encodeURIComponent(updated.cardId)}`),
      );
      card = payload?.card || payload;
    }
    if (!routeIsFresh(routeToken)) return;
    if (
      card
      && (
        detail.activeTaskPanelId === taskId
        || detail.activeCardPanelId === card.id
      )
    ) {
      const archived = isArchivedWorkCard(card);
      const route = archived ? "/cards/archive" : "/cards";
      const navigation = navigateCanonicalWorkspace(route, {
        cardId: card.id,
        taskId,
      });
      await navigation.ready;
      if (!routeIsFresh(navigation.token)) return;
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
    const intent = {
      taskId,
      kind: "status",
      label: `Set status to ${status}`,
      method: "PUT",
      path: `/api/tasks/${encodeURIComponent(taskId)}`,
      payload: { status },
      pendingMessage: `Setting task status to ${status}…`,
      successMessage: `Task is now ${status} in the refreshed Task.`,
      errorPrefix: "Could not update task",
    };
    const owner = taskIntentOwner(intent);
    let expectedVersion;
    try {
      expectedVersion = displayedVersion(taskId, explicitVersion);
    } catch (err) {
      showIntentFailure(owner, intent, err, expectedVersion);
      return null;
    }
    const updated = await submitTaskIntent(intent, expectedVersion);
    if (!updated) return null;
    try {
      await handleTaskStatusSuccess(taskId, status, updated);
    } catch (err) {
      if (taskOwnerIsCurrent(owner, intent, getActiveWorkspaceRouteToken())) {
        showIntentFailure(
          owner,
          { ...intent, intent: null },
          new Error(`Task changed but the refreshed Card could not be opened: ${err.message || "request failed"}`),
        );
      }
    }
    return updated;
  }

  async function refreshTaskPanel(taskId) {
    if (detail.activeTaskPanelId !== taskId) return false;
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
        const artifacts = await loadArtifactsForTask(payload, { strict: true });
        if (
          !isWorkspaceRouteFresh(token) ||
          detail.activeTaskPanelId !== taskId
        )
          return false;
        detail.activeTaskPanelArtifacts = artifacts;
        renderTaskPanel({ preserveDrafts: true });
        return artifacts;
      }
    } catch {
      return false;
    }
    return false;
  }

  async function saveTaskLink(taskId, linkValue, explicitVersion) {
    const intent = {
      taskId,
      kind: "link",
      label: `Save link: ${linkValue}`,
      method: "PUT",
      path: `/api/tasks/${encodeURIComponent(taskId)}`,
      payload: { link: linkValue },
      pendingMessage: "Saving Task link…",
      successMessage: "Task link is saved in the refreshed Task.",
      errorPrefix: "Could not save link",
    };
    const owner = taskIntentOwner(intent);
    let expectedVersion;
    try {
      expectedVersion = displayedVersion(taskId, explicitVersion);
    } catch (err) {
      showIntentFailure(owner, intent, err, expectedVersion);
      return null;
    }
    return submitTaskIntent(intent, expectedVersion);
  }

  async function markTaskWaiting(taskId) {
    const today = todayIsoDate();
    const followUp = defaultNextFollowUpDate();
    const existing = detail.activeTaskPanelTask?.waitingFor || "";
    const waitingFor =
      existing || promptUser("Who/what are you waiting for?", "") || "";
    if (!waitingFor.trim()) {
      setTaskPanelFeedback({
        phase: "error",
        message: "Waiting tasks need a 'waiting for' description.",
      });
      return;
    }
    const intent = {
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
      pendingMessage: "Marking the Task waiting…",
      successMessage: "Task is waiting in the refreshed Task.",
      errorPrefix: "Could not mark task waiting",
    };
    let expectedVersion;
    try {
      expectedVersion = displayedVersion(taskId);
    } catch (err) {
      showIntentFailure(taskIntentOwner(intent), intent, err, expectedVersion);
      return null;
    }
    return submitTaskIntent(intent, expectedVersion);
  }

  async function recordTaskResponseReceived(taskId) {
    const intent = {
      taskId,
      kind: "response-received",
      label: "Record response received",
      method: "POST",
      path: `/api/tasks/${encodeURIComponent(taskId)}/actions/response-received`,
      payload: {
        channel: "portal",
        note: "Response received in the Task panel",
      },
      pendingMessage: "Recording the received response…",
      successMessage: "Response received is confirmed in the refreshed Task.",
      errorPrefix: "Could not record response",
    };
    let expectedVersion;
    try {
      expectedVersion = displayedVersion(taskId);
    } catch (err) {
      showIntentFailure(taskIntentOwner(intent), intent, err, expectedVersion);
      return null;
    }
    return submitTaskIntent(intent, expectedVersion);
  }

  async function recordTaskFollowUpSent(taskId, nextDate) {
    if (!nextDate) {
      setTaskPanelFeedback({
        phase: "error",
        message: "Choose the next follow-up date.",
        focusSelector: '[data-panel-field="follow-up-next"]',
      });
      return;
    }
    const intent = {
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
      pendingMessage: "Recording the follow-up…",
      successMessage: "Follow-up is confirmed in the refreshed Task.",
      errorPrefix: "Could not record follow-up",
    };
    let expectedVersion;
    try {
      expectedVersion = displayedVersion(taskId);
    } catch (err) {
      showIntentFailure(taskIntentOwner(intent), intent, err, expectedVersion);
      return null;
    }
    return submitTaskIntent(intent, expectedVersion);
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
    if (conflict.owner === "card") {
      const tasks = detail.activeCardPanelData?.tasks || [];
      detail.activeCardPanelData = {
        ...detail.activeCardPanelData,
        tasks: tasks.map((task) => (task.id === latest.id ? latest : task)),
      };
      renderCardPanel();
    } else {
      renderTaskPanel();
    }
  }

  async function retryTaskIntent() {
    const intent = detail.activeTaskPanelDraft;
    const latest = detail.activeTaskPanelConflict?.currentTask;
    if (!intent) return;
    const updated = await submitTaskIntent(
      intent,
      latest?.version || intent.expectedVersion,
    );
    if (!updated) return;
    if (intent.kind === "status") {
      await handleTaskStatusSuccess(intent.taskId, intent.payload.status, updated);
    }
  }

  function discardTaskIntent() {
    const conflict = detail.activeTaskPanelConflict;
    const latest = conflict?.currentTask;
    if (latest) detail.activeTaskPanelTask = latest;
    adoptConflictCards(conflict);
    const owner =
      conflict?.owner ||
      detail.activeTaskPanelDraft?.owner ||
      detail.activeTaskPanelFeedback?.owner ||
      taskIntentOwner(detail.activeTaskPanelDraft || { taskId: "" });
    if (owner === "card" && latest) {
      const tasks = detail.activeCardPanelData?.tasks || [];
      detail.activeCardPanelData = {
        ...detail.activeCardPanelData,
        tasks: tasks.map((task) => (task.id === latest.id ? latest : task)),
      };
    }
    detail.activeTaskPanelDraft = null;
    detail.activeTaskPanelConflict = null;
    clearOwnerFeedback(owner);
    renderTaskOwner(owner);
    focusOwnerPanel(owner);
  }

  function reloadTaskIntent() {
    const owner =
      detail.activeTaskPanelConflict?.owner ||
      detail.activeTaskPanelDraft?.owner ||
      detail.activeTaskPanelFeedback?.owner ||
      (detail.activeTaskPanelId ? "task" : "card");
    detail.activeTaskPanelDraft = null;
    detail.activeTaskPanelConflict = null;
    detail.activeTaskPanelFeedback = null;
    detail.activeTaskMutationBusy = false;
    if (owner === "card") detail.activeCardPanelFeedback = null;
    const route = getActiveWorkspaceRoute?.();
    if (!route || route.invalid) return undefined;
    return navigateCanonicalWorkspace(route.path, route.params, {
      history: "none",
    }).ready;
  }

  // ---------- Card (workflow) detail panel ----------

  return {
    createTaskActionButton,
    defaultNextFollowUpDate,
    discardTaskIntent,
    markTaskWaiting,
    recordTaskFollowUpSent,
    recordTaskResponseReceived,
    reloadTaskIntent,
    reviewLatestTask,
    retryTaskIntent,
    refreshTaskPanel,
    saveTaskLink,
    setCardPanelFeedback,
    setTaskPanelFeedback,
    updateTaskStatus,
  };
}
