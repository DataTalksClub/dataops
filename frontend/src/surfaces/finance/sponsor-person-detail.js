import { html } from "./shared.js";
import {
  activityPanelMarkup,
  createActivityLoader,
  formatBerlinDate,
  formatBerlinDateTime,
  wireActivityPanel,
} from "./sponsor-activity.js";
import { emptyMarkup, errorMarkup, loadingMarkup } from "./sponsor-record.js";

/**
 * Person record: identity + Overview/Activity tabs with progressive
 * disclosure (never an all-in-one dump).
 *
 * - Overview (immediate): identity header, channels, notes. No activity
 *   fetch, no mail bodies.
 * - Activity (lazy): the unified timeline loader is created and fetched
 *   only on first tab open, with real loading/error/retry states. The type
 *   filter sits behind a native <details> disclosure (compact, accessible,
 *   native control semantics). Generation guards invalidate pending loads
 *   when switching to another person.
 *
 * Reads the existing contact record (GET /api/sponsor-crm/contacts/:id —
 * basic, flat A fields) plus bounded activity (GET /activity/contact/:id).
 * Person mail is provably-linked only (`provenance.link: 'direct'`
 * server-side). No company finance surface is rendered here.
 *
 * E (directory/navigation owner) provides the mount
 * (`surface.querySelector("[data-crm-person]")`), `closeRecord` (canonical
 * Back restoring the People list + focus), optional
 * `openCompanyRecord(organizationId)`, `openContactEditor(person)` (A's
 * editor) and `openTaskPanel`. E owns People nav, funnel text, shared CSS
 * and combined screenshots; this module adds no new CSS.
 */

export const PERSON_TABS = Object.freeze([
  ["overview", "Overview"],
  ["activity", "Activity"],
]);

function esc(context) {
  return typeof context?.escapeHtml === "function" ? context.escapeHtml : String;
}

export function personHeaderMarkup(person, options = {}, context = {}) {
  const escape = esc(context);
  const { companyName = null, returnLabel = "Back", canEdit = false } = options;
  // The company link is a real canonical anchor so modified clicks and
  // open-in-new-tab keep working natively; only unmodified primary clicks
  // are intercepted for in-place navigation (same rule as the directories).
  const companyHref = person?.organizationId
    ? `/sponsors/companies/${encodeURIComponent(person.organizationId)}`
    : "";
  const companyLink = companyName
    ? html`<a href="${escape(companyHref)}" data-open-company="${escape(person?.organizationId || "")}">${escape(companyName)}</a>`
    : person?.organizationId
      ? "Company unavailable"
      : "No company link";
  return html`<header class="dk-split__head">
    <button type="button" class="dk-split__back" data-person-back>${escape(returnLabel)}</button>
    <div class="booking-detail-title">
      <h2 class="dk-split__title" data-person-title tabindex="-1">${escape(person?.name || "Unnamed person")}</h2>
      <p>
        ${person?.role ? html`<span class="status-label" data-status="role">${escape(person.role)}</span>` : ""}
        ${person?.primary ? html`<span class="status-label" data-status="primary">Primary</span>` : ""}
        ${person?.active === false ? html`<span class="status-label" data-status="archived">Archived</span>` : ""}
      </p>
      <p class="crm-record-sub">
        ${companyLink}
        ${person?.lastTouch ? html` · Last touch ${escape(formatBerlinDate(person.lastTouch))}` : ""}
        ${person?.lastContactedAt ? html` · Last contacted ${escape(formatBerlinDateTime(person.lastContactedAt))}` : ""}
      </p>
    </div>
    ${canEdit ? html`<button type="button" data-edit-person> Edit </button>` : ""}
  </header>`;
}

export function personChannelsMarkup(person, context = {}) {
  const escape = esc(context);
  const emails = Array.isArray(person?.emails) ? person.emails.filter(Boolean) : [];
  const rows = [
    ...emails.map((email) => ({ label: "Email", value: email, href: `mailto:${email}` })),
    ...(person?.linkedin ? [{ label: "LinkedIn", value: person.linkedin, href: person.linkedin }] : []),
    ...(person?.telegram ? [{ label: "Telegram", value: person.telegram, href: "" }] : []),
  ];
  if (!rows.length) return emptyMarkup("No contact channels", "Add an email, LinkedIn or Telegram handle.", context);
  return html`<ul class="crm-directory-list">
    ${rows
      .map(
        (row) => html`<li class="crm-directory-row">
          <div><strong>${escape(row.label)}</strong><p>${escape(row.value)}</p></div>
          <div class="row-actions">${row.href ? html`<a href="${escape(row.href)}">${escape(row.label === "Email" ? "Write" : "Open")}</a>` : ""}</div>
        </li>`,
      )
      .join("")}
  </ul>`;
}

export function personTabsMarkup(active, context = {}) {
  const escape = esc(context);
  return html`<div class="dk-tabs" role="tablist" aria-label="Person record sections" data-person-tabs>
    ${PERSON_TABS.map(
      ([id, label]) => html`<button type="button" class="dk-tab" role="tab" id="person-tab-${id}"
        aria-selected="${id === active ? "true" : "false"}" tabindex="${id === active ? "0" : "-1"}"
        aria-controls="person-panel-${id}" data-person-tab="${id}">${escape(label)}</button>`,
    ).join("")}
  </div>`;
}

export function personOverviewMarkup(person, context = {}) {
  const escape = esc(context);
  return html`<div class="crm-record-overview">
    <section aria-label="Contact channels"><h3>Channels</h3>${personChannelsMarkup(person, context)}</section>
    ${person?.notes
      ? html`<section aria-label="Person notes"><h3>Notes</h3><p>${escape(person.notes)}</p></section>`
      : ""}
  </div>`;
}

export function personDetailMarkup(person, options = {}, context = {}) {
  const { activeTab = "overview" } = options;
  return html`${personHeaderMarkup(person, options, context)}
    ${personTabsMarkup(activeTab, context)}
    ${PERSON_TABS.map(
      ([id]) => html`<section role="tabpanel" id="person-panel-${id}" aria-labelledby="person-tab-${id}"
        data-person-panel="${id}"${id === activeTab ? "" : " hidden"}></section>`,
    ).join("")}`;
}

/**
 * Person record controller. Renders into
 * `surface.querySelector("[data-crm-person]")` (E-owned mount).
 */
export function createSponsorPersonDetail(context) {
  const { api, surface, closeRecord } = context;
  if (typeof api !== "function") throw new Error("createSponsorPersonDetail requires api");
  if (!surface) throw new Error("createSponsorPersonDetail requires surface");
  if (typeof closeRecord !== "function") throw new Error("createSponsorPersonDetail requires closeRecord (E integration)");
  const fail = typeof context.safe === "function" ? context.safe : async (action) => action();
  const canEdit = typeof context.openContactEditor === "function";
  let person = null;
  let activeTab = "overview";
  let activityLoaded = false;
  let token = 0;

  function root() {
    return surface.querySelector("[data-crm-person]");
  }

  function panel(name) {
    return root()?.querySelector(`[data-person-panel="${name}"]`);
  }

  function paintTabs() {
    const tabs = root()?.querySelector("[data-person-tabs]");
    if (tabs) tabs.innerHTML = personTabsMarkup(activeTab, context);
  }

  function showTab(name) {
    for (const [id] of PERSON_TABS) {
      const section = panel(id);
      if (section) section.hidden = id !== name;
    }
    activeTab = name;
    paintTabs();
  }

  async function openPerson(personId, { returnLabel = "Back" } = {}) {
    const mine = ++token;
    const host = root();
    if (!host) throw new Error("createSponsorPersonDetail: missing [data-crm-person] mount (E integration)");
    person = null;
    activeTab = "overview";
    activityLoaded = false;
    host.innerHTML = loadingMarkup("Loading person", context);
    let record;
    try {
      record = await api(`/contacts/${encodeURIComponent(personId)}`);
    } catch (error) {
      if (mine !== token) return null;
      host.innerHTML = error?.status === 404
        ? emptyMarkup("Person not found", "They may have been archived or removed.", context)
        : errorMarkup(error?.message, context);
      return null;
    }
    if (mine !== token) return null;
    person = record || {};
    let companyName = person.organizationId ? null : "";
    if (person.organizationId && typeof context.openCompanyRecord === "function") {
      try {
        const company = await api(`/directory/companies/${encodeURIComponent(person.organizationId)}`);
        if (mine !== token) return null;
        companyName = company?.displayName || null;
      } catch {
        // The company link degrades to plain text; the person stays usable.
        companyName = null;
      }
    }
    host.innerHTML = personDetailMarkup(person, { companyName, returnLabel, canEdit }, context);
    const overviewPanel = host.querySelector('[data-person-panel="overview"]');
    if (overviewPanel) overviewPanel.innerHTML = personOverviewMarkup(person, context);
    host.querySelector("[data-person-title]")?.focus?.();
    return person;
  }

  async function loadActivity(mine) {
    const target = panel("activity");
    if (!target || !person) return;
    const loader = createActivityLoader({ api, targetType: "contact", targetId: person.id });
    target.innerHTML = activityPanelMarkup({ targetType: "contact", collapsibleFilters: true });
    const wired = wireActivityPanel(target, loader, context);
    wired.paint();
    await loader.load();
    if (mine !== undefined && mine !== token) return;
    wired.paint();
    activityLoaded = true;
  }

  async function switchTab(name) {
    if (!person || !PERSON_TABS.some(([id]) => id === name)) return;
    const mine = token;
    showTab(name);
    if (name === "activity" && !activityLoaded) return loadActivity(mine);
    return undefined;
  }

  function destroy() {
    token += 1;
    person = null;
    activityLoaded = false;
  }

  function wire(host) {
    host.addEventListener("click", async (event) => {
      if (event.target.closest("[data-person-back]")) {
        destroy();
        closeRecord();
        return;
      }
      const tab = event.target.closest("[data-person-tab]");
      if (tab) {
        await fail(() => switchTab(tab.dataset.personTab), "Could not open section");
        return;
      }
      if (event.target.closest("[data-edit-person]") && canEdit && person) {
        context.openContactEditor(person);
        return;
      }
      const company = event.target.closest("[data-open-company]");
      if (!company?.dataset.openCompany || typeof context.openCompanyRecord !== "function") return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button > 0) return;
      event.preventDefault();
      context.openCompanyRecord(company.dataset.openCompany);
    });
    host.addEventListener("keydown", async (event) => {
      const tab = event.target.closest?.('[role="tab"]');
      if (!tab) return;
      const ids = PERSON_TABS.map(([id]) => id);
      const index = ids.indexOf(tab.dataset.personTab);
      let next = null;
      if (event.key === "ArrowRight") next = ids[(index + 1) % ids.length];
      else if (event.key === "ArrowLeft") next = ids[(index - 1 + ids.length) % ids.length];
      else if (event.key === "Home") next = ids[0];
      else if (event.key === "End") next = ids[ids.length - 1];
      else return;
      event.preventDefault();
      await fail(() => switchTab(next).then(() => {
        host.querySelector(`[data-person-tab="${next}"]`)?.focus?.();
      }), "Could not open section");
    });
  }

  return { openPerson, switchTab, destroy, wire };
}
