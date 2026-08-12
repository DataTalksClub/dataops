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
    activeBundlePanelId: null,
    activeBundlePanelData: null,
    taskRouteContext: emptyTaskRouteContext(),
  };
  let taskPanelApi;
  let cardPanelApi;
  let routeStateApi;
  let taskActionsApi;
  let taskEvidenceApi;

  const delegated = {
    closeBundlePanel: (...args) => routeStateApi.closeBundlePanel(...args),
    closeTaskPanel: (...args) => routeStateApi.closeTaskPanel(...args),
    createTaskActionButton: (...args) =>
      taskActionsApi.createTaskActionButton(...args),
    formatMetaDate,
    loadArtifactsForBundle: (...args) =>
      taskEvidenceApi.loadArtifactsForBundle(...args),
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
    renderBundlePanel: (...args) => cardPanelApi.renderBundlePanel(...args),
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
    closeBundlePanel: routeStateApi.closeBundlePanel,
    closeTaskPanel: routeStateApi.closeTaskPanel,
    dedupeArtifacts: taskEvidenceApi.dedupeArtifacts,
    defaultNextFollowUpDate: taskActionsApi.defaultNextFollowUpDate,
    getTaskRouteContext: () => detail.taskRouteContext,
    handleWorkspaceEntityModalKeydown:
      routeStateApi.handleWorkspaceEntityModalKeydown,
    hydrateBundlePanel: cardPanelApi.hydrateBundlePanel,
    hydrateTaskPanel: taskPanelApi.hydrateTaskPanel,
    openBundlePanel: cardPanelApi.openBundlePanel,
    openTaskPanel: taskPanelApi.openTaskPanel,
    prepareBundlePanel: routeStateApi.prepareBundlePanel,
    prepareTaskPanel: routeStateApi.prepareTaskPanel,
    renderArtifactList: taskEvidenceApi.renderArtifactList,
    resetBundlePanel: routeStateApi.resetBundlePanel,
    resetTaskPanel: routeStateApi.resetTaskPanel,
    resolveAssigneeLabel: taskPanelApi.resolveAssigneeLabel,
    resolveBundleLabel: taskPanelApi.resolveBundleLabel,
    resolveTaskQueueRouteContext: routeStateApi.resolveTaskQueueRouteContext,
    setTaskRouteContextFromRoute: routeStateApi.setTaskRouteContextFromRoute,
  };
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
