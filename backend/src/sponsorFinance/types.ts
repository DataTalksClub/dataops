export const WAITING_PARTIES = ['us', 'sponsor'] as const;
export const WAITING_REASONS = [
  'billing-details',
  'payment-details',
  'payment-link',
  'vendor-onboarding',
  'purchase-order',
  'approval',
  'invoice',
  'other',
] as const;
export const EVIDENCE_KINDS = ['email', 'document', 'ledger', 'url', 'note'] as const;
export const RECORDED_PAYMENT_METHODS = ['bank-report', 'sponsor-confirmation', 'processor', 'other'] as const;

export type WaitingOn = {
  party: (typeof WAITING_PARTIES)[number];
  reason: (typeof WAITING_REASONS)[number];
  since: string;
  note?: string;
};

export type FinanceEvidence = {
  kind: (typeof EVIDENCE_KINDS)[number];
  ref: string;
  label?: string;
  on?: string;
};

export type FinanceState = {
  id: string;
  recordType: 'sponsor-finance';
  dealId: string;
  version: number;
  invoiceRequirement: 'required' | 'not-required';
  amountDue?: string;
  currency?: string;
  taxMode?: 'unknown' | 'included' | 'added' | 'not-applicable';
  taxAmount?: string;
  requestBy?: string;
  invoiceRequestedAt?: string;
  expectedInvoiceBy?: string;
  invoiceNumber?: string;
  issuedOn?: string;
  sentOn?: string;
  dueOn?: string;
  invoiceLinkId?: string;
  paymentLinkIds: string[];
  recordedPaymentIds: string[];
  waitingOn?: WaitingOn;
  evidence?: FinanceEvidence[];
  /** Payment chase Tasks created for this deal's money; open ones throttle re-creation. */
  chaseTaskIds: string[];
  voidedAt?: string;
  actorId: string;
  createdAt: string;
  updatedAt: string;
};

export type FinanceLink = {
  id: string;
  recordType: 'sponsor-finance-link';
  dealId: string;
  kind: 'document' | 'transaction';
  sourceId: string;
  identityToken: string;
  actorId: string;
  financeVersion: number;
  createdAt: string;
};

/** Cash the ledger has not caught up with yet (accountant report, sponsor confirmation, processor payout). */
export type RecordedPayment = {
  id: string;
  recordType: 'sponsor-finance-payment';
  dealId: string;
  paymentId: string;
  receivedOn: string;
  amount: string;
  currency: string;
  method: (typeof RECORDED_PAYMENT_METHODS)[number];
  reference?: string;
  actorId: string;
  financeVersion: number;
  createdAt: string;
};

export type FinancePayment = {
  id: string;
  effectiveDate: string;
  amount: string;
  currency: string;
  source: 'ledger' | 'recorded';
  method?: RecordedPayment['method'];
  reference?: string;
};

export type FollowUpCode =
  | 'classify'
  | 'send-invoice'
  | 'unblock'
  | 'chase-payment'
  | 'reconcile'
  | 'await-sponsor'
  | 'await-payment'
  | 'invoice-later'
  | 'none';

export type FollowUp = {
  code: FollowUpCode;
  party: 'us' | 'sponsor' | 'none';
  since?: string;
  reason?: WaitingOn['reason'];
  daysOverdue?: number;
};

export type InvoiceState = 'unclassified' | 'not-required' | 'to-request' | 'requested' | 'issued' | 'voided';
export type PaymentState = 'not-applicable' | 'unpaid' | 'partially-paid' | 'paid' | 'reconciliation-required';
export type TimingState = 'not-applicable' | 'not-due' | 'overdue' | 'settled';

/** An open payment chase Task as the finance projection shows it. */
export type ChaseTaskView = {
  id: string;
  description: string;
  date: string;
  status: 'todo' | 'waiting';
  followUpAt?: string;
  assigneeId?: string;
};

export type FinanceProjection = {
  enabled: true;
  classified: boolean;
  dealId: string;
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
    invoiceNumber?: string;
    issuedOn?: string;
    sentOn?: string;
    dueOn?: string;
    waitingOn?: WaitingOn;
    evidence?: FinanceEvidence[];
    voidedAt?: string;
  };
  invoiceState: InvoiceState;
  paymentState: PaymentState;
  timingState: TimingState;
  outstanding?: string;
  paid?: string;
  daysOverdue?: number;
  lastPaymentOn?: string;
  invoice?: { id: string; label: string; uploadedAt: string };
  payments: FinancePayment[];
  followUp: FollowUp;
  reconciliationStatus: 'coherent' | 'reconciliation-required';
  paymentLinkCount: number;
  paymentLinkLimit: number;
  /** Open payment chase Tasks in the main task pool, attached at the route layer. */
  chase?: { tasks: ChaseTaskView[] };
};
