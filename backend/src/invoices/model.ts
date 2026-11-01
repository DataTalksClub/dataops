export interface InvoiceFields {
  netAmount?: string; vatAmount?: string; vatCurrency?: string; vatRate?: string; reverseCharge?: boolean;
  grossAmountEur?: string; netAmountEur?: string; vatAmountEur?: string; exchangeRate?: string; exchangeRateDate?: string; exchangeRateSource?: string;
  transactionDate?: string; paidDate?: string; counterparty?: string; description?: string;
  amount?: string; currency?: string; amountEur?: string; statementRef?: string; comment?: string;
  quantity?: number; subtype?: string; period?: string; category?: string;
  paymentEvidence?: string; accountContext?: string; invoiceNumber?: string; vatId?: string;
  archiveRequired?: boolean; archiveExceptionReason?: string;
}
export const BLANK_CONVERSION_ISSUE = 'Blank conversion — original needed';
export interface Destination {
  state: 'pending' | 'unknown' | 'verified' | 'blocked' | 'skipped';
  operationId: string; error?: string; reference?: string; reservedRow?: number;
}
export interface Invoice {
  id: string; revision: number; status: 'pending' | 'confirmed' | 'rejected';
  fields: InvoiceFields;
  // A credit note is published as income (subtype Refund) keyed
  // credit-note:<number>. needsReview with candidates: the amount was
  // ambiguous and left empty.
  extraction: { method: string; evidence: string[]; issues: string[]; documentType?: 'invoice' | 'receipt' | 'credit_note' | 'other'; direction?: 'income' | 'expense'; paymentChannel?: string; needsReview?: boolean; candidates?: string[]; blankConversion?: boolean };
  // The ledger row this record is booked as when it is not its own row
  // (a credit note already recorded under the same credit-note:<number>).
  ledgerTransactionId?: string;
  source: { intakeItemIds: string[]; artifactId: string; checksum: string };
  destinations: { dropbox: Destination; sheets: Destination };
  audit: Array<{ action: string; actor: string; at: string; revision: number; oldDocument?: { artifactId: string; checksum: string }; newDocument?: { artifactId: string; checksum: string }; reextracted?: boolean }>;
  createdAt: string; updatedAt: string; confirmedRevision?: number;
  verification?: { revision: number; actor: string; at: string; method: 'operator' };
  publicationBinding?: string; publicationError?: string; leaseOwner?: string; leaseUntil?: number; restoredNeedsReconciliation?: boolean;
}
const fields = new Set(['netAmount','vatAmount','vatCurrency','vatRate','reverseCharge','grossAmountEur','netAmountEur','vatAmountEur','exchangeRate','exchangeRateDate','exchangeRateSource','transactionDate','paidDate','counterparty','description','amount','currency','amountEur','statementRef','comment','quantity','subtype','period','category','paymentEvidence','accountContext','invoiceNumber','vatId','archiveRequired','archiveExceptionReason']);
const currencies = new Set(Intl.supportedValuesOf('currency'));
export function validCurrency(value: string): boolean { return currencies.has(value); }
export function date(value: unknown): boolean {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
}
export function money(value: unknown): boolean { return typeof value === 'string' && /^(0|[1-9]\d{0,9})(\.\d{1,2})?$/.test(value) && Number(value) > 0; }
export function validateFields(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['fields'];
  const errors: string[] = [];
  for (const [name, child] of Object.entries(value)) {
    if (!fields.has(name)) { errors.push(name); continue; }
    if (child === null && ['amount','amountEur','quantity'].includes(name)) continue;
    if (['archiveRequired','reverseCharge'].includes(name)) { if (typeof child !== 'boolean') errors.push(name); }
    else if (name === 'quantity') { if (!Number.isSafeInteger(child) || Number(child) < 1) errors.push(name); }
    else if (typeof child !== 'string' || child.length > 500 || /[\x00-\x1f]/.test(child)) errors.push(name);
    else if (child && ['transactionDate','paidDate','exchangeRateDate'].includes(name) && !date(child)) errors.push(name);
    else if (child && ['amount','amountEur'].includes(name) && !money(child)) errors.push(name);
    else if (child && ['currency','vatCurrency'].includes(name) && !validCurrency(child)) errors.push(name);
    else if (child && ['netAmount','vatAmount','grossAmountEur','netAmountEur','vatAmountEur'].includes(name) && !/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/.test(child)) errors.push(name);
    else if (child && name === 'vatRate' && (!/^\d{1,2}(\.\d{1,2})?$/.test(child) || Number(child)>50)) errors.push(name);
    else if (child && name === 'exchangeRate' && (!/^\d+(\.\d+)?$/.test(child) || Number(child)<=0)) errors.push(name);
  }
  return errors;
}
export function missingEvidence(f: InvoiceFields): string[] {
  const missing = ['counterparty','description','paymentEvidence','invoiceNumber','accountContext'].filter(k => !String(f[k as keyof InvoiceFields] || '').trim());
  if (!date(f.transactionDate)) missing.push('transactionDate');
  if (!date(f.paidDate)) missing.push('paidDate');
  if (!money(f.amount)) missing.push('amount');
  if (!money(f.amountEur)) missing.push('amountEur');
  if (!validCurrency(f.currency || '')) missing.push('currency');
  if (f.archiveRequired === false && !f.archiveExceptionReason?.trim()) missing.push('archiveExceptionReason');
  return missing;
}
export function invoiceDuplicateKey(record: Pick<Invoice, 'fields'>): string | undefined {
  const vendor = record.fields.counterparty?.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase().replace(/\s+gmbh\.?$/, '').trim();
  const number = record.fields.invoiceNumber?.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  return vendor && number ? `${vendor}\n${number}` : undefined;
}
export function duplicateInvoiceIds(record: Invoice, records: Invoice[]): string[] {
  const key = invoiceDuplicateKey(record);
  if (!key) return [];
  return records.filter(other => other.id !== record.id && invoiceDuplicateKey(other) === key).map(other => other.id).sort();
}
export function publicInvoice(record: Invoice, duplicateIds: string[] = []) {
  const { leaseOwner: _owner, leaseUntil: _until, ...safe } = record;
  return { ...safe, duplicateInvoiceIds: duplicateIds, publicationPolicy: 'automatic-when-verified', verifiedRevision: record.verification?.revision, missingEvidence: missingEvidence(record.fields), publicationStatus: record.status !== 'confirmed' ? 'not-confirmed' : record.publicationError ? 'incomplete' : ['verified','skipped'].includes(record.destinations.dropbox.state) && record.destinations.sheets.state === 'verified' ? 'complete' : 'incomplete' };
}
