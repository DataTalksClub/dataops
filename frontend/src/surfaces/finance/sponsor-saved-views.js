import { html } from "./shared.js";
import {
  DIRECTORY_FILTER_KEYS,
  validateDirectoryState,
} from "./sponsor-directory.js";

// Package E persisted saved views: personal views stored server-side through
// the D workspace API, builtins as shared immutable definitions. No
// browser-only storage anywhere: the URL always carries the effective filters
// explicitly, so refresh, back navigation and copied links replay the same
// query even when a personal view id is unavailable to the reader. Effective
// filters always come from the server's resolvedFilters (Berlin-resolved);
// there is no client date math anywhere.
//
// Endpoint paths default to the D contract mount and stay injectable;
// every client below takes an optional paths override. Nothing here touches
// the DOM or the network directly.

export const VIEW_ENTITIES = Object.freeze(["companies", "people", "pipeline"]);

// Pipeline saved views (D contract: stored + validated here, interpreted by
// the pipeline projection). On the pipeline tab `view` is the API filter, so
// the selected saved-view id travels as `savedView` in URLs.
export const PIPELINE_VIEW_FILTER_KEYS = Object.freeze(["view", "stage", "search", "organizationId", "owner", "nextActionFrom", "nextActionBefore"]);
const PIPELINE_VIEWS = Object.freeze(["actionable", "active", "early", "overdue", "reply", "unscheduled", "all", "closed"]);
const PIPELINE_STAGES = Object.freeze(["open", "agreed", "invoiced", "running", "closed", "lost"]);
const PIPELINE_SORTS = Object.freeze(["next-action", "recent"]);

export const DEFAULT_WORKSPACE_PATHS = Object.freeze({
  views: "/api/sponsor-crm/views",
  companies: "/api/sponsor-crm/directory/companies",
  people: "/api/sponsor-crm/directory/people",
});

// Builtins are server-provided (D `GET views` returns builtins first, then
// personal views) and consumed here, never duplicated: this module holds no
// second query-definition store that could drift from the API. UI filter
// definitions and labels live in sponsor-directory.js; execution always goes
// through the server's filters (or its resolvedFilters, when provided).
export function isBuiltinView(view) {
  return !!view && (view.builtin === true || String(view.id || "").startsWith("builtin:"));
}

// Default selection: the entity's Active builtin when the server provides it,
// else the server's first builtin for the entity, else null. A null default
// is an honest empty state, never a silent local fallback.
export function defaultViewForEntity(views, entity) {
  const scoped = (views || []).filter((view) => !view.entity || view.entity === entity);
  return scoped.find((view) => view.id === `builtin:${entity}:active`)
    || scoped.find(isBuiltinView)
    || null;
}

export function validateViewName(name) {
  if (typeof name !== "string" || !name.trim() || name.trim().length > 120) {
    return "Name must be 1..120 characters";
  }
  return "";
}

function isRelativeDay(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Number.isInteger(value.daysAgo) && value.daysAgo >= 1 && value.daysAgo <= 730 &&
    Object.keys(value).length === 1;
}

function absoluteOrRelative(value) {
  if (typeof value === "string") return /^\d{4}-\d{2}-\d{2}$/.test(value);
  return isRelativeDay(value);
}

// Client mirror of the D view-filter validation: unknown keys are rejected so
// a view can never be saved that the API would refuse to run.
export function validateViewFilters(entity, filters) {
  if (entity !== "companies" && entity !== "people" && entity !== "pipeline") {
    return "entity must be companies, people or pipeline";
  }
  if (!filters || typeof filters !== "object" || Array.isArray(filters)) return "filters must be an object";
  if (entity === "pipeline") return validatePipelineViewFilters(filters);
  for (const key of Object.keys(filters)) {
    if (!(DIRECTORY_FILTER_KEYS[entity] || []).includes(key)) return `Unknown ${entity} filter: ${key}`;
  }
  if (filters.search !== undefined &&
      (typeof filters.search !== "string" || !filters.search || filters.search.length > 200)) {
    return "Invalid search filter";
  }
  if (entity === "companies") {
    if (filters.relationship !== undefined &&
        !["customer", "talking", "dormant", "prospect"].includes(String(filters.relationship))) {
      return "Invalid relationship filter";
    }
    if (filters.active !== undefined && !["true", "false", "all"].includes(String(filters.active))) {
      return "Invalid active filter";
    }
    for (const key of ["lastTouchAfter", "lastTouchBefore"]) {
      if (filters[key] !== undefined && !absoluteOrRelative(filters[key])) {
        return `Invalid ${key} filter: YYYY-MM-DD or {daysAgo: 1..730}`;
      }
    }
  } else {
    if (filters.company !== undefined && (typeof filters.company !== "string" || !filters.company)) {
      return "Invalid company filter";
    }
    for (const key of ["primary", "unlinked"]) {
      if (filters[key] !== undefined && !["true", "false"].includes(String(filters[key]))) {
        return `Invalid ${key} filter`;
      }
    }
    if (filters.active !== undefined && !["true", "false", "all"].includes(String(filters.active))) {
      return "Invalid active filter";
    }
  }
  return "";
}

export function validatePipelineViewFilters(filters) {
  const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  for (const key of Object.keys(filters)) {
    if (!PIPELINE_VIEW_FILTER_KEYS.includes(key)) return `Unknown pipeline filter: ${key}`;
  }
  if (filters.view !== undefined && !PIPELINE_VIEWS.includes(String(filters.view))) {
    return "view must be actionable, active, early, overdue, reply, unscheduled, all or closed";
  }
  if (filters.stage !== undefined && !PIPELINE_STAGES.includes(String(filters.stage))) {
    return "stage must be open, agreed, invoiced, running, closed or lost";
  }
  if (filters.search !== undefined &&
      (typeof filters.search !== "string" || !filters.search || filters.search.length > 200)) {
    return "Invalid search filter";
  }
  if (filters.organizationId !== undefined &&
      (typeof filters.organizationId !== "string" || !ID.test(filters.organizationId))) {
    return "Invalid organizationId filter";
  }
  if (filters.owner !== undefined &&
      (typeof filters.owner !== "string" || !filters.owner || filters.owner.length > 200)) {
    return "Invalid owner filter";
  }
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  for (const key of ["nextActionFrom", "nextActionBefore"]) {
    if (filters[key] !== undefined && (typeof filters[key] !== "string" || !DAY.test(filters[key]))) {
      return `Invalid ${key} filter: YYYY-MM-DD`;
    }
  }
  if (typeof filters.nextActionFrom === "string" && typeof filters.nextActionBefore === "string" &&
      filters.nextActionFrom > filters.nextActionBefore) {
    return "nextActionFrom must not exceed nextActionBefore";
  }
  return "";
}

export function validatePipelineViewSort(sort) {
  if (!sort || typeof sort !== "object" || Array.isArray(sort) || typeof sort.field !== "string") {
    return "sort must be {field}";
  }
  if (!PIPELINE_SORTS.includes(sort.field)) return "pipeline sort must be next-action or recent";
  return "";
}

export function validateViewSort(entity, sort) {
  if (entity === "pipeline") return validatePipelineViewSort(sort);
  if (!sort || typeof sort !== "object" || Array.isArray(sort)) return "sort must be {field, direction}";
  if (!["name", "lastTouch"].includes(sort.field)) return "sort field must be name or lastTouch";
  if (sort.direction !== "asc" && sort.direction !== "desc") return "sort direction must be asc or desc";
  return "";
}

function defaultFiltersFor(entity) {
  return entity === "pipeline" ? {} : { active: "true" };
}

// Sort state preserves direction end-to-end (saved view → controls/state →
// query → URL/reload → update): reverse combos (name/desc, lastTouch/asc)
// execute and round-trip instead of collapsing to field defaults. Pipeline
// sorts carry no direction key (rev4: {field: next-action|recent}).
function defaultSortFor(entity) {
  return entity === "pipeline" ? { field: "next-action" } : { field: "name", direction: "asc" };
}

function defaultDirectionFor(field) {
  return field === "lastTouch" ? "desc" : "asc";
}

function sameSort(left, right) {
  if (typeof left === "string" || typeof right === "string") return left === right;
  return left?.field === right?.field && (left?.direction || "asc") === (right?.direction || "asc");
}

// Combines the selected view (builtin or personal, server-provided) with
// explicit URL filters. Explicit URL keys win; any genuine deviation unpins
// the view id so the URL keeps the effective filters and stays shareable.
// Unknown view ids fall back to the URL filters when present, and fail
// honestly otherwise. A failed views fetch (viewsError) is never papered
// over: without usable URL filters the caller gets an error for its honest
// error state. Effective filters always come from the server's resolvedFilters;
// a view without them fails honestly instead of client-side guessing.
export function resolveEffectiveFilters({ entity, views, viewsError, selectedViewId, urlState }) {
  const url = urlState || {};
  const allowedKeys = entity === "pipeline" ? PIPELINE_VIEW_FILTER_KEYS : DIRECTORY_FILTER_KEYS[entity] || [];
  const urlFilters = {};
  for (const key of allowedKeys) {
    if (url[key] !== undefined) urlFilters[key] = url[key];
  }
  const urlSortField = url.sort;
  const urlDir = url.dir;
  const view = (views || []).find((item) => item.id === selectedViewId);
  // Sort state preserves direction: an explicit sort field takes the explicit
  // dir or its field default; a bare dir applies to the base field so shared
  // links never silently drop a reverse direction.
  const urlSort = urlSortField !== undefined
    ? (entity === "pipeline"
      ? { field: urlSortField }
      : { field: urlSortField, direction: urlDir || defaultDirectionFor(urlSortField) })
    : undefined;
  if (selectedViewId && !view) {
    if (!Object.keys(urlFilters).length && !urlSort && urlDir === undefined) {
      return { error: viewsError || "That saved view is not available. Pick another view or adjust the filters." };
    }
    return {
      filters: urlFilters,
      sort: urlSort || { field: defaultSortFor(entity).field, direction: urlDir },
      viewId: null,
      modified: true,
    };
  }
  if (!view && viewsError && !Object.keys(urlFilters).length && !urlSort && urlDir === undefined) {
    return { error: viewsError };
  }
  if (view && !view.resolvedFilters) {
    return { error: "That saved view could not be resolved. Reload the directory and retry." };
  }
  const baseFilters = view ? { ...view.resolvedFilters } : { ...defaultFiltersFor(entity) };
  const baseSort = view?.sort || defaultSortFor(entity);
  // A URL key matching the resolved value is the same window, not a
  // modification, so builtins stay selected across refresh while copied links
  // without the view id still replay the frozen window.
  const overlaid = Object.keys(urlFilters).filter((key) => {
    // An explicitly cleared control deletes an applied filter (unpins);
    // an empty control over no base value changes nothing.
    if (urlFilters[key] === "") return key in baseFilters;
    return String(urlFilters[key]) !== String(baseFilters[key]);
  });
  const filters = { ...baseFilters, ...urlFilters };
  for (const [key, value] of Object.entries(urlFilters)) {
    if (value === "") delete filters[key];
  }
  const baseField = typeof baseSort === "string" ? baseSort : baseSort.field;
  const baseDir = typeof baseSort === "string" ? undefined : baseSort.direction;
  const sort = urlSort || (urlDir !== undefined && entity !== "pipeline"
    ? { field: baseField, direction: urlDir }
    : baseSort);
  const modified = (!!view && (overlaid.length > 0 || (!!urlSort && !sameSort(urlSort, baseSort)))) ||
    (!!view && urlDir !== undefined && urlDir !== baseDir);
  const sortError = entity === "pipeline"
    ? validatePipelineViewSort(sort)
    : validateViewSort(entity, sort);
  const error = validateViewFilters(entity, filters) || sortError;
  if (error) return { error };
  return { filters, sort, viewId: modified ? null : view?.id || null, modified };
}

// --- API client. `api` is the surface's request closure (path, options).
// Bodies follow the D contract: POST create, PUT full replace + version,
// DELETE archives (record kept). Builtins are immutable: the server answers
// 404 on PUT/DELETE of builtin ids, which propagates to the honest error UI.

export async function fetchViews(api, entity, { includeArchived = false, paths = DEFAULT_WORKSPACE_PATHS } = {}) {
  const query = new URLSearchParams();
  if (entity) query.set("entity", entity);
  if (includeArchived) query.set("includeArchived", "true");
  const suffix = query.toString() ? `?${query}` : "";
  return api(`${paths.views}${suffix}`);
}

export async function saveView(api, { entity, name, filters, sort, columns, sourceKey } = {}, { paths = DEFAULT_WORKSPACE_PATHS } = {}) {
  const nameError = validateViewName(name);
  if (nameError) throw new Error(nameError);
  const filterError = validateViewFilters(entity, filters);
  if (filterError) throw new Error(filterError);
  if (sort !== undefined) {
    const sortError = validateViewSort(entity, sort);
    if (sortError) throw new Error(sortError);
  }
  return api(paths.views, {
    method: "POST",
    body: JSON.stringify({
      entity, name: name.trim(), filters,
      ...(sort !== undefined ? { sort } : {}),
      ...(columns !== undefined ? { columns } : {}),
      ...(sourceKey !== undefined ? { sourceKey } : {}),
    }),
  });
}

export async function updateSavedView(api, id, { name, filters, sort, columns, version } = {}, { paths = DEFAULT_WORKSPACE_PATHS } = {}) {
  if (!id) throw new Error("A view id is required");
  if (isBuiltinView({ id })) throw new Error("Built-in views cannot be changed");
  const nameError = validateViewName(name);
  if (nameError) throw new Error(nameError);
  return api(`${paths.views}/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify({
      name: name.trim(), filters, sort, columns, version,
    }),
  });
}

export async function archiveSavedView(api, id, { paths = DEFAULT_WORKSPACE_PATHS } = {}) {
  if (!id) throw new Error("A view id is required");
  if (isBuiltinView({ id })) throw new Error("Built-in views cannot be archived");
  return api(`${paths.views}/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function isVersionConflict(error) {
  return Number(error?.status) === 409;
}

// --- Markup: a view switcher (builtins grouped, then personal) with save /
// update / manage controls. Rename and archive run from the manage list; the
// integration hunk provides the dialogs around these data attributes.

export function renderSavedViewBar({ entity, views, viewsError, selectedViewId, updateViewId, modified, escapeHtml }) {
  // A failed views fetch is an honest error with retry, never a silent
  // fallback to local definitions: builtins remain available from the API.
  if (viewsError) {
    return html`<div class="crm-views-bar" data-views-bar="${escapeHtml(entity)}">
      <p class="surface-status" role="status" data-views-error>Saved views unavailable: ${escapeHtml(viewsError)}</p>
      <button type="button" data-views-retry>Retry</button>
    </div>`;
  }
  const items = (views || []).filter((view) => !view.entity || view.entity === entity);
  if (!items.length) {
    return html`<div class="crm-views-bar" data-views-bar="${escapeHtml(entity)}">
      <p class="surface-status" role="status" data-views-empty>No saved views for this list yet.</p>
      <button type="button" data-views-save>Save current filters</button>
    </div>`;
  }
  const personal = items.filter((view) => !isBuiltinView(view) && !view.archivedAt);
  const selected = items.find((view) => view.id === selectedViewId);
  const updatable = items.find((view) => view.id === (updateViewId ?? selectedViewId));
  const group = (label, list) => list.length
    ? html`<optgroup label="${escapeHtml(label)}">${list
      .map((view) => html`<option value="${escapeHtml(view.id)}"${
        view.id === selectedViewId ? " selected" : ""}>${escapeHtml(view.name)}${modified && view.id === selectedViewId ? " (modified)" : ""}</option>`)
      .join("")}</optgroup>`
    : "";
  return html`<div class="crm-views-bar" data-views-bar="${escapeHtml(entity)}">
    <label>View <select data-views-select>
      ${!selected ? html`<option value="" disabled selected>Current filters</option>` : ""}
      ${group("Built-in", items.filter(isBuiltinView))}
      ${group("My views", personal)}
    </select></label>
    ${modified ? html`<span class="crm-views-modified">Modified</span>` : ""}
    <button type="button" data-views-save>Save current filters</button>
    ${modified && updatable && !isBuiltinView(updatable)
      ? html`<button type="button" data-views-update>Update “${escapeHtml(updatable.name)}”</button>` : ""}
    ${personal.length ? html`<button type="button" data-views-manage>Manage my views</button>` : ""}
  </div>`;
}

export function renderSavedViewManageList({ views, escapeHtml }) {
  const personal = (views || []).filter((view) => !isBuiltinView(view) && !view.archivedAt);
  if (!personal.length) {
    return html`<div class="honest-state" data-views-manage-empty>
      <strong>No saved views yet</strong>
      <p>Save the current filters to reuse them later.</p>
    </div>`;
  }
  return html`<ul class="crm-views-manage" data-views-manage-list>${personal
    .map((view) => html`<li data-views-manage-item="${escapeHtml(view.id)}">
      <strong>${escapeHtml(view.name)}</strong>
      <span>${escapeHtml(view.entity)}</span>
      <button type="button" data-views-rename="${escapeHtml(view.id)}">Rename</button>
      <button type="button" data-views-archive="${escapeHtml(view.id)}">Archive</button>
    </li>`)
    .join("")}</ul>`;
}
