import { UsageError } from "../errors.mjs";
import { enc, integer, isoDate, optionalString, positional, table, jsonData } from "../format.mjs";
import { apiFor } from "../session.mjs";
import { runLookup, runSetWait } from "../crmLookup.mjs";

export const summary = "CRM workspace: company/people directories, activity, notes, touches, saved views";

export const help = `dataops crm - bounded CRM directories, record activity, notes and saved views

Usage
  dataops crm companies list [--search Q] [--relationship R] [--tag TAG] [--active true|false|all]
      [--last-touch-after YYYY-MM-DD] [--last-touch-before YYYY-MM-DD]
      [--sort name|lastTouch] [--direction asc|desc] [--saved-view ID] [--limit N] [--cursor C]
  dataops crm people list [--search Q] [--company ID] [--tag TAG] [--primary true|false]
      [--unlinked true|false] [--active true|false|all] [--sort name|lastTouch]
      [--direction asc|desc] [--saved-view ID] [--limit N] [--cursor C]
  dataops crm deals list [--search Q] [--company ID] [--status open|agreed|lost]
      [--active true|false] [--limit N] [--cursor C]
  dataops crm pipeline list [--saved-view ID] [--view actionable|active|unscheduled|closed|all|early|overdue|reply]
      [--stage STAGE] [--owner ID] [--search Q] [--sort next-action|recent] [--limit N] [--cursor C]
      [--next-action-from YYYY-MM-DD] [--next-action-before YYYY-MM-DD]  Inclusive bounds
      Read-only pipeline rows through the canonical pipeline endpoint
  dataops crm archive <deal-id>             Read-only post-send archive for a deal (drafts/attempts)
  dataops crm lookup --email ADDRESS [--domain DOMAIN]
      Match a sender to CRM people, company and deals. Prints JSON with matched people
      (colleagues included), the organization, deals with stage/money/fulfillment,
      nextTask and recent notes, plus decision: proceed | waiting (until DATE) | skip | no_match.
  dataops crm lookup --email ADDRESS --set-wait --until YYYY-MM-DD --reason TEXT [--deal-id ID]
      Mark the deal "wait, revisit later": open Tasks go waiting until DATE (a waiting
      Task is created when the deal has none), then the fresh state is printed.
  dataops crm company show <id>
  dataops crm company create [--tags a,b] [--first-contact-at DATE] [--last-contact-at DATE] --data '{...}'      Through the canonical organization record
  dataops crm company update <id> [--tags a,b] [--first-contact-at DATE] [--last-contact-at DATE] --data '{...}'  Must include the current version
  dataops crm company archive <id>
  dataops crm company unarchive <id>
  dataops crm company delete <id> --yes [--expected-version N]  Permanently delete (admin only)
  dataops crm person show <id>
  dataops crm person create [--tags a,b] [--first-contact-at DATE] [--last-contact-at DATE] --data '{...}'      Through the canonical contact record
  dataops crm person update <id> [--tags a,b] [--first-contact-at DATE] [--last-contact-at DATE] --data '{...}'  Must include the current version
  dataops crm person archive <id>
  dataops crm person unarchive <id>
  dataops crm person delete <id> --yes [--expected-version N]   Permanently delete (admin only)
  dataops crm deal show <id>
  dataops crm deal create --data '{...}'        Through the canonical deal record
  dataops crm deal update <id> --data '{...}'    Must include the current version
  dataops crm deal archive <id>
  dataops crm deal unarchive <id>
  dataops crm activity <organization|contact|deal> <id> [--types note,touch,mail,history,deal-history]
      [--limit N] [--cursor C]
  dataops crm notes list <organization|contact|deal> <id> [--limit N] [--cursor C]
  dataops crm note add <organization|contact|deal> <id> --body TEXT [--source-key KEY]
  dataops crm note show <organization|contact|deal> <id> <note-id>
  dataops crm note update <organization|contact|deal> <id> <note-id> --body TEXT [--version N]
  dataops crm note delete <organization|contact|deal> <id> <note-id>
  dataops crm touch <organization|contact> <id> --channel email|call|meeting|linkedin|other
      [--note TEXT] [--date YYYY-MM-DD]
  dataops crm views list [--entity companies|people|pipeline] [--all]
  dataops crm views show <id>               A view with server-resolved filters
  dataops crm views create --data '{...}'
  dataops crm views update <id> --data '{...}'  Must include the current version
  dataops crm views archive <id>                Archive affects view metadata only
  dataops crm views unarchive <id>

Directories return summaries only (no finance, mail or note bodies per row).
Notes are attributed to you; update/delete notes with version check; retry safely with --source-key.
Views are personal: builtins are read-only, yours are versioned, archive keeps the record.
Hard delete refuses deals, linked contacts, notes and human touches; delete people before their company.
Hard-delete errors: exit 4 = not found; exit 5 = guard/version conflict (reason in error).

Examples
  dataops crm companies list --json | jq '.items[] | {displayName, relationship}'
  dataops crm activity contact abc123 --types note,touch,mail
  dataops crm note add organization abc123 --body "Called; send deck next week" --source-key call-2026-10-17
  dataops crm touch contact abc123 --channel email --note "Sent deck"
  dataops crm lookup --email angela@meritmap.ai --json | jq .decision
`;

const TARGETS = ["organization", "contact", "deal"];

function targetOf(args, index = 0) {
  const rawTarget = positional(args, index, `dataops crm <activity|notes|note> <${TARGETS.join("|")}> <id>`);
  const target = rawTarget === "company" ? "organization" : rawTarget === "person" ? "contact" : rawTarget;
  if (!TARGETS.includes(target)) throw new UsageError(`Target must be one of: ${TARGETS.join(", ")}, company, person (not "${rawTarget}").`);
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
    ["tag", "tag"],
    ["sort", "sort"], ["direction", "direction"], ["types", "types"],
    ["view", "view"], ["stage", "stage"], ["owner", "owner"],
    ["status", "status"],
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
    ["TAGS", (item) => (item.tags || []).join(", ")],
    ["PERSON", (item) => item.primaryPerson?.name || "—"],
    ["LAST TOUCH", (item) => String(item.lastTouch || "—").slice(0, 10)],
    ["DEALS", (item) => String(item.openDealCount ?? 0)],
  ], "No companies.");
  if (result.nextCursor) io.print(`More: --cursor ${result.nextCursor} (total ${result.total}).`);
  return pagedResult(result);
}

export async function companyShow(args, io) {
  const id = positional(args, 0, "dataops crm company show <id>");
  const result = await apiFor(args).get(`/api/sponsor-crm/directory/companies/${enc(id)}`);
  if (!args.json) io.print(JSON.stringify(result, null, 2));
  return result;
}

export async function companyCreate(args, io) {
  const payload = { ...(args.data !== undefined ? jsonData(args) : {}) };
  if (args.tags !== undefined) {
    payload.tags = typeof args.tags === "string" ? args.tags.split(",").map((t) => t.trim()).filter(Boolean) : args.tags;
  }
  const firstContactAt = args.firstContactAt ?? args.first_contact_at;
  if (firstContactAt !== undefined) payload.first_contact_at = firstContactAt;
  const lastContactAt = args.lastContactAt ?? args.last_contact_at;
  if (lastContactAt !== undefined) payload.last_contact_at = lastContactAt;
  if (Object.keys(payload).length === 0) {
    throw new UsageError("Pass --data '{...}' or flags like --tags, --first-contact-at, --last-contact-at.");
  }
  const result = await apiFor(args).post("/api/sponsor-crm/organizations", payload);
  if (!args.json) io.print(`Created company ${result?.id || ""}.`.replace(" .", "."));
  return result;
}

export async function companyUpdate(args, io) {
  const id = positional(args, 0, "dataops crm company update <id> [--tags a,b] [--first-contact-at DATE] [--last-contact-at DATE] --data '{...}'");
  const payload = { ...(args.data !== undefined ? jsonData(args) : {}) };
  if (args.tags !== undefined) {
    payload.tags = typeof args.tags === "string" ? args.tags.split(",").map((t) => t.trim()).filter(Boolean) : args.tags;
  }
  const firstContactAt = args.firstContactAt ?? args.first_contact_at;
  if (firstContactAt !== undefined) payload.first_contact_at = firstContactAt;
  const lastContactAt = args.lastContactAt ?? args.last_contact_at;
  if (lastContactAt !== undefined) payload.last_contact_at = lastContactAt;
  if (Object.keys(payload).length === 0) {
    throw new UsageError("Pass --data '{...}' or flags like --tags, --first-contact-at, --last-contact-at.");
  }
  const result = await apiFor(args).put(`/api/sponsor-crm/organizations/${enc(id)}`, payload);
  if (!args.json) io.print(`Updated company ${id}.`);
  return result;
}

export async function companyArchive(args, io) {
  const id = positional(args, 0, "dataops crm company archive <id>");
  const result = await apiFor(args).delete(`/api/sponsor-crm/organizations/${enc(id)}`);
  if (!args.json) io.print(`Archived company ${id}.`);
  return result;
}

export async function companyUnarchive(args, io) {
  const id = positional(args, 0, "dataops crm company unarchive <id>");
  const result = await apiFor(args).post(`/api/sponsor-crm/organizations/${enc(id)}/unarchive`);
  if (!args.json) io.print(`Unarchived company ${id}.`);
  return result;
}

export async function peopleList(args, io) {
  const api = apiFor(args);
  const result = await api.get("/api/sponsor-crm/directory/people", { query: await directoryQuery(api, args, "people") });
  if (args.json) return result;
  table(io, result.items || [], [
    ["NAME", (item) => item.name || ""],
    ["COMPANY", (item) => item.companyName || "—"],
    ["TAGS", (item) => (item.tags || []).join(", ")],
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
  const payload = { ...(args.data !== undefined ? jsonData(args) : {}) };
  if (args.tags !== undefined) {
    payload.tags = typeof args.tags === "string" ? args.tags.split(",").map((t) => t.trim()).filter(Boolean) : args.tags;
  }
  const firstContactAt = args.firstContactAt ?? args.first_contact_at;
  if (firstContactAt !== undefined) payload.first_contact_at = firstContactAt;
  const lastContactAt = args.lastContactAt ?? args.last_contact_at;
  if (lastContactAt !== undefined) payload.last_contact_at = lastContactAt;
  if (Object.keys(payload).length === 0) {
    throw new UsageError("Pass --data '{...}' or flags like --tags, --first-contact-at, --last-contact-at.");
  }
  const result = await apiFor(args).post("/api/sponsor-crm/contacts", payload);
  if (!args.json) io.print(`Created person ${result?.id || ""}.`.replace(" .", "."));
  return result;
}

export async function personUpdate(args, io) {
  const id = positional(args, 0, "dataops crm person update <id> [--tags a,b] [--first-contact-at DATE] [--last-contact-at DATE] --data '{...}'");
  const payload = { ...(args.data !== undefined ? jsonData(args) : {}) };
  if (args.tags !== undefined) {
    payload.tags = typeof args.tags === "string" ? args.tags.split(",").map((t) => t.trim()).filter(Boolean) : args.tags;
  }
  const firstContactAt = args.firstContactAt ?? args.first_contact_at;
  if (firstContactAt !== undefined) payload.first_contact_at = firstContactAt;
  const lastContactAt = args.lastContactAt ?? args.last_contact_at;
  if (lastContactAt !== undefined) payload.last_contact_at = lastContactAt;
  if (Object.keys(payload).length === 0) {
    throw new UsageError("Pass --data '{...}' or flags like --tags, --first-contact-at, --last-contact-at.");
  }
  const result = await apiFor(args).put(`/api/sponsor-crm/contacts/${enc(id)}`, payload);
  if (!args.json) io.print(`Updated person ${id}.`);
  return result;
}

export async function personArchive(args, io) {
  const id = positional(args, 0, "dataops crm person archive <id>");
  const result = await apiFor(args).delete(`/api/sponsor-crm/contacts/${enc(id)}`);
  if (!args.json) io.print(`Archived person ${id}.`);
  return result;
}

export async function personUnarchive(args, io) {
  const id = positional(args, 0, "dataops crm person unarchive <id>");
  const result = await apiFor(args).post(`/api/sponsor-crm/contacts/${enc(id)}/unarchive`);
  if (!args.json) io.print(`Unarchived person ${id}.`);
  return result;
}

async function deleteDirectoryRecord(args, io, entity, plural) {
  const id = positional(args, 0, `dataops crm ${entity} delete <id> --yes [--expected-version N]`);
  if (args.yes !== true) throw new UsageError('Permanent deletion requires --yes. Read the record before deleting it.');
  const expectedVersion = integer(optionalString(args, 'expectedVersion'), 'expected-version');
  if (expectedVersion !== undefined && !Number.isSafeInteger(expectedVersion)) throw new UsageError('expected-version must be a safe positive integer.');
  const result = await apiFor(args).delete(`/api/sponsor-crm/${plural}/${enc(id)}`, undefined, {
    query: { hard: 'true', expectedVersion },
  });
  if (!args.json) io.print(`Deleted ${entity} ${id}.`);
  return result;
}

export const companyDelete = (args, io) => deleteDirectoryRecord(args, io, 'company', 'organizations');
export const personDelete = (args, io) => deleteDirectoryRecord(args, io, 'person', 'contacts');

export async function dealShow(args, io) {
  const id = positional(args, 0, "dataops crm deal show <id>");
  const result = await apiFor(args).get(`/api/sponsor-crm/deals/${enc(id)}`);
  if (!args.json) io.print(JSON.stringify(result, null, 2));
  return result;
}

export async function dealCreate(args, io) {
  const result = await apiFor(args).post("/api/sponsor-crm/deals", jsonData(args));
  if (!args.json) io.print(`Created deal ${result?.id || ""}.`.replace(" .", "."));
  return result;
}

export async function dealUpdate(args, io) {
  const id = positional(args, 0, "dataops crm deal update <id> --data '{...}'");
  const result = await apiFor(args).put(`/api/sponsor-crm/deals/${enc(id)}`, jsonData(args));
  if (!args.json) io.print(`Updated deal ${id}.`);
  return result;
}

export async function dealArchive(args, io) {
  const id = positional(args, 0, "dataops crm deal archive <id>");
  const result = await apiFor(args).delete(`/api/sponsor-crm/deals/${enc(id)}`);
  if (!args.json) io.print(`Archived deal ${id}.`);
  return result;
}

export async function dealUnarchive(args, io) {
  const id = positional(args, 0, "dataops crm deal unarchive <id>");
  const result = await apiFor(args).post(`/api/sponsor-crm/deals/${enc(id)}/unarchive`);
  if (!args.json) io.print(`Unarchived deal ${id}.`);
  return result;
}

export async function dealsList(args, io) {
  const api = apiFor(args);
  const query = queryArgs(args);
  if (args.company !== undefined) {
    query.organizationId = args.company;
    delete query.company;
  }
  const result = await api.get("/api/sponsor-crm/deals", { query });
  if (args.json) return result;
  table(io, result.items || [], [
    ["ID", (item) => item.id || ""],
    ["TITLE", (item) => item.title || "—"],
    ["COMPANY", (item) => item.organizationId || ""],
    ["STATUS", (item) => item.status || ""],
    ["MONEY", (item) => item.money || "none"],
  ], "No deals.");
  if (result.nextCursor) io.print(`More: --cursor ${result.nextCursor}.`);
  return pagedResult(result);
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

export async function noteShow(args, io) {
  const target = targetOf(args);
  const id = idOf(args);
  const noteId = positional(args, 2, "Note id is required.");
  const result = await apiFor(args).get(`/api/sponsor-crm/notes/${target}/${enc(id)}/${enc(noteId)}`);
  if (!args.json) {
    io.print(`Note ${result.id} (${result.authorId || "unknown"}, ${String(result.createdAt || "").slice(0, 10)}):\n${result.body}`);
  }
  return result;
}

export async function noteUpdate(args, io) {
  const target = targetOf(args);
  const id = idOf(args);
  const noteId = positional(args, 2, "Note id is required.");
  const body = optionalString(args, "body");
  if (!body) throw new UsageError("--body is required.");
  const ver = integer(args.version, "version");
  const payload = { body, ...(ver !== undefined ? { version: ver } : {}) };
  const result = await apiFor(args).put(`/api/sponsor-crm/notes/${target}/${enc(id)}/${enc(noteId)}`, payload);
  if (!args.json) io.print(`Updated note ${noteId} on ${target} ${id}.`);
  return result;
}

export async function noteDelete(args, io) {
  const target = targetOf(args);
  const id = idOf(args);
  const noteId = positional(args, 2, "Note id is required.");
  const result = await apiFor(args).delete(`/api/sponsor-crm/notes/${target}/${enc(id)}/${enc(noteId)}`);
  if (!args.json) io.print(`Deleted note ${noteId} from ${target} ${id}.`);
  return result;
}

const TOUCH_CHANNELS = ["email", "call", "meeting", "linkedin", "other"];

export async function touch(args, io) {
  let rest = args._;
  if (rest[0] === "add" || rest[0] === "log") rest = rest.slice(1);
  const usage = "dataops crm touch <organization|contact> <id> --channel email|call|meeting|linkedin|other [--note TEXT] [--date YYYY-MM-DD]";
  const rawTarget = positional({ ...args, _: rest }, 0, usage);
  const target = rawTarget === "company" ? "organization" : rawTarget === "person" ? "contact" : rawTarget;
  if (!["organization", "contact"].includes(target)) {
    throw new UsageError(`Target must be "organization" or "contact", not "${rawTarget}".`);
  }
  const id = positional({ ...args, _: rest }, 1, usage);
  const channel = optionalString(args, "channel");
  if (!channel) throw new UsageError("--channel is required (email, call, meeting, linkedin, other).");
  if (!TOUCH_CHANNELS.includes(channel)) {
    throw new UsageError(`--channel must be one of: ${TOUCH_CHANNELS.join(", ")}.`);
  }
  const note = optionalString(args, "note");
  const date = isoDate(optionalString(args, "date"), "date");
  const result = await apiFor(args).post("/api/sponsor-crm/touches", {
    targetType: target,
    targetId: id,
    channel,
    ...(note !== undefined ? { note } : {}),
    ...(date !== undefined ? { touchedAt: date } : {}),
  });
  if (!args.json) {
    io.print(`Logged ${channel} touch for ${target} ${id}${date ? ` on ${date}` : ""}.`);
  }
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

export async function viewsUnarchive(args, io) {
  const id = positional(args, 0, "dataops crm views unarchive <id>");
  const result = await apiFor(args).post(`/api/sponsor-crm/views/${enc(id)}/unarchive`);
  if (!args.json) io.print(`Unarchived view ${id}.`);
  return result;
}

export async function viewsShow(args, io) {
  const id = positional(args, 0, "dataops crm views show <id>");
  const result = await apiFor(args).get(`/api/sponsor-crm/views/${enc(id)}`);
  if (!args.json) io.print(JSON.stringify(result, null, 2));
  return result;
}

export async function lookup(args, io) {
  const api = apiFor(args);
  const email = optionalString(args, "email");
  const domain = optionalString(args, "domain");
  if (!email && !domain) throw new UsageError("Pass --email ADDRESS or --domain DOMAIN.");
  if (email && !email.includes("@")) throw new UsageError(`--email must be a full address like name@company.com (got "${email}").`);
  let result;
  if (args.setWait) {
    const setWait = await runSetWait(api, { email, domain, until: args.until, reason: args.reason, dealId: args.dealId });
    result = { ...(await runLookup(api, { email, domain })), setWait };
  } else {
    result = await runLookup(api, { email, domain });
  }
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
  company: (args, io) => dispatch(args, io,
    { show: companyShow, create: companyCreate, update: companyUpdate, archive: companyArchive, unarchive: companyUnarchive, delete: companyDelete },
    "dataops crm company <show|create|update|archive|unarchive|delete> [...]"),
  people: (args, io) => dispatch(args, io, { list: peopleList }, "dataops crm people list [...]"),
  person: (args, io) => dispatch(args, io,
    { show: personShow, create: personCreate, update: personUpdate, archive: personArchive, unarchive: personUnarchive, delete: personDelete },
    "dataops crm person <show|create|update|archive|unarchive|delete> [...]"),
  deals: (args, io) => dispatch(args, io, { list: dealsList }, "dataops crm deals list [...]"),
  deal: (args, io) => dispatch(args, io,
    { show: dealShow, create: dealCreate, update: dealUpdate, archive: dealArchive, unarchive: dealUnarchive },
    "dataops crm deal <show|create|update|archive|unarchive> [...]"),
  pipeline: (args, io) => dispatch(args, io, { list: pipelineList }, "dataops crm pipeline list [...]"),
  archive,
  lookup,
  activity,
  notes: (args, io) => dispatch(args, io, { list: notesList }, "dataops crm notes list <target> <id> [...]"),
  note: (args, io) => dispatch(args, io,
    { add: noteAdd, show: noteShow, update: noteUpdate, edit: noteUpdate, delete: noteDelete, remove: noteDelete },
    "dataops crm note <add|show|update|delete> <target> <id> [...]"),
  touch,
  touches: touch,
  views: (args, io) => dispatch(args, io,
    { list: viewsList, show: viewsShow, create: viewsCreate, update: viewsUpdate, archive: viewsArchive, unarchive: viewsUnarchive },
    "dataops crm views <list|show|create|update|archive|unarchive> [...]"),
};
