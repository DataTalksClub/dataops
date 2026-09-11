import { renderDataSummary } from "./operations-overview.js";
import { createHomeAttentionView } from "./home-attention.js";
import { createCollectionLoader } from "../core/collection-loader.js";
import {
  compareQualityFindings,
  dedupeQualityFindings,
  findingMatchesCard,
  findingMatchesDoc,
  normalizeOperationsQualitySnapshot,
  normalizeQualityFinding,
  taskHasClearProofInstruction,
  taskNeedsProofInstruction,
} from "../core/operations-model.js";

export function createHomeSurface(context) {
  const {
    activeWorkOwner,
    activeWorkOwnerId,
    addDaysIso,
    allWorkTasks,
    apiUrl,
    buildOperationsFutureSections,
    buildOperationsReferenceLinks,
    currentOperatorIdForTodayScope,
    currentOperatorIdFromPayload,
    dedupeOperationItems,
    deriveHomeWorkState,
    documentList,
    emptyOperationsQualitySnapshot,
    emptyOperationsWorkSnapshot,
    formatHomeCalendarDate,
    getActiveWorkspaceRouteToken,
    isActiveWorkCard,
    isOpenWorkTask,
    isOperationsHomeVisible,
    isWorkflowTemplateDoc,
    isWorkspaceRouteFresh,
    listDraftPaths,
    navigateCanonicalWorkspace,
    normalizeOperationsRecurringSnapshot,
    normalizeOperationsWorkSnapshot,
    normalizeTemplateMatchValue,
    openQuickTaskForm,
    openQuickWorkflowForm,
    operationItemFromCard,
    operationItemFromTask,
    operationItemFromTemplate,
    readLocalPreviewContext,
    refreshAccountIdentity,
    refreshDocuments,
    refreshWorkBell,
    renderDocsAvailabilityState,
    request,
    resolveDocReference,
    setRouteTitle,
    settledPayload,
    state,
    summarizeWorkflowTemplate,
    tasksFromWorkPayload,
    todayIsoDate,
    usersFromWorkPayload,
    workApiUrl,
    workCardTitle,
    workTaskTitle,
    workflowPriority,
  } = context;

  let cardsLoader;
  let lastGoodCardsPage;
  const { renderHomeAttentionQueue } = createHomeAttentionView(context);

  function renderOperationsHome(documents) {
    const model = buildOperationsHomeModel(documents, {
      draftPaths: listDraftPaths(),
      workSnapshot: state.workSnapshot,
      recurringSnapshot: state.recurringSnapshot,
      qualitySnapshot: state.qualitySnapshot,
    });
    documentList.classList.add("is-operations-home");
    documentList.classList.remove("is-unified-search");
    setRouteTitle("Today");

    const wrap = document.createElement("div");
    wrap.className = "operations-home operations-home-daily";

    // Read-only load signal for tests: reflects whether the async work snapshot
    // (/work/api/tasks, /work/api/cards) has finished hydrating. The home view
    // renders immediately on first paint with an unloaded snapshot, then re-renders
    // once refreshOperationsWorkSnapshot resolves. This attribute lets waiters
    // distinguish the hydrated render from the skeleton render without polling rows.
    wrap.dataset.operationsWorkLoaded = String(Boolean(model.stats.liveLoaded));

    const header = document.createElement("header");
    header.className = "home-daily-header";
    const heading = document.createElement("div");
    const title = document.createElement("h1");
    title.textContent = "Today";
    const date = document.createElement("time");
    date.dateTime = model.today;
    date.textContent = formatHomeCalendarDate(model.today);
    const purpose = document.createElement("p");
    purpose.className = "home-purpose";
    purpose.textContent = homeHeadlineSentence(model);
    heading.append(title, date, purpose);
    const debtChip = renderCarriedDebtChip(model);
    if (debtChip) heading.append(debtChip);

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
    quickWorkflow.className = "home-quick-action";
    quickWorkflow.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7Z"/></svg><span>Create card</span>';
    quickWorkflow.addEventListener("click", () => openQuickWorkflowForm());
    quickBar.append(quickTask, quickWorkflow);
    header.append(heading, quickBar);
    wrap.append(
      header,
      renderHomeStatusStrip(model, {
        onRetryWork: async () => {
          const routeToken = getActiveWorkspaceRouteToken();
          await refreshOperationsWorkSnapshot({
            rerender: false,
            continueCards:
              model.stats.cardsLoaded && !model.stats.cardsComplete,
          });
          if (isWorkspaceRouteFresh(routeToken)) refreshDocuments();
        },
      }),
    );

    // Home reports a docs outage next to the work summary, and stays
    // silent while docs are loading or the corpus is merely empty: Home is not
    // where an operator looks for process documents.
    const docsState = renderDocsAvailabilityState(state.docsSnapshot);
    if (docsState) wrap.append(docsState);

    wrap.append(renderHomeAttentionQueue(model), renderHomeNextDestinations());

    documentList.replaceChildren(wrap);
  }

  // The headline counts what needs the operator before end of day — what
  // changed the decision — instead of a motivational placeholder (1e). The
  // count is the queue's own deduplicated item count, so the headline and the
  // "Showing N of M" meta below it never disagree; work waiting on others is
  // named separately because it is not in that queue.
  function homeHeadlineSentence(model) {
    const stats = model.stats;
    if (!stats.liveLoaded) {
      return "Counts appear once today's work data loads.";
    }
    const total = buildNeedsActionLane(model).items.length;
    const waiting = stats.waitingLoaded ? stats.waitingTasks : 0;
    if (total === 0 && waiting === 0) {
      return "Nothing is overdue, due today, missing proof, or waiting on others.";
    }
    const needs =
      total === 0
        ? "Nothing needs your action before end of day"
        : `${total} item${total === 1 ? "" : "s"} need${
            total === 1 ? "s" : ""
          } your action before end of day`;
    return waiting > 0
      ? `${needs} · ${waiting} waiting on others`
      : needs;
  }

  // Overdue work is carried debt: the chip quantifies the pile and its age so
  // the pressure is visible before the queue is read (1b).
  function renderCarriedDebtChip(model) {
    const stats = model.stats;
    if (!stats.overdueLoaded || stats.overdueTasks === 0) return null;
    const overdueItems = model.lanes.find(
      (lane) => lane.id === "overdue",
    )?.items || [];
    const oldest = overdueItems.reduce((maxDays, item) => {
      const due = String(item.dueDate || "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return maxDays;
      const days = Math.round(
        (Date.parse(`${model.today}T00:00:00Z`) -
          Date.parse(`${due}T00:00:00Z`)) / 86400000,
      );
      return Math.max(maxDays, days);
    }, 0);
    const chip = document.createElement("p");
    chip.className = "home-debt-chip";
    const label = document.createElement("strong");
    label.textContent = "Carried debt";
    const detail = document.createElement("span");
    detail.textContent =
      `${stats.overdueTasks} item${stats.overdueTasks === 1 ? "" : "s"}` +
      (oldest > 0 ? ` · oldest ${oldest} day${oldest === 1 ? "" : "s"}` : "");
    chip.append(label, detail);
    return chip;
  }

  function renderHomeStatusStrip(model, options = {}) {
    const summary = document.createElement("section");
    summary.className = "home-status-strip";
    summary.setAttribute("aria-label", "Daily work summary");
    const feedback = renderHomeSummary(model, options);
    if (feedback.dataset.summaryState !== "ready") summary.append(feedback);
    const stats = [
      { id: "overdue", label: "Overdue", short: "Overdue", value: model.stats.overdueTasks, loaded: model.stats.overdueLoaded },
      { id: "today", label: "Due today", short: "Due today", value: model.stats.todayTasks, loaded: model.stats.todayLoaded },
      { id: "waiting", label: "Waiting on others", short: "Waiting", value: model.stats.waitingTasks, loaded: model.stats.waitingLoaded },
    ];
    for (const stat of stats) {
      const item = document.createElement("div");
      item.className = `home-status-item home-status-${stat.id}`;
      item.dataset.state = stat.loaded ? "ready" : "unavailable";
      const label = document.createElement("span");
      label.className = "home-status-label";
      const dot = document.createElement("i");
      dot.className = "home-status-dot";
      dot.setAttribute("aria-hidden", "true");
      const text = document.createElement("span");
      text.className = "home-status-text";
      const long = document.createElement("span");
      long.className = "home-status-text-long";
      long.textContent = stat.label;
      const short = document.createElement("span");
      short.className = "home-status-text-short";
      short.textContent = stat.short;
      text.append(long, short);
      label.append(dot, text);
      const value = document.createElement("strong");
      value.textContent = stat.loaded ? String(stat.value) : "—";
      if (!stat.loaded)
        value.setAttribute("aria-label", `${stat.label} unavailable`);
      item.append(label, value);
      summary.append(item);
    }
    return summary;
  }

  function renderHomeNextDestinations() {
    const nav = document.createElement("nav");
    nav.className = "home-next-destinations";
    nav.setAttribute("aria-label", "Plan and capture work");
    for (const [question, label, route] of [
      ["Choosing what's next?", "My Plan", "/my-plan"],
      ["Something new arrived?", "Inbox", "/inbox"],
      ["Not sure how?", "Process Docs", "/processes"],
    ]) {
      const part = document.createElement("span");
      const questionText = document.createElement("span");
      questionText.textContent = question;
      const action = document.createElement("button");
      action.type = "button";
      action.textContent = label;
      action.addEventListener("click", () => navigateCanonicalWorkspace(route).ready);
      part.append(questionText, action);
      nav.append(part);
    }
    return nav;
  }

  function renderHomeSummary(model, options) {
    const stats = model.stats;
    const errors = (model.stats.workErrors || []).filter(Boolean);
    const open =
      stats.todayTasks + stats.overdueTasks + stats.waitingTasks + stats.activeCards;
    const everyLaneLoaded =
      stats.todayLoaded &&
      stats.overdueLoaded &&
      stats.waitingLoaded &&
      stats.cardsComplete &&
      stats.cardTasksComplete;
    // A failed lane has no count, not a zero.
    const unavailableSources = [
      !stats.todayLoaded && "Due-today tasks",
      !stats.overdueLoaded && "Overdue tasks",
      !stats.waitingLoaded && "Waiting tasks",
      !stats.cardsComplete && "Cards",
      stats.cardsComplete && !stats.cardTasksComplete && "Card tasks",
    ].filter(Boolean);
    const feedback = renderDataSummary({
      id: "home",
      label: "Today",
      loaded: stats.liveLoaded,
      errors,
      empty: everyLaneLoaded && open === 0,
      messages: {
        loading: "Loading today's tasks and cards…",
        unavailable: "Today's work could not be loaded, so no counts are shown.",
        empty: "Nothing is overdue, due today, or waiting, and no card is active.",
        partial: `${unavailableSources.join(", ") || "Some work sources"} unavailable. Loaded work is still shown.`,
        ready: "Your work is up to date.",
      },
      retryLabel: "Retry loading work",
      onRetry: options.onRetryWork,
    });
    // The summary names the affected sources. Request URLs and runtime
    // diagnostics do not help an operator decide what to do next.
    feedback.querySelector(".surface-summary-detail")?.remove();
    return feedback;
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
          cardId: String(task.cardId || finding.cardId || ""),
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
    for (const card of work.activeCards || []) {
      const matched = reportFindings.filter((finding) =>
        findingMatchesCard(
          finding,
          card,
          normalizeTemplateMatchValue,
        ),
      );
      for (const finding of matched) {
        findings.push({
          ...finding,
          id: `${finding.id}:card:${card.id}`,
          severity: "blocking",
          cardId: String(card.id || ""),
          summary: `${workCardTitle(card)} is active. ${finding.summary}`,
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
          cardId: task.cardId,
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
          cardId: task.cardId,
        }),
      );
    } else if (!docId && !task?.instructionsUrl) {
      findings.push(
        normalizeQualityFinding({
          id: `runtime-no-doc:${task.id}`,
          category: "template-doc-gap",
          severity: "blocking",
          title: "Task has no process instructions",
          summary: `${title} has no linked process doc yet; attach one so operators can open the instructions.`,
          source: "runtime task scan",
          nextAction: "open task",
          taskId: task.id,
          cardId: task.cardId,
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
          cardId: task.cardId,
          instructionDocId: docId,
        }),
      );
    }
    return findings;
  }

  function buildTaskProcessQualityFindings(task, qualitySnapshot) {
    const runtimeFindings = runtimeTaskQualityFindings(task);
    const doc = task.instructionDocId
      ? resolveDocReference(task.instructionDocId)
      : null;
    const docFindings = doc
      ? qualitySnapshot.findings
          .filter((finding) =>
            findingMatchesDoc(normalizeQualityFinding(finding), doc),
          )
          .map((finding) =>
            normalizeQualityFinding({
              ...finding,
              id: `${finding.id}:panel:${task.id}`,
              severity: "blocking",
              taskId: task.id,
              cardId: task.cardId,
              nextAction: "open doc",
            }),
          )
      : [];
    return dedupeQualityFindings([...runtimeFindings, ...docFindings]).sort(
      compareQualityFindings,
    );
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
      (validation.requiredEvidence || validation.requiredCardLinks),
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
        cards: options.cards,
        cardTasks: options.cardTasks,
        errors: options.workErrors,
      },
      { today },
    );
    const recurring = normalizeOperationsRecurringSnapshot(
      options.recurringSnapshot || {},
    );
    const hasLiveWork = work.loaded;
    // Missing-proof spans direct Task queries and Card checklist Tasks. Its
    // list is trustworthy only when every contributing source has loaded.
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
    const cardItems = work.cardsLoaded
      ? work.activeCards.map((card) =>
          operationItemFromCard(card, work.cardTasks[card.id] || [], {
            today,
          }),
        )
      : [];
    const missingProofTasks = homeWork.tasks.missingProof;
    const missingProofItems =
      tasksLoaded && work.cardTasksComplete
        ? missingProofTasks.map((task) =>
            operationItemFromTask(task, { today }),
          )
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
        empty: !tasksLoaded
          ? "Live work data unavailable; missing-proof work cannot be confirmed."
          : work.cardTasksComplete
            ? "No tasks waiting on proof."
            : "Card task data is incomplete; missing-proof totals are partial.",
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
        id: "cards",
        title: "At-risk Cards",
        empty: work.cardsLoaded
          ? "No active Cards."
          : "No live Card data loaded.",
        items: cardItems,
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
        cardsLoaded: work.cardsLoaded,
        cardsComplete: work.cardsComplete,
        usersLoaded: work.usersLoaded,
        cardTasksComplete: work.cardTasksComplete,
        missingProofLoaded: tasksLoaded && work.cardTasksComplete,
        todayTasks: homeWork.counts.today,
        overdueTasks: homeWork.counts.overdue,
        waitingTasks: homeWork.counts.waiting,
        followUpTasks: homeWork.counts.followUps,
        missingProofTasks: work.cardTasksComplete
          ? homeWork.counts.missingProof
          : 0,
        activeCards: work.activeCards.length,
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
    if (!options.continueCards || !cardsLoader) {
      cardsLoader = createCollectionLoader({
        request,
        createUrl: (parameters) => workApiUrl("/api/cards", parameters),
        collection: "cards",
      });
    }
    const usersUrl = workApiUrl("/api/users");
    const meUrl = workApiUrl("/api/me");
    const localContext = await readLocalPreviewContext();
    const meRequest = localContext?.actorEmail
      ? Promise.resolve({})
      : request(meUrl);
    let cardsPromise;
    if (options.continueCards && cardsLoader) {
      const currentPage = cardsLoader.getSnapshot();
      cardsPromise = !currentPage.loaded || (currentPage.failed && !currentPage.cursor)
        ? cardsLoader.load()
        : currentPage.failed && currentPage.cursor
          ? cardsLoader.loadMore()
          : Promise.resolve(currentPage);
    } else {
      cardsPromise = cardsLoader.load();
    }
    const [
      todayResult,
      overdueResult,
      waitingResult,
      cardsResult,
      usersResult,
      meResult,
    ] = await Promise.allSettled([
      request(todayUrl),
      request(overdueUrl),
      request(waitingUrl),
      cardsPromise,
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
    let cardPage = settledPayload(cardsResult);
    while (cardPage.moreAvailable && !cardPage.failed) {
      cardPage = await cardsLoader.loadMore();
    }
    const cardsRequestFailed = Boolean(cardPage.failed);
    const cardsRequestError = String(cardPage.error || "");
    if (cardPage.loaded && !cardPage.failed) {
      lastGoodCardsPage = cardPage;
    } else if (cardPage.failed && !cardPage.loaded && lastGoodCardsPage) {
      // A fresh reload that never received its first page must not erase the
      // operator's last known-good view. The runtime error above still makes
      // that retained view explicitly stale.
      cardPage = lastGoodCardsPage;
    }

    snapshot.loaded =
      [
        todayResult,
        overdueResult,
        waitingResult,
        usersResult,
      ].some((result) => result.status === "fulfilled") ||
      Boolean(cardPage.loaded);
    // Per-lane load state (#97): each fetch tracks whether its OWN data source
    // resolved, so a single failed endpoint degrades only its lane rather than
    // hiding the whole work surface behind the coarse `.some()` signal above.
    snapshot.todayLoaded = todayResult.status === "fulfilled";
    snapshot.overdueLoaded = overdueResult.status === "fulfilled";
    snapshot.waitingLoaded = waitingResult.status === "fulfilled";
    snapshot.cardsLoaded = Boolean(cardPage.loaded);
    // A retained last-known-good Card page is stale evidence after a failed
    // reload; it may remain visible, but its completeness must not become the
    // authority for today's counters.
    snapshot.cardsComplete = !cardsRequestFailed && Boolean(cardPage.complete);
    snapshot.usersLoaded = usersResult.status === "fulfilled";
    snapshot.todayTasks = tasksFromWorkPayload(settledPayload(todayResult));
    snapshot.overdueTasks = tasksFromWorkPayload(settledPayload(overdueResult));
    snapshot.waitingTasks = tasksFromWorkPayload(settledPayload(waitingResult));
    snapshot.cards = cardPage.items || [];
    snapshot.users = usersFromWorkPayload(settledPayload(usersResult));
    snapshot.currentOperatorId = currentOperatorIdFromPayload(
      settledPayload(meResult),
    );
    snapshot.errors = [
      todayResult,
      overdueResult,
      waitingResult,
      usersResult,
    ]
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason?.message || "Work API request failed");
    if (cardsRequestFailed || cardPage.failed) {
      snapshot.errors.push(
        cardsRequestError ||
          cardPage.error ||
          "Cards could not be completely loaded",
      );
    }

    const activeCards = snapshot.cards.filter(isActiveWorkCard);

    const cardTaskResults = await Promise.allSettled(
      activeCards.map((card) =>
        request(workApiUrl("/api/tasks", { cardId: card.id })),
      ),
    );
    activeCards.forEach((card, index) => {
      const result = cardTaskResults[index];
      if (result.status === "fulfilled") {
        snapshot.cardTasks[card.id] = tasksFromWorkPayload(result.value);
      } else {
        snapshot.errors.push(
          result.reason?.message ||
            `Could not load tasks for ${card.title || card.id}`,
        );
      }
    });
    snapshot.cardTasksComplete =
      !cardsRequestFailed &&
      cardPage.complete &&
      cardTaskResults.every((result) => result.status === "fulfilled");

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
    buildTaskProcessQualityFindings,
    refreshOperationsQualitySnapshot,
    refreshOperationsWorkSnapshot,
    renderOperationsHome,
  };
}
