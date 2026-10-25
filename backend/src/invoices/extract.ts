import type { InvoiceFields } from './model';
import { dirname, join } from 'node:path';
export interface InvoiceHints { subject?: string; sender?: string }
const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const monthIndex = new Map<string, number>();
for (const [index, name] of months.entries()) { monthIndex.set(name.toLowerCase(), index); monthIndex.set(name.slice(0,3).toLowerCase(), index); }
function isoDate(year: string, month: string, day: string): string | undefined {
  const m = monthIndex.get(month.toLowerCase().replace(/\.$/, ''));
  if (m === undefined) return undefined;
  const result = `${year}-${String(m+1).padStart(2,'0')}-${day.padStart(2,'0')}`;
  return new Date(result).toISOString().slice(0,10) === result ? result : undefined;
}
function calendar(value: string): string | undefined {
  const text = value.trim();
  let match = /([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(text);
  if (match) return isoDate(match[3], match[1], match[2]);
  match = /(\d{1,2})\.?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/.exec(text);
  if (match) return isoDate(match[3], match[2], match[1]);
  match = /(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (match) { const result = match[0]; return new Date(result).toISOString().slice(0,10) === result ? result : undefined; }
  match = /\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/.exec(text);
  if (match) {
    const result = `${match[3]}-${match[2].padStart(2,'0')}-${match[1].padStart(2,'0')}`;
    const date = new Date(result);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === result ? result : undefined;
  }
  return undefined;
}
// Canonical operator ledger names for common billing senders. Names and
// generic descriptions only — never account numbers or routing specifics.
const PROVIDER_RULES: Array<{ match: RegExp; name: string; description?: string }> = [
  { match: /amazon\s+web\s+services|\baws\b/i, name: 'Amazon Web Services', description: 'Cloud services' },
  { match: /openai|chatgpt/i, name: 'OpenAI' },
  { match: /anthropic|claude/i, name: 'Anthropic' },
  { match: /google\s+workspace/i, name: 'Google Workspace', description: 'Google Workspace' },
  { match: /google\s+play/i, name: 'Google Play' },
  { match: /google\s+one/i, name: 'Google', description: 'Google One' },
  { match: /hetzner/i, name: 'Hetzner Online GmbH', description: 'Dedicated server' },
  { match: /\bcontabo\b/i, name: 'Contabo' },
  { match: /luma\s+(?:labs|ai)/i, name: 'Luma Labs, Inc.' },
  { match: /eleven\s?labs/i, name: 'ElevenLabs' },
  { match: /substack/i, name: 'Substack' },
  { match: /go\s?daddy/i, name: 'GoDaddy' },
  { match: /mailchimp|intuit/i, name: 'Intuit Mailchimp' },
  { match: /revolut/i, name: 'Revolut' },
  { match: /deepseek/i, name: 'Deepseek' },
  { match: /super\s?grok|\bx[.\s]?ai\b/i, name: 'xAI' },
  { match: /\bx\s?corp\b|x\s+internet/i, name: 'X Corp' },
];
const catalogProvider = (value: string) => PROVIDER_RULES.find(rule => rule.match.test(value));
export function normalizeSubject(value: unknown): string {
  return String(value || '')
    .replace(/^(?:(?:fwd?|re)\s*:\s*)+/gi, '')
    .replace(/\s*\[(?:account|invoice\s*id)\s*:[^\]]*\]/gi, '')
    .replace(/\s+(?:invoice\s+available|is\s+now\s+available)\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}
// "ChatGPT Plus subscription receipt from Oct 2, 2026" -> "ChatGPT Plus subscription"
function subjectDescription(subject: string, provider: string | undefined): string | undefined {
  let value = normalizeSubject(subject)
    .replace(/^your\s+/i, '')
    .replace(/\s+(?:from|on|of|dated?)\s+[A-Za-z0-9].*$/i, '')
    .replace(/\s*(?:order\s+)?(?:receipt|invoice|statement)\s*$/i, '');
  if (provider) value = value.replace(new RegExp(`^${provider.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\s*`, 'i'), '').replace(new RegExp(`\\s*${provider.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}$`, 'i'), '');
  value = value.replace(/[\s·–—:,-]+$/,'').trim();
  return value.length >= 3 && value.length <= 120 ? value : undefined;
}
const NON_ISSUER = /^(?:page|seite|company\s+name|vat|gst|tax|invoice|receipt|number|date|due|bill|sold|from|to|amount|total|paid|order|statement|account|iban|bic|swift|period|terms|status|customer|client|email|website|address|phone|subscription|plan|product|description|quantity|qty|price|currency|card|payment|method|reference|ref|stripe|paypal|paddle|square|klarna|mollie|adyen)\b/i;
function plausibleIssuer(line: unknown): string | undefined {
  const value = String(line || '').replace(/\s+/g,' ').trim().replace(/^[—–-]+|[—–-]+$/g,'').replace(/\s+@[A-Za-z0-9_.-]+$/, '');
  if (value.length < 2 || value.length > 100) return undefined;
  if (/[:;]/.test(value) || /\d{5,}/.test(value)) return undefined;
  if (!/[a-zA-Z]{2}/.test(value) || /^(?:https?:\/\/|www\.)/i.test(value)) return undefined;
  if (NON_ISSUER.test(value)) return undefined;
  if (/^\d{4}-\d{2}-\d{2}\b|^\d{1,2}[./]\d{1,2}[./]\d{4}\b|^[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}\b/.test(value)) return undefined;
  return value;
}
// Standalone-line issuers outside a named layout must look like a company:
// a known provider or a trailing legal form. Prose and OCR noise stay out.
const LEGAL_FORM = /\b(?:gmbh|ug|ag|se|kg|ltda?|limited|inc|llc|corp(?:oration)?|company|co|bv|oy|aps|ab|as|oü|sarl|srl|sl|plc|pte|kk)\.?[\s,]*$/i;
function credibleIssuer(line: unknown): { name: string; rule?: ReturnType<typeof catalogProvider> } | undefined {
  const value = plausibleIssuer(line);
  if (!value) return undefined;
  const rule = catalogProvider(value);
  if (!rule && !LEGAL_FORM.test(value)) return undefined;
  return { name: rule ? rule.name : value, rule };
}
// Vendor-name candidates in decreasing trust order; implausible field-label
// lines (e.g. a bare VAT/GST identifier row) are skipped, not reported.
function issuerCandidates(text: string): string[] {
  const candidates: string[] = [];
  const from = /(?:receipt|invoice|order)\s+from\s+([^\n]{1,120})/i.exec(text);
  if (from) candidates.push(from[1]);
  const first = /^[^\S\n]*(\S[^\n]{0,119})/.exec(text);
  if (first) candidates.push(first[1]);
  const above = /([^\n]{1,120})\n(?:Receipt|Invoice)\s*(?:\n|$)/.exec(text);
  if (above) candidates.push(above[1]);
  const afterDate = /(?:Date (?:of issue|paid|due)|Invoice date|Billing date|Due date)[^\n]*\n/.exec(text);
  if (afterDate) {
    for (const line of text.slice(afterDate.index+afterDate[0].length).split('\n').slice(0,8)) {
      if (/^\s*(?:bill\s+to|sold\s+to|customer|client)\b/i.test(line)) break;
      candidates.push(line);
    }
  }
  const afterHeading = /^(?:Receipt|Invoice)\s*\n(?!Invoice number|Receipt number)([^\n]{1,120})\n/m.exec(text);
  if (afterHeading) candidates.push(afterHeading[1]);
  // Some documents identify their issuer only in a legal footer. A legal
  // company suffix bounds the name before an address separator; arbitrary
  // prose elsewhere in the email is not an issuer candidate.
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    const copyright = /^©\s*\d{4}\s*/.test(line.trim());
    const registration = /\b(?:Sitz|Registergericht|registered\s+office|company\s+registration)\b/i.test(lines.slice(index,index+3).join(' '));
    if (!copyright && !registration) continue;
    const clean = line.trim().replace(/^©\s*\d{4}\s*/, '');
    const legal = /^(.{2,100}?\b(?:gmbh\s*&\s*co\.?\s*kg|gmbh|limited|inc|llc|corp(?:oration)?|bv|plc|ltd)\.?)(?:\s+[-•]\s+|$)/i.exec(clean);
    if (legal && credibleIssuer(legal[1])) candidates.push(legal[1]);
  }
  return candidates;
}
function money(value: string): string | undefined {
  let normalized = value.replace(/\s/g,'');
  if (/^\d{1,3},\d{2}$/.test(normalized)) normalized = `${normalized.slice(0,normalized.indexOf(','))}.${normalized.slice(normalized.indexOf(',')+1)}`;
  else normalized = normalized.replace(/,/g,'');
  return /^\d{1,10}(\.\d{2})?$/.test(normalized) && Number(normalized) > 0 ? normalized : undefined;
}
const TOTAL_LABEL = /(?:grand\s+total|total\s+amount|amount\s+(?:due|charged|paid)|balance\s+due|order\s+total|total\s+due|total)\b[^\n]{0,80}/gi;
function lineMoney(line: string): { amount: string; currency: 'USD' | 'EUR' } | undefined {
  const match = /(?:(\$|€|\bUSD\b|\bEUR\b)\s?([\d][\d,]*(?:\.\d{2})?)\s?(?:USD|EUR)?)|((?:[\d][\d,]*(?:\.\d{2})?)\s?(\$|€|\bUSD\b|\bEUR\b))/.exec(line);
  if (!match) return undefined;
  const euro = (symbol: string) => symbol === '€' || /EUR/i.test(symbol);
  if (match[2] !== undefined) {
    const amount = money(match[2]);
    return amount ? { amount, currency: euro(match[1]) ? 'EUR' : 'USD' } : undefined;
  }
  const amount = money(match[3].replace(/(\$|€|\bUSD\b|\bEUR\b)/i, ''));
  return amount ? { amount, currency: euro(match[4]) ? 'EUR' : 'USD' } : undefined;
}
// European comma decimals ("45,70 €") only inside an explicit € context.
const COMMA_EURO = /([\d]{1,4},\d{2})\s?€/;
function totalAmount(text: string): { amount: string; currency: 'USD' | 'EUR' } | undefined {
  let found: { amount: string; currency: 'USD' | 'EUR' } | undefined;
  for (const label of text.matchAll(TOTAL_LABEL)) {
    const direct = lineMoney(label[0]);
    if (direct) { found = direct; continue; }
    const comma = COMMA_EURO.exec(label[0]);
    if (comma) { const amount = money(comma[1]); if (amount) found = { amount, currency: 'EUR' }; }
  }
  return found;
}
function documentCurrency(text: string): 'USD' | 'EUR' | undefined {
  const usd = /\$|\bUSD\b/.test(text); const eur = /€|\bEUR\b/.test(text);
  return usd && !eur ? 'USD' : eur && !usd ? 'EUR' : undefined;
}
function labeledDate(text: string, labels: RegExp): string | undefined {
  const match = labels.exec(text);
  return match?.[1] ? calendar(match[1]) : undefined;
}
const ISSUED_LABELS = /(?:invoice\s+date|date\s+of\s+issue|issue\s+date|billing\s+date|order\s+date|rechnungsdatum|\bdate\b)[^\n]{0,30}?([^\n]{1,40})/i;
const PAID_LABELS = /(?:date\s+paid|paid\s+on|payment\s+date)[^\n]{0,30}?([^\n]{1,40})/i;
function invoiceNumber(text: string): string | undefined {
  const labeled = /(?:invoice|receipt|order)\s+(?:number|no\.?|num\.?|#|id)\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9\/_.-]{2,40})/i.exec(text);
  if (labeled && /\d/.test(labeled[1])) return labeled[1];
  const bare = /(?:^|\n)\s*(?:invoice|receipt)\s+((?=[A-Za-z0-9-]*\d)[A-Za-z0-9][A-Za-z0-9\/_.-]{2,40})\s*(?:\n|$)/i.exec(text);
  return bare ? bare[1] : undefined;
}
export function extractInvoiceText(text: string, hints: InvoiceHints = {}): { fields: InvoiceFields; extraction: { method: string; evidence: string[]; issues: string[] } } {
  const fields: InvoiceFields = { archiveRequired: true, quantity: 1 };
  const evidence: string[] = [];
  const issues: string[] = [];
  const vat = /\b(?:VAT[ \-]*(?:ID|number|no\.?)|USt[. \-]*IdNr\.?)\s*[:#]?\s*([A-Z]{2}[A-Z0-9]{2,14})\b/i.exec(text);
  if (vat) { fields.vatId = vat[1].toUpperCase(); evidence.push('labeled VAT identifier'); }
  let method = 'manual';
  // Contabo's proforma PDFs can consist almost entirely of vector outlines.
  // pdfText supplies OCR when the text layer is sparse. Require the issuer,
  // proforma number, issue date and gross total together before using this layout.
  const contaboNumber = /Proforma\s*[-–]?\s*Rechnung\s*:?\s*([A-Z0-9]{8,40})\b/i.exec(text);
  const contaboDate = /\bDatum\s*:\s*(\d{1,2}\.\d{1,2}\.\d{4})\b/i.exec(text);
  const contaboGross = /Gesamt\s*brutto\s*:?\s*(\d{1,7}(?:[.,]\d{2}))\s*(?:€|EUR)/i.exec(text);
  if (/\bContabo\s*GmbH\b/i.test(text) && contaboNumber && contaboDate && contaboGross) {
    const date = calendar(contaboDate[1]);
    const amount = money(contaboGross[1].replace(',', '.'));
    if (date && amount) {
      method = 'deterministic-contabo';
      Object.assign(fields, { counterparty: 'Contabo', amount, currency: 'EUR', transactionDate: date, invoiceNumber: contaboNumber[1] });
      evidence.push('Contabo issuer, proforma number, issue date and gross EUR total');
      // Preserve the existing first-labeled-VAT semantics: the customer VAT-ID
      // precedes Contabo's own USt-IdNr in the footer. This is not a supplier-ID field.
      if (vat) evidence.push('VAT ID is the first labeled identifier in document order (customer VAT-ID on Contabo)');
    }
  }
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
    return { fields, extraction: { method, evidence, issues: ['Confirm payment evidence and actual EUR bank amount'] } };
  }
  const stripeNumber = /(?:Invoice|Receipt) number\s+([A-Z0-9]+(?:\s*[-\u0000–—]\s*[A-Z0-9]+)+)/.exec(text);
  const stripeAmount = /(\$|€|USD\s*|EUR\s*)([\d,]+\.\d{2})\s*(?:(?:USD|EUR)\s+)?(?:paid on|due)/.exec(text);
  const stripeDate = /(?:Date of issue|Date paid)\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i.exec(text);
  if (stripeNumber && stripeAmount && stripeDate) {
    method = 'deterministic-stripe';
    Object.assign(fields, { invoiceNumber: stripeNumber[1].replace(/\s*[-\u0000–—]\s*/g,'-'), amount: stripeAmount[2].replace(/,/g,''), currency: /€|EUR/.test(stripeAmount[1]) ? 'EUR' : 'USD', transactionDate: calendar(stripeDate[1]) });
    for (const candidate of issuerCandidates(text)) {
      const issuer = plausibleIssuer(candidate);
      if (!issuer) continue;
      const rule = catalogProvider(issuer);
      fields.counterparty = rule ? rule.name : issuer;
      if (rule?.description) fields.description ??= rule.description;
      break;
    }
    const paid = /Date paid\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4})/.exec(text);
    if (paid) fields.paidDate = calendar(paid[1]);
    evidence.push('Stripe-layout invoice/receipt number, date and total anchors');
  }
  // Generic anchors cover layouts outside the two named families and fill
  // anything the named-family pass missed.
  if (!fields.invoiceNumber) { const found = invoiceNumber(text); if (found) { fields.invoiceNumber = found; evidence.push('labeled invoice/receipt number'); } }
  if (!fields.transactionDate) { const found = labeledDate(text, ISSUED_LABELS); if (found) { fields.transactionDate = found; evidence.push('labeled issue date'); } }
  if (!fields.paidDate) { const found = labeledDate(text, PAID_LABELS); if (found) fields.paidDate = found; }
  if (!fields.amount) {
    const found = totalAmount(text);
    if (found) { fields.amount = found.amount; fields.currency = found.currency; evidence.push(`labeled total with ${found.currency} currency`); }
    else { const currency = documentCurrency(text); if (currency) fields.currency = currency; }
  }
  if (!fields.counterparty) {
    for (const candidate of issuerCandidates(text)) {
      const issuer = credibleIssuer(candidate);
      if (!issuer) continue;
      fields.counterparty = issuer.name;
      if (issuer.rule?.description) fields.description ??= issuer.rule.description;
      evidence.push('document issuer line');
      break;
    }
  }
  if (fields.invoiceNumber || fields.transactionDate || fields.amount || fields.counterparty) method = method === 'manual' ? 'deterministic-text' : method;
  // Forwarded-email hints: the subject and sender identify the provider even
  // when the document text is scanned, terse or fully opaque.
  const subject = normalizeSubject(hints.subject);
  if (subject || hints.sender) {
    const rule = catalogProvider(`${subject}\n${hints.sender || ''}`);
    if (rule && !fields.counterparty) {
      fields.counterparty = rule.name;
      fields.description ??= rule.description;
      if (method === 'manual') method = 'email-hints';
      evidence.push('provider from the forwarded email subject/sender');
    }
    if (!fields.description) {
      const derived = subjectDescription(subject, fields.counterparty || rule?.name);
      if (derived) { fields.description = derived; if (method === 'manual') method = 'email-hints'; evidence.push('description from the email subject'); }
    }
    if (rule && fields.counterparty === rule.name && !evidence.includes('provider from the forwarded email subject/sender')) evidence.push('provider confirmed against the email subject/sender');
  }
  if (!fields.counterparty) issues.push('Provider not identified: complete it during review');
  else if (method === 'email-hints') issues.push('Provider identified from the email, not the document: confirm it against the PDF');
  if (!fields.amount || !fields.currency) issues.push('Total not identified: enter the invoice amount during review');
  if (!fields.transactionDate) issues.push('Invoice date not identified: enter it during review');
  if (method === 'manual') issues.push('Unsupported or ambiguous layout: complete the draft manually');
  else issues.push('Confirm payment evidence and actual EUR bank amount');
  return { fields, extraction: { method, evidence, issues } };
}
export async function pdfText(bytes: Buffer): Promise<string> {
  if (bytes.length > 25*1024*1024 || bytes.subarray(0,5).toString() !== '%PDF-') throw new Error('invalid-pdf');
  // Keep native ESM import through the CommonJS build.
  const load = new Function('return import("pdfjs-dist/legacy/build/pdf.mjs")') as () => Promise<typeof import('pdfjs-dist')>;
  const pdfjs = await load();
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false, verbosity: 0,
    standardFontDataUrl: join(dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + '/' });
  try {
    const doc = await task.promise;
    if (doc.numPages > 40) throw new Error('pdf-page-limit');
    let text = '';
    const sparsePages: number[] = [];
    for (let n=1; n<=doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let pageText = '';
      for (const item of content.items) {
        if ('str' in item) pageText += item.str + (item.hasEOL ? '\n' : ' ');
        if (text.length + pageText.length > 200000) throw new Error('pdf-text-limit');
      }
      text += pageText + '\n';
      if (text.length > 200000) throw new Error('pdf-text-limit');
      if (pageText.replace(/\s/g, '').length < 100) sparsePages.push(n);
    }
    // Keep the text layer first: reliable labeled IDs retain their precedence
    // over OCR (notably the customer VAT-ID on outline-only Contabo invoices).
    if (sparsePages.length) {
      const fields = extractInvoiceText(text).fields;
      if (!fields.amount && !fields.transactionDate && !fields.invoiceNumber) text += await ocrPages(doc, sparsePages);
    }
    if (text.length > 200000) throw new Error('pdf-text-limit');
    return text;
  } finally { await task.destroy(); }
}

async function ocrPages(doc: import('pdfjs-dist').PDFDocumentProxy, pages: number[]): Promise<string> {
  // Bound memory and latency within the 60-second, 1-GiB Lambda. Never download
  // executables or language data at runtime, or write into Lambda's read-only tree.
  if (pages.length > 3) throw new Error('pdf-ocr-page-limit');
  const { createWorker } = require('tesseract.js') as typeof import('tesseract.js');
  const { createCanvas } = require('@napi-rs/canvas') as typeof import('@napi-rs/canvas');
  const langPath = join(dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0');
  let worker: import('tesseract.js').Worker | undefined;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operation = async () => {
    // Legacy recognition preserves the tiny decimal comma in Contabo's narrow
    // outlined font; the LSTM model reads its "70,44" as "7044". Require explicit
    // decimal punctuation in the layout parser rather than inferring cents.
    worker = await createWorker('eng', 0, { langPath, cacheMethod: 'none', errorHandler: () => {} });
    if (expired) { await worker.terminate(); throw new Error('pdf-ocr-timeout'); }
    await worker.setParameters({ preserve_interword_spaces: '1' });
    let text = '';
    for (const n of pages) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(4, Math.sqrt(10_000_000 / (base.width * base.height)));
      const viewport = page.getViewport({ scale });
      if (!Number.isFinite(viewport.width * viewport.height) || viewport.width > 10000 || viewport.height > 10000)
        throw new Error('pdf-ocr-dimension-limit');
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      try {
        await page.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport }).promise;
        text += '\n' + (await worker.recognize(canvas.toBuffer('image/png'))).data.text;
      } finally { canvas.width = 1; canvas.height = 1; page.cleanup(); }
      if (text.length > 200000) throw new Error('pdf-text-limit');
    }
    return text;
  };
  try {
    return await Promise.race([operation(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(new Error('pdf-ocr-timeout')); }, 35000);
    })]);
  } finally { if (timer) clearTimeout(timer); if (worker) await worker.terminate(); }
}
