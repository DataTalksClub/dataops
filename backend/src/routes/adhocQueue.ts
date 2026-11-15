import { createHash, timingSafeEqual } from 'node:crypto';
import { GetCommand, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { TABLE_INTAKE } from '../db/tableNames';
import { writeEmbeddedMetric } from '../embeddedMetrics';
import { headerValue } from '../httpHeaders';
import { noStoreJson as json } from '../http';
import { resolveInteractiveActor } from '../identity/actor';
import { recordRequestError } from '../requestErrorLog';
import { readRuntimeSecret } from '../secrets/reader';
import type { LambdaEvent, LambdaResponse } from '../types';

/**
 * General-purpose ad-hoc queue. Any system (AISL first) posts an item with
 * its own per-source token; operators and Orin list, read and resolve items
 * through the portal and the `dataops queue` CLI.
 *
 * Source tokens live in the DataOps secrets store as `adhoc-queue.<source>`,
 * so adding a source is `dataops secrets set adhoc-queue.<source>`; no code
 * or deploy. Items are stored in the intake table under `ADHOC#<id>`, where
 * the id is derived from (source, idempotencyKey), so a retried post lands on
 * the same item.
 */

export const ADHOC_QUEUE_POST_PATH = '/api/v1/queue/items';
export const ADHOC_QUEUE_STATUSES = ['new', 'acked', 'done'] as const;
export type AdhocQueueStatus = (typeof ADHOC_QUEUE_STATUSES)[number];

const SOURCE_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const KIND_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_TITLE = 300;
const MAX_KEY = 200;
const MAX_LINKS = 20;
const SECRET_CACHE_MS = 60_000;

export interface AdhocQueueLink { label: string; url: string }

export interface AdhocQueueItem {
  id: string;
  source: string;
  kind: string;
  title: string;
  payload: Record<string, unknown>;
  links: AdhocQueueLink[];
  idempotencyKey: string;
  status: AdhocQueueStatus;
  receivedAt: string;
  updatedAt: string;
  resolvedBy?: string;
  resolutionNote?: string;
  history: { at: string; status: AdhocQueueStatus; by: string; note?: string }[];
}

let readSecret: (name: string) => Promise<string> = readRuntimeSecret;
const secretCache = new Map<string, { value: string; expiresAt: number }>();

export function setAdhocQueueSecretReaderForTests(reader: ((name: string) => Promise<string>) | null): void {
  readSecret = reader || readRuntimeSecret;
  secretCache.clear();
}

export function adhocQueueSecretName(source: string): string {
  return `adhoc-queue.${source}`;
}

async function sourceToken(source: string, force: boolean): Promise<string | null> {
  const cached = secretCache.get(source);
  if (!force && cached && cached.expiresAt > Date.now()) return cached.value;
  try {
    const value = (await readSecret(adhocQueueSecretName(source))).trim();
    secretCache.set(source, { value, expiresAt: Date.now() + SECRET_CACHE_MS });
    return value || null;
  } catch (error) {
    // A source with no secret is simply not registered; that is a 401, not an outage.
    if (/does not exist/.test(String((error as Error)?.message))) return null;
    throw error;
  }
}

function sameSecret(actual: string, expected: string): boolean {
  const left = createHash('sha256').update(actual).digest();
  const right = createHash('sha256').update(expected).digest();
  return actual.length > 0 && expected.length > 0 && timingSafeEqual(left, right);
}

function bearer(event: LambdaEvent): string {
  const raw = headerValue(event.headers, 'authorization');
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match ? match[1].trim() : headerValue(event.headers, 'x-dataops-queue-token').trim();
}

export function adhocQueueItemId(source: string, idempotencyKey: string): string {
  return `q-${createHash('sha256').update(`${source}\n${idempotencyKey}`).digest('hex').slice(0, 24)}`;
}

function bad(message: string, code = 'invalid_request'): LambdaResponse {
  return json(400, { error: { code, message } });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validLinks(value: unknown): AdhocQueueLink[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return 'links must be an array of {label, url}';
  if (value.length > MAX_LINKS) return `links must have at most ${MAX_LINKS} entries`;
  const out: AdhocQueueLink[] = [];
  for (const entry of value) {
    const url = typeof entry === 'string' ? entry : isPlainObject(entry) ? entry.url : undefined;
    const label = isPlainObject(entry) && typeof entry.label === 'string' ? entry.label.trim().slice(0, 120) : '';
    if (typeof url !== 'string' || !/^https?:\/\/\S+$/.test(url) || url.length > 2000) {
      return 'every link needs an http(s) url';
    }
    out.push({ label: label || url, url });
  }
  return out;
}

type Validated = Pick<AdhocQueueItem, 'source' | 'kind' | 'title' | 'payload' | 'links' | 'idempotencyKey'>;

export function validateAdhocQueuePost(body: unknown): Validated | string {
  if (!isPlainObject(body)) return 'body must be a JSON object';
  const { source, kind, title, payload, idempotencyKey } = body;
  if (typeof source !== 'string' || !SOURCE_PATTERN.test(source)) return 'source must match [a-z0-9][a-z0-9-]{0,39}';
  if (typeof kind !== 'string' || !KIND_PATTERN.test(kind)) return 'kind must be a dotted lowercase name such as event.updated';
  if (typeof title !== 'string' || !title.trim()) return 'title is required';
  if (title.length > MAX_TITLE) return `title must be ${MAX_TITLE} characters or less`;
  if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) return 'idempotencyKey is required';
  if (idempotencyKey.length > MAX_KEY) return `idempotencyKey must be ${MAX_KEY} characters or less`;
  if (payload !== undefined && !isPlainObject(payload)) return 'payload must be a JSON object';
  const links = validLinks(body.links);
  if (typeof links === 'string') return links;
  return {
    source,
    kind,
    title: title.trim(),
    payload: (payload as Record<string, unknown>) || {},
    links,
    idempotencyKey: idempotencyKey.trim(),
  };
}

function clean(row: Record<string, unknown> | undefined): AdhocQueueItem | null {
  if (!row) return null;
  const { PK: _pk, SK: _sk, ...rest } = row;
  return rest as unknown as AdhocQueueItem;
}

function storageFailed(operation: string, error: unknown): LambdaResponse {
  // Loud: the 5xx boundary log line plus a metric the operator alarm pages on.
  recordRequestError(error);
  writeEmbeddedMetric({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{ Namespace: 'DataOps/AdhocQueue', Dimensions: [['Operation']], Metrics: [{ Name: 'StoreFailure', Unit: 'Count' }] }],
    },
    Operation: operation,
    StoreFailure: 1,
  });
  return json(503, { error: { code: 'queue_storage_failed', message: 'The queue could not store the item; retry later.' } });
}

async function handlePost(event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  const raw = typeof event.body === 'string'
    ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body)
    : '';
  if (!raw) return bad('request body is required');
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) return json(413, { error: { code: 'too_large', message: `body must be ${MAX_BODY_BYTES} bytes or less` } });
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return bad('body must be valid JSON'); }

  const sourceForAuth = isPlainObject(parsed) && typeof parsed.source === 'string' && SOURCE_PATTERN.test(parsed.source)
    ? parsed.source : '';
  const token = bearer(event);
  if (!token) return json(401, { error: { code: 'unauthorized', message: 'Authorization: Bearer <source token> is required' } });
  if (!sourceForAuth) return bad('source must match [a-z0-9][a-z0-9-]{0,39}');

  let expected: string | null;
  try {
    expected = await sourceToken(sourceForAuth, false);
    if (expected && !sameSecret(token, expected)) expected = await sourceToken(sourceForAuth, true);
  } catch (error) {
    return storageFailed('auth', error);
  }
  if (!expected || !sameSecret(token, expected)) {
    return json(401, { error: { code: 'unauthorized', message: 'token is not valid for this source' } });
  }

  const valid = validateAdhocQueuePost(parsed);
  if (typeof valid === 'string') return bad(valid);

  const id = adhocQueueItemId(valid.source, valid.idempotencyKey);
  const now = new Date().toISOString();
  const item: AdhocQueueItem = {
    id,
    ...valid,
    status: 'new',
    receivedAt: now,
    updatedAt: now,
    history: [{ at: now, status: 'new', by: valid.source }],
  };
  try {
    await client.send(new PutCommand({
      TableName: TABLE_INTAKE,
      Item: { PK: `ADHOC#${id}`, SK: `ADHOC#${id}`, ...item },
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
    return json(201, { item, created: true });
  } catch (error) {
    if ((error as { name?: string })?.name === 'ConditionalCheckFailedException') {
      try {
        const existing = await getAdhocQueueItem(client, id);
        return json(200, { item: existing, created: false, duplicate: true });
      } catch (readError) {
        return storageFailed('read', readError);
      }
    }
    return storageFailed('put', error);
  }
}

export async function getAdhocQueueItem(client: DynamoDBDocumentClient, id: string): Promise<AdhocQueueItem | null> {
  const result = await client.send(new GetCommand({ TableName: TABLE_INTAKE, Key: { PK: `ADHOC#${id}`, SK: `ADHOC#${id}` } }));
  return clean(result.Item as Record<string, unknown> | undefined);
}

export async function listAdhocQueueItems(client: DynamoDBDocumentClient): Promise<AdhocQueueItem[]> {
  const items: AdhocQueueItem[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await client.send(new ScanCommand({
      TableName: TABLE_INTAKE,
      FilterExpression: 'begins_with(PK, :prefix)',
      ExpressionAttributeValues: { ':prefix': 'ADHOC#' },
      ExclusiveStartKey: start,
    }));
    for (const row of page.Items || []) {
      const item = clean(row as Record<string, unknown>);
      if (item) items.push(item);
    }
    start = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (start);
  return items.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt) || a.id.localeCompare(b.id));
}

const ID_PATTERN = /^q-[a-f0-9]{24}$/;

/** Operator routes: GET /api/queue, GET /api/queue/:id, PUT /api/queue/:id/status. */
export async function handleAdhocQueueRoutes(event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse | null> {
  const method = (event.httpMethod || 'GET').toUpperCase();
  const path = (event.path || '').replace(/\/+$/, '');
  if (method === 'POST' && path === ADHOC_QUEUE_POST_PATH) return handlePost(event, client);
  if (path !== '/api/queue' && !path.startsWith('/api/queue/')) return null;

  if (method === 'GET' && path === '/api/queue') {
    const actor = await resolveInteractiveActor(client, event, 'work-read');
    if (!actor.ok) return actor.response;
    const status = event.queryStringParameters?.status || 'open';
    const source = event.queryStringParameters?.source;
    if (status !== 'open' && status !== 'all' && !(ADHOC_QUEUE_STATUSES as readonly string[]).includes(status)) {
      return bad('status must be open, all, new, acked or done');
    }
    const items = (await listAdhocQueueItems(client)).filter((item) => (
      (status === 'all' || (status === 'open' ? item.status !== 'done' : item.status === status))
      && (!source || item.source === source)
    ));
    return json(200, { items, count: items.length });
  }

  const match = /^\/api\/queue\/([^/]+)(\/status)?$/.exec(path);
  if (!match) return json(404, { error: { code: 'not_found', message: 'Not found' } });
  const id = decodeURIComponent(match[1]);
  if (!ID_PATTERN.test(id)) return bad('invalid queue item id');

  if (method === 'GET' && !match[2]) {
    const actor = await resolveInteractiveActor(client, event, 'work-read');
    if (!actor.ok) return actor.response;
    const item = await getAdhocQueueItem(client, id);
    return item ? json(200, { item }) : json(404, { error: { code: 'not_found', message: `queue item ${id} not found` } });
  }

  if (method === 'PUT' && match[2]) {
    const actor = await resolveInteractiveActor(client, event, 'work-write');
    if (!actor.ok) return actor.response;
    let body: Record<string, unknown>;
    try { body = JSON.parse(event.body || '{}'); } catch { return bad('body must be valid JSON'); }
    const status = body.status;
    if (typeof status !== 'string' || !(ADHOC_QUEUE_STATUSES as readonly string[]).includes(status)) {
      return bad('status must be new, acked or done');
    }
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 2000) : '';
    if (status === 'done' && !note) return bad('note is required when marking an item done');
    const by = actor.actor.id || 'operator';
    const now = new Date().toISOString();
    try {
      const result = await client.send(new UpdateCommand({
        TableName: TABLE_INTAKE,
        Key: { PK: `ADHOC#${id}`, SK: `ADHOC#${id}` },
        ConditionExpression: 'attribute_exists(PK)',
        UpdateExpression: 'SET #status = :status, updatedAt = :now, resolvedBy = :by, resolutionNote = :note, history = list_append(history, :entry)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':status': status, ':now': now, ':by': by, ':note': note,
          ':entry': [{ at: now, status, by, ...(note ? { note } : {}) }],
        },
        ReturnValues: 'ALL_NEW',
      }));
      return json(200, { item: clean(result.Attributes as Record<string, unknown>) });
    } catch (error) {
      if ((error as { name?: string })?.name === 'ConditionalCheckFailedException') {
        return json(404, { error: { code: 'not_found', message: `queue item ${id} not found` } });
      }
      return storageFailed('update', error);
    }
  }

  return json(405, { error: { code: 'method_not_allowed', message: `${method} not allowed on ${path}` } });
}
