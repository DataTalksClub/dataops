import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CRM_MORE_LINKS,
  CRM_PRIMARY_TABS,
  crmNavModel,
  renderCrmNav,
} from "../src/surfaces/finance/sponsor-navigation.js";
import {
  DIRECTORY_FILTER_KEYS,
  directoryDefaults,
  directoryQueryFromState,
  directoryStateFromUrl,
  directoryUrl,
  dropCursor,
  firstPage,
  renderCompanyRow,
  renderDirectoryEmpty,
  renderDirectoryError,
  renderDirectoryFilters,
  renderDirectoryPagination,
  renderDirectoryStatus,
  renderPersonRow,
  validateDirectoryState,
} from "../src/surfaces/finance/sponsor-directory.js";
import {
  archiveSavedView,
  defaultViewForEntity,
  fetchViews,
  isBuiltinView,
  isVersionConflict,
  renderSavedViewBar,
  renderSavedViewManageList,
  resolveEffectiveFilters,
  saveView,
  updateSavedView,
  validateViewFilters,
  validateViewName,
  validateViewSort,
} from "../src/surfaces/finance/sponsor-saved-views.js";

const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");
const rows = { escapeHtml, humanDate: (value) => String(value).slice(0, 10) };

// --- Navigation: Pipeline · Companies · People primary, More secondary ---

test("primary navigation is Pipeline, Companies, People with canonical list paths", async () => {
  assert.deepEqual(CRM_PRIMARY_TABS.map(({ id }) => id), ["pipeline", "companies", "people"]);
  assert.deepEqual(CRM_MORE_LINKS.map(({ label }) => label),
    ["Lead discovery", "Newsletter sources", "Money"]);
  const routes = await import("../src/core/sponsor-routes.js");
  const model = crmNavModel("people");
  assert.deepEqual(model.primary.map(({ href }) => href),
    ["pipeline", "companies", "people"].map((tab) => routes.sponsorsPath(tab)));
  assert.equal(routes.sponsorsPath("people"), "/sponsors/people");
  assert.equal(routes.sponsorRecordPath("person", "person-1"), "/sponsors/people/person-1");
});

test("every existing canonical URL stays reachable and maps to a tab", async () => {
  const { parseWorkspaceLocation } = await import("../src/core/workspace.js");
  const at = (url) => parseWorkspaceLocation(url, new URL(url, "https://example.invalid"));
  for (const [path, tab] of Object.entries({
    "/sponsors/pipeline": "pipeline",
    "/sponsors/companies": "companies",
    "/sponsors/people": "people",
    "/sponsors/leads": "leads",
    "/sponsors/newsletters": "newsletters",
    "/sponsors/money": "money",
    "/sponsors/deals/deal-1": "pipeline",
    "/sponsors/companies/company-1": "companies",
    "/sponsors/people/person-1": "people",
    "/sponsors/leads/lead-1": "leads",
    "/sponsors/newsletters/news-1": "newsletters",
  })) {
    const route = at(path);
    assert.equal(route.sponsorsTab, tab, path);
    assert.equal(route.canonicalUrl, path, path);
  }
  assert.equal(at("/sponsors").canonicalUrl, "/sponsors/pipeline");
  assert.equal(at("/sponsors").sponsorsTab, "pipeline");
});

test("nav marks the current tab and keeps More reachable with an open state", () => {
  const markup = renderCrmNav(crmNavModel("people"), { escapeHtml });
  assert.match(markup, /data-crm-nav-tab="people" aria-current="page"/);
  assert.doesNotMatch(markup, /data-crm-nav-tab="pipeline" aria-current/);
  assert.match(markup, /<details class="crm-more" data-crm-nav-more>/);
  assert.match(markup, /href="\/sponsors\/leads"[^>]*>Lead discovery/);
  const money = renderCrmNav(crmNavModel("money"), { escapeHtml });
  assert.match(money, /<details class="crm-more" data-crm-nav-more open>/);
  assert.match(money, /data-crm-nav-tab="money" aria-current="page"/);
});

// --- Directory state: URL parsing, validation, API-exact queries ---

test("directory defaults are active-only with stable name ordering", () => {
  assert.deepEqual(directoryDefaults("companies"), { active: "true", sort: "name", limit: 30 });
  assert.deepEqual(directoryDefaults("people"), { active: "true", sort: "name", limit: 30 });
});

test("directory state validates per entity and rejects cross-entity keys", () => {
  assert.equal(validateDirectoryState("companies", { relationship: "talking", active: "all" }), "");
  assert.equal(validateDirectoryState("people", { primary: "true", unlinked: "false", company: "org-1" }), "");
  assert.match(validateDirectoryState("companies", { relationship: "vip" }), /relationship/);
  assert.match(validateDirectoryState("companies", { primary: "true" }), /Unknown companies filter/);
  assert.match(validateDirectoryState("people", { relationship: "talking" }), /Unknown people filter/);
  assert.match(validateDirectoryState("people", { lastTouchAfter: "2026-09-17" }), /Unknown people filter/);
  assert.match(validateDirectoryState("companies", { lastTouchAfter: "next friday" }), /YYYY-MM-DD/);
  assert.match(validateDirectoryState("companies", { sort: "value" }), /sort/);
  assert.match(validateDirectoryState("companies", { limit: "500" }), /limit/);
  assert.match(validateDirectoryState("deals", {}), /Unknown directory/);
});

test("URL state round-trips through the canonical URL with effective filters", () => {
  const { state, error } = directoryStateFromUrl(
    "/sponsors/companies?view=builtin:companies:active&relationship=talking&active=true&sort=lastTouch", "companies");
  assert.equal(error, undefined);
  assert.equal(state.view, "builtin:companies:active");
  assert.equal(state.relationship, "talking");
  const url = directoryUrl("companies", { viewId: null, filters: state, sort: state.sort });
  assert.match(url, /\/sponsors\/companies\?/);
  assert.match(url, /relationship=talking/);
  assert.match(url, /sort=lastTouch/);
  const again = directoryStateFromUrl(url, "companies");
  assert.equal(again.error, undefined);
  assert.equal(again.state.relationship, "talking");
  // Defaults stay clean: no view, default sort and page size are implicit.
  assert.equal(directoryUrl("people", { filters: { active: "true" }, sort: "name" }), "/sponsors/people?active=true");
});

test("API queries emit only contract keys with bounded paging", () => {
  const query = directoryQueryFromState("companies",
    { relationship: "talking", view: "builtin:x", cursor: "bound-cursor", limit: 30 });
  assert.deepEqual(query, { relationship: "talking", sort: "name", direction: "asc", limit: "30", cursor: "bound-cursor" });
  const people = directoryQueryFromState("people", { unlinked: "true" });
  assert.deepEqual(people, { unlinked: "true", sort: "name", direction: "asc", limit: "30" });
  assert.deepEqual(directoryQueryFromState("companies", { sort: "lastTouch" }),
    { sort: "lastTouch", direction: "desc", limit: "30" });
  // Changing filters drops the bound cursor instead of paging a stale query.
  assert.deepEqual(dropCursor({ search: "acme", cursor: "abc" }), { search: "acme" });
  assert.equal(firstPage({ search: "acme", cursor: "abc", sort: "lastTouch" }).cursor, undefined);
});

// --- Builtins are server-provided and consumed, never duplicated ---
// Fixture mirrors the D rev4 builtin shapes (resolvedFilters universal).

const SERVER_VIEWS = [
  { id: "builtin:companies:active", entity: "companies", name: "Active", builtin: true,
    filters: { active: "true" }, resolvedFilters: { active: "true" },
    sort: { field: "name", direction: "asc" } },
  { id: "builtin:companies:all", entity: "companies", name: "All", builtin: true,
    filters: { active: "all" }, resolvedFilters: { active: "all" },
    sort: { field: "name", direction: "asc" } },
  { id: "builtin:companies:recent", entity: "companies", name: "Recently contacted", builtin: true,
    filters: { active: "true", lastTouchAfter: { daysAgo: 30 } },
    resolvedFilters: { active: "true", lastTouchAfter: "2026-09-17" },
    sort: { field: "lastTouch", direction: "desc" } },
  { id: "builtin:companies:stale", entity: "companies", name: "No recent contact", builtin: true,
    filters: { active: "true", lastTouchBefore: { daysAgo: 30 } },
    resolvedFilters: { active: "true", lastTouchBefore: "2026-09-17" },
    sort: { field: "lastTouch", direction: "desc" } },
  { id: "builtin:companies:archived", entity: "companies", name: "Archived", builtin: true,
    filters: { active: "false" }, resolvedFilters: { active: "false" },
    sort: { field: "name", direction: "asc" } },
  { id: "builtin:people:active", entity: "people", name: "Active", builtin: true,
    filters: { active: "true" }, resolvedFilters: { active: "true" },
    sort: { field: "name", direction: "asc" } },
  { id: "builtin:people:all", entity: "people", name: "All", builtin: true,
    filters: { active: "all" }, resolvedFilters: { active: "all" },
    sort: { field: "name", direction: "asc" } },
  { id: "builtin:people:primary", entity: "people", name: "Primary only", builtin: true,
    filters: { active: "true", primary: "true" }, resolvedFilters: { active: "true", primary: "true" },
    sort: { field: "name", direction: "asc" } },
  { id: "builtin:people:unlinked", entity: "people", name: "Unlinked", builtin: true,
    filters: { active: "true", unlinked: "true" }, resolvedFilters: { active: "true", unlinked: "true" },
    sort: { field: "name", direction: "asc" } },
  { id: "builtin:people:archived", entity: "people", name: "Archived", builtin: true,
    filters: { active: "false" }, resolvedFilters: { active: "false" },
    sort: { field: "name", direction: "asc" } },
];

test("every server builtin executes its resolvedFilters as a directory query", () => {
  const ids = new Set();
  for (const view of SERVER_VIEWS) {
    assert.ok(view.id && !ids.has(view.id), `duplicate builtin ${view.id}`);
    ids.add(view.id);
    assert.ok(view.resolvedFilters, `${view.id} carries resolvedFilters`);
    for (const key of Object.keys(view.resolvedFilters)) {
      assert.ok(DIRECTORY_FILTER_KEYS[view.entity].includes(key), `${view.id} uses ${key}`);
    }
    assert.equal(validateDirectoryState(view.entity, { ...view.resolvedFilters, sort: view.sort.field }), "", view.id);
  }
  const recent = SERVER_VIEWS.find((view) => view.id === "builtin:companies:recent");
  assert.deepEqual(recent.resolvedFilters, { active: "true", lastTouchAfter: "2026-09-17" });
});

test("the default selection is the server's Active builtin, else its first builtin", () => {
  assert.equal(defaultViewForEntity(SERVER_VIEWS, "companies").id, "builtin:companies:active");
  assert.equal(defaultViewForEntity(SERVER_VIEWS, "people").id, "builtin:people:active");
  const rest = SERVER_VIEWS.filter((view) => view.id !== "builtin:companies:active");
  assert.equal(defaultViewForEntity(rest, "companies").id, "builtin:companies:all");
  assert.equal(defaultViewForEntity([], "companies"), null);
});

// --- Effective filters: views apply, URLs override, links survive ---

const views = [
  ...SERVER_VIEWS,
  { id: "view-1", entity: "companies", name: "My patch", builtin: false,
    filters: { active: "true", relationship: "talking" },
    resolvedFilters: { active: "true", relationship: "talking" },
    sort: { field: "name", direction: "asc" }, version: 2 },
  { id: "view-2", entity: "companies", name: "Server resolved", builtin: false,
    filters: { active: "true", lastTouchAfter: { daysAgo: 30 } },
    resolvedFilters: { active: "true", lastTouchAfter: "2026-09-17" },
    sort: { field: "lastTouch", direction: "desc" }, version: 1 },
];

test("selecting a view applies its stored filters and keeps its id", () => {
  const resolved = resolveEffectiveFilters({
    entity: "companies", views, selectedViewId: "view-1", urlState: {},
  });
  assert.deepEqual(resolved.filters, { active: "true", relationship: "talking" });
  assert.equal(resolved.sort, "name");
  assert.equal(resolved.viewId, "view-1");
  assert.equal(resolved.modified, false);
});

test("explicit URL filters override the view and unpin its id", () => {
  const resolved = resolveEffectiveFilters({
    entity: "companies", views, selectedViewId: "view-1", urlState: { search: "acme" },
  });
  assert.equal(resolved.filters.search, "acme");
  assert.equal(resolved.filters.relationship, "talking");
  assert.equal(resolved.viewId, null);
  assert.equal(resolved.modified, true);
});

test("resolved builtin windows stay selected across refresh but freeze in copied links", () => {
  const selected = resolveEffectiveFilters({
    entity: "companies", views,
    selectedViewId: "builtin:companies:recent",
    urlState: { active: "true", lastTouchAfter: "2026-09-17" },
  });
  assert.equal(selected.viewId, "builtin:companies:recent");
  assert.equal(selected.modified, false);
  // Without the view id the frozen absolute window still replays honestly.
  const shared = resolveEffectiveFilters({
    entity: "companies", views, selectedViewId: "missing-view",
    urlState: { active: "true", lastTouchAfter: "2026-09-17" },
  });
  assert.equal(shared.viewId, null);
  assert.equal(shared.filters.lastTouchAfter, "2026-09-17");
  const lost = resolveEffectiveFilters({
    entity: "companies", views, selectedViewId: "missing-view", urlState: {},
  });
  assert.match(lost.error, /not available/);
});

test("a view without server resolvedFilters fails honestly instead of guessing", () => {
  const unresolved = resolveEffectiveFilters({
    entity: "companies",
    views: [{ id: "view-x", entity: "companies", name: "X", filters: { active: "true" } }],
    selectedViewId: "view-x",
    urlState: {},
  });
  assert.match(unresolved.error, /could not be resolved/);
});

test("default with no selection is the Active builtin behavior", () => {
  const resolved = resolveEffectiveFilters({ entity: "people", views, selectedViewId: null, urlState: {} });
  assert.deepEqual(resolved.filters, { active: "true" });
  assert.equal(resolved.viewId, null);
});

test("server resolvedFilters win over stored relative windows", () => {
  const resolved = resolveEffectiveFilters({
    entity: "companies", views, selectedViewId: "view-2", urlState: {},
  });
  assert.deepEqual(resolved.filters, { active: "true", lastTouchAfter: "2026-09-17" });
  assert.equal(resolved.viewId, "view-2");
});

test("a failed views fetch is honest: error without usable URL filters", () => {
  const failed = resolveEffectiveFilters({
    entity: "companies", views: null, viewsError: "Saved views unavailable: 500", urlState: {},
  });
  assert.match(failed.error, /Saved views unavailable/);
  const usable = resolveEffectiveFilters({
    entity: "companies", views: null, viewsError: "Saved views unavailable: 500",
    urlState: { search: "acme" },
  });
  assert.equal(usable.filters.search, "acme");
  assert.equal(usable.viewId, null);
  const bar = renderSavedViewBar({ entity: "companies", views: null, viewsError: "boom", escapeHtml });
  assert.match(bar, /data-views-error/);
  assert.match(bar, /data-views-retry/);
  assert.doesNotMatch(bar, /data-views-select/);
});

// --- Compact rows: identity and context only, honest gaps ---

test("company rows show identity, relationship, primary person, last touch and open deals", () => {
  const markup = renderCompanyRow({
    id: "org-1", displayName: "Acme", domain: "acme.example", relationship: "talking", active: true,
    primaryPerson: { id: "p-1", name: "Ada", email: "ada@acme.example" },
    lastTouch: "2026-10-09T10:00:00Z", openDealCount: 2,
  }, rows);
  assert.match(markup, /Acme/);
  assert.match(markup, /acme\.example/);
  assert.match(markup, /Talking/);
  assert.match(markup, /Ada/);
  assert.match(markup, /ada@acme\.example/);
  assert.match(markup, /2026-10-09/);
  assert.match(markup, /2 open deals/);
  assert.match(markup, /<a href="\/sponsors\/companies\/org-1" data-open-company="org-1">Acme<\/a>/);
  assert.doesNotMatch(markup, /<button/);
  assert.doesNotMatch(markup, /data-href/);
  for (const leak of ["mail", "notes", "finance", "invoice"]) {
    assert.doesNotMatch(markup, new RegExp(leak, "i"), `row leaks ${leak}`);
  }
});

test("company rows stay honest without a primary person, touch or deals", () => {
  const markup = renderCompanyRow({
    id: "org-2", displayName: "Quiet <Co>", relationship: "prospect", active: false,
    primaryPerson: null, lastTouch: null, openDealCount: 0,
  }, rows);
  assert.match(markup, /Quiet &lt;Co&gt;/);
  assert.match(markup, /No primary contact/);
  assert.match(markup, /No recorded contact/);
  assert.match(markup, /0 open deals/);
  assert.match(markup, /Archived/);
});

test("person rows never invent a company and surface role plus preferred email", () => {
  const linked = renderPersonRow({
    id: "p-1", organizationId: "org-1", companyName: "Acme", name: "Ada", emails: ["ada@acme.example", "other@example.test"],
    primary: true, role: "CTO", lastTouch: "2026-10-01T00:00:00Z", active: true,
  }, rows);
  assert.match(linked, /Ada/);
  assert.match(linked, /Primary/);
  assert.match(linked, /Acme/);
  assert.match(linked, /CTO/);
  assert.match(linked, /ada@acme\.example/);
  assert.doesNotMatch(linked, /other@example\.test/);
  const unlinked = renderPersonRow({
    id: "p-2", companyName: null, name: "Bo", emails: [], active: true, lastTouch: null,
  }, rows);
  assert.match(unlinked, /Unlinked/);
  assert.match(unlinked, /No role recorded/);
  assert.match(unlinked, /No email/);
  assert.match(unlinked, /<a href="\/sponsors\/people\/p-2" data-open-person="p-2">Bo<\/a>/);
  assert.doesNotMatch(unlinked, /<button/);
});

// --- Empty, error, paging and filter markup ---

test("empty and error states explain what happened and what to do next", () => {
  const filtered = renderDirectoryEmpty("companies", { hasFilters: true });
  assert.match(filtered, /No companies match these filters/);
  const fresh = renderDirectoryEmpty("people", { hasFilters: false });
  assert.match(fresh, /No people yet/);
  const error = renderDirectoryError({ message: "boom <", escapeHtml });
  assert.match(error, /Could not load this directory/);
  assert.match(error, /boom &lt;/);
  assert.match(error, /data-dir-retry/);
});

test("status counts and paging disable honestly at the bounds", () => {
  assert.equal(renderDirectoryStatus({ shown: 30, total: 42 }), "30 of 42 records");
  assert.equal(renderDirectoryStatus({ shown: 1, total: 1 }), "1 of 1 record");
  const first = renderDirectoryPagination({ hasPrev: false, hasNext: true });
  assert.match(first, /data-dir-prev disabled/);
  assert.doesNotMatch(first, /data-dir-next disabled/);
});

test("filter toolbars are one compact row with secondary fields collapsed", () => {
  const companies = renderDirectoryFilters("companies", { relationship: "talking" }, { escapeHtml });
  assert.match(companies, /data-dir-search/);
  assert.match(companies, /<details class="crm-dir-more-filters">/);
  assert.match(companies, /data-dir-filter="relationship"/);
  assert.match(companies, /data-dir-filter="lastTouchAfter"/);
  // Search, Show and Sort stay outside the disclosure.
  const primary = companies.slice(0, companies.indexOf("<details"));
  assert.match(primary, /data-dir-search/);
  assert.match(primary, /data-dir-filter="active"/);
  assert.match(primary, /data-dir-sort/);
  assert.doesNotMatch(companies, /data-dir-filter="company"/);
});

test("people company scoping is a searchable name picker, never an id input", () => {
  const people = renderDirectoryFilters("people", { primary: "true" },
    { escapeHtml, companyOptions: [{ id: "org-1", name: "Acme" }] });
  assert.match(people, /data-dir-company-search/);
  assert.match(people, /<select data-dir-filter="company" aria-label="Company">/);
  assert.match(people, /value="org-1">Acme/);
  assert.doesNotMatch(people, /placeholder="Company id"/);
  assert.match(people, /Primary contact <select data-dir-filter="primary">/);
  assert.doesNotMatch(people, /Role <select/);
  assert.match(people, /data-dir-filter="unlinked"/);
  assert.doesNotMatch(people, /data-dir-filter="relationship"/);
  // A selected company off the current options page still shows its name.
  const offPage = renderDirectoryFilters("people", { company: "org-9" },
    { escapeHtml, companyOptions: [{ id: "org-1", name: "Acme" }], selectedCompanyName: "Faraway Inc" });
  assert.match(offPage, /<option value="org-9" selected>Faraway Inc<\/option>/);
  // Without a known name the id is shown honestly as an id, never invented.
  const unknown = renderDirectoryFilters("people", { company: "org-9" }, { escapeHtml, companyOptions: [] });
  assert.match(unknown, /<option value="org-9" selected>Company org-9<\/option>/);
  assert.doesNotMatch(unknown, /Company id/);
});

// --- Saved views client: persisted personal views, immutable builtins ---

function stubApi(calls) {
  return async (path, options = {}) => {
    calls.push({ path, ...options });
    return { ok: true };
  };
}

test("views client hits the workspace endpoints with the contract shapes", async () => {
  const calls = [];
  const api = stubApi(calls);
  await fetchViews(api, "companies");
  assert.equal(calls[0].path, "/api/sponsor-crm/views?entity=companies");
  await saveView(api, { entity: "people", name: " Mine ", filters: { active: "true" }, sourceKey: "k-1" });
  assert.equal(calls[1].method, "POST");
  assert.deepEqual(JSON.parse(calls[1].body),
    { entity: "people", name: "Mine", filters: { active: "true" }, sourceKey: "k-1" });
  await updateSavedView(api, "view-1",
    { name: "Renamed", filters: { active: "all" }, sort: { field: "name", direction: "asc" }, version: 2 });
  assert.equal(calls[2].path, "/api/sponsor-crm/views/view-1");
  assert.equal(calls[2].method, "PUT");
  assert.equal(JSON.parse(calls[2].body).version, 2);
  await archiveSavedView(api, "view-1");
  assert.equal(calls[3].method, "DELETE");
  // Saved filters are absolute server-resolved values; the server floats
  // relative windows from the stored form.
  await saveView(api, { entity: "companies", name: "Recent",
    filters: { active: "true", lastTouchAfter: "2026-09-17" },
    sort: { field: "lastTouch", direction: "desc" } });
  assert.match(calls[4].body, /"lastTouchAfter":"2026-09-17"/);
});

test("builtins cannot be written and bad input fails before the network", async () => {
  const api = stubApi([]);
  await assert.rejects(updateSavedView(api, "builtin:companies:active", { name: "X" }), /cannot be changed/);
  await assert.rejects(archiveSavedView(api, "builtin:people:all"), /cannot be archived/);
  await assert.rejects(saveView(api, { entity: "companies", name: "  ", filters: {} }), /1\.\.120/);
  await assert.rejects(saveView(api, { entity: "companies", name: "X", filters: { bogus: "1" } }), /Unknown companies/);
  assert.equal(isBuiltinView({ id: "builtin:companies:active" }), true);
  assert.equal(isBuiltinView({ id: "view-1" }), false);
  assert.equal(isVersionConflict({ status: 409 }), true);
  assert.equal(isVersionConflict({ status: 400 }), false);
  assert.equal(validateViewName("ok"), "");
  assert.equal(validateViewSort("companies", { field: "lastTouch", direction: "desc" }), "");
  assert.match(validateViewSort("companies", { field: "value", direction: "asc" }), /field/);
});

test("saved view bar groups builtins and personal views with save/update affordances", () => {
  const bar = renderSavedViewBar({ entity: "companies", views, selectedViewId: "view-1", modified: true, escapeHtml });
  assert.match(bar, /optgroup label="Built-in"/);
  assert.match(bar, /optgroup label="My views"/);
  assert.match(bar, /Modified/);
  assert.match(bar, /data-views-save/);
  assert.match(bar, /data-views-update/);
  const clean = renderSavedViewBar({
    entity: "companies", views, selectedViewId: "builtin:companies:active", modified: false, escapeHtml,
  });
  assert.doesNotMatch(clean, /data-views-update/);
  assert.doesNotMatch(clean, /Modified/);
  const manage = renderSavedViewManageList({ views, escapeHtml });
  assert.match(manage, /My patch/);
  assert.match(manage, /data-views-archive="view-1"/);
  assert.doesNotMatch(manage, /builtin:companies:active/);
});

// --- No client date math: resolution is the server's job ---

test("stored relative windows still validate, but never resolve client-side", () => {
  assert.equal(
    validateViewFilters("companies", { active: "true", lastTouchAfter: { daysAgo: 30 } }),
    "",
  );
  assert.match(
    validateViewFilters("companies", { active: "true", lastTouchAfter: { daysAgo: 0 } }),
    /daysAgo/,
  );
});
