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

export function deriveCliThankYou(input = {}) {
  if (input.projection?.thankYou) return input.projection.thankYou;
  const paymentState = input.paymentState ?? input.projection?.paymentState;
  if (paymentState !== "paid" && paymentState !== "partially-paid") return undefined;

  const finance = input.projection?.finance || input.beforeProjection?.finance || {};
  const invoiceNumber = input.invoiceNumber || finance.invoiceNumber;
  const dealTitle = input.dealTitle || input.dealName;
  const currency = input.currency || finance.currency;
  const paid = input.paid || input.projection?.paid || input.amount;
  const lastPaymentOn = input.lastPaymentOn || input.projection?.lastPaymentOn || input.receivedOn;
  const evidence = input.projection?.finance?.evidence || finance.evidence;

  const whatWasPaid = invoiceNumber
    ? `invoice ${invoiceNumber}`
    : dealTitle
      ? dealTitle
      : paid && currency
        ? `${paid} ${currency} sponsorship payment`
        : "your sponsorship";

  const recordedEvidence = findThankYouEvidence(evidence, lastPaymentOn);
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
      dealId: input.dealId,
      ...(dealTitle ? { dealTitle } : {}),
      ...(invoiceNumber ? { invoiceNumber } : {}),
      ...(paid ? { paid: String(paid) } : {}),
      ...(currency ? { currency } : {}),
      ...(lastPaymentOn ? { lastPaymentOn } : {}),
      whatWasPaid,
    },
    ...(recordedEvidence ? { recordedEvidence } : {}),
  };
}

export function attachThankYouResult(result, input = {}) {
  const thankYou = deriveCliThankYou({
    ...input,
    dealId: result.dealId,
    paymentState: result.paymentState ?? input.projection?.paymentState ?? input.fallbackPaymentState,
  });
  if (!thankYou) return result;
  result.thankYou = thankYou;
  if (thankYou.status === "required") {
    result.nextStep = {
      code: "thank-sponsor",
      sendPolicy: "send-with-template",
      templateId: thankYou.templateId,
      sopId: thankYou.sopId,
      sopStep: thankYou.sopStep,
      summary: thankYou.summary,
      instruction: thankYou.instruction,
    };
  }
  return result;
}

export function printThankYouHint(io, thankYou) {
  if (!thankYou || typeof io?.print !== "function") return;
  if (thankYou.status === "recorded") {
    io.print(`thank-you: recorded (${thankYou.recordedEvidence?.ref || "email evidence on deal"})`);
    return;
  }
  io.print(
    `next-step: send thank-you email from orin@ using ${thankYou.templateId} `
    + `(reply in the invoice thread, no draft; template exists — no Alexey approval; fill <NAME>, <WHAT_WAS_PAID>="${thankYou.context?.whatWasPaid || ""}", <SENDER_NAME>)`,
  );
}
