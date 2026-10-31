import { UsageError } from "../errors.mjs";
import { calendarLabel, enc, fields, integer, isoDate, linkedCardLabel, list as csv, optionalString, portalUrl, positional, required, table } from "../format.mjs";
import { apiFor } from "../session.mjs";
import { create as createSponsorDoc } from "./sponsorDocs.mjs";
import { findTemplate } from "./templates.mjs";

export const summary = "List, inspect, create (from a Template), and move Cards";

export const STAGES = ["preparation", "announced", "after-event"];

export const help = `dataops cards - a Card is one unit of work, created from a Template

Usage
  dataops cards list [--owner me|team|unassigned|<user-id>] [--mine] [--stage S]
      [--status active|parked|archived] [--all] [--limit N]
                                                Default: active and parked; --all adds archived
  dataops cards show <card-id>                  The Card, its links, and its Tasks
  dataops cards create --date YYYY-MM-DD --template ID|TYPE|NAME [--title T]
      [--end-date YYYY-MM-DD] [--optional-groups a,b] [--count FIELD=N,...] [--stage S] [--description D] [--owner ID] [--tags a,b]
  dataops cards update <card-id> [--title T] [--description D] [--date D] [--end-date D] [--owner ID|none]
      [--tags a,b]
  dataops cards update <card-id> --count FIELD=N[,FIELD=N] [--apply]
                                                Change a count (e.g. workshops=3); preview by default
  dataops cards time <card-id> --at "YYYY-MM-DD HH:MM" [--duration 60] [--tz Europe/Berlin]
      [--guests EMAIL,EMAIL] [--json]            Set the event time: creates or moves its invites on
                                                DTC events, Alexey personal and orin@ (the only way)
  dataops cards event-slots <card-id> [--apply] [--json]
                                                A course's event Cards (Q&A, launch, workshops);
                                                --apply creates and links the missing ones, undated
  dataops cards stage <card-id> <preparation|announced|after-event>
  dataops cards link <card-id> <link-name> <url>  Fill a Card link (e.g. a template's required link)
  dataops cards invite list <card-id> [--json]  The Card's invites, checked in Google (gone = stale)
  dataops cards invite remove <card-id> <event-id> [--calendar CAL] [--delete-event] [--json]
                                                Unlink an invite from the Card; with --delete-event also
                                                deletes the Google event (no guest notification)
  dataops cards sponsor-doc <card-id> [--template T] [--slot primary|secondary] [--sponsor NAME]
                                                Create a portal sponsor doc and link it on the Card
  dataops cards park <card-id> | resume <card-id>
  dataops cards delete <card-id> --yes          Delete the Card and all its Tasks (admin)
  dataops cards dedupe-tasks --card ID|--all [--dry-run] [--apply]
                                                Skip manual duplicates; preview by default
  dataops cards template-update <card-id> [--optional-groups a,b|none] [--count FIELD=N] [--apply]
                                                Review Template and Card option changes

--date is the Card's anchor date: Template Tasks are scheduled relative to it.
A Template with Tasks anchored to END also needs --end-date (the cohort END
date); Tasks anchored to END count their offset from it.
--title is required unless the Template has a card_title pattern, which
names the Card when the title is left out.
Writes read the Card's current version first (or pass --expected-version N).
Optional groups default off. Existing Cards need an explicit option decision;
--optional-groups sponsored activates sponsor work; none disables all optional work.
Template updates may also include newer definition changes; review before --apply.

Counts
A Template can declare count fields (e.g. workshops, "Number of workshops") and
repeat Tasks once per unit: Workshop 1..N. Set them with create --count; change
them with update --count. Raising adds the missing numbered Tasks; lowering
removes the extra ones that are not done and link no Card. Done or linked extras
stay. The preview lists every add and removal; nothing changes without --apply.
Link a repeated Task to its own Card with \`dataops tasks link-card <task> <card>\`.

Event Cards
A Template Task with a link_card slot (a course's Pre-Course Live Q&A, launch
stream, Workshop N) is done through its own event Card, never a comment or URL.
Creating the course Card creates those event Cards undated ("date TBD") and
links them; \`cards event-slots <card> --apply\` adds any that are missing.
\`cards time <event-card>\` is the one way to date an event: it sets the Card
date, re-dates its open Tasks and sends the calendar invites.
Disabled open tasks are skipped with history; completed and operator-skipped tasks stay resolved.

Examples
  dataops templates list
  dataops cards create --title "Newsletter 2026-11-02" --date 2026-11-02 --template newsletter-issue
  dataops cards show 542df0a6-...
  dataops cards link 542df0a6-... "Published issue" https://example.com/issue
`;

function itemsOf(payload) {
  return Array.isArray(payload?.cards?.items) ? payload.cards.items : [];
}

export async function list(args, io) {
  const api = apiFor(args);
  const owner = args.mine ? "me" : optionalString(args, "owner");
  const stage = optionalString(args, "stage");
  const status = optionalString(args, "status");
  const max = integer(args.limit, "limit") ?? 200;
  const cards = [];
  let cursor;
  do {
    const page = await api.get("/api/cards", { query: { owner, cursor, limit: 100 } });
    for (const card of itemsOf(page)) {
      if (stage && card.stage !== stage) continue;
      if (status ? card.status !== status : card.status === "archived" && !args.all) continue;
      cards.push(card);
    }
    cursor = page?.cards?.nextCursor;
  } while (cursor && cards.length < max);
  const result = { cards: cards.slice(0, max) };
  if (args.json) return result;
  table(
    io,
    result.cards,
    [
      ["ID", (card) => card.id],
      ["STATUS", (card) => card.status],
      ["STAGE", (card) => card.stage],
      ["DATE", (card) => card.anchorDate],
      ["OPEN", (card) => `${card.openTaskCount ?? "?"}/${card.taskCount ?? "?"}`],
      ["OWNER", (card) => card.owner?.name || ""],
      ["TITLE", (card) => card.title],
    ],
    "No Cards match.",
  );
  return result;
}

export async function show(args, io) {
  const id = positional(args, 0, "dataops cards show <card-id>");
  const api = apiFor(args);
  const [{ card }, tasks] = await Promise.all([
    api.get(`/api/cards/${enc(id)}`),
    api.get("/api/tasks", { query: { cardId: id } }),
  ]);
  const result = { card, tasks: Array.isArray(tasks?.tasks) ? tasks.tasks : [] };
  if (args.json) return result;
  fields(io, [
    ["id", card.id],
    ["title", card.title],
    ["status", card.status],
    ["stage", card.stage],
    ["date", card.anchorDate || "TBD (set with: dataops cards time)"],
    ["end date", card.endDate],
    ["event time", card.eventTime?.startIso],
    ["event end", card.eventTime?.endIso],
    ["time zone", card.eventTime?.timeZone],
    ["guests", card.guestEmails],
    ["owner", card.owner?.name],
    ["template", card.templateId],
    ["options", card.selectedOptionalGroups],
    ["counts", card.counts && Object.keys(card.counts).length
      ? Object.entries(card.counts).map(([field, count]) => `${field}=${count}`).join(", ") : undefined],
    ["description", card.description],
    ["tags", card.tags],
    ["source docs", card.sourceDocIds],
    ["version", card.version],
  ]);
  for (const link of card.cardLinks || []) {
    io.print(`link: ${link.name || link.label} = ${link.url || "(not filled)"}`);
  }
  for (const invite of card.calendarInvites || []) {
    io.print(`invite: ${invite.eventId} on ${calendarLabel(invite.calendar)}${invite.label ? ` [${invite.label}]` : ""}${invite.staleAt ? " STALE (gone in Google; unlink with: dataops cards invite remove " + card.id + " " + invite.eventId + ")" : ""}${invite.url ? ` ${invite.url}` : ""}`);
  }
  for (const ref of card.linkedFrom || []) {
    io.print(`linked from: ${ref.cardTitle} - ${ref.taskDescription} [${ref.taskStatus}] ${portalUrl(api, ref.url)}`);
  }
  for (const task of result.tasks) {
    if (task.linkedCard) io.print(`task link: ${task.description} -> ${linkedCardLabel(task.linkedCard)} ${portalUrl(api, task.linkedCard.url)}`);
  }
  for (const doc of card.sponsorDocs || []) {
    const edited = doc.lastEditedAt ? `, last edited ${doc.lastEditedAt} by ${doc.lastEditedBy || "staff"}` : "";
    io.print(`sponsor doc: ${doc.id} [${doc.status}] (${doc.template}${edited})`);
  }
  io.print("");
  table(
    io,
    [...result.tasks].sort((a, b) => String(a.date).localeCompare(String(b.date))),
    [
      ["TASK", (task) => task.id],
      ["STATUS", (task) => task.status],
      ["DUE", (task) => task.date],
      ["DESCRIPTION", (task) => task.description],
      ["LINKED CARD", (task) => linkedCardLabel(task.linkedCard)],
    ],
    "No Tasks.",
  );
  io.print("");
  io.print(`Docs for this Card: dataops kb related ${card.id}`);
  return result;
}

export async function create(args, io) {
  const api = apiFor(args);
  const body = { anchorDate: isoDate(required(args, "date", "date"), "date") };
  const endDate = optionalString(args, "endDate");
  if (endDate !== undefined) body.endDate = isoDate(endDate, "end-date");
  const title = optionalString(args, "title");
  if (title !== undefined) body.title = title;
  // Every Card is instantiated from a Template.
  body.templateId = (await findTemplate(api, required(args, "template", "template"))).id;
  if (args.optionalGroups !== undefined) body.optionalGroups = csv(args.optionalGroups);
  if (args.count !== undefined) body.counts = parseCounts(args.count);
  const stage = optionalString(args, "stage");
  if (stage !== undefined) body.stage = stage;
  const description = optionalString(args, "description");
  if (description !== undefined) body.description = description;
  const owner = optionalString(args, "owner");
  if (owner !== undefined) body.ownerId = owner;
  if (args.tags !== undefined) body.tags = csv(args.tags);
  const result = await api.post("/api/cards", body);
  if (args.json) return result;
  io.print(`Created Card ${result.card.id} - ${result.card.title} (${result.tasks?.length ?? 0} Tasks).`);
  for (const task of result.tasks || []) io.print(`  ${task.id}  ${task.date}  ${task.description}`);
  for (const slot of result.eventSlots || []) {
    if (slot.outcome === "created") io.print(`Event Card ${slot.cardId} - ${slot.cardTitle} (date TBD; set it with: dataops cards time ${slot.cardId} --at "YYYY-MM-DD HH:MM")`);
  }
  if (result.eventSlotsError) io.print(`Event Cards incomplete: ${result.eventSlotsError}`);
  return result;
}

async function write(args, io, id, change, verb) {
  const api = apiFor(args);
  const { card } = await api.get(`/api/cards/${enc(id)}`);
  const expectedVersion = integer(args.expectedVersion, "expected-version") ?? card.version;
  const body = typeof change === "function" ? change(card) : change;
  const result = await api.put(`/api/cards/${enc(id)}`, { ...body, expectedVersion });
  if (args.json) return result;
  io.print(`${verb} ${result.card.id} - ${result.card.title} [${result.card.stage}].`);
  return result;
}

/** `workshops=3,speakers=2` as `{ workshops: 3, speakers: 2 }`. */
export function parseCounts(value) {
  const counts = {};
  for (const entry of csv(value)) {
    const match = /^([a-z0-9][a-z0-9-]*)=(\d+)$/.exec(entry);
    if (!match) throw new UsageError(`--count takes FIELD=N pairs, e.g. --count workshops=3 (got "${entry}").`);
    counts[match[1]] = Number(match[2]);
  }
  if (!Object.keys(counts).length) throw new UsageError("--count needs at least one FIELD=N pair.");
  return counts;
}

export async function update(args, io) {
  const id = positional(args, 0, "dataops cards update <card-id> [--title T] ...");
  if (args.count !== undefined) {
    const other = ["title", "description", "date", "endDate", "owner", "tags"].find((flag) => args[flag] !== undefined);
    if (other) throw new UsageError(`--count is a reviewed change of its own; run --${other} separately.`);
    return templateUpdate(args, io);
  }
  const body = {};
  for (const [flag, key] of [["title", "title"], ["description", "description"]]) {
    const value = optionalString(args, flag);
    if (value !== undefined) body[key] = value;
  }
  const date = isoDate(args.date, "date");
  if (date) body.anchorDate = date;
  const endDate = optionalString(args, "endDate");
  if (endDate !== undefined) body.endDate = isoDate(endDate, "end-date");
  const owner = optionalString(args, "owner");
  if (owner !== undefined) body.ownerId = owner === "none" ? null : owner;
  if (args.tags !== undefined) body.tags = csv(args.tags);
  if (!Object.keys(body).length) throw new UsageError("Nothing to change. See `dataops cards --help`.");
  return write(args, io, id, body, "Updated");
}

export async function stage(args, io) {
  const id = positional(args, 0, "dataops cards stage <card-id> <stage>");
  const value = positional(args, 1, `dataops cards stage <card-id> <${STAGES.join("|")}>`);
  if (!STAGES.includes(value)) throw new UsageError(`Stage must be one of: ${STAGES.join(", ")}.`);
  return write(args, io, id, { stage: value }, "Moved");
}

export async function link(args, io) {
  const usage = "dataops cards link <card-id> <link-name> <url>";
  const id = positional(args, 0, usage);
  const name = positional(args, 1, usage);
  const url = positional(args, 2, usage);
  const api = apiFor(args);
  const { card } = await api.get(`/api/cards/${enc(id)}`);
  const links = Array.isArray(card.cardLinks) ? card.cardLinks : [];
  if (links.some((item) => (item.name || item.label) === name)) {
    return write(args, io, id, {
      cardLinks: links.map((item) => ((item.name || item.label) === name ? { ...item, url } : item)),
    }, `Saved "${name}" on`);
  }
  // A link the Card's Template defines today (e.g. "Meetup Global") but the
  // Card predates is added to the Card.
  const template = card.templateId ? await api.get(`/api/templates/${enc(card.templateId)}`).catch(() => null) : null;
  const defined = (template?.template || template)?.cardLinkDefinitions || [];
  if (!defined.some((definition) => definition.name === name)) {
    const known = [...new Set([...links.map((item) => item.name || item.label), ...defined.map((definition) => definition.name)])].join(", ") || "none";
    throw new UsageError(`Card has no link named "${name}". Known links: ${known}.`);
  }
  return write(args, io, id, { cardLinks: [...links, { name, url }] }, `Saved "${name}" on`);
}

async function parkResume(args, io, verb) {
  const id = positional(args, 0, `dataops cards ${verb} <card-id>`);
  const api = apiFor(args);
  const { card } = await api.get(`/api/cards/${enc(id)}`);
  const expectedVersion = integer(args.expectedVersion, "expected-version") ?? card.version;
  const result = await api.post(`/api/cards/${enc(id)}/${verb}`, { expectedVersion });
  if (args.json) return result;
  io.print(`${verb === "park" ? "Parked" : "Resumed"} ${result.card.id} - ${result.card.title}.`);
  return result;
}

export const park = (args, io) => parkResume(args, io, "park");
export const resume = (args, io) => parkResume(args, io, "resume");

export async function remove(args, io) {
  const id = positional(args, 0, "dataops cards delete <card-id> --yes");
  const api = apiFor(args);
  const { card } = await api.get(`/api/cards/${enc(id)}`);
  const taskCount = Number(card.taskCount || 0);
  if (!args.yes) {
    throw new UsageError(
      `This deletes Card "${card.title || id}" and its ${taskCount} Task${taskCount === 1 ? "" : "s"}. `
      + `Re-run with --yes to confirm: dataops cards delete ${id} --yes`,
    );
  }
  const expectedVersion = integer(args.expectedVersion, "expected-version") ?? card.version;
  const result = await api.delete(`/api/cards/${enc(id)}`, { expectedVersion });
  if (args.json) return result;
  const deleted = result.deleted || {};
  const removedTasks = (deleted.deletedTaskIds || []).length;
  io.print(`Deleted ${id} - ${deleted.title || card.title || ""} and ${removedTasks} Task${removedTasks === 1 ? "" : "s"}.`);
  return result;
}

export async function templateUpdate(args, io) {
  const id = positional(args, 0, "dataops cards template-update <card-id> [--apply]");
  const api = apiFor(args);
  const optionalGroups = args.optionalGroups === undefined ? undefined
    : args.optionalGroups === "none" ? [] : csv(args.optionalGroups);
  const counts = args.count === undefined ? undefined : parseCounts(args.count);
  const target = {
    ...(optionalGroups === undefined ? {} : { optionalGroups }),
    ...(counts === undefined ? {} : { counts }),
  };
  const { preview } = Object.keys(target).length === 0
    ? await api.get(`/api/cards/${enc(id)}/template-update`)
    : await api.post(`/api/cards/${enc(id)}/template-update`, { previewOnly: true, ...target });
  if (!args.apply) {
    if (args.json) return { preview };
    if (counts) printCountPreview(io, preview);
    else io.print(JSON.stringify(preview, null, 2));
    io.print("");
    const flags = [
      optionalGroups === undefined ? "" : ` --optional-groups ${optionalGroups.join(",") || "none"}`,
      counts === undefined ? "" : ` --count ${Object.entries(counts).map(([field, n]) => `${field}=${n}`).join(",")}`,
    ].join("");
    io.print(`Apply with: dataops cards ${counts ? "update" : "template-update"} ${id}${flags} --apply`);
    return { preview };
  }
  const result = await api.post(`/api/cards/${enc(id)}/template-update`, { previewToken: preview.previewToken, ...target });
  if (args.json) return result;
  const removed = preview.counts?.removed || 0;
  const added = preview.counts?.added || 0;
  io.print(counts
    ? `Applied to ${id}: ${added} Task(s) added, ${removed} removed.`
    : `Applied the Template update to ${id}.`);
  return result;
}

/** A count change preview as the operator reads it: what is added, removed and kept. */
function printCountPreview(io, preview) {
  const labels = new Map((preview.countFields || []).map((field) => [field.id, field.label]));
  for (const [field, target] of Object.entries(preview.targetCounts || {})) {
    const current = preview.currentCounts?.[field];
    io.print(`${labels.get(field) || field}: ${current} -> ${target}`);
  }
  const of = (action) => (preview.taskChanges || []).filter((change) => change.action === action);
  for (const change of of("add")) io.print(`  add     ${change.targetLabel}`);
  for (const change of of("remove")) io.print(`  remove  ${change.currentLabel} (${change.taskId})`);
  const other = (preview.taskChanges || []).filter((change) => !["add", "remove"].includes(change.action));
  if (other.length) io.print(`  ${other.length} other Template change(s) apply too; see --json.`);
  if (!of("add").length && !of("remove").length) io.print("  No Tasks are added or removed.");
}

export async function invite(args, io) {
  const usage = "dataops cards invite list <card-id>\n"
    + "  dataops cards invite remove <card-id> <event-id> [--calendar CAL] [--delete-event]";
  const action = positional(args, 0, usage);
  if (action === "add") {
    throw new UsageError("Invites are created only by setting the event time: dataops cards time <card-id> --at \"YYYY-MM-DD HH:MM\"");
  }
  if (action === "remove") {
    const id = positional(args, 1, usage);
    const eventId = positional(args, 2, usage);
    const calendar = optionalString(args, "calendar");
    const deleteEvent = args.deleteEvent === true;
    const result = await apiFor(args).delete(`/api/cards/${enc(id)}/calendar-invites`, { eventId, ...(calendar ? { calendar } : {}), ...(deleteEvent ? { deleteEvent } : {}) });
    if (args.json) return result;
    for (const removed of result.removed || []) {
      io.print(`Unlinked invite ${removed.eventId} on ${calendarLabel(removed.calendar)} from Card ${id} (${deleteEvent ? "the Google event was deleted without notifying guests" : "the Google event is untouched"}).`);
    }
    return result;
  }
  if (action === "list") {
    const id = positional(args, 1, usage);
    const api = apiFor(args);
    const result = await api.get(`/api/cards/${enc(id)}/calendar-invites`, { query: { verify: "1" } });
    const invites = Array.isArray(result?.invites) ? result.invites : [];
    if (args.json) return { invites, ...(result?.check ? { check: result.check } : {}) };
    table(
      io,
      invites,
      [
        ["EVENT ID", (invite) => invite.eventId],
        ["CALENDAR", (invite) => calendarLabel(invite.calendar)],
        ["STATE", (invite) => (invite.staleAt ? `stale (gone in Google ${invite.staleAt.slice(0, 10)})` : "live")],
        ["LABEL", (invite) => invite.label || ""],
      ],
      "No calendar invites linked.",
    );
    if (result?.check?.state === "deferred") io.print(`Not checked in Google: ${result.check.reason}`);
    return { invites };
  }
  throw new UsageError(`Unknown invite action: ${action}. ${usage}`);
}

export async function eventSlots(args, io) {
  const id = positional(args, 0, "dataops cards event-slots <card-id> [--apply]");
  const api = apiFor(args);
  const route = `/api/cards/${enc(id)}/event-slots`;
  const result = args.apply ? await api.post(route, {}) : await api.get(route);
  if (args.json) return result;
  const slots = result.eventSlots || [];
  table(
    io,
    slots,
    [
      ["SLOT", (slot) => slot.slot],
      ["TASK", (slot) => slot.taskId],
      ["STATUS", (slot) => slot.taskStatus],
      ["OUTCOME", (slot) => slot.outcome],
      ["EVENT CARD", (slot) => [slot.cardId, slot.cardTitle].filter(Boolean).join(" ")],
    ],
    "This Card has no event slots.",
  );
  if (!args.apply && slots.some((slot) => slot.outcome === "planned")) io.print("Preview only: --apply creates and links the planned event Cards.");
  if (slots.some((slot) => slot.outcome === "closed-without-card")) {
    io.print("closed-without-card: the Task was closed before event Cards existed; reopen it to give the event its Card.");
  }
  return result;
}

export async function time(args, io) {
  const id = positional(args, 0);
  if (!id) throw new UsageError('A Card id is required');
  const at = required(args, 'at', 'at');
  const body = { at };
  if (args.duration !== undefined) body.duration = integer(args.duration, 'duration');
  if (args.tz !== undefined) body.tz = optionalString(args, 'tz');
  if (args.guests !== undefined) body.guestEmails = csv(args.guests);
  const result = await apiFor(args).post(`/api/cards/${enc(id)}/time`, body);
  if (!args.json) {
    io.print(`Event: ${result.card.eventTime.startIso} .. ${result.card.eventTime.endIso} (${result.card.eventTime.timeZone})`);
    if (result.card.anchorDate) io.print(`Card date: ${result.card.anchorDate}${result.movedTasks ? ` (${result.movedTasks} open Tasks re-dated)` : ''}`);
    for (const invite of result.card.calendarInvites || []) {
      io.print(`invite: ${invite.eventId} on ${calendarLabel(invite.calendar)}${invite.staleAt ? ' STALE (gone in Google)' : ''} ${invite.url || ''}`);
    }
    if (result.taskClosure?.message) io.print(`taskClosure (${result.taskClosure.outcome}): ${result.taskClosure.message}`);
  }
  return result;
}

export const commands = {
  "dedupe-tasks": dedupeTasks,
  "event-slots": eventSlots,
  time,
  list,
  show,
  create,
  update,
  stage,
  link,
  invite,
  "sponsor-doc": createSponsorDoc,
  park,
  resume,
  delete: remove,
  "template-update": templateUpdate,
};

/** Archive duplicate manual work through the ordinary versioned skip action. */
export async function dedupeTasks(args, io) {
  if (Boolean(args.card) === Boolean(args.all)) throw new UsageError('Choose --card ID or --all.');
  if (args.apply && args.dryRun) throw new UsageError('Choose --dry-run or --apply.');
  const api = apiFor(args);
  const cards = [];
  if (args.card) {
    cards.push((await api.get(`/api/cards/${enc(args.card)}`)).card);
  } else {
    let cursor;
    do {
      const page = await api.get('/api/cards', { query: { cursor, limit: 100 } });
      cards.push(...itemsOf(page));
      cursor = page?.cards?.nextCursor;
    } while (cursor);
  }
  const pairs = [];
  const normalize = (task) => String(task.description || '').trim().toLowerCase();
  const open = (task) => task.status === 'todo' || task.status === 'waiting';
  for (const card of cards) {
    const tasks = [];
    let cursor;
    do {
      const page = await api.get('/api/tasks', { query: { cardId: card.id, cursor, limit: 100 } });
      tasks.push(...(page.tasks || []));
      cursor = page.nextCursor;
    } while (cursor);
    for (const extra of tasks.filter((task) => open(task) && !(task.templateId && task.templateTaskRef))) {
      const matches = tasks.filter((task) => open(task) && task.templateId && task.templateTaskRef
        && normalize(task) === normalize(extra));
      // Multiple template owners need an operator decision.
      if (matches.length !== 1) continue;
      const pair = { cardId: card.id, keepId: matches[0].id, extraId: extra.id };
      pairs.push(pair);
      if (args.apply) {
        // Re-read the keeper for each pair: several manual copies can share it.
        let keep = await api.get(`/api/tasks/${enc(pair.keepId)}`);
        if (!open(keep) || normalize(keep) !== normalize(extra) || !keep.templateId || !keep.templateTaskRef) {
          throw new UsageError(`Task ${pair.keepId} changed; run the preview again.`);
        }
        const marker = `Duplicate task ${extra.id}`;
        const copied = [
          ...(extra.notesLog || []).map((note) => `${note.createdAt || ''} ${note.authorId || ''}: ${note.text}`),
          extra.comment,
          extra.link ? `Link: ${extra.link}` : undefined,
        ].filter(Boolean);
        const body = { expectedVersion: keep.version };
        // A marker makes retrying a partially applied pair safe.
        if (copied.length && !(keep.notesLog || []).some((note) => note.text.startsWith(`${marker}\n`))) {
          body.comment = `${marker}\n${[...new Set(copied)].join('\n')}`;
        }
        if (extra.link && !keep.link) body.link = extra.link;
        if (Object.keys(body).length > 1) keep = await api.put(`/api/tasks/${enc(keep.id)}`, body);
        await api.post(`/api/tasks/${enc(extra.id)}/actions/skip`, {
          expectedVersion: extra.version, reason: `duplicate of ${keep.id}`,
        });
      }
    }
  }
  const result = { dryRun: !args.apply, cardsScanned: cards.length, pairs };
  if (!args.json) {
    table(io, pairs, [['CARD', (p) => p.cardId], ['KEEP', (p) => p.keepId], ['EXTRA', (p) => p.extraId]], 'No duplicate open Tasks.');
    io.print(`${args.apply ? 'Skipped' : 'Dry-run:'} ${pairs.length} duplicate pairs across ${cards.length} Cards.`);
  }
  return result;
}
