import { PDFDocument, StandardFonts } from 'pdf-lib';

export interface InvoiceTemplate {
  name: string;
  issuer: string;
  recipient: string;
  paymentDetails: string;
  taxNote: string;
  currency: string;
}
export interface InvoiceValues {
  invoiceNumber: string;
  issueDate: string;
  servicePeriod: string;
  items: { description: string; amount: string }[];
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x08\x0b-\x1f\x7f]/.test(value))
    throw new Error(`Invalid ${label}`);
  if (/[^\x20-\x7e\n\u00a0-\u00ff\u20ac\u2013\u2014\u2018\u2019\u201c\u201d]/.test(value))
    throw new Error(`${label} contains characters unsupported by the invoice font; use Latin spelling`);
  return value.trim();
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
  return value as Record<string, unknown>;
}
export function validateTemplate(value: unknown): InvoiceTemplate {
  const v = object(value);
  const currency = text(v.currency, 'currency', 3);
  if (!['EUR', 'USD', 'GBP'].includes(currency)) throw new Error('Currency must be EUR, USD or GBP');
  return {
    name: text(v.name, 'template name', 100), issuer: text(v.issuer, 'issuer', 1500),
    recipient: text(v.recipient, 'recipient', 1500), paymentDetails: text(v.paymentDetails, 'payment details', 1500),
    taxNote: text(v.taxNote, 'tax note', 1500), currency,
  };
}
export function validateValues(value: unknown): InvoiceValues {
  const v = object(value);
  const issueDate = text(v.issueDate, 'issue date', 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issueDate) || !Number.isFinite(Date.parse(issueDate)) || new Date(issueDate).toISOString().slice(0, 10) !== issueDate)
    throw new Error('Invalid issue date');
  if (!Array.isArray(v.items) || v.items.length < 1 || v.items.length > 50) throw new Error('Use 1 to 50 invoice items');
  return {
    invoiceNumber: text(v.invoiceNumber, 'invoice number', 80), issueDate,
    servicePeriod: text(v.servicePeriod, 'service period', 150),
    items: v.items.map((item) => {
      const row = object(item);
      const amount = text(row.amount, 'item amount', 12);
      if (!/^(0|[1-9]\d{0,7})(\.\d{1,2})?$/.test(amount) || cents(amount) <= 0) throw new Error('Item amounts must be positive decimals with at most two decimal places');
      return { description: text(row.description, 'item description', 600), amount };
    }),
  };
}
function cents(amount: string): number {
  const [whole, fraction = ''] = amount.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}
export function invoiceTotal(values: InvoiceValues): string {
  return (values.items.reduce((sum, item) => sum + cents(item.amount), 0) / 100).toFixed(2);
}

/** Pure rendering: no sending, numbering allocation, payment or ledger mutation. */
export async function renderInvoice(template: InvoiceTemplate, values: InvoiceValues): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = pdf.embedStandardFont(StandardFonts.Helvetica);
  const bold = pdf.embedStandardFont(StandardFonts.HelveticaBold);
  let page = pdf.addPage([595.28, 841.89]);
  let y = 790;
  function line(value: string, heading = false) {
    const face = heading ? bold : font, size = heading ? 14 : 11;
    for (const paragraph of value.split('\n')) {
      let row = '';
      for (const char of paragraph) {
        if (face.widthOfTextAtSize(row + char, size) > 490) { draw(row); row = ''; }
        row += char;
      }
      draw(row);
    }
    y -= 7;
    function draw(row: string) {
      if (y < 55) { page = pdf.addPage([595.28, 841.89]); y = 790; }
      page.drawText(row, { x: 50, y, font: face, size }); y -= 17;
    }
  }
  pdf.setTitle(`Invoice ${values.invoiceNumber}`);
  line('INVOICE', true);
  line(`Invoice number: ${values.invoiceNumber}`);
  line(`Invoice date: ${values.issueDate}`);
  line(`Services provided in: ${values.servicePeriod}`);
  line('From', true); line(template.issuer);
  line('Bill to', true); line(template.recipient);
  line(`Items (${template.currency})`, true);
  values.items.forEach((item, index) => line(`${index + 1}. ${item.description} - ${Number(item.amount).toFixed(2)} ${template.currency}`));
  line(`Invoice total: ${invoiceTotal(values)} ${template.currency}`, true);
  line('Tax treatment', true); line(template.taxNote);
  line('Payment details', true); line(template.paymentDetails);
  return pdf.save();
}
