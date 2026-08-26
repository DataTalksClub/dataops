import { renderDataSummary } from "../operations-overview.js";
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
    isArchivedWorkCard,
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
    openCardPanel,
    openTaskPanel,
    operationItemFromCard,
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
    resolveAssigneeLabel,
    request,
    scheduleAnimationFrame,
    setRouteTitle,
    setWorkspaceEntityState,
    shellBody,
    sortWorkTasks,
    state,
    surfaceDescription,
    summarizeCardProgress,
    taskDate,
    taskNextActionLabel,
    taskProofState,
    taskSourceLabel,
    tasksSectionTitle,
    tasksFromWorkPayload,
    todayIsoDate,
    workApiUrl,
    workCardTitle,
    workTaskTitle,
  } = context;

  const { openQuickTaskForm, openQuickWorkflowForm, openRecurringForm } =
    createQuickTaskActions(context);
  const {
    recurringConfigTitle,
    renderRecurringSurface,
    renderWorkflowTemplateCard,
  } = createRecurringTasks({
    ...context,
    openQuickWorkflowForm,
    openRecurringForm,
  });
  const { renderWorkflowsSurface } = createCardsSurface({
    ...context,
    openQuickWorkflowForm,
  });
  const { renderWorkQueueSurface } = createTaskQueue(context);
  const {
    getRuntimeTemplateState,
    refreshRuntimeTemplates,
    renderTemplatesSurface,
    resolveTemplateRouteEntity,
    setRuntimeTemplateRoute,
  } = createTemplatesSurface({
    ...context,
    openQuickWorkflowForm,
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
    setRouteTitle(title);
    clearSelectionButton.hidden = true;

    const wrap = document.createElement("div");
    wrap.className = `operations-home ops-surface ops-surface-${activeSection}`;
    if (activeSection !== "workflows") {
      wrap.append(
        renderSurfaceHeader(title, surfaceDescription(activeSection)),
      );
    }
    const summary = renderTasksSummary(activeSection, model, documents);
    if (summary) wrap.append(summary);
    const runtimeStatus = renderOperationsRuntimeState(model.runtime);
    if (runtimeStatus && ["queue", "workflows"].includes(activeSection)) {
      wrap.append(runtimeStatus);
    }

    if (activeSection === "queue") wrap.append(renderWorkQueueSurface(model));
    else if (activeSection === "workflows")
      wrap.append(renderWorkflowsSurface(model));
    else if (activeSection === "templates")
      wrap.append(renderTemplatesSurface(model));
    else if (activeSection === "recurring")
      wrap.append(renderRecurringSurface(model));
    else if (activeSection === "assistants")
      wrap.append(renderAssistantsSurface());
    else if (activeSection === "artifacts")
      wrap.append(renderArtifactsSurface());

    documentList.replaceChildren(wrap);
  }

  // A retry is itself an async action. The route token proves that the operator
  // is still looking at Templates before its late response can re-render.

  // Each Tasks section reports its own load state where the operator is
  // looking. A section that is still fetching, that failed, that answered with
  // nothing, or that answered only in part are four different sentences.
  function renderTasksSummary(view, model, documents) {
    const work = state.workSnapshot;
    const workErrors = (model.stats.workErrors || []).filter(Boolean);
    const retryWork = async () => {
      const routeToken = getActiveWorkspaceRouteToken();
      // Resetting the Cards loader is deliberate: a continuation retry must
      // also recover a failed page, not merely preserve its broken cursor.
      await refreshOperationsWorkSnapshot({ rerender: false });
      if (isWorkspaceRouteFresh(routeToken)) refreshDocuments();
    };
    if (view === "queue") {
      const total = allWorkTasks(work).length;
      // A lane whose source did not answer has no count, not a zero.
      const sourceLoaded = (flag) =>
        flag === false ? false : flag === true ? true : Boolean(model.stats.liveLoaded);
      const tasksLoaded =
        sourceLoaded(model.stats.todayLoaded) ||
        sourceLoaded(model.stats.overdueLoaded) ||
        sourceLoaded(model.stats.waitingLoaded);
      const counts = [
        tasksLoaded
          ? countLabel(total, "known work item")
          : "known work items unknown",
        model.stats.waitingLoaded
          ? `${countLabel(model.stats.followUpTasks, "follow-up")} due`
          : "follow-ups unknown",
        model.stats.missingProofLoaded
          ? `${countLabel(model.stats.missingProofTasks, "item")} missing proof`
          : "missing proof unknown",
      ].join(" · ");
      return renderDataSummary({
        id: "tasks-queue",
        label: "Work Queue",
        loaded: model.stats.liveLoaded,
        errors: workErrors,
        empty: total === 0,
        messages: {
          loading: "Loading tasks from the work API…",
          unavailable: "The work queue could not be loaded, so no tasks are listed.",
          empty: "No tasks are open in this queue.",
          partial: `${counts}. Some task sources are unavailable.`,
          ready: `${counts}.`,
        },
        retryLabel: "Retry loading tasks",
        onRetry: retryWork,
      });
    }
    if (view === "workflows") {
      // The board renders from the snapshot, so the summary counts the same
      // cards the operator can see rather than a parallel derived number.
      const active = (work.activeCards || []).length;
      const complete = model.stats.cardsComplete !== false;
      const counts = complete
        ? `${countLabel(active, "active card")}, at-risk first`
        : `${countLabel(active, "loaded active card")}s; total unknown`;
      return renderDataSummary({
        id: "tasks-workflows",
        label: "Cards",
        loaded: complete
          ? model.stats.cardsLoaded ?? model.stats.liveLoaded
          : active > 0,
        errors: workErrors,
        empty: complete && active === 0,
        messages: {
          loading: "Loading cards from the work API…",
          unavailable: "Cards could not be loaded, so none are listed.",
          empty: "No active cards. Finished cards move to the archive.",
          partial: `${counts}. Some card sources are unavailable.`,
          ready: `${counts}.`,
        },
        retryLabel: "Retry loading cards",
        onRetry: retryWork,
      });
    }
    if (view === "recurring") {
      const recurring = model.recurring;
      const counts = [
        countLabel(recurring.configs.length, "recurring schedule"),
        `${recurring.enabled.length} enabled`,
        `${recurring.disabled.length} paused`,
      ].join(" · ");
      return renderDataSummary({
        id: "tasks-recurring",
        label: "Recurring",
        loaded: recurring.loaded,
        errors: recurring.errors,
        empty: recurring.configs.length === 0,
        messages: {
          loading: "Loading recurring schedules…",
          unavailable: "Recurring schedules could not be loaded.",
          empty: "No recurring schedules yet. New schedule creates the first one.",
          partial: `${counts}. Some schedule data is unavailable.`,
          ready: `${counts}.`,
        },
        retryLabel: "Retry loading schedules",
        onRetry: async () => {
          const routeToken = getActiveWorkspaceRouteToken();
          await refreshOperationsRecurringSnapshot({ rerender: false });
          if (isWorkspaceRouteFresh(routeToken)) renderTasksSurface(documents, view);
        },
      });
    }
    if (view === "templates") {
      const routeToken = getActiveWorkspaceRouteToken();
      const runtimeState = getRuntimeTemplateState();
      const count = runtimeState.loaded
        ? runtimeState.templates.length
        : model.templates.length;
      return renderDataSummary({
        id: "tasks-templates",
        label: "Templates",
        loaded: runtimeState.loaded,
        errors: runtimeState.error ? [runtimeState.error] : [],
        empty: count === 0,
        messages: {
          loading: "Loading Git-authored templates…",
          unavailable: "Runtime templates could not be loaded.",
          empty: "No runtime templates are deployed.",
          partial: `${countLabel(count, "runtime template")}. Some template data is unavailable.`,
          ready: `${countLabel(count, "runtime template")}.`,
        },
        retryLabel: "Retry loading templates",
        onRetry: async () => {
          await refreshRuntimeTemplates();
          if (isWorkspaceRouteFresh(routeToken)) renderTasksSurface(documents, view);
        },
      });
    }
    // Assistants and Artifacts render their own state; Tasks does not speak for
    // surfaces it does not own.
    return null;
  }

  // Process Docs owns a separate main-canvas surface. The global sidebar remains
  // navigation-only; library, filtering, creation, and editor tools belong here.

  return {
    openQuickTaskForm,
    openQuickWorkflowForm,
    recurringConfigTitle,
    refreshRuntimeTemplates,
    renderTasksSurface,
    resolveTemplateRouteEntity,
    setRuntimeTemplateRoute,
  };
}
