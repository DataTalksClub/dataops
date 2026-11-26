// Ledger descriptions for extracted invoices. A description must say what was
// bought, in words the document itself prints. Anything generic, copied from a
// header, or not found in the document is dropped so review sees a blank rather
// than a plausible-looking guess.

const MAX_LENGTH = 120;
const GENERIC = /^(?:business\s+expenses?|expenses?|invoices?|receipts?|payments?|purchases?|orders?|services?|subscriptions?|products?|items?|charges?|fees?|credit\s+notes?|refunds?|documents?|statements?|bills?|misc(?:ellaneous)?|other|n\/?a|none|unknown|sponsor\s+payment(?:\s+for\s+deal\s+\S+)?|rechnung(?:en)?|rechnungsnummern?|quittung(?:en)?|bestellung(?:en)?|gutschrift(?:en)?|zahlung(?:en)?|belege?|factures?|fattur[ae]|facturas?|reçus?|recibos?|ricevut[ae])\.?$/i;
const GENERIC_WITH_NUMBER = /^(?:invoice|receipt|payment|order|credit\s+note|refund|bill|rechnung(?:s\s?nummer|snr\.?)?|quittung|bestellung|gutschrift|zahlung|beleg|facture|fattura|factura|reçu|recibo|ricevuta)\s*(?:no\.?|number|#|nr\.?)?\s*[:#]?\s*[A-Z0-9][A-Z0-9\-/._]*$/i;
const GENERIC_FROM_VENDOR = /^(?:invoice|receipt|payment|order|statement|subscription|charge)s?\s+(?:from|for|to)\s+.{0,60}$/i;

const norm = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

export type DescriptionContext = { counterparty?: string | null; invoiceNumber?: string | null };

/** The tidy description, or undefined when the value is empty or generic. */
export function cleanDescription(value: unknown, context: DescriptionContext = {}): string | undefined {
  const text = String(value ?? '').replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[\s,;:·–—-]+$/, '').trim();
  if (text.length < 3) return undefined;
  const clipped = text.length > MAX_LENGTH ? `${text.slice(0, MAX_LENGTH - 1).trimEnd()}…` : text;
  if (GENERIC.test(text) || GENERIC_WITH_NUMBER.test(text) || GENERIC_FROM_VENDOR.test(text)) return undefined;
  const key = norm(text);
  if (context.counterparty && key === norm(context.counterparty)) return undefined;
  if (context.invoiceNumber && key === norm(context.invoiceNumber)) return undefined;
  if (!/\p{L}{3}/u.test(text)) return undefined;
  return clipped;
}

const STOPWORDS = new Set(['with', 'from', 'that', 'this', 'plan', 'for', 'and', 'the', 'new', 'top']);
const words = (value: string) => value.toLowerCase().match(/\p{L}{3,}/gu)?.filter(word => !STOPWORDS.has(word)) || [];

/**
 * A description is grounded when at least one distinctive word of it is printed
 * in the document. Documents with no usable text layer (scans read by the
 * vision reader) cannot be checked, so they pass.
 */
export function groundedInDocument(description: string, documentText: string): boolean {
  if (documentText.replace(/\s/g, '').length < 100) return true;
  const haystack = documentText.toLowerCase();
  const candidates = words(description);
  return candidates.length === 0 || candidates.some(word => haystack.includes(word));
}

const AMOUNT_TAIL = /\s+(?:\d+(?:[.,]\d+)?\s+)?(?:[$€£]|USD|EUR|GBP)\s*[\d.,]+(?:\s+.*)?$|\s+\d+\s+\d[\d.,]*[.,]\d{2}(?:\s.*)?$/;
const PERIOD = /^(?:[A-Z][a-z]{2,8}\.?\s+\d{1,2}(?:,\s*\d{4})?\s*[–—-]\s*[A-Z][a-z]{2,8}\.?\s+\d{1,2},?\s*\d{4}|\d{1,2}\.\d{1,2}\.\d{4}\s*[–—-]\s*\d{1,2}\.\d{1,2}\.\d{4})$/;
const TABLE_STOP = /^(?:Subtotal|Total|Amount\s+(?:due|paid)|Tax|VAT|Discount|Page\s+\d|Payment\s+history|Applied\s+balance)\b/i;
const TABLE_HEADER = /^(?:Description|Item|Beschreibung|Position)\b.*\b(?:Qty|Quantity|Menge|Unit\s+price|Amount|Betrag)\b/i;

/**
 * The first purchased line item of a Stripe-style table: its name plus the
 * billed period printed under it. Undefined when the layout has no such table.
 */
export function lineItemDescription(rawText: string): string | undefined {
  const lines = rawText.replace(/\u0000/g, '-').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const header = lines.findIndex(line => TABLE_HEADER.test(line));
  if (header < 0) return undefined;
  const body: string[] = [];
  for (const line of lines.slice(header + 1)) {
    if (TABLE_STOP.test(line)) break;
    body.push(line);
  }
  const first = body[0]?.replace(AMOUNT_TAIL, '').trim();
  const name = cleanDescription(first);
  if (!name) return undefined;
  const period = body.slice(1, 3).map(line => line.replace(AMOUNT_TAIL, '').trim()).find(line => PERIOD.test(line));
  return period ? `${name}, ${period}` : name;
}

const OVERVIEW_HEADER = /^Service\s+Period\b/i;
// A service row ends in an amount; its name ends at the first column break,
// which is a wide gap or a space before a period or an amount.
const OVERVIEW_ROW = /^(.+?)(?:\s{2,}|\s+(?=[€$£]\s*\d|\d{1,2}\/\d{1,2}\b|\d[\d.,]*[.,]\d{2}\b)).*\d[.,]\d{2}\b/;
const OVERVIEW_STOP = /^(?:Total|Subtotal)\b/i;

/**
 * The services named one per row in the "Service / Period / Total" overview
 * table of a Hetzner-style invoice. Undefined when the layout has no such
 * table. Only rows that carry an amount count, so page footers between the
 * rows are never read as a service.
 */
export function serviceOverviewDescription(rawText: string, context: DescriptionContext = {}): string | undefined {
  const lines = rawText.replace(/\u0000/g, '-').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const header = lines.findIndex(line => OVERVIEW_HEADER.test(line));
  if (header < 0) return undefined;
  const names: string[] = [];
  for (const line of lines.slice(header + 1)) {
    if (OVERVIEW_STOP.test(line)) break;
    const row = OVERVIEW_ROW.exec(line);
    const name = row && cleanDescription(row[1], context);
    if (name && !names.includes(name)) names.push(name);
  }
  if (!names.length) return undefined;
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
