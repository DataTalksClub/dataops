import { createHash, timingSafeEqual } from 'crypto';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { deterministicCrmId, getCrmRecord, listCrmRecords, updateCrmRecord, type CrmRecord } from '../db/sponsorCrm';
import { convertLead } from '../sponsorCrm/convertLead';
import { recordInboxIssue } from '../sponsorCrm/newsletterIssues';
import { TABLE_AUDIT_EVENTS, TABLE_SPONSOR_CRM } from '../db/tableNames';
import type { LambdaEvent, LambdaResponse } from '../types';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const CONTRACT_VERSION = '2026-10-10';
const MAX_SPONSORS = 20;
const MAX_BODY_BYTES = 64 * 1024;
const SECRET_CACHE_MS = 60_000;
const TOP_LEVEL_FIELDS = new Set(['version', 'messageId', 'newsletter', 'sponsors']);
const NEWSLETTER_FIELDS = new Set(['name', 'sender', 'subject', 'receivedAt']);
const SPONSOR_FIELDS = new Set(['name', 'url', 'category', 'blurb', 'context']);
const LEAD_STATUSES = new Set(['new', 'triaged', 'converted', 'ignored']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

let secretsClient: SecretsManagerClient | null = null;
let cachedCredential: { value: string; id: string; expiresAt: number } | null = null;

interface Credential { value: string; id: string }
export interface LeadNewsletter { name: string; sender: string; subject: string; receivedAt: string }
export interface LeadSponsor { name: string; url: string; category: string; blurb: string; context: string }

function response(statusCode: number, body: unknown, headers: Record<string, string> = {}): LambdaResponse {
  return { statusCode, headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(body) };
}

function header(event: LambdaEvent, name: string): string {
  const entry = Object.entries(event.headers || {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry ? String(entry[1]) : '';
}

function safeError(statusCode: number, status: string, code: string, message: string): LambdaResponse {
  return response(statusCode, { status, error: { code, message } });
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function normalizeLeadName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function normalizeLeadUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return '';
  const parsed = new URL(trimmed);
  const port = (parsed.protocol === 'https:' && parsed.port === '443') ? '' : parsed.port ? `:${parsed.port}` : '';
  const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
  return `${parsed.hostname.toLowerCase()}${port}${path}${parsed.search}`;
}

export function leadSourceKey(messageId: string, name: string, url: string): string {
  return `${messageId.trim()}\n${normalizeLeadName(name)}\n${normalizeLeadUrl(url)}`;
}

function parseCredential(raw: string): Credential {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.credential === 'string' && parsed.credential.length > 0) {
      const configuredId = typeof parsed.id === 'string' && /^[a-zA-Z0-9._-]{1,64}$/.test(parsed.id) ? parsed.id : '';
      return { value: parsed.credential, id: configuredId || digest(parsed.credential).slice(0, 12) };
    }
  } catch {
    // Plain secret strings remain supported for pre-created credentials.
  }
  return { value: raw, id: digest(raw).slice(0, 12) };
}

async function loadCredential(force = false): Promise<Credential | null> {
  // Potential-lead intake reuses the email-document intake secret: the same
  // Dapier forwarder holds it, so no additional infrastructure is required.
  const inline = process.env.EMAIL_DOCUMENT_INTAKE_SECRET;
  if (inline) return parseCredential(inline);
  if (!force && cachedCredential && cachedCredential.expiresAt > Date.now()) return cachedCredential;
  const name = process.env.EMAIL_DOCUMENT_INTAKE_SECRET_NAME;
  if (!name) return null;
  secretsClient ||= new SecretsManagerClient({});
  const value = await secretsClient.send(new GetSecretValueCommand({ SecretId: name }));
  const raw = value.SecretString || (value.SecretBinary ? Buffer.from(value.SecretBinary).toString('utf8') : '');
  if (!raw) return null;
  const parsed = parseCredential(raw);
  cachedCredential = { ...parsed, expiresAt: Date.now() + SECRET_CACHE_MS };
  return parsed;
}

function equalSecret(actual: string, expected: string): boolean {
  const left = createHash('sha256').update(actual).digest();
  const right = createHash('sha256').update(expected).digest();
  const matches = timingSafeEqual(left, right);
  return matches && actual.length > 0 && expected.length > 0;
}

async function authenticate(event: LambdaEvent): Promise<Credential | null> {
  const actual = header(event, 'x-dataops-intake-secret');
  let expected = await loadCredential(false);
  if (!expected) return null;
  if (equalSecret(actual, expected.value)) return expected;
  // A mismatch bypasses the cache once so a newly rotated value works immediately.
  expected = await loadCredential(true);
  return expected && equalSecret(actual, expected.value) ? expected : null;
}

async function rateLimit(client: DynamoDBDocumentClient, credentialId: string): Promise<number | null> {
  const configured = Number(process.env.LEADS_INTAKE_RATE_LIMIT || '60');
  const limit = Number.isSafeInteger(configured) && configured > 0 ? configured : 60;
  const now = Date.now();
  const windowStart = Math.floor(now / 60_000) * 60_000;
  try {
    await client.send(new UpdateCommand({
      TableName: TABLE_AUDIT_EVENTS,
      Key: {
        PK: `RATE#LEADS#${digest(credentialId).slice(0, 32)}`,
        SK: `WINDOW#${windowStart}`,
      },
      UpdateExpression: 'SET expiresAt = :expiresAt ADD requestCount :one',
      ConditionExpression: 'attribute_not_exists(requestCount) OR requestCount < :limit',
      ExpressionAttributeValues: {
        ':expiresAt': Math.floor((windowStart + 2 * 60_000) / 1000),
        ':one': 1,
        ':limit': limit,
      },
    }));
    return null;
  } catch (error) {
    if ((error as { name?: string })?.name === 'ConditionalCheckFailedException') {
      return Math.max(1, Math.ceil((windowStart + 60_000 - now) / 1000));
    }
    throw error;
  }
}

function text(value: unknown, field: string, max: number, allowNewlines = false): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  const result = value.trim();
  const forbidden = allowNewlines ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
  if (result.length > max || forbidden.test(result)) throw new Error(`${field} is invalid or exceeds ${max} characters`);
  return result;
}

function optionalText(value: unknown, field: string, max: number): string {
  if (value === undefined || value === null || value === '') return '';
  return text(value, field, max, true);
}

function onlyFields(value: Record<string, unknown>, fields: Set<string>, path: string): void {
  const unknown = Object.keys(value).find((key) => !fields.has(key));
  if (unknown) throw new Error(`${path} contains unknown fields`);
}

function utcTimestamp(value: unknown): string {
  const result = text(value, 'newsletter.receivedAt', 40);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(result);
  if (!match) throw new Error('newsletter.receivedAt must be a valid UTC ISO timestamp');
  const normalized = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${(match[7] || '').padEnd(3, '0')}Z`;
  const parsed = new Date(result);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== normalized) throw new Error('newsletter.receivedAt must be a real UTC calendar timestamp');
  if (parsed.getTime() > Date.now() + 5 * 60_000) throw new Error('newsletter.receivedAt must not be in the future');
  return result;
}

function validatedUrl(value: unknown, field: string): string {
  if (value === undefined || value === null || value === '') return '';
  const result = text(value, field, 2000);
  if (/\s/.test(result)) throw new Error(`${field} must be a valid URL without whitespace`);
  let parsed: URL;
  try {
    parsed = new URL(result);
  } catch {
    throw new Error(`${field} must be a valid URL`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`${field} must use https`);
  if (parsed.username || parsed.password) throw new Error(`${field} must not contain credentials`);
  if (!parsed.hostname || parsed.hostname.length > 253) throw new Error(`${field} has an invalid host`);
  return result;
}

function parseNewsletter(value: unknown): LeadNewsletter {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('newsletter must be an object');
  const newsletter = value as Record<string, unknown>;
  onlyFields(newsletter, NEWSLETTER_FIELDS, 'newsletter');
  return {
    name: text(newsletter.name, 'newsletter.name', 200),
    sender: text(newsletter.sender, 'newsletter.sender', 320),
    subject: text(newsletter.subject, 'newsletter.subject', 500),
    receivedAt: utcTimestamp(newsletter.receivedAt),
  };
}

export function parseSponsors(value: unknown): LeadSponsor[] {
  // An issue with no sponsors is still reported: it was checked and had none.
  if (!Array.isArray(value) || value.length > MAX_SPONSORS) {
    throw new Error(`sponsors must be an array with at most ${MAX_SPONSORS} items`);
  }
  const sponsors = value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`sponsors[${index}] must be an object`);
    const sponsor = item as Record<string, unknown>;
    onlyFields(sponsor, SPONSOR_FIELDS, `sponsors[${index}]`);
    return {
      name: text(sponsor.name, `sponsors[${index}].name`, 200),
      url: validatedUrl(sponsor.url, `sponsors[${index}].url`),
      category: optionalText(sponsor.category, `sponsors[${index}].category`, 40),
      blurb: optionalText(sponsor.blurb, `sponsors[${index}].blurb`, 2000),
      context: optionalText(sponsor.context, `sponsors[${index}].context`, 2000),
    };
  });
  const seen = new Set<string>();
  for (const [index, sponsor] of sponsors.entries()) {
    const key = `${normalizeLeadName(sponsor.name)}\n${normalizeLeadUrl(sponsor.url)}`;
    if (seen.has(key)) throw new Error(`sponsors[${index}] duplicates another sponsor in this request`);
    seen.add(key);
  }
  return sponsors;
}

function audit(outcome: string, credential: Credential | null, correlation: string, sponsorCount: number, failureCount = 0): void {
  console.info(JSON.stringify({ event: 'sponsor-lead-intake', outcome, credentialId: credential?.id || 'unknown', contractVersion: CONTRACT_VERSION, correlation, sponsorCount, failureCount }));
}

export interface LeadValue {
  sourceKey: string;
  messageId: string;
  newsletter: LeadNewsletter;
  sponsor: {
    name: string;
    url: string;
    category: string;
    blurb: string;
    context: string;
    normalizedName: string;
    normalizedUrl: string;
  };
  status: string;
  active: boolean;
  sourceType: string;
}

// The idempotency identity is the normalized sponsor within the message.
// Display spellings may vary cosmetically between extractions (case,
// trailing slash); only substantive content differences conflict.
function canonicalLead(value: LeadValue): Record<string, unknown> {
  return {
    messageId: value.messageId,
    newsletter: value.newsletter,
    normalizedName: value.sponsor.normalizedName,
    normalizedUrl: value.sponsor.normalizedUrl,
    category: value.sponsor.category,
    blurb: value.sponsor.blurb,
    context: value.sponsor.context,
  };
}

function stableStringify(value: unknown): string {
  // DynamoDB does not preserve document key order, so a stored newsletter
  // can come back with its keys shuffled. An order-sensitive comparison
  // would then mistake an exact replay for a conflict (live 409 on a
  // byte-identical retry); sort keys recursively before comparing.
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function sameCanonical(existing: CrmRecord, value: LeadValue): boolean {
  const sponsor = (existing.sponsor || {}) as Record<string, unknown>;
  // Leads stored before category existed carry no key; read them as '' so
  // an old lead replayed without a category still matches (a newly added
  // category is a content change and conflicts, as it should).
  return stableStringify({
    messageId: existing.messageId,
    newsletter: existing.newsletter,
    normalizedName: sponsor.normalizedName,
    normalizedUrl: sponsor.normalizedUrl,
    category: typeof sponsor.category === 'string' ? sponsor.category : '',
    blurb: sponsor.blurb,
    context: sponsor.context,
  }) === stableStringify(canonicalLead(value));
}

export function leadValue(messageId: string, newsletter: LeadNewsletter, sponsor: LeadSponsor, sourceType: string): LeadValue {
  return {
    sourceKey: leadSourceKey(messageId, sponsor.name, sponsor.url),
    messageId: messageId.trim(),
    newsletter: { ...newsletter },
    sponsor: {
      name: sponsor.name.trim(),
      url: sponsor.url.trim(),
      category: sponsor.category,
      blurb: sponsor.blurb,
      context: sponsor.context,
      normalizedName: normalizeLeadName(sponsor.name),
      normalizedUrl: normalizeLeadUrl(sponsor.url),
    },
    status: 'new',
    active: true,
    sourceType,
  };
}

export async function storeLead(client: DynamoDBDocumentClient, value: LeadValue): Promise<{ id: string; outcome: 'created' | 'duplicate' }> {
  const id = deterministicCrmId('lead', value.sourceKey);
  const existing = await getCrmRecord(client, 'lead', id);
  if (existing) {
    if (!sameCanonical(existing, value)) {
      throw Object.assign(new Error('Sponsor identity was already used with different content'), { statusCode: 409 });
    }
    return { id, outcome: 'duplicate' };
  }
  const now = new Date().toISOString();
  try {
    await client.send(new PutCommand({
      TableName: TABLE_SPONSOR_CRM,
      Item: { PK: `LEAD#${id}`, SK: `LEAD#${id}`, ...value, id, version: 1, createdAt: now, updatedAt: now },
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
    return { id, outcome: 'created' };
  } catch (error) {
    if ((error as { name?: string })?.name !== 'ConditionalCheckFailedException') throw error;
    // A concurrent identical request won the race; reconcile against the winner.
    const winner = await getCrmRecord(client, 'lead', id);
    if (winner && sameCanonical(winner, value)) return { id, outcome: 'duplicate' };
    throw Object.assign(new Error('Sponsor identity was already used with different content'), { statusCode: 409 });
  }
}

export function resetSponsorLeadIntakeStateForTests(): void {
  cachedCredential = null;
  secretsClient = null;
}

export function setSponsorLeadIntakeClientsForTests(clients: { secrets?: SecretsManagerClient }): void {
  if (clients.secrets) secretsClient = clients.secrets;
}

export async function handleSponsorLeadIntake(event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  if (!process.env.EMAIL_DOCUMENT_INTAKE_SECRET && !process.env.EMAIL_DOCUMENT_INTAKE_SECRET_NAME) {
    return safeError(503, 'configuration-error', 'authentication-not-configured', 'Lead intake authentication is not configured');
  }
  let credential: Credential | null;
  try { credential = await authenticate(event); }
  catch { return safeError(503, 'configuration-error', 'authentication-unavailable', 'Lead intake authentication is unavailable'); }
  if (!credential) {
    audit('unauthorized', null, 'unavailable', 0);
    return safeError(401, 'unauthorized', 'unauthorized', 'Unauthorized');
  }
  let retryAfter: number | null;
  try { retryAfter = await rateLimit(client, credential.id); }
  catch { return safeError(503, 'configuration-error', 'rate-limit-unavailable', 'Request limiting is unavailable'); }
  if (retryAfter !== null) {
    audit('rate-limited', credential, 'unavailable', 0);
    return response(429, { status: 'rate-limited', error: { code: 'rate-limited', message: 'Request limit exceeded' } }, { 'Retry-After': String(retryAfter) });
  }

  const rawBody = typeof event.body === 'string' ? event.body : JSON.stringify(event.body || {});
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) return safeError(413, 'payload-too-large', 'payload-too-large', `Request body exceeds ${MAX_BODY_BYTES} bytes`);

  let body: Record<string, unknown>;
  try {
    const decoded = event.isBase64Encoded ? Buffer.from(rawBody, 'base64').toString('utf8') : rawBody;
    const parsed = JSON.parse(decoded);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('request must be a JSON object');
    body = parsed as Record<string, unknown>;
    onlyFields(body, TOP_LEVEL_FIELDS, 'request');
  } catch (error) {
    return safeError(400, 'validation-error', 'invalid-request', error instanceof Error ? error.message : 'Invalid JSON body');
  }

  let messageId: string;
  let newsletter: LeadNewsletter;
  let sponsors: LeadSponsor[];
  try {
    if (body.version !== CONTRACT_VERSION) throw new Error(`version must be ${CONTRACT_VERSION}`);
    messageId = text(body.messageId, 'messageId', 500);
    newsletter = parseNewsletter(body.newsletter);
    sponsors = parseSponsors(body.sponsors);
  } catch (error) {
    return safeError(400, 'validation-error', 'invalid-request', error instanceof Error ? error.message : 'Invalid request');
  }

  const correlation = digest(messageId.trim()).slice(0, 16);
  // Responses carry only the request index and the stored id: intake content
  // (names, urls, blurbs) is never echoed back, matching the email-document
  // intake privacy posture. Dapier reconciles by index.
  const leads: Array<{ index: number; id: string; outcome: 'created' | 'duplicate' }> = [];
  const failures: Array<{ index: number; code: string }> = [];
  let issue: { id: string; outcome: string };
  try {
    issue = await recordInboxIssue(client, messageId, newsletter);
    for (const [index, sponsor] of sponsors.entries()) {
      try {
        const stored = await storeLead(client, leadValue(messageId, newsletter, sponsor, 'leads-intake'));
        leads.push({ index, id: stored.id, outcome: stored.outcome });
      } catch (error) {
        if ((error as { statusCode?: number })?.statusCode === 409) {
          failures.push({ index, code: 'idempotency-conflict' });
        } else {
          throw error;
        }
      }
    }
  } catch (error) {
    // Tables belong to infrastructure and are never created here. A missing
    // table surfaces as an augmented ResourceNotFoundException naming it;
    // log that detail so the deployment gap is loud instead of a bare 503.
    console.error(JSON.stringify({ event: 'sponsor-lead-intake', outcome: 'persistence-failed', detail: error instanceof Error ? error.message : 'unknown' }));
    audit('persistence-failed', credential, correlation, sponsors.length, sponsors.length - leads.length);
    return safeError(503, 'configuration-error', 'persistence-unavailable', 'Lead storage is unavailable');
  }

  if (failures.length && !leads.length) {
    audit('idempotency-conflict', credential, correlation, sponsors.length, failures.length);
    return response(409, { status: 'idempotency-conflict', error: { code: 'idempotency-conflict', message: 'Sponsor identity was already used with different content' }, failures });
  }
  if (failures.length) {
    audit('partial-failure', credential, correlation, sponsors.length, failures.length);
    return response(207, { status: 'partial-failure', issue: { id: issue.id }, leads, failures });
  }
  const allDuplicate = issue.outcome !== 'created' && leads.every((lead) => lead.outcome === 'duplicate');
  audit(allDuplicate ? 'duplicate' : 'accepted', credential, correlation, sponsors.length);
  return response(allDuplicate ? 200 : 201, { status: allDuplicate ? 'duplicate' : 'accepted', issue: { id: issue.id }, leads });
}

const parseBody = (event: LambdaEvent) => {
  try { return event.body ? JSON.parse(String(event.body)) as Record<string, unknown> : null; }
  catch { return null; }
};

function publicLead(lead: CrmRecord): Record<string, unknown> {
  return {
    id: lead.id,
    messageId: lead.messageId,
    newsletter: lead.newsletter,
    sponsor: lead.sponsor,
    status: lead.status,
    active: lead.active,
    sourceType: lead.sourceType,
    version: lead.version,
    createdAt: lead.createdAt,
    updatedAt: lead.updatedAt,
  };
}

// ---- review list -----------------------------------------------------------
// Leads are one row per sighting: (issue messageId, sponsor name, url). The
// list reads every lead (the table holds hundreds, not millions), filters and
// sorts in memory, and pages with a keyset cursor over the sort order, so a
// lead that changes status between pages never shifts the next page.

export interface LeadListFilters {
  limit: number;
  cursor: { at: string; id: string } | null;
  status: string;
  newsletter: string;
  sponsor: string;
  search: string;
  group: '' | 'sponsor';
}

function encodeCursor(at: string, id: string): string {
  return Buffer.from(JSON.stringify([at, id]), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): { at: string; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (Array.isArray(parsed) && parsed.length === 2 && parsed.every((part) => typeof part === 'string')) {
      return { at: parsed[0], id: parsed[1] };
    }
  } catch {
    // fall through
  }
  return null;
}

export function parseLeadListQuery(query: Record<string, string | undefined>): LeadListFilters | string {
  const limit = Number(query.limit || 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return 'Invalid pagination';
  let cursor: LeadListFilters['cursor'] = null;
  if (query.cursor) {
    cursor = decodeCursor(query.cursor);
    if (!cursor) return 'Invalid pagination';
  }
  const status = query.status || '';
  if (status && !LEAD_STATUSES.has(status)) return 'Invalid status filter';
  for (const name of ['newsletter', 'sponsor', 'search'] as const) {
    if ((query[name] || '').length > 200) return `Invalid ${name} filter`;
  }
  const group = query.group || '';
  if (group !== '' && group !== 'sponsor') return 'Invalid group';
  return {
    limit,
    cursor,
    status,
    newsletter: query.newsletter || '',
    sponsor: query.sponsor ? normalizeLeadName(query.sponsor) : '',
    search: (query.search || '').trim().toLowerCase(),
    group,
  };
}

function leadSponsor(item: CrmRecord): Record<string, unknown> {
  return (item.sponsor || {}) as Record<string, unknown>;
}

function leadNewsletter(item: CrmRecord): Record<string, unknown> {
  return (item.newsletter || {}) as Record<string, unknown>;
}

/** When the sponsor was seen: the issue's date, else when the lead landed. */
function leadSeenAt(item: CrmRecord): string {
  return String(leadNewsletter(item).receivedAt || item.createdAt || '');
}

function leadSponsorKey(item: CrmRecord): string {
  const sponsor = leadSponsor(item);
  return String(sponsor.normalizedName || normalizeLeadName(String(sponsor.name || '')));
}

/** Newest first; id breaks ties so the order (and the cursor) is total. */
function newestFirst<T>(rows: T[], at: (row: T) => string, id: (row: T) => string): T[] {
  return rows.sort((a, b) => at(b).localeCompare(at(a)) || id(b).localeCompare(id(a)));
}

function afterCursor<T>(rows: T[], cursor: LeadListFilters['cursor'], at: (row: T) => string, id: (row: T) => string): T[] {
  if (!cursor) return rows;
  return rows.filter((row) => at(row) < cursor.at || (at(row) === cursor.at && id(row) < cursor.id));
}

function page<T>(rows: T[], filters: LeadListFilters, at: (row: T) => string, id: (row: T) => string) {
  const rest = afterCursor(newestFirst(rows, at, id), filters.cursor, at, id);
  const items = rest.slice(0, filters.limit);
  const last = items[items.length - 1];
  return { items, nextCursor: rest.length > filters.limit && last ? encodeCursor(at(last), id(last)) : null };
}

export function leadListPage(all: CrmRecord[], filters: LeadListFilters): Record<string, unknown> {
  // The newsletter picker lists every newsletter that has leads, whatever
  // the other filters say, so narrowing never hides a way back out.
  const newsletters = [...new Set(all.map((item) => String(leadNewsletter(item).name || '')).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  const matches = all.filter((item) => {
    if (filters.status && item.status !== filters.status) return false;
    if (filters.newsletter && leadNewsletter(item).name !== filters.newsletter) return false;
    if (filters.sponsor && leadSponsorKey(item) !== filters.sponsor) return false;
    if (!filters.search) return true;
    const sponsor = leadSponsor(item);
    const newsletter = leadNewsletter(item);
    return [sponsor.name, sponsor.url, sponsor.blurb, newsletter.name, newsletter.subject]
      .some((value) => String(value || '').toLowerCase().includes(filters.search));
  });

  if (filters.group === 'sponsor') {
    const groups = new Map<string, { key: string; name: string; url: string; latestAt: string; sightings: number; newsletters: string[] }>();
    // Walk newest first so the first sighting sets the display name and url.
    for (const item of newestFirst([...matches], leadSeenAt, (row) => row.id)) {
      const key = leadSponsorKey(item);
      const sponsor = leadSponsor(item);
      const newsletter = String(leadNewsletter(item).name || '');
      const group = groups.get(key) || { key, name: String(sponsor.name || ''), url: '', latestAt: leadSeenAt(item), sightings: 0, newsletters: [] };
      group.sightings += 1;
      if (!group.url && sponsor.url) group.url = String(sponsor.url);
      if (newsletter && !group.newsletters.includes(newsletter)) group.newsletters.push(newsletter);
      groups.set(key, group);
    }
    const result = page([...groups.values()], filters, (row) => row.latestAt, (row) => row.key);
    return { items: result.items, nextCursor: result.nextCursor, newsletters };
  }

  const result = page(matches, filters, leadSeenAt, (row) => row.id);
  return { items: result.items.map(publicLead), nextCursor: result.nextCursor, newsletters };
}

export async function handleSponsorLeadRoutes(path: string, method: string, event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  const match = path.match(/^\/api\/sponsor-crm\/leads(?:\/([^/]+))?$/);
  if (!match) return response(404, { error: 'Not found' });
  const id = match[1];

  if (method === 'GET' && !id) {
    const query = event.queryStringParameters || {};
    const filters = parseLeadListQuery(query);
    if (typeof filters === 'string') return response(400, { error: filters });
    const all = await listCrmRecords(client, 'lead');
    return response(200, leadListPage(all, filters));
  }

  if (method === 'GET' && id) {
    if (!ID.test(id)) return response(400, { error: 'Invalid ID' });
    const lead = await getCrmRecord(client, 'lead', id);
    return lead ? response(200, publicLead(lead)) : response(404, { error: 'Not found' });
  }

  if ((method === 'PATCH' || method === 'PUT') && id) {
    if (!ID.test(id)) return response(400, { error: 'Invalid ID' });
    const body = parseBody(event);
    if (!body) return response(400, { error: 'Invalid JSON' });
    const existing = await getCrmRecord(client, 'lead', id);
    if (!existing) return response(404, { error: 'Not found' });
    if (body.version !== existing.version) return response(409, { error: 'Lead was changed; reload and retry' });
    const unknown = Object.keys(body).find((key) => !['version', 'status', 'organizationId', 'createNew'].includes(key));
    if (unknown) return response(400, { error: `Unknown field: ${unknown}` });
    if (body.status !== undefined && !LEAD_STATUSES.has(String(body.status))) return response(400, { error: 'Invalid status' });
    if (body.status === undefined) return response(400, { error: 'Nothing to update' });
    if (body.status === 'converted') {
      const actorId = Object.entries(event.headers || {}).find(([key]) => key.toLowerCase() === 'x-user-id')?.[1] || 'authenticated-operator';
      try {
        const result = await convertLead(client, existing, {
          version: body.version,
          status: body.status,
          organizationId: body.organizationId,
          createNew: body.createNew,
        }, actorId);
        if (!result.ok) return response(result.statusCode, { error: result.error, candidates: result.candidates });
        return response(200, { ...publicLead(result.lead), organizationId: result.organization.id, organization: { id: result.organization.id, displayName: result.organization.displayName, domain: result.organization.domain, sightings: result.organization.sightings }, created: result.created });
      } catch {
        return response(409, { error: 'Conflicting update; reload and retry' });
      }
    }
    try {
      const next = await updateCrmRecord(client, 'lead', existing, { status: body.status });
      return response(200, publicLead(next));
    } catch {
      return response(409, { error: 'Conflicting update; reload and retry' });
    }
  }

  return response(405, { error: 'Method not allowed' });
}
