import { html } from "./shared.js";
import {
  activityItemMarkup,
  formatBerlinDate,
  formatBerlinDateTime,
} from "./sponsor-activity.js";

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

export function recordHeaderMarkup(company, options = {}, context = {}) {
  const escape = esc(context);
  const { selectedDeal = null, returnLabel = "Back", canArchive = false, canEdit = false } = options;
  const primary = company?.primaryPerson;
  const showPrimary = primary !== undefined
    || (company != null && Object.prototype.hasOwnProperty.call(company, "primaryPerson"));
  const archived = Boolean(company?.archivedAt) || company?.active === false;
  const isDnc = Boolean(company?.doNotContact || (Array.isArray(company?.tags) && company.tags.includes("do-not-contact")));
  return html`<header class="dk-split__head">
    <button type="button" class="dk-split__back" data-record-back>${escape(returnLabel)}</button>
    <div class="booking-detail-title">
      <h2 class="dk-split__title" data-record-title tabindex="-1">${escape(company?.displayName || "Unknown sponsor")}</h2>
      <p>
        ${company?.domain ? html`<span class="status-label" data-status="domain">${escape(company.domain)}</span>` : ""}
        ${company?.relationship ? html`<span class="status-label" data-status="${escape(company.relationship)}">${escape(humanize(company.relationship, context))}</span>` : ""}
        ${archived ? html`<span class="status-label" data-status="archived">Archived</span>` : ""}
        ${isDnc ? html`<span class="status-label" data-status="dnc">Do Not Contact</span>` : ""}
        ${selectedDeal ? html`<span class="status-label" data-status="${escape(selectedDeal.status)}">${escape(humanize(selectedDeal.status, context))}</span>` : ""}
      </p>
      <p class="crm-record-sub">
        ${showPrimary ? (primary ? html`Primary: ${escape(primary.name || "Unnamed")}${primary.email ? html` · ${escape(primary.email)}` : ""}` : "No primary person yet") : ""}
        ${showPrimary && company?.lastTouch ? " · " : ""}${company?.lastTouch ? html`Last touch ${escape(formatBerlinDate(company.lastTouch))}` : ""}
      </p>
    </div>
    <div style="display:flex;gap:8px;align-items:center;">
      <button type="button" data-toggle-company-dnc class="button button--secondary">
        ${isDnc ? "Remove DNC" : "Mark Do-Not-Contact"}
      </button>
      ${canEdit ? html`<button type="button" data-edit-company>Edit company</button>` : ""}
      ${canArchive ? (archived
        ? html`<button type="button" data-restore-company>Restore</button>`
        : html`<button type="button" data-archive-company>Archive</button>`) : ""}
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
  const { selectedDeal = null, returnLabel = "Back", activeTab = "overview", canArchive = false, canEdit = false } = options;
  return html`${recordHeaderMarkup(company, { selectedDeal, returnLabel, canArchive, canEdit }, context)}
    ${recordTabsMarkup(activeTab, context)}
    ${RECORD_TABS.map(
      ([id]) => html`<section role="tabpanel" id="record-panel-${id}" aria-labelledby="record-tab-${id}"
        data-record-panel="${id}"${id === activeTab ? "" : " hidden"}></section>`,
    ).join("")}`;
}

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
  const canEditDeal = typeof context?.onEditDeal === "function";
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
            ${canEditDeal ? html`<button type="button" data-edit-deal="${escape(deal.id)}">Edit deal</button>` : ""}
          </div>
        </article></li>`;
      })
      .join("")}
  </ul>
  ${canAdd ? html`<button type="button" data-add-deal>Add deal</button>` : ""}`;
}
