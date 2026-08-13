import { html } from "./shared.js";

export function sponsorSurfaceMarkup(bookingStatusOptions) {
  return html`<header class="crm-header">
      <div>
        <p class="surface-eyebrow">Partner operations</p>
        <h2>Sponsors</h2>
        <p>
          Move each booking from agreement through publication, payment, and
          reviewed follow-up.
        </p>
      </div>
      <div class="surface-actions">
        <button data-evaluate-communications>Refresh suggestions</button
        ><button data-add-org>Add sponsor</button
        ><button class="primary-button" data-add-booking>Add booking</button>
      </div>
    </header>
    <p data-crm-message class="surface-status" role="status">
      Loading sponsor CRM…
    </p>
    <div class="crm-layout">
      <section class="crm-master" aria-labelledby="crm-bookings-heading">
        <header class="section-header">
          <div>
            <p class="section-kicker">Booking queue</p>
            <h3 id="crm-bookings-heading">Bookings</h3>
          </div>
          <span data-booking-count class="section-count"></span>
        </header>
        <div class="crm-filters">
          <label
            >Search sponsors
            <input
              data-crm-search
              type="search"
              placeholder="Sponsor name" /></label
          ><label
            >Booking status
            <select data-crm-status>
              <option value="">All statuses</option>
              ${bookingStatusOptions}
            </select></label
          >
        </div>
        <div data-crm-bookings class="crm-booking-list">Loading bookings…</div>
      </section>
      <section class="crm-detail-pane" data-crm-detail aria-live="polite">
        <div class="honest-state crm-select-booking">
          <strong>Select a booking</strong>
          <p>
            Open a booking to review its work, finance, communications, and
            history in one place.
          </p>
        </div>
      </section>
    </div>
    <section class="crm-support-grid">
      <section class="crm-directory" aria-labelledby="crm-sponsors-heading">
        <header class="section-header">
          <div>
            <p class="section-kicker">Partner directory</p>
            <h3 id="crm-sponsors-heading">Sponsor organizations</h3>
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
      <section class="crm-alerts" aria-labelledby="crm-alerts-heading">
        <header class="section-header">
          <div>
            <p class="section-kicker">Follow-up</p>
            <h3 id="crm-alerts-heading">Booking alerts</h3>
          </div>
        </header>
        <div data-crm-alerts>Loading alerts…</div>
      </section>
    </section>
    <dialog class="surface-dialog" data-org-dialog>
      <form method="dialog">
        <header>
          <p class="surface-eyebrow">Partner record</p>
          <h3>Sponsor organization</h3>
          <p>Add the public-facing name operators will recognize.</p>
        </header>
        <div class="dialog-fields">
          <label>Name <input name="displayName" required /></label
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
          <p class="surface-eyebrow">Partner record</p>
          <h3>Contact</h3>
          <p>Contact details stay attached to the sponsor organization.</p>
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
    <dialog class="surface-dialog" data-suppression-dialog>
      <form method="dialog">
        <header>
          <p class="surface-eyebrow">Delivery safety</p>
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
    <dialog class="surface-dialog surface-dialog-wide" data-booking-dialog>
      <form method="dialog">
        <header>
          <p class="surface-eyebrow">Booking record</p>
          <h3>Sponsor booking</h3>
          <p>
            Dates and status drive the operator queue. Links and notes remain
            supporting context.
          </p>
        </header>
        <div class="dialog-fields booking-form-grid">
          <input name="bookingId" type="hidden" /><input
            name="version"
            type="hidden"
          /><label
            >Sponsor
            <select name="organizationId"></select></label
          ><label
            >Primary contact
            <select name="primaryContactId">
              <option value="">No contact</option>
            </select></label
          ><label
            >Slot type
            <select name="slotType">
              <option>main</option>
              <option>secondary</option>
              <option>standalone</option>
            </select></label
          ><label
            >Status
            <select name="status">
              ${bookingStatusOptions}
            </select></label
          ><label
            >Publication date
            <input name="plannedPublicationDate" type="date" /></label
          ><label
            >Material deadline
            <input name="materialDeadline" type="date" /></label
          ><label>Next action <input name="nextActionDate" type="date" /></label
          ><label>Schedule entry <input name="scheduleEntryId" /></label
          ><label>Newsletter Card <input name="cardId" /></label
          ><label class="span-all"
            >Required link <input name="requiredLinkUrl" type="url" /></label
          ><label class="span-all"
            >Private artifact links
            <textarea name="artifactUrls"></textarea></label
          ><label class="span-all"
            >Operator notes <textarea name="notes"></textarea></label
          ><label class="span-all"
            >Status note <input name="historyNote"
          /></label>
          <p class="span-all" role="alert"></p>
        </div>
        <footer>
          <button class="primary-button" data-booking-save>Save booking</button
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
          <p class="surface-eyebrow">Reviewed communication</p>
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
          <p class="surface-eyebrow">Final approval gate</p>
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
          <p class="surface-eyebrow">Confirm change</p>
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
