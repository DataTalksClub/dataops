import { createCardPanel } from "./card-panel.js";
import { createRouteState } from "./route-state.js";
import { createTaskActions } from "./task-actions.js";
import { createTaskEvidence } from "./task-evidence.js";
import { createTaskPanel } from "./task-panel.js";

export function createWorkDetailSurface(context) {
  const formatMetaDate = (value, today) => {
    const strong = document.createElement("strong");
    strong.textContent =
      context.formatTaskDateMeta(value, today) ||
      String(value || "").slice(0, 10);
    return strong;
  };
  const detail = {
    activeTaskPanelId: null,
    activeTaskPanelTask: null,
    activeTaskPanelArtifacts: [],
    activeTaskPanelDraft: null,
    activeTaskPanelConflict: null,
    activeTaskMutationBusy: false,
    activeCardPanelId: null,
    activeCardPanelData: null,
    activeCardPanelDraft: null,
    activeCardPanelConflict: null,
    activeCardMutationBusy: false,
    activeCardTemplateReviewOpen: false,
    activeCardTemplateBusy: false,
    activeCardTemplateMessage: "",
    taskRouteContext: emptyTaskRouteContext(),
  };
  let taskPanelApi;
  let cardPanelApi;
  let routeStateApi;
  let taskActionsApi;
  let taskEvidenceApi;

  const delegated = {
    closeCardPanel: (...args) => routeStateApi.closeCardPanel(...args),
    closeTaskPanel: (...args) => routeStateApi.closeTaskPanel(...args),
    createTaskActionButton: (...args) =>
      taskActionsApi.createTaskActionButton(...args),
    formatMetaDate,
    loadArtifactsForCard: (...args) =>
      taskEvidenceApi.loadArtifactsForCard(...args),
    loadArtifactsForTask: (...args) =>
      taskEvidenceApi.loadArtifactsForTask(...args),
    markTaskWaiting: (...args) => taskActionsApi.markTaskWaiting(...args),
    navigateTaskToWorkflow: (...args) =>
      cardPanelApi.navigateTaskToWorkflow(...args),
    openTaskPanel: (...args) => taskPanelApi.openTaskPanel(...args),
    recordTaskFollowUpSent: (...args) =>
      taskActionsApi.recordTaskFollowUpSent(...args),
    recordTaskResponseReceived: (...args) =>
      taskActionsApi.recordTaskResponseReceived(...args),
    refreshTaskPanel: (...args) => taskActionsApi.refreshTaskPanel(...args),
    renderArtifactList: (...args) =>
      taskEvidenceApi.renderArtifactList(...args),
    renderCardPanel: (...args) => cardPanelApi.renderCardPanel(...args),
    renderEntityLoadingState: (...args) =>
      cardPanelApi.renderEntityLoadingState(...args),
    renderTaskArtifactSection: (...args) =>
      taskEvidenceApi.renderTaskArtifactSection(...args),
    renderTaskFileSection: (...args) =>
      taskEvidenceApi.renderTaskFileSection(...args),
    renderTaskPanel: (...args) => taskPanelApi.renderTaskPanel(...args),
    saveTaskLink: (...args) => taskActionsApi.saveTaskLink(...args),
    updateTaskStatus: (...args) => taskActionsApi.updateTaskStatus(...args),
  };

  taskActionsApi = createTaskActions({
    ...context,
    ...delegated,
    detail,
  });
  taskEvidenceApi = createTaskEvidence({
    ...context,
    ...delegated,
    ...taskActionsApi,
    detail,
  });
  taskPanelApi = createTaskPanel({
    ...context,
    ...delegated,
    ...taskActionsApi,
    ...taskEvidenceApi,
    detail,
  });
  cardPanelApi = createCardPanel({
    ...context,
    ...delegated,
    ...taskActionsApi,
    ...taskEvidenceApi,
    ...taskPanelApi,
    detail,
  });
  routeStateApi = createRouteState({
    ...context,
    ...delegated,
    ...taskPanelApi,
    ...cardPanelApi,
    detail,
  });

  return {
    closeCardPanel: routeStateApi.closeCardPanel,
    closeTaskPanel: routeStateApi.closeTaskPanel,
    dedupeArtifacts: taskEvidenceApi.dedupeArtifacts,
    defaultNextFollowUpDate: taskActionsApi.defaultNextFollowUpDate,
    getTaskRouteContext: () => detail.taskRouteContext,
    handleWorkspaceEntityModalKeydown:
      routeStateApi.handleWorkspaceEntityModalKeydown,
    hydrateCardPanel: cardPanelApi.hydrateCardPanel,
    hydrateTaskPanel: taskPanelApi.hydrateTaskPanel,
    openCardPanel: cardPanelApi.openCardPanel,
    openTaskPanel: taskPanelApi.openTaskPanel,
    prepareCardPanel: routeStateApi.prepareCardPanel,
    prepareTaskPanel: routeStateApi.prepareTaskPanel,
    renderArtifactList: taskEvidenceApi.renderArtifactList,
    resetCardPanel: routeStateApi.resetCardPanel,
    resetTaskPanel: routeStateApi.resetTaskPanel,
    resolveAssigneeLabel: taskPanelApi.resolveAssigneeLabel,
    resolveCardLabel: taskPanelApi.resolveCardLabel,
    resolveTaskQueueRouteContext: routeStateApi.resolveTaskQueueRouteContext,
    setTaskRouteContextFromRoute: routeStateApi.setTaskRouteContextFromRoute,
  };
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
