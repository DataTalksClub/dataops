import { UsageError } from "./errors.mjs";

/**
 * Show commands accept a unique id prefix (8 or more characters) in place of a
 * full id. Anything else (full ids, arbitrary task-id slugs, shorter refs)
 * passes through to the API untouched, and an ambiguous prefix is an error
 * naming the matches.
 */

const MIN_PREFIX = 8;
const FULL_ID_LENGTH = 32;

function isShortPrefix(id) {
  return id.length >= MIN_PREFIX && id.length < FULL_ID_LENGTH;
}

async function collectAll(listPage) {
  const items = [];
  let cursor;
  do {
    const page = await listPage({ limit: 100, ...(cursor ? { cursor } : {}) });
    items.push(...(Array.isArray(page?.items) ? page.items : []));
    cursor = page?.nextCursor;
  } while (cursor);
  return items;
}

/**
 * Resolve `id` for one entity kind. `listAll` returns every id-bearing record
 * of the kind; `label` names the kind in errors.
 */
export async function resolveId(api, { label, id, listAll }) {
  if (!isShortPrefix(id)) return id;
  const matches = new Set();
  for (const full of (await listAll()).map((item) => String(item.id))) {
    if (full.startsWith(id)) matches.add(full);
    if (matches.size > 1) break;
  }
  if (matches.size === 1) return [...matches][0];
  if (matches.size === 0) {
    throw new UsageError(`No ${label} matches short id prefix "${id}".`);
  }
  const found = [...matches];
  const shown = found.slice(0, 5).join(", ");
  const more = found.length > 5 ? ` +${found.length - 5} more` : "";
  throw new UsageError(`Ambiguous short id prefix "${id}": ${found.length} ${label} matches (${shown}${more}).`);
}

function pagedAll(api, route) {
  return () => collectAll((query) => api.get(route, { query }).then((page) => ({
    items: Array.isArray(page?.items) ? page.items : [],
    nextCursor: page?.nextCursor,
  })));
}

// The tasks endpoint requires a primary filter, so every status is scanned.
const TASK_STATUSES = ["todo", "waiting", "done", "skipped"];

async function listAllTasks(api) {
  const items = [];
  for (const status of TASK_STATUSES) {
    items.push(...(await collectAll((query) => api.get("/api/tasks", { query: { ...query, status } }).then((page) => ({
      items: Array.isArray(page) ? page : Array.isArray(page?.tasks) ? page.tasks : [],
      nextCursor: page?.nextCursor,
    })))));
  }
  return items;
}

export const resolveTaskId = (api, id) => resolveId(api, { label: "Task", id, listAll: () => listAllTasks(api) });
export const resolveCompanyId = (api, id) => resolveId(api, { label: "company", id, listAll: pagedAll(api, "/api/sponsor-crm/directory/companies") });
export const resolvePersonId = (api, id) => resolveId(api, { label: "person", id, listAll: pagedAll(api, "/api/sponsor-crm/directory/people") });
export const resolveDealId = (api, id) => resolveId(api, { label: "deal", id, listAll: pagedAll(api, "/api/sponsor-crm/deals") });
