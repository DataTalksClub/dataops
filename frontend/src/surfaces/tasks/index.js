import { createCardsSurface } from "./cards.js";
import { createQuickTaskActions } from "./quick-create.js";
import { createTaskQueue } from "./queue.js";
import { createRecurringTasks } from "./recurring.js";
import { createTemplatesSurface } from "./templates.js";

export function createTasksSurface(context) {
  const {
    addBeforeUnloadListener,
    allWorkTasks,
    buildOperationsHomeModel,
    cardsHeaderViewModel,
    clearSelectionButton,
    compareIsoDate,
    confirmDialog,
    countLabel,
    debounce,
    documentList,
    escapeHtml,
    formatTaskDateMeta,
    getActiveTasksSection,
    getActiveWorkspaceRoute,
    getActiveWorkspaceRouteToken,
    getAllDocuments,
    getPendingLegacyRoute,
    getTaskRouteContext,
    getWorkspaceEntityState,
    groupCardItemsByStage,
    isArchivedWorkBundle,
    isFollowUpDueTask,
    isOpenWorkTask,
    isOperationsHomeVisible,
    isTaskDueToday,
    isTaskOverdue,
    isWaitingOrFollowUpTask,
    isWorkspaceRouteFresh,
    libraryTitle,
    listDraftPaths,
    navigateCanonicalWorkspace,
    openDocument,
    openBundlePanel,
    openTaskPanel,
    operationItemFromBundle,
    referenceCountLabel,
    refreshDocuments,
    refreshOperationsRecurringSnapshot,
    refreshOperationsWorkSnapshot,
    renderArtifactsSurface,
    renderAssistantsSurface,
    renderEntityLoadState,
    renderHonestState,
    renderOperationsRuntimeState,
    renderSurfaceHeader,
    reportError,
    resolveAssigneeLabel,
    request,
    scheduleAnimationFrame,
    setPageTitle,
    setStatus,
    setWorkspaceEntityState,
    shellBody,
    showErrorToast,
    sortWorkTasks,
    state,
    surfaceDescription,
    summarizeBundleProgress,
    taskDate,
    taskNextActionLabel,
    taskProofState,
    taskSourceLabel,
    tasksSectionTitle,
    tasksFromWorkPayload,
    todayIsoDate,
    workApiUrl,
    workBundleTitle,
    workTaskTitle,
  } = context;

  const { openQuickTaskForm, openQuickWorkflowForm } =
    createQuickTaskActions(context);
  const {
    recurringConfigTitle,
    renderRecurringOperationsSection,
    renderWorkflowTemplateCard,
  } = createRecurringTasks({
    ...context,
    openQuickWorkflowForm,
  });
  const { renderWorkflowsSurface } = createCardsSurface({
    ...context,
    openQuickWorkflowForm,
  });
  const { renderWorkQueueSurface } = createTaskQueue(context);
  const {
    confirmLeaveRuntimeDraft,
    getRuntimeTemplateState,
    refreshRuntimeTemplates,
    renderTemplatesRecurringSurface,
    resolveTemplateRouteEntity,
    setRuntimeTemplateRoute,
  } = createTemplatesSurface({
    ...context,
    openQuickWorkflowForm,
    renderRecurringOperationsSection,
    renderTasksSurface,
    renderWorkflowTemplateCard,
  });

  function renderTasksSurface(documents, section) {
    const model = buildOperationsHomeModel(documents, {
      draftPaths: listDraftPaths(),
      workSnapshot: state.workSnapshot,
      recurringSnapshot: state.recurringSnapshot,
      qualitySnapshot: state.qualitySnapshot,
    });
    const activeSection = section || "queue";
    documentList.classList.add("is-operations-home");
    documentList.classList.remove("is-unified-search");
    const title = tasksSectionTitle(activeSection);
    libraryTitle.textContent = title;
    setPageTitle(title, "Tasks");
    clearSelectionButton.hidden = true;
    setStatus(tasksSurfaceStatusText(activeSection, model));

    const wrap = document.createElement("div");
    wrap.className = `operations-home ops-surface ops-surface-${activeSection}`;
    if (activeSection !== "workflows") {
      wrap.append(
        renderSurfaceHeader(title, surfaceDescription(activeSection)),
      );
    }
    const runtimeStatus = renderOperationsRuntimeState(model.runtime);
    if (runtimeStatus && ["queue", "workflows"].includes(activeSection)) {
      wrap.append(runtimeStatus);
    }

    if (activeSection === "queue") wrap.append(renderWorkQueueSurface(model));
    else if (activeSection === "workflows")
      wrap.append(renderWorkflowsSurface(model));
    else if (activeSection === "templates")
      wrap.append(renderTemplatesRecurringSurface(model));
    else if (activeSection === "assistants")
      wrap.append(renderAssistantsSurface());
    else if (activeSection === "artifacts")
      wrap.append(renderArtifactsSurface());

    documentList.replaceChildren(wrap);
  }

  function tasksSurfaceStatusText(view, model) {
    if (view === "queue") {
      return [
        countLabel(allWorkTasks(state.workSnapshot).length, "known work item"),
        `${countLabel(model.stats.followUpTasks, "follow-up")} due`,
        `${countLabel(model.stats.missingProofTasks, "item")} missing proof.`,
      ].join(" · ");
    }
    if (view === "workflows") {
      return `${countLabel(model.stats.activeBundles, "active card")} · at-risk first.`;
    }
    const runtimeState = getRuntimeTemplateState();
    const runtimeCount = runtimeState.loaded
      ? runtimeState.templates.length
      : model.templates.length;
    return `${countLabel(runtimeCount, "runtime template")} · ${countLabel(model.recurring.configs.length, "recurring config")}.`;
  }

  // Process Docs owns a separate main-canvas surface. The global sidebar remains
  // navigation-only; library, filtering, creation, and editor tools belong here.

  return {
    confirmLeaveRuntimeDraft,
    openQuickTaskForm,
    openQuickWorkflowForm,
    recurringConfigTitle,
    refreshRuntimeTemplates,
    renderTasksSurface,
    resolveTemplateRouteEntity,
    setRuntimeTemplateRoute,
  };
}
