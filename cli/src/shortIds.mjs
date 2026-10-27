import { UsageError } from "./errors.mjs";

/**
 * Show commands accept a unique id prefix (8 or more characters) in place of a
 * full id. Shorter refs are rejected, full ids pass through untouched, and an
 * ambiguous prefix is an error naming the matches.
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
 * Resolve `id` for one entity kind. `listPage` fetches one page as
 * `{ items, nextCursor }`; `label` names the kind in errors.
 */
export async function resolveId(api, { label, id, listPage }) {
  if (!isShortPrefix(id)) {
    if (id.length < MIN_PREFIX) {
      throw new UsageError(`"${id}" is too short: a ${label} id or its unique prefix (8+ characters) is required.`);
    }
    return id;
  }
  const matches = (await collectAll(listPage))
    .map((item) => String(item.id))
    .filter((full) => full.startsWith(id));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    throw new UsageError(`No ${label} matches short id prefix "${id}".`);
  }
  const shown = matches.slice(0, 5).join(", ");
  const more = matches.length > 5 ? ` +${matches.length - 5} more` : "";
  throw new UsageError(`Ambiguous short id prefix "${id}": ${matches.length} ${label} matches (${shown}${more}).`);
}

function paged(route) {
  return (api, query) => api.get(route, { query }).then((page) => ({
    items: Array.isArray(page?.items) ? page.items : [],
    nextCursor: page?.nextCursor,
  }));
}

const listTasks = (api, query) => api.get("/api/tasks", { query }).then((page) => ({
  items: Array.isArray(page) ? page : Array.isArray(page?.tasks) ? page.tasks : [],
  nextCursor: page?.nextCursor,
}));

export const resolveTaskId = (api, id) => resolveId(api, { label: "Task", id, listPage: (q) => listTasks(api, q) });
export const resolveCompanyId = (api, id) => resolveId(api, { label: "company", id, listPage: (q) => paged("/api/sponsor-crm/directory/companies")(api, q) });
export const resolvePersonId = (api, id) => resolveId(api, { label: "person", id, listPage: (q) => paged("/api/sponsor-crm/directory/people")(api, q) });
export const resolveDealId = (api, id) => resolveId(api, { label: "deal", id, listPage: (q) => paged("/api/sponsor-crm/deals")(api, q) });
