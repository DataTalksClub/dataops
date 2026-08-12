import { html } from "./shared.js";

export function createSponsorFinance(context) {
  const {
    escapeHtml,
    humanizeOptionLabel,
    message,
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
              Evidence is unavailable or changed. No payment is counted until an
              admin reconciles the current records.
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
    panel.querySelector("[data-finance-void]")?.addEventListener("click", () =>
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

  return {
    loadFinance,
    setReopenBookingDetail,
  };
}
