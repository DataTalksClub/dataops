import { realDate } from '../sponsorCrm/model';

export const CONTRACT_STATUSES = ['draft', 'sent', 'viewed', 'signed', 'declined'] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];
export const SIGNING_ORDERS = ['sponsor-first', 'counter-first'] as const;
export type SigningOrder = (typeof SIGNING_ORDERS)[number];
/** eIDAS leaves these B2B contracts at a Simple Electronic Signature. */
export const MIN_LEAD_TIME_DAYS = 30;
export const DE_VAT_RATE = 19;
export const DEFAULT_TOKEN_TTL_DAYS = 14;
export const CONTRACT_EMAIL_FROM = 'orin@datatalks.club';

export interface ContractTerms {
  company: string;
  legalPayer: string;
  payerCountry: string;
  scope: string;
  priceEur: number;
  currency: string;
  startDate: string;
  endDate: string;
  signingOrder: SigningOrder;
}

export interface ContractSigner {
  role: 'sponsor' | 'counter';
  name: string;
  email: string;
  order: number;
  tokenHash?: string;
  tokenExpiresAt?: string;
  emailSentTo?: string;
  viewedAt?: string;
  signedAt?: string;
  declinedAt?: string;
  ip?: string;
  userAgent?: string;
}

export interface StoredPdf {
  storageProvider: 's3' | 'local-dev';
  storagePath: string;
  storageUri: string;
}

export interface SignedPdf extends StoredPdf { sha256: string }

export interface ContractRecord {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  dealId: string;
  organizationId: string;
  status: ContractStatus;
  terms: ContractTerms;
  signers: ContractSigner[];
  sentAt?: string;
  viewedAt?: string;
  signedAt?: string;
  declinedAt?: string;
  draftPdf?: StoredPdf;
  signedPdf?: SignedPdf;
}

/** EU member states (2026): reverse charge applies to EU business customers outside DE. */
const EU_COUNTRIES = new Set(['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE']);

export interface VatRule { rate: number; apply: boolean; reverseCharge: boolean }
/** VAT rule DE-only: German payers pay 19 percent VAT; other EU business
 * customers fall under reverse charge; non-EU payers are outside the scope. */
export function vatRuleFor(payerCountry: string): VatRule {
  const country = String(payerCountry || '').toUpperCase();
  if (country === 'DE') return { rate: DE_VAT_RATE, apply: true, reverseCharge: false };
  return { rate: 0, apply: false, reverseCharge: EU_COUNTRIES.has(country) };
}

export interface ValidatedTerms { error?: string; terms?: ContractTerms }
/** Validates contract terms from untrusted input. The today argument anchors
 * the minimum lead time between signing and the first deliverable date. */
export function validateContractTerms(input: unknown, today: string): ValidatedTerms {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'Invalid contract terms' };
  const raw = input as Record<string, unknown>;
  const string_ = (name: string, max: number) => {
    const value = raw[name];
    if (typeof value !== 'string' || !value.trim() || value.length > max) return undefined;
    return value.trim();
  };
  const company = string_('company', 200);
  const legalPayer = string_('legalPayer', 200);
  const scope = string_('scope', 4000);
  const payerCountry = typeof raw.payerCountry === 'string' ? raw.payerCountry.trim().toUpperCase() : '';
  const currency = (typeof raw.currency === 'string' && raw.currency.trim() ? raw.currency.trim().toUpperCase() : 'EUR');
  const startDate = raw.startDate, endDate = raw.endDate;
  const priceEur = raw.priceEur;
  const signingOrder = raw.signingOrder === 'counter-first' ? 'counter-first' : 'sponsor-first';
  if (!company) return { error: 'company is required (max 200 chars)' };
  if (!legalPayer) return { error: 'legalPayer is required (max 200 chars)' };
  if (!scope) return { error: 'scope is required (max 4000 chars)' };
  if (!/^[A-Z]{2}$/.test(payerCountry)) return { error: 'payerCountry must be a two-letter country code' };
  if (!['EUR', 'USD', 'GBP'].includes(currency)) return { error: 'currency must be EUR, USD or GBP' };
  if (typeof priceEur !== 'number' || !Number.isFinite(priceEur) || priceEur <= 0 || priceEur > 10000000) return { error: 'priceEur must be a positive amount' };
  if (!realDate(startDate)) return { error: 'startDate must be a YYYY-MM-DD date' };
  if (!realDate(endDate)) return { error: 'endDate must be a YYYY-MM-DD date' };
  if (String(startDate) >= String(endDate)) return { error: 'startDate must be before endDate' };
  const leadMs = Date.parse(startDate + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z');
  if (!Number.isFinite(leadMs) || leadMs < MIN_LEAD_TIME_DAYS * 86400000) return { error: 'Contracts need at least ' + MIN_LEAD_TIME_DAYS + ' days lead time before the start date' };
  const terms: ContractTerms = { company, legalPayer, payerCountry, scope, priceEur, currency, startDate: String(startDate), endDate: String(endDate), signingOrder };
  return { terms };
}

export function publicContract(contract: Record<string, any>) {
  const { signers, ...rest } = contract;
  return {
    ...rest,
    signers: (signers || []).map((signer: any) => ({
      role: signer.role, name: signer.name, email: signer.email, order: signer.order,
      ...(signer.tokenExpiresAt ? { tokenExpiresAt: signer.tokenExpiresAt } : {}),
      ...(signer.emailSentTo ? { emailSentTo: signer.emailSentTo } : {}),
      ...(signer.viewedAt ? { viewedAt: signer.viewedAt } : {}),
      ...(signer.signedAt ? { signedAt: signer.signedAt } : {}),
      ...(signer.declinedAt ? { declinedAt: signer.declinedAt } : {}),
    })),
  };
}
