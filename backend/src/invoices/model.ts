export interface InvoiceFields {
  transactionDate?: string; paidDate?: string; counterparty?: string; description?: string;
  amount?: string; currency?: string; amountEur?: string; statementRef?: string; comment?: string;
  quantity?: number; subtype?: string; period?: string; category?: string;
  paymentEvidence?: string; accountContext?: string; invoiceNumber?: string;
  archiveRequired?: boolean; archiveExceptionReason?: string;
}
export interface Destination {
  state: 'pending' | 'unknown' | 'verified' | 'blocked' | 'skipped';
  operationId: string; error?: string; reference?: string; reservedRow?: number;
}
export interface Invoice {
  id: string; revision: number; status: 'pending' | 'confirmed' | 'rejected';
  fields: InvoiceFields;
  extraction: { method: string; evidence: string[]; issues: string[] };
  source: { intakeItemIds: string[]; artifactId: string; checksum: string };
  destinations: { dropbox: Destination; sheets: Destination };
  audit: Array<{ action: string; actor: string; at: string; revision: number }>;
  createdAt: string; updatedAt: string; confirmedRevision?: number;
  verification?: { revision: number; actor: string; at: string; method: 'operator' };
  publicationBinding?: string; publicationError?: string; leaseOwner?: string; leaseUntil?: number; restoredNeedsReconciliation?: boolean;
}
const fields = new Set(['transactionDate','paidDate','counterparty','description','amount','currency','amountEur','statementRef','comment','quantity','subtype','period','category','paymentEvidence','accountContext','invoiceNumber','archiveRequired','archiveExceptionReason']);
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
    if (name === 'archiveRequired') { if (typeof child !== 'boolean') errors.push(name); }
    else if (name === 'quantity') { if (!Number.isSafeInteger(child) || Number(child) < 1) errors.push(name); }
    else if (typeof child !== 'string' || child.length > 500 || /[\x00-\x1f]/.test(child)) errors.push(name);
    else if (child && ['transactionDate','paidDate'].includes(name) && !date(child)) errors.push(name);
    else if (child && ['amount','amountEur'].includes(name) && !money(child)) errors.push(name);
    else if (child && name === 'currency' && !['USD','EUR'].includes(child)) errors.push(name);
  }
  return errors;
}
export function missingEvidence(f: InvoiceFields): string[] {
  const missing = ['counterparty','description','paymentEvidence','invoiceNumber','accountContext'].filter(k => !String(f[k as keyof InvoiceFields] || '').trim());
  if (!date(f.transactionDate)) missing.push('transactionDate');
  if (!date(f.paidDate)) missing.push('paidDate');
  if (!money(f.amount)) missing.push('amount');
  if (!money(f.amountEur)) missing.push('amountEur');
  if (!['USD','EUR'].includes(f.currency || '')) missing.push('currency');
  if (f.archiveRequired === false && !f.archiveExceptionReason?.trim()) missing.push('archiveExceptionReason');
  return missing;
}
export function publicInvoice(record: Invoice) {
  const { leaseOwner: _owner, leaseUntil: _until, ...safe } = record;
  return { ...safe, publicationPolicy: 'automatic-when-verified', verifiedRevision: record.verification?.revision, missingEvidence: missingEvidence(record.fields), publicationStatus: record.status !== 'confirmed' ? 'not-confirmed' : record.publicationError ? 'incomplete' : ['verified','skipped'].includes(record.destinations.dropbox.state) && record.destinations.sheets.state === 'verified' ? 'complete' : 'incomplete' };
}
