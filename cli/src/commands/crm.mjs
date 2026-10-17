import { UsageError } from "../errors.mjs";
import { enc, integer, optionalString, positional, table, jsonData } from "../format.mjs";
import { apiFor } from "../session.mjs";

export const summary = "CRM workspace: company/people directories, activity, notes, saved views";

export const help = `dataops crm - bounded CRM directories, record activity, notes and saved views

Usage
  dataops crm companies list [--search Q] [--relationship R] [--active true|false|all]
      [--last-touch-after YYYY-MM-DD] [--last-touch-before YYYY-MM-DD]
      [--sort name|lastTouch] [--direction asc|desc] [--saved-view ID] [--limit N] [--cursor C]
  dataops crm people list [--search Q] [--company ID] [--primary true|false]
      [--unlinked true|false] [--active true|false|all] [--sort name|lastTouch]
      [--direction asc|desc] [--saved-view ID] [--limit N] [--cursor C]
  dataops crm pipeline list [--saved-view ID] [--view actionable|active|unscheduled|closed|all|early|overdue|reply]
      [--stage STAGE] [--owner ID] [--search Q] [--sort next-action|recent] [--limit N] [--cursor C]
      [--next-action-from YYYY-MM-DD] [--next-action-before YYYY-MM-DD]  Inclusive bounds
      Read-only pipeline rows through the canonical pipeline endpoint
  dataops crm archive <deal-id>             Read-only post-send archive for a deal (drafts/attempts)
  dataops crm person show <id>
  dataops crm person create --data '{...}'      Through the canonical contact record
  dataops crm person update <id> --data '{...}'  Must include the current version
  dataops crm activity <organization|contact|deal> <id> [--types note,touch,mail,history,deal-history]
      [--limit N] [--cursor C]
  dataops crm notes list <organization|contact|deal> <id> [--limit N] [--cursor C]
  dataops crm note add <organization|contact|deal> <id> --body TEXT [--source-key KEY]
  dataops crm views list [--entity companies|people|pipeline] [--all]
  dataops crm views show <id>               A view with server-resolved filters
  dataops crm views create --data '{...}'
  dataops crm views update <id> --data '{...}'  Must include the current version
  dataops crm views archive <id>                Archive affects view metadata only

Directories return summaries only (no finance, mail or note bodies per row).
Notes are append-only and attributed to you; retry safely with --source-key.
Views are personal: builtins are read-only, yours are versioned, archive keeps the record.

Examples
  dataops crm companies list --json | jq '.items[] | {displayName, relationship}'
  dataops crm activity contact abc123 --types note,touch,mail
  dataops crm note add organization abc123 --body "Called; send deck next week" --source-key call-2026-10-17
`;

const TARGETS = ["organization", "contact", "deal"];

function targetOf(args, index = 0) {
  const target = positional(args, index, `dataops crm <activity|notes|note> <${TARGETS.join("|")}> <id>`);
  if (!TARGETS.includes(target)) throw new UsageError(`Target must be one of: ${TARGETS.join(", ")}.`);
  return target;
}

function idOf(args, index = 1) {
  return positional(args, index, "Record id is required.");
}

function queryArgs(args) {
  const query = {};
  for (const [option, param] of [
    ["search", "search"], ["relationship", "relationship"], ["active", "active"],
    ["company", "company"], ["primary", "primary"], ["unlinked", "unlinked"],
    ["sort", "sort"], ["direction", "direction"], ["types", "types"],
    ["view", "view"], ["stage", "stage"], ["owner", "owner"],
    ["nextActionFrom", "nextActionFrom"], ["nextActionBefore", "nextActionBefore"],
    ["lastTouchAfter", "lastTouchAfter"], ["lastTouchBefore", "lastTouchBefore"],
  ]) {
    const value = optionalString(args, option);
    if (value !== undefined) query[param] = value;
  }
  const limit = integer(args.limit, "limit");
  if (limit !== undefined) query.limit = String(limit);
  const cursor = optionalString(args, "cursor");
  if (cursor !== undefined) query.cursor = cursor;
  return query;
}

function pagedResult(payload, emptyLabel) {
  return { items: Array.isArray(payload?.items) ? payload.items : [], total: payload?.total ?? 0, nextCursor: payload?.nextCursor ?? null, emptyLabel };
}

/**
 * Execute a saved view: fetch it (server-resolved filters), then run the
 * directory with explicit flags winning. One resolver — the server's.
 */
async function directoryQuery(api, args, entity) {
  const query = queryArgs(args);
  const savedView = optionalString(args, "savedView");
  if (savedView === undefined) return query;
  const view = await api.get(`/api/sponsor-crm/views/${enc(savedView)}`);
  if (view?.entity !== entity) throw new UsageError(`Saved view ${savedView} is for ${view?.entity || "unknown"}, not ${entity}.`);
  const resolved = view?.resolvedFilters || {};
  const viewSort = view?.sort || {};
  return {
    ...resolved,
    ...(viewSort.field ? { sort: viewSort.field } : {}),
    ...(viewSort.direction ? { direction: viewSort.direction } : {}),
    ...query,
  };
}

export async function companiesList(args, io) {
  const api = apiFor(args);
  const result = await api.get("/api/sponsor-crm/directory/companies", { query: await directoryQuery(api, args, "companies") });
  if (args.json) return result;
  table(io, result.items || [], [
    ["NAME", (item) => item.displayName || ""],
    ["REL", (item) => item.relationship || ""],
    ["PERSON", (item) => item.primaryPerson?.name || "—"],
    ["LAST TOUCH", (item) => String(item.lastTouch || "—").slice(0, 10)],
    ["DEALS", (item) => String(item.openDealCount ?? 0)],
  ], "No companies.");
  if (result.nextCursor) io.print(`More: --cursor ${result.nextCursor} (total ${result.total}).`);
  return pagedResult(result);
}

export async function peopleList(args, io) {
  const api = apiFor(args);
  const result = await api.get("/api/sponsor-crm/directory/people", { query: await directoryQuery(api, args, "people") });
  if (args.json) return result;
  table(io, result.items || [], [
    ["NAME", (item) => item.name || ""],
    ["COMPANY", (item) => item.companyName || "—"],
    ["ROLE", (item) => item.role || ""],
    ["PRIMARY", (item) => (item.primary ? "yes" : "")],
    ["LAST TOUCH", (item) => String(item.lastTouch || "—").slice(0, 10)],
  ], "No people.");
  if (result.nextCursor) io.print(`More: --cursor ${result.nextCursor} (total ${result.total}).`);
  return pagedResult(result);
}

export async function personShow(args, io) {
  const id = positional(args, 0, "dataops crm person show <id>");
  const result = await apiFor(args).get(`/api/sponsor-crm/contacts/${enc(id)}`);
  if (!args.json) io.print(JSON.stringify(result, null, 2));
  return result;
}

export async function personCreate(args, io) {
  const result = await apiFor(args).post("/api/sponsor-crm/contacts", jsonData(args));
  if (!args.json) io.print(`Created person ${result?.id || ""}.`.replace(" .", "."));
  return result;
}

export async function personUpdate(args, io) {
  const id = positional(args, 0, "dataops crm person update <id> --data '{...}'");
  const result = await apiFor(args).put(`/api/sponsor-crm/contacts/${enc(id)}`, jsonData(args));
  if (!args.json) io.print(`Updated person ${id}.`);
  return result;
}

export async function pipelineList(args, io) {
  const api = apiFor(args);
  const savedView = optionalString(args, "savedView");
  let query = queryArgs(args);
  if (savedView !== undefined) {
    const view = await api.get(`/api/sponsor-crm/views/${enc(savedView)}`);
    if (view?.entity !== "pipeline") throw new UsageError(`Saved view ${savedView} is for ${view?.entity || "unknown"}, not pipeline.`);
    const viewSort = view?.sort || {};
    query = { ...(view?.resolvedFilters || {}), ...(viewSort.field ? { sort: viewSort.field } : {}), ...query };
  }
  const result = await api.get("/api/sponsor-crm/pipeline", { query });
  if (args.json) return result;
  table(io, result.items || result.rows || [], [
    ["COMPANY", (item) => item.organizationName || ""],
    ["STAGE", (item) => item.stage || ""],
    ["NEXT", (item) => item.nextTask?.description || ""],
    ["OWNER", (item) => item.nextTask?.assigneeId || ""],
  ], "No pipeline rows.");
  return result;
}

export async function archive(args, io) {
  const id = positional(args, 0, "dataops crm archive <deal-id>");
  const result = await apiFor(args).get(`/api/sponsor-crm/deals/${enc(id)}/communications`);
  if (!args.json) io.print(JSON.stringify(result, null, 2));
  return result;
}

export async function activity(args, io) {
  const target = targetOf(args);
  const id = idOf(args);
  const result = await apiFor(args).get(`/api/sponsor-crm/activity/${target}/${enc(id)}`, { query: queryArgs(args) });
  if (args.json) return result;
  table(io, result.items || [], [
    ["DATE", (item) => String(item.ts || "").slice(0, 10)],
    ["SOURCE", (item) => item.source || ""],
    ["TEXT", (item) => String(item.text || "").slice(0, 80)],
  ], "No activity.");
  if ((result.relatedWork || []).length) {
    table(io, result.relatedWork, [
      ["DUE", (item) => String(item.effectiveDate || item.date || "").slice(0, 10)],
      ["STATUS", (item) => `${item.status || ""}${item.deferred ? " deferred" : ""}`],
      ["NEXT ACTION", (item) => item.description || ""],
    ]);
  }
  for (const work of result.relatedWork || []) {
    // Human output follows effective/deferred dates, never the raw original date.
    const when = work.effectiveDate || work.date || "";
    const deferred = work.deferred ? ` (deferred${work.deferredUntil ? ` until ${String(work.deferredUntil).slice(0, 10)}` : ""})` : "";
    io.print(`Open ${work.status} ${when}: ${work.description}${deferred} [${work.scope}]`);
  }
  if (result.nextCursor) io.print(`More: --cursor ${result.nextCursor} (total ${result.total}).`);
  return result;
}

export async function notesList(args, io) {
  const target = targetOf(args);
  const id = idOf(args);
  const result = await apiFor(args).get(`/api/sponsor-crm/notes/${target}/${enc(id)}`, { query: queryArgs(args) });
  if (args.json) return result;
  table(io, result.items || [], [
    ["DATE", (item) => String(item.createdAt || "").slice(0, 10)],
    ["AUTHOR", (item) => item.authorId || ""],
    ["BODY", (item) => String(item.body || "").slice(0, 80)],
  ], "No notes.");
  if (result.nextCursor) io.print(`More: --cursor ${result.nextCursor} (total ${result.total}).`);
  return pagedResult(result);
}

export async function noteAdd(args, io) {
  const target = targetOf(args);
  const id = idOf(args);
  const body = optionalString(args, "body");
  if (!body) throw new UsageError("--body is required.");
  const sourceKey = optionalString(args, "sourceKey");
  const result = await apiFor(args).post(`/api/sponsor-crm/notes/${target}/${enc(id)}`, {
    body,
    ...(sourceKey !== undefined ? { sourceKey } : {}),
  });
  if (!args.json) io.print(`Added note ${result?.id || ""}.`.replace(" .", "."));
  return result;
}

export async function viewsList(args, io) {
  const query = {};
  const entity = optionalString(args, "entity");
  if (entity !== undefined) query.entity = entity;
  if (args.all) query.includeArchived = "true";
  const result = await apiFor(args).get("/api/sponsor-crm/views", { query });
  if (args.json) return result;
  table(io, result.items || [], [
    ["NAME", (item) => item.name || ""],
    ["ENTITY", (item) => item.entity || ""],
    ["BUILTIN", (item) => (item.builtin ? "yes" : "")],
    ["ARCHIVED", (item) => (item.archivedAt ? "yes" : "")],
  ], "No saved views.");
  return result;
}

export async function viewsCreate(args, io) {
  const result = await apiFor(args).post("/api/sponsor-crm/views", jsonData(args));
  if (!args.json) io.print(`Created view ${result?.id || ""}.`.replace(" .", "."));
  return result;
}

export async function viewsUpdate(args, io) {
  const id = positional(args, 0, "dataops crm views update <id> --data '{...}'");
  const result = await apiFor(args).put(`/api/sponsor-crm/views/${enc(id)}`, jsonData(args));
  if (!args.json) io.print(`Updated view ${id}.`);
  return result;
}

export async function viewsArchive(args, io) {
  const id = positional(args, 0, "dataops crm views archive <id>");
  const result = await apiFor(args).delete(`/api/sponsor-crm/views/${enc(id)}`);
  if (!args.json) io.print(`Archived view ${id}.`);
  return result;
}

export async function viewsShow(args, io) {
  const id = positional(args, 0, "dataops crm views show <id>");
  const result = await apiFor(args).get(`/api/sponsor-crm/views/${enc(id)}`);
  if (!args.json) io.print(JSON.stringify(result, null, 2));
  return result;
}

async function dispatch(args, io, verbs, usage) {
  const [verb, ...rest] = args._;
  const handler = verbs[verb];
  if (!handler) throw new UsageError(`Usage: ${usage} One of: ${Object.keys(verbs).join(", ")}.`);
  return handler({ ...args, _: rest }, io);
}

export const commands = {
  companies: (args, io) => dispatch(args, io, { list: companiesList }, "dataops crm companies list [...]"),
  people: (args, io) => dispatch(args, io, { list: peopleList }, "dataops crm people list [...]"),
  person: (args, io) => dispatch(args, io,
    { show: personShow, create: personCreate, update: personUpdate },
    "dataops crm person <show|create|update> [...]"),
  pipeline: (args, io) => dispatch(args, io, { list: pipelineList }, "dataops crm pipeline list [...]"),
  archive,
  activity,
  notes: (args, io) => dispatch(args, io, { list: notesList }, "dataops crm notes list <target> <id> [...]"),
  note: (args, io) => dispatch(args, io, { add: noteAdd }, "dataops crm note add <target> <id> --body TEXT [...]"),
  views: (args, io) => dispatch(args, io,
    { list: viewsList, show: viewsShow, create: viewsCreate, update: viewsUpdate, archive: viewsArchive },
    "dataops crm views <list|show|create|update|archive> [...]"),
};
