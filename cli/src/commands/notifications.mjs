import { enc, positional, table } from "../format.mjs";
import { apiFor } from "../session.mjs";

export const summary = "List and dismiss notifications";

export const help = `dataops notifications - the web notification tray

Usage
  dataops notifications list [--all]      Undismissed by default; --all includes dismissed
  dataops notifications dismiss <id>
  dataops notifications dismiss-all
`;

export async function list(args, io) {
  const api = apiFor(args);
  const items = [];
  let cursor;
  do {
    const page = await api.get("/api/notifications", { query: { all: args.all ? "true" : undefined, cursor } });
    items.push(...(page?.notifications?.items || []));
    cursor = page?.notifications?.nextCursor;
  } while (cursor);
  const result = { notifications: items };
  if (args.json) return result;
  table(io, items, [
    ["ID", (item) => item.id],
    ["CREATED", (item) => String(item.createdAt || "").slice(0, 16)],
    ["TASK", (item) => item.taskId || ""],
    ["MESSAGE", (item) => item.message || item.title || item.type || ""],
  ], "No notifications.");
  return result;
}

export async function dismiss(args, io) {
  const id = positional(args, 0, "dataops notifications dismiss <id>");
  const result = await apiFor(args).put(`/api/notifications/${enc(id)}/dismiss`, {});
  if (!args.json) io.print(`Dismissed ${id}.`);
  return result;
}

export async function dismissAll(args, io) {
  const result = await apiFor(args).put("/api/notifications/dismiss-all", {});
  if (!args.json) io.print(`Dismissed ${result?.count ?? 0} notifications.`);
  return result;
}

export const commands = { list, dismiss, "dismiss-all": dismissAll };
