import { createHash, timingSafeEqual } from 'node:crypto';
import { GetCommand, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { TABLE_INTAKE } from '../db/tableNames';
import { createTask } from '../db/tasks';
import { getUsersByNormalizedEmail } from '../db/users';
import { writeEmbeddedMetric } from '../embeddedMetrics';
import { publishOperatorAlarm } from '../export/dynamoPitrCheck';
import { headerValue } from '../httpHeaders';
import { OPERATIONS_SENDER } from '../identity/operatingIdentities';
import { noStoreJson as json } from '../http';
import { resolveInteractiveActor } from '../identity/actor';
import { recordRequestError } from '../requestErrorLog';
import { readRuntimeSecret } from '../secrets/reader';
import { berlinDate } from '../sponsorFinance/core';
import type { BrowserRequirement, LambdaEvent, LambdaResponse, TaskChecklistItem } from '../types';

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
 *
 * A source/kind registered in ADHOC_QUEUE_TASK_SOURCES must also send a
 * `task` block; its item then becomes exactly one ad hoc Task (id
 * `qt-<item hash>`, assigned to the registered operator) carrying that
 * checklist and SOP inline. The Task is created with a conditional write
 * from the stored item, so a retry or a concurrent post never makes a second
 * Task, and a failed Task write is a 503 the caller retries with the same key.
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
  /** Ad hoc Task spec, for a registered task source only; immutable after the first post. */
  task?: AdhocQueueTaskSpec;
  /** The Task materialized from this item (`qt-...`). */
  taskId?: string;
  history: { at: string; status: AdhocQueueStatus; by: string; note?: string }[];
}

export interface AdhocQueueTaskSpec {
  description: string;
  checklist: string[];
  instructionDocId?: string;
  comment?: string;
  browserRequirement?: BrowserRequirement;
}

interface AdhocQueueTaskSource {
  kinds: readonly string[];
  /** The operator every Task from this source is assigned to. */
  assigneeEmail: string;
  tags: readonly string[];
  /** The one SOP every Task from this source binds; a post must name exactly this document. */
  instructionDocId: string;
  /** How the operator carries the Task out; a post must declare exactly this. */
  browserRequirement: BrowserRequirement;
  /** idempotencyKey is `<keyPrefix><request id>`; the request id must match requestIdPattern. */
  keyPrefix: string;
  requestIdPattern: RegExp;
  /** Exactly one link must be the source decision: this origin + path, with the request id in sourceLinkParam. */
  sourceLink: { origin: string; path: string; param: string };
  /** Every other link must be on one of these origins. */
  extraLinkOrigins: readonly string[];
  /** payload.decision must carry these fields; workspace_id must equal workspaceId and member_id match memberIdPattern. */
  workspaceId: string;
  memberIdPattern: RegExp;
}

/**
 * Sources whose items each become one ad hoc Task. Registering a source here
 * is a reviewed code change; its token alone never lets it create Tasks.
 */
export const ADHOC_QUEUE_TASK_SOURCES: Readonly<Record<string, AdhocQueueTaskSource>> = {
  // Approved Slack ban requests from slack-mod-app, carried out by Orin.
  // The operator path is the headless `scripts/ban-action.py` CLI on the moderation host;
  // it reads the source decision itself and never acts on this Task's editable text.
  'slack-mod-app': {
    kinds: ['slack.ban-request'],
    assigneeEmail: OPERATIONS_SENDER,
    tags: ['slack-ban'],
    instructionDocId: 'sop.community.slack.process-slack-moderation-ban-requests',
    browserRequirement: 'headless',
    keyPrefix: 'ban-request:',
    requestIdPattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/,
    sourceLink: { origin: 'https://mod.dtcdev.click', path: '/', param: 'request' },
    extraLinkOrigins: ['https://datatalks-club.slack.com'],
    workspaceId: 'T01ATQK62F8',
    memberIdPattern: /^[UW][A-Z0-9]{8,12}$/,
  },
};

const MAX_TASK_DESCRIPTION = 300;
const MAX_CHECKLIST = 10;
const MAX_CHECKLIST_TEXT = 1000;
const MAX_TASK_COMMENT = 4000;

export function adhocQueueTaskId(itemId: string): string {
  return `qt-${itemId.slice(2)}`;
}

function taskSourceFor(source: string, kind: string): AdhocQueueTaskSource | null {
  const registered = Object.prototype.hasOwnProperty.call(ADHOC_QUEUE_TASK_SOURCES, source)
    ? ADHOC_QUEUE_TASK_SOURCES[source] : null;
  return registered && registered.kinds.includes(kind) ? registered : null;
}

/**
 * The registered source's contract for one post: the key names exactly one
 * request, the payload decision is that request in the pinned workspace, and
 * the links point only at that request's decision (plus allowed extras).
 */
function validSourceContract(
  registered: AdhocQueueTaskSource,
  idempotencyKey: string,
  payload: Record<string, unknown>,
  links: AdhocQueueLink[],
): string | null {
  const key = idempotencyKey.trim();
  if (!key.startsWith(registered.keyPrefix)) return `idempotencyKey must be ${registered.keyPrefix}<request id>`;
  const requestId = key.slice(registered.keyPrefix.length);
  if (!registered.requestIdPattern.test(requestId)) return 'idempotencyKey names an invalid request id';
  const decision = payload.decision;
  if (!isPlainObject(decision)) return 'payload.decision is required';
  if (decision.request_id !== requestId) return 'payload.decision.request_id must match the idempotencyKey';
  if (decision.workspace_id !== registered.workspaceId) return 'payload.decision.workspace_id is not the registered workspace';
  if (typeof decision.member_id !== 'string' || !registered.memberIdPattern.test(decision.member_id)) {
    return 'payload.decision.member_id must be one member id';
  }
  let sourceLinks = 0;
  for (const { url } of links) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return 'every link must be a valid url';
    }
    if (parsed.origin === registered.sourceLink.origin) {
      if (parsed.pathname !== registered.sourceLink.path || parsed.username || parsed.password
        || parsed.searchParams.getAll(registered.sourceLink.param).length !== 1
        || parsed.searchParams.get(registered.sourceLink.param) !== requestId) {
        return 'the source decision link must point at this request';
      }
      sourceLinks += 1;
    } else if (!registered.extraLinkOrigins.includes(parsed.origin)) {
      return `links must stay on ${[registered.sourceLink.origin, ...registered.extraLinkOrigins].join(' or ')}`;
    }
  }
  if (sourceLinks !== 1) return 'exactly one link must be the source decision';
  return null;
}

function validTask(value: unknown, registered: AdhocQueueTaskSource): AdhocQueueTaskSpec | string {
  if (!isPlainObject(value)) return 'task must be an object';
  const { description, checklist, instructionDocId, comment, browserRequirement } = value;
  if (typeof description !== 'string' || !description.trim()) return 'task.description is required';
  if (description.length > MAX_TASK_DESCRIPTION) return `task.description must be ${MAX_TASK_DESCRIPTION} characters or less`;
  if (!Array.isArray(checklist) || checklist.length < 1 || checklist.length > MAX_CHECKLIST) {
    return `task.checklist must have 1 to ${MAX_CHECKLIST} items`;
  }
  if (!checklist.every((row) => typeof row === 'string' && row.trim() && row.length <= MAX_CHECKLIST_TEXT)) {
    return `every task.checklist item must be text of ${MAX_CHECKLIST_TEXT} characters or less`;
  }
  if (instructionDocId !== registered.instructionDocId) {
    return `task.instructionDocId must be the registered SOP ${registered.instructionDocId}`;
  }
  if (comment !== undefined && (typeof comment !== 'string' || comment.length > MAX_TASK_COMMENT)) {
    return `task.comment must be text of ${MAX_TASK_COMMENT} characters or less`;
  }
  if (browserRequirement !== registered.browserRequirement) {
    return `task.browserRequirement must be ${registered.browserRequirement} for this source`;
  }
  return {
    description: description.trim(),
    checklist: (checklist as string[]).map((row) => row.trim()),
    instructionDocId: registered.instructionDocId,
    ...(comment && (comment as string).trim() ? { comment: (comment as string).trim() } : {}),
    browserRequirement: registered.browserRequirement,
  };
}

async function resolveAssignee(client: DynamoDBDocumentClient, email: string): Promise<string> {
  const users = (await getUsersByNormalizedEmail(client, email)).filter((user) => user.disabled !== true);
  if (users.length !== 1) throw new Error(`queue task assignee ${email} must resolve to exactly one active user`);
  return users[0].id;
}

/**
 * Create the item's Task (once) and record its id on the item. Safe to repeat:
 * the Task id is derived from the item id and written conditionally.
 */
async function materializeTask(client: DynamoDBDocumentClient, item: AdhocQueueItem, registered: AdhocQueueTaskSource): Promise<AdhocQueueItem> {
  if (item.taskId || !item.task) return item;
  const taskId = adhocQueueTaskId(item.id);
  const spec = item.task;
  const actorId = `queue:${item.source}`;
  const checklistItems: TaskChecklistItem[] = spec.checklist.map((text, index) => ({
    id: `${taskId}-${index + 1}`,
    text,
    checked: false,
    ...(spec.instructionDocId ? { instructionDocId: spec.instructionDocId } : {}),
  }));
  try {
    await createTask(client, {
      id: taskId,
      description: spec.description,
      date: berlinDate(),
      assigneeId: await resolveAssignee(client, registered.assigneeEmail),
      createdBy: actorId,
      source: actorId,
      queueItemId: item.id,
      checklistItems,
      tags: [...registered.tags],
      ...(spec.instructionDocId ? { instructionDocId: spec.instructionDocId } : {}),
      ...(spec.comment ? { comment: spec.comment } : {}),
      ...(spec.browserRequirement ? { browserRequirement: spec.browserRequirement } : {}),
      ...(item.links.length ? { materials: item.links.map(({ label, url }) => ({ label, url })) } : {}),
    }, { actorId, triggerKind: 'queue-item' });
  } catch (error) {
    // Another post already created it: the conditional write keeps one Task.
    if ((error as { name?: string })?.name !== 'ConditionalCheckFailedException') throw error;
  }
  const result = await client.send(new UpdateCommand({
    TableName: TABLE_INTAKE,
    Key: { PK: `ADHOC#${item.id}`, SK: `ADHOC#${item.id}` },
    ConditionExpression: 'attribute_exists(PK)',
    UpdateExpression: 'SET taskId = :taskId',
    ExpressionAttributeValues: { ':taskId': taskId },
    ReturnValues: 'ALL_NEW',
  }));
  return clean(result.Attributes as Record<string, unknown>) as AdhocQueueItem;
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

type Validated = Pick<AdhocQueueItem, 'source' | 'kind' | 'title' | 'payload' | 'links' | 'idempotencyKey' | 'task'>;

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
  let task: AdhocQueueTaskSpec | undefined;
  const registered = taskSourceFor(source, kind);
  if (registered) {
    const contract = validSourceContract(registered, idempotencyKey, (payload as Record<string, unknown>) || {}, links);
    if (contract) return contract;
    const spec = validTask(body.task, registered);
    if (typeof spec === 'string') return spec;
    task = spec;
  } else if (body.task !== undefined) {
    return 'task is accepted only from a registered task source and kind';
  }
  return {
    source,
    kind,
    title: title.trim(),
    payload: (payload as Record<string, unknown>) || {},
    links,
    idempotencyKey: idempotencyKey.trim(),
    ...(task ? { task } : {}),
  };
}

function clean(row: Record<string, unknown> | undefined): AdhocQueueItem | null {
  if (!row) return null;
  const { PK: _pk, SK: _sk, ...rest } = row;
  return rest as unknown as AdhocQueueItem;
}

// Injectable for tests; production pages the shared operator SNS topic.
let pageOperator: typeof publishOperatorAlarm = publishOperatorAlarm;

export function setAdhocQueueOperatorPagerForTests(pager: typeof publishOperatorAlarm | null): void {
  pageOperator = pager || publishOperatorAlarm;
}

async function storageFailed(operation: string, error: unknown): Promise<LambdaResponse> {
  // Loud: the 5xx boundary log line, a metric, and a direct page on the shared
  // operator SNS topic (emails dev@dtcdev.click), so a lost item is never silent.
  recordRequestError(error);
  writeEmbeddedMetric({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{ Namespace: 'DataOps/AdhocQueue', Dimensions: [[]], Metrics: [{ Name: 'StoreFailure', Unit: 'Count' }] }],
    },
    Operation: operation,
    StoreFailure: 1,
  });
  const detail = `${(error as Error)?.name || 'Error'}: ${(error as Error)?.message || 'unknown error'}`;
  try {
    const result = await pageOperator({
      alarmName: 'dataops-v1-adhoc-queue-store-failure',
      description: 'The ad-hoc queue failed to store or update an item; the caller got 503 and must retry.',
      reason: `Ad-hoc queue ${operation} failed: ${detail}`.slice(0, 1000),
      subject: '[DataOps] Ad-hoc queue store failure',
      details: { Operation: operation },
    });
    if (!result.published) console.error(`adhoc_queue_page_skipped: no operator topic configured (${operation}: ${detail})`);
  } catch (pageError) {
    console.error(`adhoc_queue_page_failed: ${(pageError as Error)?.message || 'unknown error'}`);
  }
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
    return await storageFailed('auth', error);
  }
  if (!expected || !sameSecret(token, expected)) {
    return json(401, { error: { code: 'unauthorized', message: 'token is not valid for this source' } });
  }

  const valid = validateAdhocQueuePost(parsed);
  if (typeof valid === 'string') return bad(valid);

  const id = adhocQueueItemId(valid.source, valid.idempotencyKey);
  const registered = taskSourceFor(valid.source, valid.kind);
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
  } catch (error) {
    if ((error as { name?: string })?.name === 'ConditionalCheckFailedException') {
      let existing: AdhocQueueItem | null;
      try {
        existing = await getAdhocQueueItem(client, id);
      } catch (readError) {
        return await storageFailed('read', readError);
      }
      if (existing && taskSourceFor(existing.source, existing.kind) || registered) {
        // A registered source's key names one decision: a post that differs from the
        // stored one (other kind, edited decision or task) is a conflict, never a no-op.
        if (!existing || !sameRegisteredPost(existing, valid)) {
          return json(409, { error: { code: 'conflict', message: 'this idempotencyKey already holds a different item' }, item: existing });
        }
        // Closed before its Task existed: never create a late Task for it.
        if (!existing.taskId && existing.status === 'done') {
          return json(409, { error: { code: 'item_closed', message: 'this item was closed before its Task was created' }, item: existing });
        }
      }
      // A retry finishes a Task the first post could not create, from the stored spec.
      if (existing && registered) {
        try {
          existing = await materializeTask(client, existing, registered);
        } catch (taskError) {
          return await storageFailed('task', taskError);
        }
      }
      return json(200, { item: existing, created: false, duplicate: true });
    }
    return await storageFailed('put', error);
  }
  if (!registered) return json(201, { item, created: true });
  try {
    return json(201, { item: await materializeTask(client, item, registered), created: true });
  } catch (taskError) {
    return await storageFailed('task', taskError);
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sameRegisteredPost(existing: AdhocQueueItem, valid: Validated): boolean {
  const fields = (item: Validated | AdhocQueueItem) => canonical({
    source: item.source, kind: item.kind, title: item.title, payload: item.payload,
    links: item.links, idempotencyKey: item.idempotencyKey, task: item.task,
  });
  return fields(existing) === fields(valid);
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
      return await storageFailed('update', error);
    }
  }

  return json(405, { error: { code: 'method_not_allowed', message: `${method} not allowed on ${path}` } });
}
