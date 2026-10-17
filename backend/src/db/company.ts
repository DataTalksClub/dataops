/**
 * DataTalks.Club company/vendor profile: the non-sensitive half of the
 * company details used in sponsor vendor onboarding (bill.com, AP portals,
 * W-8BEN-E style forms).
 *
 * Non-sensitive fields (legal name, registered address, VAT/tax IDs) live
 * here as one record in the Users table next to the workspace settings.
 * Bank details per account/currency are sensitive and live in the team
 * secrets store instead (`company-bank-<accountId>`); this module keeps only
 * their summaries (id, label, currency) so a profile read never decrypts
 * anything.
 */

import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { TABLE_USERS } from './tableNames';

const COMPANY_KEY = { PK: 'SETTINGS#company', SK: 'SETTINGS#company' } as const;

export interface RegisteredAddress {
  line1: string;
  line2?: string;
  city: string;
  postalCode: string;
  country: string;
}

export interface CompanyTax {
  vatId?: string;
  taxId?: string;
  /** W-8BEN-E chapter 3 entity status, e.g. "Active NFFE". */
  entityType?: string;
  countryOfIncorporation?: string;
}

export interface CompanyContact {
  email?: string;
  phone?: string;
}

/** Non-sensitive bank account metadata; values stay in the secrets store. */
export interface BankAccountSummary {
  id: string;
  label: string;
  currency: string;
  updatedAt: string;
  updatedBy: string;
}

export interface CompanyProfile {
  legalName: string | null;
  tradeName?: string;
  registeredAddress?: RegisteredAddress;
  tax?: CompanyTax;
  contact?: CompanyContact;
  bankAccounts: BankAccountSummary[];
  /** 0 until the record is first written. */
  version: number;
  updatedAt?: string;
  updatedBy?: string;
}

export class CompanyProfileConflictError extends Error {
  constructor(readonly expectedVersion: number) {
    super(`Company profile changed since version ${expectedVersion}`);
    this.name = 'CompanyProfileConflictError';
  }
}

export interface CompanyProfileChanges {
  legalName?: string | null;
  /** Null clears the trade name. */
  tradeName?: string | null;
  /** Null clears the registered address. */
  registeredAddress?: RegisteredAddress | null;
  /** Null clears the tax block. */
  tax?: CompanyTax | null;
  /** Null clears the contact block. */
  contact?: CompanyContact | null;
}

export async function getCompanyProfile(client: DynamoDBDocumentClient): Promise<CompanyProfile> {
  const result = await client.send(new GetCommand({
    TableName: TABLE_USERS,
    Key: COMPANY_KEY,
    ConsistentRead: true,
  }));
  const item = result.Item as Record<string, unknown> | undefined;
  if (!item) {
    return { legalName: null, bankAccounts: [], version: 0 };
  }
  const bankAccounts = Array.isArray(item.bankAccounts)
    ? (item.bankAccounts as Record<string, unknown>[])
      .filter((entry): entry is Record<string, string> =>
        !!entry && typeof entry.id === 'string' && typeof entry.label === 'string'
        && typeof entry.currency === 'string')
      .map((entry) => ({
        id: entry.id,
        label: entry.label,
        currency: entry.currency,
        updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : '',
        updatedBy: typeof entry.updatedBy === 'string' ? entry.updatedBy : '',
      }))
    : [];
  return {
    legalName: typeof item.legalName === 'string' && item.legalName ? item.legalName : null,
    ...(typeof item.tradeName === 'string' && item.tradeName ? { tradeName: item.tradeName } : {}),
    ...(isRecord(item.registeredAddress) ? { registeredAddress: item.registeredAddress as unknown as RegisteredAddress } : {}),
    ...(isRecord(item.tax) ? { tax: item.tax as unknown as CompanyTax } : {}),
    ...(isRecord(item.contact) ? { contact: item.contact as unknown as CompanyContact } : {}),
    bankAccounts,
    version: Number(item.version) || 0,
    ...(typeof item.updatedAt === 'string' ? { updatedAt: item.updatedAt } : {}),
    ...(typeof item.updatedBy === 'string' ? { updatedBy: item.updatedBy } : {}),
  };
}

/** Write `changes` over the current profile, if it is still at `expectedVersion`. */
export async function updateCompanyProfile(
  client: DynamoDBDocumentClient,
  input: { changes: CompanyProfileChanges; expectedVersion: number; actorId?: string },
): Promise<CompanyProfile> {
  const current = await getCompanyProfile(client);
  if (current.version !== input.expectedVersion) throw new CompanyProfileConflictError(input.expectedVersion);
  const next: CompanyProfile = {
    ...current,
    version: input.expectedVersion + 1,
    updatedAt: new Date().toISOString(),
    ...(input.actorId ? { updatedBy: input.actorId } : {}),
  };
  for (const [key, value] of Object.entries(input.changes)) {
    if (value === null) {
      if (key === 'legalName') next.legalName = null;
      else delete next[key as 'tradeName' | 'registeredAddress' | 'tax' | 'contact'];
    } else {
      (next as unknown as Record<string, unknown>)[key] = value;
    }
  }
  try {
    await client.send(new PutCommand({
      TableName: TABLE_USERS,
      Item: { ...COMPANY_KEY, ...next },
      ConditionExpression: input.expectedVersion === 0
        ? 'attribute_not_exists(PK)'
        : '#version = :expectedVersion',
      ...(input.expectedVersion === 0 ? {} : {
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: { ':expectedVersion': input.expectedVersion },
      }),
    }));
  } catch (error) {
    if ((error as { name?: string })?.name === 'ConditionalCheckFailedException') {
      throw new CompanyProfileConflictError(input.expectedVersion);
    }
    throw error;
  }
  return next;
}

/** Record (or refresh) one bank account's non-sensitive summary after its secret is written. */
export async function setBankAccountSummary(
  client: DynamoDBDocumentClient,
  input: { id: string; label: string; currency: string; updatedAt: string; actorId?: string },
): Promise<CompanyProfile> {
  const current = await getCompanyProfile(client);
  const summary: BankAccountSummary = {
    id: input.id,
    label: input.label,
    currency: input.currency,
    updatedAt: input.updatedAt,
    updatedBy: input.actorId || '',
  };
  const bankAccounts = [
    ...current.bankAccounts.filter((entry) => entry.id !== input.id),
    summary,
  ].sort((left, right) => left.id.localeCompare(right.id));
  const next: CompanyProfile = {
    ...current,
    bankAccounts,
    version: current.version + 1,
    updatedAt: new Date().toISOString(),
    ...(input.actorId ? { updatedBy: input.actorId } : {}),
  };
  await client.send(new PutCommand({
    TableName: TABLE_USERS,
    Item: { ...COMPANY_KEY, ...next },
  }));
  return next;
}

/** Drop one bank account's summary after its secret is deleted. */
export async function removeBankAccountSummary(
  client: DynamoDBDocumentClient,
  input: { id: string; actorId?: string },
): Promise<CompanyProfile> {
  const current = await getCompanyProfile(client);
  const next: CompanyProfile = {
    ...current,
    bankAccounts: current.bankAccounts.filter((entry) => entry.id !== input.id),
    version: current.version + 1,
    updatedAt: new Date().toISOString(),
    ...(input.actorId ? { updatedBy: input.actorId } : {}),
  };
  await client.send(new PutCommand({
    TableName: TABLE_USERS,
    Item: { ...COMPANY_KEY, ...next },
  }));
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
