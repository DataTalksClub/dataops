import { readFileSync } from "node:fs";

import { ApiError } from "../api.mjs";
import { ConflictError, UsageError } from "../errors.mjs";
import { enc, fields, integer, optionalString, positional, table } from "../format.mjs";
import { apiFor } from "../session.mjs";

export const summary = "List, inspect, and edit Templates (Git defaults stay canonical)";

export const help = `dataops templates - reusable Card definitions; edits pin a whole definition over the Git base

Usage
  dataops templates list
  dataops templates show <id|type|name>
  dataops templates create --file <definition.yaml|json> [--dry-run]
  dataops templates update <id|type|name> (--from-file <definition.yaml|json> | --file <definition.yaml|json>
      | --task <taskRef> --offset-days <int> [--task-name <text>] [--name <text>])
      [--expected-version N] [--revision R] [--dry-run]
  dataops templates reset <id|type|name> [--expected-version N] [--revision R] [--dry-run]
  dataops templates delete <id|type|name> --yes [--expected-version N] [--revision R]
  dataops templates sync

sync projects dataops-knowledge main (workflow-templates/) into the live
Templates; it needs the knowledge repository's CI identity and runs in its
publish workflow, so a push to main refreshes them without a deploy. Pinned
(edited) Templates keep their pin and are reported.

Create a Card from one with: dataops cards create --title T --date D --template <id|type|name>

Writes pin (PUT) or restore (reset) the whole effective definition: Git stays
the canonical default (dataops-knowledge/workflow-templates/<type>.yaml) and a
seed never half-applies a pin. The same pin is available from the web Templates
page (Edit definition). The
--expected-version/--revision pair defaults to the currently fetched values,
except a definition file carrying its own version/revision (for example a
saved GET response) supplies them instead; explicit flags always win. Only a
fresh fetch covers the fetch-to-submit window the server CAS guards, so apply
stale offline files with the pair they were read at. The server enforces both
and reports the current pair on conflict. Custom templates can be created and
deleted by admins; Git templates are pinned, reset, or left alone, never
deleted. A deleted template's type can be recreated fresh.

Examples
  dataops templates list --json
  dataops templates show newsletter-issue
  dataops templates update newsletter-issue --task schedule-email --offset-days -14
  dataops templates delete my-scratch-type --yes
`;

function templatesOf(payload) {
  return Array.isArray(payload?.templates) ? payload.templates : Array.isArray(payload) ? payload : [];
}

/** A Template by id, then exact type, then exact (case-insensitive) name. */
export async function findTemplate(api, ref) {
  try {
    const { template } = await api.get(`/api/templates/${enc(ref)}`);
    if (template) return template;
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
  }
  const templates = templatesOf(await api.get("/api/templates"));
  const lower = ref.toLowerCase();
  const matches = templates.filter(
    (template) => template.type === ref || String(template.name || "").toLowerCase() === lower,
  );
  if (matches.length > 1) {
    throw new UsageError(`More than one Template matches "${ref}". Re-run with its id.`);
  }
  const [match] = matches;
  if (!match) {
    throw new UsageError(`No Template matches "${ref}". Run \`dataops templates list\` to see them.`);
  }
  return match;
}

/** Server-owned fields never travel inside a definition; the CAS pair rides alongside it. */
const SERVER_OWNED_FIELDS = new Set([
  "id", "version", "revision", "origin", "pinned", "base", "baseSourceRevision",
  "sourcePath", "sourceRevision", "createdAt", "updatedAt", "PK", "SK",
]);

function stripServerOwned(definition) {
  const clean = { ...definition };
  for (const field of SERVER_OWNED_FIELDS) delete clean[field];
  return clean;
}

/** js-yaml is loaded lazily so the CLI keeps working in checkouts without
 * installed dependencies (e.g. the knowledge publish job) for every command
 * that never parses a YAML file. Only YAML `--file` inputs trigger the load. */
async function loadYaml() {
  try {
    return (await import("js-yaml")).default;
  } catch {
    throw new UsageError(
      "YAML template files need the js-yaml package: pass a JSON file to --file instead, or run with dependencies installed.",
    );
  }
}

async function definitionFile(args) {
  const fromFile = optionalString(args, "fromFile");
  const file = optionalString(args, "file");
  if (fromFile !== undefined && file !== undefined) {
    throw new UsageError("Pass --from-file or --file, not both.");
  }
  const path = fromFile ?? file;
  if (path === undefined) return undefined;
  let text;
  try {
    text = path === "-" ? readFileSync(0, "utf8") : readFileSync(path, "utf8");
  } catch (error) {
    throw new UsageError(`Cannot read file ${path}: ${error.message}`);
  }
  const isYaml = path === "-" || /\.ya?ml$/i.test(path);
  try {
    let parsed;
    if (isYaml) {
      const yaml = await loadYaml();
      parsed = yaml.load(text, { schema: yaml.JSON_SCHEMA });
    } else {
      parsed = JSON.parse(text);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new UsageError(`--file ${path} must hold a template definition object.`);
    }
    return parsed;
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(`--file ${path} is not valid ${isYaml ? "YAML" : "JSON"}: ${error.message}`);
  }
}

function versionPair(args, template, fileDefinition) {
  // Precedence: explicit flags, then the file's own pair (a saved GET
  // response carries the revision it was read at), then a fresh fetch. Only
  // a fresh fetch covers the fetch-to-submit window the server CAS guards.
  const fileVersion = Number.isInteger(fileDefinition?.version) && fileDefinition.version >= 1
    ? fileDefinition.version
    : undefined;
  const fileRevision = typeof fileDefinition?.revision === "string" && fileDefinition.revision.length > 0
    ? fileDefinition.revision
    : undefined;
  const expectedVersion = integer(args.expectedVersion, "expected-version") ?? fileVersion ?? template.version;
  const revision = optionalString(args, "revision") ?? fileRevision ?? template.revision;
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new UsageError("No usable version; re-run with --expected-version N.");
  }
  if (typeof revision !== "string" || revision.length === 0) {
    throw new UsageError("No usable revision; re-run with --revision R.");
  }
  return { expectedVersion, revision };
}

function describeConflict(error, ref) {
  if (error instanceof ApiError && error.status === 409 && error.body && typeof error.body === "object") {
    const current = error.body.currentTemplate;
    const hint = current
      ? ` Current version is ${current.version} (revision ${current.revision || "unknown"}).`
      : "";
    throw new ConflictError(`${error.message || "Template changed."}${hint} Re-read ${ref} and retry.`, { current });
  }
  throw error;
}

export async function list(args, io) {
  const result = await apiFor(args).get("/api/templates");
  if (args.json) return result;
  table(
    io,
    templatesOf(result),
    [
      ["ID", (template) => template.id],
      ["TYPE", (template) => template.type],
      ["ORIGIN", (template) => template.origin || "git"],
      ["PINNED", (template) => template.pinned ? "yes" : ""],
      ["TASKS", (template) => (template.taskDefinitions || []).length],
      ["NAME", (template) => template.name],
    ],
    "No Templates.",
  );
  return result;
}

export async function show(args, io) {
  const ref = positional(args, 0, "dataops templates show <id|type|name>");
  const template = await findTemplate(apiFor(args), ref);
  if (args.json) return { template };
  fields(io, [
    ["id", template.id],
    ["name", template.name],
    ["type", template.type],
    ["origin", template.origin || "git"],
    ["pinned", template.pinned ? "yes" : "no"],
    ["revision", template.revision],
    ["version", template.version],
    ["base source", template.baseSourceRevision || template.sourceRevision],
    ["trigger", template.triggerType],
    ["source", template.sourcePath],
    ["source docs", template.sourceDocIds],
    ["tags", template.tags],
    ["card links", (template.cardLinkDefinitions || []).map((link) => link.name)],
  ]);
  io.print("");
  table(
    io,
    template.taskDefinitions || [],
    [
      ["OFFSET", (task) => `${task.offsetDays >= 0 ? "+" : ""}${task.offsetDays ?? 0}d`],
      ["REF", (task) => task.refId || ""],
      ["GROUP", (task) => task.optionalGroup || task.group || ""],
      ["AFTER", (task) => (task.dependsOn || []).join(",")],
      ["DESCRIPTION", (task) => task.description],
    ],
    "No Task definitions.",
  );
  return { template };
}

export async function create(args, io) {
  const fileDefinition = await definitionFile(args);
  if (fileDefinition === undefined) {
    throw new UsageError("dataops templates create --file <definition.yaml|json> [--dry-run]");
  }
  const definition = stripServerOwned(fileDefinition);
  const api = apiFor(args);
  const query = args.dryRun ? { dryRun: "true" } : undefined;
  const result = await api.post("/api/templates", definition, { query });
  if (args.json) return result;
  if (result.dryRun) {
    io.print("Dry run: definition is valid. Nothing was created.");
    return result;
  }
  io.print(`Created ${result.template.id} (${result.template.type}).`);
  return result;
}

function patchedTaskDefinitions(template, args) {
  const taskRef = optionalString(args, "task");
  const definitions = structuredClone(template.taskDefinitions || []);
  const name = optionalString(args, "name");
  if (name !== undefined) template.name = name;
  if (taskRef === undefined) {
    if (name === undefined) {
      throw new UsageError(
        "dataops templates update <ref> (--file <definition.yaml|json> | --task <taskRef> --offset-days <int> [--task-name <text>] [--name <text>])",
      );
    }
    return { name: template.name, taskDefinitions: definitions };
  }
  const task = definitions.find((entry) => entry.refId === taskRef);
  if (!task) throw new UsageError(`No Task definition with ref "${taskRef}" on Template "${template.type || template.id}".`);
  const offsetDays = args.offsetDays === undefined ? undefined : Number(args.offsetDays);
  const taskName = optionalString(args, "taskName");
  if (offsetDays !== undefined && (!Number.isInteger(offsetDays))) {
    throw new UsageError("--offset-days must be an integer number of days.");
  }
  if (offsetDays === undefined && taskName === undefined) {
    throw new UsageError("dataops templates update <ref> --task <taskRef> --offset-days <int> [--task-name <text>]");
  }
  if (offsetDays !== undefined) task.offsetDays = offsetDays;
  if (taskName !== undefined) task.description = taskName;
  return { name: template.name, taskDefinitions: definitions };
}

export async function update(args, io) {
  const ref = positional(args, 0, "dataops templates update <id|type|name> (--from-file ... | --task ...)");
  const api = apiFor(args);
  const fileDefinition = await definitionFile(args);
  const template = await findTemplate(api, ref);
  const { expectedVersion, revision } = versionPair(args, template, fileDefinition);
  let definition;
  if (fileDefinition !== undefined) {
    if (args.task !== undefined || args.offsetDays !== undefined || args.taskName !== undefined || args.name !== undefined) {
      throw new UsageError("Pass --from-file or task flags, not both.");
    }
    definition = stripServerOwned(fileDefinition);
  } else {
    const base = stripServerOwned(structuredClone(template));
    const patched = patchedTaskDefinitions(base, args);
    definition = { ...base, ...patched };
  }
  const query = args.dryRun ? { dryRun: "true" } : undefined;
  let result;
  try {
    result = await api.put(`/api/templates/${enc(template.id)}`, { expectedVersion, revision, definition }, { query });
  } catch (error) {
    describeConflict(error, ref);
  }
  if (args.json) return result;
  if (result.dryRun) {
    io.print("Dry run: definition is valid. Nothing was pinned.");
    return result;
  }
  io.print(`Updated ${template.id} to version ${result.template.version}.`);
  return result;
}

export async function reset(args, io) {
  const ref = positional(args, 0, "dataops templates reset <id|type|name> [--expected-version N] [--revision R] [--dry-run]");
  const api = apiFor(args);
  const template = await findTemplate(api, ref);
  const { expectedVersion, revision } = versionPair(args, template);
  const query = args.dryRun ? { dryRun: "true" } : undefined;
  let result;
  try {
    result = await api.post(`/api/templates/${enc(template.id)}/reset`, { expectedVersion, revision }, { query });
  } catch (error) {
    describeConflict(error, ref);
  }
  if (args.json) return result;
  if (result.dryRun) {
    io.print("Dry run: nothing was reset.");
    return result;
  }
  io.print(result.applied ? `Reset ${template.id} to the Git base.` : `${template.id} already follows the Git base.`);
  return result;
}

export async function remove(args, io) {
  const ref = positional(args, 0, "dataops templates delete <id|type|name> --yes");
  const api = apiFor(args);
  const template = await findTemplate(api, ref);
  if (!args.yes) {
    throw new UsageError(
      `This deletes custom Template "${template.name || template.type || template.id}". `
      + `Re-run with --yes to confirm: dataops templates delete ${ref} --yes`,
    );
  }
  const { expectedVersion, revision } = versionPair(args, template);
  let result;
  try {
    result = await api.delete(`/api/templates/${enc(template.id)}`, { expectedVersion, revision });
  } catch (error) {
    describeConflict(error, ref);
  }
  if (args.json) return result;
  io.print(`Deleted ${template.id}.`);
  return result;
}

export async function sync(args, io) {
  const result = await apiFor(args).post("/api/templates/sync", {});
  if (args.json) return result;
  const { total, created, updated, unchanged } = result.templates;
  io.print(`Synced ${total} Templates from Git: ${created} created, ${updated} updated, ${unchanged} unchanged.`);
  if (result.pinnedTypes?.length) {
    io.print(`Pinned (live definition differs from Git, base follows Git): ${result.pinnedTypes.join(", ")}`);
  }
  return result;
}

export const commands = { list, show, create, update, reset, delete: remove, sync };
