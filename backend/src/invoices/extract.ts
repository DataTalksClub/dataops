import type { InvoiceFields } from './model';
const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function calendar(value: string): string | undefined {
  const match = /([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/.exec(value);
  if (!match) return undefined;
  const m = months.findIndex(x => x.toLowerCase() === match[1].toLowerCase());
  if (m < 0) return undefined;
  const result = `${match[3]}-${String(m+1).padStart(2,'0')}-${match[2].padStart(2,'0')}`;
  return new Date(result).toISOString().slice(0,10) === result ? result : undefined;
}
export function extractInvoiceText(text: string): { fields: InvoiceFields; extraction: { method: string; evidence: string[]; issues: string[] } } {
  const fields: InvoiceFields = { archiveRequired: true, quantity: 1 };
  const evidence: string[] = [];
  let method = 'manual';
  const aws = /\b(EUINDE\d+-\d+)\b/.exec(text);
  const total = /TOTAL AMOUNT\s+USD\s+([\d,]+\.\d{2})/.exec(text);
  const awsDate = /VAT Invoice Date:\s*([A-Za-z]+\s+\d{1,2},?\s+\d{4})/.exec(text);
  if (aws && total && awsDate && /Amazon Web Services/i.test(text)) {
    method = 'deterministic-aws';
    Object.assign(fields, { invoiceNumber: aws[1], counterparty: 'Amazon Web Services', amount: total[1].replace(/,/g,''), currency: 'USD', transactionDate: calendar(awsDate[1]), description: 'Cloud services' });
    const account = /(?:Account(?: number| ID)?|VAT Invoice Number:[^\n]*?)\s*[:#]?\s*(\d{12})/i.exec(text);
    if (account) fields.accountContext = account[1];
    const period = /billing period\s+([^\n]{1,100})/i.exec(text);
    if (period) fields.period = period[1].trim();
    evidence.push('AWS invoice number, invoice date, USD total and issuer anchors');
  } else {
    const number = /(?:Invoice|Receipt) number\s+([A-Z0-9]+(?:\s*[-\u0000–—]\s*[A-Z0-9]+)+)/i.exec(text);
    const dated = /(?:Date of issue|Date paid)\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i.exec(text);
    const amount = /(\$|€|USD\s*|EUR\s*)([\d,]+\.\d{2})\s*(?:(?:USD|EUR)\s+)?(?:paid on|due)/i.exec(text);
    // Merchant comes from the document issuer line, never from the payment processor.
    const issuer = /(?:Date paid|Date of issue|Date due|Due date)[ \t]+[^\n]+\n(?![ \t]*(?:Date |Due date|Bill to))([^\n]{1,120})/m.exec(text) || /^(\S[^\n]{0,119})\n(?:Receipt|Invoice)[ \t]*\n/m.exec(text) || /^(?:Receipt|Invoice)\s*\n(?!Invoice number|Receipt number)([^\n]{1,120})\n/m.exec(text);
    if (number && dated && amount && issuer) {
      method = 'deterministic-stripe';
      Object.assign(fields, { invoiceNumber: number[1].replace(/\s*[-\u0000–—]\s*/g,'-'), counterparty: issuer[1].trim(), amount: amount[2].replace(/,/g,''), currency: /€|EUR/.test(amount[1]) ? 'EUR' : 'USD', transactionDate: calendar(dated[1]), description: 'Subscription' });
      const context = /(?:Billed to|Bill to)\s*\n([^\n]{1,120})/i.exec(text);
      if (context) fields.accountContext = context[1].trim();
      // Date paid is evidence of date only. EUR tax-display conversion is never copied.
      const paid = /Date paid\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4})/.exec(text);
      if (paid) fields.paidDate = calendar(paid[1]);
      evidence.push('Stripe-layout issuer, invoice/receipt number, date and USD total anchors');
    }
  }
  return { fields, extraction: { method, evidence, issues: method === 'manual' ? ['Unsupported or ambiguous layout: complete the draft manually'] : ['Confirm payment evidence and actual EUR bank amount'] } };
}
export async function pdfText(bytes: Buffer): Promise<string> {
  if (bytes.length > 25*1024*1024 || bytes.subarray(0,5).toString() !== '%PDF-') throw new Error('invalid-pdf');
  // Keep native ESM import through the CommonJS build.
  const load = new Function('return import("pdfjs-dist/legacy/build/pdf.mjs")') as () => Promise<typeof import('pdfjs-dist')>;
  const pdfjs = await load();
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false, verbosity: 0 });
  try {
    const doc = await task.promise;
    if (doc.numPages > 40) throw new Error('pdf-page-limit');
    let text = '';
    for (let n=1; n<=doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      for (const item of content.items) {
        if ('str' in item) text += item.str + (item.hasEOL ? '\n' : ' ');
        if (text.length > 200000) throw new Error('pdf-text-limit');
      }
      text += '\n';
    }
    return text;
  } finally { await task.destroy(); }
}
