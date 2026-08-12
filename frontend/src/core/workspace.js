// Canonical workspace routes and navigation vocabulary.
export const WORKSPACE_HASH_BY_VIEW = Object.freeze({
  home: "/",
  inbox: "/inbox",
  docs: "/processes",
  admin: "/admin",
  users: "/users",
  bookkeeping: "/bookkeeping",
  sponsors: "/sponsors",
  newsletter: "/newsletter",
  calendar: "/calendar",
  "mailing-exports": "/mailing-exports",
});

export const WORKSPACE_ROUTE_DEFINITIONS = Object.freeze({
  "/": { view: "home", tasksSection: "queue", params: [] },
  "/inbox": { view: "inbox", tasksSection: "queue", params: ["intakeId"] },
  "/tasks": {
    view: "tasks",
    tasksSection: "queue",
    params: ["taskId", "date", "bundleId", "contextBundleId"],
  },
  "/cards": {
    view: "tasks",
    tasksSection: "workflows",
    params: ["cardId", "taskId"],
  },
  "/cards/archive": {
    view: "tasks",
    tasksSection: "workflows",
    params: ["cardId", "taskId"],
  },
  "/assistants": {
    view: "tasks",
    tasksSection: "assistants",
    params: ["assistantJobId"],
  },
  "/templates": {
    view: "tasks",
    tasksSection: "templates",
    params: ["templateId"],
  },
  "/recurring": { view: "tasks", tasksSection: "templates", params: [] },
  "/artifacts": { view: "tasks", tasksSection: "artifacts", params: [] },
  "/notifications": { view: "home", tasksSection: "queue", params: [] },
  "/bookkeeping": { view: "bookkeeping", tasksSection: "queue", params: [] },
  "/sponsors": {
    view: "sponsors",
    tasksSection: "queue",
    params: ["bookingId"],
  },
  "/newsletter": { view: "newsletter", tasksSection: "queue", params: [] },
  "/calendar": { view: "calendar", tasksSection: "queue", params: [] },
  "/mailing-exports": {
    view: "mailing-exports",
    tasksSection: "queue",
    params: [],
  },
  "/processes": { view: "docs", tasksSection: "queue", params: [] },
  "/admin": { view: "admin", tasksSection: "queue", params: [] },
  "/users": { view: "users", tasksSection: "queue", params: [] },
});

export const TASKS_SECTIONS = Object.freeze([
  Object.freeze(["queue", "Queue"]),
  Object.freeze(["workflows", "Cards"]),
  Object.freeze(["templates", "Templates"]),
  Object.freeze(["assistants", "Assistants"]),
  Object.freeze(["artifacts", "Artifacts"]),
]);

export const ENTITY_VOCABULARY = Object.freeze({
  template: "Template",
  card: "Card",
  task: "Task",
});

export function tasksSectionTitle(section) {
  const titles = {
    queue: "Tasks - Work Queue",
    workflows: "Tasks - Cards",
    templates: "Tasks - Templates",
    assistants: "Tasks - Assistants",
    artifacts: "Tasks - Artifacts",
  };
  return titles[section] || "Tasks - Work Queue";
}

export function workspaceHashPath(view, tasksSection = "queue") {
  if (view === "tasks") {
    return (
      {
        queue: "/tasks",
        workflows: "/cards",
        templates: "/templates",
        assistants: "/assistants",
        artifacts: "/artifacts",
      }[tasksSection] || "/tasks"
    );
  }
  return WORKSPACE_HASH_BY_VIEW[view] || "/";
}

export function isRealIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

export function canonicalWorkspaceUrl(path, params = new URLSearchParams()) {
  const definition =
    WORKSPACE_ROUTE_DEFINITIONS[path] || WORKSPACE_ROUTE_DEFINITIONS["/"];
  const ordered = new URLSearchParams();
  for (const name of definition.params) {
    const value =
      params instanceof URLSearchParams ? params.get(name) : params?.[name];
    if (value) ordered.set(name, value);
  }
  const query = ordered.toString();
  return `/#${path}${query ? `?${query}` : ""}`;
}

export function parseWorkspaceHash(
  rawHash,
  location = globalThis.window?.location,
) {
  const raw = String(
    rawHash === undefined ? location?.hash || "" : rawHash || "",
  );
  if (!raw) return { invalid: true, reason: "empty hash" };
  if (!raw.startsWith("#/") || raw.includes("#", 1)) {
    return { invalid: true, reason: "malformed hash" };
  }

  const value = raw.slice(1);
  const queryIndex = value.indexOf("?");
  const rawPath = queryIndex >= 0 ? value.slice(0, queryIndex) : value;
  const rawQuery = queryIndex >= 0 ? value.slice(queryIndex + 1) : "";
  if (rawQuery.includes("?"))
    return { invalid: true, reason: "malformed query" };

  try {
    decodeURIComponent(rawPath);
    for (const component of rawQuery.split("&").filter(Boolean)) {
      const separator = component.indexOf("=");
      decodeURIComponent(
        (separator >= 0 ? component.slice(0, separator) : component).replace(
          /\+/g,
          " ",
        ),
      );
      decodeURIComponent(
        (separator >= 0 ? component.slice(separator + 1) : "").replace(
          /\+/g,
          " ",
        ),
      );
    }
  } catch {
    return { invalid: true, reason: "malformed encoding" };
  }

  const path =
    rawPath.endsWith("/") && rawPath !== "/" ? rawPath.slice(0, -1) : rawPath;
  const definition = WORKSPACE_ROUTE_DEFINITIONS[path];
  if (!definition) return { invalid: true, reason: "unknown path" };

  const incoming = new URLSearchParams(rawQuery);
  const params = new URLSearchParams();
  for (const name of definition.params) {
    const values = incoming.getAll(name);
    if (values.length > 1 || (values.length === 1 && !values[0])) {
      return { invalid: true, reason: `invalid ${name}` };
    }
    if (values[0]) params.set(name, values[0]);
  }
  if (params.has("date") && !isRealIsoDate(params.get("date"))) {
    return { invalid: true, reason: "invalid date" };
  }
  if (
    ["/cards", "/cards/archive"].includes(path) &&
    params.has("taskId") &&
    !params.has("cardId")
  ) {
    return { invalid: true, reason: "taskId requires cardId" };
  }

  const canonicalUrl = canonicalWorkspaceUrl(path, params);
  const currentUrl = `${location?.pathname || "/"}${location?.search || ""}${raw}`;
  return {
    view: definition.view,
    tasksSection: definition.tasksSection,
    path,
    params,
    canonicalUrl,
    normalized: currentUrl !== canonicalUrl,
  };
}

export function workspaceRouteFor(path, params = {}, location) {
  const visible = canonicalWorkspaceUrl(path, params);
  return parseWorkspaceHash(visible.slice(visible.indexOf("#")), location);
}

// Pure task, Card, proof, and Home view-model helpers.
export const CARD_BOARD_COLUMNS = Object.freeze([
  Object.freeze({ stage: "preparation", label: "Preparation" }),
  Object.freeze({ stage: "announced", label: "Announced" }),
  Object.freeze({ stage: "after-event", label: "After event" }),
]);

export function parseIsoDateValue(value) {
  if (!value) return null;
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

export function toIsoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function todayIsoDate() {
  return toIsoDate(new Date());
}

export function addDaysIso(isoDate, days) {
  const date = parseIsoDateValue(isoDate) || new Date();
  date.setDate(date.getDate() + days);
  return toIsoDate(date);
}

export function compareIsoDate(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return left.localeCompare(right);
}

export function isBeforeIsoDate(a, b) {
  if (!a || !b) return false;
  return String(a).slice(0, 10) < String(b).slice(0, 10);
}

export function isoDayDistance(value, today) {
  const target = parseIsoDateValue(value);
  const origin = parseIsoDateValue(today);
  if (!target || !origin) return 0;
  return Math.round((target.getTime() - origin.getTime()) / 86400000);
}

export function formatHomeCalendarDate(value) {
  const date = parseIsoDateValue(value);
  if (!date) return value || "";
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(date);
}

export function formatHomeShortDate(value) {
  const date = parseIsoDateValue(value);
  if (!date) return value || "";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
  }).format(date);
}

export function formatHomeTaskTiming(item, today) {
  const value = String(
    item.priority === "follow-up"
      ? item.followUpDate
      : item.dueDate || item.followUpDate || "",
  ).slice(0, 10);
  if (!value)
    return item.priority === "missing-proof" ? "Proof required" : "Open task";
  const days = isoDayDistance(value, today);
  if (item.priority === "follow-up") {
    if (days === 0) return "Follow up today";
    if (days < 0)
      return `Follow-up ${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} overdue`;
  }
  if (days === 0) return "Due today";
  if (days === -1) return "Due yesterday";
  if (days === 1) return "Due tomorrow";
  if (days < 0) return `${Math.abs(days)} days overdue`;
  return `Due ${formatHomeShortDate(value)}`;
}

export function formatTaskDateMeta(value, today) {
  const date = String(value || "").slice(0, 10);
  if (!date) return "";
  if (date === today) return "Today";
  if (date === addDaysIso(today, -1)) return "Yesterday";
  if (date === addDaysIso(today, 1)) return "Tomorrow";
  return date;
}

export function buildHomeAttentionItems(model) {
  const byId = (id) => model.lanes.find((lane) => lane.id === id)?.items || [];
  const groups = [
    ["overdue", "Overdue", byId("overdue")],
    ["follow-up", "Follow-up due", byId("followups")],
    ["today", "Due today", byId("today")],
    ["missing-proof", "Missing proof", byId("missing-proof")],
  ];
  const seen = new Set();
  const items = [];
  for (const [priority, exception, group] of groups) {
    const prioritized = [...group].sort((left, right) => {
      const leftDate =
        priority === "follow-up"
          ? left.followUpDate
          : left.dueDate || left.followUpDate || "9999-12-31";
      const rightDate =
        priority === "follow-up"
          ? right.followUpDate
          : right.dueDate || right.followUpDate || "9999-12-31";
      return (
        compareIsoDate(leftDate, rightDate) ||
        String(left.title || "").localeCompare(String(right.title || ""))
      );
    });
    for (const item of prioritized) {
      const key =
        item.taskId ||
        `${item.title}:${item.dueDate || item.followUpDate || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ ...item, priority, exception });
    }
  }
  return items;
}

export function deriveHomeWorkState(snapshot, options = {}) {
  const work = snapshot && typeof snapshot === "object" ? snapshot : {};
  const today = options.today || todayIsoDate();
  const selectedOwnerId = String(options.selectedOwnerId || "");
  const currentOperatorId = String(
    options.currentOperatorId || work.currentOperatorId || "",
  );
  const laneTasks = dedupeWorkTasks([
    ...tasksFromWorkPayload(work.tasks || []),
    ...tasksFromWorkPayload(work.todayTasks || []),
    ...tasksFromWorkPayload(work.overdueTasks || []),
    ...tasksFromWorkPayload(work.waitingTasks || []),
  ]);
  const allTasks = dedupeWorkTasks([
    ...laneTasks,
    ...Object.values(work.bundleTasks || {}).flatMap(tasksFromWorkPayload),
  ]);
  const todayTasks = dedupeWorkTasks([
    ...tasksFromWorkPayload(work.todayTasks || []),
    ...laneTasks.filter((task) => isTaskDueToday(task, today)),
  ]);
  const overdueTasks = dedupeWorkTasks([
    ...tasksFromWorkPayload(work.overdueTasks || []),
    ...laneTasks.filter((task) => isTaskOverdue(task, today)),
  ]);
  const waitingTasks = dedupeWorkTasks([
    ...tasksFromWorkPayload(work.waitingTasks || []),
    ...laneTasks.filter(isWaitingOrFollowUpTask),
  ]);
  const laneLoaded = (flag) =>
    work[flag] === undefined ? Boolean(work.loaded) : Boolean(work[flag]);
  const loaded = {
    today: laneLoaded("todayLoaded"),
    overdue: laneLoaded("overdueLoaded"),
    waiting: laneLoaded("waitingLoaded"),
  };
  loaded.tasks = loaded.today || loaded.overdue || loaded.waiting;

  const scope = (tasks) =>
    tasks.filter(
      (task) =>
        !selectedOwnerId ||
        (isOpenWorkTask(task) &&
          String(task.assigneeId || "") === selectedOwnerId),
    );
  const scopedOperatorId =
    selectedOwnerId ||
    (currentOperatorId && currentOperatorId.toLowerCase() !== "portal-admin"
      ? currentOperatorId
      : "");
  const todayVisible = selectedOwnerId
    ? scope(todayTasks)
    : scopedOperatorId
      ? todayTasks.filter((task) => {
          const assigneeId = String(task.assigneeId || "");
          return (
            isOpenWorkTask(task) &&
            (!assigneeId || assigneeId === scopedOperatorId)
          );
        })
      : todayTasks;
  const overdueVisible = selectedOwnerId ? scope(overdueTasks) : overdueTasks;
  const waitingVisible = selectedOwnerId ? scope(waitingTasks) : waitingTasks;
  const followUpVisible = waitingVisible.filter((task) =>
    isFollowUpDueTask(task, today),
  );
  const waitingNotDueVisible = waitingVisible.filter(
    (task) => !isFollowUpDueTask(task, today),
  );
  const allKnownVisible = selectedOwnerId ? scope(allTasks) : allTasks;
  const missingProofVisible = allKnownVisible.filter(
    (task) => isOpenWorkTask(task) && !taskProofState(task).ok,
  );

  return {
    today,
    selectedOwnerId,
    currentOperatorId: scopedOperatorId,
    loaded,
    tasks: {
      today: loaded.today ? todayVisible : [],
      overdue: loaded.overdue ? overdueVisible : [],
      followUps: loaded.waiting ? followUpVisible : [],
      waiting: loaded.waiting ? waitingNotDueVisible : [],
      missingProof: loaded.tasks ? missingProofVisible : [],
    },
    counts: {
      today: scopedOperatorId
        ? todayVisible.length
        : Number.isFinite(Number(work.todayTaskCount))
          ? Number(work.todayTaskCount)
          : todayVisible.length,
      overdue: selectedOwnerId
        ? overdueVisible.length
        : Number.isFinite(Number(work.overdueTaskCount))
          ? Number(work.overdueTaskCount)
          : overdueVisible.length,
      waiting: selectedOwnerId
        ? waitingVisible.length
        : Number.isFinite(Number(work.waitingTaskCount))
          ? Number(work.waitingTaskCount)
          : waitingVisible.length,
      followUps: followUpVisible.length,
      missingProof: missingProofVisible.length,
    },
  };
}

export function tasksFromWorkPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.tasks)) return payload.tasks;
  if (Array.isArray(payload.items)) return payload.items;
  return [];
}

export function dedupeWorkTasks(tasks) {
  const seen = new Set();
  const output = [];
  for (const task of tasksFromWorkPayload(tasks)) {
    if (!task || typeof task !== "object") continue;
    const key =
      task.id ||
      `${task.description || task.title || ""}:${task.date || ""}:${task.bundleId || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(task);
  }
  return output;
}

export function stripTitleSuffix(value) {
  if (value == null) return "";
  const title = typeof value === "string" ? value : String(value);
  const match = title.match(/^(.+[ ].+)[ \t]+([a-zA-Z0-9]{4,8})$/);
  if (!match) return title;
  const [, head, token] = match;
  if (/[a-zA-Z]/.test(token) && /[0-9]/.test(token)) return head.trimEnd();
  return title;
}

export function workTaskTitle(task) {
  return stripTitleSuffix(
    task.description || task.title || task.name || task.id || "Untitled task",
  );
}

export function workBundleTitle(bundle) {
  return bundle.title || bundle.name || bundle.id || "Untitled bundle";
}

export function taskDate(task) {
  if (!task || !task.date) return "";
  return String(task.date).slice(0, 10);
}

export function isOpenWorkTask(task) {
  if (!task || typeof task !== "object") return false;
  const status = String(task.status || "todo").toLowerCase();
  return status !== "done" && status !== "archived";
}

export function isTaskDueToday(task, today) {
  return isOpenWorkTask(task) && taskDate(task) === today;
}

export function isTaskOverdue(task, today) {
  const date = taskDate(task);
  return isOpenWorkTask(task) && Boolean(date) && isBeforeIsoDate(date, today);
}

export function isWaitingOrFollowUpTask(task) {
  if (!isOpenWorkTask(task)) return false;
  const status = String(task.status || "").toLowerCase();
  return (
    status === "waiting" || Boolean(task.waitingFor) || Boolean(task.followUpAt)
  );
}

export function isFollowUpDueTask(task, today = todayIsoDate()) {
  if (!isWaitingOrFollowUpTask(task)) return false;
  const followUpAt = String(task.followUpAt || "").slice(0, 10);
  return Boolean(followUpAt) && !isBeforeIsoDate(today, followUpAt);
}

export function isActiveWorkBundle(bundle) {
  if (!bundle || typeof bundle !== "object") return false;
  const status = String(bundle.status || "active").toLowerCase();
  const stage = String(bundle.stage || "preparation").toLowerCase();
  return status !== "done" && status !== "archived" && stage !== "done";
}

export function isArchivedWorkBundle(bundle) {
  if (!bundle || typeof bundle !== "object") return false;
  const status = String(bundle.status || "active").toLowerCase();
  const stage = String(bundle.stage || "").toLowerCase();
  return status === "done" || status === "archived" || stage === "done";
}

export function partitionCardsByArchive(cards) {
  const active = [];
  const archived = [];
  for (const card of cards || []) {
    if (isArchivedWorkBundle(card)) archived.push(card);
    else if (isActiveWorkBundle(card)) active.push(card);
  }
  return { active, archived };
}

export function groupCardItemsByStage(items) {
  return CARD_BOARD_COLUMNS.map(({ stage, label }) => ({
    stage,
    label,
    items: (items || []).filter(
      (item) => String(item.stage || "preparation").toLowerCase() === stage,
    ),
  }));
}

export function cardsHeaderViewModel({
  archiveVisible,
  activeCount,
  archivedCount,
}) {
  return {
    title: "Cards",
    eyebrow: "Task board",
    summary: archiveVisible
      ? `${countLabel(archivedCount, "archived card")} · completed work remains available`
      : `${countLabel(activeCount, "active card")} · open a card to see its tasks`,
    archiveAction: archiveVisible
      ? "Back to board"
      : `Archive (${archivedCount})`,
    archiveRoute: archiveVisible ? "/cards" : "/cards/archive",
    createVisible: !archiveVisible,
  };
}

export function taskRequiresApprovedArtifact(task) {
  const proof = task?.proofRequirement;
  return Boolean(
    proof && proof.required !== false && proof.type === "artifact",
  );
}

export function hasApprovedArtifactEvidence(task, artifacts) {
  const direct = (artifacts || []).some(
    (artifact) => artifact && artifact.status === "approved",
  );
  if (direct) return true;
  const refs = Array.isArray(task?.artifactRefs) ? task.artifactRefs : [];
  return refs.some((reference) => reference && reference.status === "approved");
}

export function hasTaskFileEvidence(task) {
  if (!task || typeof task !== "object") return false;
  if (task._hasFiles) return true;
  if (Number(task.fileCount || 0) > 0) return true;
  if (Array.isArray(task.files) && task.files.length > 0) return true;
  return Array.isArray(task.fileRefs) && task.fileRefs.length > 0;
}

export function taskProofState(task) {
  const missing = [];
  if (task?.requiredLinkName && !task.link) missing.push(task.requiredLinkName);
  if (task?.requiresFile && !hasTaskFileEvidence(task))
    missing.push("required file");
  if (
    taskRequiresApprovedArtifact(task) &&
    !hasApprovedArtifactEvidence(task, [])
  ) {
    missing.push("approved artifact");
  }
  if (missing.length > 0) {
    return {
      ok: false,
      label: `Missing proof: ${missing.join(", ")}`,
      missing,
    };
  }
  if (
    task?.requiredLinkName ||
    task?.requiresFile ||
    taskRequiresApprovedArtifact(task)
  ) {
    return { ok: true, label: "Proof ready", missing: [] };
  }
  return { ok: true, label: "No proof required", missing: [] };
}

export function missingBundleLinks(bundle) {
  if (!Array.isArray(bundle?.bundleLinks)) return [];
  return bundle.bundleLinks.filter(
    (link) =>
      link && typeof link === "object" && !String(link.url || "").trim(),
  );
}

export function summarizeBundleProgress(bundle, tasks, today) {
  const taskList = dedupeWorkTasks(tasks);
  const total = taskList.length;
  const done = taskList.filter(
    (task) => String(task.status || "").toLowerCase() === "done",
  ).length;
  const open = taskList.filter(isOpenWorkTask).length;
  const overdue = taskList.filter((task) => isTaskOverdue(task, today)).length;
  const waiting = taskList.filter(isWaitingOrFollowUpTask).length;
  const missingLinks =
    taskList.filter(
      (task) => isOpenWorkTask(task) && task.requiredLinkName && !task.link,
    ).length + missingBundleLinks(bundle).length;
  const missingFiles = taskList.filter(
    (task) =>
      isOpenWorkTask(task) && task.requiresFile && !hasTaskFileEvidence(task),
  ).length;
  const missingProof =
    taskList.filter((task) => isOpenWorkTask(task) && !taskProofState(task).ok)
      .length + missingBundleLinks(bundle).length;
  const nextDueTask = nextDueOpenTask(taskList, today);
  let risk = "low";
  if (overdue > 0) risk = "high";
  else if (
    waiting > 0 ||
    missingProof > 0 ||
    (open > 0 && bundle.anchorDate && isBeforeIsoDate(bundle.anchorDate, today))
  ) {
    risk = "medium";
  }
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  const parts = total > 0 ? [`${done}/${total} tasks`] : ["No tasks loaded"];
  if (overdue > 0) parts.push(`${overdue} overdue`);
  if (waiting > 0) parts.push(`${waiting} waiting`);
  if (missingLinks > 0)
    parts.push(`${missingLinks} missing link${missingLinks === 1 ? "" : "s"}`);
  if (missingFiles > 0)
    parts.push(`${missingFiles} missing file${missingFiles === 1 ? "" : "s"}`);
  if (missingProof > 0) parts.push(`${missingProof} missing proof`);
  return {
    total,
    done,
    open,
    overdue,
    waiting,
    missingLinks,
    missingFiles,
    missingProof,
    nextDueTask,
    percent,
    risk,
    label: parts.join(" - "),
  };
}

export function nextDueOpenTask(tasks, today) {
  const openTasks = dedupeWorkTasks(tasks).filter(isOpenWorkTask);
  openTasks.sort((left, right) => {
    const byDate = compareIsoDate(
      taskDate(left) || left.followUpAt || today,
      taskDate(right) || right.followUpAt || today,
    );
    if (byDate !== 0) return byDate;
    return workTaskTitle(left).localeCompare(workTaskTitle(right));
  });
  return openTasks[0] || null;
}

export function sortBundleChecklistTasks(tasks, today) {
  const sorted = [...tasks];
  sorted.sort((left, right) => {
    const leftDone = String(left.status || "").toLowerCase() === "done";
    const rightDone = String(right.status || "").toLowerCase() === "done";
    if (leftDone !== rightDone) return leftDone ? 1 : -1;
    return compareIsoDate(taskDate(left) || today, taskDate(right) || today);
  });
  return sorted;
}

export function workflowTaskGroups(tasks, today) {
  const sorted = sortBundleChecklistTasks(tasks, today);
  return [
    {
      title: "Active",
      empty: "No active tasks.",
      tasks: sorted.filter(
        (task) => isOpenWorkTask(task) && !isWaitingOrFollowUpTask(task),
      ),
    },
    {
      title: "Waiting / follow-up",
      empty: "No waiting tasks.",
      tasks: sorted.filter((task) => isWaitingOrFollowUpTask(task)),
    },
    {
      title: "Done / history",
      empty: "No completed tasks yet.",
      tasks: sorted.filter(
        (task) => String(task.status || "").toLowerCase() === "done",
      ),
    },
  ];
}

function countLabel(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}
