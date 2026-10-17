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
 * Person record: identity + role + channels + company link + notes + Activity.
 *
 * Reads the existing contact record (GET /api/sponsor-crm/contacts/:id —
 * basic, flat A fields: id, organizationId, name, emails, primary, role,
 * linkedin, telegram, notes, lastTouch/lastInboundAt/lastOutboundAt/
 * lastContactedAt, active, version, updatedAt) plus bounded activity
 * (GET /activity/contact/:id). Person mail is provably-linked only
 * (`provenance.link: 'direct'` server-side); company-wide mail never appears
 * in a person timeline. No company finance surface is rendered here.
 *
 * E (directory/navigation owner) provides the mount
 * (`surface.querySelector("[data-crm-person]")`), `closeRecord` (canonical
 * Back restoring the People list filters/page/scroll + focus), optional
 * `openCompanyRecord(organizationId)`, `openContactEditor(person)` (A's
 * editor, optimistic version, never a channels object) and `openTaskPanel`.
 */

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

export function personDetailMarkup(person, options = {}, context = {}) {
  return html`${personHeaderMarkup(person, options, context)}
    <section aria-label="Contact channels"><h3>Channels</h3>${personChannelsMarkup(person, context)}</section>
    ${person?.notes
      ? html`<section aria-label="Person notes"><h3>Notes</h3><p>${esc(context)(person.notes)}</p></section>`
      : ""}
    <section aria-label="Activity"><h3>Activity</h3>
      <div data-person-activity>${activityPanelMarkup({ targetType: "contact" })}</div>
    </section>`;
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
  let token = 0;

  function root() {
    return surface.querySelector("[data-crm-person]");
  }

  async function openPerson(personId, { returnLabel = "Back" } = {}) {
    const mine = ++token;
    const host = root();
    if (!host) throw new Error("createSponsorPersonDetail: missing [data-crm-person] mount (E integration)");
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
    host.querySelector("[data-person-title]")?.focus?.();
    const activityHost = host.querySelector("[data-person-activity]");
    if (activityHost) {
      const loader = createActivityLoader({ api, targetType: "contact", targetId: person.id });
      const wired = wireActivityPanel(activityHost, loader, context);
      wired.paint();
      await loader.load();
      if (mine !== token) return person;
      wired.paint();
    }
    return person;
  }

  function wire(host) {
    host.addEventListener("click", (event) => {
      if (event.target.closest("[data-person-back]")) {
        closeRecord();
        return;
      }
      if (event.target.closest("[data-edit-person]") && canEdit && person) {
        context.openContactEditor(person);
        return;
      }
      const company = event.target.closest("[data-open-company]");
      if (!company?.dataset.openCompany || typeof context.openCompanyRecord !== "function") return;
      // Modified clicks (new tab/window) keep their native anchor behavior.
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button > 0) return;
      event.preventDefault();
      context.openCompanyRecord(company.dataset.openCompany);
    });
  }

  return { openPerson, wire };
}
