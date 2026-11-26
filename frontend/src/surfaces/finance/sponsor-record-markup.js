import { escapeHtml as escape } from "../../core/html.js";
import { html } from "./shared.js";
import {
  activityItemMarkup,
  formatBerlinDate,
  formatBerlinDateTime,
  relatedWorkMarkup,
} from "./sponsor-activity.js";
import { SPONSOR_PIPELINE_STAGES } from "./sponsor-pipeline.js";

export const RECORD_TABS = Object.freeze([
  ["overview", "Overview"],
  ["people", "People"],
  ["activity", "Activity"],
  ["deals", "Deals"],
  ["finance", "Finance"],
]);

const PRODUCT_LABELS = Object.freeze({ "one-off": "One-off", package: "Package", course: "Course" });

function humanize(value, context) {
  if (typeof context?.humanizeOptionLabel === "function") return context.humanizeOptionLabel(value);
  return String(value ?? "").replaceAll("-", " ").replaceAll("_", " ");
}

/** A deal's display name: its title, else the product it sells. */
export function dealTitle(deal, context = {}) {
  if (deal?.title) return String(deal.title);
  return PRODUCT_LABELS[deal?.productKind] || humanize(deal?.productKind || "deal", context);
}

/** Stage names come from the one stage list the Pipeline rows read. */
export function stageLabel(stage, context = {}) {
  return SPONSOR_PIPELINE_STAGES.find(({ id }) => id === stage)?.label || humanize(stage, context);
}

export function formatDealAmount(amountEur) {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(amountEur);
}

/**
 * Readable owner through the injected ownerName(id) lookup (the Pipeline's
 * ownerDirectory.name). Never a raw ID: no assignee reads Unassigned, an
 * unknown or failing lookup reads Unavailable assignee.
 */
function ownerLabel(assigneeId, context) {
  if (!assigneeId) return "Unassigned";
  let name = "";
  try {
    name = typeof context?.ownerName === "function" ? context.ownerName(assigneeId) : "";
  } catch {
    name = "";
  }
  return name || "Unavailable assignee";
}

/**
 * The action a deal page leads with. `row` is the deal's Pipeline row, so
 * the text and date are the ones on the row the operator clicked, and a row
 * without a Task means no open task. Without a row the deal's own first open
 * Task stands in.
 */
export function dealNextAction(row, deal) {
  const none = { text: "No open task", when: "", taskId: null, assigneeId: null, deferredTask: null };
  const task = row?.nextTask || null;
  const review = Boolean(row?.replyReview && (!task || task.deferred));
  if (review) {
    return {
      text: "Review newer inbound (inferred)",
      when: row.inboundAt ? `Inbound ${formatBerlinDate(row.inboundAt)}` : "",
      taskId: null,
      assigneeId: null,
      deferredTask: task,
    };
  }
  const next = row ? task : (deal?.openTasks?.[0] || null);
  if (!next) return none;
  return {
    text: `${task?.deferred ? "Deferred: " : ""}${next.description || "Open task"}`,
    when: next.date ? formatBerlinDate(next.date) : "",
    taskId: next.id || null,
    assigneeId: next.assigneeId || null,
    deferredTask: null,
  };
}

export function loadingMarkup(label, context = {}) {
  return html`<div class="honest-state"><strong>${escape(label)}…</strong></div>`;
}

export function errorMarkup(message, context = {}) {
  return html`<div class="honest-state">
    <strong>Unavailable</strong>
    <p>${escape(message || "Could not load this section.")}</p>
    <button type="button" data-record-retry>Retry</button>
  </div>`;
}

export function emptyMarkup(title, hint, context = {}) {
  return html`<div class="honest-state">
    <strong>${escape(title)}</strong>
    ${hint ? html`<p>${escape(hint)}</p>` : ""}
  </div>`;
}

export function archiveDisclosureMarkup(archive, context = {}) {
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
  const { selectedDeal = null, returnLabel = "Back", canArchive = false, canEdit = false, canDelete = false } = options;
  const primary = company?.primaryPerson;
  const showPrimary = primary !== undefined
    || (company != null && Object.prototype.hasOwnProperty.call(company, "primaryPerson"));
  const archived = Boolean(company?.archivedAt) || company?.active === false;
  const isDnc = Boolean(company?.doNotContact || (Array.isArray(company?.tags) && company.tags.includes("do-not-contact")));
  const followupLabel = company?.follow_up_at
    ? `Follow-up ${company.follow_up_at}${company?.follow_up_status === "done" ? " (done)" : ""}`
    : "";
  return html`<header class="dk-split__head">
    <button type="button" class="dk-split__back" data-record-back>${escape(returnLabel)}</button>
    <div class="booking-detail-title">
      <h2 class="dk-split__title" data-record-title tabindex="-1">${escape(company?.displayName || "Unknown sponsor")}</h2>
      <p>
        ${company?.domain ? html`<span class="status-label" data-status="domain">${escape(company.domain)}</span>` : ""}
        ${company?.relationship ? html`<span class="status-label" data-status="${escape(company.relationship)}">${escape(humanize(company.relationship, context))}</span>` : ""}
        ${archived ? html`<span class="status-label" data-status="archived">Archived</span>` : ""}
        ${isDnc ? html`<span class="status-label" data-status="dnc">Do Not Contact</span>` : ""}
        ${followupLabel ? html`<span class="status-label" data-status="followup">${escape(followupLabel)}</span>` : ""}
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
      ${canDelete ? html`<button type="button" data-delete-company>Delete</button>` : ""}
    </div>
  </header>`;
}

/** Confirm dialog for permanently deleting a deal; the guard error shows in the alert. */
export function deleteDealDialogMarkup() {
  return html`<dialog class="surface-dialog" data-delete-deal-dialog>
    <form method="dialog">
      <header>
        <h3>Delete deal</h3>
        <p data-delete-deal-description></p>
      </header>
      <p role="alert" data-delete-deal-error></p>
      <footer>
        <button type="button" class="primary-button" data-delete-deal-confirm>Delete deal</button>
        <button type="button" data-delete-deal-cancel>Cancel</button>
      </footer>
    </form>
  </dialog>`;
}

/**
 * Header for a record opened on one exact deal (/sponsors/deals/:id). The
 * deal is the identity; its company is the context and the way up to the
 * company record, whose company-level actions do not repeat here.
 */
export function dealHeaderMarkup({ deal, company, row = null, returnLabel = "Back" }, context = {}) {
  const canEditDeal = typeof context?.onEditDeal === "function";
  const canDeleteDeal = typeof context?.onDeleteDeal === "function";
  const next = dealNextAction(row, deal);
  const stage = row?.stage || deal?.status || "";
  const trail = [next.when, next.assigneeId ? ownerLabel(next.assigneeId, context) : ""]
    .filter(Boolean)
    .map((value) => ` · ${escape(value)}`)
    .join("");
  const deferredTask = next.deferredTask;
  return html`<header class="dk-split__head crm-deal-head">
    <button type="button" class="dk-split__back" data-record-back>${escape(returnLabel)}</button>
    <div class="booking-detail-title">
      <p class="crm-deal-kicker">Deal for
        <button type="button" class="crm-row-link" data-record-company${company?.id ? "" : " disabled"}>${escape(company?.displayName || "Unknown sponsor")}</button>
      </p>
      <h2 class="dk-split__title" data-record-title tabindex="-1">${escape(dealTitle(deal, context))}</h2>
      <p>
        ${stage ? html`<span class="status-label" data-status="${escape(stage)}">${escape(stageLabel(stage, context))}</span>` : ""}
        ${deal?.amountEur != null ? html`<span class="status-label crm-deal-value" data-status="value">${escape(formatDealAmount(deal.amountEur))}</span>` : ""}
        ${deal?.contract ? html`<span class="status-label" data-status="contract" data-contract-chip>${escape("contract: " + deal.contract.status)}</span>` : ""}
      </p>
      <p class="crm-record-sub crm-deal-next">
        <span data-deal-next-action><strong>Next action:</strong> ${escape(next.text)}${trail}</span>
        ${deferredTask
          ? html`<span class="crm-deal-secondary">Deferred task: ${escape(deferredTask.description || "Open task")}${
            deferredTask.date ? html` · ${escape(formatBerlinDate(deferredTask.date))}` : ""
          }</span>`
          : ""}
      </p>
    </div>
    <div class="crm-deal-actions">
      ${next.taskId ? html`<button type="button" data-open-task="${escape(next.taskId)}">Open task</button>` : ""}
      ${canEditDeal ? html`<button type="button" data-edit-deal="${escape(deal.id)}">Edit deal</button>` : ""}
      ${canDeleteDeal ? html`<button type="button" data-delete-deal="${escape(deal.id)}">Delete deal</button>` : ""}
    </div>
  </header>`;
}

/** Invoice and payment state in the words the Pipeline and Money tabs use. */
function invoiceSummary(finance, context = {}) {
  if (!finance) return "";
  if (finance.invoiceState !== "issued") return humanize(finance.invoiceState, context);
  const parts = [
    finance.invoiceNumber ? `Invoice ${finance.invoiceNumber}` : "Invoice without number",
    humanize(finance.paymentState, context),
  ];
  if (finance.timingState && !["not-applicable", "settled"].includes(finance.timingState)) parts.push(humanize(finance.timingState, context));
  if (finance.dueOn) parts.push(`due ${formatBerlinDate(finance.dueOn)}`);
  return parts.join(" · ");
}

/**
 * Overview for a record opened on one exact deal: the deal's next action and
 * facts first, then its contact, open work and activity, and only then the
 * company as context. An activity failure hides the activity and work
 * sections instead of claiming they are empty.
 */
export function dealOverviewMarkup(
  { deal, company, row = null, recent, relatedWork = [], activityError = "" },
  context = {},
) {
  const next = dealNextAction(row, deal);
  const contact = row ? row.primaryContact : null;
  const facts = [
    ["Stage", stageLabel(row?.stage || deal?.status, context)],
    ["Value", deal?.amountEur != null ? formatDealAmount(deal.amountEur) : ""],
    ["Product", PRODUCT_LABELS[deal?.productKind] || humanize(deal?.productKind, context)],
    ["Invoice", invoiceSummary(deal?.finance, context)],
    ["Contract", deal?.contract ? humanize(deal.contract.status, context) : ""],
    ["Last touch", row ? (row.lastContacted ? formatBerlinDate(row.lastContacted) : "Never") : ""],
  ].filter(([, value]) => value);
  const primary = company?.primaryPerson;
  const person = contact || primary || null;
  return html`<div class="crm-record-overview crm-deal-overview">
    <section aria-label="Next action">
      <h3>Next action</h3>
      <p><strong>${escape(next.text)}</strong>${next.when ? html` · ${escape(next.when)}` : ""}${
        next.assigneeId ? html` · ${escape(ownerLabel(next.assigneeId, context))}` : ""
      }</p>
      ${next.taskId ? html`<button type="button" data-open-task="${escape(next.taskId)}">Open task</button>` : ""}
    </section>
    <section aria-label="Deal details">
      <h3>Deal details</h3>
      <dl class="crm-deal-facts">
        ${facts.map(([term, value]) => html`<div><dt>${escape(term)}</dt><dd>${escape(value)}</dd></div>`).join("")}
      </dl>
    </section>
    <section aria-label="Primary contact">
      <h3>Primary contact</h3>
      ${person
        ? html`<p>${escape(person.name || "Unnamed")}${[person.role, person.email].filter(Boolean).map((value) => html` · ${escape(value)}`).join("")}</p>`
        : html`<p>No primary contact</p>`}
    </section>
    ${activityError
      ? errorMarkup(activityError, context)
      : html`${relatedWork.length ? relatedWorkMarkup(relatedWork) : ""}
        <section aria-label="Recent activity">
          <h3>Recent activity</h3>
          ${(recent?.length
            ? html`<ul class="crm-activity-list">${recent.map((item) => activityItemMarkup(item, context)).join("")}</ul>`
            : html`<p>No recent activity.</p>`)}
        </section>`}
    <section aria-label="Company">
      <h3>Company</h3>
      <p>${escape(company?.displayName || "Unknown sponsor")}${company?.domain ? html` · ${escape(company.domain)}` : ""}${
        company?.relationship ? html` · ${escape(humanize(company.relationship, context))}` : ""
      }</p>
      <button type="button" data-record-company${company?.id ? "" : " disabled"}>View company record</button>
    </section>
    ${company?.notes
      ? html`<section aria-label="Company summary">
          <h3>Company summary</h3>
          <p>${escape(company.notes)}</p>
        </section>`
      : ""}
  </div>`;
}

/** Confirm dialog for permanently deleting the company; guard errors show in the alert. */
export function deleteCompanyDialogMarkup() {
  return html`<dialog class="surface-dialog" data-delete-company-dialog>
    <form method="dialog">
      <header>
        <h3>Delete company</h3>
        <p data-delete-company-description></p>
      </header>
      <p role="alert" data-delete-company-error></p>
      <footer>
        <button type="button" class="primary-button" data-delete-company-confirm>Delete company</button>
        <button type="button" data-delete-company-cancel>Cancel</button>
      </footer>
    </form>
  </dialog>`;
}

/** Confirm dialog for permanently deleting a person; guard errors show in the alert. */
export function deletePersonDialogMarkup() {
  return html`<dialog class="surface-dialog" data-delete-person-dialog>
    <form method="dialog">
      <header>
        <h3>Delete person</h3>
        <p data-delete-person-description></p>
      </header>
      <p role="alert" data-delete-person-error></p>
      <footer>
        <button type="button" class="primary-button" data-delete-person-confirm>Delete person</button>
        <button type="button" data-delete-person-cancel>Cancel</button>
      </footer>
    </form>
  </dialog>`;
}

export function recordTabsMarkup(active, context = {}, { label = "Company record sections" } = {}) {
  return html`<div class="dk-tabs" role="tablist" aria-label="${escape(label)}" data-record-tabs>
    ${RECORD_TABS.map(
      ([id, label]) => html`<button type="button" class="dk-tab" role="tab" id="record-tab-${id}"
        aria-selected="${id === active ? "true" : "false"}" tabindex="${id === active ? "0" : "-1"}"
        aria-controls="record-panel-${id}" data-record-tab="${id}">${escape(label)}</button>`,
    ).join("")}
  </div>`;
}

export function recordShellMarkup(company, options = {}, context = {}) {
  const { selectedDeal = null, returnLabel = "Back", activeTab = "overview", canArchive = false, canEdit = false, canDelete = false } = options;
  return html`${recordHeaderMarkup(company, { selectedDeal, returnLabel, canArchive, canEdit, canDelete }, context)}
    ${recordTabsMarkup(activeTab, context)}
    ${RECORD_TABS.map(
      ([id]) => html`<section role="tabpanel" id="record-panel-${id}" aria-labelledby="record-tab-${id}"
        data-record-panel="${id}"${id === activeTab ? "" : " hidden"}></section>`,
    ).join("")}`;
}

export function nextTaskMarkup(nextTask, emptyMessage, context = {}) {
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
  const ownerPart = html`<span>${escape(` · ${ownerLabel(nextTask.assigneeId, context)}`)}</span>`;
  const taskButton = nextTask.taskId
    ? html`<button type="button" data-open-task="${escape(nextTask.taskId)}">Open task</button>`
    : "";
  return html`<p><strong>${escape(nextTask.description || "Open task")}</strong>${duePart}${ownerPart}${deferredNote}${originalPart}</p>
    ${taskButton}`;
}

export function overviewMarkup({ company, primaryPerson, nextTask, recent, relatedWork = [], activityError = "" }, context = {}) {
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

export function formatAttachmentSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function dealAttachmentsMarkup(deal) {
  const attachments = Array.isArray(deal?.attachments) ? deal.attachments : [];
  return html`<section class="crm-deal-attachments" data-deal-attachments="${escape(deal.id)}" aria-label="Deal attachments">
    <div class="crm-deal-attachments-head">
      <strong>Attachments (${escape(String(attachments.length))})</strong>
    </div>
    ${attachments.length
      ? html`<ul class="crm-deal-attachment-list">
          ${attachments.map((att) => {
            const size = formatAttachmentSize(att.sizeBytes);
            const uploaded = att.createdAt ? formatBerlinDate(att.createdAt) : "";
            const meta = [size, uploaded, att.note || ""].filter(Boolean).join(" · ");
            return html`<li class="crm-deal-attachment-row" data-attachment-id="${escape(att.id)}">
              <span><strong>${escape(att.filename || "Attachment")}</strong>${meta ? html` <small>${escape(meta)}</small>` : ""}</span>
              <span class="row-actions">
                <button type="button" data-download-attachment="${escape(att.id)}" data-attachment-deal="${escape(deal.id)}">Download</button>
                <button type="button" data-delete-attachment="${escape(att.id)}" data-attachment-deal="${escape(deal.id)}">Remove</button>
              </span>
            </li>`;
          }).join("")}
        </ul>`
      : html`<p class="crm-deal-meta">No attachments yet.</p>`}
    <div class="row-actions">
      <input type="file" data-attach-file-input="${escape(deal.id)}" aria-label="Attach document to deal">
      <button type="button" data-attach-file-submit="${escape(deal.id)}">Upload</button>
    </div>
    <p role="alert" data-attachment-error="${escape(deal.id)}"></p>
  </section>`;
}

/**
 * The company's deals. In a company record a card's button selects the deal
 * whose Finance and archive the tabs show; in a deal-first record
 * (`open: true`) it opens that deal, so the list is the way between the
 * company's deals and the open one reads "This deal".
 */
export function dealsListMarkup({ deals, selectedDealId, canAdd = false, heading = "", open = false }, context = {}) {
  const canEditDeal = typeof context?.onEditDeal === "function";
  const canDeleteDeal = typeof context?.onDeleteDeal === "function";
  if (!deals?.length) {
    return html`${heading ? html`<h3 class="crm-deals-heading">${escape(heading)}</h3>` : ""}
      ${emptyMarkup("No deals", "Add a deal for this company.", context)}
      ${canAdd ? html`<button type="button" data-add-deal>Add deal</button>` : ""}`;
  }
  return html`${heading ? html`<h3 class="crm-deals-heading">${escape(heading)}</h3>` : ""}
    <ul class="crm-directory-list">
    ${deals
      .map((deal) => {
        const task = deal.openTasks?.[0];
        const amount = deal.amountEur != null ? formatDealAmount(deal.amountEur) : "";
        const next = task
          ? `${task.description} · ${formatBerlinDate(task.date)}`
          : deal.status === "lost" ? "" : "No open task";
        // With a title as the card's name the product moves to the meta line.
        const product = deal.title && deal.productKind
          ? (PRODUCT_LABELS[deal.productKind] || humanize(deal.productKind, context))
          : "";
        const current = selectedDealId === deal.id;
        return html`<li><article class="crm-card crm-company-deal"${current ? ' aria-current="true"' : ""}>
          <div class="crm-deal-card-header">
            <strong>${escape(dealTitle(deal, context))}</strong>
            <span class="status-label" data-status="${escape(deal.status)}">${escape(humanize(deal.status, context))}</span>
            <span class="status-label" data-status="contract" data-contract-chip>${deal.contract ? escape("contract: " + deal.contract.status) : ""}</span>
          </div>
          <p class="crm-deal-meta">${[product, amount, next].filter(Boolean).map((value) => escape(value)).join(" · ")}</p>
          <div class="row-actions">
            <button type="button" data-select-deal="${escape(deal.id)}"${current ? " disabled" : ""}>${
              current ? (open ? "This deal" : "Selected") : (open ? "Open deal" : "Select deal")
            }</button>
            ${canEditDeal ? html`<button type="button" data-edit-deal="${escape(deal.id)}">Edit deal</button>` : ""}
            ${canDeleteDeal ? html`<button type="button" data-delete-deal="${escape(deal.id)}">Delete deal</button>` : ""}
          </div>
          ${dealAttachmentsMarkup(deal)}
        </article></li>`;
      })
      .join("")}
  </ul>
  ${canAdd ? html`<button type="button" data-add-deal>Add deal</button>` : ""}`;
}
