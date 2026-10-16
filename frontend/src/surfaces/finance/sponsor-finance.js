import { html } from "./shared.js";
import { formatAmount, ledgerDate } from "./bookkeeping-format.js";
import {
  EVIDENCE_KIND_LABELS,
  PAYMENT_SOURCE_LABELS,
  WAITING_REASON_LABELS,
  createFinanceRecordForms,
  followUpSummary,
  replaceablePayment,
} from "./sponsor-finance-records.js";

export function createSponsorFinance(context) {
  const {
    escapeHtml,
    humanizeOptionLabel,
    message,
    openTaskPanel,
    request,
    surface,
    workApiUrl,
  } = context;
  let reopenBookingDetail = async () => {};
  const setReopenBookingDetail = (callback) => {
    reopenBookingDetail = callback;
  };

  const pendingFinanceKeys = new Map();
  const financeApi = async (bookingId, suffix = "", options = {}) => {
    const response = await fetch(
      workApiUrl(
        `/api/sponsor-crm/deals/${encodeURIComponent(bookingId)}/finance${suffix}`,
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
  const confirmDialog = surface.querySelector("[data-sponsor-confirm-dialog]");
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
      message.hidden = false;
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
    const requestBody = { dealVersion: booking.version, ...body };
    const scope = `${booking.id}:${method}:${suffix}:${JSON.stringify(requestBody)}`;
    const idempotencyKey = pendingFinanceKeys.get(scope) || crypto.randomUUID();
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
      message.hidden = false;
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
  const { openIssueInvoice, openRecordPayment, openSettlementAdjustment, openWaitingOn, openAddEvidence, openVoidFinance } =
    createFinanceRecordForms({
      surface,
      financeMutation,
      reopenBookingDetail: (booking) => reopenBookingDetail(booking),
      safe,
    });
  function financeMarkup(projection) {
    const admin = projection.role === "admin";
    if (!projection.classified) {
      return html`<section class="finance-panel" data-finance-panel>
        <div class="honest-state">
          <strong>Finance is not classified</strong>
          <p>
            This deal has not been classified. Record whether an invoice is
            required before linking invoice or payment evidence.
          </p>
          ${
            admin
              ? html`
                  ${projection.followUp?.party === "us" && !(projection.paymentFollowUp?.tasks || []).length
                    ? html`<button data-finance-payment-follow-up-create>Add next finance action to Tasks</button>` : ""}
                  ${(projection.paymentFollowUp?.tasks || []).map((task) => html`<button
                    data-finance-payment-follow-up-open="${escapeHtml(task.id)}">Open finance Task</button>`).join("")}
                  ${(projection.paymentFollowUp?.existingTasks || []).map((task) => html`<p>
                    ${escapeHtml(task.description)}
                    <button data-finance-payment-follow-up-link="${escapeHtml(task.id)}">Use this Task for finance</button>
                  </p>`).join("")}
                  ${projection.paymentFollowUp?.existingTasks?.length ? html`<label>
                    <input type="checkbox" data-finance-payment-follow-up-reviewed>
                    I reviewed these Tasks; a new finance Task is separate work.</label>` : ""}
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
    const live = admin && !finance.voidedAt;
    const required = finance.invoiceRequirement === "required";
    const coherent = projection.reconciliationStatus === "coherent";
    const next = followUpSummary(projection.followUp);
    const nextStep = html`<div
      class="dk-callout dk-callout--${next.tone} finance-next-step"
      role="status"
      data-finance-next-step="${escapeHtml(projection.followUp?.code || "none")}"
    >
      <div class="dk-callout__body">
        <div class="dk-callout__title">${escapeHtml(next.title)}</div>
        ${next.detail ? html`<p>${escapeHtml(next.detail)}</p>` : ""}
      </div>
    </div>`;
    const waiting = finance.waitingOn;
    const waitingBanner = waiting
      ? html`<div
          class="dk-callout dk-callout--${waiting.party === "us" ? "warning" : "info"} finance-waiting"
          data-finance-waiting="${escapeHtml(waiting.party)}"
        >
          <div class="dk-callout__body">
            <div class="dk-callout__title">
              ${escapeHtml(
                waiting.party === "us"
                  ? `The sponsor is waiting on us for ${WAITING_REASON_LABELS[waiting.reason] || waiting.reason}`
                  : `Waiting on the sponsor for ${WAITING_REASON_LABELS[waiting.reason] || waiting.reason}`,
              )}
            </div>
            <p>
              Since ${escapeHtml(ledgerDate(waiting.since))}${waiting.note ? html` · ${escapeHtml(waiting.note)}` : ""}
            </p>
          </div>
          ${live
            ? html`<div class="dk-callout__actions">
                <button type="button" class="dk-button dk-button--secondary dk-button--sm" data-finance-waiting-edit>Change</button>
                <button type="button" class="dk-button dk-button--secondary dk-button--sm" data-finance-waiting-clear>Clear</button>
              </div>`
            : ""}
        </div>`
      : "";
    const requestInvoiceAction =
      required && !finance.invoiceRequestedAt && !finance.issuedOn
        ? html` <button data-finance-request>Record invoice request</button> `
        : "";
    const issueAction =
      required && projection.paymentState !== "paid"
        ? html` <button class="primary-button" data-finance-issue>
            ${finance.issuedOn ? "Correct invoice" : "Record invoice"}
          </button>`
        : "";
    const recordPaymentAction =
      required &&
      finance.issuedOn &&
      coherent &&
      projection.paymentState !== "paid" &&
      projection.paymentLinkCount < projection.paymentLinkLimit
        ? html` <button data-finance-record-payment>Record verified receipt</button> `
        : "";
    const linkInvoiceAction =
      required &&
      finance.invoiceRequestedAt &&
      !projection.invoice &&
      finance.taxMode !== "unknown"
        ? html` <button data-finance-invoice>Link invoice PDF</button> `
        : "";
    const linkPaymentAction =
      finance.issuedOn &&
      coherent &&
      projection.paymentLinkCount < projection.paymentLinkLimit
        ? html` <button data-finance-payment>Link bookkeeping payment</button> `
        : "";
    const voidAction =
      projection.paymentLinkCount === 0
        ? html` <button data-finance-void>Cancel invoice follow-through</button> `
        : "";
    const actions = live
      ? html`<div class="finance-actions">
          ${issueAction} ${recordPaymentAction} ${requestInvoiceAction}
          ${finance.settlementAdjustment ? html`<button data-finance-reverse-settlement>Reverse noncash settlement</button>`
            : coherent && finance.issuedOn && Number(projection.paid) > 0 && Number(projection.outstanding) > 0
              ? html`<button data-finance-approve-settlement>Approve noncash settlement</button>` : ""}
          ${waiting ? "" : html`<button data-finance-waiting-edit>Set waiting on</button>`}
          <button data-finance-classify>Update classification</button>
          ${linkInvoiceAction} ${linkPaymentAction}
          <button data-finance-reconcile>Reconcile current evidence</button>
          ${projection.invoice ? html`<button data-finance-unlink-invoice="${escapeHtml(projection.invoice.id)}">Unlink invoice</button>` : ""}
          ${voidAction}
        </div>`
      : "";
    const invoiceFacts = finance.issuedOn
      ? html`<p class="finance-invoice-facts" data-finance-invoice-facts>
          <strong>${escapeHtml(finance.invoiceNumber ? `Invoice ${finance.invoiceNumber}` : "Invoice without number")}</strong>
          · issued ${escapeHtml(ledgerDate(finance.issuedOn))}${finance.sentOn ? html` · sent ${escapeHtml(ledgerDate(finance.sentOn))}` : ""}
          · due ${escapeHtml(ledgerDate(finance.dueOn))}
        </p>`
      : "";
    const invoiceMarkup = projection.invoice
      ? html`
          <p>
            <strong>${escapeHtml(projection.invoice.label)}</strong>
            · uploaded ${escapeHtml(ledgerDate(projection.invoice.uploadedAt))}
            <button
              data-finance-download="${escapeHtml(projection.invoice.id)}"
            >
              Download invoice
            </button>
          </p>
        `
      : "";
    const reconciliationWarning = !coherent
      ? html`
          <p class="finance-recovery" role="alert">
            Evidence is unavailable or changed. No payment is counted until an
            admin reconciles the current records.
          </p>
        `
      : "";
    const paymentRow = (payment) => {
      const source =
        payment.source === "recorded"
          ? `Reported, unverified: ${PAYMENT_SOURCE_LABELS[payment.method] || "payment"}`
          : "Bookkeeping";
      const unlink =
        live && payment.source === "recorded"
          ? html`<button
              class="dk-button dk-button--secondary dk-button--sm"
              data-finance-delete-payment="${escapeHtml(payment.id)}"
              aria-label="Remove ${escapeHtml(ledgerDate(payment.effectiveDate))} recorded payment"
            >
              Remove
            </button>`
          : live
            ? html`<button
                class="dk-button dk-button--secondary dk-button--sm"
                data-finance-unlink-payment="${escapeHtml(payment.id)}"
                aria-label="Unlink ${escapeHtml(ledgerDate(payment.effectiveDate))} payment"
              >
                Unlink
              </button>`
            : "";
      return html`<li class="finance-payment-row" data-finance-payment-source="${escapeHtml(payment.source)}">
        <span class="dk-mono">${escapeHtml(ledgerDate(payment.effectiveDate))}</span>
        <span class="dk-mono">${escapeHtml(formatAmount(payment.amount, payment.currency))}</span>
        <span class="dk-muted">${escapeHtml(source)}${payment.reference ? ` · ${escapeHtml(payment.reference)}` : ""}</span>
        ${live && payment.source === "ledger" && projection.invoice ? html`<button
          data-finance-attach-payment-evidence="${escapeHtml(payment.id)}">Attach invoice to bookkeeping</button>` : ""}
        ${live && payment.source === "ledger" ? html`<button data-finance-correct-receipt="${escapeHtml(payment.id)}">Correct receipt</button>` : ""}
        ${unlink}
      </li>`;
    };
    const paymentMarkup = projection.payments.length
      ? html`<ul class="finance-payment-list">${projection.payments.map(paymentRow).join("")}</ul>`
      : html` <p class="dk-muted">No payments yet.</p> `;
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
    const evidence = finance.evidence || [];
    const paymentFollowUpTasks = projection.paymentFollowUp?.tasks || [];
    const existingTasks = projection.paymentFollowUp?.existingTasks || [];
    const needsPaymentFollowUp = ["payment-follow-up", "send-invoice", "unblock", "reconcile"].includes(projection.followUp?.code);
    const paymentFollowUpTaskRow = (task) => {
      const detail = [
        `Due ${ledgerDate(task.date)}`,
        task.status === "waiting" && task.followUpAt
          ? `Next follow-up ${ledgerDate(task.followUpAt)}`
          : "",
      ].filter(Boolean).join(" · ");
      return html`<li class="finance-payment-follow-up-row" data-finance-payment-follow-up-task="${escapeHtml(task.id)}">
        <div>
          <strong>${escapeHtml(task.description)}</strong>
          <p class="dk-muted">${escapeHtml(detail)} · ${escapeHtml(task.status)}</p>
        </div>
        <button
          class="dk-button dk-button--secondary dk-button--sm"
          data-finance-payment-follow-up-open="${escapeHtml(task.id)}"
        >
          Open in Tasks
        </button>
      </li>`;
    };
    const paymentFollowUpSection = needsPaymentFollowUp || paymentFollowUpTasks.length
      ? html`<div class="finance-payment-follow-up" data-finance-payment-follow-up>
          <header class="crm-company-section-header">
            <h4>Payment follow-up</h4>
            ${
              live && needsPaymentFollowUp && !paymentFollowUpTasks.length
                ? html`<button data-finance-payment-follow-up-create>Add next finance action to Tasks</button>`
                : ""
            }
          </header>
          ${!paymentFollowUpTasks.length && existingTasks.length ? html`
            <p>Review the deal's open Tasks before adding another follow-up.</p>
            <ul>${existingTasks.map((task) => html`<li>${escapeHtml(task.description)}
              <button data-finance-payment-follow-up-link="${escapeHtml(task.id)}">Use this Task for the payment follow-up</button>
            </li>`).join("")}</ul>
            <label><input type="checkbox" data-finance-payment-follow-up-reviewed>
              I reviewed these Tasks; a new payment follow-up is separate work.
            </label>` : ""}
          ${
            paymentFollowUpTasks.length
              ? html`<ul class="finance-payment-follow-up-list">${paymentFollowUpTasks.map(paymentFollowUpTaskRow).join("")}</ul>`
              : html`<p class="dk-muted">
                  No payment follow-up yet. Creating one adds a Task to the regular task pool —
                  it uses the regular Task lifecycle and proof requirements.
                  Bank review and specific message approval remain required.
                </p>`
          }
        </div>`
      : "";
    const evidenceRow = (item, index) => {
      const link = /^https:\/\//.test(item.ref)
        ? html`<a href="${escapeHtml(item.ref)}" target="_blank" rel="noopener">${escapeHtml(item.label || item.ref)}</a>`
        : html`<span>${escapeHtml(item.label ? `${item.label} · ${item.ref}` : item.ref)}</span>`;
      return html`<li class="finance-evidence-row">
        <span class="dk-muted">${escapeHtml(EVIDENCE_KIND_LABELS[item.kind] || item.kind)}</span>
        ${link}
        ${item.on ? html`<span class="dk-mono dk-muted">${escapeHtml(ledgerDate(item.on))}</span>` : ""}
        ${live
          ? html`<button
              class="dk-button dk-button--secondary dk-button--sm"
              data-finance-evidence-remove="${index}"
              aria-label="Remove evidence ${escapeHtml(item.label || item.ref)}"
            >
              Remove
            </button>`
          : ""}
      </li>`;
    };
    const evidenceMarkup = html`<div class="finance-evidence" data-finance-evidence>
      <header class="crm-company-section-header">
        <h4>Evidence</h4>
        ${live ? html`<button data-finance-evidence-add>Add evidence</button>` : ""}
      </header>
      ${evidence.length
        ? html`<ul class="finance-evidence-list">${evidence.map(evidenceRow).join("")}</ul>`
        : html`<p class="dk-muted">No mail thread, invoice PDF or bookkeeping row linked yet.</p>`}
    </div>`;
    return html`<section class="finance-panel" data-finance-panel>
      <span hidden
        >${escapeHtml(`${projection.invoiceState} ${projection.paymentState} ${projection.timingState} ${projection.reconciliationStatus}`)}</span
      >
      ${nextStep} ${waitingBanner}
      ${finance.settlementAdjustment ? html`<p>
        Noncash settlement: ${escapeHtml(formatAmount(finance.settlementAdjustment.amount, finance.currency))}.
        ${escapeHtml(finance.settlementAdjustment.reason)}
        Approved by ${escapeHtml(finance.settlementAdjustment.approvedBy)} on ${escapeHtml(finance.settlementAdjustment.approvedOn)}.
        Cash received: ${escapeHtml(formatAmount(projection.paid, finance.currency))}.</p>` : ""}
      ${finance.voidReason ? html`<p>Cancellation reason: ${escapeHtml(finance.voidReason)}</p>` : ""}
      <header>
        <div>
          <h3>${escapeHtml((finance.settlementAdjustment && projection.paymentState === "paid" ? "Settled with adjustment" : humanizeOptionLabel(projection.paymentState)))}</h3>
          <p>
            ${escapeHtml(humanizeOptionLabel(projection.invoiceState))} ·
            ${escapeHtml(humanizeOptionLabel(projection.timingState))}
          </p>
        </div>
        <span class="finance-status"
          >${coherent ? "Evidence consistent" : "Review evidence"}</span
        >
      </header>
      <dl>
        <div>
          <dt>Amount due</dt>
          <dd>
            ${escapeHtml(finance.amountDue ? formatAmount(finance.amountDue, finance.currency) : "Not applicable")}
          </dd>
        </div>
        <div>
          <dt>Outstanding</dt>
          <dd>
            ${escapeHtml(projection.outstanding ? formatAmount(projection.outstanding, finance.currency) : "Not applicable")}
          </dd>
        </div>
        <div>
          <dt>Tax</dt>
          <dd>${escapeHtml(finance.taxMode ? humanizeOptionLabel(finance.taxMode) : "Not applicable")}</dd>
        </div>
        <div>
          <dt>Due</dt>
          <dd>
            ${escapeHtml(finance.dueOn || finance.expectedInvoiceBy ? ledgerDate(finance.dueOn || finance.expectedInvoiceBy) : "Not set")}
          </dd>
        </div>
      </dl>
      ${invoiceFacts} ${invoiceMarkup} ${reconciliationWarning}
      <div class="finance-payments">
        <header class="crm-company-section-header"><h4>Payments</h4></header>
        ${projection.payments.some((payment) => payment.source === "recorded") ? html`<p>
          Payment reported, awaiting verification. Outstanding is the amount not yet verified in bookkeeping.
          Check these reports before chasing.</p>` : ""}${paymentMarkup}
      </div>
      ${paymentLimitWarning} ${paymentFollowUpSection} ${evidenceMarkup} ${actions}
    </section>`;
  }
  async function loadFinance(booking) {
    currentFinanceBooking = booking;
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
          <strong>No finance recorded yet</strong>
          <p>Invoice and payment details will appear here when finance is recorded for this deal.</p>
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
      form.querySelector("[data-candidates]").innerHTML = candidateItems.length
        ? `${candidateMarkup}${loadMoreMarkup}`
        : html`
            <p>
              No eligible unclaimed evidence is available. Upload or import
              evidence in Bookkeeping, then retry.
            </p>
          `;
      form.querySelector("button.primary-button").disabled =
        candidateItems.length === 0;
      form.querySelector("[data-finance-more]")?.addEventListener("click", () =>
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
        const replaced =
          kind === "invoice" ? null : replaceablePayment(projection.payments, candidate);
        const body = {
          expectedVersion: projection.finance?.version || 0,
          sourceId: candidate.id,
          identityToken: candidate.identityToken,
          ...(kind === "invoice"
            ? {
                issuedOn: form.elements.issuedOn.value,
                dueOn: form.elements.dueOn.value,
              }
            : {}),
          ...(replaced ? { replacesPaymentId: replaced.id } : {}),
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
      .querySelector("[data-finance-issue]")
      ?.addEventListener("click", () => openIssueInvoice(booking, projection));
    panel.querySelector("[data-finance-approve-settlement]")?.addEventListener("click", () => openSettlementAdjustment(booking, projection));
    panel.querySelector("[data-finance-reverse-settlement]")?.addEventListener("click", () => {
      const reason = window.prompt("Reason for reversing this approved noncash settlement");
      if (!reason?.trim()) return;
      safe(async () => {
        await financeMutation(booking, "/settlement-adjustment", "DELETE", {
          expectedVersion: projection.finance.version, reason: reason.trim(),
        });
        await reopenBookingDetail(booking);
      }, "Could not reverse settlement");
    });
    panel
      .querySelector("[data-finance-record-payment]")
      ?.addEventListener("click", () => openRecordPayment(booking, projection));
    panel
      .querySelectorAll("[data-finance-waiting-edit]")
      .forEach((button) =>
        button.addEventListener("click", () => openWaitingOn(booking, projection)),
      );
    panel
      .querySelector("[data-finance-waiting-clear]")
      ?.addEventListener("click", () =>
        safe(async () => {
          await financeMutation(booking, "/follow-through", "PUT", {
            expectedVersion: projection.finance?.version || 0,
            waitingOn: null,
          });
          await reopenBookingDetail(booking);
        }, "Could not clear who the money is waiting on"),
      );
    panel
      .querySelector("[data-finance-evidence-add]")
      ?.addEventListener("click", () => openAddEvidence(booking, projection));
    panel.querySelectorAll("[data-finance-evidence-remove]").forEach((button) =>
      button.addEventListener("click", () =>
        safe(async () => {
          const index = Number(button.dataset.financeEvidenceRemove);
          await financeMutation(booking, "/follow-through", "PUT", {
            expectedVersion: projection.finance?.version || 0,
            evidence: (projection.finance.evidence || []).filter(
              (_, position) => position !== index,
            ),
          });
          await reopenBookingDetail(booking);
        }, "Could not remove evidence"),
      ),
    );
    panel.querySelectorAll("[data-finance-delete-payment]").forEach((button) =>
      button.addEventListener("click", () =>
        safe(async () => {
          if (
            !(await confirmSponsorAction(
              "Remove recorded payment?",
              "Use this when the payment was recorded by mistake. Linking its bookkeeping row replaces it on its own.",
              "Remove payment",
            ))
          )
            return;
          await financeMutation(
            booking,
            `/recorded-payments/${encodeURIComponent(button.dataset.financeDeletePayment)}`,
            "DELETE",
            { expectedVersion: projection.finance.version },
          );
          await reopenBookingDetail(booking);
        }, "Could not remove recorded payment"),
      ),
    );
    panel
      .querySelector("[data-finance-payment-follow-up-create]")
      ?.addEventListener("click", () =>
        safe(async () => {
          const existing = projection.paymentFollowUp?.existingTasks || [];
          if (existing.length && !panel.querySelector("[data-finance-payment-follow-up-reviewed]")?.checked) {
            throw new Error("Review existing Tasks and link one, or confirm the new follow-up is separate work.");
          }
          await financeMutation(booking, "/follow-up", "POST", {
            expectedVersion: projection.finance?.version || 0,
            ...(existing.length ? { reviewedOpenTasks: existing.map(({ id, version }) => ({ id, version })) } : {}),
          });
          await reopenBookingDetail(booking);
        }, "Could not create the payment follow-up task"),
      );
    panel.querySelectorAll("[data-finance-attach-payment-evidence]").forEach((button) =>
      button.addEventListener("click", () => safe(async () => {
        await financeMutation(booking, "/payment-evidence", "POST", {
          expectedVersion: projection.finance.version, documentId: projection.invoice.id,
          transactionIds: [button.dataset.financeAttachPaymentEvidence],
        });
        await reopenBookingDetail(booking);
      }, "Could not attach the reviewed invoice to bookkeeping")),
    );
    panel.querySelectorAll("[data-finance-correct-receipt]").forEach((button) =>
      button.addEventListener("click", () => openRecordPayment(booking, projection,
        projection.payments.find((payment) => payment.id === button.dataset.financeCorrectReceipt))),
    );
    panel.querySelectorAll("[data-finance-payment-follow-up-link]").forEach((button) =>
      button.addEventListener("click", () => safe(async () => {
        await financeMutation(booking, "/follow-up", "POST", {
          expectedVersion: projection.finance?.version || 0,
          existingTaskId: button.dataset.financePaymentFollowUpLink,
        });
        await reopenBookingDetail(booking);
      }, "Could not link the existing follow-up")),
    );
    panel.querySelectorAll("[data-finance-payment-follow-up-open]").forEach((button) =>
      button.addEventListener("click", () =>
        openTaskPanel(button.dataset.financePaymentFollowUpOpen),
      ),
    );
    panel
      .querySelector("[data-finance-request]")
      ?.addEventListener("click", () =>
        safe(async () => {
          await financeMutation(booking, "/request", "POST", {
            expectedVersion: projection.finance?.version || 0,
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
    panel.querySelectorAll("[data-finance-unlink-payment]").forEach((button) =>
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
    panel.querySelector("[data-finance-void]")?.addEventListener("click", () => openVoidFinance(booking, projection));
  }

  return {
    loadFinance,
    setReopenBookingDetail,
  };
}
