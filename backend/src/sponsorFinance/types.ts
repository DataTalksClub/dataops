export type FinanceState = {
  id: string;
  recordType: 'sponsor-finance';
  bookingId: string;
  version: number;
  invoiceRequirement: 'required' | 'not-required';
  amountDue?: string;
  currency?: string;
  taxMode?: 'unknown' | 'included' | 'added' | 'not-applicable';
  taxAmount?: string;
  requestBy?: string;
  invoiceRequestedAt?: string;
  expectedInvoiceBy?: string;
  issuedOn?: string;
  dueOn?: string;
  invoiceLinkId?: string;
  paymentLinkIds: string[];
  voidedAt?: string;
  actorId: string;
  createdAt: string;
  updatedAt: string;
};

export type FinanceLink = {
  id: string;
  recordType: 'sponsor-finance-link';
  bookingId: string;
  kind: 'document' | 'transaction';
  sourceId: string;
  identityToken: string;
  actorId: string;
  financeVersion: number;
  createdAt: string;
};

export type FinanceProjection = {
  enabled: true;
  classified: boolean;
  bookingId: string;
  role: 'admin' | 'operator';
  finance?: {
    version: number;
    invoiceRequirement: 'required' | 'not-required';
    amountDue?: string;
    currency?: string;
    taxMode?: string;
    taxAmount?: string;
    requestBy?: string;
    invoiceRequestedAt?: string;
    expectedInvoiceBy?: string;
    issuedOn?: string;
    dueOn?: string;
    voidedAt?: string;
  };
  invoiceState: 'unclassified' | 'not-required' | 'to-request' | 'requested' | 'issued' | 'voided';
  paymentState: 'not-applicable' | 'unpaid' | 'partially-paid' | 'paid' | 'reconciliation-required';
  timingState: 'not-applicable' | 'not-due' | 'overdue' | 'settled';
  outstanding?: string;
  invoice?: { id: string; label: string; uploadedAt: string };
  payments: Array<{ id: string; effectiveDate: string; amount: string; currency: string }>;
  reconciliationStatus: 'coherent' | 'reconciliation-required';
  paymentLinkCount: number;
  paymentLinkLimit: number;
};
