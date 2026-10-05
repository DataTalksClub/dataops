import { createCollectionLoader } from "./collection-loader.js";
import {
  addDaysIso,
  deriveScopedWorkState,
  isActiveWorkCard,
  isOpenWorkTask,
  todayIsoDate,
  workCardTitle,
  workTaskTitle,
} from "./workspace.js";

// Every operations surface - Tasks, Process Docs, Admin, and the task panel -
// reads the same shape: lanes of work items, templates, quality findings, and
// per-lane load state. This module owns that shape and the two snapshots behind
// it, so no single destination surface is the reason the work model exists.
export function createWorkModel(context) {
  const {
    activeWorkOwner,
    activeWorkOwnerId,
    allWorkTasks,
    apiUrl,
    buildOperationsFutureSections,
    buildOperationsReferenceLinks,
    compareQualityFindings,
    currentOperatorIdForTodayScope,
    currentOperatorIdFromPayload,
    dedupeQualityFindings,
    emptyOperationsQualitySnapshot,
    emptyOperationsWorkSnapshot,
    findingMatchesCard,
    isOperationsWorkspaceVisible,
    isWorkflowTemplateDoc,
    normalizeOperationsQualitySnapshot,
    normalizeOperationsRecurringSnapshot,
    normalizeOperationsWorkSnapshot,
    normalizeQualityFinding,
    normalizeTemplateMatchValue,
    operationItemFromCard,
    operationItemFromTask,
    operationItemFromTemplate,
    readLocalPreviewContext,
    refreshAccountIdentity,
    refreshDocuments,
    refreshWorkBell,
    request,
    resolveDocReference,
    settledPayload,
    state,
    summarizeWorkflowTemplate,
    taskHasClearProofInstruction,
    taskNeedsProofInstruction,
    tasksFromWorkPayload,
    usersFromWorkPayload,
    workApiUrl,
    workflowPriority,
  } = context;

  let cardsLoader;
  let lastGoodCardsPage;

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
    const visibleFindings = (
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
      visibleFindings,
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
        findingMatchesCard(finding, card, normalizeTemplateMatchValue),
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

  function buildOperationsWorkModel(documents, options) {
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
    const scopedWork = deriveScopedWorkState(work, {
      today,
      selectedOwnerId,
      currentOperatorId: scopedCurrentOperatorId,
    });
    const todayItems = work.todayLoaded
      ? scopedWork.tasks.today.map((task) =>
          operationItemFromTask(task, { today }),
        )
      : [];
    const overdueItems = work.overdueLoaded
      ? scopedWork.tasks.overdue.map((task) =>
          operationItemFromTask(task, { today, overdue: true }),
        )
      : [];
    const followUpItems = work.waitingLoaded
      ? scopedWork.tasks.followUps.map((task) =>
          operationItemFromTask(task, { today, followUp: true }),
        )
      : [];
    const waitingItems = work.waitingLoaded
      ? scopedWork.tasks.waiting.map((task) =>
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
    const missingProofItems =
      tasksLoaded && work.cardTasksComplete
        ? scopedWork.tasks.missingProof.map((task) =>
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
        // work-queue and Cards surfaces.
        todayLoaded: work.todayLoaded,
        overdueLoaded: work.overdueLoaded,
        waitingLoaded: work.waitingLoaded,
        cardsLoaded: work.cardsLoaded,
        cardsComplete: work.cardsComplete,
        usersLoaded: work.usersLoaded,
        cardTasksComplete: work.cardTasksComplete,
        missingProofLoaded: tasksLoaded && work.cardTasksComplete,
        todayTasks: scopedWork.counts.today,
        overdueTasks: scopedWork.counts.overdue,
        waitingTasks: scopedWork.counts.waiting,
        followUpTasks: scopedWork.counts.followUps,
        missingProofTasks: work.cardTasksComplete
          ? scopedWork.counts.missingProof
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
    if (options.rerender && isOperationsWorkspaceVisible()) refreshDocuments();
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
      cardsPromise =
        !currentPage.loaded || (currentPage.failed && !currentPage.cursor)
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
    // fetches resolves, which is enough for a surface to start rendering. This is
    // intentionally permissive: on a partial outage the queue can render with
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
    // authority for the counters.
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
    if (options.rerender && isOperationsWorkspaceVisible()) refreshDocuments();
    refreshWorkBell();
  }

  return {
    buildOperationsWorkModel,
    buildProcessQualityModel,
    buildTaskProcessQualityFindings,
    refreshOperationsQualitySnapshot,
    refreshOperationsWorkSnapshot,
  };
}