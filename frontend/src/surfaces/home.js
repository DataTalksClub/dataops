export function createHomeSurface(context) {
  const {
    activeWorkOwner,
    activeWorkOwnerId,
    addDaysIso,
    allWorkTasks,
    buildHomeAttentionItems,
    buildOperationsFutureSections,
    buildOperationsReferenceLinks,
    bundlesFromWorkPayload,
    clearSelectionButton,
    currentOperatorIdForTodayScope,
    currentOperatorIdFromPayload,
    dedupeOperationItems,
    deriveHomeWorkState,
    documentList,
    emptyOperationsQualitySnapshot,
    emptyOperationsWorkSnapshot,
    formatHomeCalendarDate,
    formatHomeTaskTiming,
    isActiveWorkBundle,
    isOpenWorkTask,
    isOperationsHomeVisible,
    isWorkflowTemplateDoc,
    isWorkspaceRouteFresh,
    libraryTitle,
    listDraftPaths,
    navigateCanonicalWorkspace,
    normalizeOperationsRecurringSnapshot,
    normalizeOperationsWorkSnapshot,
    normalizeTemplateMatchValue,
    openQuickTaskForm,
    openQuickWorkflowForm,
    openTaskPanel,
    operationItemFromBundle,
    operationItemFromTask,
    operationItemFromTemplate,
    readLocalPreviewContext,
    refreshAccountIdentity,
    refreshDocuments,
    refreshWorkBell,
    renderHonestState,
    renderOperationsRuntimeState,
    request,
    resolveBundleLabel,
    resolveDocReference,
    setPageTitle,
    setStatus,
    settledPayload,
    state,
    summarizeWorkflowTemplate,
    tasksFromWorkPayload,
    todayIsoDate,
    usersFromWorkPayload,
    workApiUrl,
    workBundleTitle,
    workTaskTitle,
    workflowPriority,
  } = context;

  function renderOperationsHome(documents) {
    const model = buildOperationsHomeModel(documents, {
      draftPaths: listDraftPaths(),
      workSnapshot: state.workSnapshot,
      recurringSnapshot: state.recurringSnapshot,
      qualitySnapshot: state.qualitySnapshot,
    });
    documentList.classList.add("is-operations-home");
    documentList.classList.remove("is-unified-search");
    libraryTitle.textContent = "Home";
    setPageTitle("Today", "Today");
    clearSelectionButton.hidden = true;
    if (model.stats.liveLoaded) {
      setStatus(
        `${model.stats.todayTasks} today · ${model.stats.overdueTasks} overdue · ${model.stats.waitingTasks} waiting · ${model.stats.activeBundles} active cards.`,
      );
    } else {
      setStatus(
        `${model.stats.totalDocs} docs · ${model.stats.workflowTemplates} Templates · ${model.stats.recurringTemplates} recurring.`,
      );
    }

    const wrap = document.createElement("div");
    wrap.className = "operations-home operations-home-daily";

    // Read-only load signal for tests: reflects whether the async work snapshot
    // (/work/api/tasks, /work/api/bundles) has finished hydrating. The home view
    // renders immediately on first paint with an unloaded snapshot, then re-renders
    // once refreshOperationsWorkSnapshot resolves. This attribute lets waiters
    // distinguish the hydrated render from the skeleton render without polling rows.
    wrap.dataset.operationsWorkLoaded = String(Boolean(model.stats.liveLoaded));

    const header = document.createElement("header");
    header.className = "home-daily-header";
    const heading = document.createElement("div");
    const title = document.createElement("h2");
    title.textContent = "Today";
    const date = document.createElement("time");
    date.dateTime = model.today;
    date.textContent = formatHomeCalendarDate(model.today);
    heading.append(title, date);

    const quickBar = document.createElement("div");
    quickBar.className = "home-quick-actions";
    quickBar.setAttribute("aria-label", "Quick actions");
    const quickTask = document.createElement("button");
    quickTask.type = "button";
    quickTask.className = "home-quick-action";
    quickTask.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg><span>New task</span>';
    quickTask.addEventListener("click", () => openQuickTaskForm());
    const quickWorkflow = document.createElement("button");
    quickWorkflow.type = "button";
    quickWorkflow.className = "home-quick-action home-quick-action-primary";
    quickWorkflow.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7Z"/></svg><span>Create card</span>';
    quickWorkflow.addEventListener("click", () => openQuickWorkflowForm());
    quickBar.append(quickTask, quickWorkflow);
    header.append(heading, quickBar);
    wrap.append(header, renderHomeStatusStrip(model));

    const runtimeState = renderOperationsRuntimeState(model.runtime);
    if (runtimeState) wrap.append(runtimeState);

    wrap.append(renderHomeAttentionQueue(model));

    documentList.replaceChildren(wrap);
  }

  function renderHomeStatusStrip(model) {
    const summary = document.createElement("section");
    summary.className = "home-status-strip";
    summary.setAttribute("aria-label", "Daily work summary");
    const stats = [
      {
        id: "overdue",
        label: "Overdue",
        value: model.stats.overdueTasks,
        loaded: model.stats.overdueLoaded,
      },
      {
        id: "today",
        label: "Due today",
        value: model.stats.todayTasks,
        loaded: model.stats.todayLoaded,
      },
      {
        id: "waiting",
        label: "Waiting",
        value: model.stats.waitingTasks,
        loaded: model.stats.waitingLoaded,
      },
    ];
    for (const stat of stats) {
      const item = document.createElement("div");
      item.className = `home-status-item home-status-${stat.id}`;
      item.dataset.state = stat.loaded ? "ready" : "unavailable";
      const label = document.createElement("span");
      label.className = "home-status-label";
      label.innerHTML = `${homeStatusIcon(stat.id)}<span>${stat.label}</span>`;
      const value = document.createElement("strong");
      value.textContent = stat.loaded ? String(stat.value) : "—";
      if (!stat.loaded)
        value.setAttribute("aria-label", `${stat.label} unavailable`);
      item.append(label, value);
      summary.append(item);
    }
    return summary;
  }

  function homeStatusIcon(id) {
    if (id === "overdue") {
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2.8 20h18.4Z"/><path d="M12 9v5M12 17h.01"/></svg>';
    }
    if (id === "waiting") {
      return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.5 9v6M14.5 9v6"/></svg>';
    }
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
  }

  function renderHomeAttentionQueue(model) {
    const section = document.createElement("section");
    section.className = "home-attention";
    section.setAttribute("aria-labelledby", "home-attention-title");

    const header = document.createElement("header");
    const title = document.createElement("h3");
    title.id = "home-attention-title";
    title.textContent = "Needs your attention";
    header.append(title);
    section.append(header);

    const items = buildHomeAttentionItems(model);
    if (items.length === 0) {
      const empty = renderHonestState(
        model.stats.missingProofLoaded
          ? "No work needs your attention"
          : "Action queue unavailable",
        model.stats.missingProofLoaded
          ? "Nothing is overdue, due for follow-up, due today, or waiting on proof."
          : "Task data is still loading or unavailable; no false work items are shown.",
      );
      empty.classList.add("home-attention-empty");
      section.append(empty);
    } else {
      const list = document.createElement("ul");
      list.className = "home-attention-list";
      for (const item of items.slice(0, 6))
        list.append(renderHomeAttentionItem(item, model.today));
      section.append(list);
    }

    const footer = document.createElement("footer");
    const allTasks = document.createElement("button");
    allTasks.type = "button";
    allTasks.className = "home-view-all";
    allTasks.textContent = "View all tasks";
    allTasks.addEventListener(
      "click",
      () => navigateCanonicalWorkspace("/tasks").ready,
    );
    footer.append(allTasks);
    section.append(footer);
    return section;
  }

  function renderHomeAttentionItem(item, today) {
    const row = document.createElement("li");
    row.className = `home-attention-row home-attention-${item.priority}`;

    const marker = document.createElement("span");
    marker.className = "home-task-marker";
    marker.setAttribute("aria-hidden", "true");

    const content = document.createElement("div");
    content.className = "home-task-content";
    const title = document.createElement("strong");
    title.textContent = item.title;
    const workflow = document.createElement("span");
    workflow.className = "home-task-workflow";
    workflow.textContent = item.bundleId
      ? resolveBundleLabel(item.bundleId)
      : "Independent task";
    content.append(title, workflow);

    const state = document.createElement("div");
    state.className = "home-task-state";
    const timing = document.createElement("time");
    const timingDate =
      item.priority === "follow-up"
        ? item.followUpDate
        : item.dueDate || item.followUpDate;
    if (timingDate) timing.dateTime = timingDate;
    timing.textContent = formatHomeTaskTiming(item, today);
    const badge = document.createElement("span");
    badge.className = `home-exception home-exception-${item.priority}`;
    badge.textContent = item.exception;
    state.append(timing, badge);

    const action = document.createElement("button");
    action.type = "button";
    action.className = "home-task-action";
    action.textContent = homeTaskActionLabel(item.nextAction);
    action.setAttribute("aria-label", `${action.textContent}: ${item.title}`);
    action.addEventListener("click", () => openTaskPanel(item.taskId));

    row.append(marker, content, state, action);
    return row;
  }

  function homeTaskActionLabel(value) {
    const label = String(value || "Open").trim();
    if (/^add /i.test(label)) return "Add proof";
    if (/^mark (done|response received)$/i.test(label)) return "Open";
    return label;
  }

  // Builds the single Home "Needs your action" lane by merging overdue, today,
  // and missing-proof task items into one prioritized list (overdue first).
  function buildNeedsActionLane(model) {
    const byId = (id) => model.lanes.find((lane) => lane.id === id);
    const overdue = (byId("overdue")?.items || []).slice();
    const today = (byId("today")?.items || []).slice();
    const hasLiveWork = model.stats.liveLoaded;
    // Overdue and today already cover their tasks; fold in missing-proof items
    // that are not already listed, so a task shows once even when it is both
    // overdue and missing proof.
    const placed = new Set(
      [...overdue, ...today].map((item) => item.taskId).filter(Boolean),
    );
    const missingProof = (byId("missing-proof")?.items || []).filter(
      (item) => !placed.has(item.taskId),
    );
    const items = dedupeOperationItems([...overdue, ...today, ...missingProof]);
    // Needs-action is a composite of the overdue, today, and missing-proof
    // lanes. If none of those sources loaded, report the work data as
    // unavailable; otherwise an empty merged list genuinely means nothing is
    // pending (#97).
    const needsActionLoaded =
      model.stats.overdueLoaded ||
      model.stats.todayLoaded ||
      model.stats.missingProofLoaded;
    return {
      id: "needs-action",
      title: "Needs your action",
      empty: needsActionLoaded
        ? "Nothing overdue, due today, or missing proof."
        : "Live work data unavailable; overdue, today, and missing-proof work cannot be confirmed.",
      items,
    };
  }

  // Tasks owns Queue / Workflows / Templates / Assistants / Artifacts. Its
  // expandable sidebar group selects the canonical sub-route; the main canvas is
  // reserved for the selected work surface.

  function normalizeOperationsQualitySnapshot(input) {
    const snapshot = input && typeof input === "object" ? input : {};
    const findings = Array.isArray(snapshot.findings)
      ? snapshot.findings
          .filter((finding) => finding && typeof finding === "object")
          .map(normalizeQualityFinding)
      : [];
    return {
      loaded: Boolean(snapshot.loaded),
      ok: snapshot.ok !== false,
      findings,
      summary:
        snapshot.summary && typeof snapshot.summary === "object"
          ? snapshot.summary
          : { total: findings.length },
      errors: Array.isArray(snapshot.errors) ? snapshot.errors : [],
      validationErrors: Array.isArray(snapshot.validationErrors)
        ? snapshot.validationErrors
        : [],
    };
  }

  function normalizeQualityFinding(finding) {
    return {
      ...finding,
      id: String(
        finding.id ||
          `${finding.category || "quality"}:${finding.title || ""}:${finding.docPath || ""}:${finding.taskId || ""}`,
      ),
      category: String(finding.category || "process-quality"),
      severity: normalizeQualitySeverity(finding.severity),
      title: String(finding.title || "Process quality finding"),
      summary: String(finding.summary || ""),
      source: String(finding.source || "process quality"),
      nextAction: String(finding.nextAction || "open doc"),
      status: String(finding.status || "open"),
      docId: String(finding.docId || ""),
      docPath: String(finding.docPath || ""),
      templateId: String(finding.templateId || ""),
      workflowSlug: String(finding.workflowSlug || ""),
      instructionDocId: String(finding.instructionDocId || ""),
      taskRef: String(finding.taskRef || ""),
      taskId: String(finding.taskId || ""),
      bundleId: String(finding.bundleId || ""),
    };
  }

  function normalizeQualitySeverity(value) {
    const severity = String(value || "warning").toLowerCase();
    return ["blocking", "warning", "info"].includes(severity)
      ? severity
      : "warning";
  }

  function buildProcessQualityModel(report, work) {
    const snapshot = normalizeOperationsQualitySnapshot(
      report || state.qualitySnapshot,
    );
    const activeFindings =
      snapshot.loaded && work.loaded
        ? activeProcessQualityFindings(snapshot.findings, work)
        : [];
    const maintainerFindings = snapshot.findings
      .slice()
      .sort(compareQualityFindings);
    const visibleHomeFindings = (
      activeFindings.length > 0 ? activeFindings : maintainerFindings
    ).slice(0, 6);
    return {
      loaded: snapshot.loaded,
      ok: snapshot.ok,
      errors: snapshot.errors,
      validationErrors: snapshot.validationErrors,
      summary: snapshot.summary,
      activeWorkLoaded: work.loaded,
      activeFindings,
      maintainerFindings,
      visibleHomeFindings,
      activeBlockingCount: activeFindings.filter(
        (finding) => finding.severity === "blocking",
      ).length,
      totalFindings: maintainerFindings.length,
    };
  }

  function activeProcessQualityFindings(reportFindings, work) {
    const findings = [];
    const tasks = allWorkTasks(work).filter(isOpenWorkTask);
    const taskIds = new Set();
    for (const task of tasks) {
      for (const finding of runtimeTaskQualityFindings(task)) {
        findings.push(finding);
        taskIds.add(finding.id);
      }
      const doc = task.instructionDocId
        ? resolveDocReference(task.instructionDocId)
        : null;
      if (!doc) continue;
      for (const finding of reportFindings) {
        if (!findingMatchesDoc(finding, doc)) continue;
        const active = {
          ...finding,
          id: `${finding.id}:task:${task.id}`,
          severity: "blocking",
          taskId: String(task.id || ""),
          bundleId: String(task.bundleId || finding.bundleId || ""),
          title: `${finding.title}`,
          summary: `${workTaskTitle(task)} uses this process doc. ${finding.summary}`,
          nextAction: "open task",
        };
        if (!taskIds.has(active.id)) {
          findings.push(active);
          taskIds.add(active.id);
        }
      }
    }
    for (const bundle of work.activeBundles || []) {
      const matched = reportFindings.filter((finding) =>
        findingMatchesBundle(finding, bundle),
      );
      for (const finding of matched) {
        findings.push({
          ...finding,
          id: `${finding.id}:bundle:${bundle.id}`,
          severity: "blocking",
          bundleId: String(bundle.id || ""),
          summary: `${workBundleTitle(bundle)} is active. ${finding.summary}`,
          nextAction: "open workflow",
        });
      }
    }
    return dedupeQualityFindings(findings).sort(compareQualityFindings);
  }

  function runtimeTaskQualityFindings(task) {
    const findings = [];
    const title = workTaskTitle(task);
    const docId = String(task?.instructionDocId || "");
    if (docId && !resolveDocReference(docId)) {
      findings.push(
        normalizeQualityFinding({
          id: `runtime-missing-doc:${task.id}:${docId}`,
          category: "broken-doc-reference",
          severity: "blocking",
          title: "Task instructions cannot be opened",
          summary: `${title} points to instructionDocId ${docId}, but the document registry cannot resolve it.`,
          source: "runtime task scan",
          nextAction: "open task",
          instructionDocId: docId,
          taskId: task.id,
          bundleId: task.bundleId,
        }),
      );
    } else if (
      !docId &&
      task?.instructionsUrl &&
      /docs\.google\.com\/document/i.test(String(task.instructionsUrl))
    ) {
      findings.push(
        normalizeQualityFinding({
          id: `runtime-external-doc:${task.id}`,
          category: "legacy-external-only-doc",
          severity: "blocking",
          title: "Task only has an external instructions link",
          summary: `${title} uses a Google Docs instructionsUrl without a stable in-repo instructionDocId.`,
          source: "runtime task scan",
          nextAction: "open task",
          taskId: task.id,
          bundleId: task.bundleId,
        }),
      );
    } else if (!docId && !task?.instructionsUrl) {
      findings.push(
        normalizeQualityFinding({
          id: `runtime-no-doc:${task.id}`,
          category: "template-doc-gap",
          severity: "blocking",
          title: "Task has no process instructions",
          summary: `${title} has no instructionDocId or instructionsUrl, so the operator cannot open task instructions from the workflow.`,
          source: "runtime task scan",
          nextAction: "open task",
          taskId: task.id,
          bundleId: task.bundleId,
        }),
      );
    }

    if (
      taskNeedsProofInstruction(task) &&
      !taskHasClearProofInstruction(task)
    ) {
      findings.push(
        normalizeQualityFinding({
          id: `runtime-proof:${task.id}`,
          category: "missing-proof-instructions",
          severity: "blocking",
          title: "Task proof guidance is unclear",
          summary: `${title} requires evidence, but the task does not clearly name the URL, file, artifact, comment, or external status needed for closure.`,
          source: "runtime task scan",
          nextAction: "add proof requirement",
          taskId: task.id,
          bundleId: task.bundleId,
          instructionDocId: docId,
        }),
      );
    }
    return findings;
  }

  function taskNeedsProofInstruction(task) {
    if (!task || typeof task !== "object") return false;
    if (task.requiredLinkName || task.requiresFile) return true;
    const proof = task.proofRequirement;
    if (proof && typeof proof === "object" && proof.required !== false)
      return true;
    const validation = task.validation;
    return Boolean(
      validation &&
      typeof validation === "object" &&
      (validation.requiredEvidence || validation.requiredBundleLinks),
    );
  }

  function taskHasClearProofInstruction(task) {
    if (task.requiredLinkName) return true;
    const proof = task.proofRequirement;
    if (proof && typeof proof === "object" && String(proof.label || "").trim())
      return true;
    const validation = task.validation;
    if (
      validation &&
      typeof validation === "object" &&
      String(validation.requiredEvidence || "").trim()
    )
      return true;
    return false;
  }

  function findingMatchesDoc(finding, doc) {
    if (!finding || !doc) return false;
    const ids = [doc.id, ...(Array.isArray(doc.aliases) ? doc.aliases : [])]
      .filter(Boolean)
      .map(String);
    return (
      (finding.docPath && finding.docPath === doc.path) ||
      (finding.docId && ids.includes(String(finding.docId))) ||
      (finding.instructionDocId &&
        ids.includes(String(finding.instructionDocId)))
    );
  }

  function findingMatchesBundle(finding, bundle) {
    if (!finding || !bundle) return false;
    const workflowValues = [
      bundle.templateId,
      bundle.templateType,
      bundle.type,
      bundle.workflowSlug,
      bundle.workflowType,
      bundle.slug,
      bundle.title,
      bundle.name,
    ]
      .filter(Boolean)
      .map(normalizeTemplateMatchValue);
    const findingValues = [finding.templateId, finding.workflowSlug]
      .filter(Boolean)
      .map(normalizeTemplateMatchValue);
    return findingValues.some((value) => workflowValues.includes(value));
  }

  function dedupeQualityFindings(findings) {
    const seen = new Set();
    const out = [];
    for (const finding of findings.map(normalizeQualityFinding)) {
      const key = finding.id;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(finding);
    }
    return out;
  }

  function compareQualityFindings(a, b) {
    const order = { blocking: 0, warning: 1, info: 2 };
    const bySeverity = (order[a.severity] ?? 3) - (order[b.severity] ?? 3);
    if (bySeverity !== 0) return bySeverity;
    return `${a.workflowSlug || ""}:${a.category}:${a.title}`.localeCompare(
      `${b.workflowSlug || ""}:${b.category}:${b.title}`,
    );
  }

  function buildOperationsHomeModel(documents, options) {
    options = options || {};
    const docs = Array.isArray(documents) ? documents : [];
    const today = options.today || todayIsoDate();
    const work = normalizeOperationsWorkSnapshot(
      options.workSnapshot || {
        loaded: options.liveLoaded,
        todayTasks: options.todayTasks,
        overdueTasks: options.overdueTasks,
        waitingTasks: options.waitingTasks,
        tasks: options.tasks,
        bundles: options.bundles,
        bundleTasks: options.bundleTasks,
        errors: options.workErrors,
      },
      { today },
    );
    const recurring = normalizeOperationsRecurringSnapshot(
      options.recurringSnapshot || {},
    );
    const hasLiveWork = work.loaded;
    // Per-lane load state (#97): each lane degrades against its OWN data source
    // rather than the coarse top-level `loaded` (.some()). Missing-proof is a
    // derived view over all task fetches, so it is "loaded" when any task source
    // resolved; bundles is gated on the bundles fetch alone.
    const tasksLoaded =
      work.todayLoaded || work.overdueLoaded || work.waitingLoaded;
    const templates = docs
      .filter(isWorkflowTemplateDoc)
      .map((doc) => summarizeWorkflowTemplate(doc))
      .sort(
        (a, b) =>
          workflowPriority(a.slug) - workflowPriority(b.slug) ||
          a.title.localeCompare(b.title),
      );

    const recurringItems = templates
      .filter((template) => template.recurring)
      .map(operationItemFromTemplate);
    const selectedOwnerId = activeWorkOwnerId();
    const scopedCurrentOperatorId =
      selectedOwnerId || currentOperatorIdForTodayScope(work.currentOperatorId);
    const homeWork = deriveHomeWorkState(work, {
      today,
      selectedOwnerId,
      currentOperatorId: scopedCurrentOperatorId,
    });
    const todayWorkTasks = homeWork.tasks.today;
    const overdueWorkTasks = homeWork.tasks.overdue;
    const todayItems = work.todayLoaded
      ? todayWorkTasks.map((task) => operationItemFromTask(task, { today }))
      : [];
    const overdueItems = work.overdueLoaded
      ? overdueWorkTasks.map((task) =>
          operationItemFromTask(task, { today, overdue: true }),
        )
      : [];
    const followUpTasks = homeWork.tasks.followUps;
    const followUpItems = work.waitingLoaded
      ? followUpTasks.map((task) =>
          operationItemFromTask(task, { today, followUp: true }),
        )
      : [];
    const waitingItems = work.waitingLoaded
      ? homeWork.tasks.waiting.map((task) =>
          operationItemFromTask(task, { today, waiting: true }),
        )
      : [];
    const bundleItems = work.bundlesLoaded
      ? work.activeBundles.map((bundle) =>
          operationItemFromBundle(bundle, work.bundleTasks[bundle.id] || [], {
            today,
          }),
        )
      : [];
    const missingProofTasks = homeWork.tasks.missingProof;
    const missingProofItems = tasksLoaded
      ? missingProofTasks.map((task) => operationItemFromTask(task, { today }))
      : [];
    const fallbackQualitySnapshot =
      typeof state.qualitySnapshot !== "undefined" ? state.qualitySnapshot : {};
    const quality = buildProcessQualityModel(
      options.qualitySnapshot || fallbackQualitySnapshot,
      work,
    );

    const lanes = [
      {
        id: "overdue",
        title: "Overdue",
        empty: work.overdueLoaded
          ? "No live overdue tasks."
          : "Live work data unavailable; overdue work cannot be confirmed.",
        items: overdueItems,
      },
      {
        id: "followups",
        title: "Follow-Ups Due",
        empty: work.waitingLoaded
          ? "No follow-ups due right now."
          : "Live work data unavailable; follow-ups cannot be confirmed.",
        items: followUpItems,
      },
      {
        id: "today",
        title: "Today",
        empty: work.todayLoaded
          ? scopedCurrentOperatorId
            ? "No live tasks assigned to you or unassigned due today."
            : "No live tasks due today."
          : "Live work data unavailable; tasks will appear here when /work/api/tasks is connected.",
        items: todayItems,
      },
      {
        id: "missing-proof",
        title: "Missing Proof",
        empty: tasksLoaded
          ? "No tasks waiting on proof."
          : "Live work data unavailable; missing-proof work cannot be confirmed.",
        items: missingProofItems,
      },
      {
        id: "waiting",
        title: "Waiting",
        empty: work.waitingLoaded
          ? "No live waiting tasks."
          : "Live work data unavailable; waiting work cannot be confirmed.",
        items: waitingItems,
      },
      {
        id: "bundles",
        title: "At-risk Cards",
        empty: work.bundlesLoaded
          ? "No active Cards."
          : "No live Card data loaded.",
        items: bundleItems,
      },
    ];

    const runtimeErrors = [
      ...work.errors,
      ...recurring.errors.map((error) => `Recurring: ${error}`),
    ];

    return {
      today,
      scope: {
        actor: state.accountIdentity.user,
        owner: activeWorkOwner(),
        isPeer: Boolean(
          state.accountIdentity.user &&
          activeWorkOwner() &&
          String(state.accountIdentity.user.id) !==
            String(activeWorkOwner().id),
        ),
      },
      lanes,
      templates,
      references: buildOperationsReferenceLinks(docs),
      recurring,
      quality,
      runtime: {
        connected: hasLiveWork,
        errors: runtimeErrors,
      },
      futureSections: buildOperationsFutureSections(),
      stats: {
        totalDocs: docs.length,
        workflowTemplates: templates.length,
        recurringTemplates: recurringItems.length,
        liveLoaded: hasLiveWork,
        // Per-lane load state (#97), exposed for downstream consumers like the
        // composite needs-action lane and the work-queue/workflows surfaces.
        todayLoaded: work.todayLoaded,
        overdueLoaded: work.overdueLoaded,
        waitingLoaded: work.waitingLoaded,
        bundlesLoaded: work.bundlesLoaded,
        usersLoaded: work.usersLoaded,
        missingProofLoaded: tasksLoaded,
        todayTasks: homeWork.counts.today,
        overdueTasks: homeWork.counts.overdue,
        waitingTasks: homeWork.counts.waiting,
        followUpTasks: homeWork.counts.followUps,
        missingProofTasks: homeWork.counts.missingProof,
        activeBundles: work.activeBundles.length,
        recurringConfigs: recurring.configs.length,
        enabledRecurringConfigs: recurring.enabled.length,
        workErrors: work.errors,
        currentOperatorId: work.currentOperatorId,
        processQualityBlocking: quality.activeBlockingCount,
      },
    };
  }

  async function refreshOperationsQualitySnapshot(options = {}) {
    const snapshot = emptyOperationsQualitySnapshot();
    try {
      const payload = await request(apiUrl("/docs/process-quality"));
      snapshot.loaded = true;
      snapshot.ok = payload?.ok !== false;
      snapshot.findings = Array.isArray(payload?.findings)
        ? payload.findings
        : [];
      snapshot.summary = payload?.summary || snapshot.summary;
      snapshot.validationErrors = Array.isArray(payload?.validationErrors)
        ? payload.validationErrors
        : [];
    } catch (err) {
      snapshot.errors = [
        err?.message || "Process quality report could not be loaded",
      ];
    }
    state.qualitySnapshot = normalizeOperationsQualitySnapshot(snapshot);
    if (options.rerender && isOperationsHomeVisible()) refreshDocuments();
  }

  async function refreshOperationsWorkSnapshot(options = {}) {
    const today = todayIsoDate();
    const yesterday = addDaysIso(today, -1);
    const todayUrl = workApiUrl("/api/tasks", { date: today });
    const overdueUrl = workApiUrl("/api/tasks", {
      startDate: "1970-01-01",
      endDate: yesterday,
    });
    const waitingUrl = workApiUrl("/api/tasks", { status: "waiting" });
    const bundlesUrl = workApiUrl("/api/bundles");
    const usersUrl = workApiUrl("/api/users");
    const meUrl = workApiUrl("/api/me");
    const localContext = await readLocalPreviewContext();
    const meRequest = localContext?.actorEmail
      ? Promise.resolve({})
      : request(meUrl);
    const [
      todayResult,
      overdueResult,
      waitingResult,
      bundlesResult,
      usersResult,
      meResult,
    ] = await Promise.allSettled([
      request(todayUrl),
      request(overdueUrl),
      request(waitingUrl),
      request(bundlesUrl),
      request(usersUrl),
      meRequest,
    ]);

    const snapshot = emptyOperationsWorkSnapshot();
    // The "work loaded" signal is a coarse "the work snapshot has fetched" gate,
    // not a precision guarantee. .some() flips true once any of the required work
    // fetches resolves, which is enough for the home to start rendering. This is
    // intentionally permissive: on a partial outage the Today lane can render with
    // available data while names degrade to ---, instead of hiding everything
    // behind a never-true signal. The real robustness for stale snapshots lives in
    // the e2e specs' retry-with-refresh loop, not in making this signal precise.
    // (See #97 for finer per-lane degradation tracking.) /api/me is optional.
    snapshot.loaded = [
      todayResult,
      overdueResult,
      waitingResult,
      bundlesResult,
      usersResult,
    ].some((result) => result.status === "fulfilled");
    // Per-lane load state (#97): each fetch tracks whether its OWN data source
    // resolved, so a single failed endpoint degrades only its lane rather than
    // hiding the whole work surface behind the coarse `.some()` signal above.
    snapshot.todayLoaded = todayResult.status === "fulfilled";
    snapshot.overdueLoaded = overdueResult.status === "fulfilled";
    snapshot.waitingLoaded = waitingResult.status === "fulfilled";
    snapshot.bundlesLoaded = bundlesResult.status === "fulfilled";
    snapshot.usersLoaded = usersResult.status === "fulfilled";
    snapshot.todayTasks = tasksFromWorkPayload(settledPayload(todayResult));
    snapshot.overdueTasks = tasksFromWorkPayload(settledPayload(overdueResult));
    snapshot.waitingTasks = tasksFromWorkPayload(settledPayload(waitingResult));
    snapshot.bundles = bundlesFromWorkPayload(settledPayload(bundlesResult));
    snapshot.users = usersFromWorkPayload(settledPayload(usersResult));
    snapshot.currentOperatorId = currentOperatorIdFromPayload(
      settledPayload(meResult),
    );
    snapshot.errors = [
      todayResult,
      overdueResult,
      waitingResult,
      bundlesResult,
      usersResult,
    ]
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason?.message || "Work API request failed");

    const activeBundles = snapshot.bundles.filter(isActiveWorkBundle);
    const bundleTaskResults = await Promise.allSettled(
      activeBundles.map((bundle) =>
        request(workApiUrl("/api/tasks", { bundleId: bundle.id })),
      ),
    );
    activeBundles.forEach((bundle, index) => {
      const result = bundleTaskResults[index];
      if (result.status === "fulfilled") {
        snapshot.bundleTasks[bundle.id] = tasksFromWorkPayload(result.value);
      } else {
        snapshot.errors.push(
          result.reason?.message ||
            `Could not load tasks for ${bundle.title || bundle.id}`,
        );
      }
    });

    state.workSnapshot = normalizeOperationsWorkSnapshot(snapshot, { today });
    await refreshAccountIdentity(
      settledPayload(meResult),
      state.workSnapshot.users,
      localContext,
    );
    if (options.rerender && isOperationsHomeVisible()) refreshDocuments();
    refreshWorkBell();
  }

  return {
    buildNeedsActionLane,
    buildOperationsHomeModel,
    buildProcessQualityModel,
    refreshOperationsQualitySnapshot,
    refreshOperationsWorkSnapshot,
    renderOperationsHome,
  };
}
