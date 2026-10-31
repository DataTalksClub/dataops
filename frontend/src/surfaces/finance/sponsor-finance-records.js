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

export const THANK_YOU_TEMPLATE_ID = "template.finance.bookkeeping.email-to-sponsor-when-payment-has-been-received";
export const THANK_YOU_TEMPLATE_PATH = "content/06-finance-and-compliance/create-and-collect-invoices/templates/email-to-sponsor-when-payment-has-been-received.md";
export const THANK_YOU_SOP_ID = "sop.finance.bookkeeping.adding-paid-invoices-to-the-bookkeeping-spreadsheet-and-adding-it-to-dropbox";
export const THANK_YOU_SOP_STEP = 9;
export const THANK_YOU_EVIDENCE_LABEL = "Payment received thank-you email";

export const THANK_YOU_TEMPLATE_BODY = [
  "Hi <NAME>,",
  "",
  "We have received the payment for <WHAT_WAS_PAID>. Thank you for supporting our community!",
  "",
  "Best,",
  "<SENDER_NAME>",
].join("\n");

export const THANK_YOU_TEMPLATE_MARKDOWN = [
  "## Template",
  "",
  "```text",
  THANK_YOU_TEMPLATE_BODY,
  "```",
  "",
  "## Placeholders",
  "",
  "| Placeholder | What to put there | Example |",
  "| :--- | :--- | :--- |",
  "| `<NAME>` | First name of the sponsor contact on the invoice or payment thread | `Alex` |",
  "| `<WHAT_WAS_PAID>` | What the payment covers — name the invoice number if there is one, otherwise the sponsorship package or service | `invoice 202610/12` |",
  "| `<SENDER_NAME>` | First name of the person preparing the reply | `Operator` |",
].join("\n");

const THANK_YOU_EVIDENCE_PATTERN = /thank[-\s]*you|payment[-\s]*(received|confirmed|confirmation)|email-to-sponsor-when-payment-has-been-received/i;
const PRIOR_INVOICE_THREAD_PATTERN = /^(invoice(\s+thread)?|overdue\s+reminder|payment\s+follow-up)$/i;

export function findThankYouEvidence(evidence, lastPaymentOn) {
  if (!Array.isArray(evidence) || !evidence.length) return undefined;
  for (let index = evidence.length - 1; index >= 0; index--) {
    const item = evidence[index];
    if (!item || item.kind !== "email") continue;
    const text = `${item.label || ""} ${item.ref || ""}`.trim();
    if (THANK_YOU_EVIDENCE_PATTERN.test(text)) return item;
    if (
      item.on
      && lastPaymentOn
      && item.on >= lastPaymentOn
      && !PRIOR_INVOICE_THREAD_PATTERN.test(String(item.label || "").trim())
    ) {
      return item;
    }
  }
  return undefined;
}

export function resolveThankYou(projection) {
  if (!projection || !projection.classified) return undefined;
  if (projection.thankYou) return projection.thankYou;
  if (projection.reconciliationStatus !== "coherent") return undefined;
  const ledgerPayments = (projection.payments || []).filter((item) => item.source === "ledger");
  const hasVerifiedPayment = ledgerPayments.length > 0 || Number(projection.paid) > 0;
  const paymentResolved = projection.paymentState === "paid"
    || (projection.paymentState === "partially-paid" && hasVerifiedPayment);
  if (!paymentResolved) return undefined;
  const finance = projection.finance || {};
  const lastPaymentOn = projection.lastPaymentOn || ledgerPayments.at(-1)?.effectiveDate;
  const whatWasPaid = finance.invoiceNumber
    ? `invoice ${finance.invoiceNumber}`
    : projection.paid && finance.currency
      ? `${projection.paid} ${finance.currency} sponsorship payment`
      : "your sponsorship";
  const recordedEvidence = findThankYouEvidence(finance.evidence, lastPaymentOn);
  const status = recordedEvidence ? "recorded" : "required";
  return {
    status,
    sendPolicy: "send-with-template",
    templateId: THANK_YOU_TEMPLATE_ID,
    templatePath: THANK_YOU_TEMPLATE_PATH,
    sopId: THANK_YOU_SOP_ID,
    sopStep: THANK_YOU_SOP_STEP,
    summary: status === "recorded"
      ? "Sponsor thank-you email recorded"
      : "Send thank-you email to sponsor from orin@ (template exists — no Alexey approval)",
    instruction:
      `Send a reply from orin@ directly in the sponsor's existing invoice or payment email thread using ${THANK_YOU_TEMPLATE_ID} `
      + `(SOP ${THANK_YOU_SOP_ID} step ${THANK_YOU_SOP_STEP}). Address the main contact, keep the thread's CC list, `
      + `and name ${whatWasPaid}. Send it directly — no draft step: the template exists, so no Alexey approval is needed. `
      + "Record the sent message reference in Finance evidence and on the owning Task.",
    templateBody: THANK_YOU_TEMPLATE_BODY,
    templateMarkdown: THANK_YOU_TEMPLATE_MARKDOWN,
    placeholders: [
      {
        name: "<NAME>",
        description: "First name of the sponsor contact on the invoice or payment thread",
        example: "Alex",
      },
      {
        name: "<WHAT_WAS_PAID>",
        description: "What the payment covers — name the invoice number if there is one, otherwise the sponsorship package or service",
        example: "invoice 202610/12",
        suggestedValue: whatWasPaid,
      },
      {
        name: "<SENDER_NAME>",
        description: "First name of the person preparing the reply",
        example: "Operator",
      },
    ],
    context: {
      dealId: projection.dealId,
      ...(finance.invoiceNumber ? { invoiceNumber: finance.invoiceNumber } : {}),
      ...(projection.paid ? { paid: projection.paid } : {}),
      ...(finance.currency ? { currency: finance.currency } : {}),
      ...(lastPaymentOn ? { lastPaymentOn } : {}),
      whatWasPaid,
    },
    ...(recordedEvidence ? { recordedEvidence } : {}),
  };
}

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
      return { tone: "danger", title: "Reconcile the payment evidence", detail: "Verify reported receipts and reconcile the linked bookkeeping rows before chasing." };
    case "unblock":
      return {
        tone: "warning",
        title: `Send the sponsor ${reasonText(followUp.reason)}`,
        detail: since ? `They have been waiting on us since ${since}.` : "They are waiting on us.",
      };
    case "payment-follow-up":
      return {
        tone: "danger",
        title: "Follow up on the payment",
        detail: `Overdue ${followUp.daysOverdue ?? ""} day${followUp.daysOverdue === 1 ? "" : "s"}${since ? `, due ${since}` : ""}.`,
      };
    case "send-invoice":
      return { tone: "warning", title: "Verify or send the invoice", detail: since ? `Invoiceable since ${since}.` : "The deal is invoiceable." };
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
      return { tone: "success", title: "Nothing to follow up on", detail: "" };
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
        <h3>Record verified receipt</h3>
        <p>
          Record verified money received. This creates and links its bookkeeping row.
          Check existing bookkeeping payments first; link an existing row instead.
          A short receipt leaves the balance open.
        </p>
      </header>
      <div class="dialog-fields">
        <label>Received on <input name="receivedOn" type="date" required /></label>
        <label
          >Amount <span data-payment-currency></span>
          <input name="amount" inputmode="decimal" required
        /></label>
        <label>Confirms a reported payment
          <select name="replacesPaymentId"><option value="">New receipt</option></select>
        </label>
        <label
          >Bank/account and unique transaction ID
          <input name="reference" maxlength="200" required
        /></label>
        <label>Counterparty <input name="counterparty" maxlength="300" required /></label>
        <label>Category (optional) <input name="category" maxlength="300" /></label>
        <label>Received value in EUR (optional) <input name="amountEur" inputmode="decimal" /></label>
        <p role="alert"></p>
      </div>
      <footer>
        <button class="primary-button">Record verified receipt</button
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
  const voidDialog = formDialog("financeVoidDialog", html`<form>
    <header><h3>Cancel invoice follow-through</h3><p>Keep the invoice original and record why no payment is expected.</p></header>
    <div class="dialog-fields"><label>Cancellation reason <input name="reason" maxlength="500" required /></label><p role="alert"></p></div>
    <footer><button class="primary-button">Cancel invoice follow-through</button><button type="button" data-cancel>Keep open</button></footer>
  </form>`);
  surface.append(voidDialog);
  voidDialog.querySelector("[data-cancel]").addEventListener("click", () => voidDialog.close());
  function openVoidFinance(booking, projection) {
    const form = voidDialog.querySelector("form"); form.reset();
    form.querySelector('[role="alert"]').textContent = "";
    form.onsubmit = (event) => {
      event.preventDefault();
      financeMutation(booking, "/void", "POST", { expectedVersion: projection.finance.version, reason: form.elements.reason.value.trim() })
        .then(async () => { voidDialog.close(); await reopenBookingDetail(booking); })
        .catch((error) => { form.querySelector('[role="alert"]').textContent = error.message; });
    };
    voidDialog.showModal();
  }
  const adjustmentDialog = formDialog("financeAdjustmentDialog", html`<form>
    <h3>Approve noncash settlement</h3>
    <p>This reduces the outstanding receivable. It records no income. Use only an explicit owner approval supported by evidence.</p>
    <label>Adjustment amount<input name="amount" required inputmode="decimal"></label>
    <label>Reason<textarea name="reason" required maxlength="1000"></textarea></label>
    <label>Approved by<input name="approvedBy" required maxlength="160"></label>
    <label>Approval date<input name="approvedOn" type="date" required></label>
    <label>Approval evidence kind<select name="kind">
      <option value="document">Document</option><option value="email">Mail thread</option>
      <option value="url">Link</option><option value="note">Source note</option>
    </select></label>
    <label>Approval evidence reference<input name="ref" required maxlength="300"></label>
    <label>Replaces reviewed reported entry<select name="replacesPaymentId"></select></label>
    <p role="alert"></p><button class="primary-button">Approve noncash settlement</button>
    <button type="button" data-close>Cancel</button></form>`);
  adjustmentDialog.querySelector("[data-close]").onclick = () => adjustmentDialog.close();
  surface.append(invoiceDialog, paymentDialog, waitingDialog, evidenceDialog, adjustmentDialog);
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
  function openRecordPayment(booking, projection, payment) {
    const form = paymentDialog.querySelector("form");
    form.reset();
    form.querySelector('[role="alert"]').textContent = "";
    const finance = projection.finance;
    form.querySelector("[data-payment-currency]").textContent = `(${finance.currency})`;
    form.elements.receivedOn.value = payment?.effectiveDate || todayIso();
    form.elements.amount.value = payment?.amount || projection.outstanding || "";
    form.elements.reference.value = payment?.reference || "";
    form.elements.amountEur.value = payment?.amountEur || "";
    form.elements.category.value = payment?.category || "";
    const reported = form.elements.replacesPaymentId;
    reported.replaceChildren();
    const empty = document.createElement("option");
    empty.value = ""; empty.textContent = "New receipt"; reported.append(empty);
    for (const item of projection.payments.filter((item) => item.source === "recorded")) {
      const option = document.createElement("option");
      option.value = item.id; option.textContent = `${item.effectiveDate}: ${item.amount} ${item.currency} reported`;
      reported.append(option);
    }
    reported.closest("label").hidden = Boolean(payment);
    form.elements.counterparty.value = booking.organizationName || booking.organization?.displayName || booking.title || "";
    form.querySelector("h3").textContent = payment ? "Correct verified receipt" : "Record verified receipt";
    form.querySelector("button.primary-button").textContent = payment ? "Save correction" : "Record verified receipt";
    form.elements.counterparty.required = !payment;
    form.onsubmit = (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(form));
      financeMutation(booking, payment ? `/receipts/${encodeURIComponent(payment.id)}` : "/receipts", payment ? "PUT" : "POST", {
        expectedVersion: finance.version,
        receivedOn: values.receivedOn,
        amount: String(values.amount).trim(),
        currency: finance.currency,
        category: values.category.trim(), reference: values.reference.trim(), counterparty: values.counterparty.trim(),
        ...(!payment && values.replacesPaymentId ? { replacesPaymentId: values.replacesPaymentId } : {}),
        ...(values.amountEur.trim() ? { amountEur: values.amountEur.trim() } : {}),
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
  function openSettlementAdjustment(booking, projection) {
    const form = adjustmentDialog.querySelector("form"); form.reset();
    form.querySelector('[role="alert"]').textContent = "";
    form.elements.amount.value = projection.outstanding || "";
    form.elements.approvedOn.value = todayIso();
    const select = form.elements.replacesPaymentId; select.replaceChildren();
    const empty = document.createElement("option"); empty.value = ""; empty.textContent = "No reported entry replaced"; select.append(empty);
    for (const payment of projection.payments.filter((item) => item.source === "recorded")) {
      const option = document.createElement("option"); option.value = payment.id;
      option.textContent = `${payment.amount} ${payment.currency}: ${payment.reference || payment.effectiveDate}`; select.append(option);
    }
    form.onsubmit = (event) => {
      event.preventDefault(); const values = Object.fromEntries(new FormData(form));
      financeMutation(booking, "/settlement-adjustment", "POST", {
        expectedVersion: projection.finance.version, amount: values.amount.trim(), currency: projection.finance.currency,
        reason: values.reason.trim(), approvedBy: values.approvedBy.trim(), approvedOn: values.approvedOn,
        evidence: [{ kind: values.kind, ref: values.ref.trim() }],
        ...(values.replacesPaymentId ? { replacesPaymentId: values.replacesPaymentId } : {}),
      }).then(async () => { adjustmentDialog.close(); await reopenBookingDetail(booking); })
        .catch((error) => showFormError(form, error));
    };
    adjustmentDialog.showModal();
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
  function openAddEvidence(booking, projection, preset = {}) {
    const form = evidenceDialog.querySelector("form");
    form.reset();
    form.querySelector('[role="alert"]').textContent = "";
    if (preset.kind) form.elements.kind.value = preset.kind;
    if (preset.label) form.elements.label.value = preset.label;
    if (preset.on) form.elements.on.value = preset.on;
    if (preset.ref) form.elements.ref.value = preset.ref;
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
      const existing = projection.finance.evidence || [];
      const duplicateIndex = existing.findIndex((entry) => entry.kind === item.kind && entry.ref === item.ref);
      const nextEvidence = duplicateIndex >= 0
        ? existing.map((entry, idx) => (idx === duplicateIndex ? item : entry))
        : [...existing, item];
      financeMutation(booking, "/follow-through", "PUT", {
        expectedVersion: projection.finance.version,
        evidence: nextEvidence,
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
  return { openIssueInvoice, openRecordPayment, openSettlementAdjustment, openWaitingOn, openAddEvidence, openVoidFinance };
}
