import { enc, positional, table } from "../format.mjs";
import { apiFor } from "../session.mjs";
import { UsageError } from "../errors.mjs";

export const summary = "Read and process the ad-hoc queue other systems post to";

export const help = `dataops queue - the general-purpose ad-hoc queue

Any system (AISL first) posts items with its own token stored in
\`dataops secrets\` as adhoc-queue.<source>. Process open items on every
task check: read, act, then mark done with a note.

Usage
  dataops queue list [--status open|new|acked|done|all] [--source <source>]
  dataops queue show <id>
  dataops queue ack <id> [--note <text>]       Seen, being handled
  dataops queue done <id> --note <text>        Handled; note says what was done
  dataops queue reopen <id> [--note <text>]

Posting (from another system)
  POST /api/v1/queue/items
  Authorization: Bearer <adhoc-queue.<source> token>
  {"source","kind","title","payload","links":[{"label","url"}],"idempotencyKey"}

Task sources
  A source/kind registered in ADHOC_QUEUE_TASK_SOURCES (backend/src/routes/adhocQueue.ts)
  must also send "task": {"description","checklist":[...],"instructionDocId","comment","browserRequirement"}.
  Its item then becomes exactly one ad hoc Task (qt-<item hash>) assigned to the registered
  operator; the item shows it as taskId. Registered: slack-mod-app / slack.ban-request -> Orin.
`;

export async function list(args, io) {
  const result = await apiFor(args).get("/api/queue", {
    query: { status: args.status || undefined, source: args.source || undefined },
  });
  if (args.json) return result;
  table(io, result?.items || [], [
    ["ID", (item) => item.id],
    ["RECEIVED", (item) => String(item.receivedAt || "").slice(0, 16)],
    ["STATUS", (item) => item.status],
    ["SOURCE", (item) => item.source],
    ["KIND", (item) => item.kind],
    ["TITLE", (item) => item.title],
  ], "Queue is empty.");
  return result;
}

export async function show(args, io) {
  const id = positional(args, 0, "dataops queue show <id>");
  const result = await apiFor(args).get(`/api/queue/${enc(id)}`);
  if (args.json) return result;
  const item = result.item;
  io.print(`${item.id}  [${item.status}]  ${item.source} ${item.kind}`);
  io.print(item.title);
  io.print(`received ${item.receivedAt}  key ${item.idempotencyKey}`);
  for (const link of item.links || []) io.print(`link: ${link.label} ${link.url}`);
  io.print(`payload: ${JSON.stringify(item.payload, null, 2)}`);
  for (const entry of item.history || []) io.print(`history: ${entry.at} ${entry.status} by ${entry.by}${entry.note ? ` - ${entry.note}` : ""}`);
  return result;
}

function setter(status, usage, needsNote) {
  return async (args, io) => {
    const id = positional(args, 0, usage);
    if (needsNote && !args.note) throw new UsageError(`--note is required. Usage: ${usage}`);
    const result = await apiFor(args).put(`/api/queue/${enc(id)}/status`, { status, note: args.note || undefined });
    if (!args.json) io.print(`${id} -> ${status}`);
    return result;
  };
}

export const ack = setter("acked", "dataops queue ack <id> [--note <text>]", false);
export const done = setter("done", "dataops queue done <id> --note <text>", true);
export const reopen = setter("new", "dataops queue reopen <id> [--note <text>]", false);

export const commands = { list, show, ack, done, reopen };
