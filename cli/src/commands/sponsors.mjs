import { UsageError } from "../errors.mjs";
import { enc, integer, jsonData, optionalString, positional, table } from "../format.mjs";
import { apiFor } from "../session.mjs";

export const summary = "Sponsor CRM: queue, organizations, contacts, deals, deliverables, leads, finance";

const KINDS = ["organizations", "contacts", "deals", "deliverables", "invoices", "leads", "newsletters"];

export const help = `dataops sponsors - the sponsor CRM (the web Finance > Sponsors views)

Usage
  dataops sponsors queue                               What needs attention
  dataops sponsors list <kind> [--limit N]             kind: ${KINDS.join(", ")}
  dataops sponsors show <kind> <id>
  dataops sponsors create <kind> --data '{...}'        Fields as the web form sends them
  dataops sponsors update <kind> <id> --data '{...}'
  dataops sponsors update leads <id> --data '{"status":"ignored","version":N}' [--reason TEXT]
  dataops sponsors messages <organization-id>          Communications with an organization
  dataops sponsors history <deal-id>                   A deal's change history
  dataops sponsors finance <deal-id> [history|candidates/invoices|candidates/payments]

--data takes a JSON object, @file.json, or - for stdin. The API validates every field
exactly as it does for the web; a 400/422 names what is wrong. Use --json to see the
current record shape before writing one.

Examples
  dataops sponsors list deals --json | jq '.items[] | {id, status}'
  dataops sponsors update deals 1f2e... --data '{"status":"won","version":3}'
  dataops sponsors update leads 9a8b... --data '{"status":"ignored","version":1}' --reason "House ad"

--reason (leads only) says why the lead has its status; a status change without one
clears the previous reason.
`;

function kindOf(args, index = 0) {
  const kind = positional(args, index, `dataops sponsors <list|show> <${KINDS.join("|")}>`);
  if (!KINDS.includes(kind)) throw new UsageError(`Unknown kind "${kind}". One of: ${KINDS.join(", ")}.`);
  return kind;
}

function itemsOf(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ["items", "organizations", "contacts", "deals", "deliverables", "invoices", "leads", "newsletters"]) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}

function label(item) {
  return item.name || item.title || item.organizationName || item.email || item.subject || item.campaignLabel || "";
}

export async function queue(args, io) {
  const result = await apiFor(args).get("/api/sponsor-crm/queue");
  if (args.json) return result;
  table(io, itemsOf(result), [
    ["ID", (item) => item.id],
    ["KIND", (item) => item.kind || item.type || ""],
    ["STATUS", (item) => item.status || ""],
    ["ITEM", (item) => label(item) || item.reason || ""],
  ], "Nothing in the sponsor queue.");
  return result;
}

export async function list(args, io) {
  const kind = kindOf(args);
  const api = apiFor(args);
  const max = integer(args.limit, "limit") ?? 200;
  const items = [];
  let cursor;
  let last;
  do {
    last = await api.get(`/api/sponsor-crm/${kind}`, { query: { cursor } });
    items.push(...itemsOf(last));
    cursor = last?.nextCursor;
  } while (cursor && items.length < max);
  const result = { kind, items: items.slice(0, max) };
  if (args.json) return result;
  table(io, result.items, [
    ["ID", (item) => item.id],
    ["STATUS", (item) => item.status || item.stage || ""],
    ["NAME", label],
  ], `No ${kind}.`);
  return result;
}

export async function show(args, io) {
  const kind = kindOf(args);
  const id = positional(args, 1, "dataops sponsors show <kind> <id>");
  const result = await apiFor(args).get(`/api/sponsor-crm/${kind}/${enc(id)}`);
  if (!args.json) io.print(JSON.stringify(result, null, 2));
  return result;
}

export async function create(args, io) {
  const kind = kindOf(args);
  const result = await apiFor(args).post(`/api/sponsor-crm/${kind}`, jsonData(args));
  if (!args.json) io.print(`Created ${kind.replace(/s$/, "")} ${result?.id || result?.item?.id || ""}.`.replace(" .", "."));
  return result;
}

export async function update(args, io) {
  const kind = kindOf(args);
  const id = positional(args, 1, "dataops sponsors update <kind> <id> --data '{...}'");
  const verb = kind === "leads" ? "patch" : "put";
  const data = jsonData(args);
  const reason = optionalString(args, "reason");
  if (reason !== undefined) {
    if (kind !== "leads") throw new UsageError("--reason applies to leads only.");
    data.statusReason = reason;
  }
  const result = await apiFor(args)[verb](`/api/sponsor-crm/${kind}/${enc(id)}`, data);
  if (!args.json) io.print(`Updated ${kind.replace(/s$/, "")} ${id}.`);
  return result;
}

export async function messages(args, io) {
  const id = positional(args, 0, "dataops sponsors messages <organization-id>");
  const result = await apiFor(args).get(`/api/sponsor-crm/organizations/${enc(id)}/messages`);
  if (!args.json) io.print(JSON.stringify(result, null, 2));
  return result;
}

export async function history(args, io) {
  const id = positional(args, 0, "dataops sponsors history <deal-id>");
  const result = await apiFor(args).get(`/api/sponsor-crm/deals/${enc(id)}/history`);
  if (!args.json) io.print(JSON.stringify(result, null, 2));
  return result;
}

export async function finance(args, io) {
  const id = positional(args, 0, "dataops sponsors finance <deal-id> [view]");
  const view = optionalString({ view: args._[1] }, "view");
  const result = await apiFor(args).get(`/api/sponsor-crm/deals/${enc(id)}/finance${view ? `/${view}` : ""}`);
  if (!args.json) io.print(JSON.stringify(result, null, 2));
  return result;
}

export const commands = { queue, list, show, create, update, messages, history, finance };
