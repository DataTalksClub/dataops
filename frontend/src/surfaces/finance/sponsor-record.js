import { html } from "./shared.js";
import {
  activityItemMarkup,
  activityPanelMarkup,
  createActivityLoader,
  formatBerlinDate,
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

export function recordHeaderMarkup(company, options = {}, context = {}) {
  const escape = esc(context);
  const { selectedDeal = null, returnLabel = "Back" } = options;
  const primary = company?.primaryPerson;
  return html`<header class="dk-split__head">
    <button type="button" class="dk-split__back" data-record-back>${escape(returnLabel)}</button>
    <div class="booking-detail-title">
      <h2 class="dk-split__title" data-record-title tabindex="-1">${escape(company?.displayName || "Unknown sponsor")}</h2>
      <p>
        ${company?.domain ? html`<span class="status-label" data-status="domain">${escape(company.domain)}</span>` : ""}
        ${company?.relationship ? html`<span class="status-label" data-status="${escape(company.relationship)}">${escape(humanize(company.relationship, context))}</span>` : ""}
        ${selectedDeal ? html`<span class="status-label" data-status="${escape(selectedDeal.status)}">${escape(humanize(selectedDeal.status, context))}</span>` : ""}
      </p>
      <p class="crm-record-sub">
        ${primary ? html`Primary: ${escape(primary.name || "Unnamed")}${primary.email ? html` · ${escape(primary.email)}` : ""}` : "No primary person yet"}
        ${company?.lastTouch ? html` · Last touch ${escape(formatBerlinDate(company.lastTouch))}` : ""}
      </p>
    </div>
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

export function overviewMarkup({ company, primaryPerson, nextTask, recent }, context = {}) {
  const escape = esc(context);
  const person = primaryPerson || company?.primaryPerson;
  return html`<div class="crm-record-overview">
    <section aria-label="Next action">
      <h3>Next action</h3>
      ${nextTask
        ? html`<p><strong>${escape(nextTask.description || "Open task")}</strong>
            ${nextTask.date ? html` · ${escape(formatBerlinDate(nextTask.date))}` : ""}</p>
          ${nextTask.taskId ? html`<button type="button" data-open-task="${escape(nextTask.taskId)}">Open task</button>` : ""}`
        : html`<p>No open task. Nothing is due for this company.</p>`}
    </section>
    <section aria-label="Primary person">
      <h3>Primary person</h3>
      ${person
        ? html`<p>${escape(person.name || "Unnamed")}${person.email ? html` · ${escape(person.email)}` : ""}</p>`
        : html`<p>No primary person yet.</p>`}
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

export function dealsListMarkup({ deals, selectedDealId }, context = {}) {
  const escape = esc(context);
  if (!deals?.length) return emptyMarkup("No deals", "Add a deal for this company.", context);
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
  </ul>`;
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

  function root() {
    return surface.querySelector("[data-crm-record]");
  }

  function panel(name) {
    return root()?.querySelector(`[data-record-panel="${name}"]`);
  }

  function paintTabs(active) {
    const tabs = root()?.querySelector("[data-record-tabs]");
    if (tabs) tabs.innerHTML = recordTabsMarkup(active, context);
  }

  function showTab(active) {
    for (const [id] of RECORD_TABS) {
      const section = panel(id);
      if (section) section.hidden = id !== active;
    }
    paintTabs(active);
    if (record) record.activeTab = active;
  }

  function paintHeader() {
    const host = root();
    if (!host || !record) return;
    const header = host.querySelector("[data-record-header]");
    if (header) {
      header.innerHTML = recordHeaderMarkup(record.company, {
        selectedDeal: record.selectedDeal,
        returnLabel: record.returnLabel,
      }, context);
    }
  }

  async function openCompany(companyId, { dealId = null, returnLabel = "Back" } = {}) {
    const mine = ++token;
    const host = root();
    if (!host) throw new Error("createSponsorRecord: missing [data-crm-record] mount (E integration)");
    record = {
      companyId, company: null, deals: [], selectedDealId: dealId,
      selectedDeal: null, activeTab: "overview", returnLabel,
      loaded: new Set(), cursors: {}, preview: { items: [], relatedWork: [] },
    };
    host.innerHTML = loadingMarkup("Loading company", context);
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
    host.innerHTML = html`<div data-record-header>${recordHeaderMarkup(record.company, { returnLabel }, context)}</div>
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
      // Overview degrades honestly: identity + summary stay, activity errors inline.
      target.innerHTML = overviewMarkup({
        company: record.company, primaryPerson: null, nextTask: null, recent: [],
      }, context) + errorMarkup(loader.state.error, context);
      return;
    }
    record.preview = { items: loader.state.items, relatedWork: loader.state.relatedWork };
    target.innerHTML = overviewMarkup({
      company: record.company,
      primaryPerson: record.company.primaryPerson || null,
      nextTask: loader.state.relatedWork[0] || null,
      recent: loader.state.items.slice(0, 3),
    }, context);
    record.loaded.add("overview");
  }

  async function loadPeople(mine) {
    const target = panel("people");
    if (!target || !record) return;
    target.innerHTML = loadingMarkup("Loading people", context);
    try {
      const query = new URLSearchParams({ company: record.companyId, limit: "30" });
      if (record.cursors.people) query.set("cursor", record.cursors.people);
      const result = await api(`/directory/people?${query}`);
      if (mine !== undefined && mine !== token) return;
      const items = [...(record.people || []), ...(result.items || [])];
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
    const loader = createActivityLoader({ api, targetType: "organization", targetId: record.companyId });
    record.activityLoader = loader;
    target.innerHTML = activityPanelMarkup({ targetType: "organization" });
    const wired = wireActivityPanel(target, loader, {
      ...context,
      openTaskPanel: typeof context.openTaskPanel === "function" ? context.openTaskPanel : undefined,
    });
    wired.paint();
    await loader.load();
    if (mine !== undefined && mine !== token) return;
    wired.paint();
    record.loaded.add("activity");
  }

  async function loadDeals(mine) {
    const target = panel("deals");
    if (!target || !record) return;
    target.innerHTML = loadingMarkup("Loading deals", context);
    try {
      const query = new URLSearchParams({ organizationId: record.companyId, limit: "50" });
      const result = await api(`/deals?${query}`);
      if (mine !== undefined && mine !== token) return;
      record.deals = result.items || [];
      if (!record.selectedDealId || !record.deals.some((deal) => deal.id === record.selectedDealId)) {
        const fallback = record.deals.find((deal) => deal.status !== "lost") || record.deals[0] || null;
        record.selectedDealId = fallback?.id || null;
      }
      record.selectedDeal = record.deals.find((deal) => deal.id === record.selectedDealId) || null;
      target.innerHTML = dealsListMarkup({ deals: record.deals, selectedDealId: record.selectedDealId }, context);
      record.loaded.add("deals");
      paintHeader();
    } catch (error) {
      if (mine !== undefined && mine !== token) return;
      target.innerHTML = errorMarkup(error?.message, context);
    }
  }

  async function loadFinanceTab(mine) {
    const target = panel("finance");
    if (!target || !record) return;
    if (!record.selectedDeal) {
      // Selection is deal-driven; without the Deals tab there may be no
      // selection yet — resolve it cheaply here without a full load.
      await loadDeals(mine);
      if ((mine !== undefined && mine !== token) || !record?.selectedDeal) {
        if (record && !record.selectedDeal) target.innerHTML = emptyMarkup("No deal selected", "Select a deal to load finance.", context);
        return;
      }
    }
    const deal = record.selectedDeal;
    const cacheKey = `finance:${deal.id}`;
    if (record.loaded.has(cacheKey)) return;
    target.innerHTML = loadingMarkup("Loading finance", context);
    try {
      await loadFinance(deal, target);
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
  }

  function wire(host) {
    host.addEventListener("click", async (event) => {
      const back = event.target.closest("[data-record-back]");
      if (back) {
        closeRecord();
        return;
      }
      const tab = event.target.closest("[data-record-tab]");
      if (tab) {
        await fail(() => switchTab(tab.dataset.recordTab), "Could not open section");
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
      const pick = event.target.closest("[data-select-deal]");
      if (pick) {
        selectDeal(pick.dataset.selectDeal);
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

  return { openCompany, switchTab, selectDeal, getSelectedDealId, wire };
}
