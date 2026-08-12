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

  let runtimeState = {
    loaded: false,
    templates: [],
    selectedId: null,
    search: "",
    error: "",
    isAdmin: false,
    draft: null,
    baseline: null,
    editorState: "clean",
    feedback: "",
    fieldErrors: {},
    conflict: null,
  };
  const recurringDeleteErrors = new Map();

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
    const runtimeCount = runtimeState.loaded
      ? runtimeState.templates.length
      : model.templates.length;
    return `${countLabel(runtimeCount, "runtime template")} · ${countLabel(model.recurring.configs.length, "recurring config")}.`;
  }

  // Process Docs owns a separate main-canvas surface. The global sidebar remains
  // navigation-only; library, filtering, creation, and editor tools belong here.

  function renderWorkQueueSurface(model) {
    const taskRouteContext = getTaskRouteContext();
    const today = taskRouteContext.date || todayIsoDate();
    const tasks = Array.isArray(taskRouteContext.tasks)
      ? taskRouteContext.tasks
      : allWorkTasks(state.workSnapshot);
    // Per-group loaded state (#97): each queue group degrades against its own
    // data source so a single failed endpoint only empties its own group.
    const groupLoaded = {
      Overdue: state.workSnapshot.overdueLoaded,
      "Follow-ups due": state.workSnapshot.waitingLoaded,
      "Missing proof":
        state.workSnapshot.todayLoaded ||
        state.workSnapshot.overdueLoaded ||
        state.workSnapshot.waitingLoaded,
      Waiting: state.workSnapshot.waitingLoaded,
      Today: state.workSnapshot.todayLoaded,
      "Done / history":
        state.workSnapshot.todayLoaded ||
        state.workSnapshot.overdueLoaded ||
        state.workSnapshot.waitingLoaded,
    };
    const groups = [
      ["Overdue", tasks.filter((task) => isTaskOverdue(task, today))],
      [
        "Follow-ups due",
        tasks.filter((task) => isFollowUpDueTask(task, today)),
      ],
      [
        "Missing proof",
        tasks.filter(
          (task) => isOpenWorkTask(task) && !taskProofState(task).ok,
        ),
      ],
      [
        "Waiting",
        tasks.filter(
          (task) =>
            isWaitingOrFollowUpTask(task) && !isFollowUpDueTask(task, today),
        ),
      ],
      ["Today", tasks.filter((task) => isTaskDueToday(task, today))],
      [
        "Done / history",
        tasks.filter(
          (task) => String(task.status || "").toLowerCase() === "done",
        ),
      ],
    ];

    const section = document.createElement("section");
    section.className = "ops-work-queue";
    section.setAttribute("aria-label", "Work queue");
    if (
      taskRouteContext.date ||
      taskRouteContext.bundleId ||
      taskRouteContext.contextBundleId ||
      taskRouteContext.failures.length
    ) {
      const context = document.createElement("aside");
      context.className = "task-route-context";
      context.setAttribute("aria-label", "Task queue route context");
      const heading = document.createElement("h3");
      heading.textContent = "Queue context";
      const summary = document.createElement("p");
      summary.textContent = [
        taskRouteContext.date ? `Date ${taskRouteContext.date}` : "",
        taskRouteContext.bundleId
          ? `Filtered to card ${taskRouteContext.filterBundle?.title || taskRouteContext.bundleId}`
          : "",
        taskRouteContext.contextBundleId
          ? `Return card ${taskRouteContext.contextBundle?.title || taskRouteContext.contextBundleId}`
          : "",
      ]
        .filter(Boolean)
        .join(" · ");
      context.append(heading, summary);
      if (taskRouteContext.contextBundleId && taskRouteContext.contextBundle) {
        const open = document.createElement("button");
        open.type = "button";
        open.textContent = "Open return card";
        open.addEventListener("click", () =>
          openBundlePanel(taskRouteContext.contextBundleId),
        );
        context.append(open);
      }
      for (const failure of taskRouteContext.failures)
        context.append(renderTaskRouteContextFailure(failure));
      section.append(context);
    }
    for (const [label, list] of groups) {
      const group = document.createElement("article");
      group.className = "ops-queue-group";
      const header = document.createElement("header");
      const title = document.createElement("h3");
      title.textContent = label;
      const count = document.createElement("span");
      count.textContent = String(list.length);
      header.append(title, count);
      group.append(header);
      const rows = document.createElement("div");
      rows.className = "ops-queue-rows";
      if (list.length === 0) {
        const empty = document.createElement("p");
        empty.className = "ops-empty";
        empty.textContent = groupLoaded[label]
          ? `No ${label.toLowerCase()} work.`
          : "Live work data unavailable.";
        rows.append(empty);
      } else {
        const visible =
          label === "Done / history"
            ? list
                .slice()
                .sort((a, b) =>
                  compareIsoDate(taskDate(b) || "", taskDate(a) || ""),
                )
                .slice(0, 12)
            : sortWorkTasks(
                list,
                label === "Overdue" ? "overdue" : "today",
                today,
              );
        for (const task of visible)
          rows.append(renderWorkQueueRow(task, today));
      }
      group.append(rows);
      section.append(group);
    }
    return section;
  }

  function renderTaskRouteContextFailure(failure) {
    const labels = {
      "filter-bundle": [
        "Filter card",
        "The card filter could not be verified.",
      ],
      "task-query": [
        "Filtered task queue",
        "The requested task slice could not be loaded.",
      ],
      "return-context": [
        "Return card",
        "The return context could not be loaded.",
      ],
    };
    const [label, explanation] = labels[failure.source] || [
      "Route context",
      "This route context could not be loaded.",
    ];
    const state = document.createElement("section");
    state.className = `task-context-state entity-route-${failure.status}`;
    state.dataset.contextSource = failure.source;
    state.setAttribute("role", failure.status === "error" ? "alert" : "status");
    const heading = document.createElement("strong");
    heading.textContent = `${label} ${failure.status === "not-found" ? "not found" : "unavailable"}`;
    const detail = document.createElement("p");
    detail.textContent =
      `${explanation} Requested value: ${failure.id}. ${failure.error || ""}`.trim();
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "Retry route context";
    retry.addEventListener("click", () => {
      const route = getActiveWorkspaceRoute();
      navigateCanonicalWorkspace(route.path, route.params, { history: "none" });
    });
    const clear = document.createElement("button");
    clear.type = "button";
    clear.textContent = "Clear queue context";
    clear.addEventListener("click", () => navigateCanonicalWorkspace("/tasks"));
    state.append(heading, detail, retry, clear);
    return state;
  }

  function renderWorkQueueRow(task, today) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ops-queue-row";
    button.dataset.taskId = task.id;
    button.addEventListener("click", () => openTaskPanel(task.id));
    const title = document.createElement("strong");
    title.textContent = workTaskTitle(task);
    const meta = document.createElement("div");
    meta.className = "ops-queue-meta";
    const status = String(task.status || "todo").toLowerCase();
    for (const value of [
      status,
      task.date ? `Due ${formatTaskDateMeta(task.date, today)}` : "",
      task.assigneeId
        ? `Owner ${resolveAssigneeLabel(task.assigneeId)}`
        : "Unassigned",
      task.bundleId ? "Card task" : "Independent task",
      taskSourceLabel(task),
      taskProofState(task).label,
    ].filter(Boolean)) {
      const chip = document.createElement("span");
      chip.textContent = value;
      meta.append(chip);
    }
    const summary = document.createElement("small");
    summary.textContent = task.waitingFor
      ? `Waiting for ${task.waitingFor}${task.followUpAt ? ` · follow up ${formatTaskDateMeta(task.followUpAt, today)}` : ""}`
      : `Next: ${taskNextActionLabel(task, today)}`;
    button.append(title, meta, summary);
    return button;
  }

  function renderWorkflowsSurface(model) {
    const section = document.createElement("section");
    section.className = "ops-workflows-board";
    section.setAttribute("aria-labelledby", "workflow-board-title");
    const bundles = state.workSnapshot.activeBundles || [];
    const archivedCards = (state.workSnapshot.bundles || []).filter(
      isArchivedWorkBundle,
    );
    const archiveVisible = getActiveWorkspaceRoute()?.path === "/cards/archive";
    const displayedCards = archiveVisible ? archivedCards : bundles;
    const headerModel = cardsHeaderViewModel({
      archiveVisible,
      activeCount: bundles.length,
      archivedCount: archivedCards.length,
    });
    const header = document.createElement("header");
    header.className = "workflow-board-header";
    const heading = document.createElement("div");
    const eyebrow = document.createElement("span");
    eyebrow.className = "workflow-board-eyebrow";
    eyebrow.textContent = headerModel.eyebrow;
    const title = document.createElement("h2");
    title.id = "workflow-board-title";
    title.textContent = headerModel.title;
    const summary = document.createElement("p");
    summary.textContent = headerModel.summary;
    heading.append(eyebrow, title, summary);
    const actions = document.createElement("div");
    actions.className = "workflow-board-actions";
    const archive = document.createElement("button");
    archive.type = "button";
    archive.className = "quiet-button";
    archive.textContent = headerModel.archiveAction;
    archive.setAttribute("aria-pressed", String(archiveVisible));
    archive.addEventListener("click", () =>
      navigateCanonicalWorkspace(headerModel.archiveRoute),
    );
    const start = document.createElement("button");
    start.type = "button";
    start.className = "primary-button";
    start.textContent = "Create card";
    start.addEventListener("click", () => openQuickWorkflowForm());
    actions.append(archive);
    if (headerModel.createVisible) actions.append(start);
    header.append(heading, actions);
    section.append(header);

    if (displayedCards.length === 0) {
      section.append(
        archiveVisible
          ? renderHonestState(
              "Archive is empty",
              "Cards appear here after all of their Tasks are complete.",
            )
          : renderHonestState(
              "No active cards",
              state.workSnapshot.bundlesLoaded
                ? "Create a card from a Template when new work arrives."
                : "Live card data is unavailable.",
            ),
      );
      return section;
    }

    const today = todayIsoDate();
    if (archiveVisible) {
      const archiveGrid = document.createElement("div");
      archiveGrid.className = "cards-archive-grid";
      archiveGrid.setAttribute("aria-label", "Archived cards");
      for (const bundle of archivedCards) {
        const tasks = state.workSnapshot.bundleTasks[bundle.id] || [];
        const item = operationItemFromBundle(bundle, tasks, { today });
        archiveGrid.append(renderWorkflowSurfaceCard(item));
      }
      section.append(archiveGrid);
      return section;
    }

    const board = document.createElement("div");
    board.className = "ops-workflows-grid";
    board.setAttribute("aria-label", "Active card board");
    const items = bundles.map((bundle) => {
      const tasks = state.workSnapshot.bundleTasks[bundle.id] || [];
      return operationItemFromBundle(bundle, tasks, { today });
    });
    for (const { stage, label, items: stageItems } of groupCardItemsByStage(
      items,
    )) {
      const column = document.createElement("section");
      column.className = "workflow-board-column";
      column.setAttribute("aria-labelledby", `workflow-column-${stage}`);
      const columnHeader = document.createElement("header");
      columnHeader.className = "workflow-column-header";
      const columnTitle = document.createElement("h3");
      columnTitle.id = `workflow-column-${stage}`;
      columnTitle.textContent = label;
      const columnCount = document.createElement("span");
      columnCount.textContent = String(stageItems.length);
      columnCount.setAttribute(
        "aria-label",
        countLabel(stageItems.length, "card"),
      );
      columnHeader.append(columnTitle, columnCount);
      const list = document.createElement("div");
      list.className = "workflow-board-list";
      if (stageItems.length === 0) {
        const empty = document.createElement("p");
        empty.className = "workflow-column-empty";
        empty.textContent = "No cards";
        list.append(empty);
      } else {
        for (const item of stageItems)
          list.append(renderWorkflowSurfaceCard(item));
      }
      column.append(columnHeader, list);
      board.append(column);
    }
    section.append(board);
    return section;
  }

  function renderWorkflowSurfaceCard(item) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = `ops-workflow-card workflow-board-card ops-risk-${item.risk || "low"}`;
    card.dataset.bundleId = item.bundleId;
    card.addEventListener("click", () => openBundlePanel(item.bundleId));
    const title = document.createElement("strong");
    title.textContent = item.title;
    const meta = document.createElement("small");
    meta.textContent = item.meta || "";
    card.append(title);
    if (item.progress) {
      const progress = document.createElement("div");
      progress.className = "ops-progress";
      const fill = document.createElement("i");
      fill.style.width = `${item.progress.percent || 0}%`;
      progress.append(fill);
      card.append(progress);
    }
    card.append(meta);
    return card;
  }

  function renderTemplatesRecurringSurface(model) {
    const section = document.createElement("section");
    section.className = "ops-split-surface";
    section.append(renderRuntimeTemplateAdmin());
    const support = document.createElement("div");
    support.className = "runtime-template-support";
    const templates = document.createElement("div");
    templates.className = "ops-section";
    const templateHeader = document.createElement("div");
    templateHeader.className = "ops-section-header";
    const templateTitle = document.createElement("h3");
    templateTitle.textContent = "Templates";
    const templateMeta = document.createElement("span");
    const manualTemplates = model.templates.filter(
      (template) => !template.recurring,
    );
    templateMeta.textContent = `${countLabel(manualTemplates.length, "template")} available`;
    templateHeader.append(templateTitle, templateMeta);
    templates.append(templateHeader);
    const grid = document.createElement("div");
    grid.className = "ops-template-grid";
    for (const template of manualTemplates)
      grid.append(renderWorkflowTemplateCard(template));
    if (!grid.children.length)
      grid.append(
        renderHonestState(
          "No manual templates indexed",
          "Process docs remain available under Processes.",
        ),
      );
    templates.append(grid);
    support.append(
      templates,
      renderRecurringOperationsSection(model.recurring),
    );
    section.append(support);
    return section;
  }

  const RUNTIME_TEMPLATE_FIELDS = [
    "name",
    "type",
    "emoji",
    "tags",
    "defaultAssigneeId",
    "phases",
    "sourceDocIds",
    "references",
    "bundleLinkDefinitions",
    "triggerType",
    "triggerSchedule",
    "triggerLeadDays",
    "triggerEnabled",
    "taskDefinitions",
  ];

  function runtimeTemplateDefinition(template) {
    const editable = editableRuntimeTemplate(template);
    return {
      name: editable.name || "",
      type: editable.type || "",
      emoji: editable.emoji || "",
      tags: [...(editable.tags || [])],
      defaultAssigneeId: editable.defaultAssigneeId || "",
      phases: structuredClone(editable.phases || []),
      sourceDocIds: [...(editable.sourceDocIds || [])],
      references: structuredClone(editable.references || []),
      bundleLinkDefinitions: structuredClone(
        editable.bundleLinkDefinitions || [],
      ),
      triggerType: editable.triggerType || "manual",
      triggerSchedule: editable.triggerSchedule || "",
      triggerLeadDays: Number(editable.triggerLeadDays || 0),
      triggerEnabled: editable.triggerEnabled !== false,
      taskDefinitions: structuredClone(editable.taskDefinitions || []),
    };
  }

  function newRuntimeTemplateDraft() {
    return runtimeTemplateDefinition({
      name: "New card template",
      type: "workflow",
      triggerType: "manual",
      triggerEnabled: true,
      taskDefinitions: [
        { refId: "first-task", description: "First task", offsetDays: 0 },
      ],
    });
  }

  function runtimeDraftDirty() {
    return (
      Boolean(runtimeState.draft && runtimeState.baseline) &&
      JSON.stringify(runtimeState.draft) !==
        JSON.stringify(runtimeState.baseline)
    );
  }

  function setRuntimeEditorState(state, feedback = "") {
    runtimeState.editorState = state;
    runtimeState.feedback = feedback;
    const status = document.querySelector("[data-template-save-state]");
    if (status) {
      status.dataset.state = state;
      status.textContent = runtimeTemplateStateLabel();
    }
    const feedbackNode = document.querySelector(".runtime-template-feedback");
    if (feedbackNode) {
      feedbackNode.textContent = feedback;
      feedbackNode.classList.toggle(
        "is-error",
        [
          "validation",
          "permission-error",
          "network-error",
          "conflict",
          "delete-blocked",
        ].includes(state),
      );
    }
  }

  function runtimeTemplateStateLabel() {
    const labels = {
      clean:
        runtimeState.selectedId === "__new__"
          ? "Not yet saved"
          : "No unsaved changes",
      dirty: "Unsaved changes",
      saving: "Saving…",
      saved: "Saved",
      validation: "Fix validation errors",
      "permission-error": "Permission error",
      "network-error": "Save failed",
      conflict: "Conflict — draft preserved",
      "delete-blocked": "Delete blocked",
    };
    return labels[runtimeState.editorState] || "Saved";
  }

  function markRuntimeDraftChanged() {
    runtimeState.conflict = null;
    runtimeState.fieldErrors = {};
    document
      .querySelectorAll(".runtime-field-error")
      .forEach((message) => message.remove());
    document
      .querySelectorAll(".runtime-template-form [aria-invalid='true']")
      .forEach((control) => control.removeAttribute("aria-invalid"));
    setRuntimeEditorState(runtimeDraftDirty() ? "dirty" : "clean");
    const advanced = document.querySelector(".runtime-template-json");
    if (advanced) advanced.value = JSON.stringify(runtimeState.draft, null, 2);
  }

  async function confirmLeaveRuntimeDraft() {
    if (!runtimeDraftDirty()) return true;
    const confirmed = await confirmDialog(
      "This runtime template has unsaved changes. Leave without saving them?",
      { okText: "Leave", danger: true },
    );
    if (!confirmed) return false;
    runtimeState.draft = null;
    runtimeState.baseline = null;
    runtimeState.conflict = null;
    runtimeState.fieldErrors = {};
    runtimeState.editorState = "clean";
    runtimeState.feedback = "";
    return true;
  }

  addBeforeUnloadListener((event) => {
    if (!runtimeDraftDirty()) return;
    event.preventDefault();
    event.returnValue = "";
  });

  async function refreshRuntimeTemplates(options = {}) {
    try {
      const [payload, me] = await Promise.all([
        request(workApiUrl("/api/templates")),
        request(workApiUrl("/api/me")).catch(() => ({})),
      ]);
      if (options.token && !isWorkspaceRouteFresh(options.token)) return;
      runtimeState = {
        ...runtimeState,
        loaded: true,
        templates: Array.isArray(payload) ? payload : payload.templates || [],
        isAdmin: me?.user?.role === "admin",
        error: "",
      };
    } catch (error) {
      if (options.token && !isWorkspaceRouteFresh(options.token)) return;
      runtimeState = {
        ...runtimeState,
        loaded: false,
        error: error.message || "Runtime templates could not be loaded",
      };
    }
    if (
      options.rerender &&
      getActiveTasksSection() === "templates" &&
      isOperationsHomeVisible()
    ) {
      renderTasksSurface(getAllDocuments(), "templates");
    }
  }

  function editableRuntimeTemplate(template) {
    const editable = {};
    for (const field of RUNTIME_TEMPLATE_FIELDS) {
      if (template?.[field] !== undefined) editable[field] = template[field];
    }
    return editable;
  }

  function runtimeError(key) {
    return runtimeState.fieldErrors[key] || "";
  }

  function runtimeField(labelText, value, onInput, options = {}) {
    const label = document.createElement("label");
    label.className = options.wide ? "wide" : "";
    const title = document.createElement("span");
    title.textContent = labelText;
    const control = document.createElement(
      options.multiline ? "textarea" : options.select ? "select" : "input",
    );
    if (!options.multiline && !options.select)
      control.type = options.type || "text";
    if (options.select) {
      for (const choice of options.select) {
        const option = document.createElement("option");
        option.value = typeof choice === "string" ? choice : choice.value;
        option.textContent = typeof choice === "string" ? choice : choice.label;
        control.append(option);
      }
    }
    control.value = value ?? "";
    if (options.placeholder) control.placeholder = options.placeholder;
    if (options.required) control.required = true;
    if (options.min !== undefined) control.min = String(options.min);
    control.addEventListener(options.select ? "change" : "input", () => {
      const next =
        options.type === "number"
          ? control.value === ""
            ? 0
            : Number(control.value)
          : control.value;
      onInput(next);
      markRuntimeDraftChanged();
    });
    label.append(title, control);
    const error = runtimeError(options.errorKey || "");
    if (error) {
      control.setAttribute("aria-invalid", "true");
      const message = document.createElement("small");
      message.className = "runtime-field-error";
      message.textContent = error;
      label.append(message);
    }
    return label;
  }

  function runtimeCheckbox(labelText, checked, onChange) {
    const label = document.createElement("label");
    label.className = "runtime-checkbox";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = Boolean(checked);
    input.addEventListener("change", () => {
      onChange(input.checked);
      markRuntimeDraftChanged();
    });
    label.append(input, document.createTextNode(labelText));
    return label;
  }

  function csvValues(value) {
    return String(value || "")
      .split(/[,\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function renderRuntimeMetadataFields(draft) {
    const fieldset = document.createElement("fieldset");
    fieldset.className = "runtime-fieldset runtime-grid";
    fieldset.innerHTML = "<legend>Template details</legend>";
    fieldset.append(
      runtimeField(
        "Name",
        draft.name,
        (value) => {
          draft.name = value;
        },
        { required: true, errorKey: "name" },
      ),
      runtimeField(
        "Type",
        draft.type,
        (value) => {
          draft.type = value;
        },
        { required: true, errorKey: "type" },
      ),
      runtimeField("Emoji", draft.emoji, (value) => {
        draft.emoji = value;
      }),
      runtimeField(
        "Tags",
        (draft.tags || []).join(", "),
        (value) => {
          draft.tags = csvValues(value);
        },
        { placeholder: "newsletter, weekly" },
      ),
      runtimeField(
        "Default assignee ID",
        draft.defaultAssigneeId,
        (value) => {
          draft.defaultAssigneeId = value;
        },
        { wide: true },
      ),
    );
    return fieldset;
  }

  function renderRuntimeTriggerFields(draft) {
    const fieldset = document.createElement("fieldset");
    fieldset.className = "runtime-fieldset runtime-grid";
    fieldset.innerHTML = "<legend>Trigger settings</legend>";
    fieldset.append(
      runtimeField(
        "Trigger type",
        draft.triggerType,
        (value) => {
          draft.triggerType = value;
        },
        { select: ["manual", "automatic"] },
      ),
      runtimeField(
        "Schedule",
        draft.triggerSchedule,
        (value) => {
          draft.triggerSchedule = value;
        },
        { placeholder: "0 9 * * 1" },
      ),
      runtimeField(
        "Lead time (days)",
        draft.triggerLeadDays,
        (value) => {
          draft.triggerLeadDays = value;
        },
        { type: "number", min: 0 },
      ),
      runtimeCheckbox("Trigger enabled", draft.triggerEnabled, (value) => {
        draft.triggerEnabled = value;
      }),
    );
    return fieldset;
  }

  function renderRuntimeCollection(title, key, items, createItem, renderItem) {
    const fieldset = document.createElement("fieldset");
    fieldset.className = "runtime-fieldset runtime-collection";
    const legend = document.createElement("legend");
    legend.textContent = title;
    fieldset.append(legend);
    items.forEach((item, index) => {
      const row = renderItem(item, index, key);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "runtime-remove-button";
      remove.textContent = "Remove";
      remove.setAttribute(
        "aria-label",
        `Remove ${title.toLowerCase()} item ${index + 1}`,
      );
      remove.addEventListener("click", () => {
        items.splice(index, 1);
        markRuntimeDraftChanged();
        renderTasksSurface(getAllDocuments(), "templates");
      });
      row.append(remove);
      fieldset.append(row);
    });
    const add = document.createElement("button");
    add.type = "button";
    add.className = "runtime-add-button";
    add.textContent = `Add ${title.replace(/s$/, "").toLowerCase()}`;
    add.addEventListener("click", () => {
      items.push(createItem());
      markRuntimeDraftChanged();
      renderTasksSurface(getAllDocuments(), "templates");
    });
    fieldset.append(add);
    return fieldset;
  }

  function renderRuntimePhase(phase) {
    const row = document.createElement("div");
    row.className = "runtime-collection-row runtime-grid";
    row.append(
      runtimeField("Phase ID", phase.id, (value) => {
        phase.id = value;
      }),
      runtimeField("Phase name", phase.name, (value) => {
        phase.name = value;
      }),
      runtimeField(
        "Stage",
        phase.stage || "",
        (value) => {
          phase.stage = value;
        },
        { select: ["", "preparation", "announced", "after-event", "done"] },
      ),
    );
    return row;
  }

  function renderRuntimeReference(reference) {
    const row = document.createElement("div");
    row.className = "runtime-collection-row runtime-grid";
    row.append(
      runtimeField("Reference name", reference.name, (value) => {
        reference.name = value;
      }),
      runtimeField(
        "Reference URL",
        reference.url,
        (value) => {
          reference.url = value;
        },
        { type: "url", wide: true },
      ),
    );
    return row;
  }

  function renderRuntimeBundleLink(link) {
    const row = document.createElement("div");
    row.className = "runtime-collection-row runtime-grid";
    row.append(
      runtimeField(
        "Bundle link name",
        link.name,
        (value) => {
          link.name = value;
        },
        { wide: true },
      ),
    );
    return row;
  }

  function renderRuntimeLineList(title, key, values, placeholder) {
    const fieldset = document.createElement("fieldset");
    fieldset.className = "runtime-fieldset";
    const legend = document.createElement("legend");
    legend.textContent = title;
    fieldset.append(
      legend,
      runtimeField(
        title,
        (values || []).join("\n"),
        (value) => {
          runtimeState.draft[key] = csvValues(value);
        },
        { multiline: true, placeholder, wide: true },
      ),
    );
    return fieldset;
  }

  function refIds(refs, idField) {
    return (refs || [])
      .map((ref) => ref?.[idField])
      .filter(Boolean)
      .join(", ");
  }

  function updateRefs(task, key, idField, value) {
    const existing = new Map(
      (task[key] || []).map((ref) => [ref?.[idField], ref]),
    );
    task[key] = csvValues(value).map(
      (id) => existing.get(id) || { [idField]: id },
    );
  }

  function renderRuntimeTasks(draft) {
    const fieldset = document.createElement("fieldset");
    fieldset.className = "runtime-fieldset runtime-tasks";
    const legend = document.createElement("legend");
    legend.textContent = "Ordered tasks";
    fieldset.append(legend);
    draft.taskDefinitions.forEach((task, index) =>
      fieldset.append(renderRuntimeTask(task, index, draft.taskDefinitions)),
    );
    const add = document.createElement("button");
    add.type = "button";
    add.className = "runtime-add-button";
    add.textContent = "Add task";
    add.addEventListener("click", () => {
      draft.taskDefinitions.push({
        refId: `task-${draft.taskDefinitions.length + 1}`,
        description: "New task",
        offsetDays: 0,
      });
      markRuntimeDraftChanged();
      renderTasksSurface(getAllDocuments(), "templates");
    });
    fieldset.append(add);
    const error = runtimeError("taskDefinitions");
    if (error) {
      const message = document.createElement("small");
      message.className = "runtime-field-error";
      message.textContent = error;
      fieldset.append(message);
    }
    return fieldset;
  }

  function renderRuntimeTask(task, index, tasks) {
    const card = document.createElement("fieldset");
    card.className = "runtime-task-card";
    const legend = document.createElement("legend");
    legend.textContent = `Task ${index + 1}: ${task.description || task.refId || "Untitled"}`;
    const order = document.createElement("div");
    order.className = "runtime-task-order";
    for (const [label, delta] of [
      ["Move up", -1],
      ["Move down", 1],
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.setAttribute("aria-label", `${label} task ${index + 1}`);
      button.disabled = index + delta < 0 || index + delta >= tasks.length;
      button.addEventListener("click", () => {
        const nextIndex = index + delta;
        const [moved] = tasks.splice(index, 1);
        tasks.splice(nextIndex, 0, moved);
        markRuntimeDraftChanged();
        renderTasksSurface(getAllDocuments(), "templates");
        const contextualLabel =
          nextIndex === 0 && label === "Move up"
            ? "Move down"
            : nextIndex === tasks.length - 1 && label === "Move down"
              ? "Move up"
              : label;
        document
          .querySelector(
            `[aria-label="${contextualLabel} task ${nextIndex + 1}"]`,
          )
          ?.focus();
      });
      order.append(button);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "runtime-remove-button";
    remove.textContent = "Remove task";
    remove.setAttribute("aria-label", `Remove task ${index + 1}`);
    remove.addEventListener("click", () => {
      tasks.splice(index, 1);
      markRuntimeDraftChanged();
      renderTasksSurface(getAllDocuments(), "templates");
    });
    order.append(remove);
    const grid = document.createElement("div");
    grid.className = "runtime-grid";
    const errorPrefix = `taskDefinitions.${index}`;
    grid.append(
      runtimeField(
        "Reference ID",
        task.refId,
        (value) => {
          task.refId = value;
        },
        { required: true, errorKey: `${errorPrefix}.refId` },
      ),
      runtimeField(
        "Day offset",
        task.offsetDays,
        (value) => {
          task.offsetDays = value;
        },
        { type: "number", errorKey: `${errorPrefix}.offsetDays` },
      ),
      runtimeField(
        "Description",
        task.description,
        (value) => {
          task.description = value;
        },
        {
          multiline: true,
          wide: true,
          required: true,
          errorKey: `${errorPrefix}.description`,
        },
      ),
      runtimeField("Phase", task.phase || "", (value) => {
        task.phase = value;
      }),
      runtimeField("Assignee ID", task.assigneeId || "", (value) => {
        task.assigneeId = value;
      }),
      runtimeField(
        "Instructions URL",
        task.instructionsUrl || "",
        (value) => {
          task.instructionsUrl = value;
        },
        { type: "url", wide: true },
      ),
      runtimeField(
        "Instruction document ID",
        task.instructionDocId || "",
        (value) => {
          task.instructionDocId = value;
        },
      ),
      runtimeField(
        "Instruction step",
        task.instructionStepId || "",
        (value) => {
          task.instructionStepId = value;
        },
      ),
      runtimeField("Systems", (task.systems || []).join(", "), (value) => {
        task.systems = csvValues(value);
      }),
      runtimeField(
        "Required bundle link",
        task.requiredLinkName || "",
        (value) => {
          task.requiredLinkName = value;
        },
      ),
      runtimeField(
        "Completion stage",
        task.stageOnComplete || "",
        (value) => {
          task.stageOnComplete = value;
        },
        { select: ["", "preparation", "announced", "after-event", "done"] },
      ),
    );
    const validation =
      task.validation && typeof task.validation === "object"
        ? task.validation
        : {};
    grid.append(
      runtimeField(
        "Validation guidance",
        typeof task.validation === "string" ? task.validation : "",
        (value) => {
          if (value) task.validation = value;
          else if (Object.keys(validation).length) task.validation = validation;
          else delete task.validation;
        },
        { wide: true },
      ),
      runtimeField(
        "Required bundle links",
        (validation.requiredBundleLinks || []).join(", "),
        (value) => {
          const links = csvValues(value);
          task.validation = { ...validation, requiredBundleLinks: links };
          if (!links.length) delete task.validation.requiredBundleLinks;
          if (!Object.keys(task.validation).length) delete task.validation;
        },
        { wide: true },
      ),
    );
    if (
      task.validation &&
      typeof task.validation === "object" &&
      Object.keys(task.validation).some((key) => key !== "requiredBundleLinks")
    ) {
      const preserved = document.createElement("small");
      preserved.className = "runtime-preserved-note";
      preserved.textContent =
        "Additional validation settings are preserved and visible in Advanced JSON.";
      grid.append(preserved);
    }
    const proof = task.proofRequirement || {
      type: "",
      label: "",
      required: true,
    };
    grid.append(
      runtimeField(
        "Proof type",
        proof.type || "",
        (value) => {
          if (!value) delete task.proofRequirement;
          else
            task.proofRequirement = {
              ...proof,
              type: value,
              required: proof.required !== false,
            };
        },
        {
          select: ["", "url", "file", "artifact", "comment", "external-status"],
        },
      ),
      runtimeField("Proof label", proof.label || "", (value) => {
        if (task.proofRequirement) task.proofRequirement.label = value;
      }),
      runtimeCheckbox("Proof required", proof.required !== false, (value) => {
        if (task.proofRequirement) task.proofRequirement.required = value;
      }),
      runtimeCheckbox("Milestone", task.isMilestone, (value) => {
        task.isMilestone = value;
      }),
      runtimeCheckbox("Required file", task.requiresFile, (value) => {
        task.requiresFile = value;
      }),
      runtimeField(
        "Artifact reference IDs",
        refIds(task.artifactRefs, "artifactId"),
        (value) => updateRefs(task, "artifactRefs", "artifactId", value),
        { wide: true },
      ),
      runtimeField(
        "Assistant job reference IDs",
        refIds(task.assistantJobRefs, "assistantJobId"),
        (value) =>
          updateRefs(task, "assistantJobRefs", "assistantJobId", value),
        { wide: true },
      ),
      runtimeField(
        "Audit event reference IDs",
        refIds(task.auditEventRefs, "auditEventId"),
        (value) => updateRefs(task, "auditEventRefs", "auditEventId", value),
        { wide: true },
      ),
      runtimeField(
        "Intake reference IDs",
        refIds(task.intakeRefs, "intakeItemId"),
        (value) => updateRefs(task, "intakeRefs", "intakeItemId", value),
        { wide: true },
      ),
    );
    card.append(legend, order, grid);
    return card;
  }

  function validateRuntimeTemplateDraft(draft) {
    const errors = {};
    if (!String(draft.name || "").trim()) errors.name = "Name is required.";
    if (!String(draft.type || "").trim()) errors.type = "Type is required.";
    if (!Array.isArray(draft.taskDefinitions) || !draft.taskDefinitions.length)
      errors.taskDefinitions = "Add at least one task.";
    (draft.taskDefinitions || []).forEach((task, index) => {
      if (!String(task.refId || "").trim())
        errors[`taskDefinitions.${index}.refId`] = "Reference ID is required.";
      if (!String(task.description || "").trim())
        errors[`taskDefinitions.${index}.description`] =
          "Description is required.";
      if (!Number.isFinite(Number(task.offsetDays)))
        errors[`taskDefinitions.${index}.offsetDays`] =
          "Day offset must be a number.";
    });
    return errors;
  }

  function renderRuntimeTemplateAdmin() {
    const section = document.createElement("section");
    section.className = "ops-section runtime-template-admin";
    section.classList.toggle("has-selection", Boolean(runtimeState.selectedId));
    const header = document.createElement("div");
    header.className = "ops-section-header";
    header.innerHTML = `<div><h3>Template administration</h3><span>Templates define the tasks used when a Card is created.</span></div>`;
    if (runtimeState.isAdmin) {
      const add = document.createElement("button");
      add.type = "button";
      add.className = "primary-button";
      add.textContent = "New runtime template";
      add.addEventListener("click", async () => {
        if (!(await confirmLeaveRuntimeDraft())) return;
        navigateCanonicalWorkspace(
          "/templates",
          {},
          { entity: { templateId: "__new__" } },
        );
      });
      header.append(add);
    }
    section.append(header);

    if (runtimeState.error) {
      section.append(
        renderHonestState("Runtime templates unavailable", runtimeState.error),
      );
      return section;
    }
    if (!runtimeState.loaded) {
      section.append(
        renderHonestState(
          "Loading runtime templates",
          "Fetching the current database-backed template definitions.",
        ),
      );
      return section;
    }

    const search = document.createElement("input");
    search.type = "search";
    search.className = "runtime-template-search";
    search.placeholder = "Search runtime templates";
    search.value = runtimeState.search;
    search.addEventListener(
      "input",
      debounce(() => {
        runtimeState.search = search.value.trim().toLowerCase();
        renderTasksSurface(getAllDocuments(), "templates");
      }, 150),
    );
    section.append(search);

    const layout = document.createElement("div");
    layout.className = "runtime-template-layout";
    layout.classList.toggle("is-detail", Boolean(runtimeState.selectedId));
    const list = document.createElement("div");
    list.className = "runtime-template-list";
    const templates = runtimeState.templates.filter((template) => {
      const haystack = [
        template.name,
        template.type,
        template.triggerType,
        ...(template.tags || []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return !runtimeState.search || haystack.includes(runtimeState.search);
    });
    if (!templates.length)
      list.append(
        renderHonestState(
          "No runtime templates match",
          "Create a template or broaden the search.",
        ),
      );
    for (const template of templates) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `runtime-template-row ${template.id === runtimeState.selectedId ? "is-selected" : ""}`;
      button.innerHTML = `
        <strong>
          ${escapeHtml(
            template.emoji
              ? `${template.emoji} ${template.name}`
              : template.name || "Unnamed template",
          )}
        </strong>
        <span>
          ${escapeHtml(template.type || "untyped")}
          · ${countLabel((template.taskDefinitions || []).length, "task")}
          · ${escapeHtml(template.triggerType || "manual")}
        </span>
      `;
      button.addEventListener("click", async () => {
        if (template.id === runtimeState.selectedId) return;
        if (!(await confirmLeaveRuntimeDraft())) return;
        navigateCanonicalWorkspace("/templates", { templateId: template.id });
      });
      list.append(button);
    }
    layout.append(list, renderRuntimeTemplateEditor());
    section.append(layout);
    return section;
  }

  function renderRuntimeTemplateBackButton() {
    const back = document.createElement("button");
    back.type = "button";
    back.className = "runtime-mobile-back";
    back.textContent = "Back to template list";
    back.addEventListener("click", async () => {
      if (!(await confirmLeaveRuntimeDraft())) return;
      runtimeState.draft = null;
      runtimeState.baseline = null;
      runtimeState.conflict = null;
      runtimeState.editorState = "clean";
      runtimeState.feedback = "";
      runtimeState.fieldErrors = {};
      await navigateCanonicalWorkspace(
        "/templates",
        {},
        {
          restoreFocus: { kind: "runtime-template-list" },
        },
      ).ready;
    });
    return back;
  }

  function appendRuntimeDefinitionRow(list, labelText, valueText) {
    const term = document.createElement("dt");
    term.textContent = labelText;
    const value = document.createElement("dd");
    value.textContent = valueText || "None";
    list.append(term, value);
  }

  function renderRuntimeTemplateReadOnly(selected) {
    const view = document.createElement("div");
    view.className = "runtime-template-readonly";
    const header = document.createElement("header");
    const title = document.createElement("div");
    const heading = document.createElement("h4");
    heading.textContent = selected.emoji
      ? `${selected.emoji} ${selected.name}`
      : selected.name || selected.id;
    const guidance = document.createElement("p");
    guidance.textContent =
      "Read-only definition. Admin permission is required to change it.";
    title.append(heading, guidance);
    const start = document.createElement("button");
    start.type = "button";
    start.className = "primary-button";
    start.textContent = "Create card";
    start.addEventListener("click", () =>
      openQuickWorkflowForm({
        template: {
          ...selected,
          templateId: selected.id,
          title: selected.name,
        },
      }),
    );
    header.append(title, start);

    const definition = document.createElement("dl");
    definition.className = "runtime-template-definition";
    appendRuntimeDefinitionRow(definition, "Type", selected.type || "untyped");
    appendRuntimeDefinitionRow(
      definition,
      "Trigger",
      [selected.triggerType || "manual", selected.triggerSchedule]
        .filter(Boolean)
        .join(" · "),
    );
    appendRuntimeDefinitionRow(
      definition,
      "Tasks",
      countLabel((selected.taskDefinitions || []).length, "task"),
    );
    appendRuntimeDefinitionRow(
      definition,
      "Tags",
      (selected.tags || []).join(", "),
    );
    appendRuntimeDefinitionRow(
      definition,
      "Default assignee",
      selected.defaultAssigneeId || "Unassigned",
    );
    appendRuntimeDefinitionRow(
      definition,
      "Source documents",
      (selected.sourceDocIds || []).join(", "),
    );

    const tasks = document.createElement("section");
    const taskHeading = document.createElement("h5");
    taskHeading.textContent = "Ordered tasks";
    const taskList = document.createElement("ol");
    taskList.className = "runtime-template-readonly-tasks";
    for (const task of selected.taskDefinitions || []) {
      const item = document.createElement("li");
      const description = document.createElement("strong");
      description.textContent =
        task.description || task.refId || "Untitled task";
      const meta = document.createElement("span");
      meta.textContent = [
        task.refId,
        `day ${Number(task.offsetDays || 0) >= 0 ? "+" : ""}${Number(task.offsetDays || 0)}`,
        task.phase,
        task.isMilestone ? "milestone" : "",
      ]
        .filter(Boolean)
        .join(" · ");
      item.append(description, meta);
      taskList.append(item);
    }
    if (!taskList.children.length) {
      const empty = document.createElement("li");
      empty.textContent =
        "No task definitions. This Template cannot create a useful Card yet.";
      taskList.append(empty);
    }
    tasks.append(taskHeading, taskList);

    const references = document.createElement("section");
    const referencesHeading = document.createElement("h5");
    referencesHeading.textContent = "References and required links";
    const referencesBody = document.createElement("p");
    referencesBody.textContent =
      [
        ...(selected.references || []).map(
          (reference) => reference.name || reference.url,
        ),
        ...(selected.bundleLinkDefinitions || []).map((link) => link.name),
      ]
        .filter(Boolean)
        .join(" · ") || "None configured";
    references.append(referencesHeading, referencesBody);
    view.append(header, definition, tasks, references);
    return view;
  }

  function renderRuntimeTemplateEditor() {
    const editor = document.createElement("div");
    editor.className = "runtime-template-editor";
    const workspaceEntityState = getWorkspaceEntityState();
    if (
      workspaceEntityState?.kind === "template" &&
      ["not-found", "error"].includes(workspaceEntityState.status)
    ) {
      renderEntityLoadState(editor, {
        ...workspaceEntityState,
        retry: () => {
          const route = getActiveWorkspaceRoute();
          navigateCanonicalWorkspace(route.path, route.params, {
            history: "none",
          });
        },
        returnToList: () => {
          navigateCanonicalWorkspace("/templates");
        },
      });
      return editor;
    }
    const creating = runtimeState.selectedId === "__new__";
    const selected = runtimeState.templates.find(
      (template) => template.id === runtimeState.selectedId,
    );
    if (!creating && !selected) {
      editor.append(
        renderHonestState(
          runtimeState.isAdmin ? "Template editor" : "Runtime templates",
          runtimeState.isAdmin
            ? "Select a runtime template to edit its complete validated definition."
            : "Operators can inspect and instantiate templates. Template administration is restricted to admins.",
        ),
      );
      return editor;
    }
    if (!runtimeState.isAdmin) {
      editor.append(
        renderRuntimeTemplateBackButton(),
        renderRuntimeTemplateReadOnly(selected),
      );
      return editor;
    }
    if (!runtimeState.draft) {
      runtimeState.draft = creating
        ? newRuntimeTemplateDraft()
        : runtimeTemplateDefinition(selected);
      runtimeState.baseline = structuredClone(runtimeState.draft);
    }
    const value = runtimeState.draft;
    editor.append(renderRuntimeTemplateBackButton());
    const heading = document.createElement("h4");
    heading.textContent = creating
      ? "New runtime template"
      : `Edit ${selected.name || selected.id}`;
    const guidance = document.createElement("p");
    guidance.textContent =
      "Use the structured fields below. Task order becomes the Card checklist order; Advanced JSON is a read-only review of the normalized draft.";
    const saveState = document.createElement("span");
    saveState.className = "runtime-template-save-state";
    saveState.dataset.templateSaveState = "";
    saveState.dataset.state = runtimeState.editorState;
    saveState.setAttribute("role", "status");
    saveState.setAttribute("aria-live", "polite");
    saveState.textContent = runtimeTemplateStateLabel();

    const form = document.createElement("div");
    form.className = "runtime-template-form";
    form.append(
      renderRuntimeMetadataFields(value),
      renderRuntimeTriggerFields(value),
    );
    form.append(
      renderRuntimeCollection(
        "Phases",
        "phases",
        value.phases,
        () => ({ id: "new-phase", name: "New phase", stage: "preparation" }),
        renderRuntimePhase,
      ),
    );
    form.append(
      renderRuntimeLineList(
        "Source document IDs",
        "sourceDocIds",
        value.sourceDocIds,
        "One document ID per line",
      ),
    );
    form.append(
      renderRuntimeCollection(
        "References",
        "references",
        value.references,
        () => ({ name: "New reference", url: "" }),
        renderRuntimeReference,
      ),
    );
    form.append(
      renderRuntimeCollection(
        "Bundle links",
        "bundleLinkDefinitions",
        value.bundleLinkDefinitions,
        () => ({ name: "New link" }),
        renderRuntimeBundleLink,
      ),
    );
    form.append(renderRuntimeTasks(value));

    const advanced = document.createElement("details");
    advanced.className = "runtime-template-advanced";
    const advancedSummary = document.createElement("summary");
    advancedSummary.textContent = "Advanced JSON";
    const textarea = document.createElement("textarea");
    textarea.className = "runtime-template-json";
    textarea.readOnly = true;
    textarea.setAttribute(
      "aria-label",
      "Normalized runtime template JSON (read only)",
    );
    textarea.value = JSON.stringify(value, null, 2);
    advanced.append(advancedSummary, textarea);
    const feedback = document.createElement("p");
    feedback.className = "runtime-template-feedback";
    feedback.setAttribute("role", "alert");
    feedback.textContent = runtimeState.feedback;
    feedback.classList.toggle(
      "is-error",
      [
        "validation",
        "permission-error",
        "network-error",
        "conflict",
        "delete-blocked",
      ].includes(runtimeState.editorState),
    );
    const actions = document.createElement("div");
    actions.className = "runtime-template-actions";
    const destructiveActions = document.createElement("div");
    destructiveActions.className = "runtime-template-destructive";
    const save = document.createElement("button");
    save.type = "button";
    save.className = "primary-button";
    save.textContent = creating ? "Create template" : "Save template";
    save.disabled = runtimeState.editorState === "saving";
    save.addEventListener("click", async () => {
      const errors = validateRuntimeTemplateDraft(value);
      runtimeState.fieldErrors = errors;
      if (Object.keys(errors).length) {
        setRuntimeEditorState(
          "validation",
          "Review the highlighted fields before saving.",
        );
        renderTasksSurface(getAllDocuments(), "templates");
        document
          .querySelector(".runtime-field-error")
          ?.closest("label, fieldset")
          ?.querySelector("input, textarea, select")
          ?.focus();
        return;
      }
      if (runtimeState.editorState === "saving") return;
      setRuntimeEditorState(
        "saving",
        creating ? "Creating template…" : "Saving template…",
      );
      save.disabled = true;
      const payload = runtimeTemplateDefinition(value);
      if (!creating) payload.expectedVersion = selected.version;
      try {
        const response = await request(
          workApiUrl(
            creating
              ? "/api/templates"
              : `/api/templates/${encodeURIComponent(selected.id)}`,
          ),
          {
            method: creating ? "POST" : "PUT",
            body: JSON.stringify(payload),
          },
        );
        const saved = response.template || response;
        runtimeState.templates = runtimeState.templates
          .filter((item) => item.id !== saved.id)
          .concat(saved);
        runtimeState.selectedId = saved.id;
        runtimeState.draft = runtimeTemplateDefinition(saved);
        runtimeState.baseline = structuredClone(runtimeState.draft);
        runtimeState.conflict = null;
        runtimeState.fieldErrors = {};
        runtimeState.editorState = "saved";
        runtimeState.feedback = `Saved version ${saved.version}.`;
        setStatus(
          creating ? "Runtime template created." : "Runtime template saved.",
        );
        if (runtimeState.selectedId) {
          await navigateCanonicalWorkspace(
            "/templates",
            { templateId: runtimeState.selectedId },
            { hydrate: false },
          ).ready;
        }
      } catch (error) {
        save.disabled = false;
        if (error.status === 409) {
          runtimeState.conflict = error.payload || {};
          setRuntimeEditorState(
            "conflict",
            `A newer server version${error.payload?.currentVersion ? ` (${error.payload.currentVersion})` : ""} exists. Your draft is preserved.`,
          );
          renderTasksSurface(getAllDocuments(), "templates");
        } else {
          setRuntimeEditorState(
            [401, 403].includes(error.status)
              ? "permission-error"
              : "network-error",
            error.message || "Template save failed. Your draft is preserved.",
          );
        }
      }
    });
    actions.append(save);
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel changes";
    cancel.addEventListener("click", async () => {
      if (
        runtimeDraftDirty() &&
        !(await confirmDialog("Discard the unsaved template changes?", {
          okText: "Discard",
          danger: true,
        }))
      )
        return;
      runtimeState.draft = structuredClone(runtimeState.baseline);
      runtimeState.fieldErrors = {};
      runtimeState.conflict = null;
      runtimeState.editorState = "clean";
      runtimeState.feedback = "";
      renderTasksSurface(getAllDocuments(), "templates");
    });
    actions.append(cancel);
    if (runtimeState.editorState === "conflict" && !creating) {
      const reload = document.createElement("button");
      reload.type = "button";
      reload.textContent = "Reload server version";
      reload.addEventListener("click", async () => {
        if (
          !(await confirmDialog(
            "Replace this local draft with the current server version?",
            { okText: "Reload", danger: true },
          ))
        )
          return;
        const response = await request(
          workApiUrl(`/api/templates/${encodeURIComponent(selected.id)}`),
        );
        const current = response.template || response;
        runtimeState.templates = runtimeState.templates.map((item) =>
          item.id === current.id ? current : item,
        );
        runtimeState.draft = runtimeTemplateDefinition(current);
        runtimeState.baseline = structuredClone(runtimeState.draft);
        runtimeState.editorState = "clean";
        runtimeState.feedback = `Reloaded version ${current.version}.`;
        runtimeState.conflict = null;
        renderTasksSurface(getAllDocuments(), "templates");
      });
      actions.append(reload);
    }
    if (!creating) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger-button";
      remove.textContent = "Delete template";
      remove.addEventListener("click", async () => {
        if (
          !(await confirmDialog(
            `Delete runtime template “${selected.name || selected.id}”? Referenced templates cannot be deleted.`,
            { okText: "Delete", danger: true },
          ))
        )
          return;
        try {
          await request(
            workApiUrl(`/api/templates/${encodeURIComponent(selected.id)}`),
            {
              method: "DELETE",
              body: JSON.stringify({ expectedVersion: selected.version }),
            },
          );
          runtimeState.selectedId = null;
          runtimeState.draft = null;
          runtimeState.baseline = null;
          setStatus("Runtime template deleted.");
          await navigateCanonicalWorkspace("/templates").ready;
        } catch (error) {
          if (error.payload?.code === "template_in_use") {
            const categories = Object.entries(
              error.payload.references?.categories || {},
            )
              .map(([name, count]) => referenceCountLabel(name, count))
              .join(", ");
            setRuntimeEditorState(
              "delete-blocked",
              `This template is still referenced${categories ? ` by ${categories}` : ""}. Remove those references before deleting.`,
            );
          } else if (error.status === 409) {
            runtimeState.conflict = error.payload || {};
            setRuntimeEditorState(
              "conflict",
              "The template changed before deletion. Your draft is preserved.",
            );
            renderTasksSurface(getAllDocuments(), "templates");
          } else {
            setRuntimeEditorState(
              [401, 403].includes(error.status)
                ? "permission-error"
                : "network-error",
              error.message || "Template deletion failed",
            );
          }
        }
      });
      destructiveActions.append(remove);
    }
    const editorHeader = document.createElement("header");
    editorHeader.append(heading, saveState);
    editor.append(editorHeader, guidance, actions, feedback, form, advanced);
    if (destructiveActions.children.length) editor.append(destructiveActions);
    return editor;
  }

  function openQuickTaskForm() {
    const overlay = createQuickFormOverlay("New task");
    const form = document.createElement("div");
    form.className = "quick-form";

    const descInput = createQuickInput("What needs doing?", "text", "");
    const dateInput = createQuickInput("Due date", "date", todayIsoDate());

    const createBtn = document.createElement("button");
    createBtn.type = "button";
    createBtn.className = "task-action-btn is-primary";
    createBtn.textContent = "Create task";
    createBtn.addEventListener("click", async () => {
      const description = descInput.input.value.trim();
      const date = dateInput.input.value;
      if (!description) {
        reportError("Task description is required.");
        return;
      }
      if (!date) {
        reportError("Due date is required.");
        return;
      }
      createBtn.disabled = true;
      createBtn.textContent = "Creating...";
      try {
        const created = await request(workApiUrl("/api/tasks"), {
          method: "POST",
          body: JSON.stringify({ description, date }),
        });
        overlay.remove();
        const task = created?.task || created;
        if (task?.id) openTaskPanel(task.id);
        refreshOperationsWorkSnapshot({ rerender: true });
      } catch (err) {
        reportError(
          `Could not create task: ${err.message || "request failed"}`,
        );
        createBtn.disabled = false;
        createBtn.textContent = "Create task";
      }
    });

    form.append(descInput.label, dateInput.label, createBtn);
    overlay.querySelector(".quick-form-body").append(form);
  }

  async function openQuickWorkflowForm(options = {}) {
    const requestedTemplate = options.template || null;
    const overlay = createQuickFormOverlay("Create card");
    const form = document.createElement("div");
    form.className = "quick-form";

    const selectLabel = document.createElement("label");
    selectLabel.className = "quick-form-label";
    selectLabel.textContent = "Template";
    const templateSelect = document.createElement("select");
    templateSelect.className = "quick-form-select";
    const loadingOpt = document.createElement("option");
    loadingOpt.value = "";
    loadingOpt.textContent = "Loading templates...";
    templateSelect.append(loadingOpt);
    templateSelect.disabled = true;
    selectLabel.append(templateSelect);

    const anchorInput = createQuickInput("Anchor date", "date", todayIsoDate());
    const titleInput = createQuickInput("Card title (optional)", "text", "");

    const createBtn = document.createElement("button");
    createBtn.type = "button";
    createBtn.className = "task-action-btn is-primary";
    createBtn.textContent = "Create card";
    createBtn.disabled = true;

    form.append(selectLabel, titleInput.label, anchorInput.label, createBtn);
    overlay.querySelector(".quick-form-body").append(form);

    // Fetch live templates from the backend API (UUIDs, not doc slugs)
    let liveTemplates = [];
    try {
      const payload = await request(workApiUrl("/api/templates"));
      liveTemplates = Array.isArray(payload)
        ? payload
        : payload.templates || [];
    } catch {
      liveTemplates = [];
    }

    templateSelect.replaceChildren();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Select template...";
    templateSelect.append(placeholder);
    for (const template of liveTemplates) {
      const opt = document.createElement("option");
      opt.value = template.id;
      opt.textContent = template.name || template.title || template.id;
      templateSelect.append(opt);
    }
    const matchedTemplate = findLiveWorkflowTemplate(
      liveTemplates,
      requestedTemplate,
    );
    if (matchedTemplate?.id) {
      templateSelect.value = matchedTemplate.id;
      if (!titleInput.input.value && requestedTemplate?.title)
        titleInput.input.value = requestedTemplate.title;
    }
    templateSelect.disabled = false;
    if (liveTemplates.length > 0) createBtn.disabled = false;
    else {
      const emptyOpt = document.createElement("option");
      emptyOpt.textContent = "No templates available";
      templateSelect.append(emptyOpt);
    }

    createBtn.addEventListener("click", async () => {
      const templateId = templateSelect.value;
      const anchorDate = anchorInput.input.value;
      if (!templateId) {
        reportError("Select a template.");
        return;
      }
      if (!anchorDate) {
        reportError("Anchor date is required.");
        return;
      }
      createBtn.disabled = true;
      createBtn.textContent = "Starting...";
      try {
        const body = { templateId, anchorDate };
        const title = titleInput.input.value.trim();
        if (title) body.title = title;
        const result = await request(workApiUrl("/api/bundles"), {
          method: "POST",
          body: JSON.stringify(body),
        });
        const bundle = result?.bundle || result;
        overlay.remove();
        if (bundle?.id) openBundlePanel(bundle.id);
        await refreshOperationsWorkSnapshot({ rerender: true });
      } catch (err) {
        reportError(
          `Could not create card: ${err.message || "request failed"}`,
        );
        createBtn.disabled = false;
        createBtn.textContent = "Create card";
      }
    });
  }

  function findLiveWorkflowTemplate(liveTemplates, requestedTemplate) {
    if (!requestedTemplate || !Array.isArray(liveTemplates)) return null;
    const wantedId = normalizeTemplateMatchValue(
      requestedTemplate.templateId ||
        requestedTemplate.sourceTemplateId ||
        requestedTemplate.canonicalTemplateId,
    );
    if (wantedId) {
      const idMatches = liveTemplates.filter(
        (template) => normalizeTemplateMatchValue(template.id) === wantedId,
      );
      return idMatches.length === 1 ? idMatches[0] : null;
    }

    const wantedSlug = normalizeTemplateMatchValue(
      requestedTemplate.slug || requestedTemplate.type,
    );
    if (!wantedSlug) return null;
    const slugMatches = liveTemplates.filter((template) => {
      const templateSlug = normalizeTemplateMatchValue(
        template.slug || template.type,
      );
      return templateSlug === wantedSlug;
    });
    return slugMatches.length === 1 ? slugMatches[0] : null;
  }

  function normalizeTemplateMatchValue(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/\s+task template$/i, "")
      .replace(/&/g, "and")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function openQuickRecurringForm() {
    const overlay = createQuickFormOverlay("New recurring operation");
    const form = document.createElement("div");
    form.className = "quick-form";

    const descriptionInput = createQuickInput("Description", "text", "");
    const scheduleLabel = document.createElement("label");
    scheduleLabel.className = "quick-form-label";
    scheduleLabel.textContent = "Schedule";
    const scheduleSelect = document.createElement("select");
    scheduleSelect.className = "quick-form-select";
    for (const [value, label] of [
      ["daily", "Daily"],
      ["weekly", "Weekly"],
      ["monthly", "Monthly"],
    ]) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = label;
      scheduleSelect.append(opt);
    }
    scheduleLabel.append(scheduleSelect);

    const timeInput = createQuickInput("Time", "time", "09:00");
    const weekday = createQuickSelect(
      "Weekday",
      [
        ["1", "Monday"],
        ["2", "Tuesday"],
        ["3", "Wednesday"],
        ["4", "Thursday"],
        ["5", "Friday"],
        ["6", "Saturday"],
        ["0", "Sunday"],
      ],
      "1",
    );
    const monthDay = createQuickInput("Day of month", "number", "1");
    monthDay.input.min = "1";
    monthDay.input.max = "31";
    const enabled = createQuickCheckbox("Enabled", true);

    const syncScheduleFields = () => {
      weekday.label.hidden = scheduleSelect.value !== "weekly";
      monthDay.label.hidden = scheduleSelect.value !== "monthly";
    };
    scheduleSelect.addEventListener("change", syncScheduleFields);
    syncScheduleFields();

    const createBtn = document.createElement("button");
    createBtn.type = "button";
    createBtn.className = "task-action-btn is-primary";
    createBtn.textContent = "Create recurring";
    createBtn.addEventListener("click", async () => {
      const description = descriptionInput.input.value.trim();
      if (!description) {
        reportError("Recurring description is required.");
        return;
      }
      const cronExpression = cronExpressionFromRecurringForm(
        scheduleSelect.value,
        timeInput.input.value,
        weekday.input.value,
        monthDay.input.value,
      );
      if (!cronExpression) return;
      createBtn.disabled = true;
      createBtn.textContent = "Creating...";
      try {
        await request(workApiUrl("/api/recurring"), {
          method: "POST",
          body: JSON.stringify({
            description,
            cronExpression,
            enabled: enabled.input.checked,
          }),
        });
        overlay.remove();
        await refreshOperationsRecurringSnapshot({ rerender: true });
      } catch (err) {
        reportError(
          `Could not create recurring operation: ${err.message || "request failed"}`,
        );
        createBtn.disabled = false;
        createBtn.textContent = "Create recurring";
      }
    });

    form.append(
      descriptionInput.label,
      scheduleLabel,
      timeInput.label,
      weekday.label,
      monthDay.label,
      enabled.label,
      createBtn,
    );
    overlay.querySelector(".quick-form-body").append(form);
  }

  function createQuickInput(labelText, type, value) {
    const label = document.createElement("label");
    label.className = "quick-form-label";
    label.textContent = labelText;
    const input = document.createElement("input");
    input.type = type;
    input.value = value;
    label.append(input);
    return { label, input };
  }

  function createQuickSelect(labelText, options, value) {
    const label = document.createElement("label");
    label.className = "quick-form-label";
    label.textContent = labelText;
    const input = document.createElement("select");
    input.className = "quick-form-select";
    for (const [optionValue, optionLabel] of options) {
      const opt = document.createElement("option");
      opt.value = optionValue;
      opt.textContent = optionLabel;
      if (optionValue === value) opt.selected = true;
      input.append(opt);
    }
    label.append(input);
    return { label, input };
  }

  function createQuickCheckbox(labelText, checked) {
    const label = document.createElement("label");
    label.className = "quick-form-label quick-form-checkbox";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = Boolean(checked);
    label.append(input, document.createTextNode(labelText));
    return { label, input };
  }

  function cronExpressionFromRecurringForm(
    schedule,
    timeValue,
    weekday,
    dayOfMonth,
  ) {
    const time = String(timeValue || "").match(/^(\d{2}):(\d{2})$/);
    if (!time) {
      reportError("Choose a valid time.");
      return "";
    }
    const hour = Number(time[1]);
    const minute = Number(time[2]);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      reportError("Choose a valid time.");
      return "";
    }
    if (schedule === "daily") return `${minute} ${hour} * * *`;
    if (schedule === "weekly") {
      const day = Number(weekday);
      if (day < 0 || day > 6) {
        reportError("Choose a valid weekday.");
        return "";
      }
      return `${minute} ${hour} * * ${day}`;
    }
    if (schedule === "monthly") {
      const day = Number(dayOfMonth);
      if (day < 1 || day > 31) {
        reportError("Choose a valid day of month.");
        return "";
      }
      return `${minute} ${hour} ${day} * *`;
    }
    reportError("Choose a recurring schedule.");
    return "";
  }

  function createQuickFormOverlay(titleText) {
    const overlay = document.createElement("div");
    overlay.className = "quick-form-overlay confirm-modal";
    overlay.hidden = false;

    const backdrop = document.createElement("div");
    backdrop.className = "confirm-backdrop";
    backdrop.addEventListener("click", () => overlay.remove());

    const panel = document.createElement("div");
    panel.className = "confirm-panel quick-form-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");

    const header = document.createElement("div");
    header.className = "diff-header";
    const title = document.createElement("strong");
    title.textContent = titleText;
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "quiet-button";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", () => overlay.remove());
    header.append(title, closeBtn);

    const body = document.createElement("div");
    body.className = "quick-form-body";

    panel.append(header, body);
    overlay.append(backdrop, panel);
    shellBody.append(overlay);
    return overlay;
  }

  function renderRecurringOperationsSection(recurring) {
    const section = document.createElement("section");
    section.className = "ops-section ops-recurring-section";
    section.setAttribute("aria-label", "Recurring operations");

    const header = document.createElement("div");
    header.className = "ops-section-header";
    const title = document.createElement("h3");
    title.textContent = "Recurring Operations";
    const meta = document.createElement("span");
    const enabled = recurring?.enabled?.length || 0;
    const paused = recurring?.disabled?.length || 0;
    meta.textContent = recurring?.loaded
      ? `${enabled} enabled - ${paused} paused`
      : "Not loaded";
    header.append(title, meta);

    const generate = document.createElement("button");
    generate.type = "button";
    generate.className = "ops-quick-btn";
    generate.textContent = "Generate today";
    generate.addEventListener("click", () =>
      generateRecurringTasksForToday(generate),
    );
    header.append(generate);
    section.append(header);

    const list = document.createElement("div");
    list.className = "ops-recurring-list";
    const configs = Array.isArray(recurring?.configs)
      ? recurring.configs.slice(0, 6)
      : [];
    if (configs.length === 0) {
      const empty = document.createElement("p");
      empty.className = "ops-empty";
      empty.textContent = recurring?.errors?.length
        ? "Recurring configs could not be loaded."
        : "No recurring configs yet.";
      list.append(empty);
    } else {
      for (const config of configs)
        list.append(renderRecurringConfigItem(config));
    }
    section.append(list);
    return section;
  }

  function renderRecurringConfigItem(config) {
    const item = document.createElement("div");
    item.className = "ops-recurring-item";
    if (config.enabled === false) item.classList.add("is-paused");

    const text = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = recurringConfigTitle(config);
    const meta = document.createElement("span");
    meta.textContent = formatRecurringSchedule(config.cronExpression || "");
    text.append(title, meta);

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "task-action-btn";
    toggle.textContent = config.enabled === false ? "Resume" : "Pause";
    toggle.addEventListener("click", () =>
      toggleRecurringConfig(config.id, config.enabled === false, toggle),
    );

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "task-action-btn danger-button";
    remove.textContent = "Delete schedule";
    remove.setAttribute(
      "aria-label",
      `Delete recurring schedule ${recurringConfigTitle(config)}`,
    );
    remove.addEventListener("click", () =>
      deleteRecurringConfigFromUi(config, remove),
    );

    const actions = document.createElement("div");
    actions.className = "recurring-row-actions";
    actions.append(toggle, remove);
    item.append(text, actions);
    const error = recurringDeleteErrors.get(config.id);
    if (error) {
      const guidance = document.createElement("p");
      guidance.className = "recurring-delete-guidance";
      guidance.setAttribute("role", "alert");
      guidance.tabIndex = -1;
      guidance.textContent = error;
      item.append(guidance);
    }
    return item;
  }

  async function deleteRecurringConfigFromUi(config, button) {
    const confirmed = await confirmDialog(
      `Delete recurring schedule “${recurringConfigTitle(config)}”? This removes only the schedule. Tasks already generated from it are never deleted.`,
      { okText: "Delete schedule", danger: true },
    );
    if (!confirmed) return;
    button.disabled = true;
    button.textContent = "Deleting…";
    try {
      await request(
        workApiUrl(`/api/recurring/${encodeURIComponent(config.id)}`),
        { method: "DELETE" },
      );
      recurringDeleteErrors.delete(config.id);
      await refreshOperationsRecurringSnapshot({ rerender: true });
    } catch (error) {
      const message =
        error.status === 409
          ? "This schedule has generated history and cannot be deleted. Pause it instead; generated tasks and notifications are preserved."
          : `${error.message || "Could not delete this schedule"} Select Delete schedule to retry.`;
      recurringDeleteErrors.set(config.id, message);
      await refreshOperationsRecurringSnapshot({ rerender: true });
      scheduleAnimationFrame(() =>
        document
          .querySelector(".recurring-delete-guidance[role='alert']")
          ?.focus(),
      );
    }
  }

  function renderWorkflowTemplateCard(template) {
    const card = document.createElement("article");
    card.className = "ops-template-card";

    const title = document.createElement("strong");
    title.textContent = template.title;
    const summary = document.createElement("span");
    summary.textContent = template.summary;
    const chips = document.createElement("div");
    chips.className = "ops-card-chips";
    const chipValues = [
      template.recurring ? "Recurring" : "Manual",
      template.atRisk ? "Watch" : "",
      ...template.tags.slice(0, 2),
    ].filter(Boolean);
    for (const value of chipValues) {
      const chip = document.createElement("small");
      chip.textContent = value;
      chips.append(chip);
    }

    const actions = document.createElement("div");
    actions.className = "ops-template-actions";
    const start = document.createElement("button");
    start.type = "button";
    start.className = "task-action-btn is-primary";
    start.textContent = "Create card";
    start.addEventListener("click", () => openQuickWorkflowForm({ template }));
    const docs = document.createElement("button");
    docs.type = "button";
    docs.className = "task-action-btn";
    docs.textContent = "View process doc";
    docs.addEventListener("click", () => openDocument(template.path));
    actions.append(start, docs);

    card.append(title, summary, chips, actions);
    return card;
  }

  async function generateRecurringTasksForToday(button) {
    const originalText = button?.textContent || "Generate today";
    if (button) {
      button.disabled = true;
      button.textContent = "Generating...";
    }
    const today = todayIsoDate();
    try {
      await request(workApiUrl("/api/recurring/generate"), {
        method: "POST",
        body: JSON.stringify({ startDate: today, endDate: today }),
      });
      await refreshOperationsWorkSnapshot({ rerender: true });
      await refreshOperationsRecurringSnapshot({ rerender: true });
    } catch (err) {
      reportError(
        `Could not generate recurring tasks: ${err.message || "request failed"}`,
      );
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = originalText;
      }
    }
  }

  async function toggleRecurringConfig(configId, enabled, button) {
    const originalText = button?.textContent || (enabled ? "Resume" : "Pause");
    if (button) {
      button.disabled = true;
      button.textContent = enabled ? "Resuming..." : "Pausing...";
    }
    try {
      await request(
        workApiUrl(`/api/recurring/${encodeURIComponent(configId)}`),
        {
          method: "PUT",
          body: JSON.stringify({ enabled }),
        },
      );
      await refreshOperationsRecurringSnapshot({ rerender: true });
    } catch (err) {
      reportError(
        `Could not update recurring operation: ${err.message || "request failed"}`,
      );
      if (button) {
        button.disabled = false;
        button.textContent = originalText;
      }
    }
  }

  function recurringConfigTitle(config) {
    return String(
      config?.description ||
        config?.name ||
        config?.id ||
        "Recurring operation",
    );
  }

  function formatRecurringSchedule(cronExpression) {
    const parts = String(cronExpression || "")
      .trim()
      .split(/\s+/);
    if (parts.length !== 5) return cronExpression || "No schedule";
    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
    if (month !== "*") return cronExpression;
    const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    if (dayOfMonth === "*" && dayOfWeek === "*") return `Daily at ${time}`;
    if (dayOfMonth === "*" && dayOfWeek !== "*")
      return `Weekly on ${weekdayName(dayOfWeek)} at ${time}`;
    if (dayOfMonth !== "*" && dayOfWeek === "*")
      return `Monthly on day ${dayOfMonth} at ${time}`;
    return cronExpression;
  }

  function weekdayName(value) {
    const names = {
      0: "Sunday",
      1: "Monday",
      2: "Tuesday",
      3: "Wednesday",
      4: "Thursday",
      5: "Friday",
      6: "Saturday",
    };
    return names[String(value)] || value;
  }

  async function resolveTemplateRouteEntity(route, token) {
    await refreshRuntimeTemplates({ token });
    if (!isWorkspaceRouteFresh(token)) return;
    const templateId = route.params.get("templateId");
    if (!templateId) {
      setWorkspaceEntityState(null);
      renderTasksSurface(getAllDocuments(), "templates");
      return;
    }
    let template = runtimeState.templates.find(
      (candidate) => candidate.id === templateId,
    );
    if (!template) {
      try {
        const payload = await request(
          workApiUrl(`/api/templates/${encodeURIComponent(templateId)}`),
        );
        if (!isWorkspaceRouteFresh(token)) return;
        template = payload.template || payload;
        runtimeState.templates = [template, ...runtimeState.templates];
      } catch (error) {
        if (!isWorkspaceRouteFresh(token)) return;
        setWorkspaceEntityState({
          kind: "template",
          id: templateId,
          status: error.status === 404 ? "not-found" : "error",
          error: error.message,
        });
      }
    }
    if (template) {
      setWorkspaceEntityState({
        kind: "template",
        id: templateId,
        status: "ready",
      });
    }
    runtimeState.selectedId = templateId;
    renderTasksSurface(getAllDocuments(), "templates");
  }

  return {
    confirmLeaveRuntimeDraft,
    openQuickTaskForm,
    openQuickWorkflowForm,
    refreshRuntimeTemplates,
    renderTasksSurface,
    resolveTemplateRouteEntity,
    setRuntimeTemplateRoute: (route, entity) => {
      runtimeState.selectedId =
        route?.tasksSection === "templates"
          ? (entity?.templateId ?? route.params.get("templateId"))
          : null;
    },
  };
}
