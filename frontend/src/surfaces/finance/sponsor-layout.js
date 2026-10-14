import { SPONSORS_TABS, sponsorsPath } from "../../core/sponsor-routes.js";
import { html } from "./shared.js";
import { renderPageHeaderMarkup } from "../operations-overview.js";

const DEAL_STATUSES = ["open", "agreed", "lost"];
const PRODUCT_KINDS = ["one-off", "package", "course"];
const CHANNELS = ["main", "secondary", "standalone", "social", "workshop", "course", "other"];
const NEXT_ACTION_TYPES = ["follow_up", "send_invoice", "chase_payment", "chase_materials", "send_stats", "other"];
const LOST_REASONS = ["no_budget", "no_reply", "wrong_fit", "timing", "other"];
const OWNERS = [
  ["00000000-0000-0000-0000-000000000001", "Grace"],
  ["00000000-0000-0000-0000-000000000003", "Alexey"],
  ["00000000-0000-0000-0000-000000000002", "Valeriia"],
];

function options(values, humanize) {
  return values
    .map((value) => html`<option value="${value}">${humanize(value)}</option>`)
    .join("");
}

export function sponsorSurfaceMarkup(humanizeOptionLabel) {
  const dealStatusOptions = options(DEAL_STATUSES, humanizeOptionLabel);
  const productOptions = options(PRODUCT_KINDS, (kind) => ({ "one-off": "One-off", package: "Package", course: "Course" })[kind]);
  const channelOptions = options(CHANNELS, humanizeOptionLabel);
  const actionOptions = options(NEXT_ACTION_TYPES, humanizeOptionLabel);
  const lostOptions = options(LOST_REASONS, humanizeOptionLabel);
  const ownerOptions = OWNERS.map(
    ([id, name]) => html`<option value="${id}">${name}</option>`,
  ).join("");
  return html`${renderPageHeaderMarkup({
    title: "Sponsors",
    className: "crm-header",
    actionsHtml: html`<div class="surface-actions">
      <button data-evaluate-communications>Refresh suggestions</button
      ><button data-add-org>Add sponsor</button
      ><button class="primary-button" data-add-deal>Add deal</button>
    </div>`,
  })}
    <p data-crm-message class="surface-status" role="status">
      Loading sponsor CRM…
    </p>
    <nav class="dk-tabs crm-views" data-crm-views aria-label="Sponsors views">
      ${SPONSORS_TABS.map(
        ([id, label]) => html`<a class="dk-tab" href="${sponsorsPath(id)}" data-crm-view="${id}">${label}</a>`,
      ).join("")}
    </nav>
    <nav class="crm-pipeline" data-crm-pipeline aria-label="Deal pipeline"></nav>
    <section class="crm-alerts" aria-label="Alerts">
      <div data-crm-alerts>Loading alerts…</div>
    </section>
    <div class="dk-split crm-layout" data-crm-split data-view="list">
      <section class="dk-split__list crm-master" aria-labelledby="crm-queue-heading">
        <header class="dk-split__head">
          <h2 class="dk-split__title" id="crm-queue-heading" data-crm-list-heading>Queue</h2>
          <span data-booking-count class="dk-split__count"></span>
        </header>
        <div class="crm-filters dk-split__tools">
          <label
            >Search sponsors
            <input
              data-crm-search
              type="search"
              placeholder="Sponsor name" /></label
          ><label class="visually-hidden"
            >Deal status
            <select data-crm-status>
              <option value="">All statuses</option>
              ${dealStatusOptions}
            </select></label
          >
        </div>
        <div class="dk-split__scroll" data-crm-list-scroll>
          <div data-crm-queue class="crm-booking-list">Loading queue…</div>
          <div data-crm-bookings class="crm-booking-list" hidden>Loading pipeline…</div>
        </div>
      </section>
      <section class="dk-split__detail crm-detail-pane" data-crm-detail aria-label="Selected sponsor" aria-live="polite">
        <div class="dk-split__scroll crm-detail-empty">
          <div class="dk-empty">
            <p class="dk-empty__title">Select a company</p>
            <p class="dk-empty__desc">
              Open a queue row or pipeline deal to review people, deals, mail, and
              finance in one place.
            </p>
          </div>
          <div data-crm-upcoming></div>
        </div>
      </section>
    </div>
    <section class="crm-directory" data-crm-companies-section hidden aria-labelledby="crm-sponsors-heading">
      <header class="section-header">
        <div>
          <h3 id="crm-sponsors-heading">Companies</h3>
        </div>
        <label
          >Show
          <select data-crm-active>
            <option value="true">Active</option>
            <option value="false">Archived</option>
            <option value="">All</option>
          </select></label
        >
      </header>
      <div data-crm-orgs>Loading sponsors…</div>
    </section>
    <section class="crm-newsletters" hidden aria-labelledby="crm-newsletters-heading">
      <header class="section-header">
        <div>
          <p class="section-kicker">Inbound sources</p>
          <h3 id="crm-newsletters-heading">Newsletters</h3>
        </div>
        <div class="crm-newsletters-toolbar" data-crm-newsletters-toolbar>
          <label
            >Show
            <select data-crm-newsletter-health>
              <option value="">All</option>
              <option value="attention">Needs attention</option>
              <option value="current">Current</option>
              <option value="pending">Signup pending</option>
            </select></label
          >
          <button type="button" data-add-newsletter>Add newsletter</button>
        </div>
      </header>
      <div data-crm-newsletters>Loading newsletters…</div>
      <div data-crm-newsletter-detail hidden></div>
    </section>
    <section class="crm-leads" hidden aria-labelledby="crm-leads-heading">
      <header class="section-header">
        <div>
          <p class="section-kicker">Review queue</p>
          <h3 id="crm-leads-heading">Potential leads</h3>
        </div>
        <label
          >Show
          <select data-crm-lead-status>
            <option value="">All statuses</option>
            <option value="new">New</option>
            <option value="triaged">Triaged</option>
            <option value="converted">Converted</option>
            <option value="ignored">Ignored</option>
          </select></label
        >
      </header>
      <div data-crm-leads>Loading potential leads…</div>
    </section>
    <dialog class="surface-dialog" data-org-dialog>
      <form method="dialog">
        <header>
          <h3>Sponsor company</h3>
        </header>
        <div class="dialog-fields">
          <label>Name <input name="displayName" required /></label
          ><label>Domain <input name="domain" placeholder="example.com" /></label
          ><label>Operator notes <textarea name="notes"></textarea></label>
          <p role="alert"></p>
        </div>
        <footer>
          <button class="primary-button" data-org-save>Save sponsor</button
          ><button value="cancel">Cancel</button>
        </footer>
      </form>
    </dialog>
    <dialog class="surface-dialog" data-contact-dialog>
      <form method="dialog">
        <header>
          <h3>Contact</h3>
        </header>
        <div class="dialog-fields">
          <input name="organizationId" type="hidden" /><label
            >Name <input name="name" required /></label
          ><label>Email <input name="email" type="email" required /></label
          ><label>Role <input name="role" /></label
          ><label class="checkbox-label"
            ><input name="primary" type="checkbox" />
            <span>Primary contact</span></label
          >
          <p role="alert"></p>
        </div>
        <footer>
          <button class="primary-button" data-contact-save>Save contact</button
          ><button value="cancel">Cancel</button>
        </footer>
      </form>
    </dialog>
    <dialog class="surface-dialog" data-convert-dialog>
      <form method="dialog">
        <header>
          <h3>Convert lead</h3>
          <p>This name already exists. Pick the company or create a new one.</p>
        </header>
        <div class="dialog-fields">
          <input name="leadId" type="hidden" /><input name="version" type="hidden" />
          <label
            >Existing company
            <select name="organizationId"></select></label
          >
          <p role="alert"></p>
        </div>
        <footer>
          <button class="primary-button" data-convert-existing>Link company</button
          ><button type="button" data-convert-new>Create new company</button
          ><button value="cancel">Cancel</button>
        </footer>
      </form>
    </dialog>
    <dialog class="surface-dialog" data-newsletter-dialog>
      <form method="dialog">
        <header>
          <h3>Newsletter</h3>
          <p>Catalog a title we receive at newsletter@dtcdev.click.</p>
        </header>
        <div class="dialog-fields">
          <input name="newsletterId" type="hidden" /><input name="version" type="hidden" />
          <label>Name <input name="name" required /></label
          ><label>Archive URL <input name="url" type="url" required /></label
          ><label>Senders <input name="senders" placeholder="news@example.com, other@example.com" /></label
          ><label>Cadence <input name="cadence" value="Weekly" /></label
          ><label
            >Expected days
            <input name="expectedIntervalDays" type="number" min="1" max="90" value="7" /></label
          ><label
            >Subscription
            <select name="subscriptionStatus">
              <option value="subscribed">Subscribed</option>
              <option value="pending">Signup pending</option>
              <option value="paused">Paused</option>
              <option value="unsubscribed">Unsubscribed</option>
            </select></label
          ><label>Operator notes <textarea name="notes"></textarea></label>
          <p role="alert"></p>
        </div>
        <footer>
          <button type="button" class="primary-button" data-newsletter-save>
            Save newsletter</button
          ><button value="cancel">Cancel</button>
        </footer>
      </form>
    </dialog>
    <dialog class="surface-dialog" data-suppression-dialog>
      <form method="dialog">
        <header>
          <h3>Suppress sponsor email</h3>
          <p>
            This immediately blocks future review and dispatch for the selected
            verified address. It cannot recall a message after dispatch starts.
          </p>
        </header>
        <div class="dialog-fields">
          <label
            >Recipient
            <select name="recipient" required></select></label
          ><label
            >Reason
            <textarea name="reason" maxlength="240" required></textarea>
          </label>
          <p role="alert"></p>
        </div>
        <footer>
          <button class="danger-button" data-save-suppression>
            Suppress future messages</button
          ><button value="cancel">Cancel</button>
        </footer>
      </form>
    </dialog>
    <dialog class="surface-dialog surface-dialog-wide" data-deal-dialog>
      <form method="dialog">
        <header>
          <h3>Sponsor deal</h3>
        </header>
        <div class="dialog-fields booking-form-grid">
          <input name="dealId" type="hidden" /><input
            name="version"
            type="hidden"
          /><label
            >Company
            <select name="organizationId"></select></label
          ><label
            >Primary contact
            <select name="primaryContactId">
              <option value="">No contact</option>
            </select></label
          ><label
            >Status
            <select name="status">
              ${dealStatusOptions}
            </select></label
          ><label
            >Product
            <select name="productKind">
              ${productOptions}
            </select></label
          ><label>Amount EUR <input name="amountEur" inputmode="decimal" /></label
          ><label
            >Lost reason
            <select name="lostReason">
              <option value="">Not lost</option>
              ${lostOptions}
            </select></label
          ><label
            >Next action
            <select name="nextActionType">
              ${actionOptions}
            </select></label
          ><label>Due <input name="nextActionDue" type="date" /></label
          ><label
            >Owner
            <select name="nextActionOwner">
              ${ownerOptions}
            </select></label
          ><label class="span-all">Action note <input name="nextActionNote" /></label
          ><label
            >Channel
            <select name="channel">
              ${channelOptions}
            </select></label
          ><label
            >Publication date
            <input name="plannedPublicationDate" type="date" /></label
          ><label
            >Material deadline
            <input name="materialDeadline" type="date" /></label
          ><label class="span-all"
            >Status note <input name="historyNote"
          /></label>
          <p class="span-all" role="alert"></p>
        </div>
        <footer>
          <button class="primary-button" data-deal-save>Save deal</button
          ><button value="cancel">Cancel</button>
        </footer>
      </form>
    </dialog>
    <dialog
      class="surface-dialog surface-dialog-wide"
      data-communication-draft-dialog
    >
      <form method="dialog">
        <header>
          <h3>Draft sponsor message</h3>
          <p>Drafting does not approve or send a message.</p>
        </header>
        <div class="dialog-fields">
          <input name="suggestionId" type="hidden" /><label
            >Recipient
            <select name="recipient" required></select></label
          ><label
            >Subject <input name="subject" maxlength="998" required /></label
          ><label
            >Plain-text message
            <textarea
              name="body"
              maxlength="100000"
              required
              rows="12"
            ></textarea></label
          ><label>Public link <input name="publicLink" type="url" /></label>
          <p class="muted">
            Choose one verified active contact address. The selection is bound
            into the immutable preview and cannot change at approval or
            dispatch.
          </p>
          <p role="alert"></p>
        </div>
        <footer>
          <button class="primary-button" data-create-review>Save draft</button
          ><button value="cancel">Cancel</button>
        </footer>
      </form>
    </dialog>
    <dialog
      class="surface-dialog exact-review-dialog"
      data-communication-review-dialog
    >
      <form method="dialog">
        <header>
          <h3>Exact message review</h3>
          <p class="error-banner" data-review-warning></p>
        </header>
        <div class="dialog-fields">
          <dl class="communication-preview" data-review-addresses></dl>
          <section class="exact-review-copy">
            <p class="section-kicker">Subject</p>
            <h4 data-review-subject></h4>
            <p class="section-kicker">Plain-text message</p>
            <pre data-review-body></pre>
            <div data-review-links></div>
          </section>
          <p data-review-status role="status"></p>
        </div>
        <footer>
          <button
            type="button"
            class="primary-button"
            data-approve-message
            hidden
          >
            Approve and queue</button
          ><button type="button" data-review-close>Reject / close</button>
        </footer>
      </form>
    </dialog>
    <dialog
      class="surface-dialog confirm-action-dialog"
      data-sponsor-confirm-dialog
    >
      <form method="dialog">
        <header>
          <h3 data-confirm-title></h3>
          <p data-confirm-description></p>
        </header>
        <footer>
          <button
            type="button"
            class="danger-button"
            data-confirm-accept
          ></button
          ><button value="cancel">Keep current record</button>
        </footer>
      </form>
    </dialog>`;
}
