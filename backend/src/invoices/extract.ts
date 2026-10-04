import type { InvoiceFields } from './model';
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
const NON_ISSUER = /^(?:vat|gst|tax|invoice|receipt|number|date|due|bill|sold|from|to|amount|total|paid|order|statement|account|iban|bic|swift|period|terms|status|customer|client|email|website|address|phone|subscription|plan|product|description|quantity|qty|price|currency|card|payment|method|reference|ref|stripe|paypal|paddle|square|klarna|mollie|adyen)\b/i;
function plausibleIssuer(line: unknown): string | undefined {
  const value = String(line || '').replace(/\s+/g,' ').trim().replace(/^[—–-]+|[—–-]+$/g,'');
  if (value.length < 2 || value.length > 100) return undefined;
  if (/[:;]/.test(value) || /\d{5,}/.test(value)) return undefined;
  if (!/[a-zA-Z]{2}/.test(value) || /^(?:https?:\/\/|www\.)/i.test(value)) return undefined;
  if (NON_ISSUER.test(value)) return undefined;
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
  const afterDate = /(?:Date (?:of issue|paid|due)|Invoice date|Billing date|Due date)[^\n]*\n([^\n]{1,120})\n?([^\n]{1,120})?\n?([^\n]{1,120})?/.exec(text);
  if (afterDate) candidates.push(afterDate[1], afterDate[2], afterDate[3]);
  const afterHeading = /^(?:Receipt|Invoice)\s*\n(?!Invoice number|Receipt number)([^\n]{1,120})\n/m.exec(text);
  if (afterHeading) candidates.push(afterHeading[1]);
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
const ISSUED_LABELS = /(?:invoice\s+date|date\s+of\s+issue|issue\s+date|billing\s+date|order\s+date|\bdate\b)[^\n]{0,30}?([^\n]{1,40})/i;
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
