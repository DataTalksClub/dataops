import { UsageError } from "../errors.mjs";
import { enc, fields, integer, isoDate, list as csv, optionalString, positional, required, table } from "../format.mjs";
import { apiFor } from "../session.mjs";
import { findTemplate } from "./templates.mjs";

export const summary = "List, inspect, create (from a Template), and move Cards";

export const STAGES = ["preparation", "announced", "after-event"];

export const help = `dataops cards - a Card is one unit of work, created from a Template

Usage
  dataops cards list [--owner me|team|unassigned|<user-id>] [--mine] [--stage S]
      [--status active|parked|archived] [--all] [--limit N]
                                                Default: active and parked; --all adds archived
  dataops cards show <card-id>                  The Card, its links, and its Tasks
  dataops cards create --title T --date YYYY-MM-DD --template ID|TYPE|NAME
      [--optional-groups a,b] [--stage S] [--description D] [--owner ID] [--tags a,b]
  dataops cards update <card-id> [--title T] [--description D] [--date D] [--owner ID|none]
      [--tags a,b]
  dataops cards stage <card-id> <preparation|announced|after-event>
  dataops cards link <card-id> <link-name> <url>  Fill a Card link (e.g. a template's required link)
  dataops cards park <card-id> | resume <card-id>
  dataops cards delete <card-id> --yes          Delete the Card and all its Tasks (admin)
  dataops cards template-update <card-id> [--optional-groups a,b|none] [--apply]
                                                Review Template and Card option changes

--date is the Card's anchor date: Template Tasks are scheduled relative to it.
Writes read the Card's current version first (or pass --expected-version N).
Optional groups default off. Existing Cards need an explicit option decision;
--optional-groups sponsored activates sponsor work; none disables all optional work.
Template updates may also include newer definition changes; review before --apply.
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
    ["date", card.anchorDate],
    ["owner", card.owner?.name],
    ["template", card.templateId],
    ["options", card.selectedOptionalGroups],
    ["description", card.description],
    ["tags", card.tags],
    ["source docs", card.sourceDocIds],
    ["version", card.version],
  ]);
  for (const link of card.cardLinks || []) {
    io.print(`link: ${link.name || link.label} = ${link.url || "(not filled)"}`);
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
    ],
    "No Tasks.",
  );
  io.print("");
  io.print(`Docs for this Card: dataops kb related ${card.id}`);
  return result;
}

export async function create(args, io) {
  const api = apiFor(args);
  const body = {
    title: required(args, "title", "title"),
    anchorDate: isoDate(required(args, "date", "date"), "date"),
  };
  // Every Card is instantiated from a Template.
  body.templateId = (await findTemplate(api, required(args, "template", "template"))).id;
  if (args.optionalGroups !== undefined) body.optionalGroups = csv(args.optionalGroups);
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

export async function update(args, io) {
  const id = positional(args, 0, "dataops cards update <card-id> [--title T] ...");
  const body = {};
  for (const [flag, key] of [["title", "title"], ["description", "description"]]) {
    const value = optionalString(args, flag);
    if (value !== undefined) body[key] = value;
  }
  const date = isoDate(args.date, "date");
  if (date) body.anchorDate = date;
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
  return write(args, io, id, (card) => {
    const links = Array.isArray(card.cardLinks) ? card.cardLinks : [];
    if (!links.some((item) => (item.name || item.label) === name)) {
      const known = links.map((item) => item.name || item.label).join(", ") || "none";
      throw new UsageError(`Card has no link named "${name}". Known links: ${known}.`);
    }
    return { cardLinks: links.map((item) => ((item.name || item.label) === name ? { ...item, url } : item)) };
  }, `Saved "${name}" on`);
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
  const { preview } = optionalGroups === undefined
    ? await api.get(`/api/cards/${enc(id)}/template-update`)
    : await api.post(`/api/cards/${enc(id)}/template-update`, { previewOnly: true, optionalGroups });
  if (!args.apply) {
    if (args.json) return { preview };
    io.print(JSON.stringify(preview, null, 2));
    io.print("");
    io.print(`Apply with: dataops cards template-update ${id}${optionalGroups === undefined ? "" : ` --optional-groups ${optionalGroups.join(",") || "none"}`} --apply`);
    return { preview };
  }
  const result = await api.post(`/api/cards/${enc(id)}/template-update`, { previewToken: preview.previewToken, ...(optionalGroups === undefined ? {} : { optionalGroups }) });
  if (args.json) return result;
  io.print(`Applied the Template update to ${id}.`);
  return result;
}

export const commands = {
  list,
  show,
  create,
  update,
  stage,
  link,
  park,
  resume,
  delete: remove,
  "template-update": templateUpdate,
};
