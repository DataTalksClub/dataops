import { sponsorsPath } from "../../core/sponsor-routes.js";
import { html } from "./shared.js";

// Package E bounded directories: separate Companies / People lists backed by
// the D workspace API (GET <directoryBase>/companies|people). This module is
// pure state + markup: parsing URL state, building API-exact queries, paging
// with filter-bound cursors, and rendering compact rows. Fetching, events and
// surface wiring belong to the future sponsors.js integration hunk — nothing
// here touches the DOM or the network.
//
// API-exactness rule: every filter this module emits must be accepted by the D
// contract (unknown keys are 400s). Companies: search, relationship, active,
// lastTouchAfter, lastTouchBefore, sort, limit, cursor. People: search,
// company, primary, unlinked, active, sort, limit, cursor. Recent contact on
// the People list is expressed as sort=lastTouch, the only recent-contact
// semantic the endpoint offers.

export const DIRECTORY_PAGE_SIZE_DEFAULT = 30;
export const DIRECTORY_PAGE_SIZE_MAX = 100;

export const DIRECTORY_ENTITIES = Object.freeze(["companies", "people"]);

export const DIRECTORY_RELATIONSHIPS = Object.freeze([
  Object.freeze({ id: "customer", label: "Customer" }),
  Object.freeze({ id: "talking", label: "Talking" }),
  Object.freeze({ id: "dormant", label: "Dormant" }),
  Object.freeze({ id: "prospect", label: "Prospect" }),
]);

export const DIRECTORY_SORTS = Object.freeze([
  Object.freeze({ id: "name", label: "Name" }),
  Object.freeze({ id: "lastTouch", label: "Last touch" }),
]);

// Allowed query keys per entity, mirroring the D contract. Used to keep
// builtins, saved views and URL state executable: anything outside these sets
// is rejected before it reaches the API.
export const DIRECTORY_FILTER_KEYS = Object.freeze({
  companies: Object.freeze(["search", "relationship", "active", "lastTouchAfter", "lastTouchBefore"]),
  people: Object.freeze(["search", "company", "primary", "unlinked", "active"]),
});

const ACTIVE_VALUES = ["true", "false", "all"];
const BOOLEAN_VALUES = ["true", "false"];
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function invalid(message) {
  return message;
}

export function validateDirectoryState(entity, state) {
  if (!DIRECTORY_ENTITIES.includes(entity)) return invalid(`Unknown directory: ${entity}`);
  const value = state || {};
  if (value.search !== undefined && (typeof value.search !== "string" || !value.search || value.search.length > 200)) {
    return invalid("Search must be 1..200 characters");
  }
  if (value.active !== undefined && !ACTIVE_VALUES.includes(value.active)) {
    return invalid("active must be true, false or all");
  }
  if (entity === "companies") {
    if (value.relationship !== undefined &&
        !DIRECTORY_RELATIONSHIPS.some((entry) => entry.id === value.relationship)) {
      return invalid("relationship must be customer, talking, dormant or prospect");
    }
    for (const key of ["lastTouchAfter", "lastTouchBefore"]) {
      if (value[key] !== undefined && (typeof value[key] !== "string" || !DAY.test(value[key]))) {
        return invalid(`${key} must be YYYY-MM-DD`);
      }
    }
    for (const key of ["company", "primary", "unlinked"]) {
      if (value[key] !== undefined) return invalid(`Unknown companies filter: ${key}`);
    }
  } else {
    if (value.company !== undefined && (typeof value.company !== "string" || !value.company)) {
      return invalid("company must be an organization id");
    }
    for (const key of ["primary", "unlinked"]) {
      if (value[key] !== undefined && !BOOLEAN_VALUES.includes(value[key])) {
        return invalid(`${key} must be true or false`);
      }
    }
    for (const key of ["relationship", "lastTouchAfter", "lastTouchBefore"]) {
      if (value[key] !== undefined) return invalid(`Unknown people filter: ${key}`);
    }
  }
  if (value.sort !== undefined && !DIRECTORY_SORTS.some((entry) => entry.id === value.sort)) {
    return invalid("sort must be name or lastTouch");
  }
  if (value.limit !== undefined) {
    const limit = Number(value.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > DIRECTORY_PAGE_SIZE_MAX) {
      return invalid(`limit must be 1..${DIRECTORY_PAGE_SIZE_MAX}`);
    }
  }
  return "";
}

// Defaults mirror the "Active" builtin: active-only, name order, 30 per page.
export function directoryDefaults(entity) {
  return { active: "true", sort: "name", limit: DIRECTORY_PAGE_SIZE_DEFAULT };
}

// Reads effective filter state from URL search params. Every key stays in the
// API's vocabulary so a copied link replays the same query after refresh.
export function directoryStateFromUrl(url, entity) {
  const query = new URL(String(url), "https://example.invalid").searchParams;
  const state = {};
  const take = (key) => {
    const value = query.get(key);
    if (value !== null && value !== "") state[key] = value;
  };
  for (const key of [...DIRECTORY_FILTER_KEYS[entity] || [], "sort", "limit"]) take(key);
  const view = query.get("view");
  if (view) state.view = view;
  const error = validateDirectoryState(entity, state);
  if (error) return { state, error };
  return { state };
}

// Builds the API query from validated state. Only contract keys are emitted;
// view ids and UI-only keys never leave the browser.
export function directoryQueryFromState(entity, state) {
  const query = {};
  for (const key of DIRECTORY_FILTER_KEYS[entity] || []) {
    if (state?.[key] !== undefined) query[key] = String(state[key]);
  }
  query.sort = state?.sort || "name";
  query.limit = String(state?.limit || DIRECTORY_PAGE_SIZE_DEFAULT);
  if (state?.cursor) query.cursor = String(state.cursor);
  return query;
}

// Cursors bind the filter+sort form they were issued for: any filter or sort
// change restarts from the first page instead of paging a stale query.
export function dropCursor(state) {
  const next = { ...(state || {}) };
  delete next.cursor;
  return next;
}

export function firstPage(state) {
  return { ...directoryDefaults(), ...dropCursor(state) };
}

// Canonical URL always carries the effective filters explicitly, so a copied
// link stays meaningful even when the referenced personal view is unavailable
// to the reader. viewId is included only when the filters still match it.
// Relative windows ({daysAgo}) are resolved to absolute Berlin dates: the
// reader replays the same window the writer saw.
export function directoryUrl(entity, { viewId, filters, sort, limit } = {}) {
  const params = new URLSearchParams();
  if (viewId) params.set("view", viewId);
  const absolute = resolveRelativeFilters(filters);
  for (const key of DIRECTORY_FILTER_KEYS[entity] || []) {
    if (absolute?.[key] !== undefined) params.set(key, String(absolute[key]));
  }
  if (sort && sort !== "name") params.set("sort", sort);
  if (limit && Number(limit) !== DIRECTORY_PAGE_SIZE_DEFAULT) params.set("limit", String(limit));
  const query = params.toString();
  return `${sponsorsPath(entity)}${query ? `?${query}` : ""}`;
}

// Absolute dates pass through; {daysAgo} windows resolve against Berlin
// today. SINGLE canonical client resolver (review correction): nothing else
// in E modules reimplements Berlin-day math.
// INTEGRATION-TODO(D resolvedFilters): once every view carries server
// resolvedFilters, resolveEffectiveFilters already prefers them and this
// client fallback (plus its re-export in sponsor-saved-views.js) is deleted.
export function berlinTodayString(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(now);
}

export function resolveRelativeDay(value, today = berlinTodayString()) {
  if (typeof value === "string") return value;
  const daysAgo = value?.daysAgo;
  if (!Number.isInteger(daysAgo) || daysAgo < 1 || daysAgo > 730) {
    throw new Error("Invalid relative day: expected {daysAgo: 1..730}");
  }
  const midnight = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(midnight)) throw new Error("Invalid today date");
  return new Date(midnight - daysAgo * 86400000).toISOString().slice(0, 10);
}

export function resolveRelativeFilters(filters, today = berlinTodayString()) {
  if (!filters) return filters;
  const resolved = {};
  for (const [key, value] of Object.entries(filters)) {
    resolved[key] = (key === "lastTouchAfter" || key === "lastTouchBefore") && typeof value !== "string"
      ? resolveRelativeDay(value, today)
      : value;
  }
  return resolved;
}

function humanTouch(value, humanDate) {
  if (!value) return "No recorded contact";
  return humanDate ? humanDate(value) : String(value).slice(0, 10);
}

// Compact company row: identity, relationship, primary person, last touch,
// open deals. No note paragraphs, no deal lists, no mail or finance — those
// live in the record. The name is a real canonical link (modifier-click and
// open-in-new-tab keep working; the integration hunk handles plain clicks via
// the data-open-company hook), so there is no separate Open button to clip on
// narrow screens.
export function renderCompanyRow(item, { escapeHtml, humanDate, recordPath }) {
  const primary = item.primaryPerson;
  const openDeals = Number(item.openDealCount || 0);
  const href = recordPath ? recordPath("company", item.id) : `/sponsors/companies/${encodeURIComponent(item.id)}`;
  return html`<article class="crm-directory-row crm-dir-row" data-dir-company="${escapeHtml(item.id)}">
    <div class="crm-dir-identity">
      <strong><a href="${escapeHtml(href)}" data-open-company="${escapeHtml(item.id)}">${escapeHtml(item.displayName || "Unnamed company")}</a></strong>
      ${item.domain ? html`<span class="crm-dir-domain">${escapeHtml(item.domain)}</span>` : ""}
      <p>${escapeHtml(relationshipLabel(item.relationship))}${item.active === false ? " · Archived" : ""}</p>
    </div>
    <div class="crm-dir-context">
      <span>${primary ? escapeHtml(primary.name || "Unnamed contact") : "No primary contact"}</span>
      ${primary?.email ? html`<span class="crm-dir-domain">${escapeHtml(primary.email)}</span>` : ""}
    </div>
    <div class="crm-dir-meta">
      <span>${escapeHtml(humanTouch(item.lastTouch, humanDate))}</span>
      <span>${openDeals === 1 ? "1 open deal" : `${openDeals} open deals`}</span>
    </div>
  </article>`;
}

// Compact person row: name, company (or an honest Unlinked), role,
// preferred email, primary flag, last touch. Never invents a company. Same
// real-link pattern as company rows: no Open button.
export function renderPersonRow(item, { escapeHtml, humanDate, recordPath }) {
  const email = Array.isArray(item.emails) && item.emails.length ? item.emails[0] : "";
  const href = recordPath ? recordPath("person", item.id) : `/sponsors/people/${encodeURIComponent(item.id)}`;
  return html`<article class="crm-directory-row crm-dir-row" data-dir-person="${escapeHtml(item.id)}">
    <div class="crm-dir-identity">
      <strong><a href="${escapeHtml(href)}" data-open-person="${escapeHtml(item.id)}">${escapeHtml(item.name || "Unnamed person")}</a></strong>
      ${item.primary ? html`<span class="crm-dir-badge">Primary</span>` : ""}
      <p>${item.companyName ? escapeHtml(item.companyName) : "Unlinked"}${item.active === false ? " · Archived" : ""}</p>
    </div>
    <div class="crm-dir-context">
      <span>${escapeHtml(item.role || "No role recorded")}</span>
      <span class="crm-dir-domain">${escapeHtml(email || "No email")}</span>
    </div>
    <div class="crm-dir-meta">
      <span>${escapeHtml(humanTouch(item.lastTouch, humanDate))}</span>
    </div>
  </article>`;
}

function relationshipLabel(id) {
  return DIRECTORY_RELATIONSHIPS.find((entry) => entry.id === id)?.label || "Prospect";
}

export function renderDirectoryEmpty(entity, { hasFilters }) {
  const noun = entity === "companies" ? "companies" : "people";
  return hasFilters
    ? html`<div class="honest-state" data-dir-empty>
        <strong>No ${noun} match these filters</strong>
        <p>Adjust the filters or pick another saved view.</p>
      </div>`
    : html`<div class="honest-state" data-dir-empty>
        <strong>No ${noun} yet</strong>
        <p>${entity === "companies" ? "Add the first sponsor company to start the directory." : "People appear here once contacts are added to a company."}</p>
      </div>`;
}

export function renderDirectoryError({ message, escapeHtml }) {
  const detail = message && escapeHtml ? escapeHtml(message) : "";
  return html`<div class="honest-state" data-dir-error>
    <strong>Could not load this directory</strong>
    <p>Permission or API error. Reopen the directory to retry.</p>
    ${detail ? html`<p data-dir-error-detail>${detail}</p>` : ""}
    <button type="button" data-dir-retry>Retry</button>
  </div>`;
}

export function renderDirectoryStatus({ shown, total }) {
  const count = Number(total || 0);
  const seen = Number(shown || 0);
  return `${seen} of ${count} ${count === 1 ? "record" : "records"}`;
}

export function renderDirectoryPagination({ hasPrev, hasNext }) {
  return html`<div class="crm-dir-pages">
    <button type="button" data-dir-prev${hasPrev ? "" : " disabled"}>Previous</button>
    <button type="button" data-dir-next${hasNext ? "" : " disabled"}>Next</button>
  </div>`;
}

// Filter toolbar: one compact primary row (search, Show, Sort) plus a
// collapsed disclosure for secondary fields, so the first record is visible
// without scrolling past six full-height controls. Every control maps to an
// API-exact filter key. The People company control is a searchable
// name picker over a bounded D companies search (never a raw id input): the
// selected organization id stays in the URL while the visible option shows
// its name, including a selected company that fell off the current options
// page via selectedCompanyName.
export function renderDirectoryFilters(entity, state, { escapeHtml, companyOptions = [], selectedCompanyName = "" } = {}) {
  const value = state || {};
  const option = (id, label, selected) =>
    html`<option value="${escapeHtml(id)}"${selected ? " selected" : ""}>${escapeHtml(label)}</option>`;
  const showSelect = html`<label>Show <select data-dir-filter="active">
    ${option("true", "Active", (value.active || "true") === "true")}
    ${option("false", "Archived", value.active === "false")}
    ${option("all", "All", value.active === "all")}
  </select></label>`;
  const sortSelect = html`<label>Sort <select data-dir-sort>
    ${DIRECTORY_SORTS.map((entry) => option(entry.id, entry.label, (value.sort || "name") === entry.id)).join("")}
  </select></label>`;
  const more = (controls) => html`<details class="crm-dir-more-filters">
    <summary>More filters</summary>
    <div class="crm-dir-more-filters__body">${controls}</div>
  </details>`;
  if (entity === "companies") {
    const searchLabel = "Search companies";
    return html`<div class="crm-dir-filters">
      <label>${searchLabel} <input data-dir-search type="search" placeholder="Company or domain" value="${escapeHtml(value.search || "")}" /></label>
      ${showSelect}
      ${sortSelect}
      ${more(html`<label>Relationship <select data-dir-filter="relationship">
          ${option("", "Any", !value.relationship)}
          ${DIRECTORY_RELATIONSHIPS.map((entry) => option(entry.id, entry.label, value.relationship === entry.id)).join("")}
        </select></label>
        <label>Contacted after <input data-dir-filter="lastTouchAfter" type="date" value="${escapeHtml(value.lastTouchAfter || "")}" /></label>
        <label>Contacted before <input data-dir-filter="lastTouchBefore" type="date" value="${escapeHtml(value.lastTouchBefore || "")}" /></label>`)}
    </div>`;
  }
  const selectedId = value.company || "";
  const knownIds = new Set(companyOptions.map((entry) => entry.id));
  const offPage = selectedId && !knownIds.has(selectedId)
    ? option(selectedId, selectedCompanyName || `Company ${selectedId}`, true)
    : "";
  const companyPicker = html`<div class="crm-dir-company-picker">
    <label>Company <input data-dir-company-search type="search" placeholder="Search companies" autocomplete="off" /></label>
    <select data-dir-filter="company" aria-label="Company">
      ${option("", "Any company", !selectedId)}
      ${companyOptions.map((entry) => option(entry.id, entry.name, selectedId === entry.id)).join("")}
      ${offPage}
    </select>
  </div>`;
  return html`<div class="crm-dir-filters">
    <label>Search people <input data-dir-search type="search" placeholder="Name, email or company" value="${escapeHtml(value.search || "")}" /></label>
    ${showSelect}
    ${sortSelect}
    ${more(html`${companyPicker}
      <label>Primary contact <select data-dir-filter="primary">
        ${option("", "Any contact", !value.primary)}
        ${option("true", "Primary only", value.primary === "true")}
        ${option("false", "Not primary", value.primary === "false")}
      </select></label>
      <label>Link <select data-dir-filter="unlinked">
        ${option("", "Linked and unlinked", !value.unlinked)}
        ${option("false", "Linked only", value.unlinked === "false")}
        ${option("true", "Unlinked only", value.unlinked === "true")}
      </select></label>`)}
  </div>`;
}

// Static section skeleton. Rows, status and views fill the data-dir-* slots;
// the integration hunk wires fetching and events around it.
export function directorySectionMarkup(entity, { state, escapeHtml, createHtml = "", viewsHtml = "" }) {
  const title = entity === "companies" ? "Companies" : "People";
  const headingId = entity === "companies" ? "crm-dir-companies-heading" : "crm-dir-people-heading";
  return html`<section class="crm-directory crm-dir" data-dir-root="${entity}" aria-labelledby="${headingId}">
    <header class="section-header">
      <div class="dk-collection-header__lead">
        <h3 id="${headingId}">${title}</h3>
        ${createHtml}
      </div>
      <span class="dk-split__count" data-dir-status></span>
    </header>
    <div data-dir-views>${viewsHtml}</div>
    ${renderDirectoryFilters(entity, state, { escapeHtml })}
    <p data-dir-message class="surface-status" role="status" hidden></p>
    <div data-dir-rows></div>
    <div data-dir-pages></div>
  </section>`;
}
