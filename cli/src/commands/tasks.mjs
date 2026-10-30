import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";

import { UsageError } from "../errors.mjs";
import { enc, fields, integer, isoDate, isValidTimezone, linkedCardLabel, list as csv, optionalString, portalUrl, positional, required, resolveDateTime, table } from "../format.mjs";
import { apiFor, today } from "../session.mjs";
import { resolveTaskId } from "../shortIds.mjs";
import { hasTaskFollowUp, isTaskActionable, isTaskSnoozed, taskAttentionDate } from "../../../frontend/src/core/task-attention.js";

export const summary = "List, inspect, create, complete, skip, and follow up Tasks";

export const help = `dataops tasks - Tasks are the checklist items inside Cards

Usage
  dataops tasks list [view] [filters] [--batches]
  dataops tasks batches [view] [filters]
  dataops tasks show <task-id>               A unique 8+ character id prefix works
  dataops tasks create --description D [--date YYYY-MM-DD] [--card ID] [--assignee ID|me]
      [--subject-type sponsor-deal|sponsor-company|sponsor-person|tuition-agreement --subject-id ID]
      [--comment C] [--link URL] [--tags a,b] [--required-link-name NAME] [--instruction-doc DOC-ID]
      [--requires youtube,luma] [--browser required|headless] [--depends-on ID,ID]
  dataops tasks update <task-id> [--description D] [--date D] [--comment C] [--link URL]
      [--subject-type sponsor-deal|sponsor-company|sponsor-person|tuition-agreement --subject-id ID | --clear-subject]
      [--at "2026-10-23 19:00" --tz Europe/Berlin | --at +7d | --at none]
      [--external-status S] [--tags a,b] [--card ID|none] [--instruction-doc DOC-ID]
      [--requires a,b|none] [--browser required|headless|none] [--depends-on ID,ID|none]
      --comment appends to the notes log (the old comment becomes its first entry)
  dataops tasks done <task-id> [--link URL] [--comment C] [--external-status S] [--file PATH]
  dataops tasks reopen <task-id>
  dataops tasks skip <task-id> --reason R        Resolve as not applicable (no proof needed)
  dataops tasks unskip <task-id>                 Back to todo
  dataops tasks wait <task-id> --for WHO --follow-up YYYY-MM-DD --channel CHANNEL --note NOTE
  dataops tasks followed-up <task-id> --channel CHANNEL --note NOTE [--next YYYY-MM-DD]
  dataops tasks followup --about <task|card|sponsor-deal|company|person id> --on +7d --description "check X" [--note "context"]
      Linked to its subject, assigned to you, due that day
  dataops tasks snooze <task-id> --until +7d --reason R   Hide from today/overdue until then
  dataops tasks unsnooze <task-id>                       Back in the queue now
  dataops tasks unblock <task-id> --note NOTE [--unblocked]   (default: response received)
  dataops tasks note <task-id> "text"                 Append to the notes log
  dataops tasks handover <task-id> --to <agent>        Hand one Task over (admin)
  dataops tasks handover --from <agent> --to <agent>   Hand every open Task over (admin)
  dataops tasks assign <task-id> <user-id|me>
  dataops tasks link-card <task-id> <card-id>          Link the Card that carries this Task out
  dataops tasks link-card <task-id> --unlink           Clear the link
  dataops tasks delete <task-id>                                (admin)

List views (default: --queue)
  --queue      Overdue work, follow-ups due today or earlier, and today todos
  --today      Due today          --overdue    Open and past due     --waiting   All waiting, including future follow-ups
  --status S   todo|waiting|done|skipped       --date D    One day     --from D --to D   A range
  --card ID    Every Task of a Card
  --batches    Group Tasks due on the same day for the same Card/subject into one sitting
               (also \`dataops tasks batches [view] [filters]\`)
  --owner me|team|unassigned|<member>, or --mine for --owner me
  --as-of YYYY-MM-DD   Treat this date as today (default: Europe/Berlin date)

<member> is a user id, an email, or a name: --owner orin shows Orin's work.
The starting point for any agent is \`dataops tasks list --mine --queue\`:
your work needing attention today. Future follow-ups stay hidden even when the
original deadline is overdue. Use \`tasks list --mine --waiting\` to inspect parked
waits, like expanding "Waiting & snoozed" in the web queue. Snoozed and timed
Tasks still wait for their wakeup; --status waiting lists the full inventory.

Dates (Europe/Berlin)
  Every date flag also takes +7d (days ahead), tomorrow, or a weekday name
  (mon is the next Monday, strictly after today): --date, --from, --to,
  --as-of, create --date, wait --follow-up, followed-up --next.

Timed tasks
  --at "2026-10-23 19:00" --tz Europe/Berlin (the default tz), --at +7d, or an
  ISO instant sets the moment a Task may surface; until then it stays out of
  the queue, then it is due like any other Task. --at none clears it.

Dependencies
  --depends-on ID,ID       Prerequisite Tasks on the same Card; the Task cannot be completed
                           until every one is done or skipped.
                           \`none\` clears them. show lists each prerequisite's name and status;
                           list marks blocked Tasks. The API rejects self, missing,
                           cross-Card and cyclic prerequisites, completing a blocked Task,
                           and reopening or deleting a prerequisite of a completed Task.
  --after ID               The single-parent form of --depends-on for chains: when the
                           parent's date or moment moves, dependents shift by the same
                           offset, transitively. \`none\` clears it. Card Templates say
                           the same with depends_on.

Required resources (ids from \`dataops resources list\`)
  --requires a,b           Only Tasks that need at least one of these
  --exclude-requires a,b   Drop Tasks that need any of these
  --can-do a,b             Only Tasks whose every requirement is in this set: what you have
                           access to. Defaults to DATAOPS_CAPABILITIES; --can-do all turns
                           it off.
                           A Task that needs something you lack is for someone else.

Browser requirement (execution need, separate from accounts)
  --browser M              Filter the list by whether a Task needs an interactive browser:
                           required (browser needed somewhere), headless (the whole Task can
                           finish without one), unclassified (not yet decided). --browser
                           headless is the headless mode: only explicitly classified Tasks
                           pass, so unclassified work is never offered as safe headless work.
                           create/update takes required|headless, or none to clear. It is
                           a human classification: no service name implies a browser.
                           Filtering never changes status, due dates, or ownership.

Proof
  done saves the proof and completes the Task in one versioned write. --link (alias
  --proof-url) fills the Task's link/required link; --comment and --external-status
  satisfy those proof types; --file uploads a file to the Task first. A waiting Task is
  closed through the follow-up "resolve" action, as in the web.
  Every write reads the Task's current version first (or pass --expected-version N);
  a 409 means someone else changed it: re-read and retry.

Examples
  dataops tasks list --mine
  dataops tasks list --can-do youtube,luma,gmail
  dataops tasks list --browser headless            # safe work for a headless machine
  dataops tasks list --status todo --requires mailchimp
  dataops tasks list --card 542df0a6-... --json
  dataops tasks create --description "Draft newsletter" --browser headless
  dataops tasks done b6fc790f-... --link https://example.com/published-post
  dataops tasks wait b6fc790f-... --for "Sponsor" --follow-up 2026-11-02 --channel email --note "Asked for logo"
`;

const OPEN = new Set(["todo", "waiting"]);

function tasksOf(payload) {
  if (Array.isArray(payload)) return payload;
  return Array.isArray(payload?.tasks) ? payload.tasks : [];
}

function ownerOf(args) {
  if (args.mine) return "me";
  return optionalString(args, "owner");
}

/**
 * Required-resource filters for GET /api/tasks. `--can-do` falls back to the
 * DATAOPS_CAPABILITIES the agent declared; `--can-do all` disables it.
 */
export function requiresQuery(args, env = process.env) {
  const query = {};
  if (args.requires !== undefined) query.requires = csv(required(args, "requires", "requires")).join(",");
  if (args.excludeRequires !== undefined) {
    query.excludeRequires = csv(required(args, "excludeRequires", "exclude-requires")).join(",");
  }
  const canDo = args.canDo !== undefined ? args.canDo : env.DATAOPS_CAPABILITIES || undefined;
  if (canDo === true || String(canDo ?? "x").trim() === "") {
    throw new UsageError("--can-do needs a comma-separated list of resource ids, or all.");
  }
  if (canDo !== undefined && String(canDo).trim() !== "all") query.canDo = csv(String(canDo)).join(",");
  return query;
}

/**
 * The `browser` listing filter: the execution need, not the accounts. Only an
 * explicit `headless` classification passes `--browser headless`, so a Task
 * nobody classified is never offered as safe headless work.
 */
export function browserQuery(args) {
  if (args.browser === undefined) return {};
  const mode = String(args.browser).trim();
  if (!["required", "headless", "unclassified"].includes(mode)) {
    throw new UsageError("--browser must be required, headless, or unclassified.");
  }
  return { browser: mode };
}

/** The writable `browserRequirement` value from --browser (none clears it). */
function browserRequirementField(args) {
  if (args.browser === undefined) return {};
  const mode = String(args.browser).trim();
  if (mode === "none" || mode === "") return { browserRequirement: null };
  if (!["required", "headless"].includes(mode)) {
    throw new UsageError("--browser must be required, headless, or none.");
  }
  return { browserRequirement: mode };
}

/** The list column's short browser word: empty means not classified. */
export function browserMark(value) {
  if (value === "required") return "browser";
  if (value === "headless") return "headless";
  return "";
}

function isWaitingOrFollowUp(task) {
  return OPEN.has(task.status) && hasTaskFollowUp(task);
}

/** A snoozed Task stays out of the queue while its date is in the future. */
export function isSnoozed(task, day) {
  return isTaskSnoozed(task, day);
}

/** A scheduled Task stays out of the queue while its moment is in the future. */
export function isScheduled(task, nowIso) {
  return typeof task.notBeforeAt === "string" && task.notBeforeAt > nowIso;
}

/** The web queue's urgency segment for one open Task. */
export function queueSegment(task, day, nowIso = new Date().toISOString()) {
  const due = taskAttentionDate(task);
  if (!OPEN.has(task.status)) return "";
  if (isScheduled(task, nowIso)) return "scheduled";
  if (isSnoozed(task, day)) return "snoozed";
  if (isWaitingOrFollowUp(task)) return due && due <= day ? "follow-up" : "waiting";
  if (due && due < day) return "overdue";
  if (due === day) return "today";
  return "open";
}

const SEGMENT_ORDER = ["overdue", "follow-up", "today", "waiting", "open", "snoozed", "scheduled"];

// The web queue uses the same attention/deferral helper. Only the explicit
// --waiting view includes upcoming follow-ups; snooze and exact-time gates remain.
export function orderQueue(tasks, day, nowIso = new Date().toISOString(), { includeUpcomingWaiting = false } = {}) {
  const seen = new Set();
  const unique = tasks.filter((task) => task && OPEN.has(task.status) && !isSnoozed(task, day) && !isScheduled(task, nowIso) && (includeUpcomingWaiting || isTaskActionable(task, day, nowIso)) && !seen.has(task.id) && seen.add(task.id));
  return unique
    .map((task) => ({ ...task, queueSegment: queueSegment(task, day, nowIso) }))
    .sort(
      (a, b) =>
        SEGMENT_ORDER.indexOf(a.queueSegment) - SEGMENT_ORDER.indexOf(b.queueSegment) ||
        taskAttentionDate(a).localeCompare(taskAttentionDate(b)),
    );
}

function yesterday(day) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function batchScopeKey(task) {
  if (task.cardId) return `card:${task.cardId}`;
  if (task.subject?.type && task.subject?.id) return `subject:${task.subject.type}:${task.subject.id}`;
  return "standalone";
}

function taskPrerequisiteIds(task) {
  if (Array.isArray(task.dependsOn) && task.dependsOn.length) return task.dependsOn.map(String);
  if (Array.isArray(task.prerequisites) && task.prerequisites.length) {
    return task.prerequisites.map((entry) => String(entry.id));
  }
  return [];
}

/**
 * Topologically order tasks within a single sitting/batch so prerequisites in
 * the same batch precede their dependents, preserving input order on ties.
 */
function orderBatchTasks(batchTasks) {
  const byId = new Map(batchTasks.map((task, idx) => [task.id, { task, idx }]));
  const inDegree = new Map();
  const dependents = new Map();

  for (const { task } of byId.values()) {
    const inBatchDeps = taskPrerequisiteIds(task).filter((depId) => byId.has(depId) && depId !== task.id);
    const uniqueDeps = [...new Set(inBatchDeps)];
    inDegree.set(task.id, uniqueDeps.length);
    for (const depId of uniqueDeps) {
      if (!dependents.has(depId)) dependents.set(depId, []);
      dependents.get(depId).push(task.id);
    }
  }

  const ready = batchTasks
    .filter((task) => (inDegree.get(task.id) || 0) === 0)
    .map((task) => task.id);
  const ordered = [];
  const visited = new Set();

  while (ready.length > 0) {
    ready.sort((a, b) => byId.get(a).idx - byId.get(b).idx);
    const currentId = ready.shift();
    if (visited.has(currentId)) continue;
    visited.add(currentId);
    ordered.push(byId.get(currentId).task);
    for (const nextId of dependents.get(currentId) || []) {
      const nextDegree = (inDegree.get(nextId) || 0) - 1;
      inDegree.set(nextId, nextDegree);
      if (nextDegree === 0) ready.push(nextId);
    }
  }

  for (const task of batchTasks) {
    if (!visited.has(task.id)) ordered.push(task);
  }
  return ordered;
}

/**
 * Group tasks that share a due date and Card/subject into same-day sittings
 * (batches), ordered topologically by `dependsOn` within each sitting.
 */
export function groupTaskBatches(tasks, day, nowIso = new Date().toISOString()) {
  const groups = new Map();
  for (const task of tasks) {
    if (!task) continue;
    const due = String(task.date || "").slice(0, 10) || "unscheduled";
    const scope = batchScopeKey(task);
    const key = `${due}:${scope}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        date: due,
        scope,
        cardId: task.cardId || null,
        subject: task.subject || null,
        rawTasks: [],
      });
    }
    groups.get(key).rawTasks.push(task);
  }

  const batches = [];
  for (const group of groups.values()) {
    const ordered = orderBatchTasks(group.rawTasks);
    const byId = new Map(ordered.map((task) => [task.id, task]));
    const stateById = new Map();

    for (const task of ordered) {
      if (task.status === "done" || task.status === "skipped") {
        stateById.set(task.id, task.status);
        continue;
      }
      if (task.status === "waiting") {
        stateById.set(task.id, "waiting");
        continue;
      }
      if (!task.blocked) {
        stateById.set(task.id, "ready");
        continue;
      }
      const prereqs = Array.isArray(task.prerequisites) && task.prerequisites.length
        ? task.prerequisites
        : taskPrerequisiteIds(task).map((id) => ({
            id,
            status: byId.get(id)?.status || "unknown",
          }));
      const unresolved = prereqs.filter((entry) => entry.status !== "done" && entry.status !== "skipped");
      const allUnresolvedInBatchActionable =
        unresolved.length > 0 &&
        unresolved.every((entry) => {
          const state = stateById.get(entry.id);
          return state === "ready" || state === "chained";
        });
      stateById.set(task.id, allUnresolvedInBatchActionable ? "chained" : "blocked");
    }

    const annotatedTasks = ordered.map((task, idx) => ({
      ...task,
      batchStep: idx + 1,
      batchState: stateById.get(task.id) || task.status,
    }));

    const counts = { ready: 0, chained: 0, blocked: 0, waiting: 0, done: 0, skipped: 0 };
    const reqSet = new Set();
    let anyBrowserRequired = false;
    let allHeadless = annotatedTasks.length > 0;
    let bestSegmentIdx = SEGMENT_ORDER.length;

    for (const task of annotatedTasks) {
      if (counts[task.batchState] !== undefined) counts[task.batchState] += 1;
      for (const req of task.requires || []) reqSet.add(req);
      if (task.browserRequirement === "required") anyBrowserRequired = true;
      if (task.browserRequirement !== "headless") allHeadless = false;
      const seg = task.queueSegment || queueSegment(task, day, nowIso);
      const segIdx = SEGMENT_ORDER.indexOf(seg);
      if (segIdx !== -1 && segIdx < bestSegmentIdx) bestSegmentIdx = segIdx;
    }

    const browserRequirement = anyBrowserRequired ? "required" : allHeadless ? "headless" : null;
    batches.push({
      key: group.key,
      date: group.date,
      scope: group.scope,
      cardId: group.cardId,
      subject: group.subject,
      queueSegment: bestSegmentIdx < SEGMENT_ORDER.length ? SEGMENT_ORDER[bestSegmentIdx] : "",
      total: annotatedTasks.length,
      ready: counts.ready,
      chained: counts.chained,
      actionable: counts.ready + counts.chained,
      blocked: counts.blocked,
      waiting: counts.waiting,
      requires: [...reqSet].sort(),
      browserRequirement,
      tasks: annotatedTasks,
    });
  }

  return batches;
}

function printTaskBatches(io, batchList, view) {
  if (!batchList.length) {
    io.print("No Tasks match.");
    return;
  }
  table(
    io,
    batchList,
    [
      ["DUE", (b) => b.date],
      ...(view === "filter" ? [] : [["WHEN", (b) => b.queueSegment]]),
      ["SCOPE", (b) => b.scope],
      ["STEPS", (b) => String(b.total)],
      ["ACTIONABLE", (b) => `${b.actionable}/${b.total}`],
      ["REQUIRES", (b) => b.requires.join(",")],
      ["BROWSER", (b) => browserMark(b.browserRequirement)],
      ["FIRST STEP", (b) => b.tasks[0]?.description || ""],
    ],
    "No Tasks match.",
  );
  for (const batch of batchList) {
    io.print("");
    io.print(
      `Batch ${batch.date}  ${batch.scope}  (${batch.total} step${batch.total === 1 ? "" : "s"}, ${batch.actionable} actionable${batch.blocked ? `, ${batch.blocked} blocked` : ""}${batch.waiting ? `, ${batch.waiting} waiting` : ""})`,
    );
    for (const task of batch.tasks) {
      io.print(
        `  ${task.batchStep}. [${task.batchState}] ${task.id}  ${task.description}`,
      );
    }
  }
}

export async function list(args, io) {
  const api = apiFor(args);
  const owner = ownerOf(args);
  const day = isoDate(args.asOf, "as-of") || today();
  const date = isoDate(args.date, "date");
  const from = isoDate(args.from, "from");
  const to = isoDate(args.to, "to");
  if (Boolean(from) !== Boolean(to)) throw new UsageError("--from and --to go together.");
  // Timed tasks surface at their moment: with --as-of the queue pretends the
  // day just started, otherwise it uses this instant.
  const nowIso = args.asOf ? `${day}T00:00:00Z` : new Date().toISOString();
  const status = optionalString(args, "status");
  const card = optionalString(args, "card");
  const resources = requiresQuery(args);
  const browser = browserQuery(args);
  const limit = args.limit !== undefined ? integer(args.limit, "limit") : undefined;
  const cursor = optionalString(args, "cursor");

  let tasks;
  let view;
  let nextCursor;
  if (date || from || status || card) {
    view = "filter";
    const query = {
      owner, cardId: card, status, date, startDate: from, endDate: to, ...resources, ...browser,
      ...(limit !== undefined ? { limit } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
    };
    if (args.all) {
      tasks = [];
      let currentCursor = cursor;
      do {
        const page = await api.get("/api/tasks", { query: { ...query, ...(currentCursor ? { cursor: currentCursor } : {}) } });
        tasks.push(...tasksOf(page));
        currentCursor = page?.nextCursor;
      } while (currentCursor);
    } else {
      const page = await api.get("/api/tasks", { query });
      tasks = tasksOf(page);
      nextCursor = page?.nextCursor;
    }
  } else {
    const wanted = ["today", "overdue", "waiting"].filter((name) => args[name]);
    view = !args.queue && wanted.length === 1 ? wanted[0] : "queue";
    const lanes = wanted.length && !args.queue ? wanted : ["today", "overdue", "waiting"];
    const queries = {
      today: { date: day },
      overdue: { startDate: "1970-01-01", endDate: yesterday(day) },
      waiting: { status: "waiting" },
    };
    const pages = await Promise.all(lanes.map((lane) => api.get("/api/tasks", { query: { ...queries[lane], owner, ...resources, ...browser } })));
    tasks = orderQueue(pages.flatMap(tasksOf), day, nowIso, { includeUpcomingWaiting: view === "waiting" });
    if (view === "overdue") tasks = tasks.filter((task) => task.queueSegment === "overdue");
    if (view === "today") tasks = tasks.filter((task) => String(task.date || "").slice(0, 10) === day);
    if (view === "waiting") tasks = tasks.filter(isWaitingOrFollowUp);
  }

  if (args.batches) {
    const batchList = groupTaskBatches(tasks, day, nowIso);
    const batchResult = {
      view,
      today: day,
      owner: owner || null,
      ...(resources.canDo !== undefined ? { canDo: csv(resources.canDo) } : {}),
      batches: batchList,
      tasks,
    };
    if (args.json) return batchResult;
    printTaskBatches(io, batchList, view);
    return batchResult;
  }

  const result = {
    view,
    today: day,
    owner: owner || null,
    ...(resources.canDo !== undefined ? { canDo: csv(resources.canDo) } : {}),
    tasks,
    ...(nextCursor ? { nextCursor } : {}),
  };
  if (args.json) return result;
  table(
    io,
    tasks,
    [
      ["ID", (task) => task.id],
      ["STATUS", (task) => task.status],
      ["DUE", (task) => String(task.date || "").slice(0, 10)],
      ...(view === "filter" ? [] : [["WHEN", (task) => task.queueSegment]]),
      ["ASSIGNEE", (task) => task.assignee?.name || ""],
      ["REQUIRES", (task) => (task.requires || []).join(",")],
      ["BROWSER", (task) => browserMark(task.browserRequirement)],
      ["BLOCKED", (task) => (task.blocked ? "yes" : "")],
      ["DESCRIPTION", (task) => task.description],
    ],
    "No Tasks match.",
  );
  if (nextCursor) {
    io.print(`More tasks available: pass --cursor ${nextCursor}`);
  }
  return result;
}

export async function batches(args, io) {
  return list({ ...args, batches: true }, io);
}

async function getTask(api, id) {
  return api.get(`/api/tasks/${enc(id)}`);
}

/** One line per prerequisite: its name and current status. */
function prerequisiteLines(task) {
  const prerequisites = task.prerequisites || [];
  return prerequisites.length ? prerequisites.map((entry) => `${entry.description} [${entry.status}] (${entry.id})`).join("; ") : "";
}

export async function show(args, io) {
  const api = apiFor(args);
  const id = await resolveTaskId(api, positional(args, 0, "dataops tasks show <task-id>"));
  const task = await getTask(api, id);
  if (args.json) return task;
  fields(io, [
    ["id", task.id],
    ["description", task.description],
    ["status", task.status],
    ["due", task.date],
    ["card", task.cardId],
    ["assignee", task.assignee ? `${task.assignee.name} (${task.assignee.id})` : task.assigneeId],
    ["link", task.link],
    ["requires", task.requires?.length ? task.requires.join(", ") : ""],
    ["browser", task.browserRequirement ? browserMark(task.browserRequirement) : "not classified"],
    ["depends on", prerequisiteLines(task)],
    ["blocked", task.blocked ? "yes - complete or skip the prerequisites first" : ""],
    ["required link", task.requiredLinkName],
    ["requires file", task.requiresFile ? "yes" : ""],
    ["proof", task.proofRequirement ? `${task.proofRequirement.type}${task.proofRequirement.label ? ` (${task.proofRequirement.label})` : ""}` : ""],
    ["comment", task.comment],
    ["waiting for", task.waitingFor],
    ["follow up", task.followUpAt],
    ["snoozed until", task.snoozedUntil],
    ["snooze reason", task.snoozeReason],
    ["not before", task.notBeforeAt],
    ["external status", task.externalStatus],
    ["instruction doc", task.instructionDocId],
    ["source docs", task.sourceDocIds],
    ["instructions", task.instructionsUrl],
    ["materials", task.materials?.length ? task.materials.map((m) => (m.label ? `${m.label} ${m.url}` : m.url)).join(", ") : ""],
    ["tags", task.tags],
    ["linked card", task.linkedCard ? `${linkedCardLabel(task.linkedCard)} ${portalUrl(api, task.linkedCard.url)}` : ""],
    ["template", task.templateId],
    ["version", task.version],
  ]);
  const log = Array.isArray(task.notesLog) ? task.notesLog : [];
  if (log.length) {
    const names = new Map((task.historyActors || []).map((actor) => [actor.id, actor.name]));
    io.print("");
    io.print("notes log:");
    for (const entry of log) {
      const who = (entry.authorId && names.get(entry.authorId)) || entry.authorId || "unknown";
      io.print(`  ${entry.createdAt} ${who}: ${entry.text}`);
    }
  }
  io.print("");
  io.print(`Docs for this Task: dataops kb related ${task.id}`);
  return task;
}

async function resolveAssignee(api, value) {
  if (value === "me") {
    const me = await api.get("/api/me");
    if (!me?.user?.id) throw new UsageError("--assignee me needs a signed-in user, not a service credential.");
    return me.user.id;
  }
  return value;
}

function writableFields(args) {
  const body = {};
  if (args.clearSubject) {
    if (args.subjectType !== undefined || args.subjectId !== undefined) throw new UsageError("Use --clear-subject or a subject, not both.");
    body.subject = null;
  } else if (args.subjectType !== undefined || args.subjectId !== undefined) {
    const type = required(args, "subjectType", "subject-type");
    const id = required(args, "subjectId", "subject-id");
    if (!["sponsor-deal", "sponsor-company", "sponsor-person", "tuition-agreement"].includes(type)) throw new UsageError("--subject-type must be sponsor-deal, sponsor-company, sponsor-person or tuition-agreement.");
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) throw new UsageError("--subject-id must be a record id.");
    if (args.card && args.card !== "none") throw new UsageError("A Task has a Card or a subject, not both.");
    body.subject = { type, id };
  }
  const description = optionalString(args, "description");
  if (description !== undefined) body.description = description;
  const date = isoDate(args.date, "date");
  if (date) body.date = date;
  if (args.at !== undefined || args.tz !== undefined) {
    const at = optionalString(args, "at");
    if (at === undefined) throw new UsageError("--tz needs --at: the moment is set with --at.");
    if (at === "none" || at === "") body.notBeforeAt = null;
    else {
      const tz = optionalString(args, "tz") || "Europe/Berlin";
      if (!isValidTimezone(tz)) throw new UsageError(`--tz must be an IANA timezone like Europe/Berlin, not ${tz}.`);
      const resolved = resolveDateTime(at, tz);
      if (!resolved) {
        throw new UsageError(`--at must be an ISO instant, "YYYY-MM-DD HH:mm", a date, or a relative word like +7d.`);
      }
      body.notBeforeAt = resolved;
      body.timezone = tz;
    }
  }
  const comment = optionalString(args, "comment");
  if (comment !== undefined) body.comment = comment;
  const link = optionalString(args, "link") ?? optionalString(args, "proofUrl");
  if (link !== undefined) body.link = link;
  const externalStatus = optionalString(args, "externalStatus");
  if (externalStatus !== undefined) body.externalStatus = externalStatus;
  if (args.tags !== undefined) body.tags = csv(args.tags);
  const card = optionalString(args, "card");
  if (card !== undefined) body.cardId = card === "none" ? null : card;
  const instructionDoc = optionalString(args, "instructionDoc");
  if (instructionDoc !== undefined) body.instructionDocId = instructionDoc;
  const requiredLinkName = optionalString(args, "requiredLinkName");
  if (requiredLinkName !== undefined) body.requiredLinkName = requiredLinkName;
  if (args.requires !== undefined) {
    const requires = required(args, "requires", "requires");
    body.requires = requires === "none" ? [] : csv(requires);
  }
  Object.assign(body, browserRequirementField(args));
  if (args.dependsOn !== undefined) {
    const dependsOn = required(args, "dependsOn", "depends-on");
    body.dependsOn = dependsOn === "none" ? [] : csv(dependsOn);
  }
  if (args.after !== undefined) {
    if (args.dependsOn !== undefined) throw new UsageError("Use --after or --depends-on, not both.");
    const after = required(args, "after", "after");
    body.dependsOn = after === "none" ? [] : [after];
  }
  return body;
}

export async function create(args, io) {
  const api = apiFor(args);
  const body = writableFields(args);
  body.description = required(args, "description", "description");
  body.date = body.date || today();
  if (body.cardId === null) delete body.cardId;
  if (body.subject === null) throw new UsageError("--clear-subject applies to tasks update only.");
  if (args.assignee !== undefined) body.assigneeId = await resolveAssignee(api, String(args.assignee));
  const task = await api.post("/api/tasks", body);
  if (args.json) return task;
  io.print(`Created Task ${task.id} - ${task.description} (due ${task.date}).`);
  return task;
}

async function currentVersion(api, id, args) {
  const task = await getTask(api, id);
  const expected = integer(args.expectedVersion, "expected-version");
  return { task, expectedVersion: expected ?? task.version };
}

function report(io, args, task, verb) {
  if (args.json) return task;
  io.print(`${verb} ${task.id} - ${task.description} [${task.status}].`);
  return task;
}

export async function update(args, io) {
  const id = positional(args, 0, "dataops tasks update <task-id> [--description D] ...");
  const body = writableFields(args);
  if (!Object.keys(body).length) throw new UsageError("Nothing to change. See `dataops tasks --help`.");
  const api = apiFor(args);
  const { expectedVersion } = await currentVersion(api, id, args);
  return report(io, args, await api.put(`/api/tasks/${enc(id)}`, { ...body, expectedVersion }), "Updated");
}

/** multipart/form-data for POST /api/files, matching the web upload. */
export function multipart(fieldsToSend, file) {
  const boundary = `----dataops-${randomUUID()}`;
  const parts = [];
  for (const [name, value] of Object.entries(fieldsToSend)) {
    if (value === undefined) continue;
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name.replace(/"/g, "")}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
  );
  parts.push(file.bytes, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

export async function uploadFile(api, taskId, path, category) {
  const { body, contentType } = multipart({ taskId, category }, { name: basename(path), bytes: readFileSync(path) });
  return api.post("/api/files", undefined, { rawBody: body, contentType });
}

export async function done(args, io) {
  const id = positional(args, 0, "dataops tasks done <task-id> [--link URL] [--comment C] [--file PATH]");
  const api = apiFor(args);
  if (args.file !== undefined) {
    if (args.file === true) throw new UsageError("--file needs a path.");
    await uploadFile(api, id, String(args.file), optionalString(args, "category"));
  }
  let { task, expectedVersion } = await currentVersion(api, id, args);
  const proof = writableFields({
    link: args.link,
    proofUrl: args.proofUrl,
    comment: args.comment,
    externalStatus: args.externalStatus,
    _: [],
  });
  if (task.status === "waiting") {
    if (Object.keys(proof).length) {
      task = await api.put(`/api/tasks/${enc(id)}`, { ...proof, expectedVersion });
      expectedVersion = task.version;
    }
    const note = optionalString(args, "note") || proof.comment || "Completed from the DataOps CLI";
    task = await api.post(`/api/tasks/${enc(id)}/actions/resolve-done`, { expectedVersion, note });
    return report(io, args, task, "Resolved and completed");
  }
  task = await api.put(`/api/tasks/${enc(id)}`, { ...proof, status: "done", expectedVersion });
  return report(io, args, task, "Completed");
}

export async function reopen(args, io) {
  const id = positional(args, 0, "dataops tasks reopen <task-id>");
  const api = apiFor(args);
  const { expectedVersion } = await currentVersion(api, id, args);
  return report(io, args, await api.put(`/api/tasks/${enc(id)}`, { status: "todo", expectedVersion }), "Reopened");
}

async function action(args, io, name, body, verb) {
  const id = args._[0];
  const api = apiFor(args);
  const { expectedVersion } = await currentVersion(api, id, args);
  const task = await api.post(`/api/tasks/${enc(id)}/actions/${name}`, { ...body, expectedVersion });
  return report(io, args, task, verb);
}

export async function wait(args, io) {
  positional(args, 0, "dataops tasks wait <task-id> --for WHO --follow-up YYYY-MM-DD --channel C --note N");
  return action(args, io, "mark-waiting", {
    waitingFor: required(args, "for", "for"),
    followUpAt: isoDate(required(args, "followUp", "follow-up"), "follow-up"),
    channel: required(args, "channel", "channel"),
    note: required(args, "note", "note"),
  }, "Waiting on");
}

export async function followedUp(args, io) {
  positional(args, 0, "dataops tasks followed-up <task-id> --channel C --note N [--next YYYY-MM-DD]");
  return action(args, io, "follow-up-sent", {
    channel: required(args, "channel", "channel"),
    note: required(args, "note", "note"),
    nextFollowUpAt: isoDate(args.next, "next"),
  }, "Recorded follow-up on");
}

/**
 * Where a follow-up Task belongs: the same Card or subject as the Task it is
 * about, the Card it names, or a sponsor deal otherwise (the API 404s when
 * the deal does not exist).
 */
async function resolveAbout(api, about) {
  try {
    const task = await api.get(`/api/tasks/${enc(about)}`);
    if (task?.cardId) return { cardId: task.cardId, label: `task ${about}` };
    if (task?.subject?.type && task?.subject?.id) {
      return { subject: { type: task.subject.type, id: task.subject.id }, label: `task ${about}` };
    }
    if (task?.id) return { label: `task ${about}` };
  } catch (error) {
    if (error?.status !== 404) throw error;
  }
  try {
    const card = await api.get(`/api/cards/${enc(about)}`);
    const id = card?.card?.id || card?.id;
    if (id) return { cardId: id, label: `card ${about}` };
  } catch (error) {
    if (error?.status !== 404) throw error;
  }
  try {
    const company = await api.get(`/api/sponsor-crm/directory/companies/${enc(about)}`);
    if (company?.id) return { subject: { type: "sponsor-company", id: about }, label: `company ${company.displayName || about}` };
  } catch (error) {
    if (error?.status !== 404) throw error;
  }
  try {
    const contact = await api.get(`/api/sponsor-crm/contacts/${enc(about)}`);
    if (contact?.id) return { subject: { type: "sponsor-person", id: about }, label: `person ${contact.name || about}` };
  } catch (error) {
    if (error?.status !== 404) throw error;
  }
  return { subject: { type: "sponsor-deal", id: about }, label: `sponsor deal ${about}` };
}

export async function followup(args, io) {
  const about = required(args, "about", "about");
  const on = isoDate(required(args, "on", "on"), "on");
  const description = required(args, "description", "description");
  const note = optionalString(args, "note");
  const api = apiFor(args);
  const { cardId, subject, label } = await resolveAbout(api, about);
  const body = { description, date: on, ...(cardId ? { cardId } : {}), ...(subject ? { subject } : {}), ...(note ? { comment: note } : {}) };
  if (args.assignee !== undefined) body.assigneeId = await resolveAssignee(api, String(args.assignee));
  const task = await api.post("/api/tasks", body);
  if (args.json) return task;
  io.print(`Created follow-up Task ${task.id} about ${label} - ${task.description} (due ${task.date}).`);
  return task;
}

export async function snooze(args, io) {
  positional(args, 0, "dataops tasks snooze <task-id> --until +7d --reason R");
  return action(args, io, "snooze", {
    snoozedUntil: isoDate(required(args, "until", "until"), "until"),
    reason: required(args, "reason", "reason"),
  }, "Snoozed");
}

export async function unsnooze(args, io) {
  positional(args, 0, "dataops tasks unsnooze <task-id>");
  return action(args, io, "unsnooze", {}, "Unsnoozed");
}

export async function note(args, io) {
  const id = positional(args, 0, `dataops tasks note <task-id> "text"`);
  const text = positional(args, 1, `dataops tasks note <task-id> "text"`);
  if (!text.trim()) throw new UsageError(`Usage: dataops tasks note <task-id> "text"`);
  const api = apiFor(args);
  const { expectedVersion } = await currentVersion(api, id, args);
  return report(io, args, await api.post(`/api/tasks/${enc(id)}/actions/add-note`, { note: text, expectedVersion }), "Noted");
}

export async function unblock(args, io) {
  positional(args, 0, "dataops tasks unblock <task-id> --note N [--unblocked]");
  return action(args, io, args.unblocked ? "unblocked" : "response-received", {
    note: required(args, "note", "note"),
    channel: optionalString(args, "channel"),
  }, "Unblocked");
}

export async function skip(args, io) {
  positional(args, 0, "dataops tasks skip <task-id> --reason R");
  return action(args, io, "skip", { reason: required(args, "reason", "reason") }, "Skipped");
}

export async function unskip(args, io) {
  positional(args, 0, "dataops tasks unskip <task-id>");
  return action(args, io, "unskip", {}, "Unskipped");
}

export async function assign(args, io) {
  const id = positional(args, 0, "dataops tasks assign <task-id> <user-id|me>");
  const who = positional(args, 1, "dataops tasks assign <task-id> <user-id|me>");
  const api = apiFor(args);
  const assigneeId = await resolveAssignee(api, who);
  const { expectedVersion } = await currentVersion(api, id, args);
  return report(io, args, await api.put(`/api/tasks/${enc(id)}`, { assigneeId, expectedVersion }), "Assigned");
}

/**
 * Hand work to another agent. One Task (`handover <id> --to <agent>`) or a
 * whole queue (`handover --from <agent> --to <agent>`, every open Task).
 * Reassigning is administration, like `assign`: the portal refuses it for
 * non-admins, and the bulk form surfaces that refusal instead of reporting
 * an empty move.
 */
export async function handover(args, io) {
  const to = optionalString(args, "to");
  if (!to) throw new UsageError("--to is required: the agent who takes over.");
  const api = apiFor(args);
  const toId = await resolveAssignee(api, to);
  const id = args._[0] === undefined ? undefined : String(args._[0]);
  if (id !== undefined) {
    const { expectedVersion } = await currentVersion(api, id, args);
    return report(io, args, await api.put(`/api/tasks/${enc(id)}`, { assigneeId: toId, expectedVersion }), "Handed over");
  }
  const from = optionalString(args, "from");
  if (!from) {
    throw new UsageError("Give a Task or --from: `dataops tasks handover <task-id> --to <agent>` or `dataops tasks handover --from <agent> --to <agent>`.");
  }
  const fromId = await resolveAssignee(api, from);
  const open = tasksOf(await api.get("/api/tasks", { query: { owner: fromId } })).filter((task) => OPEN.has(task.status));
  let moved = 0;
  const remaining = [];
  let firstError = null;
  for (const task of open) {
    try {
      await api.put(`/api/tasks/${enc(task.id)}`, { assigneeId: toId, expectedVersion: task.version });
      moved += 1;
    } catch (error) {
      remaining.push(task.id);
      firstError = firstError || error;
    }
  }
  if (moved === 0 && remaining.length > 0 && firstError) throw firstError;
  const result = { from: fromId, to: toId, moved, remaining };
  if (args.json) return result;
  io.print(`Handed over ${moved} open Task(s) from ${fromId} to ${toId}.`);
  if (remaining.length) io.print(`Still open: ${remaining.length} Task(s) changed meanwhile; run it again.`);
  return result;
}

/** Link a Task to the Card that carries it out (a course's Workshop 2 Task to that workshop's Card), or clear it. */
export async function linkCard(args, io) {
  const usage = "dataops tasks link-card <task-id> <card-id> | dataops tasks link-card <task-id> --unlink";
  const id = positional(args, 0, usage);
  const cardId = args._[1] === undefined ? undefined : String(args._[1]);
  if (Boolean(args.unlink) === (cardId !== undefined)) throw new UsageError(usage);
  const api = apiFor(args);
  const taskId = await resolveTaskId(api, id);
  const { expectedVersion } = await currentVersion(api, taskId, args);
  const task = await api.post(`/api/tasks/${enc(taskId)}/actions/link-card`, {
    cardId: cardId ?? null, expectedVersion,
  });
  if (args.json) return task;
  io.print(task.linkedCard
    ? `Linked ${task.description} -> ${linkedCardLabel(task.linkedCard)} ${portalUrl(api, task.linkedCard.url)}`
    : `Unlinked ${task.description}.`);
  return task;
}

export async function remove(args, io) {
  const id = positional(args, 0, "dataops tasks delete <task-id>");
  const api = apiFor(args);
  const { expectedVersion } = await currentVersion(api, id, args);
  await api.delete(`/api/tasks/${enc(id)}`, { expectedVersion });
  const result = { status: "deleted", id };
  if (!args.json) io.print(`Deleted Task ${id}.`);
  return result;
}

export const commands = {
  list,
  batches,
  show,
  create,
  update,
  done,
  reopen,
  wait,
  "followed-up": followedUp,
  followup,
  snooze,
  unsnooze,
  note,
  unblock,
  skip,
  unskip,
  assign,
  handover,
  "link-card": linkCard,
  delete: remove,
};
