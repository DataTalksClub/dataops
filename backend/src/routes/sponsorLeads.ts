import { createHash, timingSafeEqual } from 'crypto';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { deterministicCrmId, getCrmRecord, listCrmRecords, updateCrmRecord, type CrmRecord } from '../db/sponsorCrm';
import { convertLead } from '../sponsorCrm/convertLead';
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
interface LeadNewsletter { name: string; sender: string; subject: string; receivedAt: string }
interface LeadSponsor { name: string; url: string; category: string; blurb: string; context: string }

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

function parseSponsors(value: unknown): LeadSponsor[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SPONSORS) {
    throw new Error(`sponsors must be an array with 1 to ${MAX_SPONSORS} items`);
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

interface LeadValue {
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

async function storeLead(client: DynamoDBDocumentClient, value: LeadValue): Promise<{ id: string; outcome: 'created' | 'duplicate' }> {
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
  try {
    for (const [index, sponsor] of sponsors.entries()) {
      const sourceKey = leadSourceKey(messageId, sponsor.name, sponsor.url);
      const value = {
        sourceKey,
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
        sourceType: 'leads-intake',
      };
      try {
        const stored = await storeLead(client, value);
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
    return response(207, { status: 'partial-failure', leads, failures });
  }
  const allDuplicate = leads.every((lead) => lead.outcome === 'duplicate');
  audit(allDuplicate ? 'duplicate' : 'accepted', credential, correlation, sponsors.length);
  return response(allDuplicate ? 200 : 201, { status: allDuplicate ? 'duplicate' : 'accepted', leads });
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

export async function handleSponsorLeadRoutes(path: string, method: string, event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  const match = path.match(/^\/api\/sponsor-crm\/leads(?:\/([^/]+))?$/);
  if (!match) return response(404, { error: 'Not found' });
  const id = match[1];

  if (method === 'GET' && !id) {
    const query = event.queryStringParameters || {};
    const limit = Number(query.limit || 50);
    const cursor = Number(query.cursor || 0);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(cursor) || cursor < 0) {
      return response(400, { error: 'Invalid pagination' });
    }
    if (query.status !== undefined && !LEAD_STATUSES.has(query.status)) return response(400, { error: 'Invalid status filter' });
    if (query.search !== undefined && (typeof query.search !== 'string' || query.search.length > 200)) return response(400, { error: 'Invalid search filter' });
    let items = await listCrmRecords(client, 'lead');
    if (query.status) items = items.filter((item) => item.status === query.status);
    if (query.search) {
      const needle = query.search.toLowerCase();
      items = items.filter((item) => {
        const sponsor = (item.sponsor || {}) as Record<string, unknown>;
        const newsletter = (item.newsletter || {}) as Record<string, unknown>;
        return [sponsor.name, sponsor.url, sponsor.normalizedName, newsletter.name, item.messageId]
          .some((value) => String(value || '').toLowerCase().includes(needle));
      });
    }
    const sliced = items.slice(cursor, cursor + limit);
    return response(200, { items: sliced.map(publicLead), nextCursor: cursor + limit < items.length ? String(cursor + limit) : null });
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
