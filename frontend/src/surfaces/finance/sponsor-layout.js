import "../../dakit/collection.js";
import { html } from "./shared.js";
import { leadsSectionMarkup } from "./sponsor-leads.js";
import { renderPageHeaderMarkup } from "../operations-overview.js";
import { directoryDefaults, directorySectionMarkup } from "./sponsor-directory.js";
import { crmNavModel, renderCrmNav } from "./sponsor-navigation.js";

const DEAL_STATUSES = ["open", "agreed", "lost"];
const PRODUCT_KINDS = ["one-off", "package", "course"];
const CHANNELS = ["main", "secondary", "standalone", "social", "workshop", "course", "other"];
const LOST_REASONS = ["no_budget", "no_reply", "wrong_fit", "timing", "other"];


function options(values, humanize) {
  return values
    .map((value) => html`<option value="${value}">${humanize(value)}</option>`)
    .join("");
}

export function sponsorSurfaceMarkup(humanizeOptionLabel, { escapeHtml = (value) => String(value ?? ""), initialTab = "pipeline" } = {}) {
  const dealStatusOptions = options(DEAL_STATUSES, humanizeOptionLabel);
  const productOptions = options(PRODUCT_KINDS, (kind) => ({ "one-off": "One-off", package: "Package", course: "Course" })[kind]);
  const channelOptions = options(CHANNELS, humanizeOptionLabel);
  const lostOptions = options(LOST_REASONS, humanizeOptionLabel);
  // Each create rides on the collection it creates into: Add deal on the
  // Pipeline list head, Add sponsor on the Companies header. Refresh
  // suggestions trails the list head. The page header holds no actions.
  return html`${renderPageHeaderMarkup({
    title: "CRM",
    className: "crm-header",
  })}
    <p data-crm-message class="surface-status" role="status">
      Loading sponsor CRM…
    </p>
    ${renderCrmNav(crmNavModel(initialTab), { escapeHtml })}
    <p class="crm-funnel-scope">All matching deals by stage · includes closed and lost</p>
    <nav class="crm-pipeline" data-crm-pipeline aria-label="Deal pipeline"></nav>
    <details class="crm-alerts">
      <summary data-crm-alert-summary>Alerts</summary>
      <div data-crm-alerts>Loading alerts…</div>
    </details>
    <div class="dk-split crm-layout" data-crm-split data-view="list">
      <section class="dk-split__list crm-master" aria-labelledby="crm-list-heading">
        <header class="dk-split__head crm-list-head">
          <div class="dk-collection-header__lead">
            <h2 class="dk-split__title" id="crm-list-heading" data-crm-list-heading>Pipeline</h2>
            ${globalThis.dakitCollection.createButtonMarkup({ label: "Add deal", attributes: "data-add-deal" })}
          </div>
          <div class="dk-collection-header__trail">
            <span data-booking-count class="dk-split__count"></span>
            <button type="button" class="dk-icon-button dk-icon-button--sm" data-evaluate-communications
              aria-label="Refresh suggestions" title="Refresh suggestions"><svg viewBox="0 0 24 24" aria-hidden="true"
              fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path
              d="M20 12a8 8 0 1 1-2.34-5.66 M20 4v4h-4"/></svg></button>
          </div>
        </header>
        <details class="crm-filter-disclosure"><summary>Search &amp; filters</summary>
        <div class="crm-filters dk-split__tools">
          <label
            >Search sponsors
            <input
              data-crm-search
              type="search"
              placeholder="Company, person, next action" /></label
          ><label
            >Stage
            <select data-crm-status>
              <option value="">All statuses</option>
              ${dealStatusOptions}
            </select></label
          >
        </div>
          <label class="crm-owner-filter">Next action owner
            <select data-pipeline-owner><option value="">All owners</option></select></label>
        </details>
        <div class="crm-funnel-controls">
          <label>Show <select data-pipeline-view>
            <option value="actionable">Needs action this week</option><option value="active">Active deals</option>
            <option value="unscheduled">Missing next step / date</option><option value="all">All deals</option><option value="closed">Closed / lost</option></select></label>
          <label>Sort <select data-pipeline-sort><option value="next-action">Next action</option><option value="recent">Recently updated</option></select></label>
        </div>
        <div data-pipeline-views></div>
        <div class="dk-split__scroll" data-crm-list-scroll>
          <div data-crm-bookings class="crm-booking-list">Loading pipeline…</div>
        </div>
      </section>
      <section class="dk-split__detail crm-detail-pane" data-crm-detail aria-label="Selected sponsor" aria-live="polite">
        <div class="dk-split__scroll crm-detail-empty">
          <div class="dk-empty">
            <p class="dk-empty__title">Select a company</p>
            <p class="dk-empty__desc">
              Open a pipeline deal to review people, deals, mail, and finance in
              one place.
            </p>
          </div>
          <div data-crm-upcoming></div>
        </div>
      </section>
    </div>
    ${directorySectionMarkup("companies", {
      state: directoryDefaults("companies"),
      escapeHtml,
      createHtml: globalThis.dakitCollection.createButtonMarkup({ label: "Add sponsor", attributes: "data-add-org" }),
    })}
    ${directorySectionMarkup("people", {
      state: directoryDefaults("people"),
      escapeHtml,
      createHtml: globalThis.dakitCollection.createButtonMarkup({ label: "Add person", attributes: "data-add-contact" }),
    })}
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
    <section class="crm-money" hidden aria-labelledby="crm-money-heading">
      <header class="section-header">
        <div>
          <h3 id="crm-money-heading">Money</h3>
          <p>What to follow up on today, what is open, and when cash should arrive.</p>
        </div>
      </header>
      <div data-crm-money></div>
    </section>
    ${leadsSectionMarkup()}
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
          <input name="organizationId" type="hidden" /><input name="contactId" type="hidden" /><input name="version" type="hidden" /><label data-contact-org-picker-wrap
            >Company <select data-contact-org-picker aria-label="Company"></select></label
          ><label
            >Name <input name="name" required /></label
          ><label>Email <input name="email" type="email" multiple required /></label
          ><label>Role <input name="role" /></label
          ><label>LinkedIn <input name="linkedin" type="url" placeholder="https://www.linkedin.com/in/…" /></label
          ><label>Telegram <input name="telegram" placeholder="@handle" /></label
          ><label>Notes <textarea name="notes"></textarea></label
          ><label>Last contacted <input name="lastContactedAt" type="date" /></label
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
    <dialog class="surface-dialog" data-ignore-dialog>
      <form method="dialog">
        <header>
          <h3>Ignore lead</h3>
          <p>Say why, so the next reviewer knows. The reason is optional.</p>
        </header>
        <div class="dialog-fields">
          <input name="leadId" type="hidden" /><input name="version" type="hidden" />
          <label
            >Reason
            <input name="statusReason" maxlength="500" placeholder="House ad, not a sponsor" /></label
          >
          <p role="alert"></p>
        </div>
        <footer>
          <button class="primary-button" data-ignore-confirm>Ignore lead</button
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
          ><label class="span-all"
            >Add a task <input name="taskDescription" placeholder="What to do next (lands in the Tasks queue)"
          /></label
          ><label>Task due <input name="taskDate" type="date" /></label
          ><label
            >Assignee
            <select name="taskAssignee">
              <option value="">Select an assignee</option>
            </select></label
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
            into the immutable preview.
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
          <button type="button" data-review-close>Reject / close</button>
        </footer>
      </form>
    </dialog>
    <dialog class="surface-dialog" data-views-dialog>
      <form method="dialog">
        <header>
          <h3 data-views-dialog-title>Save view</h3>
        </header>
        <div class="dialog-fields">
          <div data-views-save-fields>
            <label>Name <input name="viewName" maxlength="120" required /></label>
          </div>
          <div data-views-manage></div>
          <p role="alert"></p>
        </div>
        <footer>
          <button class="primary-button" data-views-confirm>Save view</button
          ><button value="cancel">Cancel</button>
        </footer>
      </form>
    </dialog>
    <dialog
      class="surface-dialog confirm-action-dialog"
      data-sponsor-confirm-dialog
    >
      <!-- Wired by record flows (F): archive/restore confirmations. -->
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
