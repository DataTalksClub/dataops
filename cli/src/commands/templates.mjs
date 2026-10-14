import { ApiError } from "../api.mjs";
import { UsageError } from "../errors.mjs";
import { enc, fields, positional, table } from "../format.mjs";
import { apiFor } from "../session.mjs";

export const summary = "List and inspect Templates (read-only; authored in Git)";

export const help = `dataops templates - reusable Card definitions; read-only here, authored in Git

Usage
  dataops templates list
  dataops templates show <id|type|name>

Create a Card from one with: dataops cards create --title T --date D --template <id|type|name>

Examples
  dataops templates list --json
  dataops templates show newsletter-issue
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
  const match =
    templates.find((template) => template.type === ref) ||
    templates.find((template) => String(template.name || "").toLowerCase() === lower);
  if (!match) {
    throw new UsageError(`No Template matches "${ref}". Run \`dataops templates list\` to see them.`);
  }
  return match;
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
      ["DESCRIPTION", (task) => task.description],
    ],
    "No Task definitions.",
  );
  return { template };
}

export const commands = { list, show };
