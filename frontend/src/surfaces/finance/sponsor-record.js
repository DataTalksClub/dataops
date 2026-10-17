import { html } from "./shared.js";
import {
  activityItemMarkup,
  activityPanelMarkup,
  createActivityLoader,
  formatBerlinDate,
  formatBerlinDateTime,
  wireActivityPanel,
} from "./sponsor-activity.js";

/**
 * Company/deal record with progressive disclosure.
 *
 * Tabs: Overview · People · Activity · Deals · Finance. Only the visible tab
 * fetches. Nothing here pages whole directories: the People tab fetches
 * GET /directory/people?company=:id (bounded), the Deals tab fetches
 * GET /deals?organizationId=:id (bounded), Activity fetches
 * GET /activity/organization/:id (bounded, filterable), and Overview fetches
 * only the company projection plus an activity preview (limit 3, server-side
 * merge, no full bodies). Finance renders through the injected canonical
 * loader on first tab open per selected deal.
 *
 * Data shapes consumed (defensive: every field optional):
 *   GET /directory/companies/:id (D projection: direct lookup + summary/notes,
 *     no finance/mail/deal bodies)
 *     { id, displayName, domain, relationship, active, primaryPerson
 *       { id, name, email } | null, notes, lastTouch, lastInboundAt,
 *       lastOutboundAt, openDealCount, version, updatedAt }
 *   GET /directory/people?company=&limit=&cursor= -> { items, total, nextCursor }
 *     person: { id, organizationId, name, emails[], primary, role, linkedin,
 *       telegram, notes, lastTouch, lastInboundAt, lastOutboundAt,
 *       lastContactedAt, active, version, updatedAt } (flat A fields, never a
 *       channels object)
 *   GET /deals?organizationId=&limit=&cursor= -> { items, nextCursor }
 *
 * E (directory/navigation owner) provides: mount root
 * `[data-crm-record]`, `closeRecord` (canonical Back restoring list
 * filters/page/scroll + focus), `loadFinance(deal, panel)`, and optional
 * `openContactEditor`, `openTaskPanel`, `openCompanyRecord`, `onEditCompany`,
 * `onAddDeal`. F owns this render/controller implementation.
 */

export const RECORD_TABS = Object.freeze([
  ["overview", "Overview"],
  ["people", "People"],
  ["activity", "Activity"],
  ["deals", "Deals"],
  ["finance", "Finance"],
]);

function esc(context) {
  return typeof context?.escapeHtml === "function" ? context.escapeHtml : String;
}

function humanize(value, context) {
  if (typeof context?.humanizeOptionLabel === "function") return context.humanizeOptionLabel(value);
  return String(value ?? "").replaceAll("-", " ").replaceAll("_", " ");
}

export function loadingMarkup(label, context = {}) {
  const escape = esc(context);
  return html`<div class="honest-state"><strong>${escape(label)}…</strong></div>`;
}

export function errorMarkup(message, context = {}) {
  const escape = esc(context);
  return html`<div class="honest-state">
    <strong>Unavailable</strong>
    <p>${escape(message || "Could not load this section.")}</p>
    <button type="button" data-record-retry>Retry</button>
  </div>`;
}

export function emptyMarkup(title, hint, context = {}) {
  const escape = esc(context);
  return html`<div class="honest-state">
    <strong>${escape(title)}</strong>
    ${hint ? html`<p>${escape(hint)}</p>` : ""}
  </div>`;
}

/**
 * Lazy read-only communication archive for the selected deal
 * (CRM-PRESERVE-ARCHIVE). B's removal brief keeps existing sponsor records,
 * drafts and delivery history readable; D's unified activity does not include
 * the old SPONSOR_SEND_ATTEMPT/draft records, so the record exposes them in
 * a collapsed disclosure that loads once, on first open, through the
 * injected `loadArchive(dealId)` reader (E wires it to B's preserved read
 * paths/projection after the rebase). No draft/approve/cancel/reconcile
 * actions and no composer exist anywhere in this module.
 */
export function archiveDisclosureMarkup(archive, context = {}) {
  const escape = esc(context);
  const loaded = archive?.items?.length || 0;
  // No fake totals: show the server total only when provided, otherwise the
  // honestly loaded count.
  const count = archive && typeof archive.total === "number" ? String(archive.total) : `${loaded} loaded`;
  const canReview = typeof context?.onReviewDraft === "function";
  if (!archive || archive.status === "idle") {
    return html`<details data-record-archive>
      <summary>Archived drafts and delivery history</summary>
    </details>`;
  }
  if (archive.status === "loading" && !loaded) {
    return html`<details data-record-archive open>
      <summary>Archived drafts and delivery history</summary>
      ${loadingMarkup("Loading archive", context)}
    </details>`;
  }
  const items = archive.items || [];
  return html`<details data-record-archive open>
    <summary>Archived drafts and delivery history (${escape(count)})</summary>
    ${items.length
      ? html`<ul class="crm-activity-list">
          ${items.map((item) => html`<li class="crm-activity-item">
            <div class="crm-activity-head">
              <strong>${escape(item.label || item.kind || "Record")}</strong>
              <span>${escape(formatBerlinDate(item.createdAt))}</span>
            </div>
            ${item.preview ? html`<p>${escape(item.preview)}</p>` : ""}
            ${item.detail ? html`<details><summary>Full text</summary><p>${escape(item.detail)}</p></details>` : ""}
            ${canReview && item.reviewable
              ? html`<button type="button" data-archive-review="${escape(item.id)}" data-archive-version="${escape(String(item.version ?? ""))}">Review exact draft</button>`
              : ""}
          </li>`).join("")}
        </ul>`
      : ""}
    ${archive.status === "error"
      ? html`<div class="honest-state">
          <strong>Archive unavailable</strong>
          <p>${escape(archive.error || "Could not load the archive.")}</p>
          <button type="button" data-archive-retry>Retry</button>
        </div>`
      : ""}
    ${archive.status !== "error" && !items.length && !archive.nextCursor
      ? html`<div class="honest-state">
          <strong>No archived messages</strong>
          <p>Drafts and delivery history for this deal will appear here.</p>
        </div>`
      : ""}
    ${archive.nextCursor && archive.status === "ready"
      ? html`<button type="button" data-archive-more>Load older (${escape(count)})</button>`
      : ""}
    ${archive.status === "loading-more"
      ? html`<button type="button" disabled>Loading older…</button>`
      : ""}
  </details>`;
}

/**
 * Bounded archive pager. One explicit page per call — no silent multi-page
 * fan-out, no fake totals (`total` stays null unless the server provides
 * one), no dedupe (distinct draft versions are preserved even when they
 * share a communication id). Failed continuations keep the visible rows;
 * `retry()` resumes from the failed page.
 */
export function createArchiveLoader({ loadArchive, dealId, limit = 50 }) {
  if (typeof loadArchive !== "function") throw new Error("createArchiveLoader requires loadArchive (E-wired B read path)");
  const state = { status: "idle", items: [], nextCursor: null, total: null, error: "" };
  async function open() {
    if (state.status === "loading" || state.status === "ready") return state;
    state.status = "loading";
    state.error = "";
    state.items = [];
    state.nextCursor = null;
    try {
      const result = await loadArchive(dealId, { limit });
      state.items = result.items || [];
      state.nextCursor = result.nextCursor ?? null;
      state.total = typeof result.total === "number" ? result.total : null;
      state.status = "ready";
    } catch (error) {
      state.status = "error";
      state.error = error?.message || "Could not load the archive";
    }
    return state;
  }
  async function loadMore() {
    if (!state.nextCursor || state.status === "loading" || state.status === "loading-more") return state;
    const cursor = state.nextCursor;
    state.status = "loading-more";
    state.error = "";
    try {
      const result = await loadArchive(dealId, { cursor, limit });
      state.items = [...state.items, ...(result.items || [])];
      state.nextCursor = result.nextCursor ?? null;
      if (typeof result.total === "number") state.total = result.total;
      state.status = "ready";
    } catch (error) {
      state.status = "error";
      state.error = error?.message || "Could not load older messages";
    }
    return state;
  }
  async function retry() {
    // Resume the failed page: a set cursor always continues the
    // continuation, even when the visible row count is zero (an empty first
    // page with a cursor is valid after recordType projection). Only a
    // cursorless state restarts from the first page.
    if (state.nextCursor) return loadMore();
    state.status = "idle";
    return open();
  }
  return { state, open, loadMore, retry };
}

export function recordHeaderMarkup(company, options = {}, context = {}) {
  const escape = esc(context);
  const { selectedDeal = null, returnLabel = "Back", canArchive = false } = options;
  const primary = company?.primaryPerson;
  const showPrimary = primary !== undefined
    || (company != null && Object.prototype.hasOwnProperty.call(company, "primaryPerson"));
  const archived = Boolean(company?.archivedAt) || company?.active === false;
  return html`<header class="dk-split__head">
    <button type="button" class="dk-split__back" data-record-back>${escape(returnLabel)}</button>
    <div class="booking-detail-title">
      <h2 class="dk-split__title" data-record-title tabindex="-1">${escape(company?.displayName || "Unknown sponsor")}</h2>
      <p>
        ${company?.domain ? html`<span class="status-label" data-status="domain">${escape(company.domain)}</span>` : ""}
        ${company?.relationship ? html`<span class="status-label" data-status="${escape(company.relationship)}">${escape(humanize(company.relationship, context))}</span>` : ""}
        ${archived ? html`<span class="status-label" data-status="archived">Archived</span>` : ""}
        ${selectedDeal ? html`<span class="status-label" data-status="${escape(selectedDeal.status)}">${escape(humanize(selectedDeal.status, context))}</span>` : ""}
      </p>
      <p class="crm-record-sub">
        ${showPrimary ? (primary ? html`Primary: ${escape(primary.name || "Unnamed")}${primary.email ? html` · ${escape(primary.email)}` : ""}` : "No primary person yet") : ""}
        ${showPrimary && company?.lastTouch ? " · " : ""}${company?.lastTouch ? html`Last touch ${escape(formatBerlinDate(company.lastTouch))}` : ""}
      </p>
    </div>
    ${canArchive ? (archived
      ? html`<button type="button" data-restore-company>Restore</button>`
      : html`<button type="button" data-archive-company>Archive</button>`) : ""}
  </header>`;
}

export function recordTabsMarkup(active, context = {}) {
  const escape = esc(context);
  return html`<div class="dk-tabs" role="tablist" aria-label="Company record sections" data-record-tabs>
    ${RECORD_TABS.map(
      ([id, label]) => html`<button type="button" class="dk-tab" role="tab" id="record-tab-${id}"
        aria-selected="${id === active ? "true" : "false"}" tabindex="${id === active ? "0" : "-1"}"
        aria-controls="record-panel-${id}" data-record-tab="${id}">${escape(label)}</button>`,
    ).join("")}
  </div>`;
}

export function recordShellMarkup(company, options = {}, context = {}) {
  const { selectedDeal = null, returnLabel = "Back", activeTab = "overview" } = options;
  return html`${recordHeaderMarkup(company, { selectedDeal, returnLabel }, context)}
    ${recordTabsMarkup(activeTab, context)}
    ${RECORD_TABS.map(
      ([id]) => html`<section role="tabpanel" id="record-panel-${id}" aria-labelledby="record-tab-${id}"
        data-record-panel="${id}"${id === activeTab ? "" : " hidden"}></section>`,
    ).join("")}`;
}

/**
 * Next-action rendering driven by D canonical rows: the displayed due
 * moment is ALWAYS the effective date; the original date appears only as
 * distinct optional context, so a waiting/follow-up/snoozed task never
 * presents its old original date as the next action due.
 */
export function nextTaskMarkup(nextTask, emptyMessage, context = {}) {
  const escape = esc(context);
  if (typeof emptyMessage !== "string") {
    emptyMessage = "No open task. Nothing is due for this company.";
  }
  if (!nextTask) return html`<p>${escape(emptyMessage)}</p>`;
  const due = nextTask.effectiveDate || nextTask.date;
  const wakeup = nextTask.deferredUntil || (nextTask.deferred ? nextTask.effectiveDate : "");
  const original = nextTask.date && nextTask.date !== due ? nextTask.date : "";
  const deferredNote = nextTask.deferred
    ? html` · deferred${wakeup && wakeup !== due ? html` until ${escape(formatBerlinDate(wakeup))}` : ""}`
    : "";
  const duePart = due ? html` · ${escape(formatBerlinDate(due))}` : "";
  const originalPart = original
    ? html` <small>(originally ${escape(formatBerlinDate(original))})</small>`
    : "";
  // Readable owner via the injected ownerName(id) lookup (E's existing
  // ownerDirectory.name in pipeline use). Never a raw ID: a missing lookup
  // reads Unassigned, an unknown ID reads Unavailable assignee.
  let ownerNote = " · Unassigned";
  if (nextTask.assigneeId) {
    let name = "";
    try {
      name = typeof context.ownerName === "function" ? context.ownerName(nextTask.assigneeId) : "";
    } catch {
      name = "";
    }
    ownerNote = name ? ` · ${name}` : " · Unavailable assignee";
  }
  const ownerPart = html`<span>${escape(ownerNote)}</span>`;
  const taskButton = nextTask.taskId
    ? html`<button type="button" data-open-task="${escape(nextTask.taskId)}">Open task</button>`
    : "";
  return html`<p><strong>${escape(nextTask.description || "Open task")}</strong>${duePart}${ownerPart}${deferredNote}${originalPart}</p>
    ${taskButton}`;
}

export function overviewMarkup({ company, primaryPerson, nextTask, recent, relatedWork = [], activityError = "" }, context = {}) {
  const escape = esc(context);
  // An absent primaryPerson (cheap D summary) renders a View People action,
  // never a no-contact claim.
  const person = primaryPerson !== undefined ? primaryPerson : company?.primaryPerson;
  if (activityError) {
    // Unknown, not empty: identity and the verified company summary stay,
    // but nothing claims what the unloaded activity would have shown.
    return html`<div class="crm-record-overview">
    ${company?.notes
      ? html`<section aria-label="Company summary">
          <h3>Company summary</h3>
          <p>${escape(company.notes)}</p>
        </section>`
      : ""}
    ${errorMarkup(activityError, context)}
  </div>`;
  }
  // Deferred-only related work is verified non-due: say so instead of
  // claiming nothing is open.
  const emptyNote = relatedWork.length
    ? "No task due now. Related work is listed under Activity."
    : "No open task. Nothing is due for this company.";
  return html`<div class="crm-record-overview">
    <section aria-label="Next action">
      <h3>Next action</h3>
      ${nextTaskMarkup(nextTask, emptyNote, context)}
    </section>
    <section aria-label="Primary person">
      <h3>Primary person</h3>
      ${person
        ? html`<p>${escape(person.name || "Unnamed")}${person.email ? html` · ${escape(person.email)}` : ""}</p>`
        : html`<p><button type="button" data-goto-people>View People</button></p>`}
    </section>
    ${company?.notes
      ? html`<section aria-label="Company summary">
          <h3>Company summary</h3>
          <p>${escape(company.notes)}</p>
        </section>`
      : ""}
    <section aria-label="Recent activity">
      <h3>Recent activity</h3>
      ${(recent?.length
        ? html`<ul class="crm-activity-list">${recent.map((item) => activityItemMarkup(item, context)).join("")}</ul>`
        : html`<p>No recent activity.</p>`)}
    </section>
  </div>`;
}

export function peopleListMarkup({ items, total, canEdit }, context = {}) {
  const escape = esc(context);
  if (!items?.length) {
    return emptyMarkup("No people yet", "Add the first person for this company.", context)
      + (canEdit ? html`<button type="button" data-add-person>Add person</button>` : "");
  }
  return html`${typeof total === "number" ? html`<p class="dk-split__count">${escape(String(total))} ${total === 1 ? "person" : "people"}</p>` : ""}
    <ul class="crm-directory-list">
    ${items
      .map(
        (person) => html`<li class="crm-directory-row">
          <div>
            <strong>${escape(person.name || "Unnamed")}</strong>
            ${person.primary ? html` <span class="status-label" data-status="primary">Primary</span>` : ""}
            <p>${[
              person.role || "",
              person.emails?.[0] || "",
              person.lastTouch ? `Last touch ${formatBerlinDate(person.lastTouch)}` : "",
              // lastContactedAt keeps full stored precision (date + time);
              // it is display-only here — edits preserve it unless the user
              // changes that date (A editor contract, post-release).
              person.lastContactedAt ? `Last contacted ${formatBerlinDateTime(person.lastContactedAt)}` : "",
            ].filter(Boolean).map((value) => escape(value)).join(" · ")}</p>
          </div>
          <div class="row-actions">
            <button type="button" data-open-person="${escape(person.id)}">Open</button>
            ${canEdit ? html`<button type="button" data-edit-person="${escape(person.id)}">Edit</button>` : ""}
          </div>
        </li>`,
      )
      .join("")}
    </ul>
    ${canEdit ? html`<button type="button" data-add-person>Add person</button>` : ""}`;
}

export function dealsListMarkup({ deals, selectedDealId, canAdd = false }, context = {}) {
  const escape = esc(context);
  if (!deals?.length) {
    return emptyMarkup("No deals", "Add a deal for this company.", context)
      + (canAdd ? html`<button type="button" data-add-deal>Add deal</button>` : "");
  }
  return html`<ul class="crm-directory-list">
    ${deals
      .map((deal) => {
        const task = deal.openTasks?.[0];
        const next = task
          ? `${task.description} · ${formatBerlinDate(task.date)}`
          : deal.status === "lost" ? "" : "No open task";
        const current = selectedDealId === deal.id;
        return html`<li><article class="crm-card crm-company-deal"${current ? ' aria-current="true"' : ""}>
          <div class="crm-deal-card-header">
            <strong>${escape(({ "one-off": "One-off", package: "Package", course: "Course" }[deal.productKind]) || humanize(deal.productKind || "deal", context))}</strong>
            <span class="status-label" data-status="${escape(deal.status)}">${escape(humanize(deal.status, context))}</span>
          </div>
          <p class="crm-deal-meta">${[next].filter(Boolean).map((value) => escape(value)).join(" · ")}</p>
    <div class="row-actions">
            <button type="button" data-select-deal="${escape(deal.id)}"${current ? " disabled" : ""}>${current ? "Selected" : "Select deal"}</button>
          </div>
        </article></li>`;
      })
      .join("")}
  </ul>
  ${canAdd ? html`<button type="button" data-add-deal>Add deal</button>` : ""}`;
}

/**
 * Company/deal record controller. Renders into
 * `surface.querySelector("[data-crm-record]")` (E-owned mount).
 */
export function createSponsorRecord(context) {
  const { api, surface, closeRecord, loadFinance } = context;
  if (typeof api !== "function") throw new Error("createSponsorRecord requires api");
  if (!surface) throw new Error("createSponsorRecord requires surface");
  if (typeof closeRecord !== "function") throw new Error("createSponsorRecord requires closeRecord (E integration)");
  if (typeof loadFinance !== "function") throw new Error("createSponsorRecord requires loadFinance (canonical finance component)");
  const fail = typeof context.safe === "function" ? context.safe : async (action) => action();
  const canEditPerson = typeof context.openContactEditor === "function";
  let record = null;
  let token = 0;
  let closer = (...args) => closeRecord(...args);

  function closeWith(next) {
    if (typeof next === "function") closer = next;
  }

  function root() {
    return surface.querySelector("[data-crm-record]");
  }

  function panel(name) {
    return root()?.querySelector(`[data-record-panel="${name}"]`);
  }

  function paintTabs(active) {
    // Update the existing buttons in place: replacing the tablist markup
    // here would nest a new tablist inside the current one.
    const tabs = root()?.querySelector("[data-record-tabs]");
    if (!tabs) return;
    for (const button of tabs.querySelectorAll('[role="tab"]')) {
      const selected = button.dataset?.recordTab === active;
      button.setAttribute("aria-selected", String(selected));
      button.setAttribute("tabindex", selected ? "0" : "-1");
    }
  }

  function showTab(active) {
    for (const [id] of RECORD_TABS) {
      const section = panel(id);
      if (section) section.hidden = id !== active;
    }
    paintTabs(active);
    if (record) record.activeTab = active;
  }

  function headerOptions() {
    return {
      selectedDeal: record?.selectedDeal || null,
      returnLabel: record?.returnLabel || "Back",
      // E asked for Archive/Restore in the record header (old per-row list
      // Archive goes away with integration); the buttons render only when
      // the migration wires the handlers.
      canArchive: typeof context.onArchiveCompany === "function" || typeof context.onRestoreCompany === "function",
    };
  }

  function paintHeader() {
    const host = root();
    if (!host || !record) return;
    const header = host.querySelector("[data-record-header]");
    if (header) {
      header.innerHTML = recordHeaderMarkup(record.company, headerOptions(), context);
    }
  }

  async function openCompany(companyId, { dealId = null, returnLabel = "Back" } = {}) {
    const mine = ++token;
    const host = root();
    if (!host) throw new Error("createSponsorRecord: missing [data-crm-record] mount (E integration)");
    record = {
      companyId, company: null, deals: [], selectedDealId: dealId,
      selectedDeal: null, activeTab: "overview", returnLabel,
      loaded: new Set(), cursors: {}, people: [], dealsLoaded: false,
      preview: { items: [], relatedWork: [] },
    };
    host.innerHTML = loadingMarkup("Loading company", context);
    // The company summary is D's cheap projection (GET
    // /directory/companies/:id): direct lookup + notes, no finance/mail/deal
    // bodies. No snapshot fallback and no legacy single-record enrichment —
    // a missing D route is an honest error, never a silent downgrade.
    let company;
    try {
      company = await api(`/directory/companies/${encodeURIComponent(companyId)}`);
    } catch (error) {
      if (mine !== token) return record;
      host.innerHTML = error?.status === 404
        ? emptyMarkup("Company not found", "It may have been archived or removed.", context)
        : errorMarkup(error?.message, context);
      return record;
    }
    if (mine !== token) return record;
    record.company = company || {};
    host.innerHTML = html`<div data-record-header>${recordHeaderMarkup(record.company, headerOptions(), context)}</div>
      ${recordTabsMarkup("overview", context)}
      ${RECORD_TABS.map(
        ([id]) => html`<section role="tabpanel" id="record-panel-${id}" aria-labelledby="record-tab-${id}"
          data-record-panel="${id}"${id === "overview" ? "" : " hidden"}></section>`,
      ).join("")}`;
    host.querySelector("[data-record-title]")?.focus?.();
    await loadOverview(mine);
    return record;
  }

  async function loadOverview(mine) {
    if (mine !== undefined && mine !== token) return;
    const target = panel("overview");
    if (!target || !record) return;
    target.innerHTML = loadingMarkup("Loading overview", context);
    const loader = createActivityLoader({
      api, targetType: "organization", targetId: record.companyId, limit: 3,
    });
    await loader.load();
    if ((mine !== undefined && mine !== token) || !record) return;
    if (loader.state.status === "error") {
      // Unknown, not empty: render no content claims, only the error.
      target.innerHTML = overviewMarkup({
        company: record.company, activityError: loader.state.error,
      }, context);
      return;
    }
    record.preview = { items: loader.state.items, relatedWork: loader.state.relatedWork };
    target.innerHTML = overviewMarkup({
      company: record.company,
      primaryPerson: record.company.primaryPerson,
      // D rev 4 orders relatedWork eligible-first with an exact boolean;
      // consume it strictly (no older-shape fallback — no compat shims).
      nextTask: loader.state.relatedWork.find((task) => task.eligible === true) || null,
      recent: loader.state.items.slice(0, 3),
      relatedWork: loader.state.relatedWork,
    }, context);
    record.loaded.add("overview");
  }

  async function loadPeople(mine) {
    const target = panel("people");
    if (!target || !record) return;
    target.innerHTML = loadingMarkup("Loading people", context);
    try {
      const query = new URLSearchParams({ company: record.companyId, limit: "30" });
      const append = Boolean(record.cursors.people);
      if (append) query.set("cursor", record.cursors.people);
      const result = await api(`/directory/people?${query}`);
      if (mine !== undefined && mine !== token) return;
      const items = append ? [...(record.people || []), ...(result.items || [])] : (result.items || []);
      record.people = items;
      record.cursors.people = result.nextCursor ?? null;
      target.innerHTML = peopleListMarkup({ items, total: result.total, canEdit: canEditPerson }, context)
        + (record.cursors.people
          ? html`<button type="button" data-people-more>Show more people</button>`
          : "");
      record.loaded.add("people");
    } catch (error) {
      if (mine !== undefined && mine !== token) return;
      target.innerHTML = errorMarkup(error?.message, context);
    }
  }

  async function loadActivity(mine) {
    const target = panel("activity");
    if (!target || !record) return;
    // One loader + one wiring per record: rapid Activity clicks reuse them
    // instead of duplicating fetches and listeners.
    if (!record.activityLoader) {
      record.activityLoader = createActivityLoader({ api, targetType: "organization", targetId: record.companyId });
      const withArchive = typeof context.loadArchive === "function";
      target.innerHTML = activityPanelMarkup({ targetType: "organization" })
        + (withArchive ? html`<div data-record-archive-host></div>` : "");
      record.activityWired = wireActivityPanel(target, record.activityLoader, {
        ...context,
        openTaskPanel: typeof context.openTaskPanel === "function" ? context.openTaskPanel : undefined,
      });
      if (withArchive) {
        paintArchive(target, null);
        wireArchive(target);
      }
    }
    // Single-flight: a second click while the first page is in flight is a
    // no-op; the stale-generation check below runs before any shared flag
    // mutation so a deferred load can never clear a newer request's flag.
    if (record.loaded.has("activity") || record.activityLoading) return;
    record.activityLoading = true;
    record.activityWired.paint();
    await record.activityLoader.load();
    if (mine !== undefined && mine !== token) return;
    record.activityLoading = false;
    record.activityWired.paint();
    if (record.activityLoader.state.status === "ready") record.loaded.add("activity");
  }

  function archiveLoaderFor() {
    if (typeof context.loadArchive !== "function" || !record?.selectedDeal) return null;
    const key = `archive:${record.selectedDeal.id}`;
    if (!record.archiveLoaders) record.archiveLoaders = new Map();
    if (!record.archiveLoaders.has(key)) {
      record.archiveLoaders.set(key, createArchiveLoader({ loadArchive: context.loadArchive, dealId: record.selectedDeal.id }));
    }
    return record.archiveLoaders.get(key);
  }

  function paintArchive(target, loader) {
    const host = target.querySelector("[data-record-archive-host]");
    if (!host) return;
    const active = loader || archiveLoaderFor();
    if (!record?.selectedDeal) {
      host.innerHTML = html`<details data-record-archive>
        <summary>Archived drafts and delivery history</summary>
        <div class="honest-state">
          <strong>No deal selected</strong>
          <p>Select a deal to see its archived drafts and delivery history.</p>
        </div>
      </details>`;
      return;
    }
    record.archiveLoader = active;
    host.innerHTML = archiveDisclosureMarkup(active?.state || { status: "idle" }, context);
  }

  function wireArchive(target) {
    const host = target.querySelector("[data-record-archive-host]");
    if (!host || host.dataset.wiredArchive) return;
    host.dataset.wiredArchive = "true";
    // The native details toggle event does NOT bubble (verified by probe:
    // bubble 0, capture 1), so the host listener must use the capture phase.
    // Listeners live on the persistent host: paintArchive replaces the
    // disclosure node on every state change, so node-level listeners
    // would be lost after the first render.
    const fail = typeof context.safe === "function" ? context.safe : async (action) => action();
    // Current generation + selected-deal identity are captured before every
    // await; a late response paints only when the same deal is still
    // selected in the same record generation — never under deal B.
    const guard = (mine, dealId, loader) =>
      mine === token && record && record.selectedDeal?.id === dealId && archiveLoaderFor() === loader;
    host.addEventListener("toggle", async (event) => {
      const disclosure = event.target.closest("[data-record-archive]");
      if (!disclosure || !disclosure.open) return;
      const loader = archiveLoaderFor();
      if (!loader || loader.state.status !== "idle") return;
      const mine = token;
      const dealId = record.selectedDeal.id;
      // Paint the loading state immediately; the guarded paint after the
      // await renders the result only for the current deal+generation.
      const pending = loader.open();
      paintArchive(target, loader);
      await fail(async () => {
        await pending;
        if (!guard(mine, dealId, loader)) return;
        paintArchive(target, loader);
      }, "Could not load the archive");
    }, true);
    host.addEventListener("click", async (event) => {
      const more = event.target.closest("[data-archive-more]");
      if (more) {
        const loader = archiveLoaderFor();
        if (!loader) return;
      const mine = token;
      const dealId = record.selectedDeal.id;
      await fail(async () => {
        const pending = loader.loadMore();
        paintArchive(target, loader);
        await pending;
        if (!guard(mine, dealId, loader)) return;
        paintArchive(target, loader);
      }, "Could not load older messages");
      return;
      }
      const retry = event.target.closest("[data-archive-retry]");
      if (retry) {
        const loader = archiveLoaderFor();
        if (!loader) return;
      const mine = token;
      const dealId = record.selectedDeal.id;
      await fail(async () => {
        const pending = loader.retry();
        paintArchive(target, loader);
        await pending;
        if (!guard(mine, dealId, loader)) return;
        paintArchive(target, loader);
      }, "Could not load the archive");
      return;
      }
      const review = event.target.closest("[data-archive-review]");
      if (!review || typeof context.onReviewDraft !== "function") return;
      const dealId = record?.selectedDeal?.id;
      await fail(async () => {
        if (record?.selectedDeal?.id !== dealId) return;
        return context.onReviewDraft(review.dataset.archiveReview, Number(review.dataset.archiveVersion));
      }, "Could not open the exact preview");
    });
  }

  async function loadDeals(mine) {
    const target = panel("deals");
    if (!target || !record) return;
    target.innerHTML = loadingMarkup("Loading deals", context);
    try {
      if (!record.dealsLoaded) {
        const query = new URLSearchParams({ organizationId: record.companyId, limit: "50" });
        const append = Boolean(record.cursors.deals);
        if (append) query.set("cursor", record.cursors.deals);
        const result = await api(`/deals?${query}`);
        if (mine !== undefined && mine !== token) return;
        record.deals = append ? [...(record.deals || []), ...(result.items || [])] : (result.items || []);
        record.cursors.deals = result.nextCursor ?? null;
        if (!record.cursors.deals) record.dealsLoaded = true;
      }
      await resolveSelection(mine);
      if (mine !== undefined && mine !== token) return;
      paintDeals(target);
      record.loaded.add("deals");
      if (record.loaded.has("activity") && typeof context.loadArchive === "function") {
        const activityPanel = panel("activity");
        if (activityPanel) {
          paintArchive(activityPanel, null);
          wireArchive(activityPanel);
        }
      }
    } catch (error) {
      if (mine !== undefined && mine !== token) return;
      target.innerHTML = errorMarkup(error?.message, context);
    }
  }

  /**
   * Resolve the selected deal with an explicit failure memory (review
   * finding 1): a deep-linked deal that is absent from the loaded page is
   * fetched independently by ID. When that fetch fails (missing, wrong
   * company, unreadable), the requested ID is preserved as an error and
   * finance is NEVER pointed at an unrelated first-page fallback. The page
   * fallback applies only when no deal was originally requested.
   */
  async function resolveSelection(mine) {
    if (!record) return;
    if (record.selectedDealId) {
      const onPage = (record.deals || []).find((deal) => deal.id === record.selectedDealId);
      if (onPage) {
        record.selectedDeal = onPage;
        record.selectionError = null;
        return;
      }
      try {
        const deal = await api(`/deals/${encodeURIComponent(record.selectedDealId)}`);
        if (mine !== undefined && mine !== token) return;
        if (deal && deal.organizationId === record.companyId) {
          record.selectedDeal = deal;
          record.selectionError = null;
          return;
        }
        record.selectionError = `Deal ${record.selectedDealId} does not belong to this company.`;
      } catch (error) {
        if (mine !== undefined && mine !== token) return;
        record.selectionError = error?.status === 404
          ? `Deal ${record.selectedDealId} was not found.`
          : `Deal ${record.selectedDealId} could not be loaded: ${error?.message || "unknown error"}.`;
      }
      if (mine !== undefined && mine !== token) return;
      record.selectedDeal = null;
      return;
    }
    record.selectionError = null;
    const fallback = (record.deals || []).find((deal) => deal.status !== "lost") || (record.deals || [])[0] || null;
    record.selectedDealId = fallback?.id || null;
    record.selectedDeal = fallback;
  }

  function paintDeals(target) {
    if (!record) return;
    const canAdd = typeof context.onAddDeal === "function";
    target.innerHTML = dealsListMarkup({ deals: record.deals, selectedDealId: record.selectedDealId, canAdd }, context)
      + (record.selectionError ? errorMarkup(record.selectionError, context) : "")
      + (!record.dealsLoaded && record.cursors.deals
        ? html`<button type="button" data-deals-more>Show more deals</button>`
        : "");
    paintHeader();
  }

  /**
   * Invalidate every pending load (source-review finding 5): Back/destroy
   * must never let a stale response render into a closed record or
   * overwrite a newer selection/finance panel.
   */
  function destroy() {
    token += 1;
    record = null;
  }

  async function loadFinanceTab(mine) {
    const target = panel("finance");
    if (!target || !record) return;
    if (!record.selectedDeal) {
      // Selection is deal-driven; without the Deals tab there may be no
      // selection yet — resolve it cheaply here without a full load.
      await loadDeals(mine);
      if ((mine !== undefined && mine !== token) || !record?.selectedDeal) {
        if (!record) return;
        // A failed explicit selection is an error, never a fallback deal's
        // finance: errorMarkup carries the record-retry hook which
        // re-attempts the independent fetch.
        target.innerHTML = record.selectionError
          ? errorMarkup(record.selectionError, context)
          : emptyMarkup("No deal selected", "Select a deal to load finance.", context);
        return;
      }
    }
    const deal = record.selectedDeal;
    const cacheKey = `finance:${deal.id}`;
    if (record.loaded.has(cacheKey)) return;
    // The canonical finance component renders into its own
    // [data-booking-panel="finance"] hook; the tab hosts that hook instead
    // of forking finance rendering.
    target.innerHTML = html`<div data-booking-panel="finance">${loadingMarkup("Loading finance", context)}</div>`;
    try {
      await loadFinance(deal);
      if (mine !== undefined && mine !== token) return;
      record.loaded.add(cacheKey);
    } catch (error) {
      if (mine !== undefined && mine !== token) return;
      target.innerHTML = errorMarkup(error?.message, context);
    }
  }

  async function switchTab(name) {
    if (!record || !RECORD_TABS.some(([id]) => id === name)) return;
    const mine = token;
    showTab(name);
    if (name === "overview" && !record.loaded.has("overview")) return loadOverview(mine);
    if (name === "people" && !record.loaded.has("people")) return loadPeople(mine);
    if (name === "activity" && !record.loaded.has("activity")) return loadActivity(mine);
    if (name === "deals" && !record.loaded.has("deals")) return loadDeals(mine);
    if (name === "finance") return loadFinanceTab(mine);
    return undefined;
  }

  function selectDeal(dealId) {
    if (!record) return;
    const deal = record.deals.find((item) => item.id === dealId);
    if (!deal) return;
    record.selectedDealId = deal.id;
    record.selectedDeal = deal;
    record.selectionError = null;
    record.loaded.delete(`finance:${record.selectedDealId}`);
    for (const key of [...record.loaded]) {
      if (key.startsWith("finance:")) record.loaded.delete(key);
    }
    paintHeader();
    const dealsPanel = panel("deals");
    if (dealsPanel && record.loaded.has("deals")) {
      dealsPanel.innerHTML = dealsListMarkup({ deals: record.deals, selectedDealId: record.selectedDealId }, context);
    }
    if (record.activeTab === "finance") {
      const mine = token;
      loadFinanceTab(mine);
    }
    if (record.loaded.has("activity") && typeof context.loadArchive === "function") {
      const activityPanel = panel("activity");
      if (activityPanel) {
        paintArchive(activityPanel, null);
        wireArchive(activityPanel);
      }
    }
  }

  function wire(host) {
    host.addEventListener("click", async (event) => {
      const back = event.target.closest("[data-record-back]");
      if (back) {
        destroy();
        closer();
        return;
      }
      const tab = event.target.closest("[data-record-tab]");
      if (tab) {
        await fail(() => switchTab(tab.dataset.recordTab), "Could not open section");
        return;
      }
      if (event.target.closest("[data-goto-people]")) {
        await fail(() => switchTab("people"), "Could not open section");
        return;
      }
      const retry = event.target.closest("[data-record-retry]");
      if (retry) {
        // A retry after a failure must refetch rather than repaint the
        // error, so drop the loaded marker (and any finance cache) first.
        fail(async () => {
          if (!record) return;
          record.loaded.delete(record.activeTab);
          for (const key of [...record.loaded]) {
            if (key.startsWith("finance:")) record.loaded.delete(key);
          }
          await switchTab(record.activeTab);
        }, "Could not reload section");
        return;
      }
      const more = event.target.closest("[data-people-more]");
      if (more) {
        await fail(() => loadPeople(token), "Could not load more people");
        return;
      }
      const moreDeals = event.target.closest("[data-deals-more]");
      if (moreDeals) {
        await fail(async () => {
          if (!record) return;
          record.loaded.delete("deals");
          await switchTab("deals");
        }, "Could not load more deals");
        return;
      }
      const pick = event.target.closest("[data-select-deal]");
      if (pick) {
        selectDeal(pick.dataset.selectDeal);
        return;
      }
      if (event.target.closest("[data-add-deal]") && typeof context.onAddDeal === "function") {
        context.onAddDeal();
        return;
      }
      const archive = event.target.closest("[data-archive-company]");
      if (archive && typeof context.onArchiveCompany === "function") {
        await fail(() => context.onArchiveCompany(), "Could not archive company");
        return;
      }
      const restore = event.target.closest("[data-restore-company]");
      if (restore && typeof context.onRestoreCompany === "function") {
        await fail(() => context.onRestoreCompany(), "Could not restore company");
        return;
      }
      const openTask = event.target.closest("[data-open-task]");
      if (openTask && typeof context.openTaskPanel === "function") {
        context.openTaskPanel(openTask.dataset.openTask);
        return;
      }
      const editPerson = event.target.closest("[data-edit-person]");
      if (editPerson && canEditPerson) {
        const person = (record?.people || []).find((item) => item.id === editPerson.dataset.editPerson);
        if (person) context.openContactEditor(person);
        return;
      }
      if (event.target.closest("[data-add-person]") && canEditPerson) {
        context.openContactEditor({ organizationId: record?.companyId });
        return;
      }
      const openPerson = event.target.closest("[data-open-person]");
      if (openPerson && typeof context.openCompanyRecord === "function") {
        // Person deep-links resolve through the primary People directory;
        // inside the record this opens the person via E navigation.
        context.openCompanyRecord({ personId: openPerson.dataset.openPerson });
      }
    });
    host.addEventListener("keydown", async (event) => {
      const tab = event.target.closest?.('[role="tab"]');
      if (!tab) return;
      const ids = RECORD_TABS.map(([id]) => id);
      const index = ids.indexOf(tab.dataset.recordTab);
      let next = null;
      if (event.key === "ArrowRight") next = ids[(index + 1) % ids.length];
      else if (event.key === "ArrowLeft") next = ids[(index - 1 + ids.length) % ids.length];
      else if (event.key === "Home") next = ids[0];
      else if (event.key === "End") next = ids[ids.length - 1];
      else return;
      event.preventDefault();
      await fail(() => switchTab(next).then(() => {
        host.querySelector(`[data-record-tab="${next}"]`)?.focus?.();
      }), "Could not open section");
    });
  }

  function getSelectedDealId() {
    return record?.selectedDealId || null;
  }

  function getCompany() {
    return record?.company || null;
  }

  return { openCompany, switchTab, selectDeal, getSelectedDealId, getCompany, destroy, closeWith, wire };
}
