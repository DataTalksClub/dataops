import { readFileSync } from "node:fs";

import { UsageError } from "../errors.mjs";
import { enc, fields, jsonData, optionalString, positional, table } from "../format.mjs";
import { apiFor } from "../session.mjs";

export const summary = "Generic templated text records with <PLACEHOLDER> tokens (distinct from card/workflow templates)";

export const help = `dataops text-templates - reusable templated text with placeholders

Plain-text templates whose body carries <UPPER_SNAKE> placeholders, stored as
one versioned record next to the offers rate card. Anyone signed in can list,
show, and render; admins create, update, and delete. Not related to card or
workflow templates (dataops templates) and not to KB email templates
(dataops email render) — these render to plain text only.

Usage
  dataops text-templates list [--json]
  dataops text-templates show <id> [--json]
  dataops text-templates create <id> --title T (--body TEXT | --body-file F)
      [--description D]
  dataops text-templates update <id> [--title T] [(--body TEXT | --body-file F)]
      [--description D] [--expected-version N]
  dataops text-templates delete <id> [--expected-version N]
  dataops text-templates render <id> [--value NAME=Text ... | --data '{"NAME":"..."}']
      [--json]

Create/update compare against the record version you last read; omit
--expected-version and the CLI reads the current version for you.

Examples
  dataops text-templates create reply.out-of-office --title "Out of office" \\
      --body "Hi <RECIPIENT_NAME>,\\n\\nAlexey is out until <RETURN_DATE>."
  dataops text-templates render reply.out-of-office \\
      --value RECIPIENT_NAME=Anna --value RETURN_DATE="3 November"
`;

function readBody(args) {
  const inline = optionalString(args, "body");
  const file = optionalString(args, "bodyFile");
  if (inline !== undefined && file !== undefined) throw new UsageError("Pass --body or --body-file, not both");
  if (file !== undefined) {
    if (file === "-") return readFileSync(0, "utf8");
    return readFileSync(file, "utf8");
  }
  return inline;
}

function parseValues(args) {
  const data = jsonData(args, { required: false });
  if (data !== undefined && data !== null) {
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new UsageError("--data must be a JSON object of placeholder values");
    return data;
  }
  const values = {};
  const raw = args.value === undefined ? [] : Array.isArray(args.value) ? args.value : [args.value];
  for (const item of raw) {
    const eq = String(item).indexOf("=");
    if (eq <= 0) throw new UsageError(`--value must be NAME=Text (got ${JSON.stringify(String(item))})`);
    values[String(item).slice(0, eq)] = String(item).slice(eq + 1);
  }
  return values;
}

async function resolveExpectedVersion(args, api, flag) {
  if (flag !== undefined) {
    const version = Number(flag);
    if (!Number.isInteger(version) || version < 0) throw new UsageError("--expected-version must be a non-negative integer");
    return version;
  }
  const current = await api.get("/api/text-templates");
  return current?.version ?? 0;
}

export async function list(args, io) {
  const result = await apiFor(args).get("/api/text-templates");
  if (args.json) return result;
  fields(io, [["Version", String(result?.version ?? 0)], ["Updated", result?.updatedAt], ["Updated by", result?.updatedBy]]);
  table(
    io,
    result?.templates || [],
    [
      ["ID", (item) => item.id],
      ["TITLE", (item) => item.title],
      ["PLACEHOLDERS", (item) => (item.placeholders || []).map((name) => `<${name}>`).join(" ")],
      ["UPDATED", (item) => item.updatedAt],
    ],
    "No text templates yet. Create one with: dataops text-templates create <id> --title T --body ...",
  );
  return result;
}

export async function show(args, io) {
  const id = positional(args, 0, "dataops text-templates show <id>");
  const result = await apiFor(args).get(`/api/text-templates/${enc(id)}`);
  if (args.json) return result;
  const template = result?.template || {};
  fields(io, [
    ["ID", template.id],
    ["Title", template.title],
    ["Description", template.description],
    ["Placeholders", (template.placeholders || []).map((name) => `<${name}>`).join(" ")],
    ["Version", String(result?.version ?? "")],
    ["Updated", template.updatedAt],
    ["Updated by", template.updatedBy],
    ["Body", template.body],
  ]);
  return result;
}

export async function create(args, io) {
  const id = positional(args, 0, "dataops text-templates create <id> --title T --body TEXT");
  const body = readBody(args);
  if (body === undefined) throw new UsageError("Pass --body TEXT or --body-file F with the template body");
  const api = apiFor(args);
  const expectedVersion = await resolveExpectedVersion(args, api, args.expectedVersion);
  const result = await api.post("/api/text-templates", {
    id,
    title: optionalString(args, "title") ?? id,
    body,
    description: optionalString(args, "description"),
    expectedVersion,
  });
  if (!args.json) io.print(`Created ${result?.template?.id || id} (record version ${result?.version}).`);
  return result;
}

export async function update(args, io) {
  const id = positional(args, 0, "dataops text-templates update <id> [--title T] [--body TEXT] [--description D]");
  const body = readBody(args);
  const patch = {
    ...(optionalString(args, "title") !== undefined ? { title: optionalString(args, "title") } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(optionalString(args, "description") !== undefined ? { description: optionalString(args, "description") } : {}),
  };
  if (!Object.keys(patch).length) throw new UsageError("Nothing to update. Pass --title, --body/--body-file or --description.");
  const api = apiFor(args);
  const expectedVersion = await resolveExpectedVersion(args, api, args.expectedVersion);
  const result = await api.put(`/api/text-templates/${enc(id)}`, { ...patch, expectedVersion });
  if (!args.json) io.print(`Updated ${result?.template?.id || id} (record version ${result?.version}).`);
  return result;
}

export async function remove(args, io) {
  const id = positional(args, 0, "dataops text-templates delete <id> [--expected-version N]");
  const api = apiFor(args);
  const expectedVersion = await resolveExpectedVersion(args, api, args.expectedVersion);
  const result = await api.delete(`/api/text-templates/${enc(id)}?expectedVersion=${expectedVersion}`);
  if (!args.json) io.print(`Deleted ${id} (record version ${result?.version}).`);
  return result;
}

export async function render(args, io) {
  const id = positional(args, 0, "dataops text-templates render <id> [--value NAME=Text ...]");
  const values = parseValues(args);
  const result = await apiFor(args).post(`/api/text-templates/${enc(id)}/render`, { values });
  if (args.json) return result;
  io.print(result?.text ?? "");
  const unused = result?.unused || [];
  if (unused.length) io.print(`\nUnfilled extra values: ${unused.join(", ")}`);
  return result;
}

export const commands = { list, show, create, update, delete: remove, render };
