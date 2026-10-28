/**
 * `/api/company`: DataTalks.Club company/vendor details for sponsor vendor
 * onboarding (bill.com, AP portals, W-8BEN-E style forms).
 *
 * Every route is admin-only. The profile (legal name, registered address,
 * VAT/tax IDs) is non-sensitive and lives in the Users table. Bank details
 * per account/currency are sensitive: each account lives as one secret
 * (`company-bank-<id>`) in the team secrets store, so every bank read and
 * write is KMS-encrypted and audited exactly like `dataops secrets`.
 *
 * Values never appear in error bodies or in the default profile read: bank
 * values are returned only to explicit bank reads (`?section=bank`,
 * `GET /api/company/bank[/:id]`).
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import {
  CompanyProfileConflictError,
  getCompanyProfile,
  removeBankAccountSummary,
  setBankAccountSummary,
  updateCompanyProfile,
  type CompanyContact,
  type CompanyProfileChanges,
  type CompanyTax,
  type RegisteredAddress,
} from '../db/company';
import { deleteSecret, getSecret, putSecret } from '../db/secrets';
import { getUser } from '../db/users';
import { MAX_PAYLOAD_BYTES, resolveSecretCipher } from '../secrets/cipher';
import { recordRequestError } from '../requestErrorLog';
import type { LambdaEvent, LambdaResponse } from '../types';
import { headerValue } from '../httpHeaders';

const JSON_HEADERS: Record<string, string> = { 'Content-Type': 'application/json' };

const ACCOUNT_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const FIELD_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const CURRENCY = /^[A-Z]{3}$/;
const MAX_DETAILS = 30;
const MAX_FIELD_VALUE_CHARS = 4096;
/** Leave headroom under the KMS 4 KiB plaintext cap for the JSON envelope. */
const MAX_PAYLOAD_JSON_BYTES = MAX_PAYLOAD_BYTES - 512;

const ADDRESS_KEYS = new Set(['line1', 'line2', 'city', 'postalCode', 'country']);
const TAX_KEYS = new Set(['vatId', 'taxId', 'entityType', 'countryOfIncorporation']);
const CONTACT_KEYS = new Set(['email', 'phone']);

export async function handleCompanyRoutes(
  path: string,
  method: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse | null> {
  if (!path.startsWith('/api/company')) return null;

  const gate = await requireAdmin(client, event);
  if (!gate.ok) return gate.response;

  const suffix = path.slice('/api/company'.length);
  try {
    if (suffix === '' || suffix === '/') {
      if (method === 'GET') return await handleShow(event, client);
      if (method === 'PUT') return await handleSet(event, client, gate.actorId);
      return methodNotAllowed();
    }

    if (suffix === '/bank' || suffix === '/bank/') {
      if (method === 'GET') return await handleBankList(client, gate.actorId);
      return methodNotAllowed();
    }

    const accountMatch = suffix.match(/^\/bank\/([^/]+)\/?$/);
    if (accountMatch) {
      const id = decodeURIComponent(accountMatch[1]);
      if (!ACCOUNT_ID.test(id)) return invalidAccountId();
      if (method === 'GET') return await handleBankGet(client, gate.actorId, id);
      if (method === 'PUT') return await handleBankPut(event, client, gate.actorId, id);
      if (method === 'DELETE') return await handleBankDelete(client, gate.actorId, id);
      return methodNotAllowed();
    }

    return json(404, { error: 'Not found' });
  } catch (error: unknown) {
    if (error instanceof CompanyInputError) return json(400, { error: error.message });
    if (error instanceof CompanyProfileConflictError) {
      return json(409, {
        error: 'Company profile changed since you read it; reload and try again',
        code: 'version_conflict',
        current: await getCompanyProfile(client),
      });
    }
    recordRequestError(error);
    return json(500, { error: 'Internal server error' });
  }
}

/**
 * Only `admin` users touch company details. Reads are gated too: bank
 * summaries name real accounts, and bank reads decrypt audited secrets.
 */
async function requireAdmin(
  client: DynamoDBDocumentClient,
  event: LambdaEvent,
): Promise<{ ok: true; actorId: string } | { ok: false; response: LambdaResponse }> {
  const actorId = headerValue(event.headers, 'x-user-id');
  const user = actorId ? await getUser(client, actorId) : null;
  if (!user || user.role !== 'admin' || user.disabled) {
    return { ok: false, response: json(403, { error: 'Admin access required' }) };
  }
  return { ok: true, actorId: user.id };
}

/** Default read: the profile plus bank summaries (ids, labels, currencies — never values). */
async function handleShow(event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  const section = event.queryStringParameters?.section;
  if (section !== undefined && section !== 'bank' && section !== 'tax' && section !== 'address') {
    throw new CompanyInputError('section must be one of bank, tax, address');
  }
  const profile = await getCompanyProfile(client);
  if (section === 'bank') return await handleBankList(client, headerValue(event.headers, 'x-user-id'));
  if (section === 'tax') return json(200, { company: { tax: profile.tax ?? null, version: profile.version } });
  if (section === 'address') {
    return json(200, { company: { registeredAddress: profile.registeredAddress ?? null, version: profile.version } });
  }
  return json(200, { company: profile });
}

async function handleSet(event: LambdaEvent, client: DynamoDBDocumentClient, actorId: string): Promise<LambdaResponse> {
  const body = parseBody(event.body ?? null);
  const expectedVersion = body.expectedVersion;
  if (!Number.isInteger(expectedVersion) || Number(expectedVersion) < 0) {
    throw new CompanyInputError('expectedVersion must be the profile version you read (0 before the first save)');
  }
  const { expectedVersion: _ignored, ...requested } = body;
  const allowed = new Set(['legalName', 'tradeName', 'registeredAddress', 'tax', 'contact']);
  const unknown = Object.keys(requested).find((name) => !allowed.has(name));
  if (unknown) throw new CompanyInputError(`Unknown field '${unknown}'; send legalName, tradeName, registeredAddress, tax, contact`);
  if (Object.keys(requested).length === 0) throw new CompanyInputError('Name a field to change');
  const changes: CompanyProfileChanges = {};
  if (Object.hasOwn(requested, 'legalName')) {
    const value = requested.legalName;
    if (value !== null && (typeof value !== 'string' || !value.trim() || value.length > 200)) {
      throw new CompanyInputError('legalName must be a non-empty string of at most 200 characters, or null to clear');
    }
    changes.legalName = value === null ? null : (value as string).trim();
  }
  if (Object.hasOwn(requested, 'tradeName')) {
    const value = requested.tradeName;
    if (value !== null && (typeof value !== 'string' || !value.trim() || value.length > 200)) {
      throw new CompanyInputError('tradeName must be a non-empty string of at most 200 characters, or null to clear');
    }
    changes.tradeName = value === null ? null : (value as string).trim();
  }
  if (Object.hasOwn(requested, 'registeredAddress')) {
    changes.registeredAddress = parseAddress(requested.registeredAddress);
  }
  if (Object.hasOwn(requested, 'tax')) {
    changes.tax = parseTax(requested.tax);
  }
  if (Object.hasOwn(requested, 'contact')) {
    changes.contact = parseContact(requested.contact);
  }
  const company = await updateCompanyProfile(client, {
    changes,
    expectedVersion: Number(expectedVersion),
    actorId,
  });
  return json(200, { company });
}

/** Every bank account with decrypted values. Each read is audited by the secrets store. */
async function handleBankList(client: DynamoDBDocumentClient, actorId: string): Promise<LambdaResponse> {
  const profile = await getCompanyProfile(client);
  const cipher = resolveSecretCipher();
  const accounts = [];
  for (const summary of profile.bankAccounts) {
    const secret = await getSecret(client, cipher, bankSecretName(summary.id), actorId);
    if (!secret) continue;
    accounts.push(splitAccount(summary.id, secret.fields));
  }
  return json(200, { accounts, version: profile.version });
}

async function handleBankGet(client: DynamoDBDocumentClient, actorId: string, id: string): Promise<LambdaResponse> {
  const cipher = resolveSecretCipher();
  const secret = await getSecret(client, cipher, bankSecretName(id), actorId);
  if (!secret) return json(404, { error: `Bank account '${id}' does not exist` });
  return json(200, { account: splitAccount(id, secret.fields) });
}

async function handleBankPut(
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
  actorId: string,
  id: string,
): Promise<LambdaResponse> {
  const body = parseBody(event.body ?? null);
  const { label, currency, details } = parseBankBody(body);
  const cipher = resolveSecretCipher();
  const meta = await putSecret(client, cipher, {
    name: bankSecretName(id),
    fields: { label, currency, ...details },
    actorId,
  });
  const company = await setBankAccountSummary(client, {
    id,
    label,
    currency,
    updatedAt: meta.updatedAt,
    actorId,
  });
  const summary = company.bankAccounts.find((entry) => entry.id === id);
  return json(200, { account: summary });
}

async function handleBankDelete(client: DynamoDBDocumentClient, actorId: string, id: string): Promise<LambdaResponse> {
  const existed = await deleteSecret(client, bankSecretName(id), actorId);
  if (!existed) return json(404, { error: `Bank account '${id}' does not exist` });
  await removeBankAccountSummary(client, { id, actorId });
  return json(200, { deleted: true, id });
}

function bankSecretName(id: string): string {
  return `company-bank-${id}`;
}

/** Split a bank secret's flat fields back into metadata plus sensitive details. */
function splitAccount(id: string, fields: Record<string, string>): {
  id: string; label: string; currency: string; details: Record<string, string>;
} {
  const { label = '', currency = '', ...details } = fields;
  return { id, label, currency, details };
}

function parseBody(rawBody: string | null): Record<string, unknown> {
  if (!rawBody) throw new CompanyInputError('A JSON body is required');
  try {
    const parsed = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new CompanyInputError('Body must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof CompanyInputError) throw error;
    throw new CompanyInputError('Body is not valid JSON');
  }
}

function parseAddress(value: unknown): RegisteredAddress | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CompanyInputError('registeredAddress must be an object, or null to clear');
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).find((key) => !ADDRESS_KEYS.has(key));
  if (unknown) throw new CompanyInputError(`Unknown address field '${unknown}'`);
  const line1 = record.line1;
  const city = record.city;
  const postalCode = record.postalCode;
  const country = record.country;
  for (const [key, field] of [['line1', line1], ['city', city], ['postalCode', postalCode], ['country', country]] as const) {
    if (typeof field !== 'string' || !field.trim() || field.length > 100) {
      throw new CompanyInputError(`${key} must be a non-empty string of at most 100 characters`);
    }
  }
  if ((line1 as string).length > 200) throw new CompanyInputError('line1 must be at most 200 characters');
  const address: RegisteredAddress = {
    line1: (line1 as string).trim(),
    city: (city as string).trim(),
    postalCode: (postalCode as string).trim(),
    country: (country as string).trim(),
  };
  if (record.line2 !== undefined) {
    if (typeof record.line2 !== 'string' || record.line2.length > 200) {
      throw new CompanyInputError('line2 must be a string of at most 200 characters');
    }
    if (record.line2.trim()) address.line2 = record.line2.trim();
  }
  return address;
}

function parseTax(value: unknown): CompanyTax | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CompanyInputError('tax must be an object, or null to clear');
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).find((key) => !TAX_KEYS.has(key));
  if (unknown) throw new CompanyInputError(`Unknown tax field '${unknown}'`);
  const tax: CompanyTax = {};
  for (const key of TAX_KEYS) {
    const field = record[key];
    if (field === undefined) continue;
    if (typeof field !== 'string' || !field.trim() || field.length > 100) {
      throw new CompanyInputError(`${key} must be a non-empty string of at most 100 characters`);
    }
    (tax as Record<string, string>)[key] = field.trim();
  }
  if (Object.keys(tax).length === 0) throw new CompanyInputError('tax must name at least one id');
  return tax;
}

function parseContact(value: unknown): CompanyContact | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CompanyInputError('contact must be an object, or null to clear');
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).find((key) => !CONTACT_KEYS.has(key));
  if (unknown) throw new CompanyInputError(`Unknown contact field '${unknown}'`);
  const contact: CompanyContact = {};
  for (const key of CONTACT_KEYS) {
    const field = record[key];
    if (field === undefined) continue;
    if (typeof field !== 'string' || !field.trim() || field.length > 200) {
      throw new CompanyInputError(`${key} must be a non-empty string of at most 200 characters`);
    }
    (contact as Record<string, string>)[key] = field.trim();
  }
  if (Object.keys(contact).length === 0) throw new CompanyInputError('contact must name at least one channel');
  return contact;
}

function parseBankBody(body: Record<string, unknown>): { label: string; currency: string; details: Record<string, string> } {
  const unknown = Object.keys(body).find((key) => key !== 'label' && key !== 'currency' && key !== 'details');
  if (unknown) throw new CompanyInputError(`Unknown body field '${unknown}'; send { label, currency, details }`);
  const { label, currency, details } = body;
  if (typeof label !== 'string' || !label.trim() || label.length > 120) {
    throw new CompanyInputError('label must be a non-empty string of at most 120 characters');
  }
  if (typeof currency !== 'string' || !CURRENCY.test(currency)) {
    throw new CompanyInputError('currency must be a 3-letter ISO code like EUR or USD');
  }
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    throw new CompanyInputError('details must be an object of string values (IBAN, BIC, accountNumber, routingNumber, ...)');
  }
  const entries = Object.entries(details as Record<string, unknown>);
  if (entries.length === 0) throw new CompanyInputError('details must contain at least one entry');
  if (entries.length > MAX_DETAILS) throw new CompanyInputError(`A bank account holds at most ${MAX_DETAILS} detail fields`);
  const result: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!FIELD_KEY.test(key)) {
      throw new CompanyInputError(`Detail name '${key.slice(0, 16)}' is invalid: use letters, digits, '_', '.', '-' starting with a letter`);
    }
    if (typeof value !== 'string' || !value) {
      throw new CompanyInputError(`Detail '${key}' must be a non-empty string`);
    }
    if (value.length > MAX_FIELD_VALUE_CHARS) {
      throw new CompanyInputError(`Detail '${key}' exceeds ${MAX_FIELD_VALUE_CHARS} characters`);
    }
    result[key] = value;
  }
  const payload = { label: label.trim(), currency, ...result };
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_PAYLOAD_JSON_BYTES) {
    throw new CompanyInputError('Bank details are too large for encrypted storage');
  }
  return { label: label.trim(), currency, details: result };
}

class CompanyInputError extends Error {}

function invalidAccountId(): LambdaResponse {
  return json(400, { error: 'Bank account ids are 1-32 characters of lowercase letters, digits, "_", "-"' });
}

function methodNotAllowed(): LambdaResponse {
  return json(405, { error: 'Method not allowed' });
}

function json(statusCode: number, body: unknown): LambdaResponse {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}
