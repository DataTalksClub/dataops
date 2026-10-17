import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";

import { UsageError } from "../errors.mjs";
import { enc, fields, integer, isoDate, list as csv, optionalString, positional, required, table } from "../format.mjs";
import { apiFor, today } from "../session.mjs";

export const summary = "List, inspect, create, complete, skip, and follow up Tasks";

export const help = `dataops tasks - Tasks are the checklist items inside Cards

Usage
  dataops tasks list [view] [filters]
  dataops tasks show <task-id>
  dataops tasks create --description D [--date YYYY-MM-DD] [--card ID] [--assignee ID|me]
      [--subject-type sponsor-deal|sponsor-company --subject-id ID]
      [--comment C] [--link URL] [--tags a,b] [--required-link-name NAME] [--instruction-doc DOC-ID]
      [--requires youtube,luma] [--browser required|headless] [--depends-on ID,ID]
  dataops tasks update <task-id> [--description D] [--date D] [--comment C] [--link URL]
      [--subject-type sponsor-deal|sponsor-company --subject-id ID | --clear-subject]
      [--external-status S] [--tags a,b] [--card ID|none] [--instruction-doc DOC-ID]
      [--requires a,b|none] [--browser required|headless|none] [--depends-on ID,ID|none]
  dataops tasks done <task-id> [--link URL] [--comment C] [--external-status S] [--file PATH]
  dataops tasks reopen <task-id>
  dataops tasks skip <task-id> --reason R        Resolve as not applicable (no proof needed)
  dataops tasks unskip <task-id>                 Back to todo
  dataops tasks wait <task-id> --for WHO --follow-up YYYY-MM-DD --channel CHANNEL --note NOTE
  dataops tasks followed-up <task-id> --channel CHANNEL --note NOTE [--next YYYY-MM-DD]
  dataops tasks followup --about <task|card|sponsor-deal id> --on +7d --description "check X" [--note "context"]
      Linked to its subject, assigned to you, due that day
  dataops tasks snooze <task-id> --until +7d --reason R   Hide from today/overdue until then
  dataops tasks unsnooze <task-id>                       Back in the queue now
  dataops tasks unblock <task-id> --note NOTE [--unblocked]   (default: response received)
  dataops tasks assign <task-id> <user-id|me>
  dataops tasks delete <task-id>                                (admin)

List views (default: --queue)
  --queue      Open work in the web queue's order: overdue, follow-ups due, today, waiting
  --today      Due today          --overdue    Open and past due     --waiting   Waiting on someone
  --status S   todo|waiting|done|skipped       --date D    One day     --from D --to D   A range
  --card ID    Every Task of a Card
  --owner me|team|unassigned|<user-id>, or --mine for --owner me
  --as-of YYYY-MM-DD   Treat this date as today (default: the local date)

Dates (Europe/Berlin)
  Every date flag also takes +7d (days ahead), tomorrow, or a weekday name
  (mon is the next Monday, strictly after today): --date, --from, --to,
  --as-of, create --date, wait --follow-up, followed-up --next.

Dependencies
  --depends-on ID,ID       Prerequisite Tasks on the same Card; the Task cannot be completed
                           until every one is done or skipped.
                           \`none\` clears them. show lists each prerequisite's name and status;
                           list marks blocked Tasks. The API rejects self, missing,
                           cross-Card and cyclic prerequisites, completing a blocked Task,
                           and reopening or deleting a prerequisite of a completed Task.

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
  return OPEN.has(task.status) && (task.status === "waiting" || Boolean(task.waitingFor) || Boolean(task.followUpAt));
}

/** A snoozed Task stays out of the queue while its date is in the future. */
export function isSnoozed(task, day) {
  const until = String(task.snoozedUntil || "").slice(0, 10);
  return Boolean(until) && until > day;
}

/** The web queue's urgency segment for one open Task. */
export function queueSegment(task, day) {
  const due = String(task.date || "").slice(0, 10);
  const followUp = String(task.followUpAt || "").slice(0, 10);
  if (!OPEN.has(task.status)) return "";
  if (isSnoozed(task, day)) return "snoozed";
  if (due && due < day) return "overdue";
  if (isWaitingOrFollowUp(task) && followUp && followUp <= day) return "follow-up";
  if (due === day) return "today";
  if (isWaitingOrFollowUp(task)) return "waiting";
  return "open";
}

const SEGMENT_ORDER = ["overdue", "follow-up", "today", "waiting", "open", "snoozed"];

export function orderQueue(tasks, day) {
  const seen = new Set();
  const unique = tasks.filter((task) => task && OPEN.has(task.status) && !isSnoozed(task, day) && !seen.has(task.id) && seen.add(task.id));
  return unique
    .map((task) => ({ ...task, queueSegment: queueSegment(task, day) }))
    .sort(
      (a, b) =>
        SEGMENT_ORDER.indexOf(a.queueSegment) - SEGMENT_ORDER.indexOf(b.queueSegment) ||
        String(a.date || "").localeCompare(String(b.date || "")),
    );
}

function yesterday(day) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export async function list(args, io) {
  const api = apiFor(args);
  const owner = ownerOf(args);
  const day = isoDate(args.asOf, "as-of") || today();
  const date = isoDate(args.date, "date");
  const from = isoDate(args.from, "from");
  const to = isoDate(args.to, "to");
  if (Boolean(from) !== Boolean(to)) throw new UsageError("--from and --to go together.");
  const status = optionalString(args, "status");
  const card = optionalString(args, "card");
  const resources = requiresQuery(args);
  const browser = browserQuery(args);

  let tasks;
  let view;
  if (date || from || status || card) {
    view = "filter";
    const query = { owner, cardId: card, status, date, startDate: from, endDate: to, ...resources, ...browser };
    tasks = tasksOf(await api.get("/api/tasks", { query }));
  } else {
    const wanted = ["today", "overdue", "waiting"].filter((name) => args[name]);
    view = wanted.length === 1 ? wanted[0] : "queue";
    const lanes = wanted.length && !args.queue ? wanted : ["today", "overdue", "waiting"];
    const queries = {
      today: { date: day },
      overdue: { startDate: "1970-01-01", endDate: yesterday(day) },
      waiting: { status: "waiting" },
    };
    const pages = await Promise.all(lanes.map((lane) => api.get("/api/tasks", { query: { ...queries[lane], owner, ...resources, ...browser } })));
    tasks = orderQueue(pages.flatMap(tasksOf), day);
    if (view === "overdue") tasks = tasks.filter((task) => task.queueSegment === "overdue");
    if (view === "today") tasks = tasks.filter((task) => String(task.date || "").slice(0, 10) === day);
    if (view === "waiting") tasks = tasks.filter(isWaitingOrFollowUp);
  }

  const result = { view, today: day, owner: owner || null, ...(resources.canDo !== undefined ? { canDo: csv(resources.canDo) } : {}), tasks };
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
  return result;
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
  const id = positional(args, 0, "dataops tasks show <task-id>");
  const task = await getTask(apiFor(args), id);
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
    ["external status", task.externalStatus],
    ["instruction doc", task.instructionDocId],
    ["source docs", task.sourceDocIds],
    ["instructions", task.instructionsUrl],
    ["materials", task.materials?.length ? task.materials.map((m) => (m.label ? `${m.label} ${m.url}` : m.url)).join(", ") : ""],
    ["tags", task.tags],
    ["template", task.templateId],
    ["version", task.version],
  ]);
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
    if (!["sponsor-deal", "sponsor-company"].includes(type)) throw new UsageError("--subject-type must be sponsor-deal or sponsor-company.");
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) throw new UsageError("--subject-id must be a record id.");
    if (args.card && args.card !== "none") throw new UsageError("A Task has a Card or a subject, not both.");
    body.subject = { type, id };
  }
  const description = optionalString(args, "description");
  if (description !== undefined) body.description = description;
  const date = isoDate(args.date, "date");
  if (date) body.date = date;
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
  unblock,
  skip,
  unskip,
  assign,
  delete: remove,
};
