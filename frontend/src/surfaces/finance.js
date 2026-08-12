export function createFinanceSurface(context) {
  const {
    documentList,
    escapeHtml,
    getPendingLegacyRoute,
    humanizeOptionLabel,
    isWorkspaceRouteFresh,
    navigateCanonicalWorkspace,
    request,
    renderEntityLoadState,
    setPageTitle,
    workApiUrl,
  } = context;

  function html(strings, ...values) {
    return strings.reduce(
      (markup, segment, index) =>
        markup + segment + (index < values.length ? values[index] : ""),
      "",
    );
  }

  let activeSponsorReviewCleanup = null;

  async function canLeaveFinanceSurface(reason = "navigation") {
    return !activeSponsorReviewCleanup || activeSponsorReviewCleanup(reason);
  }

  async function renderSponsorCrmSurface() {
    const routeAtStart = getPendingLegacyRoute();
    const routeToken = routeAtStart?.token;
    const requestedBookingId =
      routeAtStart?.path === "/sponsors"
        ? routeAtStart.params.get("bookingId")
        : null;
    documentList.replaceChildren();
    const bookingStatuses = [
      "inquiry",
      "held",
      "confirmed",
      "materials-pending",
      "materials-ready",
      "scheduled",
      "published",
      "performance-due",
      "complete",
      "cancelled",
    ];
    const bookingStatusOptions = bookingStatuses
      .map(
        (value) => html`
          <option value="${value}">${humanizeOptionLabel(value)}</option>
        `,
      )
      .join("");
    const surface = document.createElement("section");
    surface.className = "sponsor-crm-surface";
    surface.innerHTML = html`<header class="crm-header">
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
          <div data-crm-bookings class="crm-booking-list">
            Loading bookings…
          </div>
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
            <button class="primary-button" data-contact-save>
              Save contact</button
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
              This immediately blocks future review and dispatch for the
              selected verified address. It cannot recall a message after
              dispatch starts.
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
      <dialog class="surface-dialog" data-suppression-orphan-dialog>
        <form method="dialog">
          <header>
            <p class="surface-eyebrow">Administration</p>
            <h3>Suppression migration exceptions</h3>
            <p>
              These redacted records need an administrator decision before the
              retired key can be removed.
            </p>
          </header>
          <div class="dialog-fields" data-suppression-orphans></div>
          <footer><button value="cancel">Close</button></footer>
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
            ><label
              >Next action <input name="nextActionDate" type="date" /></label
            ><label>Schedule entry <input name="scheduleEntryId" /></label
            ><label>Newsletter Card <input name="bundleId" /></label
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
            <button class="primary-button" data-booking-save>
              Save booking</button
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
    documentList.append(surface);
    setPageTitle("Sponsors", "Sponsors");
    const api = (path, options = {}) =>
        request(workApiUrl(`/api/sponsor-crm${path}`), {
          headers: {
            "content-type": "application/json",
            ...(options.headers || {}),
          },
          ...options,
        }),
      message = surface.querySelector("[data-crm-message]");
    let organizations = [],
      contacts = [],
      bookings = [],
      selectedBookingId = "",
      communicationItems = [],
      communicationConfig = null,
      communicationPermissions = {
        role: "operator",
        canApprove: false,
        canCancel: false,
        canReconcile: false,
      },
      currentReview = null;
    const pendingFinanceKeys = new Map();
    const financeApi = async (bookingId, suffix = "", options = {}) => {
      const response = await fetch(
        workApiUrl(
          `/api/sponsor-crm/bookings/${encodeURIComponent(bookingId)}/finance${suffix}`,
        ),
        {
          headers: {
            "content-type": "application/json",
            ...(options.headers || {}),
          },
          ...options,
        },
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(payload.error || `HTTP ${response.status}`);
        error.status = response.status;
        error.outcome = payload.outcome;
        error.sponsorFinance = true;
        throw error;
      }
      return payload;
    };
    const financeDialog = document.createElement("dialog");
    financeDialog.className = "surface-dialog";
    financeDialog.dataset.financeDialog = "";
    financeDialog.innerHTML = html`<form>
      <header>
        <p class="surface-eyebrow">Booking finance</p>
        <h3>Classify sponsor finance</h3>
        <p>Record what must be invoiced before linking evidence.</p>
      </header>
      <div class="dialog-fields">
        <label
          >Invoice requirement
          <select name="invoiceRequirement">
            <option value="required">Invoice required</option>
            <option value="not-required">Invoice not required</option>
          </select></label
        ><label data-money
          >Amount due
          <input
            name="amountDue"
            inputmode="decimal"
            placeholder="2500.00" /></label
        ><label data-money
          >Currency
          <input name="currency" maxlength="3" placeholder="EUR" /></label
        ><label data-money
          >Tax treatment
          <select name="taxMode">
            <option value="unknown">Unknown</option>
            <option value="included">Included</option>
            <option value="added">Added</option>
            <option value="not-applicable">Not applicable</option>
          </select></label
        ><label data-money
          >Tax amount <input name="taxAmount" inputmode="decimal" /></label
        ><label data-money
          >Request by <input name="requestBy" type="date" /></label
        ><label data-money
          >Expected invoice by <input name="expectedInvoiceBy" type="date"
        /></label>
        <p role="alert"></p>
      </div>
      <footer>
        <button class="primary-button">Save classification</button
        ><button type="button" data-cancel>Cancel</button>
      </footer>
    </form>`;
    const financeCandidateDialog = document.createElement("dialog");
    financeCandidateDialog.className = "surface-dialog";
    financeCandidateDialog.dataset.financeCandidateDialog = "";
    financeCandidateDialog.innerHTML = html`<form>
      <header>
        <p class="surface-eyebrow">Booking finance</p>
        <h3 data-title>Link finance evidence</h3>
        <p>Only eligible, unclaimed Bookkeeping evidence is shown.</p>
      </header>
      <div class="dialog-fields">
        <div data-candidates></div>
        <div class="dialog-fields" data-invoice-dates hidden>
          <label>Issued on <input name="issuedOn" type="date" /></label
          ><label>Due on <input name="dueOn" type="date" /></label>
        </div>
        <p role="alert"></p>
      </div>
      <footer>
        <button class="primary-button">Link selected evidence</button
        ><button type="button" data-cancel>Cancel</button>
      </footer>
    </form>`;
    surface.append(financeDialog, financeCandidateDialog);
    const confirmDialog = surface.querySelector(
      "[data-sponsor-confirm-dialog]",
    );
    const confirmSponsorAction = (title, description, actionLabel) =>
      new Promise((resolve) => {
        confirmDialog.querySelector("[data-confirm-title]").textContent = title;
        confirmDialog.querySelector("[data-confirm-description]").textContent =
          description;
        confirmDialog.querySelector("[data-confirm-accept]").textContent =
          actionLabel;
        const finish = (accepted) => {
          confirmDialog.removeEventListener("close", onClose);
          confirmDialog
            .querySelector("[data-confirm-accept]")
            .removeEventListener("click", onAccept);
          resolve(accepted);
        };
        const onClose = () => finish(false);
        const onAccept = () => {
          confirmDialog.removeEventListener("close", onClose);
          confirmDialog.close();
          finish(true);
        };
        confirmDialog.addEventListener("close", onClose, { once: true });
        confirmDialog
          .querySelector("[data-confirm-accept]")
          .addEventListener("click", onAccept, { once: true });
        confirmDialog.showModal();
      });
    let lastFinanceRetry = null;
    let currentFinanceBooking = null;
    const safe = async (action, label) => {
      try {
        await action();
      } catch (error) {
        if (
          error.sponsorFinance &&
          (error.outcome === "outcome_unknown" || error.status === 409)
        )
          surface.querySelector("dialog[open]")?.close();
        message.textContent = `${label}: ${error.message}`;
        if (
          error.sponsorFinance &&
          error.outcome === "outcome_unknown" &&
          lastFinanceRetry
        ) {
          const retry = document.createElement("button");
          retry.type = "button";
          retry.textContent = "Retry same operation";
          retry.dataset.financeRetryUnknown = "";
          retry.addEventListener(
            "click",
            () => safe(lastFinanceRetry, "Could not recover finance operation"),
            { once: true },
          );
          message.append(" ", retry);
        } else if (error.sponsorFinance && error.status === 409) {
          const reload = document.createElement("button");
          reload.type = "button";
          reload.textContent = "Reload current finance state";
          reload.addEventListener(
            "click",
            () =>
              safe(
                () =>
                  currentFinanceBooking
                    ? reopenBookingDetail(currentFinanceBooking)
                    : Promise.resolve(),
                "Could not reload finance state",
              ),
            { once: true },
          );
          message.append(" ", reload);
        }
      }
    };
    const financeMutation = async (booking, suffix, method, body) => {
      const requestBody = { bookingVersion: booking.version, ...body };
      const scope = `${booking.id}:${method}:${suffix}:${JSON.stringify(requestBody)}`;
      const idempotencyKey =
        pendingFinanceKeys.get(scope) || crypto.randomUUID();
      pendingFinanceKeys.set(scope, idempotencyKey);
      const attempt = async () => {
        const result = await financeApi(booking.id, suffix, {
          method,
          headers: { "idempotency-key": idempotencyKey },
          body: JSON.stringify(requestBody),
        });
        pendingFinanceKeys.delete(scope);
        lastFinanceRetry = null;
        return result;
      };
      lastFinanceRetry = async () => {
        await attempt();
        await reopenBookingDetail(booking);
        message.textContent =
          "Finance operation recovered with the original idempotency key.";
      };
      try {
        return await attempt();
      } catch (error) {
        if (error.status !== 503) pendingFinanceKeys.delete(scope);
        if (error.status !== 503) lastFinanceRetry = null;
        throw error;
      }
    };
    function financeMarkup(projection) {
      const admin = projection.role === "admin";
      if (!projection.classified) {
        return html`<section class="finance-panel" data-finance-panel>
          <div class="honest-state">
            <strong>Finance is not classified</strong>
            <p>
              This booking has not been classified. Record whether an invoice is
              required before linking invoice or payment evidence.
            </p>
            ${
              admin
                ? html`
                    <button class="primary-button" data-finance-classify>
                      Classify
                    </button>
                  `
                : ""
            }
          </div>
        </section>`;
      }
      const finance = projection.finance;
      const requestInvoiceAction =
        finance.invoiceRequirement === "required" && !finance.invoiceRequestedAt
          ? html` <button data-finance-request>Record invoice request</button> `
          : "";
      const linkInvoiceAction =
        finance.invoiceRequirement === "required" &&
        finance.invoiceRequestedAt &&
        !projection.invoice &&
        finance.taxMode !== "unknown"
          ? html` <button data-finance-invoice>Link invoice</button> `
          : "";
      const linkPaymentAction =
        projection.invoice &&
        projection.reconciliationStatus === "coherent" &&
        projection.paymentLinkCount < projection.paymentLinkLimit
          ? html` <button data-finance-payment>Link payment</button> `
          : "";
      const unlinkPaymentActions = projection.payments
        .map(
          (payment) => html`
            <button data-finance-unlink-payment="${escapeHtml(payment.id)}">
              Unlink ${escapeHtml(`${payment.effectiveDate} payment`)}
            </button>
          `,
        )
        .join("");
      const voidAction =
        !projection.invoice && projection.paymentLinkCount === 0
          ? html` <button data-finance-void>Void follow-through</button> `
          : "";
      const actions =
        admin && !finance.voidedAt
          ? html`<div class="finance-actions">
              <button data-finance-classify>Update classification</button>
              ${requestInvoiceAction} ${linkInvoiceAction} ${linkPaymentAction}
              <button data-finance-reconcile>Reconcile current evidence</button>
              ${projection.invoice ? html`<button data-finance-unlink-invoice="${escapeHtml(projection.invoice.id)}">Unlink invoice</button>` : ""}
              ${unlinkPaymentActions} ${voidAction}
            </div>`
          : "";
      const invoiceMarkup = projection.invoice
        ? html`
            <p>
              <strong>${escapeHtml(projection.invoice.label)}</strong>
              · uploaded ${escapeHtml(projection.invoice.uploadedAt)}
              <button
                data-finance-download="${escapeHtml(projection.invoice.id)}"
              >
                Download invoice
              </button>
            </p>
          `
        : "";
      const reconciliationWarning =
        projection.reconciliationStatus === "reconciliation-required"
          ? html`
              <p class="finance-recovery" role="alert">
                Evidence is unavailable or changed. No payment is counted until
                an admin reconciles the current records.
              </p>
            `
          : "";
      const paymentMarkup = projection.payments.length
        ? projection.payments
            .map(
              (payment) => html`
                <p>
                  ${escapeHtml(payment.effectiveDate)} ·
                  ${escapeHtml(payment.amount)} ${escapeHtml(payment.currency)}
                </p>
              `,
            )
            .join("")
        : html` <p>No linked payments.</p> `;
      const paymentLimitWarning =
        projection.paymentLinkCount >= projection.paymentLinkLimit
          ? html`
              <p>
                Payment link limit reached
                (${escapeHtml(projection.paymentLinkLimit)}). Unlink evidence
                before adding another payment.
              </p>
            `
          : "";
      return html`<section class="finance-panel" data-finance-panel>
        <span hidden
          >${escapeHtml(`${projection.invoiceState} ${projection.paymentState} ${projection.timingState} ${projection.reconciliationStatus}`)}</span
        >
        <header>
          <div>
            <p class="section-kicker">Payment position</p>
            <h3>${escapeHtml(humanizeOptionLabel(projection.paymentState))}</h3>
            <p>
              ${escapeHtml(humanizeOptionLabel(projection.invoiceState))} ·
              ${escapeHtml(humanizeOptionLabel(projection.timingState))}
            </p>
          </div>
          <span class="finance-status"
            >${escapeHtml(humanizeOptionLabel(projection.reconciliationStatus))}</span
          >
        </header>
        <dl>
          <div>
            <dt>Amount due</dt>
            <dd>
              ${escapeHtml(finance.amountDue ? `${finance.amountDue} ${finance.currency}` : "Not applicable")}
            </dd>
          </div>
          <div>
            <dt>Outstanding</dt>
            <dd>
              ${escapeHtml(projection.outstanding ? `${projection.outstanding} ${finance.currency}` : "Not applicable")}
            </dd>
          </div>
          <div>
            <dt>Tax</dt>
            <dd>${escapeHtml(finance.taxMode || "Not applicable")}</dd>
          </div>
          <div>
            <dt>Due</dt>
            <dd>
              ${escapeHtml(finance.dueOn || finance.expectedInvoiceBy || "Not set")}
            </dd>
          </div>
        </dl>
        ${invoiceMarkup} ${reconciliationWarning}
        <div class="finance-payments">${paymentMarkup}</div>
        ${paymentLimitWarning} ${actions}
      </section>`;
    }
    async function loadFinance(booking) {
      const detail = surface.querySelector('[data-booking-panel="finance"]');
      if (!detail) return;
      try {
        const projection = await financeApi(booking.id);
        detail.innerHTML = financeMarkup(projection);
        bindFinanceActions(booking, projection);
      } catch (error) {
        if (error.status !== 404)
          detail.innerHTML = html`<div class="honest-state">
            <strong>Finance is unavailable</strong>
            <p>Return to the booking list and reopen this booking to retry.</p>
          </div>`;
        else
          detail.innerHTML = html`<div class="honest-state">
            <strong>Finance is not enabled</strong>
            <p>
              The booking remains available. No finance action can be taken in
              this workspace.
            </p>
          </div>`;
      }
    }
    function openFinanceClassification(booking, projection) {
      const form = financeDialog.querySelector("form");
      form.reset();
      const finance = projection.finance || {};
      for (const field of form.elements)
        if (field.name && finance[field.name] !== undefined)
          field.value = finance[field.name];
      const sync = () =>
        form.querySelectorAll("[data-money]").forEach((field) => {
          field.hidden =
            form.elements.invoiceRequirement.value === "not-required";
        });
      form.elements.invoiceRequirement.onchange = sync;
      sync();
      form.onsubmit = (event) => {
        event.preventDefault();
        safe(async () => {
          const body = Object.fromEntries(
            [...new FormData(form)].filter(([, value]) => value !== ""),
          );
          body.expectedVersion = projection.finance?.version;
          await financeMutation(booking, "", "PUT", body);
          financeDialog.close();
          await reopenBookingDetail(booking);
        }, "Could not save finance classification");
      };
      financeDialog.showModal();
    }
    async function openFinanceCandidates(booking, projection, kind) {
      const suffix =
        kind === "invoice" ? "/candidates/invoices" : "/candidates/payments";
      const result = await financeApi(booking.id, `${suffix}?limit=25`);
      let candidateItems = result.items;
      let nextCursor = result.nextCursor;
      const form = financeCandidateDialog.querySelector("form");
      form.reset();
      form.dataset.kind = kind;
      form.querySelector("[data-title]").textContent =
        kind === "invoice" ? "Link an invoice" : "Link a payment";
      form.querySelector("[data-invoice-dates]").hidden = kind !== "invoice";
      const renderCandidates = () => {
        const candidateMarkup = candidateItems
          .map((item, index) => {
            const candidateLabel =
              kind === "invoice"
                ? `${escapeHtml(item.label)} · ${escapeHtml(item.uploadedAt)}`
                : `${escapeHtml(item.effectiveDate)} · ${escapeHtml(item.amount)} ${escapeHtml(item.currency)}`;
            return html`
              <label class="finance-candidate">
                <input
                  type="radio"
                  name="candidate"
                  value="${index}"
                  ${index === 0 ? "checked" : ""}
                />
                <span>${candidateLabel}</span>
              </label>
            `;
          })
          .join("");
        const loadMoreMarkup = nextCursor
          ? html`
              <button type="button" data-finance-more>
                Load more eligible evidence
              </button>
            `
          : "";
        form.querySelector("[data-candidates]").innerHTML =
          candidateItems.length
            ? `${candidateMarkup}${loadMoreMarkup}`
            : html`
                <p>
                  No eligible unclaimed evidence is available. Upload or import
                  evidence in Bookkeeping, then retry.
                </p>
              `;
        form.querySelector("button.primary-button").disabled =
          candidateItems.length === 0;
        form
          .querySelector("[data-finance-more]")
          ?.addEventListener("click", () =>
            safe(async () => {
              const next = await financeApi(
                booking.id,
                `${suffix}?limit=25&cursor=${encodeURIComponent(nextCursor)}`,
              );
              candidateItems = [...candidateItems, ...next.items];
              nextCursor = next.nextCursor;
              renderCandidates();
            }, "Could not load more finance evidence"),
          );
      };
      renderCandidates();
      form.onsubmit = (event) => {
        event.preventDefault();
        safe(async () => {
          const index = Number(new FormData(form).get("candidate"));
          const candidate = candidateItems[index];
          if (!candidate) throw new Error("Select eligible evidence");
          const body = {
            expectedVersion: projection.finance.version,
            sourceId: candidate.id,
            identityToken: candidate.identityToken,
            ...(kind === "invoice"
              ? {
                  issuedOn: form.elements.issuedOn.value,
                  dueOn: form.elements.dueOn.value,
                }
              : {}),
          };
          await financeMutation(
            booking,
            kind === "invoice" ? "/invoice" : "/payments",
            "POST",
            body,
          );
          financeCandidateDialog.close();
          await reopenBookingDetail(booking);
        }, `Could not link ${kind}`);
      };
      financeCandidateDialog.showModal();
    }
    function bindFinanceActions(booking, projection) {
      const panel = surface.querySelector("[data-finance-panel]");
      if (!panel) return;
      panel
        .querySelector("[data-finance-classify]")
        ?.addEventListener("click", () =>
          openFinanceClassification(booking, projection),
        );
      panel
        .querySelector("[data-finance-request]")
        ?.addEventListener("click", () =>
          safe(async () => {
            await financeMutation(booking, "/request", "POST", {
              expectedVersion: projection.finance.version,
            });
            await reopenBookingDetail(booking);
          }, "Could not record invoice request"),
        );
      panel
        .querySelector("[data-finance-invoice]")
        ?.addEventListener("click", () =>
          safe(
            () => openFinanceCandidates(booking, projection, "invoice"),
            "Could not load invoice candidates",
          ),
        );
      panel
        .querySelector("[data-finance-payment]")
        ?.addEventListener("click", () =>
          safe(
            () => openFinanceCandidates(booking, projection, "payment"),
            "Could not load payment candidates",
          ),
        );
      panel
        .querySelector("[data-finance-reconcile]")
        ?.addEventListener("click", () =>
          safe(async () => {
            await financeApi(booking.id, "/reconcile", {
              method: "POST",
              body: "{}",
            });
            await reopenBookingDetail(booking);
          }, "Could not reconcile finance evidence"),
        );
      panel
        .querySelector("[data-finance-download]")
        ?.addEventListener("click", (event) =>
          safe(async () => {
            const result = await request(
              workApiUrl(
                `/api/bookkeeping/documents/${encodeURIComponent(event.currentTarget.dataset.financeDownload)}/download`,
              ),
            );
            const link = document.createElement("a");
            link.href = result.downloadUrl;
            link.target = "_blank";
            link.rel = "noopener";
            link.click();
          }, "Could not prepare the private invoice download"),
        );
      panel
        .querySelector("[data-finance-unlink-invoice]")
        ?.addEventListener("click", (event) =>
          safe(async () => {
            const documentId = event.currentTarget.dataset.financeUnlinkInvoice;
            if (
              !(await confirmSponsorAction(
                "Unlink invoice evidence?",
                "The file stays in Bookkeeping, but this booking will no longer count it as invoice evidence.",
                "Unlink invoice",
              ))
            )
              return;
            await financeMutation(
              booking,
              `/invoice/${encodeURIComponent(documentId)}`,
              "DELETE",
              { expectedVersion: projection.finance.version },
            );
            await reopenBookingDetail(booking);
          }, "Could not unlink invoice"),
        );
      panel
        .querySelectorAll("[data-finance-unlink-payment]")
        .forEach((button) =>
          button.addEventListener("click", () =>
            safe(async () => {
              if (
                !(await confirmSponsorAction(
                  "Unlink payment evidence?",
                  "The transaction stays in Bookkeeping, but this booking will no longer count it toward payment.",
                  "Unlink payment",
                ))
              )
                return;
              await financeMutation(
                booking,
                `/payments/${encodeURIComponent(button.dataset.financeUnlinkPayment)}`,
                "DELETE",
                { expectedVersion: projection.finance.version },
              );
              await reopenBookingDetail(booking);
            }, "Could not unlink payment"),
          ),
        );
      panel
        .querySelector("[data-finance-void]")
        ?.addEventListener("click", () =>
          safe(async () => {
            if (
              !(await confirmSponsorAction(
                "Void finance follow-through?",
                "This closes the booking's finance follow-through. It is available only while no invoice or payment evidence is linked.",
                "Void finance",
              ))
            )
              return;
            await financeMutation(booking, "/void", "POST", {
              expectedVersion: projection.finance.version,
            });
            await reopenBookingDetail(booking);
          }, "Could not void finance follow-through"),
        );
    }
    async function reopenBookingDetail(booking) {
      currentFinanceBooking = booking;
      const history = await api(`/bookings/${booking.id}/history`);
      const org = organizations.find(
        (item) => item.id === booking.organizationId,
      );
      const contact = contacts.find(
        (item) => item.id === booking.primaryContactId,
      );
      selectedBookingId = booking.id;
      surface.classList.add("has-booking-detail");
      draw();
      const historyMarkup = (history.items || []).length
        ? history.items
            .map(
              (item) => html`
                <div>
                  <strong>
                    ${escapeHtml(humanizeOptionLabel(item.oldStatus || "created"))}
                    → ${escapeHtml(humanizeOptionLabel(item.newStatus))}
                  </strong>
                  <small>Recorded ${escapeHtml(item.createdAt)}</small>
                  ${item.note ? html`<p>${escapeHtml(item.note)}</p>` : ""}
                </div>
              `,
            )
            .join("")
        : html`
            <div class="honest-state">
              <strong>No status changes yet</strong>
              <p>Changes to the booking status will appear here.</p>
            </div>
          `;
      surface.querySelector("[data-crm-detail]").innerHTML = html`<article
        class="crm-booking-detail"
      >
        <header class="booking-detail-header">
          <div>
            <button type="button" class="booking-back" data-close-booking>
              ← Return to bookings
            </button>
            <p class="surface-eyebrow">
              ${escapeHtml(humanizeOptionLabel(booking.slotType || "sponsor"))}
              booking
            </p>
            <h2>Booking detail</h2>
            <p>
              <strong
                >${escapeHtml(org?.displayName || "Unknown sponsor")}</strong
              ><span class="status-label"
                >${escapeHtml(humanizeOptionLabel(booking.status))}</span
              >
            </p>
          </div>
          <button data-edit-booking="${escapeHtml(booking.id)}">
            Edit booking
          </button>
        </header>
        <nav class="booking-section-nav" aria-label="Booking detail sections">
          <button
            class="is-active"
            aria-pressed="true"
            data-booking-section-link="overview"
          >
            Overview
          </button>
          <button aria-pressed="false" data-booking-section-link="finance">
            Finance
          </button>
          <button
            aria-pressed="false"
            data-booking-section-link="communications"
          >
            Communications
          </button>
          <button aria-pressed="false" data-booking-section-link="history">
            History
          </button>
        </nav>
        <div class="booking-detail-sections">
          <section
            id="booking-overview"
            class="booking-detail-section"
            data-booking-panel="overview"
          >
            <header>
              <p class="section-kicker">Current work</p>
              <h3>Overview</h3>
            </header>
            <dl class="booking-overview-list">
              <div>
                <dt>Publication</dt>
                <dd>
                  ${escapeHtml(booking.plannedPublicationDate || "Not set")}
                </dd>
              </div>
              <div>
                <dt>Material deadline</dt>
                <dd>${escapeHtml(booking.materialDeadline || "Not set")}</dd>
              </div>
              <div>
                <dt>Next action</dt>
                <dd>${escapeHtml(booking.nextActionDate || "Not set")}</dd>
              </div>
              <div>
                <dt>Primary contact</dt>
                <dd>${escapeHtml(contact?.name || "Not assigned")}</dd>
              </div>
              <div>
                <dt>Newsletter</dt>
                <dd>
                  ${escapeHtml(booking.bundleId ? "Linked" : "Not linked")}
                </dd>
              </div>
              <div>
                <dt>Schedule</dt>
                <dd>
                  ${escapeHtml(booking.scheduleEntryId ? "Linked" : "Not linked")}
                </dd>
              </div>
            </dl>
            ${
              booking.notes
                ? html`<div class="booking-notes">
                    <strong>Operator notes</strong>
                    <p>${escapeHtml(booking.notes)}</p>
                  </div>`
                : ""
            }
          </section>
          <section
            id="booking-finance"
            class="booking-detail-section"
            data-booking-panel="finance"
          >
            <div class="honest-state"><strong>Loading finance…</strong></div>
          </section>
          <section
            id="booking-communications"
            class="booking-detail-section"
            data-booking-panel="communications"
            aria-labelledby="crm-communications-heading"
          >
            <header>
              <p class="section-kicker">Reviewed delivery</p>
              <h3 id="crm-communications-heading">Communications</h3>
              <p>Suggestions never draft, approve, or send automatically.</p>
            </header>
            <div data-crm-communications>
              <div class="honest-state">
                <strong>Loading communications…</strong>
              </div>
            </div>
          </section>
          <section
            id="booking-history"
            class="booking-detail-section"
            data-booking-panel="history"
          >
            <header>
              <p class="section-kicker">Audit trail</p>
              <h3>History</h3>
            </header>
            <div class="crm-history">${historyMarkup}</div>
          </section>
        </div>
      </article>`;
      surface
        .querySelector("[data-close-booking]")
        .addEventListener("click", () => {
          navigateCanonicalWorkspace("/sponsors");
        });
      surface
        .querySelector("[data-crm-detail] [data-edit-booking]")
        .addEventListener("click", () => openBooking(booking));
      surface
        .querySelectorAll("[data-booking-section-link]")
        .forEach((button) =>
          button.addEventListener("click", () => {
            surface
              .querySelectorAll("[data-booking-section-link]")
              .forEach((item) => {
                const active = item === button;
                item.classList.toggle("is-active", active);
                item.setAttribute("aria-pressed", String(active));
              });
            surface
              .querySelector(
                `[data-booking-panel="${button.dataset.bookingSectionLink}"]`,
              )
              ?.scrollIntoView({ behavior: "smooth", block: "start" });
          }),
        );
      await loadFinance(booking);
      await loadCommunications(booking.id);
    }
    function orgOptions() {
      surface.querySelector(
        '[data-booking-dialog] [name="organizationId"]',
      ).innerHTML = organizations
        .filter((item) => !item.archivedAt)
        .map(
          (item) =>
            html`<option value="${escapeHtml(item.id)}">
              ${escapeHtml(item.displayName)}
            </option>`,
        )
        .join("");
    }
    function draw() {
      const search = surface
          .querySelector("[data-crm-search]")
          .value.toLowerCase(),
        active = surface.querySelector("[data-crm-active]").value,
        status = surface.querySelector("[data-crm-status]").value,
        shown = organizations.filter(
          (item) =>
            (!search || item.displayName.toLowerCase().includes(search)) &&
            (!active || String(!item.archivedAt) === active),
        );
      surface.querySelector("[data-crm-orgs]").innerHTML = shown.length
        ? shown
            .map(
              (item) =>
                html`<article class="crm-directory-row">
                  <div>
                    <strong>${escapeHtml(item.displayName)}</strong>
                    <p>
                      ${item.archivedAt ? "Archived organization" : "Active organization"}
                    </p>
                  </div>
                  <div class="row-actions">
                    <button data-contact-org="${escapeHtml(item.id)}">
                      Add contact</button
                    >${item.archivedAt ? "" : ` <button data-archive-org="${escapeHtml(item.id)}">Archive</button>`}
                  </div>
                </article>`,
            )
            .join("")
        : html`<div class="honest-state">
            <strong>No sponsors found</strong>
            <p>Adjust filters or add the first sponsor.</p>
          </div>`;
      const shownIds = new Set(shown.map((item) => item.id));
      const visible = bookings.filter(
        (item) =>
          shownIds.has(item.organizationId) &&
          (!status || item.status === status),
      );
      surface.querySelector("[data-booking-count]").textContent =
        `${visible.length} ${visible.length === 1 ? "booking" : "bookings"}`;
      surface.querySelector("[data-crm-bookings]").innerHTML = visible.length
        ? visible
            .map((item) => {
              const org = organizations.find(
                (value) => value.id === item.organizationId,
              );
              return html`<article
                class="crm-booking-row"
                ${item.id === selectedBookingId ? 'aria-current="true"' : ""}
              >
                <div>
                  <strong
                    >${escapeHtml(org?.displayName || "Unknown sponsor")}</strong
                  ><span class="status-label"
                    >${escapeHtml(humanizeOptionLabel(item.status))}</span
                  >
                  <p>
                    ${escapeHtml(item.plannedPublicationDate || "Publication not set")}
                    · next action
                    ${escapeHtml(item.nextActionDate || "not set")}
                  </p>
                </div>
                <div class="row-actions">
                  <button data-open-booking="${escapeHtml(item.id)}">
                    Open booking</button
                  ><button data-edit-booking="${escapeHtml(item.id)}">
                    Edit
                  </button>
                </div>
              </article>`;
            })
            .join("")
        : html`<div class="honest-state">
            <strong>No bookings</strong>
            <p>Create a booking or adjust filters.</p>
          </div>`;
    }
    function drawCommunications() {
      const root = surface.querySelector("[data-crm-communications]");
      if (!selectedBookingId) return;
      const booking = bookings.find((item) => item.id === selectedBookingId);
      const hasRecipients = contacts.some(
        (item) =>
          item.organizationId === booking?.organizationId &&
          item.active !== false &&
          !item.archivedAt &&
          item.emails?.length,
      );
      const isAdmin = communicationPermissions.role === "admin";
      const controls = hasRecipients
        ? html`<div class="crm-communication-controls">
            <button data-suppress-address>Suppress sponsor address</button
            >${isAdmin ? " <button data-list-suppression-orphans>Migration exceptions</button>" : ""}
          </div>`
        : "";
      const disabledBanner = !communicationConfig?.enabled
        ? html`<div class="honest-state" data-communication-state="disabled">
            <strong>Reviewed sending is disabled</strong>
            <p>
              History remains visible. A credentialed operator must reconcile
              private templates, suppression keys, SES identity, and the kill
              switch before a new preview can be approved.
            </p>
          </div>`
        : "";
      const suggestions = communicationItems.filter(
        (item) => item.recordType === "communication-suggestion",
      );
      const attempts = communicationItems.filter(
        (item) => item.recordType === "sponsor-send-attempt",
      );
      const drafts = communicationItems.filter(
        (item) => item.recordType === "communication-draft-version",
      );
      const draftCards = drafts
        .map((item) => {
          const state = item.reviewState || "awaiting_review";
          const guidance =
            state === "claimed"
              ? "This exact version has already been claimed by an immutable send attempt."
              : state === "abandoned"
                ? "This draft expired and its private payload is no longer reviewable."
                : isAdmin
                  ? "Generate a fresh admin-bound exact preview before approval."
                  : "Draft saved. Awaiting administrator review.";
          const action =
            isAdmin && item.reviewable && communicationConfig?.enabled
              ? html`<button
                  data-review-draft="${escapeHtml(item.communicationId)}"
                  data-draft-version="${escapeHtml(item.version)}"
                >
                  Review exact draft
                </button>`
              : "";
          return html`<article
            class="crm-card"
            data-communication-state="${escapeHtml(state)}"
          >
            <header>
              <strong>Draft version ${escapeHtml(item.version)}</strong
              ><span>${escapeHtml(humanizeOptionLabel(state))}</span>
            </header>
            <p>${guidance}</p>
            ${action}
          </article>`;
        })
        .join("");
      const suggestionCards = suggestions.length
        ? suggestions
            .map(
              (item) =>
                html`<article
                  class="crm-card"
                  data-communication-state="${escapeHtml(item.status)}"
                >
                  <header>
                    <strong
                      >${escapeHtml(humanizeOptionLabel(item.communicationType))}</strong
                    ><span hidden>${escapeHtml(item.communicationType)}</span
                    ><span
                      >${escapeHtml(humanizeOptionLabel(item.status))}</span
                    >
                  </header>
                  <p>${escapeHtml(item.safeReason)}</p>
                  ${item.status === "open" && communicationConfig?.enabled ? html`<button data-draft-suggestion="${escapeHtml(item.id)}">Draft message</button>` : ""}
                </article>`,
            )
            .join("")
        : html`<div class="honest-state">
            <strong>No eligible suggestions</strong>
            <p>
              Milestones only create suggestions. Nothing is drafted or sent
              automatically.
            </p>
          </div>`;
      const attemptCards = attempts
        .map((item) => {
          const state = item.derivedStatus || item.status;
          const guidance =
            item.status === "outcome_unknown"
              ? isAdmin
                ? "Provider outcome is unknown. This attempt will never be resent automatically; reconcile it only after provider investigation."
                : "Provider outcome is unknown. This attempt will never be resent automatically; an administrator must reconcile it."
              : state === "delayed"
                ? "SES accepted the message but delivery is delayed."
                : state === "rejected"
                  ? "The provider rejected this message. Draft and approve a new version only after resolving the cause."
                  : state === "delivered"
                    ? "Provider delivery fact recorded. This does not prove the recipient read it."
                    : state === "pending_event"
                      ? "Dispatch started. Waiting for a trusted provider fact; this message will not be sent again automatically."
                      : state === "accepted"
                        ? "SES accepted the immutable message. Awaiting later delivery evidence."
                        : state === "queued"
                          ? isAdmin
                            ? "Approved and queued. You may cancel only before dispatch reaches its point of no return."
                            : "Approved and queued. An administrator may cancel only before dispatch starts."
                          : "Current immutable execution history.";
          const cancel =
            item.status === "queued" && communicationPermissions.canCancel
              ? html`<button data-cancel-attempt="${escapeHtml(item.id)}">
                  Cancel before dispatch
                </button>`
              : "";
          const reconcile =
            item.status === "outcome_unknown" &&
            communicationPermissions.canReconcile
              ? html`<button data-reconcile-attempt="${escapeHtml(item.id)}">
                  Reconcile outcome
                </button>`
              : "";
          return html`<article
            class="crm-card"
            data-communication-state="${escapeHtml(state)}"
          >
            <header>
              <strong>Reviewed send</strong
              ><span hidden>${escapeHtml(state)}</span
              ><span>${escapeHtml(humanizeOptionLabel(state))}</span>
            </header>
            <p>${guidance}</p>
            ${cancel}${reconcile}
          </article>`;
        })
        .join("");
      root.innerHTML = `${controls}${disabledBanner}${suggestionCards}${draftCards}${attemptCards}`;
    }
    async function loadCommunications(bookingId) {
      selectedBookingId = bookingId;
      let cursor = "";
      let pageCount = 0;
      const items = [];
      do {
        const query = new URLSearchParams({ limit: "50" });
        if (cursor) query.set("cursor", cursor);
        const result = await api(
          `/bookings/${bookingId}/communications?${query}`,
        );
        items.push(...(result.items || []));
        communicationConfig = result.config || { enabled: false };
        communicationPermissions =
          result.permissions || communicationPermissions;
        cursor = result.nextCursor || "";
        pageCount += 1;
        if (pageCount > 20)
          throw new Error(
            "Communication history is too large to display safely",
          );
      } while (cursor);
      communicationItems = items;
      drawCommunications();
    }
    async function showExactReview(communicationId, version) {
      const presentation = await api(
        `/communications/${communicationId}/presentations`,
        {
          method: "POST",
          body: JSON.stringify({ version }),
        },
      );
      currentReview = {
        communicationId,
        version,
        presentationId: presentation.presentationId,
        token: presentation.token,
      };
      activeSponsorReviewCleanup = revokeCurrentReview;
      const preview = presentation.preview;
      const reviewDialog = surface.querySelector(
        "[data-communication-review-dialog]",
      );
      reviewDialog.querySelector("[data-review-warning]").textContent =
        communicationPermissions.canApprove
          ? [
              "Approval queues exactly this one-recipient plain-text message.",
              "It never sends inline; the worker rechecks authority, source revisions, suppression, and the kill switch.",
            ].join(" ")
          : [
              "This is an exact private preview.",
              "Save the draft for an administrator; this review cannot approve or send.",
            ].join(" ");
      reviewDialog.querySelector("[data-review-addresses]").innerHTML =
        html`<dt>From</dt>
          <dd>${escapeHtml(preview.from)}</dd>
          ${
            preview.replyTo
              ? html`<dt>Reply-To</dt>
                  <dd>${escapeHtml(preview.replyTo)}</dd>`
              : ""
          }
          <dt>To</dt>
          <dd>${escapeHtml(preview.to)}</dd>
          <dt>Type</dt>
          <dd>${escapeHtml(preview.communicationType)}</dd>`;
      reviewDialog.querySelector("[data-review-subject]").textContent =
        preview.subject;
      reviewDialog.querySelector("[data-review-body]").textContent =
        preview.body;
      reviewDialog.querySelector("[data-review-links]").innerHTML = (
        preview.publicLinks || []
      )
        .map((link) => html`<p>${escapeHtml(link)}</p>`)
        .join("");
      reviewDialog.querySelector("[data-review-status]").textContent =
        `Exact preview hash: ${presentation.previewHash}`;
      reviewDialog.querySelector("[data-approve-message]").hidden =
        !communicationPermissions.canApprove;
      reviewDialog.showModal();
    }
    async function revokeCurrentReview(reason = "close") {
      const reviewDialog = surface.querySelector(
        "[data-communication-review-dialog]",
      );
      if (!currentReview) {
        if (reviewDialog.open) reviewDialog.close();
        activeSponsorReviewCleanup = null;
        return true;
      }
      const closeButton = reviewDialog.querySelector("[data-review-close]");
      const approveButton = reviewDialog.querySelector(
        "[data-approve-message]",
      );
      closeButton.disabled = true;
      approveButton.disabled = true;
      reviewDialog.querySelector("[data-review-status]").textContent =
        "Revoking this one-time review…";
      try {
        await api(
          `/communications/${currentReview.communicationId}/presentations/${currentReview.presentationId}/reject`,
          { method: "POST", body: "{}" },
        );
        currentReview = null;
        activeSponsorReviewCleanup = null;
        reviewDialog.close();
        if (reason !== "navigation")
          message.textContent =
            "Exact review revoked. The saved draft remains available for a fresh review.";
        return true;
      } catch (error) {
        reviewDialog.querySelector("[data-review-status]").textContent =
          `Could not revoke this review: ${error.message}. Retry Reject / close before leaving.`;
        message.textContent =
          "The review is still active and visible. Retry revocation before navigating or regenerate after reloading.";
        return false;
      } finally {
        closeButton.disabled = false;
        approveButton.disabled = false;
      }
    }
    activeSponsorReviewCleanup = revokeCurrentReview;
    async function refresh() {
      message.textContent = "Loading sponsor CRM…";
      const results = await Promise.all([
        api("/organizations"),
        api("/contacts"),
        api("/bookings"),
        request(workApiUrl("/api/notifications")),
      ]);
      organizations = results[0].items || [];
      contacts = results[1].items || [];
      bookings = results[2].items || [];
      const alerts = (results[3].notifications || []).filter(
        (item) =>
          (item.metadata?.sponsorBookingId ||
            item.metadata?.financeBookingId) &&
          !item.dismissed,
      );
      surface.querySelector("[data-crm-alerts]").innerHTML = alerts.length
        ? alerts
            .map(
              (item) =>
                html`<article class="crm-card">
                  <strong>${escapeHtml(item.message)}</strong>
                  <p>Due ${escapeHtml(item.dueAt || "now")}</p>
                  <button
                    data-alert-booking="${escapeHtml(item.metadata.sponsorBookingId || item.metadata.financeBookingId)}"
                  >
                    Open booking
                  </button>
                </article>`,
            )
            .join("")
        : "No active sponsor booking alerts.";
      orgOptions();
      draw();
      message.textContent = "Sponsor CRM ready.";
    }
    function openBooking(item) {
      const dialog = surface.querySelector("[data-booking-dialog]"),
        form = dialog.querySelector("form");
      form.reset();
      for (const field of form.elements)
        if (item && field.name && item[field.name] != null)
          field.value = Array.isArray(item[field.name])
            ? item[field.name].join("\n")
            : item[field.name];
      form.elements.bookingId.value = item?.id || "";
      const orgId = item?.organizationId || form.elements.organizationId.value;
      form.elements.primaryContactId.innerHTML = html`<option value="">
          No contact
        </option>
        ${contacts
          .filter(
            (value) => value.organizationId === orgId && !value.archivedAt,
          )
          .map(
            (value) =>
              html`<option value="${escapeHtml(value.id)}">
                ${escapeHtml(value.name)}
              </option>`,
          )
          .join("")}`;
      if (item?.primaryContactId)
        form.elements.primaryContactId.value = item.primaryContactId;
      dialog.showModal();
    }
    surface
      .querySelectorAll("[data-crm-search],[data-crm-active],[data-crm-status]")
      .forEach((input) => input.addEventListener("input", draw));
    surface.querySelector("[data-add-org]").onclick = () =>
      surface.querySelector("[data-org-dialog]").showModal();
    surface.querySelector("[data-add-booking]").onclick = () =>
      openBooking(null);
    surface.querySelector("[data-crm-orgs]").onclick = (event) => {
      const contact =
          event.target.closest("[data-contact-org]")?.dataset.contactOrg,
        archive =
          event.target.closest("[data-archive-org]")?.dataset.archiveOrg;
      if (contact) {
        const form = surface.querySelector("[data-contact-dialog] form");
        form.reset();
        form.elements.organizationId.value = contact;
        surface.querySelector("[data-contact-dialog]").showModal();
      }
      if (archive)
        safe(async () => {
          const organization = organizations.find(
            (item) => item.id === archive,
          );
          if (
            !(await confirmSponsorAction(
              "Archive sponsor organization?",
              `${organization?.displayName || "This organization"} will leave the active directory. Existing bookings and history remain available.`,
              "Archive sponsor",
            ))
          )
            return;
          await api(`/organizations/${archive}`, { method: "DELETE" });
          await refresh();
        }, "Could not archive sponsor");
    };
    surface.querySelector("[data-crm-bookings]").onclick = (event) => {
      const edit = event.target.closest("[data-edit-booking]")?.dataset
          .editBooking,
        open = event.target.closest("[data-open-booking]")?.dataset.openBooking;
      if (edit) openBooking(bookings.find((item) => item.id === edit));
      if (open) navigateCanonicalWorkspace("/sponsors", { bookingId: open });
    };
    surface.querySelector("[data-crm-alerts]").onclick = (event) => {
      const id = event.target.closest("[data-alert-booking]")?.dataset
        .alertBooking;
      const booking = bookings.find((item) => item.id === id);
      if (booking) {
        navigateCanonicalWorkspace("/sponsors", { bookingId: id });
      }
    };
    for (const dialog of surface.querySelectorAll("dialog")) {
      const cancel = dialog.querySelector('[value="cancel"],[data-cancel]');
      if (cancel) cancel.onclick = () => dialog.close();
    }
    surface.querySelector("[data-evaluate-communications]").onclick = () =>
      safe(async () => {
        const result = await api("/communications/evaluate", {
          method: "POST",
          body: "{}",
        });
        message.textContent = `Suggestions refreshed: ${result.created.length} new, ${result.existing.length} already known. No messages were drafted or sent.`;
        if (selectedBookingId) await loadCommunications(selectedBookingId);
      }, "Could not refresh communication suggestions");
    surface.addEventListener("click", (event) => {
      if (!event.target.closest("[data-crm-communications]")) return;
      if (event.target.closest("[data-list-suppression-orphans]")) {
        safe(async () => {
          const result = await api(
            "/communications/suppressions/orphans?limit=20",
          );
          const dialog = surface.querySelector(
            "[data-suppression-orphan-dialog]",
          );
          dialog.querySelector("[data-suppression-orphans]").innerHTML = result
            .items?.length
            ? result.items
                .map(
                  (item) =>
                    html`<article class="crm-card">
                      <strong
                        >Redacted suppression record ·
                        ${escapeHtml(humanizeOptionLabel(item.status))}</strong
                      >
                      <p>
                        The retired suppression key needs an administrator
                        decision.
                      </p>
                      ${item.status === "unresolved" ? html`<button data-reconcile-suppression-orphan="${escapeHtml(item.id)}">Resolve exception</button>` : ""}
                    </article>`,
                )
                .join("")
            : html`
              <p>No unresolved migration exceptions.</p>
            `;
          for (const button of dialog.querySelectorAll(
            "[data-reconcile-suppression-orphan]",
          )) {
            button.onclick = (click) => {
              click.preventDefault();
              const reason = window.prompt(
                "Why is it safe to resolve this redacted suppression exception?",
              );
              if (!reason) return;
              safe(async () => {
                await api(
                  `/communications/suppressions/orphans/${button.dataset.reconcileSuppressionOrphan}/reconcile`,
                  {
                    method: "POST",
                    body: JSON.stringify({ reason }),
                  },
                );
                dialog.close();
                message.textContent =
                  "Suppression migration exception resolved.";
              }, "Could not resolve migration exception");
            };
          }
          dialog.showModal();
        }, "Could not load migration exceptions");
        return;
      }
      if (event.target.closest("[data-suppress-address]")) {
        const booking = bookings.find((item) => item.id === selectedBookingId);
        const recipients = contacts
          .filter(
            (item) =>
              item.organizationId === booking?.organizationId &&
              item.active !== false &&
              !item.archivedAt,
          )
          .flatMap((item) =>
            (item.emails || []).map((email) => ({
              contactId: item.id,
              name: item.name,
              email,
            })),
          );
        const dialog = surface.querySelector("[data-suppression-dialog]");
        const form = dialog.querySelector("form");
        form.reset();
        form.elements.recipient.innerHTML = recipients
          .map(
            (item) =>
              html`<option
                value="${escapeHtml(item.email)}"
                data-contact-id="${escapeHtml(item.contactId)}"
              >
                ${escapeHtml(item.name || "Sponsor contact")} ·
                ${escapeHtml(item.email)}
              </option>`,
          )
          .join("");
        dialog.showModal();
        return;
      }
      const cancelAttempt = event.target.closest("[data-cancel-attempt]")
        ?.dataset.cancelAttempt;
      if (cancelAttempt) {
        safe(async () => {
          await api(`/communications/attempts/${cancelAttempt}/cancel`, {
            method: "POST",
            body: "{}",
          });
          await loadCommunications(selectedBookingId);
        }, "Could not cancel before dispatch");
        return;
      }
      const reconcileAttempt = event.target.closest("[data-reconcile-attempt]")
        ?.dataset.reconcileAttempt;
      if (reconcileAttempt) {
        const reason = window.prompt(
          "Record why this provider outcome is considered no effect. This never resends the message.",
        );
        if (!reason) return;
        safe(async () => {
          await api(`/communications/attempts/${reconcileAttempt}/reconcile`, {
            method: "POST",
            body: JSON.stringify({ resolution: "no_effect", reason }),
          });
          await loadCommunications(selectedBookingId);
        }, "Could not reconcile provider uncertainty");
        return;
      }
      const reviewDraft = event.target.closest("[data-review-draft]");
      if (reviewDraft) {
        safe(
          async () =>
            showExactReview(
              reviewDraft.dataset.reviewDraft,
              Number(reviewDraft.dataset.draftVersion),
            ),
          "Could not generate a fresh exact review",
        );
        return;
      }
      const suggestionId = event.target.closest("[data-draft-suggestion]")
        ?.dataset.draftSuggestion;
      if (!suggestionId) return;
      const suggestion = communicationItems.find(
        (item) => item.id === suggestionId,
      );
      const booking = bookings.find((item) => item.id === selectedBookingId);
      const recipients = contacts
        .filter(
          (item) =>
            item.organizationId === booking?.organizationId &&
            item.active !== false &&
            !item.archivedAt,
        )
        .flatMap((item) =>
          (item.emails || []).map((email) => ({
            contactId: item.id,
            name: item.name,
            email,
          })),
        );
      if (!suggestion || !recipients.length) {
        message.textContent =
          "At least one active contact address in this sponsor organization is required before drafting.";
        return;
      }
      const dialog = surface.querySelector("[data-communication-draft-dialog]");
      const form = dialog.querySelector("form");
      form.reset();
      form.elements.suggestionId.value = suggestionId;
      form.elements.recipient.innerHTML = recipients
        .map(
          (item) =>
            html`<option
              value="${escapeHtml(item.email)}"
              data-contact-id="${escapeHtml(item.contactId)}"
            >
              ${escapeHtml(item.name || "Sponsor contact")} ·
              ${escapeHtml(item.email)}
            </option>`,
        )
        .join("");
      surface.querySelector("[data-create-review]").textContent =
        communicationPermissions.canApprove
          ? "Save and review exact message"
          : "Save draft for admin review";
      dialog.showModal();
    });
    for (const dialog of surface.querySelectorAll("dialog"))
      dialog
        .querySelector('[value="cancel"]')
        ?.addEventListener("click", () => dialog.close());
    const reviewDialog = surface.querySelector(
      "[data-communication-review-dialog]",
    );
    reviewDialog.querySelector("[data-review-close]").onclick = (event) => {
      event.preventDefault();
      revokeCurrentReview("close");
    };
    reviewDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      revokeCurrentReview("escape");
    });
    surface.querySelector("[data-org-save]").onclick = (event) => {
      event.preventDefault();
      const dialog = surface.querySelector("[data-org-dialog]"),
        form = dialog.querySelector("form");
      safe(async () => {
        const data = Object.fromEntries(new FormData(form));
        if (!data.displayName) throw new Error("Name is required");
        await api("/organizations", {
          method: "POST",
          body: JSON.stringify(data),
        });
        dialog.close();
        await refresh();
      }, "Could not save sponsor");
    };
    surface.querySelector("[data-contact-save]").onclick = (event) => {
      event.preventDefault();
      const dialog = surface.querySelector("[data-contact-dialog]"),
        form = dialog.querySelector("form");
      safe(async () => {
        const data = Object.fromEntries(new FormData(form));
        if (!data.name || !data.email)
          throw new Error("Name and email are required");
        data.emails = [data.email];
        delete data.email;
        data.primary = form.elements.primary.checked;
        await api("/contacts", { method: "POST", body: JSON.stringify(data) });
        dialog.close();
        await refresh();
      }, "Could not save contact");
    };
    surface.querySelector("[data-booking-save]").onclick = (event) => {
      event.preventDefault();
      const dialog = surface.querySelector("[data-booking-dialog]"),
        form = dialog.querySelector("form");
      safe(async () => {
        const data = Object.fromEntries(
          [...new FormData(form)].filter(([, value]) => value !== ""),
        );
        if (data.version) data.version = Number(data.version);
        if (data.artifactUrls)
          data.artifactUrls = data.artifactUrls.split("\n").filter(Boolean);
        const id = data.bookingId;
        delete data.bookingId;
        await api(`/bookings${id ? `/${id}` : ""}`, {
          method: id ? "PUT" : "POST",
          body: JSON.stringify(data),
        });
        dialog.close();
        await refresh();
      }, "Could not save booking");
    };
    surface.querySelector("[data-save-suppression]").onclick = (event) => {
      event.preventDefault();
      const dialog = surface.querySelector("[data-suppression-dialog]");
      const form = dialog.querySelector("form");
      safe(async () => {
        const value = Object.fromEntries(new FormData(form));
        const selectedRecipient = form.elements.recipient.selectedOptions[0];
        if (!selectedRecipient) throw new Error("Select one recipient");
        if (!value.reason) throw new Error("A reason is required");
        await api(
          `/contacts/${selectedRecipient.dataset.contactId}/suppressions`,
          {
            method: "POST",
            body: JSON.stringify({
              email: value.recipient,
              reason: value.reason,
            }),
          },
        );
        dialog.close();
        message.textContent =
          "Future messages to the selected sponsor address are suppressed. In-flight mail cannot be recalled.";
        await loadCommunications(selectedBookingId);
      }, "Could not add suppression");
    };
    surface.querySelector("[data-create-review]").onclick = (event) => {
      event.preventDefault();
      const draftDialog = surface.querySelector(
        "[data-communication-draft-dialog]",
      );
      const form = draftDialog.querySelector("form");
      safe(async () => {
        const value = Object.fromEntries(new FormData(form));
        const selectedRecipient = form.elements.recipient.selectedOptions[0];
        if (!selectedRecipient) throw new Error("Select one recipient");
        const publicLinks = value.publicLink ? [value.publicLink] : [];
        const draft = await api(
          `/communication-suggestions/${value.suggestionId}/drafts`,
          {
            method: "POST",
            body: JSON.stringify({
              contactId: selectedRecipient.dataset.contactId,
              recipient: value.recipient,
              subject: value.subject,
              body: value.body,
              publicLinks,
            }),
          },
        );
        draftDialog.close();
        await loadCommunications(selectedBookingId);
        if (communicationPermissions.canApprove) {
          await showExactReview(draft.communicationId, draft.version);
        } else {
          message.textContent = `Draft version ${draft.version} saved. Awaiting administrator review; no message was approved or sent.`;
        }
      }, "Could not save sponsor message draft");
    };
    surface.querySelector("[data-approve-message]").onclick = (event) => {
      event.preventDefault();
      if (!currentReview) return;
      const reviewDialog = surface.querySelector(
        "[data-communication-review-dialog]",
      );
      safe(async () => {
        const oneTimeReview = currentReview;
        if (!oneTimeReview || !communicationPermissions.canApprove)
          throw new Error("A fresh administrator review is required");
        let result;
        try {
          result = await api(
            `/communications/${oneTimeReview.communicationId}/approve`,
            {
              method: "POST",
              body: JSON.stringify({
                version: oneTimeReview.version,
                presentationId: oneTimeReview.presentationId,
                token: oneTimeReview.token,
              }),
            },
          );
        } catch (error) {
          reviewDialog.querySelector("[data-review-status]").textContent =
            `Approval was not applied: ${error.message}. Keep this review open to retry, or revoke it before leaving.`;
          throw error;
        }
        currentReview = null;
        activeSponsorReviewCleanup = null;
        reviewDialog.close();
        message.textContent =
          "Approved immutable message queued for dispatch. No provider call occurred in this request.";
        await loadCommunications(selectedBookingId);
      }, "Approval was not applied");
    };
    try {
      await refresh();
      if (
        routeToken &&
        (!isWorkspaceRouteFresh(routeToken) || !surface.isConnected)
      )
        return;
      if (requestedBookingId) {
        let booking = bookings.find((item) => item.id === requestedBookingId);
        try {
          if (!booking) {
            booking = await api(
              `/bookings/${encodeURIComponent(requestedBookingId)}`,
            );
            if (
              routeToken &&
              (!isWorkspaceRouteFresh(routeToken) || !surface.isConnected)
            )
              return;
            bookings = [booking, ...bookings];
            draw();
          }
          await reopenBookingDetail(booking);
        } catch (error) {
          if (
            routeToken &&
            (!isWorkspaceRouteFresh(routeToken) || !surface.isConnected)
          )
            return;
          const detail = surface.querySelector("[data-crm-detail]");
          renderEntityLoadState(detail, {
            kind: "booking",
            id: requestedBookingId,
            status: error.status === 404 ? "not-found" : "error",
            error: error.message,
            retry: () => renderSponsorCrmSurface(),
            returnToList: () => {
              navigateCanonicalWorkspace("/sponsors");
            },
          });
        }
      }
    } catch (error) {
      surface.querySelector("[data-crm-orgs]").textContent =
        "Could not load sponsors.";
      surface.querySelector("[data-crm-bookings]").textContent =
        "Could not load bookings.";
      message.textContent = `Permission or API error: ${error.message}. Reopen Sponsors to retry.`;
    }
  }

  async function renderMailingExportsSurface() {
    const surface = document.createElement("section");
    surface.className = "mailing-exports-surface";
    surface.innerHTML = html`<header>
        <div>
          <h2>Mailing-list exports</h2>
          <p>
            Private account-wide audiences archives. Mailchimp permits one
            export at a time and one completed export per 24 hours.
          </p>
        </div>
        <button type="button" data-refresh>Refresh</button>
      </header>
      <p role="status" aria-live="polite">Loading export configurations…</p>
      <div data-configs></div>
      <section aria-labelledby="mailing-history-heading">
        <h3 id="mailing-history-heading">Run history</h3>
        <div data-history></div>
      </section>`;
    documentList.replaceChildren(surface);
    const status = surface.querySelector('[role="status"]');
    const configsRoot = surface.querySelector("[data-configs]");
    const historyRoot = surface.querySelector("[data-history]");
    const api = (path = "", options = {}) =>
      request(workApiUrl(`/api/mailing-exports${path}`), {
        headers: {
          "content-type": "application/json",
          ...(options.headers || {}),
        },
        ...options,
      });
    const actionCopy = {
      wait: "Wait for the provider, then refresh or advance this run.",
      retry: "Retry this run with the same key.",
      "fix-authorization": "Fix provider authorization, then retry.",
      "fix-storage": "Fix private storage access, then retry.",
      "fix-task-link":
        "Fix the recurring-task link; the archive remains stored.",
      download: "Archive ready for a private five-minute download.",
    };
    const formatTime = (value) =>
      value
        ? new Date(value).toLocaleString([], {
            dateStyle: "medium",
            timeStyle: "short",
          })
        : "Not yet";
    const actionRunKey = (run) =>
      run &&
      ["requested", "pending", "failed"].includes(run.status) &&
      run.runKey
        ? run.runKey
        : new Date().toISOString().slice(0, 10);

    function runCard(config, run) {
      const state = run?.status || "empty";
      const next = run?.nextAction
        ? actionCopy[run.nextAction]
        : "Start the first account-wide audiences export.";
      return html`<article
        class="mailing-export-card"
        data-export-state="${escapeHtml(state)}"
      >
        <header>
          <div>
            <h3>${escapeHtml(config.account)}</h3>
            <p>
              ${escapeHtml(config.scopeLabel)} · ${escapeHtml(config.provider)}
            </p>
          </div>
          <span class="mailing-export-status">${escapeHtml(state)}</span>
        </header>
        <dl>
          <div>
            <dt>Requested</dt>
            <dd>${formatTime(run?.requestedAt)}</dd>
          </div>
          <div>
            <dt>Completed</dt>
            <dd>${formatTime(run?.completedAt)}</dd>
          </div>
          <div>
            <dt>Recurring task</dt>
            <dd>
              ${escapeHtml(run?.taskId ? `${run.taskLinkStatus || "pending"} · ${run.taskId}` : "Not configured")}
            </dd>
          </div>
          <div>
            <dt>Artifact</dt>
            <dd>${escapeHtml(run?.artifactId || "Not created")}</dd>
          </div>
        </dl>
        ${run?.errorMessage ? html`<p class="mailing-export-error" role="alert"><strong>${escapeHtml(run.errorCode)}</strong> · ${escapeHtml(run.errorMessage)}</p>` : ""}
        <p>
          ${escapeHtml(next)}${run?.retryAfter ? ` Earliest retry: ${escapeHtml(formatTime(run.retryAfter))}.` : ""}
        </p>
        <div class="mailing-export-actions">
          <button
            type="button"
            class="primary-button"
            data-run="${escapeHtml(config.id)}"
            data-run-key="${escapeHtml(actionRunKey(run))}"
          >
            ${run && run.status !== "completed" ? "Advance / retry" : "Start daily export"}</button
          >${run?.status === "completed" && run.artifactId ? html`<button type="button" data-download="${escapeHtml(run.artifactId)}">Download ZIP</button>` : ""}
        </div>
      </article>`;
    }

    async function load() {
      status.textContent = "Loading export configurations…";
      try {
        const result = await api();
        const configs = result.configs || [],
          runs = result.exports || [];
        if (!configs.length) {
          configsRoot.innerHTML = html`<div
            class="honest-state"
            data-export-state="no-config"
          >
            <strong>No export configurations</strong>
            <p>
              Add an enabled provider configuration through the approved deploy
              mechanism. No secret values belong in the portal.
            </p>
          </div>`;
        } else {
          configsRoot.innerHTML = configs
            .map((config) =>
              runCard(
                config,
                runs.find((run) => run.configId === config.id),
              ),
            )
            .join("");
        }
        historyRoot.innerHTML = runs.length
          ? runs
              .map(
                (run) =>
                  html`<article class="mailing-export-history">
                    <strong
                      >${escapeHtml(run.account)} ·
                      ${escapeHtml(run.status)}</strong
                    ><span
                      >${escapeHtml(run.scopeLabel)} · requested
                      ${escapeHtml(formatTime(run.requestedAt))}${run.completedAt ? ` · completed ${escapeHtml(formatTime(run.completedAt))}` : ""}</span
                    >
                  </article>`,
              )
              .join("")
          : html`<div class="honest-state" data-export-state="empty">
              <strong>No export runs yet</strong>
              <p>Start an enabled configuration to create durable history.</p>
            </div>`;
        status.textContent = configs.length
          ? `${configs.length} export configuration${configs.length === 1 ? "" : "s"} loaded.`
          : "No export configurations are enabled.";
      } catch (error) {
        status.textContent = `Could not load mailing-list exports: ${error.message}`;
        configsRoot.innerHTML = html`<div
          class="honest-state"
          data-export-state="failure"
        >
          <strong>Exports unavailable</strong>
          <p>
            Retry with Refresh. No provider or archive details were exposed.
          </p>
        </div>`;
        historyRoot.replaceChildren();
      }
    }

    surface.querySelector("[data-refresh]").addEventListener("click", load);
    configsRoot.addEventListener("click", async (event) => {
      const run = event.target.closest("[data-run]");
      const download = event.target.closest("[data-download]");
      if (run) {
        run.disabled = true;
        run.setAttribute("aria-busy", "true");
        status.textContent = "Requesting or advancing the durable export run…";
        try {
          await api("/run", {
            method: "POST",
            body: JSON.stringify({
              configId: run.dataset.run,
              runKey: run.dataset.runKey,
            }),
          });
          await load();
        } catch (error) {
          status.textContent = `Could not advance export: ${error.message}`;
          run.disabled = false;
          run.removeAttribute("aria-busy");
        }
      }
      if (download) {
        download.disabled = true;
        download.setAttribute("aria-busy", "true");
        status.textContent = "Preparing a private five-minute download…";
        try {
          const result = await request(
            workApiUrl(
              `/api/artifacts/${encodeURIComponent(download.dataset.download)}/download`,
            ),
          );
          const link = document.createElement("a");
          link.href = result.downloadUrl;
          link.target = "_blank";
          link.rel = "noopener";
          link.click();
          status.textContent =
            "Private download prepared. The link expires in five minutes.";
        } catch (error) {
          status.textContent = `Could not prepare download: ${error.message}`;
        } finally {
          download.disabled = false;
          download.removeAttribute("aria-busy");
        }
      }
    });
    await load();
  }

  async function renderBookkeepingSurface() {
    documentList.replaceChildren();
    const surface = document.createElement("section");
    surface.className = "bookkeeping-surface";
    surface.innerHTML = html` <header class="bookkeeping-header">
        <div>
          <p class="surface-eyebrow">Monthly close</p>
          <h2>Bookkeeping</h2>
          <p>
            Record the ledger, match private evidence, and prepare a reviewable
            monthly package.
          </p>
        </div>
        <button class="primary-button" data-bookkeeping-add>Add entry</button>
      </header>
      <nav class="bookkeeping-job-nav" aria-label="Bookkeeping jobs">
        <a href="#bookkeeping-ledger"
          ><span>1</span><strong>Record ledger</strong
          ><small>Transactions and totals</small></a
        ><a href="#bookkeeping-evidence"
          ><span>2</span><strong>Match evidence</strong
          ><small>PDFs and references</small></a
        ><a href="#bookkeeping-package"
          ><span>3</span><strong>Close month</strong
          ><small>Review package</small></a
        >
      </nav>
      <p data-bookkeeping-status class="surface-status" role="status">
        Private downloads expire after five minutes.
      </p>
      <section
        id="bookkeeping-ledger"
        class="bookkeeping-section bookkeeping-ledger-section"
        aria-labelledby="bookkeeping-ledger-heading"
      >
        <header class="section-header">
          <div>
            <p class="section-kicker">Job 1</p>
            <h3 id="bookkeeping-ledger-heading">
              Record and review the ledger
            </h3>
            <p>
              Filter transactions, confirm totals, and open an entry only when
              it needs work.
            </p>
          </div>
          <p class="bookkeeping-totals" aria-live="polite"></p>
        </header>
        <div class="bookkeeping-filters">
          <label
            >Search
            <input
              data-filter="search"
              type="search"
              placeholder="Provider, description, or category" /></label
          ><label
            >Year
            <select data-filter="year">
              <option value="">All years</option>
            </select></label
          >
          <details>
            <summary>More filters</summary>
            <div class="bookkeeping-filter-more">
              <label>Type <input data-filter="entryType" /></label
              ><label>Category <input data-filter="category" /></label
              ><label
                >Provider / payee <input data-filter="counterparty" /></label
              ><label
                >Currency <input data-filter="currency" maxlength="3"
              /></label>
            </div>
          </details>
        </div>
        <div class="bookkeeping-ledger" aria-live="polite">Loading ledger…</div>
      </section>
      <section
        id="bookkeeping-evidence"
        class="bookkeeping-section bookkeeping-evidence"
        aria-labelledby="bookkeeping-evidence-heading"
      >
        <header class="section-header">
          <div>
            <p class="section-kicker">Job 2</p>
            <h3 id="bookkeeping-evidence-heading">
              Match transaction evidence
            </h3>
            <p>
              Upload verified PDFs and connect each file to the ledger entry it
              supports.
            </p>
          </div>
          <button class="quiet-button" data-setup-accounts>
            Set up business accounts
          </button>
        </header>
        <div class="bookkeeping-upload">
          <label class="bookkeeping-file"
            >PDF evidence
            <input type="file" accept="application/pdf,.pdf" data-pdf /></label
          ><label
            >Document type
            <select data-document-type>
              <option value="invoice">Invoice</option>
              <option value="receipt">Receipt</option>
              <option value="bank-statement">Bank statement</option>
              <option value="private-account-statement">
                Private account statement
              </option>
            </select></label
          ><label
            >Account
            <select data-account>
              <option value="">No account</option>
            </select></label
          ><label
            >Statement month <input type="month" data-statement-month /></label
          ><label class="bookkeeping-transaction-link"
            >Link to transaction
            <select data-transaction>
              <option value="">No transaction</option>
            </select></label
          ><button class="primary-button" data-upload>Upload PDF</button>
        </div>
        <div class="bookkeeping-documents" aria-live="polite">
          Loading documents…
        </div>
      </section>
      <section
        id="bookkeeping-package"
        class="bookkeeping-section bookkeeping-package-section"
        aria-labelledby="bookkeeping-package-heading"
      >
        <header class="section-header">
          <div>
            <p class="section-kicker">Job 3</p>
            <h3 id="bookkeeping-package-heading">
              Prepare the monthly package
            </h3>
            <p>
              Choose the reporting month and include private-account statements
              only when they are needed.
            </p>
          </div>
        </header>
        <fieldset class="bookkeeping-private-statements">
          <legend>Optional private-account statements</legend>
          <div data-private-statements>No eligible private statements.</div>
        </fieldset>
        <div class="bookkeeping-package">
          <label>Report month <input type="month" data-report-month /></label
          ><button class="primary-button" data-report>
            Create monthly package
          </button>
        </div>
      </section>
      <dialog class="surface-dialog bookkeeping-entry-dialog">
        <form method="dialog" novalidate>
          <header>
            <p class="surface-eyebrow">Ledger record</p>
            <h3>Bookkeeping entry</h3>
            <p>
              Required fields describe the transaction. Payment and
              classification details may be added later.
            </p>
          </header>
          <div class="dialog-fields bookkeeping-entry-fields">
            <input type="hidden" name="id" /><label
              >Transaction date
              <input name="transactionDate" type="date" /></label
            ><label>Paid date <input name="paidDate" type="date" /></label
            ><label class="span-all"
              >Provider / payee <input name="counterparty" /></label
            ><label class="span-all"
              >Description <input name="description" /></label
            ><label>Amount <input name="amount" inputmode="decimal" /></label
            ><label
              >Currency
              <input name="currency" maxlength="3" value="EUR" /></label
            ><label>Category <input name="category" /></label
            ><label>Type <input name="entryType" /></label
            ><label class="span-all"
              >Statement / reference <input name="statementRef"
            /></label>
            <p class="span-all" role="alert" data-form-error></p>
          </div>
          <footer class="bookkeeping-actions">
            <button class="primary-button" data-save>Save</button
            ><button value="cancel">Cancel</button>
          </footer>
        </form>
      </dialog>
      <dialog class="surface-dialog bookkeeping-delete-dialog">
        <form method="dialog">
          <header>
            <p class="surface-eyebrow">Destructive change</p>
            <h3>Delete bookkeeping entry?</h3>
            <p>
              <strong data-delete-entry-name>This ledger entry</strong> will be
              permanently removed. Linked evidence is not deleted.
            </p>
          </header>
          <footer>
            <button type="button" class="danger-button" data-delete-confirm>
              Delete entry</button
            ><button value="cancel" data-delete-cancel>Keep entry</button>
          </footer>
        </form>
      </dialog>`;
    documentList.append(surface);
    setPageTitle("Bookkeeping", "Bookkeeping");
    let entries = [],
      documents = [],
      links = [];
    const ledger = surface.querySelector(".bookkeeping-ledger"),
      totals = surface.querySelector(".bookkeeping-totals"),
      entryDialog = surface.querySelector(".bookkeeping-entry-dialog"),
      form = entryDialog.querySelector("form"),
      status = surface.querySelector("[data-bookkeeping-status]");
    const api = (path, options = {}) =>
      request(workApiUrl(`/api/bookkeeping${path}`), {
        headers: {
          "content-type": "application/json",
          ...(options.headers || {}),
        },
        ...options,
      });
    async function safeAction(action, fallback) {
      try {
        await action();
      } catch (error) {
        status.textContent = `${fallback}: ${error.message}`;
      }
    }
    function openPrivateDownload(url) {
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener";
      link.click();
    }
    function renderLedger() {
      const filters = Object.fromEntries(
        [...surface.querySelectorAll("[data-filter]")].map((el) => [
          el.dataset.filter,
          el.value.trim(),
        ]),
      );
      const shown = entries.filter(
        (e) =>
          (!filters.year || e.transactionDate.startsWith(filters.year)) &&
          (!filters.entryType ||
            String(e.entryType || "")
              .toLowerCase()
              .includes(filters.entryType.toLowerCase())) &&
          (!filters.category ||
            String(e.category || "")
              .toLowerCase()
              .includes(filters.category.toLowerCase())) &&
          (!filters.counterparty ||
            e.counterparty
              .toLowerCase()
              .includes(filters.counterparty.toLowerCase())) &&
          (!filters.currency ||
            e.currency === filters.currency.toUpperCase()) &&
          (!filters.search ||
            [e.counterparty, e.description, e.category, e.entryType]
              .join(" ")
              .toLowerCase()
              .includes(filters.search.toLowerCase())),
      );
      const sums = {};
      shown.forEach(
        (e) => (sums[e.currency] = (sums[e.currency] || 0) + Number(e.amount)),
      );
      totals.textContent =
        Object.entries(sums)
          .map(([currency, amount]) => `${currency} ${amount.toFixed(2)}`)
          .join(" · ") || "No filtered total";
      ledger.innerHTML = shown.length
        ? html`<div class="bookkeeping-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Paid</th>
                  <th>Provider / description</th>
                  <th>Amount</th>
                  <th>Category / type</th>
                  <th>Evidence</th>
                  <th><span class="visually-hidden">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                ${shown
                  .map(
                    (e) =>
                      html`<tr>
                        <td data-label="Transaction date">
                          ${escapeHtml(e.transactionDate)}
                        </td>
                        <td data-label="Paid">
                          ${escapeHtml(e.paidDate || "Unpaid")}
                        </td>
                        <td data-label="Entry">
                          <strong>${escapeHtml(e.counterparty)}</strong
                          ><small>${escapeHtml(e.description)}</small>
                        </td>
                        <td data-label="Amount" class="ledger-amount">
                          ${escapeHtml(`${e.amount} ${e.currency}`)}
                        </td>
                        <td data-label="Category / type">
                          ${escapeHtml([e.category, e.entryType].filter(Boolean).join(" / ") || "—")}
                        </td>
                        <td data-label="Evidence">
                          <span
                            class="evidence-state ${e.statementRef ? "is-attached" : ""}"
                            >${escapeHtml(e.statementRef ? "Referenced" : "Missing")}</span
                          >
                        </td>
                        <td data-label="Actions">
                          <div class="row-actions">
                            <button data-edit="${escapeHtml(e.id)}">Edit</button
                            ><button
                              class="danger-text-button"
                              data-delete="${escapeHtml(e.id)}"
                            >
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>`,
                  )
                  .join("")}
              </tbody>
            </table>
          </div>`
        : html`<div class="honest-state">
            <strong>No bookkeeping entries</strong>
            <p>Adjust filters or add the first entry.</p>
          </div>`;
    }
    async function refreshEvidence() {
      const [docResult, linkResult, accountResult] = await Promise.all([
        api("/documents"),
        api("/links"),
        api("/accounts"),
      ]);
      documents = docResult.items || [];
      links = linkResult.items || [];
      surface.querySelector("[data-account]").innerHTML = html`<option value="">
          No account
        </option>
        ${(accountResult.items || []).map((a) => html`<option value="${escapeHtml(a.id)}">${escapeHtml(a.displayName)} (${escapeHtml(a.kind)})</option>`).join("")}`;
      surface.querySelector(".bookkeeping-documents").innerHTML =
        documents.length
          ? documents
              .map((d) => {
                const documentLinks = links.filter(
                  (l) => l.documentId === d.id,
                );
                const matchDescription = documentLinks.length
                  ? ` · matched to ${documentLinks.length} ${documentLinks.length === 1 ? "entry" : "entries"}`
                  : " · not matched";
                return html`<article class="bookkeeping-document-row">
                  <div>
                    <strong
                      >${escapeHtml(d.originalFilename || "Private PDF")}</strong
                    >
                    <p>
                      ${escapeHtml(humanizeOptionLabel(d.documentType))}${matchDescription}
                    </p>
                  </div>
                  <div class="row-actions">
                    <button data-download="${escapeHtml(d.id)}">Download</button
                    >${documentLinks
                      .map((l) => {
                        const transaction = entries.find(
                          (e) => e.id === l.transactionId,
                        );
                        return ` <button data-unlink="${escapeHtml(l.id)}">Unlink ${escapeHtml(transaction?.counterparty || "entry")}</button>`;
                      })
                      .join("")}
                  </div>
                </article>`;
              })
              .join("")
          : html`<div class="honest-state">
              <strong>No private documents uploaded</strong>
              <p>Choose a PDF above to add the first piece of evidence.</p>
            </div>`;
      const privateStatements = documents.filter(
        (d) => d.documentType === "private-account-statement",
      );
      surface.querySelector("[data-private-statements]").innerHTML =
        privateStatements.length
          ? privateStatements
              .map(
                (d) =>
                  html`<label class="checkbox-label"
                    ><input type="checkbox" value="${escapeHtml(d.id)}" />
                    <span
                      >${escapeHtml(d.originalFilename || "Private statement")}</span
                    ></label
                  >`,
              )
              .join("")
          : "No eligible private statements.";
    }
    try {
      const result = await api("/transactions");
      entries = result.items || [];
      const years = [
        ...new Set(entries.map((e) => e.transactionDate.slice(0, 4))),
      ]
        .sort()
        .reverse();
      surface
        .querySelector('[data-filter="year"]')
        .insertAdjacentHTML(
          "beforeend",
          years.map((y) => html`<option>${y}</option>`).join(""),
        );
      surface
        .querySelector("[data-transaction]")
        .insertAdjacentHTML(
          "beforeend",
          entries
            .map(
              (e) =>
                html`<option value="${escapeHtml(e.id)}">
                  ${escapeHtml(`${e.transactionDate} · ${e.counterparty}`)}
                </option>`,
            )
            .join(""),
        );
      renderLedger();
      await refreshEvidence();
    } catch (error) {
      ledger.textContent = `Could not load bookkeeping: ${error.message}`;
      surface.querySelector(".bookkeeping-documents").textContent =
        "Could not load private documents.";
      status.textContent = "Retry by reopening Bookkeeping.";
    }
    surface
      .querySelectorAll("[data-filter]")
      .forEach((el) => el.addEventListener("input", renderLedger));
    surface
      .querySelector("[data-bookkeeping-add]")
      .addEventListener("click", () => {
        form.reset();
        form.elements.currency.value = "EUR";
        entryDialog.querySelector("h3").textContent = "Add ledger entry";
        entryDialog.showModal();
      });
    form.addEventListener("input", (event) => {
      event.target.removeAttribute("aria-invalid");
      surface.querySelector("[data-form-error]").textContent = "";
    });
    ledger.addEventListener("click", (event) => {
      const edit = event.target.closest("[data-edit]")?.dataset.edit,
        del = event.target.closest("[data-delete]")?.dataset.delete;
      if (edit) {
        const item = entries.find((e) => e.id === edit);
        Object.keys(item).forEach((k) => {
          if (form.elements[k]) form.elements[k].value = item[k] || "";
        });
        entryDialog.querySelector("h3").textContent = "Edit ledger entry";
        entryDialog.showModal();
      }
      if (del) {
        const dialog = surface.querySelector(".bookkeeping-delete-dialog"),
          item = entries.find((e) => e.id === del);
        dialog.dataset.id = del;
        dialog.querySelector("[data-delete-entry-name]").textContent =
          item?.counterparty || "This ledger entry";
        dialog.showModal();
      }
    });
    surface.querySelector("[data-save]").addEventListener("click", (event) => {
      event.preventDefault();
      safeAction(async () => {
        const data = Object.fromEntries(
          [...new FormData(form)].filter(([, v]) => v !== ""),
        );
        const missing = [
          "transactionDate",
          "counterparty",
          "description",
          "amount",
          "currency",
        ].find((k) => !data[k]);
        if (missing) {
          const requiredFieldLabels = {
            transactionDate: "Transaction date",
            counterparty: "Provider / payee",
            description: "Description",
            amount: "Amount",
            currency: "Currency",
          };
          const field = form.elements[missing];
          field.setAttribute("aria-invalid", "true");
          field.focus();
          surface.querySelector("[data-form-error]").textContent =
            `${requiredFieldLabels[missing]} is required.`;
          return;
        }
        data.currency = data.currency.toUpperCase();
        const id = form.elements.id.value;
        const saved = await api(`/transactions${id ? `/${id}` : ""}`, {
          method: id ? "PUT" : "POST",
          body: JSON.stringify(data),
        });
        entries = id
          ? entries.map((e) => (e.id === id ? saved : e))
          : [saved, ...entries];
        entryDialog.close();
        renderLedger();
      }, "Could not save entry");
    });
    surface
      .querySelector("[data-delete-cancel]")
      .addEventListener("click", () =>
        surface.querySelector(".bookkeeping-delete-dialog").close(),
      );
    surface
      .querySelector("[data-delete-confirm]")
      .addEventListener("click", () =>
        safeAction(async () => {
          const dialog = surface.querySelector(".bookkeeping-delete-dialog");
          await api(`/transactions/${dialog.dataset.id}`, { method: "DELETE" });
          entries = entries.filter((e) => e.id !== dialog.dataset.id);
          dialog.close();
          renderLedger();
        }, "Could not delete entry"),
      );
    surface
      .querySelector("[data-setup-accounts]")
      .addEventListener("click", () =>
        safeAction(async () => {
          const result = await api("/accounts/setup", { method: "POST" });
          status.textContent = `${result.accounts.length} business accounts ready.`;
          await refreshEvidence();
        }, "Could not set up accounts"),
      );
    surface.querySelector("[data-upload]").addEventListener("click", () =>
      safeAction(async () => {
        const file = surface.querySelector("[data-pdf]").files[0];
        if (!file) {
          status.textContent = "Choose a PDF first.";
          return;
        }
        const bytes = await file.arrayBuffer(),
          sha256 = [
            ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
          ]
            .map((value) => value.toString(16).padStart(2, "0"))
            .join(""),
          runId = crypto.randomUUID(),
          idempotencyKey = crypto.randomUUID(),
          documentType = surface.querySelector("[data-document-type]").value;
        const ownership = { idempotencyKey, runId };
        const prepared = await api("/documents/prepare", {
          method: "POST",
          body: JSON.stringify({
            sha256,
            byteSize: file.size,
            documentType,
            ...ownership,
            sourceRef: `portal-${sha256.slice(0, 24)}`,
            accountId: ["bank-statement", "private-account-statement"].includes(
              documentType,
            )
              ? surface.querySelector("[data-account]").value || undefined
              : undefined,
            statementMonth: [
              "bank-statement",
              "private-account-statement",
            ].includes(documentType)
              ? surface.querySelector("[data-statement-month]").value ||
                undefined
              : undefined,
          }),
        });
        let completed = prepared;
        if (prepared.outcome !== "existing") {
          const uploaded = await fetch(prepared.uploadUrl, {
            method: "PUT",
            headers: prepared.uploadHeaders || {
              "content-type": "application/pdf",
            },
            body: file,
          });
          if (!uploaded.ok) throw new Error("Upload failed");
          completed = await api(`/documents/${prepared.document.id}/complete`, {
            method: "POST",
            body: JSON.stringify(ownership),
          });
        }
        const transactionId = surface.querySelector("[data-transaction]").value;
        if (transactionId)
          await api("/links", {
            method: "POST",
            body: JSON.stringify({
              documentId: completed.document.id,
              transactionId,
              coverageType: "evidence",
            }),
          });
        status.textContent =
          prepared.outcome === "existing"
            ? "Matching PDF already verified."
            : "PDF uploaded and verified.";
        await refreshEvidence();
      }, "Could not upload PDF"),
    );
    surface
      .querySelector(".bookkeeping-documents")
      .addEventListener("click", (event) =>
        safeAction(async () => {
          const download =
              event.target.closest("[data-download]")?.dataset.download,
            unlink = event.target.closest("[data-unlink]")?.dataset.unlink;
          if (download) {
            const result = await api(`/documents/${download}/download`);
            openPrivateDownload(result.downloadUrl);
          }
          if (unlink) {
            await api(`/links/${unlink}`, { method: "DELETE" });
            await refreshEvidence();
          }
        }, "Could not update document"),
      );
    surface.querySelector("[data-report]").addEventListener("click", () =>
      safeAction(async () => {
        const month = surface.querySelector("[data-report-month]").value;
        if (!month) {
          status.textContent = "Choose a report month.";
          return;
        }
        const privateDocumentIds = [
          ...surface.querySelectorAll(
            "[data-private-statements] input:checked",
          ),
        ].map((input) => input.value);
        const snapshot = await api("/reports/snapshot", {
          method: "POST",
          body: JSON.stringify({ month, privateDocumentIds }),
        });
        status.textContent = snapshot.warnings?.missingEvidence
          ? `${snapshot.warnings.missingEvidence} missing-evidence warning(s).`
          : "Snapshot ready.";
        const archive = await api(`/reports/${snapshot.report.id}/archive`, {
          method: "POST",
        });
        openPrivateDownload(archive.downloadUrl);
      }, "Could not create monthly package"),
    );
  }

  return {
    canLeaveFinanceSurface,
    renderBookkeepingSurface,
    renderMailingExportsSurface,
    renderSponsorCrmSurface,
  };
}
