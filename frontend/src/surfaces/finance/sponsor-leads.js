import { html } from "./shared.js";

const PAGE_SIZE = 50;
const SEARCH_DELAY_MS = 250;
// Statuses the lead API knows, in review order; "" is every status.
const STATUS_FILTERS = [
  ["new", "New"],
  ["triaged", "Triaged"],
  ["converted", "Converted"],
  ["ignored", "Ignored"],
  ["", "All"],
];
const VIEWS = [
  ["sightings", "Sightings"],
  ["sponsors", "By sponsor"],
];

function statusSegments(active) {
  return STATUS_FILTERS.map(
    ([value, label]) => html`<button
      type="button"
      class="dk-tab"
      role="radio"
      data-lead-filter-status="${value}"
      aria-checked="${String(value === active)}"
      tabindex="${value === active ? "0" : "-1"}"
    >${label}</button>`,
  ).join("");
}

function viewSegments(active) {
  return VIEWS.map(
    ([value, label]) => html`<button
      type="button"
      class="dk-tab"
      role="tab"
      aria-controls="crm-leads-list"
      data-lead-view="${value}"
      aria-selected="${String(value === active)}"
      tabindex="${value === active ? "0" : "-1"}"
    >${label}</button>`,
  ).join("");
}

/** The Leads tab: filter toolbar above the paged review list. */
export function leadsSectionMarkup() {
  return html`<section class="crm-leads" hidden aria-labelledby="crm-leads-heading">
      <header class="section-header">
        <div>
          <p class="section-kicker">Review queue</p>
          <h3 id="crm-leads-heading">Potential leads</h3>
        </div>
        <div class="dk-tabs dk-tabs--sm" role="tablist" aria-label="Lead views" data-crm-lead-views>
          ${viewSegments("sightings")}
        </div>
      </header>
      <div class="dk-toolbar crm-lead-tools">
        <div class="dk-tabs" role="radiogroup" aria-label="Filter leads by status" data-crm-lead-status>
          ${statusSegments("new")}
        </div>
        <label class="crm-lead-search"
          >Search
          <input
            data-crm-lead-search
            type="search"
            placeholder="Sponsor, URL or newsletter"
            maxlength="200" /></label
        ><label
          >Newsletter
          <select data-crm-lead-newsletter>
            <option value="">All newsletters</option>
          </select></label
        >
      </div>
      <div data-crm-lead-scope hidden></div>
      <div data-crm-leads id="crm-leads-list" role="tabpanel">Loading potential leads…</div>
    </section>`;
}

export function createSponsorLeads(context) {
  const { api, escapeHtml, humanizeOptionLabel, message, surface, openDialog } = context;
  // Default view: the review queue — new leads, newest first.
  const filters = { status: "new", search: "", newsletter: "", sponsor: "" };
  let view = "sightings";
  let leads = [];
  let groups = [];
  let nextCursor = null;
  let newsletters = [];
  let focusedLeadId = null;
  let sponsorLabel = "";
  let loadSeq = 0;
  let searchTimer = null;

  const fail = async (action, label) => {
    try {
      await action();
    } catch (error) {
      message.textContent = `${label}: ${error.message}`;
    }
  };

  const seenDate = (value) => (value ? escapeHtml(String(value).slice(0, 10)) : "");

  function filtersApplied() {
    return Boolean(filters.status || filters.search || filters.newsletter || filters.sponsor);
  }

  function emptyState() {
    if (!filtersApplied()) {
      return html`<div class="honest-state">
        <strong>No potential leads</strong>
        <p>Newsletter sponsor sightings forwarded for review will appear here.</p>
      </div>`;
    }
    const status = STATUS_FILTERS.find(([value]) => value === filters.status)?.[1];
    return html`<div class="honest-state">
      <strong>No ${filters.status ? escapeHtml(status.toLowerCase()) + " " : ""}leads match</strong>
      <p>Change the status, newsletter or search to see more.</p>
    </div>`;
  }

  function moreMarkup() {
    if (!nextCursor) return "";
    return html`<div class="dk-table-footer crm-lead-more">
      <button type="button" class="dk-button" data-leads-more>Load more</button>
    </div>`;
  }

  function drawLeads() {
    const container = surface.querySelector("[data-crm-leads]");
    const rows = view === "sponsors" ? groups.map(groupRow) : leads.map(leadCard);
    container.innerHTML = rows.length ? rows.join("") + moreMarkup() : emptyState();
  }

  function drawScope() {
    const scope = surface.querySelector("[data-crm-lead-scope]");
    if (!filters.sponsor) {
      scope.hidden = true;
      scope.innerHTML = "";
      return;
    }
    scope.hidden = false;
    scope.innerHTML = html`<p class="crm-lead-scope">
      Sightings of <strong>${escapeHtml(sponsorLabel || filters.sponsor)}</strong>
      <button type="button" class="crm-lead-triage" data-lead-clear-sponsor>Show all sponsors</button>
    </p>`;
  }

  function drawNewsletterOptions() {
    const select = surface.querySelector("[data-crm-lead-newsletter]");
    const names = filters.newsletter && !newsletters.includes(filters.newsletter)
      ? [filters.newsletter, ...newsletters]
      : newsletters;
    select.innerHTML =
      html`<option value="">All newsletters</option>` +
      names
        .map(
          (name) =>
            html`<option value="${escapeHtml(name)}"${name === filters.newsletter ? " selected" : ""}>${escapeHtml(name)}</option>`,
        )
        .join("");
    select.value = filters.newsletter;
  }

  function drawControls() {
    surface.querySelector("[data-crm-lead-status]").innerHTML = statusSegments(filters.status);
    surface.querySelector("[data-crm-lead-views]").innerHTML = viewSegments(view);
    globalThis.dakitTabs?.sync?.(surface);
  }

  function leadCard(item) {
    const sponsor = item.sponsor || {};
    const newsletter = item.newsletter || {};
    const link = sponsor.url
      ? html`<a href="${escapeHtml(sponsor.url)}">${escapeHtml(sponsor.url)}</a>`
      : "";
    const source = [link, escapeHtml(newsletter.name || "Unknown newsletter"), seenDate(newsletter.receivedAt)]
      .filter(Boolean)
      .join(" · ");
    const focused = item.id === focusedLeadId ? ' aria-current="true"' : "";
    return html`<article class="crm-lead-row" data-lead-row="${escapeHtml(item.id)}"${focused}>
      <div class="crm-lead-body">
        <div class="crm-lead-header">
          <strong class="crm-lead-name">${escapeHtml(sponsor.name || "Unnamed sponsor")}</strong>
          <span class="status-label" data-status="${escapeHtml(item.status)}"
            >${escapeHtml(humanizeOptionLabel(item.status))}</span
          >
        </div>
        <p class="crm-lead-source">${source}${newsletter.subject ? html` · ${escapeHtml(newsletter.subject)}` : ""}</p>
        ${sponsor.blurb ? html`<p class="crm-lead-blurb">${escapeHtml(sponsor.blurb)}</p>` : ""}
        ${sponsor.context ? html`<p class="crm-lead-context muted">${escapeHtml(sponsor.context)}</p>` : ""}
      </div>
      ${item.status === "converted" ? "" : html`<div class="row-actions crm-lead-actions">
        ${leadAction(item.id, "converted", "Convert", "primary-button")}
        ${leadAction(item.id, "triaged", "Triage", "crm-lead-triage")}
        ${leadAction(item.id, "ignored", "Ignore", "danger-text-button")}
      </div>`}
    </article>`;
  }

  /** One sponsor seen across issues: how often, where, and when last. */
  function groupRow(group) {
    const link = group.url
      ? html`<a href="${escapeHtml(group.url)}">${escapeHtml(group.url)}</a>`
      : "";
    const sightings = group.sightings === 1 ? "1 sighting" : `${group.sightings} sightings`;
    const source = [link, sightings, `last ${seenDate(group.latestAt)}`].filter(Boolean).join(" · ");
    return html`<article class="crm-lead-row" data-lead-group="${escapeHtml(group.key)}">
      <div class="crm-lead-body">
        <div class="crm-lead-header">
          <strong class="crm-lead-name">${escapeHtml(group.name || "Unnamed sponsor")}</strong>
        </div>
        <p class="crm-lead-source">${source}</p>
        <p class="crm-lead-blurb">${group.newsletters.map((name) => escapeHtml(name)).join(", ")}</p>
      </div>
      <div class="row-actions crm-lead-actions">
        <button type="button" class="crm-lead-triage" data-lead-sponsor="${escapeHtml(group.key)}">
          Show sightings</button
        >
      </div>
    </article>`;
  }

  function leadAction(id, status, label, className = "") {
    const classAttr = className ? html` class="${className}"` : "";
    return html`<button
      type="button"
      ${classAttr}
      data-lead-status="${status}"
      data-lead-id="${escapeHtml(id)}"
    >
      ${label}</button
    >`;
  }

  function listQuery(cursor) {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (filters.status) query.set("status", filters.status);
    if (filters.newsletter) query.set("newsletter", filters.newsletter);
    if (filters.search) query.set("search", filters.search);
    if (filters.sponsor) query.set("sponsor", filters.sponsor);
    if (view === "sponsors") query.set("group", "sponsor");
    if (cursor) query.set("cursor", cursor);
    return query;
  }

  /** First page for the current filters; a newer load supersedes an older one. */
  async function loadLeads() {
    const container = surface.querySelector("[data-crm-leads]");
    const seq = ++loadSeq;
    try {
      const result = await api(`/leads?${listQuery()}`);
      if (seq !== loadSeq) return;
      if (view === "sponsors") groups = result.items || [];
      else leads = result.items || [];
      nextCursor = result.nextCursor || null;
      newsletters = result.newsletters || [];
      drawNewsletterOptions();
      drawScope();
      drawLeads();
    } catch (error) {
      if (seq !== loadSeq) return;
      container.innerHTML = html`<div class="honest-state">
        <strong>Could not load potential leads.</strong>
        <p>
          ${escapeHtml(error.message)}
          <button type="button" data-retry-leads>Retry</button>
        </p>
      </div>`;
    }
  }

  async function loadMore(button) {
    if (!nextCursor || button?.getAttribute?.("aria-busy") === "true") return;
    const seq = loadSeq;
    button?.setAttribute?.("aria-busy", "true");
    try {
      const result = await api(`/leads?${listQuery(nextCursor)}`);
      if (seq !== loadSeq) return;
      if (view === "sponsors") groups = [...groups, ...(result.items || [])];
      else leads = [...leads, ...(result.items || [])];
      nextCursor = result.nextCursor || null;
      drawLeads();
    } finally {
      button?.removeAttribute?.("aria-busy");
    }
  }

  function reload() {
    fail(loadLeads, "Could not load potential leads");
  }

  /** Show one lead (from a newsletter issue link) highlighted in the list. */
  async function focusLead(id) {
    focusedLeadId = id;
    if (view !== "sightings") {
      view = "sightings";
      drawControls();
    }
    if (!leads.some((item) => item.id === id)) {
      const lead = await api(`/leads/${encodeURIComponent(id)}`);
      leads = [lead, ...leads];
    }
    drawLeads();
    const row = surface.querySelector(`[data-lead-row="${CSS.escape(id)}"]`);
    row?.scrollIntoView({ block: "center" });
    row?.querySelector("button, a")?.focus({ preventScroll: true });
  }

  /**
   * Apply a changed lead in place. The row stays put with its new status
   * (even when it no longer matches the filter) so the operator sees what
   * happened and loaded pages do not shift; the next load re-applies filters.
   */
  function applyLead(updated) {
    leads = leads.map((item) => (item.id === updated.id ? { ...item, ...updated } : item));
    drawLeads();
  }

  function wireLeadControls() {
    surface.querySelector("[data-crm-lead-status]").addEventListener("click", (event) => {
      const segment = event.target.closest("[data-lead-filter-status]");
      if (!segment || segment.dataset.leadFilterStatus === filters.status) return;
      filters.status = segment.dataset.leadFilterStatus;
      drawControls();
      reload();
    });
    surface.querySelector("[data-crm-lead-views]").addEventListener("click", (event) => {
      const segment = event.target.closest("[data-lead-view]");
      if (!segment || segment.dataset.leadView === view) return;
      view = segment.dataset.leadView;
      if (view === "sponsors") filters.sponsor = "";
      drawControls();
      reload();
    });
    surface.querySelector("[data-crm-lead-newsletter]").addEventListener("change", (event) => {
      filters.newsletter = event.target.value || "";
      reload();
    });
    surface.querySelector("[data-crm-lead-search]").addEventListener("input", (event) => {
      const value = String(event.target.value || "").trim();
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        if (value === filters.search) return;
        filters.search = value;
        reload();
      }, SEARCH_DELAY_MS);
    });
    surface.querySelector("[data-crm-lead-scope]").onclick = (event) => {
      if (!event.target.closest("[data-lead-clear-sponsor]")) return;
      filters.sponsor = "";
      view = "sponsors";
      drawControls();
      reload();
    };
    surface.querySelector("[data-crm-leads]").onclick = (event) => {
      if (event.target.closest("[data-retry-leads]")) {
        reload();
        return;
      }
      const more = event.target.closest("[data-leads-more]");
      if (more) {
        fail(() => loadMore(more), "Could not load more leads");
        return;
      }
      const sponsorGroup = event.target.closest("[data-lead-sponsor]");
      if (sponsorGroup) {
        filters.sponsor = sponsorGroup.dataset.leadSponsor;
        sponsorLabel = groups.find((group) => group.key === filters.sponsor)?.name || "";
        view = "sightings";
        drawControls();
        reload();
        return;
      }
      const transition = event.target.closest("[data-lead-status]");
      if (!transition) return;
      const lead = leads.find((item) => item.id === transition.dataset.leadId);
      if (!lead || lead.status === "converted") return;
      const { leadStatus } = transition.dataset;
      fail(async () => {
        let updated;
        try {
          updated = await api(`/leads/${encodeURIComponent(lead.id)}`, {
            method: "PATCH",
            body: JSON.stringify({ version: lead.version, status: leadStatus }),
          });
        } catch (error) {
          if (leadStatus === "converted" && error.status === 409 && error.payload?.candidates) {
            const dialog = surface.querySelector("[data-convert-dialog]");
            const form = dialog.querySelector("form");
            form.elements.leadId.value = lead.id;
            form.elements.version.value = String(lead.version);
            form.elements.organizationId.innerHTML = (error.payload.candidates || [])
              .map(
                (item) =>
                  html`<option value="${escapeHtml(item.id)}">
                    ${escapeHtml(item.displayName)}${item.domain ? html` · ${escapeHtml(item.domain)}` : ""}
                  </option>`,
              )
              .join("");
            if (openDialog) openDialog(dialog);
            else dialog.showModal();
            return;
          }
          throw error;
        }
        applyLead(updated);
      }, "Could not update lead");
    };
    const convert = async (body) => {
      const lead = leads.find((item) => item.id === body.leadId);
      if (!lead || lead.status === "converted") {
        surface.querySelector("[data-convert-dialog]").close();
        return;
      }
      const updated = await api(`/leads/${encodeURIComponent(body.leadId)}`, {
        method: "PATCH",
        body: JSON.stringify({
          version: Number(body.version),
          status: "converted",
          organizationId: body.organizationId || undefined,
          createNew: body.createNew === true,
        }),
      });
      surface.querySelector("[data-convert-dialog]").close();
      applyLead(updated);
    };
    surface.querySelector("[data-convert-existing]")?.addEventListener("click", (event) => {
      event.preventDefault();
      const form = surface.querySelector("[data-convert-dialog] form");
      fail(async () => {
        await convert({
          leadId: form.elements.leadId.value,
          version: form.elements.version.value,
          organizationId: form.elements.organizationId.value,
        });
      }, "Could not convert lead");
    });
    surface.querySelector("[data-convert-new]")?.addEventListener("click", (event) => {
      event.preventDefault();
      const form = surface.querySelector("[data-convert-dialog] form");
      fail(async () => {
        await convert({
          leadId: form.elements.leadId.value,
          version: form.elements.version.value,
          createNew: true,
        });
      }, "Could not convert lead");
    });
  }

  return { focusLead, loadLeads, wireLeadControls };
}
