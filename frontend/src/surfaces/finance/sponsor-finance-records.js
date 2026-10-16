import { html } from "./shared.js";
import { ledgerDate } from "./bookkeeping-format.js";

// Labels, the next-step sentence, and the record forms (invoice, payment,
// waiting on, evidence) for a sponsor deal's finance panel.

export const WAITING_REASON_LABELS = {
  "billing-details": "billing details",
  "payment-details": "payment details",
  "payment-link": "a payment link",
  "vendor-onboarding": "vendor onboarding",
  "purchase-order": "a purchase order",
  approval: "approval",
  invoice: "the invoice",
  other: "something else",
};

export const PAYMENT_SOURCE_LABELS = {
  "bank-report": "Accountant report",
  "sponsor-confirmation": "Sponsor confirmation",
  processor: "Payment processor",
  other: "Other",
};

export const EVIDENCE_KIND_LABELS = {
  email: "Mail thread",
  document: "Invoice PDF",
  ledger: "Bookkeeping row",
  url: "Link",
  note: "Note",
};

const reasonText = (reason) => WAITING_REASON_LABELS[reason] || "something";

/**
 * The derived next step for a deal's money, as one sentence with a tone.
 * `followUp` comes from the backend (deal projection or ledger row); it is
 * never computed here.
 */
/**
 * The payment a deal recorded before its bookkeeping row existed that this
 * row confirms: same amount, at most 14 days apart. Linking the row replaces it.
 */
export function replaceablePayment(payments, candidate) {
  const date = Date.parse(String(candidate?.effectiveDate || ""));
  return (payments || []).find(
    (payment) =>
      payment.source === "recorded" &&
      Number(payment.amount) === Number(candidate.amount) &&
      Number.isFinite(date) &&
      Math.abs(Date.parse(String(payment.effectiveDate)) - date) <= 14 * 86_400_000,
  );
}

export function followUpSummary(followUp = {}) {
  const since = followUp.since ? ledgerDate(followUp.since) : "";
  switch (followUp.code) {
    case "reconcile":
      return { tone: "danger", title: "Reconcile the payment evidence", detail: "Linked bookkeeping rows no longer match this deal." };
    case "unblock":
      return {
        tone: "warning",
        title: `Send the sponsor ${reasonText(followUp.reason)}`,
        detail: since ? `They have been waiting on us since ${since}.` : "They are waiting on us.",
      };
    case "chase-payment":
      return {
        tone: "danger",
        title: "Chase the payment",
        detail: `Overdue ${followUp.daysOverdue ?? ""} day${followUp.daysOverdue === 1 ? "" : "s"}${since ? `, due ${since}` : ""}.`,
      };
    case "send-invoice":
      return { tone: "warning", title: "Send the invoice", detail: since ? `Invoiceable since ${since}.` : "The deal is invoiceable." };
    case "classify":
      return { tone: "warning", title: "Record what to invoice", detail: "The deal is agreed but its money is not classified." };
    case "await-sponsor":
      return {
        tone: "info",
        title: `Waiting on the sponsor for ${reasonText(followUp.reason)}`,
        detail: since ? `Since ${since}.` : "",
      };
    case "await-payment":
      return { tone: "info", title: "Waiting for payment", detail: since ? `Due ${since}.` : "No due date recorded." };
    case "invoice-later":
      return { tone: "info", title: "Invoice later", detail: since ? `Invoice by ${since}.` : "Not invoiceable yet." };
    default:
      return { tone: "success", title: "Nothing to chase", detail: "" };
  }
}

const todayIso = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};


/**
 * The four record forms of the deal finance panel. Their content is in
 * memory, so they open immediately; a failed save keeps the form open with
 * the server's reason, and conflicts fall through to the panel's `safe`.
 */
export function createFinanceRecordForms({ surface, financeMutation, reopenBookingDetail, safe }) {
  const formDialog = (name, markup) => {
    const dialog = document.createElement("dialog");
    dialog.className = "surface-dialog";
    dialog.dataset[name] = "";
    dialog.innerHTML = markup;
    return dialog;
  };
  const invoiceDialog = formDialog(
    "financeIssueDialog",
    html`<form>
      <header>
        <h3>Record invoice</h3>
        <p>
          The invoice as sent. Leave the number empty when the sponsor's
          portal assigns none.
        </p>
      </header>
      <div class="dialog-fields">
        <label
          >Invoice number <span class="dk-muted">(optional)</span>
          <input name="invoiceNumber" maxlength="64" autocomplete="off"
        /></label>
        <label>Issued on <input name="issuedOn" type="date" required /></label>
        <label>Sent on <input name="sentOn" type="date" /></label>
        <label>Due on <input name="dueOn" type="date" required /></label>
        <label
          >Amount
          <input name="amountDue" inputmode="decimal" required /></label
        ><label
          >Currency <input name="currency" maxlength="3" required
        /></label>
        <p class="dk-hint" data-amount-locked hidden>
          Amount and currency are fixed once payment or invoice evidence is
          linked.
        </p>
        <p role="alert"></p>
      </div>
      <footer>
        <button class="primary-button">Record invoice</button
        ><button type="button" data-cancel>Cancel</button>
      </footer>
    </form>`,
  );
  const paymentDialog = formDialog(
    "financeRecordPaymentDialog",
    html`<form>
      <header>
        <h3>Record payment</h3>
        <p>
          Money received that bookkeeping has not caught up with yet. When the
          bookkeeping row arrives, linking it replaces this payment.
        </p>
      </header>
      <div class="dialog-fields">
        <label>Received on <input name="receivedOn" type="date" required /></label>
        <label
          >Amount <span data-payment-currency></span>
          <input name="amount" inputmode="decimal" required
        /></label>
        <label
          >Source
          <select name="method">
            <option value="bank-report">Accountant report</option>
            <option value="sponsor-confirmation">Sponsor confirmation</option>
            <option value="processor">Payment processor</option>
            <option value="other">Other</option>
          </select></label
        >
        <label
          >Reference <span class="dk-muted">(optional)</span>
          <input name="reference" maxlength="200"
        /></label>
        <p role="alert"></p>
      </div>
      <footer>
        <button class="primary-button">Record payment</button
        ><button type="button" data-cancel>Cancel</button>
      </footer>
    </form>`,
  );
  const reasonOptions = Object.entries(WAITING_REASON_LABELS)
    .map(([value, label]) => `<option value="${value}">${label[0].toUpperCase()}${label.slice(1)}</option>`)
    .join("");
  const waitingDialog = formDialog(
    "financeWaitingDialog",
    html`<form>
      <header>
        <h3>Who is the money waiting on?</h3>
        <p>Name the blocker so the next step shows who has to act.</p>
      </header>
      <div class="dialog-fields">
        <label
          >Waiting on
          <select name="party">
            <option value="us">Us: the sponsor needs something from us</option>
            <option value="sponsor">The sponsor</option>
          </select></label
        >
        <label>Reason <select name="reason">${reasonOptions}</select></label>
        <label>Since <input name="since" type="date" required /></label>
        <label
          >Note <span class="dk-muted">(optional)</span>
          <input name="note" maxlength="300"
        /></label>
        <p role="alert"></p>
      </div>
      <footer>
        <button class="primary-button">Save</button
        ><button type="button" data-cancel>Cancel</button>
      </footer>
    </form>`,
  );
  const evidenceOptions = Object.entries(EVIDENCE_KIND_LABELS)
    .map(([value, label]) => `<option value="${value}">${label}</option>`)
    .join("");
  const evidenceDialog = formDialog(
    "financeEvidenceDialog",
    html`<form>
      <header>
        <h3>Add evidence</h3>
        <p>Where the proof lives: a mail thread, the invoice PDF or a bookkeeping row.</p>
      </header>
      <div class="dialog-fields">
        <label>Kind <select name="kind">${evidenceOptions}</select></label>
        <label
          >Reference
          <input name="ref" maxlength="300" required placeholder="https://… or an ID"
        /></label>
        <label
          >Label <span class="dk-muted">(optional)</span>
          <input name="label" maxlength="160"
        /></label>
        <label
          >Dated <span class="dk-muted">(optional)</span>
          <input name="on" type="date"
        /></label>
        <p role="alert"></p>
      </div>
      <footer>
        <button class="primary-button">Add evidence</button
        ><button type="button" data-cancel>Cancel</button>
      </footer>
    </form>`,
  );
  surface.append(invoiceDialog, paymentDialog, waitingDialog, evidenceDialog);
  const showFormError = (form, error) => {
    form.querySelector('[role="alert"]').textContent = error.message;
  };
  function openIssueInvoice(booking, projection) {
    const form = invoiceDialog.querySelector("form");
    form.reset();
    form.querySelector('[role="alert"]').textContent = "";
    const finance = projection.finance;
    form.elements.invoiceNumber.value = finance.invoiceNumber || "";
    form.elements.issuedOn.value = finance.issuedOn || todayIso();
    form.elements.sentOn.value = finance.sentOn || "";
    form.elements.dueOn.value = finance.dueOn || "";
    form.elements.amountDue.value = finance.amountDue || "";
    form.elements.currency.value = finance.currency || "EUR";
    const locked =
      Boolean(projection.invoice) ||
      projection.paymentLinkCount > 0 ||
      projection.payments.length > 0;
    form.elements.amountDue.readOnly = locked;
    form.elements.currency.readOnly = locked;
    form.querySelector("[data-amount-locked]").hidden = !locked;
    form.onsubmit = (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(form));
      const currency = String(values.currency).trim().toUpperCase();
      const amountDue = String(values.amountDue).trim();
      (async () => {
        let expectedVersion = finance.version;
        if (amountDue !== finance.amountDue || currency !== finance.currency) {
          const classified = await financeMutation(booking, "", "PUT", {
            expectedVersion,
            invoiceRequirement: "required",
            amountDue,
            currency,
            taxMode: finance.taxMode || "unknown",
            ...(finance.taxAmount !== undefined ? { taxAmount: finance.taxAmount } : {}),
            ...(finance.requestBy ? { requestBy: finance.requestBy } : {}),
            ...(finance.expectedInvoiceBy ? { expectedInvoiceBy: finance.expectedInvoiceBy } : {}),
          });
          expectedVersion = classified.projection.finance.version;
        }
        await financeMutation(booking, "/issue", "POST", {
          expectedVersion,
          issuedOn: values.issuedOn,
          dueOn: values.dueOn,
          ...(values.invoiceNumber.trim() ? { invoiceNumber: values.invoiceNumber.trim() } : {}),
          ...(values.sentOn ? { sentOn: values.sentOn } : {}),
        });
        invoiceDialog.close();
        await reopenBookingDetail(booking);
      })().catch((error) => {
        if (error.status === 400) showFormError(form, error);
        else safe(() => Promise.reject(error), "Could not record invoice");
      });
    };
    invoiceDialog.showModal();
  }
  function openRecordPayment(booking, projection) {
    const form = paymentDialog.querySelector("form");
    form.reset();
    form.querySelector('[role="alert"]').textContent = "";
    const finance = projection.finance;
    form.querySelector("[data-payment-currency]").textContent = `(${finance.currency})`;
    form.elements.receivedOn.value = todayIso();
    form.elements.amount.value = projection.outstanding || "";
    form.onsubmit = (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(form));
      financeMutation(booking, "/recorded-payments", "POST", {
        expectedVersion: finance.version,
        receivedOn: values.receivedOn,
        amount: String(values.amount).trim(),
        currency: finance.currency,
        method: values.method,
        ...(values.reference.trim() ? { reference: values.reference.trim() } : {}),
      })
        .then(async () => {
          paymentDialog.close();
          await reopenBookingDetail(booking);
        })
        .catch((error) => {
          if (error.status === 400) showFormError(form, error);
          else safe(() => Promise.reject(error), "Could not record payment");
        });
    };
    paymentDialog.showModal();
  }
  function openWaitingOn(booking, projection) {
    const form = waitingDialog.querySelector("form");
    form.reset();
    form.querySelector('[role="alert"]').textContent = "";
    const waiting = projection.finance.waitingOn;
    form.elements.party.value = waiting?.party || "sponsor";
    form.elements.reason.value = waiting?.reason || "billing-details";
    form.elements.since.value = waiting?.since || todayIso();
    form.elements.note.value = waiting?.note || "";
    form.onsubmit = (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(form));
      financeMutation(booking, "/follow-through", "PUT", {
        expectedVersion: projection.finance.version,
        waitingOn: {
          party: values.party,
          reason: values.reason,
          since: values.since,
          ...(values.note.trim() ? { note: values.note.trim() } : {}),
        },
      })
        .then(async () => {
          waitingDialog.close();
          await reopenBookingDetail(booking);
        })
        .catch((error) => {
          if (error.status === 400) showFormError(form, error);
          else safe(() => Promise.reject(error), "Could not save who the money is waiting on");
        });
    };
    waitingDialog.showModal();
  }
  function openAddEvidence(booking, projection) {
    const form = evidenceDialog.querySelector("form");
    form.reset();
    form.querySelector('[role="alert"]').textContent = "";
    form.onsubmit = (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(form));
      const item = {
        kind: values.kind,
        ref: values.ref.trim(),
        ...(values.label.trim() ? { label: values.label.trim() } : {}),
        ...(values.on ? { on: values.on } : {}),
      };
      if (item.kind === "url" && !/^https:\/\/\S+$/.test(item.ref)) {
        showFormError(form, new Error("A link must start with https://"));
        return;
      }
      financeMutation(booking, "/follow-through", "PUT", {
        expectedVersion: projection.finance.version,
        evidence: [...(projection.finance.evidence || []), item],
      })
        .then(async () => {
          evidenceDialog.close();
          await reopenBookingDetail(booking);
        })
        .catch((error) => {
          if (error.status === 400) showFormError(form, error);
          else safe(() => Promise.reject(error), "Could not add evidence");
        });
    };
    evidenceDialog.showModal();
  }
  return { openIssueInvoice, openRecordPayment, openWaitingOn, openAddEvidence };
}
