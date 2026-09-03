import {
  cardAnchorTone,
  compareIsoDate,
  dedupeWorkTasks,
  describeRecurringRun,
  formatCardAnchorLabel,
  formatTaskDateMeta,
  isActiveWorkCard,
  isBeforeIsoDate,
  isCanonicalWorkTask,
  isOpenWorkTask,
  isTaskDueToday,
  isTaskOverdue,
  isWaitingOrFollowUpTask,
  summarizeCardProgress,
  taskDate,
  taskProofState,
  tasksFromWorkPayload,
  todayIsoDate,
  workCardTitle,
  workTaskTitle,
} from "./workspace.js";

export function emptyOperationsWorkSnapshot() {
  return {
    loaded: false,
    currentOperatorId: "",
    todayTasks: [],
    overdueTasks: [],
    waitingTasks: [],
    cards: [],
    users: [],
    cardTasks: {},
    errors: [],
    todayLoaded: false,
    overdueLoaded: false,
    waitingLoaded: false,
    cardsLoaded: false,
    cardsComplete: false,
    cardTasksComplete: false,
    usersLoaded: false,
  };
}

export function emptyOperationsRecurringSnapshot() {
  return { loaded: false, recurringConfigs: [], errors: [] };
}

export function emptyOperationsArtifactSnapshot() {
  return { loaded: false, artifacts: [], errors: [] };
}

export function emptyOperationsAssistantSnapshot() {
  return { loaded: false, jobs: [], errors: [] };
}

export function emptyOperationsQualitySnapshot() {
  return {
    loaded: false,
    ok: false,
    findings: [],
    summary: {
      total: 0,
      blocking: 0,
      warning: 0,
      info: 0,
      byCategory: {},
    },
    errors: [],
    validationErrors: [],
  };
}

export function emptyOperationsReviewSnapshot() {
  return {
    loaded: false,
    reviews: [],
    errors: [],
    updatedAt: null,
  };
}

// ---------- Process document availability ----------
//
// One snapshot, derived from the single `GET /docs` bootstrap request, tells
// every surface whether the process-document corpus is still loading, was
// answered by the docs service, or is unreachable. An unreachable corpus must
// never be rendered as an empty one, so the three states stay distinguishable
// and no surface probes `/docs` again to find out.

const DOCS_UNAVAILABLE_TITLE = "Process documents are unavailable";
const DOCS_EMPTY_TITLE = "No process documents yet";
const DOCS_UNAVAILABLE_FALLBACK_MESSAGE =
  "Process documents could not be loaded and the server gave no reason.";
const DOCS_UNAVAILABLE_GUIDANCE =
  "Work, Cards, and Tasks are unaffected. Reload this page once the docs service is restored.";
const DOCS_EMPTY_BODY =
  "The docs service answered and the process-document corpus contains no documents.";
const DOCS_EMPTY_GUIDANCE =
  "Publish a process document to fill this surface. Nothing is being hidden by an error.";

export function emptyOperationsDocsSnapshot() {
  return { state: "loading", documentCount: 0, error: "", status: 0 };
}

export function loadedOperationsDocsSnapshot(documents) {
  return {
    state: "loaded",
    documentCount: Array.isArray(documents) ? documents.length : 0,
    error: "",
    status: 0,
  };
}

export function unavailableOperationsDocsSnapshot(error) {
  const message = String(error?.message || "").trim();
  return {
    state: "unavailable",
    documentCount: 0,
    error: message || DOCS_UNAVAILABLE_FALLBACK_MESSAGE,
    status: Number(error?.status) || 0,
  };
}

/**
 * Describe what a surface should render for a docs snapshot, or `null` when it
 * should render nothing. Loading never looks like an outage, and the empty
 * state only appears where a surface asks for it.
 */
export function docsAvailabilityView(snapshot, options = {}) {
  const state = snapshot?.state;
  if (state === "unavailable") {
    return {
      docsState: "unavailable",
      title: DOCS_UNAVAILABLE_TITLE,
      body: String(snapshot.error || "").trim() || DOCS_UNAVAILABLE_FALLBACK_MESSAGE,
      detail: DOCS_UNAVAILABLE_GUIDANCE,
    };
  }
  if (
    state === "loaded" &&
    Number(snapshot.documentCount || 0) === 0 &&
    options.includeEmpty === true
  ) {
    return {
      docsState: "empty",
      title: DOCS_EMPTY_TITLE,
      body: DOCS_EMPTY_BODY,
      detail: DOCS_EMPTY_GUIDANCE,
    };
  }
  return null;
}

export function settledPayload(result) {
  return result && result.status === "fulfilled" ? result.value : {};
}

export function cardsFromWorkPayload(payload) {
  if (!payload || typeof payload !== "object") return [];
  const collection = payload.cards;
  if (
    collection &&
    typeof collection === "object" &&
    !Array.isArray(collection) &&
    Array.isArray(collection.items)
  ) {
    return collection.items;
  }
  return [];
}

export function usersFromWorkPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.users)) return payload.users;
  if (Array.isArray(payload.items)) return payload.items;
  return [];
}

export function recurringConfigsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.recurringConfigs)) return payload.recurringConfigs;
  if (Array.isArray(payload.configs)) return payload.configs;
  if (Array.isArray(payload.items)) return payload.items;
  return [];
}

export function assistantJobsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.assistantJobs)) return payload.assistantJobs;
  if (Array.isArray(payload.jobs)) return payload.jobs;
  if (Array.isArray(payload.items)) return payload.items;
  return [];
}

export function currentOperatorIdFromPayload(payload) {
  if (!payload || typeof payload !== "object") return "";
  if (payload.user && typeof payload.user === "object" && payload.user.id) {
    return String(payload.user.id);
  }
  if (payload.actor && typeof payload.actor === "object" && payload.actor.id) {
    return String(payload.actor.id);
  }
  if (payload.id) return String(payload.id);
  return "";
}

export function labelizeWorkValue(value) {
  return String(value || "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function normalizeTemplateMatchValue(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+task template$/i, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function taskNeedsProofInstruction(task) {
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

export function taskHasClearProofInstruction(task) {
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

export function findingMatchesDoc(finding, doc) {
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

export function findingMatchesCard(
  finding,
  card,
  normalizeTemplateMatchValue,
) {
  if (!finding || !card) return false;
  const workflowValues = [
    card.templateId,
    card.templateType,
    card.type,
    card.workflowSlug,
    card.workflowType,
    card.slug,
    card.title,
    card.name,
  ]
    .filter(Boolean)
    .map(normalizeTemplateMatchValue);
  const findingValues = [finding.templateId, finding.workflowSlug]
    .filter(Boolean)
    .map(normalizeTemplateMatchValue);
  return findingValues.some((value) => workflowValues.includes(value));
}

export function normalizeOperationsQualitySnapshot(input) {
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

export function normalizeQualityFinding(finding) {
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
    cardId: String(finding.cardId || ""),
  };
}

function normalizeQualitySeverity(value) {
  const severity = String(value || "warning").toLowerCase();
  return ["blocking", "warning", "info"].includes(severity)
    ? severity
    : "warning";
}

export function dedupeQualityFindings(findings) {
  const seen = new Set();
  return findings.map(normalizeQualityFinding).filter((finding) => {
    if (seen.has(finding.id)) return false;
    seen.add(finding.id);
    return true;
  });
}

export function compareQualityFindings(a, b) {
  const order = { blocking: 0, warning: 1, info: 2 };
  const bySeverity = (order[a.severity] ?? 3) - (order[b.severity] ?? 3);
  if (bySeverity !== 0) return bySeverity;
  return `${a.workflowSlug || ""}:${a.category}:${a.title}`.localeCompare(
    `${b.workflowSlug || ""}:${b.category}:${b.title}`,
  );
}

export function createOperationsModel({
  basename,
  cleanPath,
  getRecurringConfigTitle,
  resolveAssigneeLabel,
} = {}) {
  function recurringTitle(config) {
    return getRecurringConfigTitle
      ? getRecurringConfigTitle(config)
      : config?.title || config?.name || config?.id || "Recurring config";
  }

  function normalizeOperationsRecurringSnapshot(input) {
    const snapshot = input && typeof input === "object" ? input : {};
    const configs = recurringConfigsFromPayload(
      snapshot.recurringConfigs || snapshot.configs || [],
    );
    const today = todayIsoDate();
    const normalized = configs
      .filter((config) => config && typeof config === "object")
      .map((config) => {
        const run = describeRecurringRun(config.cronExpression || "", today);
        return {
          ...config,
          enabled: config.enabled !== false,
          scheduleLabel: run.summary,
          nextRunDate: run.nextDate,
          nextRunLabel: run.nextLabel,
        };
      })
      .sort((left, right) => {
        if (left.enabled !== right.enabled) return left.enabled ? -1 : 1;
        return recurringTitle(left).localeCompare(recurringTitle(right));
      });
    return {
      loaded: Boolean(snapshot.loaded),
      configs: normalized,
      enabled: normalized.filter((config) => config.enabled !== false),
      disabled: normalized.filter((config) => config.enabled === false),
      errors: Array.isArray(snapshot.errors) ? snapshot.errors : [],
    };
  }

  function normalizeCardTaskMap(cardTasks, fallbackTasks) {
    const output = {};
    if (
      cardTasks &&
      typeof cardTasks === "object" &&
      !Array.isArray(cardTasks)
    ) {
      for (const [cardId, tasks] of Object.entries(cardTasks)) {
        output[cardId] = tasksFromWorkPayload(tasks);
      }
    }
    for (const task of tasksFromWorkPayload(fallbackTasks || [])) {
      if (!task || !task.cardId) continue;
      if (!output[task.cardId]) output[task.cardId] = [];
      output[task.cardId].push(task);
    }
    for (const [cardId, tasks] of Object.entries(output)) {
      output[cardId] = dedupeWorkTasks(tasks);
    }
    return output;
  }

  function taskSortDate(task, mode) {
    if (mode === "waiting") return task.followUpAt || task.date || "";
    return task.date || task.followUpAt || "";
  }

  function sortWorkTasks(tasks, mode, today) {
    const sorted = dedupeWorkTasks(tasks).filter(isOpenWorkTask);
    sorted.sort((left, right) => {
      const dateLeft = taskSortDate(left, mode);
      const dateRight = taskSortDate(right, mode);
      const byDate = compareIsoDate(dateLeft, dateRight);
      if (byDate !== 0) return byDate;
      if (mode === "overdue") {
        return compareIsoDate(
          taskDate(left) || today,
          taskDate(right) || today,
        );
      }
      return workTaskTitle(left).localeCompare(workTaskTitle(right));
    });
    return sorted.slice(0, 12);
  }

  function sortActiveWorkCards(cards, cardTasks, today) {
    const scored = cards.map((card) => ({
      card,
      progress: summarizeCardProgress(
        card,
        cardTasks[card.id] || [],
        today,
      ),
    }));
    scored.sort((left, right) => {
      const riskOrder = { high: 0, medium: 1, low: 2 };
      const byRisk =
        (riskOrder[left.progress.risk] ?? 2) -
        (riskOrder[right.progress.risk] ?? 2);
      if (byRisk !== 0) return byRisk;
      const byDate = compareIsoDate(
        left.card.anchorDate || "",
        right.card.anchorDate || "",
      );
      if (byDate !== 0) return byDate;
      return workCardTitle(left.card).localeCompare(
        workCardTitle(right.card),
      );
    });
    return scored.map((entry) => entry.card);
  }

  function normalizeOperationsWorkSnapshot(input, options = {}) {
    const today = options.today || todayIsoDate();
    const snapshot = input && typeof input === "object" ? input : {};
    const allTasks = dedupeWorkTasks([
      ...tasksFromWorkPayload(snapshot.tasks || []),
      ...tasksFromWorkPayload(snapshot.todayTasks || []),
      ...tasksFromWorkPayload(snapshot.overdueTasks || []),
      ...tasksFromWorkPayload(snapshot.waitingTasks || []),
    ]);
    const explicitToday = tasksFromWorkPayload(snapshot.todayTasks || []);
    const explicitOverdue = tasksFromWorkPayload(snapshot.overdueTasks || []);
    const explicitWaiting = tasksFromWorkPayload(snapshot.waitingTasks || []);
    // The HTTP adapter requires the canonical `{ cards: { items } }` envelope.
    // A work snapshot, however, already stores the loader's materialized Card
    // items, so do not send that internal list back through the HTTP adapter.
    const cards = Array.isArray(snapshot.cards)
      ? snapshot.cards
      : cardsFromWorkPayload(snapshot);
    const users = usersFromWorkPayload(snapshot.users || []);
    const cardTasks = normalizeCardTaskMap(
      snapshot.cardTasks || {},
      allTasks,
    );
    const laneLoaded = (flag) =>
      snapshot[flag] === undefined
        ? Boolean(snapshot.loaded)
        : Boolean(snapshot[flag]);
    const taskCount = (value, fallback) =>
      Number.isFinite(Number(value)) ? Number(value) : fallback;
    const normalizedTodayTasks = dedupeWorkTasks([
      ...explicitToday,
      ...allTasks.filter((task) => isTaskDueToday(task, today)),
    ]);
    const normalizedOverdueTasks = dedupeWorkTasks([
      ...explicitOverdue,
      ...allTasks.filter((task) => isTaskOverdue(task, today)),
    ]);
    const normalizedWaitingTasks = dedupeWorkTasks([
      ...explicitWaiting,
      ...allTasks.filter((task) => isWaitingOrFollowUpTask(task)),
    ]);

    return {
      loaded: Boolean(snapshot.loaded),
      todayLoaded: laneLoaded("todayLoaded"),
      overdueLoaded: laneLoaded("overdueLoaded"),
      waitingLoaded: laneLoaded("waitingLoaded"),
      cardsLoaded: laneLoaded("cardsLoaded"),
      cardsComplete: Boolean(snapshot.cardsComplete),
      cardTasksComplete: Boolean(snapshot.cardTasksComplete),
      usersLoaded: laneLoaded("usersLoaded"),
      currentOperatorId: String(snapshot.currentOperatorId || ""),
      todayTasks: sortWorkTasks(normalizedTodayTasks, "today", today),
      overdueTasks: sortWorkTasks(normalizedOverdueTasks, "overdue", today),
      waitingTasks: sortWorkTasks(normalizedWaitingTasks, "waiting", today),
      todayTaskCount: taskCount(
        snapshot.todayTaskCount,
        normalizedTodayTasks.length,
      ),
      overdueTaskCount: taskCount(
        snapshot.overdueTaskCount,
        normalizedOverdueTasks.length,
      ),
      waitingTaskCount: taskCount(
        snapshot.waitingTaskCount,
        normalizedWaitingTasks.length,
      ),
      activeCards: sortActiveWorkCards(
        cards.filter(isActiveWorkCard),
        cardTasks,
        today,
      ),
      cards,
      cardsById: new Map(
        cards
          .filter((card) => card && card.id)
          .map((card) => [card.id, card]),
      ),
      users,
      usersById: new Map(
        users
          .filter((user) => user && user.id)
          .map((user) => [user.id, user]),
      ),
      cardTasks,
      errors: Array.isArray(snapshot.errors) ? snapshot.errors : [],
    };
  }

  function isCurrentOperatorTodayTask(task, currentOperatorId) {
    if (!isOpenWorkTask(task)) return false;
    const assigneeId = String(task.assigneeId || "");
    return !assigneeId || assigneeId === String(currentOperatorId || "");
  }

  function isTaskAssignedTo(task, userId) {
    return (
      isOpenWorkTask(task) &&
      String(task?.assigneeId || "") === String(userId || "")
    );
  }

  function isSyntheticCurrentOperatorId(currentOperatorId) {
    return String(currentOperatorId || "").trim().toLowerCase() === "portal-admin";
  }

  function currentOperatorIdForTodayScope(currentOperatorId) {
    const id = String(currentOperatorId || "").trim();
    if (!id || isSyntheticCurrentOperatorId(id)) return "";
    return id;
  }

  function taskSourceLabel(task) {
    if (task?.source) return labelizeWorkValue(task.source);
    if (task?.recurringConfigId) return "Recurring";
    if (task?.templateId || task?.cardId) return "Card";
    return "Ad hoc";
  }

  function taskNextActionLabel(task, today) {
    if (!isCanonicalWorkTask(task)) return "Task unavailable";
    const status = task.status;
    if (status === "waiting") {
      if (
        task?.followUpAt &&
        !isBeforeIsoDate(today, String(task.followUpAt).slice(0, 10))
      ) {
        return "Follow up";
      }
      return "Mark response received";
    }
    const proof = taskProofState(task);
    if (!proof.ok) {
      const first = proof.missing[0] || "proof";
      return first === "required file" ? "Attach file" : `Add ${first}`;
    }
    return "Mark done";
  }

  function operationItemFromTask(task, options = {}) {
    const today = options.today || todayIsoDate();
    const proof = taskProofState(task);
    const meta = [];
    if (task.date) meta.push(`Due ${formatTaskDateMeta(task.date, today)}`);
    if (task.status) meta.push(task.status);
    meta.push(task.cardId ? "Card" : "Independent");
    meta.push(taskSourceLabel(task));
    if (task.assigneeId) {
      meta.push(`Owner ${resolveAssigneeLabel(task.assigneeId)}`);
    }
    meta.push(proof.label);
    meta.push(`Next: ${taskNextActionLabel(task, today)}`);
    const summary = task.waitingFor
      ? `Waiting for ${task.waitingFor}${
          task.followUpAt
            ? `; follow up ${formatTaskDateMeta(task.followUpAt, today)}`
            : ""
        }`
      : !proof.ok
        ? proof.label
        : task.comment ||
          task.instructionsUrl ||
          task.link ||
          "Ready for the next operating action.";
    return {
      title: workTaskTitle(task),
      summary,
      meta: meta.join(" - "),
      taskId: task.id,
      cardId: task.cardId,
      dueDate: taskDate(task),
      followUpDate: String(task.followUpAt || "").slice(0, 10),
      nextAction: taskNextActionLabel(task, today),
      proof,
      risk: options.overdue
        ? "high"
        : options.waiting || !proof.ok
          ? "medium"
          : "low",
    };
  }

  function operationItemFromCard(card, tasks, options = {}) {
    const today = options.today || todayIsoDate();
    const relationshipsComplete = options.cardTasksComplete !== false;
    const progress = relationshipsComplete
      ? summarizeCardProgress(card, tasks, today)
      : null;
    const relationshipLabel = "Task relationships unavailable";
    const summaryParts = [];
    if (card.stage) summaryParts.push(labelizeWorkValue(card.stage));
    if (card.anchorDate) {
      summaryParts.push(
        `Anchor ${formatTaskDateMeta(card.anchorDate, today)}`,
      );
    }
    if (progress?.nextDueTask) {
      const nextDate = taskDate(progress.nextDueTask);
      const timing = nextDate
        ? ` (${formatTaskDateMeta(nextDate, today)})`
        : "";
      summaryParts.push(
        `Next: ${workTaskTitle(progress.nextDueTask)}${timing}`,
      );
    }
    if (card.description) summaryParts.push(card.description);
    const anchorDate = String(card.anchorDate || "").slice(0, 10);
    return {
      title: workCardTitle(card),
      stage: card.stage || "",
      summary: summaryParts.join(" - "),
      meta: progress ? progress.label : relationshipLabel,
      cardId: card.id,
      anchorDate,
      completedAt: card.completedAt || "",
      anchorLabel: formatCardAnchorLabel(anchorDate, today),
      anchorTone: cardAnchorTone(anchorDate, today),
      taskRelationshipsComplete: relationshipsComplete,
      progress,
      risk: progress?.risk ?? "",
    };
  }

  function isWorkflowTemplateDoc(doc) {
    if (!doc || !doc.path) return false;
    return (
      doc.doc_type === "task-template" ||
      cleanPath(doc.path).startsWith("tasks/templates/")
    );
  }

  function workflowSlugFromDoc(doc) {
    const docPath = cleanPath(doc.path || "");
    const filename = docPath.split("/").pop() || "";
    return filename.replace(/\.md$/, "");
  }

  function isRecurringWorkflowSlug(slug) {
    return ["newsletter", "social-media", "tax-report"].includes(slug);
  }

  function isAtRiskWorkflowSlug(slug) {
    return [
      "podcast",
      "webinar",
      "workshop",
      "newsletter",
      "tax-report",
    ].includes(slug);
  }

  function summarizeWorkflowTemplate(doc) {
    const slug = workflowSlugFromDoc(doc);
    const tags = Array.isArray(doc.tags)
      ? doc.tags.filter((tag) => tag && tag !== "task-template")
      : [];
    return {
      title: (doc.title || basename(doc.path || "")).replace(
        /\s+Task Template$/i,
        "",
      ),
      summary: doc.summary || "Git-backed Card template.",
      path: doc.path,
      slug,
      tags,
      recurring: isRecurringWorkflowSlug(slug),
      atRisk: isAtRiskWorkflowSlug(slug),
    };
  }

  function workflowPriority(slug) {
    const order = [
      "newsletter",
      "podcast",
      "webinar",
      "workshop",
      "book-of-the-week",
      "course",
      "office-hours",
      "tax-report",
      "social-media",
      "oss",
      "maven-ll",
    ];
    const index = order.indexOf(slug);
    return index === -1 ? order.length : index;
  }

  function isFollowUpDoc(doc) {
    if (!doc || isWorkflowTemplateDoc(doc)) return false;
    const haystack = [
      doc.title || "",
      doc.summary || "",
      (doc.tags || []).join(" "),
      doc.path || "",
    ]
      .join(" ")
      .toLowerCase();
    return /\b(waiting|follow[- ]?up|remind|reminder|reach[- ]?out|contact|reply|email)\b/.test(
      haystack,
    );
  }

  function operationItemFromTemplate(template) {
    const badges = [];
    if (template.recurring) badges.push("Recurring");
    if (template.atRisk) badges.push("Watch");
    return {
      title: template.title,
      summary: template.summary,
      meta: badges.join(" · ") || "Template",
      path: template.path,
    };
  }

  function operationItemFromDoc(doc, meta) {
    return {
      title: doc.title || basename(doc.path || ""),
      summary: doc.summary || doc.path || "",
      meta,
      path: doc.path,
    };
  }

  function dedupeOperationItems(items) {
    const seen = new Set();
    const output = [];
    for (const item of items) {
      const key = item.path || item.title;
      if (seen.has(key)) continue;
      seen.add(key);
      output.push(item);
    }
    return output;
  }

  function buildOperationsFutureSections() {
    return [
      {
        id: "inbox",
        title: "Inbox",
        status: "Not connected yet",
        body:
          "Telegram, email, manual notes, files, and assistant-ready inputs " +
          "will land here when the durable inbox model ships in #31.",
      },
      {
        id: "assistant-jobs",
        title: "Assistant Jobs",
        status: "Not connected yet",
        body:
          "Assistant run status, approvals, retries, logs, and outputs will " +
          "appear here after the assistant job lifecycle ships in #30.",
      },
    ];
  }

  function buildOperationsReferenceLinks(docs) {
    const indexed = [
      docs.find(
        (doc) => doc.path === "content/tasks/templates/newsletter.md",
      ),
      docs.find((doc) => doc.path === "content/tasks/templates/podcast.md"),
      docs.find(
        (doc) =>
          doc.path ===
          "content/finance/reference/invoices-receipts-and-statements.md",
      ),
      docs.find(
        (doc) => doc.path === "content/courses/reference/course-guide.md",
      ),
      docs.find(
        (doc) => doc.path === "content/overview/reference/schedule.md",
      ),
    ]
      .filter(Boolean)
      .map((doc) => ({
        title: doc.title || basename(doc.path),
        summary: doc.summary || doc.path,
        path: doc.path,
      }));

    const repoReferences = [
      [
        "DataOps V1 Goal",
        "https://github.com/DataTalksClub/dataops/blob/main/.goal-v1.md",
      ],
      [
        "Project Plan",
        "https://github.com/DataTalksClub/dataops/blob/main/PROJECT_PLAN.md",
      ],
      [
        "Portal Analysis",
        "https://github.com/DataTalksClub/dataops/blob/main/PORTAL_ANALYSIS.md",
      ],
      [
        "Merge Plan",
        "https://github.com/DataTalksClub/dataops/blob/main/docs/MERGE_PLAN.md",
      ],
    ].map(([title, href]) => ({
      title,
      href,
      summary: "Planning reference",
    }));

    return [...indexed, ...repoReferences];
  }

  return {
    buildOperationsFutureSections,
    buildOperationsReferenceLinks,
    dedupeOperationItems,
    isAtRiskWorkflowSlug,
    isCurrentOperatorTodayTask,
    isFollowUpDoc,
    isRecurringWorkflowSlug,
    isSyntheticCurrentOperatorId,
    isTaskAssignedTo,
    isWorkflowTemplateDoc,
    currentOperatorIdForTodayScope,
    normalizeCardTaskMap,
    normalizeOperationsRecurringSnapshot,
    normalizeOperationsWorkSnapshot,
    operationItemFromCard,
    operationItemFromDoc,
    operationItemFromTask,
    operationItemFromTemplate,
    sortActiveWorkCards,
    sortWorkTasks,
    summarizeWorkflowTemplate,
    taskNextActionLabel,
    taskSortDate,
    taskSourceLabel,
    workflowPriority,
    workflowSlugFromDoc,
  };
}
