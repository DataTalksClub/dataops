import { concreteRoutePath, matchRoutePath } from "./route-patterns.js";

export const WORKSPACE_PATH_BY_VIEW = Object.freeze({
  "operating-model": "/operating-model",
  docs: "/processes",
  admin: "/admin",
  users: "/users",
  device: "/device",
  bookkeeping: "/bookkeeping",
  sponsors: "/sponsors/queue",
  newsletter: "/newsletter",
  calendar: "/calendar",
  podcast: "/podcast",
});

export const WORKSPACE_ROUTE_DEFINITIONS = Object.freeze({
  "/": { view: "tasks", tasksSection: "queue", params: [] },
  "/operating-model": { view: "operating-model", tasksSection: "queue", params: ["section", "entityId"] },
  "/tasks": {
    view: "tasks",
    tasksSection: "queue",
    params: ["taskId", "date", "cardId", "contextCardId", "assignee"],
    // A bare /tasks is the signed-in operator's queue: the default scope has
    // one URL, so `assignee=me` normalizes away.
    paramDefaults: { assignee: "me" },
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
  "/templates": {
    view: "tasks",
    tasksSection: "templates",
    params: ["templateId"],
  },
  "/recurring": { view: "tasks", tasksSection: "recurring", params: [] },
  "/bookkeeping": { view: "bookkeeping", tasksSection: "queue", params: [] },
  // Bare /sponsors opens the default tab; every tab and record is a path.
  "/sponsors": { view: "sponsors", tasksSection: "queue", params: [], canonicalPath: "/sponsors/queue" },
  "/sponsors/queue": { view: "sponsors", tasksSection: "queue", sponsorsTab: "queue", params: [] },
  "/sponsors/pipeline": { view: "sponsors", tasksSection: "queue", sponsorsTab: "pipeline", params: [] },
  "/sponsors/companies": { view: "sponsors", tasksSection: "queue", sponsorsTab: "companies", params: [] },
  "/sponsors/leads": { view: "sponsors", tasksSection: "queue", sponsorsTab: "leads", params: [] },
  "/sponsors/newsletters": { view: "sponsors", tasksSection: "queue", sponsorsTab: "newsletters", params: [] },
  "/sponsors/money": { view: "sponsors", tasksSection: "queue", sponsorsTab: "money", params: [] },
  "/sponsors/deals/:dealId": { view: "sponsors", tasksSection: "queue", sponsorsTab: "queue", params: [] },
  "/sponsors/companies/:companyId": { view: "sponsors", tasksSection: "queue", sponsorsTab: "queue", params: [] },
  "/sponsors/leads/:leadId": { view: "sponsors", tasksSection: "queue", sponsorsTab: "leads", params: [] },
  "/sponsors/newsletters/:newsletterId": { view: "sponsors", tasksSection: "queue", sponsorsTab: "newsletters", params: [] },
  "/newsletter": { view: "newsletter", tasksSection: "queue", params: [] },
  "/calendar": { view: "calendar", tasksSection: "queue", params: [] },
  // ?view=list swaps the seasons overview for the plain episode list.
  "/podcast": { view: "podcast", tasksSection: "queue", params: ["view"] },
  "/podcast/schedule": { view: "podcast", tasksSection: "queue", params: [] },
  "/podcast/:episodeId": { view: "podcast", tasksSection: "queue", params: ["view"] },
  "/processes": {
    view: "docs",
    tasksSection: "queue",
    params: ["domain", "type", "system", "tag"],
  },
  "/admin": { view: "admin", tasksSection: "queue", params: [] },
  "/users": { view: "users", tasksSection: "queue", params: [] },
  "/device": { view: "device", tasksSection: "queue", params: ["code"] },
});

export const TASKS_SECTIONS = Object.freeze([
  Object.freeze(["queue", "Queue"]),
  Object.freeze(["workflows", "Cards"]),
  Object.freeze(["templates", "Templates"]),
  Object.freeze(["recurring", "Recurring"]),
]);

export const ENTITY_VOCABULARY = Object.freeze({
  template: "Template",
  card: "Card",
  task: "Task",
});

export function tasksSectionTitle(section, archiveVisible = false) {
  // Bare human page titles: the sidebar already says "Tasks", so the H1 and
  // the toolbar that mirrors it name only the page.
  const titles = {
    queue: "Work Queue",
    workflows: archiveVisible ? "Card archive" : "Cards",
    templates: "Templates",
    recurring: "Recurring",
  };
  return titles[section] || "Work Queue";
}

export function workspacePath(view, tasksSection = "queue") {
  if (view === "tasks") {
    return (
      {
        queue: "/tasks",
        workflows: "/cards",
        templates: "/templates",
        recurring: "/recurring",
      }[tasksSection] || "/tasks"
    );
  }
  return WORKSPACE_PATH_BY_VIEW[view] || "/tasks";
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
  let matched;
  try {
    matched = matchRoutePath(WORKSPACE_ROUTE_DEFINITIONS, path);
  } catch {
    matched = null;
  }
  const definition = matched?.definition || WORKSPACE_ROUTE_DEFINITIONS["/"];
  if (definition.canonicalPath) path = definition.canonicalPath;
  else if (matched?.pattern.includes(":")) path = concreteRoutePath(matched.pattern, matched.pathParams);
  const ordered = new URLSearchParams();
  for (const name of definition.params) {
    const value =
      params instanceof URLSearchParams ? params.get(name) : params?.[name];
    if (value && value !== definition.paramDefaults?.[name]) ordered.set(name, value);
  }
  const query = ordered.toString();
  return `${path}${query ? `?${query}` : ""}`;
}

export function parseWorkspaceLocation(
  rawLocation,
  location = globalThis.window?.location,
) {
  const raw = String(
    rawLocation === undefined
      ? `${location?.pathname || "/"}${location?.search || ""}`
      : rawLocation || "",
  );
  if (!raw) return { invalid: true, reason: "empty path" };
  if (!raw.startsWith("/") || raw.includes("#")) {
    return { invalid: true, reason: "malformed path" };
  }

  const value = raw;
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

  const trimmedPath =
    rawPath.endsWith("/") && rawPath !== "/" ? rawPath.slice(0, -1) : rawPath;
  const matched = matchRoutePath(WORKSPACE_ROUTE_DEFINITIONS, trimmedPath);
  if (!matched) return { invalid: true, reason: "unknown path" };
  const definition = matched.definition.canonicalPath
    ? WORKSPACE_ROUTE_DEFINITIONS[matched.definition.canonicalPath]
    : matched.definition;
  const path = matched.definition.canonicalPath
    || (matched.pattern.includes(":") ? concreteRoutePath(matched.pattern, matched.pathParams) : trimmedPath);

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
  for (const [name, value] of Object.entries(matched.pathParams)) params.set(name, value);
  const currentUrl = `${location?.pathname || "/"}${location?.search || ""}`;
  return {
    view: definition.view,
    tasksSection: definition.tasksSection,
    ...(definition.sponsorsTab ? { sponsorsTab: definition.sponsorsTab } : {}),
    path,
    params,
    canonicalUrl,
    normalized: currentUrl !== canonicalUrl,
  };
}

export function workspaceRouteFor(path, params = {}, location) {
  const visible = canonicalWorkspaceUrl(path, params);
  return parseWorkspaceLocation(visible, location);
}

// Pure task, Card, proof, and work view-model helpers.
export const CARD_BOARD_COLUMNS = Object.freeze([
  Object.freeze({ stage: "preparation", label: "Preparation" }),
  Object.freeze({ stage: "announced", label: "Announced" }),
  Object.freeze({ stage: "after-event", label: "After event" }),
]);

export function parseIsoDateValue(value) {
  if (!value) return null;
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(
    Date.UTC(year, month - 1, day),
  );
  const validCalendarDate =
    !Number.isNaN(date.getTime()) &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
  return validCalendarDate ? date : null;
}

export function toIsoDate(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const BERLIN_TIME_ZONE = "Europe/Berlin";

const BERLIN_DATE_PARTS_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: BERLIN_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T[^\s]+(?:Z|[+-]\d{2}:?\d{2})$/u;

export function berlinIsoDate(instant) {
  let date;
  if (instant instanceof Date) {
    date = instant;
  } else if (
    typeof instant === "number"
    || (typeof instant === "string" && ISO_INSTANT_PATTERN.test(instant))
  ) {
    date = new Date(instant);
  } else {
    return "";
  }

  if (Number.isNaN(date.getTime())) return "";
  const parts = Object.fromEntries(
    BERLIN_DATE_PARTS_FORMATTER.formatToParts(date).map(
      ({ type, value }) => [type, value],
    ),
  );
  const isoDate = `${parts.year}-${parts.month}-${parts.day}`;
  return /^\d{4}-\d{2}-\d{2}$/u.test(isoDate) ? isoDate : "";
}

export function todayIsoDate(instant = new Date()) {
  return berlinIsoDate(instant);
}

export function addDaysIso(isoDate, days) {
  const date = parseIsoDateValue(isoDate);
  if (!date) return "";
  date.setUTCDate(date.getUTCDate() + days);
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
export function formatShortDate(value) {
  const date = parseIsoDateValue(value);
  if (!date) return value || "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
  }).format(date);
}

export function formatHomeShortDate(value) {
  return formatShortDate(value);
}

export function formatHomeCalendarDate(value) {
  const date = parseIsoDateValue(value);
  if (!date) return value || "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(date);
}

export function formatTaskDateMeta(value, today) {
  const date = String(value || "").slice(0, 10);
  if (!date) return "";
  if (date === today) return "Today";
  if (date === addDaysIso(today, -1)) return "Yesterday";
  if (date === addDaysIso(today, 1)) return "Tomorrow";
  // Every surface shows human dates; the ISO input never leaks through.
  const short = formatShortDate(date);
  return date.slice(0, 4) === String(today || "").slice(0, 4)
    ? short
    : `${short} ${date.slice(0, 4)}`;
}

export function formatCardAnchorLabel(value, today = todayIsoDate()) {
  return formatTaskDateMeta(value, today);
}

export function formatHomeTaskTiming(item, today) {
  if (item.priority === "missing-proof") return "Proof required";
  const value = String(
    item.priority === "follow-up"
      ? item.followUpDate
      : item.dueDate || item.followUpDate || "",
  ).slice(0, 10);
  if (!value) return "Open task";
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

export function cardAnchorTone(value, today = todayIsoDate()) {
  const date = String(value || "").slice(0, 10);
  if (!date) return "";
  if (date === today) return "today";
  return isBeforeIsoDate(date, today) ? "past" : "upcoming";
}

export function deriveScopedWorkState(snapshot, options = {}) {
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
    ...Object.values(work.cardTasks || {}).flatMap(tasksFromWorkPayload),
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

export function buildHomeAttentionItems(model) {
  const byId = (id) => model.lanes.find((lane) => lane.id === id)?.items || [];
  const groups = [
    ["overdue", byId("overdue")],
    ["follow-up", byId("followups")],
    ["today", byId("today")],
    ["missing-proof", byId("missing-proof")],
  ];
  const seen = new Set();
  const items = [];
  for (const [priority, group] of groups) {
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
      items.push({ ...item, priority });
    }
  }
  return items;
}

export function deriveHomeWorkState(snapshot, options = {}) {
  return deriveScopedWorkState(snapshot, options);
}

export function tasksFromWorkPayload(payload) {
  if (Array.isArray(payload)) return payload.filter(isCanonicalWorkTask);
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.tasks)) return payload.tasks.filter(isCanonicalWorkTask);
  if (Array.isArray(payload.items)) return payload.items.filter(isCanonicalWorkTask);
  return [];
}

const CANONICAL_TASK_STATUSES = new Set(["todo", "waiting", "done", "skipped"]);

export function isCanonicalWorkTask(task) {
  return Boolean(
    task &&
      typeof task === "object" &&
      Number.isInteger(task.version) &&
      task.version >= 1 &&
      Array.isArray(task.taskHistory) &&
      CANONICAL_TASK_STATUSES.has(task.status),
  );
}

export function dedupeWorkTasks(tasks) {
  const seen = new Set();
  const output = [];
  for (const task of tasksFromWorkPayload(tasks)) {
    if (!task || typeof task !== "object") continue;
    const key =
      task.id ||
      `${task.description || task.title || ""}:${task.date || ""}:${task.cardId || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(task);
  }
  return output;
}

export function workTaskTitle(task) {
  const title =
    task.description || task.title || task.name || task.id || "Untitled task";
  return typeof title === "string" ? title : String(title);
}

export function cleanCardTitle(raw) {
  if (typeof raw !== "string") return "";
  const tagMatch = raw.match(/^(?:[\p{Extended_Pictographic}\u2699\u26a1\ufe0f\u200d]+\s*)?\[([^\]]+)\]\s*/u);
  if (!tagMatch) return raw;
  let rest = raw.slice(tagMatch[0].length);
  rest = rest.replace(/\(\s*(\d{1,2})\s*([A-Za-z]{3,9}|\d{1,2})\s*(20\d{2})\s*\)/g, "");
  rest = rest.replace(/\b(20\d{2})-([A-Za-z]{3,9}|\d{1,2})-(\d{1,2})\b/g, "");
  const lastDash = rest.lastIndexOf(" - ");
  if (lastDash > 0) rest = rest.slice(0, lastDash);
  const gluedDash = rest.match(/^(.*)-([A-ZÀ-Þ][^-]* [^-]*)$/u);
  if (gluedDash) rest = gluedDash[1];
  const issueMatch = rest.match(/#\s*\d+\b/);
  if (issueMatch) {
    const withoutIssue = rest.slice(0, issueMatch.index) + rest.slice(issueMatch.index + issueMatch[0].length);
    if (withoutIssue.replace(/^[-–:;\s]+|[-–:;\s]+$/g, "").trim()) {
      rest = withoutIssue;
    }
  }
  rest = rest.replace(/\(\s*\)/g, "").replace(/\s{2,}/g, " ").replace(/^[-–:;\s]+|[-–:;\s]+$/g, "").trim();
  return rest || raw;
}

export function workCardTitle(card) {
  if (!card || typeof card !== "object") return "Untitled card";
  const raw = card.title || card.name || card.id || "Untitled card";
  return cleanCardTitle(raw);
}

export function workCardSubtitle(card) {
  if (!card || typeof card !== "object") return "";
  const people = Array.isArray(card.people)
    ? card.people.filter((name) => typeof name === "string" && name.trim().length > 0)
    : [];
  if (people.length > 0) return people.join(", ");
  const sponsors = [
    ...(typeof card.sponsor === "string" && card.sponsor.trim() ? [card.sponsor.trim()] : []),
    ...(Array.isArray(card.secondarySponsors)
      ? card.secondarySponsors.filter((name) => typeof name === "string" && name.trim().length > 0)
      : []),
  ];
  if (sponsors.length > 0) return sponsors.join(", ");

  const raw = String(card.title || card.name || "");
  const tagMatch = raw.match(/^(?:[\p{Extended_Pictographic}\u2699\u26a1\ufe0f\u200d]+\s*)?\[([^\]]+)\]\s*/u);
  if (tagMatch) {
    const lastDash = raw.lastIndexOf(" - ");
    if (lastDash > 0) {
      const tail = raw.slice(lastDash + 3).trim();
      if (tail && !/^\d{4}/.test(tail)) return tail;
    }
    const gluedDash = raw.match(/-([A-ZÀ-Þ][^-]* [^-]*)$/u);
    if (gluedDash) return gluedDash[1].trim();
  }
  return "";
}

export function workCardIssueNumber(card) {
  if (!card || typeof card !== "object") return "";
  if (card.issueNumber !== undefined && card.issueNumber !== null) {
    const raw = String(card.issueNumber).trim();
    if (raw) return raw.replace(/^/, "");
  }
  const raw = String(card.title || card.name || "");
  const match = raw.match(/#\s*(\d+)\b/);
  return match ? match[1] : "";
}

export function taskDate(task) {
  if (!task || !task.date) return "";
  return String(task.date).slice(0, 10);
}

export function isOpenWorkTask(task) {
  return isCanonicalWorkTask(task) && (task.status === "todo" || task.status === "waiting");
}

/** Done or skipped: the Task needs no more work, and its Card counts it resolved. */
export function isResolvedWorkTask(task) {
  return task?.status === "done" || task?.status === "skipped";
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
  return (
    task.status === "waiting" || Boolean(task.waitingFor) || Boolean(task.followUpAt)
  );
}

export function isFollowUpDueTask(task, today = todayIsoDate()) {
  if (!isWaitingOrFollowUpTask(task)) return false;
  const followUpAt = String(task.followUpAt || "").slice(0, 10);
  return Boolean(followUpAt) && !isBeforeIsoDate(today, followUpAt);
}

export function isActiveWorkCard(card) {
  if (!card || typeof card !== "object") return false;
  return (
    Number.isInteger(card.version) && card.version >= 1 &&
    Number.isInteger(card.taskCount) && card.taskCount >= 0 &&
    Number.isInteger(card.openTaskCount) && card.openTaskCount >= 0 &&
    card.openTaskCount <= card.taskCount &&
    (card.taskCount === 0 || card.openTaskCount > 0) &&
    card.status === "active" &&
    ["preparation", "announced", "after-event"].includes(card.stage) &&
    card.completedAt === undefined &&
    card.completedBy === undefined &&
    card.activeStageBeforeCompletion === undefined
  );
}

export function isArchivedWorkCard(card) {
  if (!card || typeof card !== "object") return false;
  return (
    Number.isInteger(card.version) && card.version >= 1 &&
    Number.isInteger(card.taskCount) && card.taskCount > 0 &&
    card.openTaskCount === 0 &&
    card.status === "archived" &&
    card.stage === "done" &&
    typeof card.completedAt === "string" && card.completedAt.length > 0 &&
    typeof card.completedBy === "string" && card.completedBy.length > 0 &&
    ["preparation", "announced", "after-event"].includes(card.activeStageBeforeCompletion)
  );
}

export function isParkedWorkCard(card) {
  if (!card || typeof card !== "object") return false;
  return (
    Number.isInteger(card.version) && card.version >= 1 &&
    Number.isInteger(card.taskCount) && card.taskCount >= 0 &&
    Number.isInteger(card.openTaskCount) && card.openTaskCount >= 0 &&
    card.openTaskCount <= card.taskCount &&
    card.status === "parked" &&
    ["preparation", "announced", "after-event"].includes(card.stage) &&
    card.completedAt === undefined &&
    card.completedBy === undefined &&
    card.activeStageBeforeCompletion === undefined
  );
}

export function partitionCardsByArchive(cards) {
  const active = [];
  const archived = [];
  const parked = [];
  for (const card of cards || []) {
    if (isArchivedWorkCard(card)) archived.push(card);
    else if (isParkedWorkCard(card)) parked.push(card);
    else if (isActiveWorkCard(card)) active.push(card);
  }
  return { active, archived, parked };
}

export function compareCardItemsByAnchor(left, right) {
  return (
    compareIsoDate(left?.anchorDate, right?.anchorDate) ||
    String(left?.title || "").localeCompare(String(right?.title || ""))
  );
}

export function formatCardMonthLabel(value) {
  const date = parseIsoDateValue(value);
  if (!date) return "No date";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  }).format(date);
}

export function groupCardItemsByMonth(items, dateKey = "completedAt") {
  const ordered = [...(items || [])].sort((left, right) => {
    const leftDate = String(left?.[dateKey] || "");
    const rightDate = String(right?.[dateKey] || "");
    if (leftDate !== rightDate) {
      // Newest first, undated last.
      if (!leftDate) return 1;
      if (!rightDate) return -1;
      return rightDate.localeCompare(leftDate);
    }
    return String(left?.title || "").localeCompare(String(right?.title || ""));
  });
  const groups = [];
  for (const item of ordered) {
    const key = String(item?.[dateKey] || "").slice(0, 7) || "undated";
    const last = groups.at(-1);
    if (last && last.key === key) last.items.push(item);
    else
      groups.push({
        key,
        label: formatCardMonthLabel(item?.[dateKey]),
        items: [item],
      });
  }
  return groups;
}

export function groupCardItemsByStage(items) {
  return CARD_BOARD_COLUMNS.map(({ stage, label }) => ({
    stage,
    label,
    items: (items || [])
      .filter(
        (item) => String(item.stage || "preparation").toLowerCase() === stage,
      )
      .sort(compareCardItemsByAnchor),
  }));
}

export function cardsHeaderViewModel({
  archiveVisible,
  activeCount,
  archivedCount,
  parkedCount = 0,
}) {
  const parked = Number(parkedCount) || 0;
  const archiveSummary = parked > 0
    ? `${countLabel(archivedCount, "done card")} · ${countLabel(parked, "parked card")} · completed work remains available`
    : `${countLabel(archivedCount, "done card")} · completed work remains available`;
  return {
    title: tasksSectionTitle("workflows", archiveVisible),
    eyebrow: "Task board",
    summary: archiveVisible
      ? archiveSummary
      : countLabel(activeCount, "active card"),
    archiveAction: archiveVisible
      ? "Back to board"
      : `Archive (${archivedCount + parked})`,
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

export function missingCardLinks(card) {
  if (!Array.isArray(card?.cardLinks)) return [];
  return card.cardLinks.filter(
    (link) =>
      link && typeof link === "object" && !String(link.url || "").trim(),
  );
}

export function summarizeCardProgress(card, tasks, today) {
  const taskList = dedupeWorkTasks(tasks);
  const total = taskList.length;
  const done = taskList.filter(isResolvedWorkTask).length;
  const open = taskList.filter(isOpenWorkTask).length;
  const overdue = taskList.filter((task) => isTaskOverdue(task, today)).length;
  const waiting = taskList.filter(isWaitingOrFollowUpTask).length;
  const missingLinks =
    taskList.filter(
      (task) => isOpenWorkTask(task) && task.requiredLinkName && !task.link,
    ).length + missingCardLinks(card).length;
  const missingFiles = taskList.filter(
    (task) =>
      isOpenWorkTask(task) && task.requiresFile && !hasTaskFileEvidence(task),
  ).length;
  const missingProof =
    taskList.filter((task) => isOpenWorkTask(task) && !taskProofState(task).ok)
      .length + missingCardLinks(card).length;
  const nextDueTask = nextDueOpenTask(taskList, today);
  let risk = "low";
  if (overdue > 0) risk = "high";
  else if (
    waiting > 0 ||
    missingProof > 0 ||
    (open > 0 && card.anchorDate && isBeforeIsoDate(card.anchorDate, today))
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

export function sortCardChecklistTasks(tasks, today) {
  const sorted = tasksFromWorkPayload(tasks);
  sorted.sort((left, right) => {
    const leftDone = isResolvedWorkTask(left);
    const rightDone = isResolvedWorkTask(right);
    if (leftDone !== rightDone) return leftDone ? 1 : -1;
    return compareIsoDate(taskDate(left) || today, taskDate(right) || today);
  });
  return sorted;
}

export function workflowTaskGroups(tasks, today) {
  const sorted = sortCardChecklistTasks(tasks, today);
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
      tasks: sorted.filter(isResolvedWorkTask),
    },
  ];
}

function countLabel(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}
