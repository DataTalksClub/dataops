import type { FinanceEvidence, PaymentState } from './types';

export const THANK_YOU_TEMPLATE_ID = 'template.finance.bookkeeping.email-to-sponsor-when-payment-has-been-received';
export const THANK_YOU_TEMPLATE_PATH = 'content/06-finance-and-compliance/create-and-collect-invoices/templates/email-to-sponsor-when-payment-has-been-received.md';
export const THANK_YOU_SOP_ID = 'sop.finance.bookkeeping.adding-paid-invoices-to-the-bookkeeping-spreadsheet-and-adding-it-to-dropbox';
export const THANK_YOU_SOP_STEP = 9;
export const THANK_YOU_EVIDENCE_LABEL = 'Payment received thank-you email';

export const THANK_YOU_TEMPLATE_BODY = [
  'Hi <NAME>,',
  '',
  'We have received the payment for <WHAT_WAS_PAID>. Thank you for supporting our community!',
  '',
  'Best,',
  '<SENDER_NAME>',
].join('\n');

export const THANK_YOU_TEMPLATE_MARKDOWN = [
  '## Template',
  '',
  '```text',
  THANK_YOU_TEMPLATE_BODY,
  '```',
  '',
  '## Placeholders',
  '',
  '| Placeholder | What to put there | Example |',
  '| :--- | :--- | :--- |',
  '| `<NAME>` | First name of the sponsor contact on the invoice or payment thread | `Alex` |',
  '| `<WHAT_WAS_PAID>` | What the payment covers — name the invoice number if there is one, otherwise the sponsorship package or service | `invoice 202610/12` |',
  '| `<SENDER_NAME>` | First name of the person preparing the reply | `Operator` |',
].join('\n');

export type ThankYouPlaceholder = {
  name: string;
  description: string;
  example: string;
  suggestedValue?: string;
};

export type SponsorThankYou = {
  status: 'required' | 'recorded';
  sendPolicy: 'draft-only';
  templateId: typeof THANK_YOU_TEMPLATE_ID;
  templatePath: typeof THANK_YOU_TEMPLATE_PATH;
  sopId: typeof THANK_YOU_SOP_ID;
  sopStep: typeof THANK_YOU_SOP_STEP;
  summary: string;
  instruction: string;
  templateBody: string;
  templateMarkdown: string;
  placeholders: ThankYouPlaceholder[];
  context: {
    dealId: string;
    dealTitle?: string;
    invoiceNumber?: string;
    paid?: string;
    adjusted?: string;
    currency?: string;
    lastPaymentOn?: string;
    whatWasPaid: string;
  };
  recordedEvidence?: FinanceEvidence;
};

const THANK_YOU_EVIDENCE_PATTERN = /thank[-\s]*you|payment[-\s]*(received|confirmed|confirmation)|email-to-sponsor-when-payment-has-been-received/i;
const PRIOR_INVOICE_THREAD_PATTERN = /^(invoice(\s+thread)?|overdue\s+reminder|payment\s+follow-up)$/i;

export function findThankYouEvidence(
  evidence: FinanceEvidence[] | undefined,
  lastPaymentOn?: string,
): FinanceEvidence | undefined {
  if (!evidence?.length) return undefined;
  for (let index = evidence.length - 1; index >= 0; index--) {
    const item = evidence[index];
    if (item.kind !== 'email') continue;
    const text = `${item.label || ''} ${item.ref || ''}`.trim();
    if (THANK_YOU_EVIDENCE_PATTERN.test(text)) return item;
    if (
      item.on
      && lastPaymentOn
      && item.on >= lastPaymentOn
      && !PRIOR_INVOICE_THREAD_PATTERN.test((item.label || '').trim())
    ) {
      return item;
    }
  }
  return undefined;
}

export function deriveThankYou(input: {
  dealId: string;
  dealTitle?: string;
  invoiceNumber?: string;
  currency?: string;
  paid?: string;
  adjusted?: string;
  lastPaymentOn?: string;
  hasVerifiedPayment: boolean;
  paymentState: PaymentState;
  reconciliationStatus: 'coherent' | 'reconciliation-required';
  evidence?: FinanceEvidence[];
}): SponsorThankYou | undefined {
  if (input.reconciliationStatus !== 'coherent') return undefined;
  const paymentResolved = input.paymentState === 'paid'
    || (input.paymentState === 'partially-paid' && input.hasVerifiedPayment);
  if (!paymentResolved) return undefined;

  const whatWasPaid = input.invoiceNumber
    ? `invoice ${input.invoiceNumber}`
    : input.dealTitle
      ? input.dealTitle
      : input.paid && input.currency
        ? `${input.paid} ${input.currency} sponsorship payment`
        : 'your sponsorship';

  const recordedEvidence = findThankYouEvidence(input.evidence, input.lastPaymentOn);
  const status = recordedEvidence ? 'recorded' : 'required';

  return {
    status,
    sendPolicy: 'draft-only',
    templateId: THANK_YOU_TEMPLATE_ID,
    templatePath: THANK_YOU_TEMPLATE_PATH,
    sopId: THANK_YOU_SOP_ID,
    sopStep: THANK_YOU_SOP_STEP,
    summary: status === 'recorded'
      ? 'Sponsor thank-you email recorded'
      : 'Draft thank-you email to sponsor (draft only — Alexey reviews and sends)',
    instruction:
      `Prepare a draft reply in the sponsor's existing invoice or payment email thread using ${THANK_YOU_TEMPLATE_ID} `
      + `(SOP ${THANK_YOU_SOP_ID} step ${THANK_YOU_SOP_STEP}). Address the main contact, keep the thread's CC list, `
      + `and name ${whatWasPaid}. Draft only — do NOT send the email; Alexey reviews and sends it himself. `
      + 'Record the drafted/sent message reference in Finance evidence and on the owning Task.',
    templateBody: THANK_YOU_TEMPLATE_BODY,
    templateMarkdown: THANK_YOU_TEMPLATE_MARKDOWN,
    placeholders: [
      {
        name: '<NAME>',
        description: 'First name of the sponsor contact on the invoice or payment thread',
        example: 'Alex',
      },
      {
        name: '<WHAT_WAS_PAID>',
        description: 'What the payment covers — name the invoice number if there is one, otherwise the sponsorship package or service',
        example: 'invoice 202610/12',
        suggestedValue: whatWasPaid,
      },
      {
        name: '<SENDER_NAME>',
        description: 'First name of the person preparing the reply',
        example: 'Operator',
      },
    ],
    context: {
      dealId: input.dealId,
      ...(input.dealTitle ? { dealTitle: input.dealTitle } : {}),
      ...(input.invoiceNumber ? { invoiceNumber: input.invoiceNumber } : {}),
      ...(input.paid ? { paid: input.paid } : {}),
      ...(input.adjusted && input.adjusted !== '0' ? { adjusted: input.adjusted } : {}),
      ...(input.currency ? { currency: input.currency } : {}),
      ...(input.lastPaymentOn ? { lastPaymentOn: input.lastPaymentOn } : {}),
      whatWasPaid,
    },
    ...(recordedEvidence ? { recordedEvidence } : {}),
  };
}
