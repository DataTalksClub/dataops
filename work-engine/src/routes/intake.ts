import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { createAssistantJob, appendAssistantJobEvent } from '../db/assistantJobs';
import { getBundle, updateBundle } from '../db/bundles';
import {
  createIntakeItem,
  findIntakeBySourceMessage,
  getIntakeItem,
  listIntakeItems,
  updateIntakeItem,
} from '../db/intake';
import { createTask, getTask, updateTask } from '../db/tasks';
import type {
  AssistantJobInputRef,
  AssistantJobRef,
  Bundle,
  IntakeAssistantReadiness,
  IntakeDataClass,
  IntakeFileRef,
  IntakeHistoryEvent,
  IntakeItem,
  IntakeLinkRef,
  IntakePriority,
  IntakeRef,
  IntakeSource,
  IntakeSourceActor,
  IntakeStatus,
  LambdaEvent,
  LambdaResponse,
  Task,
} from '../types';

const JSON_HEADERS: Record<string, string> = { 'Content-Type': 'application/json' };
const INTAKE_SOURCES = new Set<IntakeSource>(['telegram', 'email', 'manual', 'file', 'link', 'import', 'assistant', 'unknown']);
const INTAKE_STATUSES = new Set<IntakeStatus>(['new', 'triaged', 'attached', 'converted', 'ignored', 'duplicate', 'blocked', 'archived']);
const INTAKE_PRIORITIES = new Set<IntakePriority>(['low', 'normal', 'high', 'urgent']);
const INTAKE_DATA_CLASSES = new Set<IntakeDataClass>(['public', 'internal', 'private', 'sensitive']);
const ASSISTANT_READINESS_STATUSES = new Set(['not-applicable', 'candidate', 'ready', 'submitted', 'blocked']);
const SECRET_KEY_PATTERN = /(secret|token|password|credential|cookie|authorization|signed[_-]?url|api[_-]?key|oauth)/i;
const SECRET_VALUE_PATTERN = /(x-amz-signature|x-amz-credential|x-amz-security-token|access_token=|token=|api[_-]?key|password=|secret=|credential=|bearer\s+[a-z0-9._-]+|ghp_[a-z0-9_]+|sk-[a-z0-9_-]+)/i;
const URL_PATTERN = /https?:\/\/[^\s<>"')]+/gi;

function jsonResponse(statusCode: number, body: unknown): LambdaResponse {
  return {
    statusCode,
    headers: JSON_HEADERS,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

function parseBody(event: LambdaEvent): Record<string, unknown> | null {
  if (!event.body) return null;
  if (typeof event.body === 'object') return event.body as Record<string, unknown>;
  try {
    return JSON.parse(event.body);
  } catch {
    return null;
  }
}

function headerValue(headers: Record<string, string> | null | undefined, name: string): string {
  if (!headers) return '';
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match ? String(match[1]) : '';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function boundedString(value: unknown, maxLength: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

function redactText(value: unknown, maxLength: number): string {
  const text = boundedString(value, maxLength);
  return text.replace(SECRET_VALUE_PATTERN, '[redacted]');
}

function containsSecret(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return SECRET_VALUE_PATTERN.test(value);
  if (Array.isArray(value)) return value.some(containsSecret);
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(([key, child]) => (
      SECRET_KEY_PATTERN.test(key) || containsSecret(child)
    ));
  }
  return false;
}

function cloneJson(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('metadata must be an object');
  }
  const json = JSON.stringify(value);
  if (json.length > 4096) throw new Error('metadata must be 4096 bytes or less');
  if (containsSecret(value)) throw new Error('metadata must not contain secrets or signed URLs');
  return JSON.parse(json) as Record<string, unknown>;
}

function sanitizeActor(value: unknown): IntakeSourceActor | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('sourceActor must be an object');
  const record = value as Record<string, unknown>;
  const actor: IntakeSourceActor = {};
  if (record.name !== undefined) actor.name = redactText(record.name, 120);
  if (record.handle !== undefined) actor.handle = redactText(record.handle, 120);
  if (record.email !== undefined) actor.email = redactText(record.email, 160);
  if (record.chatId !== undefined) actor.chatId = redactText(record.chatId, 120);
  if (record.userId !== undefined) actor.userId = redactText(record.userId, 120);
  if (record.metadata !== undefined) actor.metadata = cloneJson(record.metadata);
  const json = JSON.stringify(actor);
  if (json.length > 2048) throw new Error('sourceActor must be 2048 bytes or less');
  return actor;
}

function normalizeUrl(value: string): string {
  const url = new URL(value);
  url.hash = '';
  return url.toString();
}

function sanitizeUrl(value: unknown, fieldName = 'url'): string {
  if (!isNonEmptyString(value)) throw new Error(`${fieldName} is required`);
  const text = value.trim();
  if (SECRET_VALUE_PATTERN.test(text)) throw new Error(`${fieldName} must not contain tokens, credentials, or signed URLs`);
  try {
    return normalizeUrl(text);
  } catch {
    throw new Error(`${fieldName} must be a valid URL`);
  }
}

function sanitizeStorageUri(value: unknown, fieldName: string): string {
  if (!isNonEmptyString(value)) throw new Error(`${fieldName} is required`);
  const text = value.trim();
  if (text.length > 512) throw new Error(`${fieldName} must be 512 characters or fewer`);
  if (SECRET_VALUE_PATTERN.test(text)) throw new Error(`${fieldName} must not contain tokens, credentials, or signed URLs`);
  if (/^(https?:\/\/|s3:\/\/|local-dev:\/\/)/.test(text)) return text;
  throw new Error(`${fieldName} must be a stable http(s), s3, or local-dev storage URI`);
}

function extractLinkRefs(text: string): IntakeLinkRef[] {
  const seen = new Set<string>();
  const links: IntakeLinkRef[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    try {
      const normalizedUrl = sanitizeUrl(match[0]);
      if (seen.has(normalizedUrl)) continue;
      seen.add(normalizedUrl);
      links.push({ url: normalizedUrl, normalizedUrl, safetyStatus: 'unchecked' });
    } catch {
      continue;
    }
  }
  return links;
}

function sanitizeLinkRefs(value: unknown, fallbackText = ''): IntakeLinkRef[] {
  const links: IntakeLinkRef[] = [];
  const seen = new Set<string>();
  const input = value === undefined ? extractLinkRefs(fallbackText) : value;
  if (input === undefined || input === null) return links;
  if (!Array.isArray(input)) throw new Error('linkRefs must be an array');
  if (JSON.stringify(input).length > 4096) throw new Error('linkRefs must be 4096 bytes or less');
  for (const [index, ref] of input.entries()) {
    if (ref === null || typeof ref !== 'object' || Array.isArray(ref)) throw new Error(`linkRefs[${index}] must be an object`);
    const record = ref as Record<string, unknown>;
    const normalizedUrl = sanitizeUrl(record.url, `linkRefs[${index}].url`);
    if (seen.has(normalizedUrl)) continue;
    seen.add(normalizedUrl);
    links.push({
      url: normalizedUrl,
      normalizedUrl: isNonEmptyString(record.normalizedUrl) ? sanitizeUrl(record.normalizedUrl, `linkRefs[${index}].normalizedUrl`) : normalizedUrl,
      title: record.title === undefined ? undefined : redactText(record.title, 160),
      type: record.type === undefined ? undefined : redactText(record.type, 60),
      safetyStatus: isNonEmptyString(record.safetyStatus) ? boundedString(record.safetyStatus, 40) : 'unchecked',
    });
  }
  return links;
}

function sanitizeFileRefs(value: unknown): IntakeFileRef[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('fileRefs must be an array');
  if (JSON.stringify(value).length > 4096) throw new Error('fileRefs must be 4096 bytes or less');
  return value.map((ref, index) => {
    if (ref === null || typeof ref !== 'object' || Array.isArray(ref)) throw new Error(`fileRefs[${index}] must be an object`);
    const record = ref as Record<string, unknown>;
    const storageUri = record.storageUri === undefined ? undefined : sanitizeStorageUri(record.storageUri, `fileRefs[${index}].storageUri`);
    return {
      fileId: record.fileId === undefined ? undefined : boundedString(record.fileId, 120),
      filename: record.filename === undefined ? undefined : redactText(record.filename, 180),
      storageUri,
      storageProvider: record.storageProvider === undefined ? undefined : boundedString(record.storageProvider, 80),
      contentType: record.contentType === undefined ? undefined : boundedString(record.contentType, 120),
      checksum: record.checksum === undefined ? undefined : boundedString(record.checksum, 160),
      sizeBytes: typeof record.sizeBytes === 'number' && Number.isFinite(record.sizeBytes) ? record.sizeBytes : undefined,
      title: record.title === undefined ? undefined : redactText(record.title, 160),
      metadata: record.metadata === undefined ? undefined : cloneJson(record.metadata),
    };
  });
}

function stringArray(value: unknown, fieldName: string, maxLength = 60): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${fieldName} must be an array of strings`);
  }
  return Array.from(new Set(value.map((item) => boundedString(item, maxLength)).filter(Boolean)));
}

function appendHistory(item: IntakeItem | null, action: string, data: {
  actorId?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
} = {}): IntakeHistoryEvent[] {
  const existing = Array.isArray(item?.history) ? item.history : [];
  return existing.concat({
    id: crypto.randomUUID(),
    action,
    actorId: data.actorId,
    reason: data.reason,
    metadata: data.metadata,
    createdAt: data.createdAt || new Date().toISOString(),
  });
}

function intakeRef(item: IntakeItem): IntakeRef {
  return {
    intakeItemId: item.id,
    source: item.source,
    title: item.title,
    status: item.status,
  };
}

function mergeIntakeRefs(refs: IntakeRef[] | undefined, ref: IntakeRef): IntakeRef[] {
  const existing = Array.isArray(refs) ? refs : [];
  return existing.filter((item) => item.intakeItemId !== ref.intakeItemId).concat(ref);
}

function mergeAssistantJobRefs(refs: AssistantJobRef[] | undefined, ref: AssistantJobRef): AssistantJobRef[] {
  const existing = Array.isArray(refs) ? refs : [];
  return existing.filter((item) => item.assistantJobId !== ref.assistantJobId).concat(ref);
}

function mergeStrings(existing: string[] | undefined, additions: string[]): string[] {
  return Array.from(new Set((Array.isArray(existing) ? existing : []).concat(additions).filter(Boolean)));
}

function validateTimestamp(value: unknown, fieldName: string, required = false): string | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error(`${fieldName} is required`);
    return undefined;
  }
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${fieldName} must be a parseable timestamp`);
  }
  return value;
}

function sanitizeBasePayload(body: Record<string, unknown>, actorId?: string): Record<string, unknown> {
  const note = typeof body.note === 'string' ? body.note : '';
  const title = redactText(body.title || body.subject || note.split(/\r?\n/)[0] || 'Untitled intake', 160);
  const summary = redactText(body.summary || note || title, 1000);
  if (!title) throw new Error('title is required');
  if (!summary) throw new Error('summary is required');

  const source = isNonEmptyString(body.source) && INTAKE_SOURCES.has(body.source as IntakeSource)
    ? body.source as IntakeSource
    : 'manual';
  const status = isNonEmptyString(body.status) && INTAKE_STATUSES.has(body.status as IntakeStatus)
    ? body.status as IntakeStatus
    : 'new';
  const priority = isNonEmptyString(body.priority) && INTAKE_PRIORITIES.has(body.priority as IntakePriority)
    ? body.priority as IntakePriority
    : 'normal';
  const dataClass = isNonEmptyString(body.dataClass) && INTAKE_DATA_CLASSES.has(body.dataClass as IntakeDataClass)
    ? body.dataClass as IntakeDataClass
    : 'internal';

  const bodyRef = body.bodyRef === undefined ? undefined : sanitizeStorageUri(body.bodyRef, 'bodyRef');
  const sourceActor = sanitizeActor(body.sourceActor);
  const receivedChannels = stringArray(body.receivedChannels || [source], 'receivedChannels');
  const linkRefs = sanitizeLinkRefs(body.linkRefs, `${title}\n${summary}`);
  const fileRefs = sanitizeFileRefs(body.fileRefs);
  const metadata = body.metadata === undefined ? undefined : cloneJson(body.metadata);

  return {
    source,
    sourceMessageId: isNonEmptyString(body.sourceMessageId) ? boundedString(body.sourceMessageId, 160) : undefined,
    sourceThreadId: isNonEmptyString(body.sourceThreadId) ? boundedString(body.sourceThreadId, 160) : undefined,
    sourceReceivedAt: validateTimestamp(body.sourceReceivedAt, 'sourceReceivedAt') || new Date().toISOString(),
    createdBy: isNonEmptyString(body.createdBy) ? body.createdBy : actorId,
    triagedBy: isNonEmptyString(body.triagedBy) ? body.triagedBy : undefined,
    ownerId: isNonEmptyString(body.ownerId) ? body.ownerId : undefined,
    assigneeId: isNonEmptyString(body.assigneeId) ? body.assigneeId : undefined,
    status,
    title,
    summary,
    bodyRef,
    sourceActor,
    receivedChannels,
    linkRefs,
    fileRefs,
    artifactRefs: Array.isArray(body.artifactRefs) ? body.artifactRefs : [],
    taskIds: stringArray(body.taskIds, 'taskIds', 120),
    bundleIds: stringArray(body.bundleIds, 'bundleIds', 120),
    assistantJobIds: stringArray(body.assistantJobIds, 'assistantJobIds', 120),
    relatedIntakeItemIds: stringArray(body.relatedIntakeItemIds, 'relatedIntakeItemIds', 120),
    tags: stringArray(body.tags, 'tags'),
    priority,
    dataClass,
    metadata,
    history: [],
  };
}

async function mirrorIntakeRef(client: DynamoDBDocumentClient, item: IntakeItem): Promise<void> {
  const ref = intakeRef(item);
  for (const taskId of item.taskIds || []) {
    const task = await getTask(client, taskId);
    if (task) await updateTask(client, taskId, { intakeRefs: mergeIntakeRefs(task.intakeRefs, ref) });
  }
  for (const bundleId of item.bundleIds || []) {
    const bundle = await getBundle(client, bundleId);
    if (bundle) await updateBundle(client, bundleId, { intakeRefs: mergeIntakeRefs(bundle.intakeRefs, ref) });
  }
}

function buildAssistantInputRefs(item: IntakeItem): AssistantJobInputRef[] {
  const refs: AssistantJobInputRef[] = [];
  refs.push({
    type: 'source-message',
    id: item.id,
    title: item.title,
    metadata: {
      source: item.source,
      sourceMessageId: item.sourceMessageId,
      bodyRef: item.bodyRef,
    },
  });
  for (const link of item.linkRefs || []) refs.push({ type: 'url', uri: link.normalizedUrl || link.url, title: link.title || item.title });
  for (const file of item.fileRefs || []) refs.push({ type: 'file', id: file.fileId, uri: file.storageUri, title: file.title || file.filename });
  for (const artifact of item.artifactRefs || []) refs.push({ type: 'artifact', id: artifact.artifactId, uri: artifact.storageUri, title: artifact.title });
  for (const taskId of item.taskIds || []) refs.push({ type: 'task', id: taskId });
  for (const bundleId of item.bundleIds || []) refs.push({ type: 'bundle', id: bundleId });
  return refs
    .filter((ref) => ref.id || ref.uri || ref.type === 'source-message')
    .map((ref) => {
      const clean: AssistantJobInputRef = { type: ref.type };
      if (ref.id) clean.id = ref.id;
      if (ref.uri) clean.uri = ref.uri;
      if (ref.title) clean.title = ref.title;
      if (ref.metadata) clean.metadata = Object.fromEntries(Object.entries(ref.metadata).filter(([, value]) => value !== undefined));
      return clean;
    });
}

function readinessFromBody(item: IntakeItem, body: Record<string, unknown>): IntakeAssistantReadiness {
  const assistantType = isNonEmptyString(body.assistantType) ? boundedString(body.assistantType, 80) : item.assistantReadiness?.assistantType;
  const inputRefs = buildAssistantInputRefs(item);
  const missingFields: string[] = [];
  if (!assistantType) missingFields.push('assistantType');
  if (inputRefs.length === 0) missingFields.push('inputRefs');
  const requestedStatus = isNonEmptyString(body.status) && ASSISTANT_READINESS_STATUSES.has(body.status)
    ? body.status
    : undefined;
  const status = requestedStatus || (missingFields.length ? 'blocked' : 'ready');
  return {
    assistantType,
    status: status as IntakeAssistantReadiness['status'],
    inputRefs,
    missingFields,
  };
}

async function attachItem(client: DynamoDBDocumentClient, item: IntakeItem, body: Record<string, unknown>, actorId?: string): Promise<IntakeItem> {
  const taskIds = mergeStrings(item.taskIds, stringArray(body.taskIds || (body.taskId ? [body.taskId] : []), 'taskIds', 120));
  const bundleIds = mergeStrings(item.bundleIds, stringArray(body.bundleIds || (body.bundleId ? [body.bundleId] : []), 'bundleIds', 120));
  if (taskIds.length === item.taskIds.length && bundleIds.length === item.bundleIds.length) throw new Error('taskIds or bundleIds are required');
  for (const taskId of taskIds) {
    if (!await getTask(client, taskId)) throw new Error(`Task not found: ${taskId}`);
  }
  for (const bundleId of bundleIds) {
    if (!await getBundle(client, bundleId)) throw new Error(`Bundle not found: ${bundleId}`);
  }
  const updated = await updateIntakeItem(client, item.id, {
    taskIds,
    bundleIds,
    status: 'attached',
    triagedAt: item.triagedAt || new Date().toISOString(),
    triagedBy: actorId || item.triagedBy,
    history: appendHistory(item, 'attached', { actorId, metadata: { taskIds, bundleIds } }),
  }) as IntakeItem;
  await mirrorIntakeRef(client, updated);
  return updated;
}

async function detachItem(client: DynamoDBDocumentClient, item: IntakeItem, body: Record<string, unknown>, actorId?: string): Promise<IntakeItem> {
  const removeTaskIds = stringArray(body.taskIds || (body.taskId ? [body.taskId] : []), 'taskIds', 120);
  const removeBundleIds = stringArray(body.bundleIds || (body.bundleId ? [body.bundleId] : []), 'bundleIds', 120);
  const taskIds = (item.taskIds || []).filter((id) => !removeTaskIds.includes(id));
  const bundleIds = (item.bundleIds || []).filter((id) => !removeBundleIds.includes(id));
  return await updateIntakeItem(client, item.id, {
    taskIds,
    bundleIds,
    status: taskIds.length || bundleIds.length ? item.status : 'triaged',
    history: appendHistory(item, 'detached', { actorId, metadata: { taskIds: removeTaskIds, bundleIds: removeBundleIds } }),
  }) as IntakeItem;
}

async function convertToTask(client: DynamoDBDocumentClient, item: IntakeItem, body: Record<string, unknown>, actorId?: string): Promise<{ item: IntakeItem; task: Task }> {
  const date = isNonEmptyString(body.date) ? body.date : new Date().toISOString().slice(0, 10);
  if (Number.isNaN(Date.parse(date))) throw new Error('date must be a valid date');
  const taskData: Record<string, unknown> = {
    description: redactText(body.description || item.title, 240),
    date,
    source: 'intake',
    tags: mergeStrings(item.tags, stringArray(body.tags, 'tags')),
    assigneeId: isNonEmptyString(body.assigneeId) ? body.assigneeId : item.assigneeId,
    bundleId: isNonEmptyString(body.bundleId) ? body.bundleId : item.bundleIds[0],
    intakeRefs: [intakeRef(item)],
  };
  if (body.proofRequirement !== undefined) taskData.proofRequirement = body.proofRequirement;
  if (body.requiredLinkName !== undefined) taskData.requiredLinkName = body.requiredLinkName;
  if (body.link !== undefined) taskData.link = sanitizeUrl(body.link, 'link');
  if (item.artifactRefs.length > 0) taskData.artifactRefs = item.artifactRefs;
  const task = await createTask(client, taskData);
  const updated = await updateIntakeItem(client, item.id, {
    taskIds: mergeStrings(item.taskIds, [task.id]),
    bundleIds: task.bundleId ? mergeStrings(item.bundleIds, [task.bundleId]) : item.bundleIds,
    status: 'converted',
    triagedAt: item.triagedAt || new Date().toISOString(),
    triagedBy: actorId || item.triagedBy,
    history: appendHistory(item, 'converted-to-task', { actorId, metadata: { taskId: task.id, bundleId: task.bundleId } }),
  }) as IntakeItem;
  await mirrorIntakeRef(client, updated);
  return { item: updated, task };
}

async function markResolved(item: IntakeItem, status: IntakeStatus, body: Record<string, unknown>, actorId?: string): Promise<IntakeItem> {
  const reason = redactText(body.reason || body.resolutionReason, 300);
  if (!reason) throw new Error('reason is required');
  const updates: Record<string, unknown> = {
    status,
    resolutionReason: reason,
    triagedAt: item.triagedAt || new Date().toISOString(),
    triagedBy: actorId || item.triagedBy,
    history: appendHistory(item, status, { actorId, reason }),
  };
  if (status === 'archived') updates.archivedAt = new Date().toISOString();
  return await updateIntakeItemFromItem(item, updates);
}

async function updateIntakeItemFromItem(item: IntakeItem, updates: Record<string, unknown>): Promise<IntakeItem> {
  throw new Error(`updateIntakeItemFromItem not initialized for ${item.id}`);
}

async function handleIntakeRoutes(event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse | null> {
  const method = event.httpMethod || 'GET';
  const reqPath = event.path || '/';
  const actorId = headerValue(event.headers, 'x-user-id') || undefined;

  async function writeItem(item: IntakeItem, updates: Record<string, unknown>): Promise<IntakeItem> {
    const updated = await updateIntakeItem(client, item.id, updates);
    return updated as IntakeItem;
  }

  if (method === 'POST' && reqPath === '/api/intake') {
    const body = parseBody(event);
    if (!body) return jsonResponse(400, { error: 'Request body is required' });
    try {
      const data = sanitizeBasePayload(body, actorId);
      const history = appendHistory(null, data.source === 'manual' ? 'manual-created' : 'created', { actorId });
      const item = await createIntakeItem(client, { ...data, history });
      let attached = item;
      if (item.taskIds.length || item.bundleIds.length) {
        attached = await updateIntakeItem(client, item.id, {
          status: 'attached',
          triagedAt: item.triagedAt || new Date().toISOString(),
          triagedBy: actorId || item.triagedBy,
          history: appendHistory(item, 'attached', { actorId, metadata: { taskIds: item.taskIds, bundleIds: item.bundleIds } }),
        }) as IntakeItem;
        await mirrorIntakeRef(client, attached);
      }
      return jsonResponse(201, { item: attached });
    } catch (err) {
      return jsonResponse(400, { error: (err as Error).message });
    }
  }

  if (method === 'GET' && reqPath === '/api/intake') {
    const params = event.queryStringParameters || {};
    const items = await listIntakeItems(client, {
      status: params.status,
      source: params.source,
      ownerId: params.ownerId,
      assigneeId: params.assigneeId,
      priority: params.priority,
      tag: params.tag,
      taskId: params.taskId,
      bundleId: params.bundleId,
      assistantReadinessStatus: params.assistantReadinessStatus || params.assistantStatus,
      duplicateState: params.duplicateState,
      from: params.from,
      to: params.to,
    });
    return jsonResponse(200, { items });
  }

  const assistantBatchMatch = reqPath === '/api/intake/assistant-inputs';
  if (method === 'POST' && assistantBatchMatch) {
    const body = parseBody(event);
    if (!body) return jsonResponse(400, { error: 'Request body is required' });
    const ids = stringArray(body.intakeItemIds, 'intakeItemIds', 120);
    if (!ids.length) return jsonResponse(400, { error: 'intakeItemIds is required' });
    const inputRefs: AssistantJobInputRef[] = [];
    const items: IntakeItem[] = [];
    for (const id of ids) {
      const item = await getIntakeItem(client, id);
      if (!item) return jsonResponse(404, { error: `Intake item not found: ${id}` });
      items.push(item);
      inputRefs.push(...buildAssistantInputRefs(item));
    }
    return jsonResponse(200, { inputRefs, items });
  }

  const match = reqPath.match(/^\/api\/intake\/([^/]+)(?:\/([^/]+))?$/);
  if (!match) return null;
  const id = decodeURIComponent(match[1]);
  const action = match[2] || '';
  const item = await getIntakeItem(client, id);
  if (!item) return jsonResponse(404, { error: 'Intake item not found' });

  if (method === 'GET' && !action) {
    return jsonResponse(200, { item });
  }

  if (method === 'PUT' && !action) {
    const body = parseBody(event);
    if (!body) return jsonResponse(400, { error: 'Request body is required' });
    const updates: Record<string, unknown> = {};
    try {
      if (body.title !== undefined) updates.title = redactText(body.title, 160);
      if (body.summary !== undefined) updates.summary = redactText(body.summary, 1000);
      if (body.status !== undefined) {
        if (!INTAKE_STATUSES.has(String(body.status) as IntakeStatus)) throw new Error('Invalid status');
        updates.status = body.status;
        if (body.status === 'triaged') {
          updates.triagedAt = item.triagedAt || new Date().toISOString();
          updates.triagedBy = actorId || item.triagedBy;
        }
      }
      if (body.ownerId !== undefined) updates.ownerId = isNonEmptyString(body.ownerId) ? body.ownerId : undefined;
      if (body.assigneeId !== undefined) updates.assigneeId = isNonEmptyString(body.assigneeId) ? body.assigneeId : undefined;
      if (body.priority !== undefined) {
        if (!INTAKE_PRIORITIES.has(String(body.priority) as IntakePriority)) throw new Error('Invalid priority');
        updates.priority = body.priority;
      }
      if (body.dataClass !== undefined) {
        if (!INTAKE_DATA_CLASSES.has(String(body.dataClass) as IntakeDataClass)) throw new Error('Invalid dataClass');
        updates.dataClass = body.dataClass;
      }
      if (body.tags !== undefined) updates.tags = stringArray(body.tags, 'tags');
      if (body.metadata !== undefined) updates.metadata = cloneJson(body.metadata);
      if (body.followUpAt !== undefined) updates.followUpAt = validateTimestamp(body.followUpAt, 'followUpAt');
      updates.history = appendHistory(item, 'updated', { actorId });
      const updated = await writeItem(item, updates);
      return jsonResponse(200, { item: updated });
    } catch (err) {
      return jsonResponse(400, { error: (err as Error).message });
    }
  }

  const body = method === 'POST' ? parseBody(event) || {} : {};

  try {
    if (method === 'POST' && action === 'attach') return jsonResponse(200, { item: await attachItem(client, item, body, actorId) });
    if (method === 'POST' && action === 'detach') return jsonResponse(200, { item: await detachItem(client, item, body, actorId) });
    if (method === 'POST' && action === 'convert-task') return jsonResponse(201, await convertToTask(client, item, body, actorId));

    if (method === 'POST' && action === 'mark-duplicate') {
      const reason = redactText(body.reason, 300);
      const duplicateOfIntakeItemId = boundedString(body.duplicateOfIntakeItemId, 120);
      if (!reason) return jsonResponse(400, { error: 'reason is required' });
      if (!duplicateOfIntakeItemId) return jsonResponse(400, { error: 'duplicateOfIntakeItemId is required' });
      if (!await getIntakeItem(client, duplicateOfIntakeItemId)) return jsonResponse(404, { error: 'Duplicate target not found' });
      const updated = await writeItem(item, {
        status: 'duplicate',
        duplicateOfIntakeItemId,
        resolutionReason: reason,
        triagedAt: item.triagedAt || new Date().toISOString(),
        triagedBy: actorId || item.triagedBy,
        history: appendHistory(item, 'duplicate', { actorId, reason, metadata: { duplicateOfIntakeItemId } }),
      });
      return jsonResponse(200, { item: updated });
    }

    if (method === 'POST' && (action === 'ignore' || action === 'archive')) {
      const reason = redactText(body.reason || body.resolutionReason, 300);
      if (!reason) return jsonResponse(400, { error: 'reason is required' });
      const status = action === 'ignore' ? 'ignored' : 'archived';
      const updated = await writeItem(item, {
        status,
        resolutionReason: reason,
        archivedAt: status === 'archived' ? new Date().toISOString() : item.archivedAt,
        triagedAt: item.triagedAt || new Date().toISOString(),
        triagedBy: actorId || item.triagedBy,
        history: appendHistory(item, status, { actorId, reason }),
      });
      return jsonResponse(200, { item: updated });
    }

    if (method === 'POST' && action === 'block') {
      const reason = redactText(body.reason || body.blockedReason, 300);
      if (!reason) return jsonResponse(400, { error: 'reason is required' });
      const waitingFor = body.waitingFor === undefined ? item.waitingFor : redactText(body.waitingFor, 160);
      const followUpAt = body.followUpAt === undefined ? item.followUpAt : validateTimestamp(body.followUpAt, 'followUpAt');
      const updated = await writeItem(item, {
        status: 'blocked',
        blockedReason: reason,
        waitingFor,
        followUpAt,
        lastFollowUpAt: item.followUpAt,
        triagedAt: item.triagedAt || new Date().toISOString(),
        triagedBy: actorId || item.triagedBy,
        history: appendHistory(item, 'blocked', { actorId, reason, metadata: { waitingFor, followUpAt } }),
      });
      return jsonResponse(200, { item: updated });
    }

    if (method === 'POST' && action === 'register-ref') {
      const kind = isNonEmptyString(body.kind) ? body.kind : '';
      const updates: Record<string, unknown> = {};
      if (kind === 'link') updates.linkRefs = mergeLinkRefs(item.linkRefs, sanitizeLinkRefs([body.ref]));
      else if (kind === 'file') updates.fileRefs = item.fileRefs.concat(sanitizeFileRefs([body.ref]));
      else if (kind === 'artifact') updates.artifactRefs = item.artifactRefs.concat(body.ref as any);
      else return jsonResponse(400, { error: 'kind must be link, file, or artifact' });
      updates.history = appendHistory(item, 'reference-registered', { actorId, metadata: { kind } });
      return jsonResponse(200, { item: await writeItem(item, updates) });
    }

    if (method === 'POST' && action === 'prepare-assistant') {
      const readiness = readinessFromBody(item, body);
      const updates: Record<string, unknown> = {
        assistantReadiness: readiness,
        history: appendHistory(item, 'assistant-input-prepared', { actorId, metadata: { assistantType: readiness.assistantType, status: readiness.status } }),
      };
      let assistantJobId: string | undefined;
      if (body.createJob === true) {
        if (!readiness.assistantType || readiness.missingFields.length) return jsonResponse(400, { error: 'Assistant input is not ready' });
        const taskId = isNonEmptyString(body.taskId) ? body.taskId : item.taskIds[0];
        const bundleId = isNonEmptyString(body.bundleId) ? body.bundleId : item.bundleIds[0];
        if (!taskId && !bundleId) return jsonResponse(400, { error: 'taskId or bundleId is required to create an assistant job' });
        const job = await createAssistantJob(client, {
          assistantType: readiness.assistantType,
          title: redactText(body.title || `Assistant input: ${item.title}`, 180),
          status: body.submit === true ? 'queued' : 'draft',
          taskId,
          bundleId,
          requestedBy: actorId,
          inputRefs: readiness.inputRefs,
          approvalRequired: body.approvalRequired !== false,
          queuedAt: body.submit === true ? new Date().toISOString() : undefined,
        });
        assistantJobId = job.id;
        await appendAssistantJobEvent(client, {
          assistantJobId: job.id,
          actorId,
          action: body.submit === true ? 'queued' : 'created',
          summary: body.submit === true ? 'Assistant job queued from intake input' : 'Assistant job drafted from intake input',
          metadata: { intakeItemId: item.id },
        });
        if (taskId) {
          const task = await getTask(client, taskId);
          if (task) await updateTask(client, taskId, { assistantJobRefs: mergeAssistantJobRefs(task.assistantJobRefs, { assistantJobId: job.id, assistantType: job.assistantType, status: job.status }) });
        }
        if (bundleId) {
          const bundle = await getBundle(client, bundleId);
          if (bundle) await updateBundle(client, bundleId, { assistantJobRefs: mergeAssistantJobRefs(bundle.assistantJobRefs, { assistantJobId: job.id, assistantType: job.assistantType, status: job.status }) });
        }
        updates.assistantJobIds = mergeStrings(item.assistantJobIds, [job.id]);
        updates.assistantReadiness = { ...readiness, status: body.submit === true ? 'submitted' : readiness.status };
        updates.history = appendHistory(item, body.submit === true ? 'assistant-job-queued' : 'assistant-job-created', { actorId, metadata: { assistantJobId: job.id } });
      }
      const updated = await writeItem(item, updates);
      return jsonResponse(200, { item: updated, inputRefs: readiness.inputRefs, assistantJobId });
    }
  } catch (err) {
    const message = (err as Error).message;
    if (message.includes('not found') || message.includes('Not found')) return jsonResponse(404, { error: message });
    return jsonResponse(400, { error: message });
  }

  return jsonResponse(404, { error: 'Not found' });
}

function mergeLinkRefs(existing: IntakeLinkRef[] | undefined, additions: IntakeLinkRef[]): IntakeLinkRef[] {
  const result = Array.isArray(existing) ? existing.slice() : [];
  const seen = new Set(result.map((ref) => ref.normalizedUrl || ref.url));
  for (const ref of additions) {
    const key = ref.normalizedUrl || ref.url;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ref);
  }
  return result;
}

function telegramActor(message: Record<string, unknown>): IntakeSourceActor {
  const from = message.from && typeof message.from === 'object' && !Array.isArray(message.from)
    ? message.from as Record<string, unknown>
    : {};
  const chat = message.chat && typeof message.chat === 'object' && !Array.isArray(message.chat)
    ? message.chat as Record<string, unknown>
    : {};
  return {
    name: redactText([from.first_name, from.last_name].filter(Boolean).join(' ') || chat.title || 'Telegram sender', 120),
    handle: from.username ? `@${redactText(from.username, 100)}` : undefined,
    userId: from.id === undefined ? undefined : String(from.id),
    chatId: chat.id === undefined ? undefined : String(chat.id),
  };
}

async function createTelegramIntake(
  client: DynamoDBDocumentClient,
  update: Record<string, unknown>
): Promise<IntakeItem | null> {
  const message = update.message && typeof update.message === 'object' && !Array.isArray(update.message)
    ? update.message as Record<string, unknown>
    : null;
  if (!message) return null;
  const chat = message.chat && typeof message.chat === 'object' && !Array.isArray(message.chat)
    ? message.chat as Record<string, unknown>
    : {};
  const sourceMessageId = message.message_id === undefined
    ? undefined
    : `${chat.id === undefined ? 'unknown-chat' : String(chat.id)}:${String(message.message_id)}`;
  if (sourceMessageId) {
    const existing = await findIntakeBySourceMessage(client, 'telegram', sourceMessageId);
    if (existing) return existing;
  }
  const text = typeof message.text === 'string' ? message.text : typeof message.caption === 'string' ? message.caption : '';
  const title = text.split(/\r?\n/)[0] || 'Telegram intake';
  const channels = ['telegram'];
  for (const key of ['voice', 'document', 'photo', 'video']) {
    if (message[key]) channels.push(key);
  }
  return await createIntakeItem(client, {
    source: 'telegram',
    sourceMessageId,
    sourceThreadId: message.message_thread_id === undefined ? undefined : String(message.message_thread_id),
    sourceReceivedAt: typeof message.date === 'number' ? new Date(message.date * 1000).toISOString() : new Date().toISOString(),
    status: 'new',
    title: redactText(title || 'Telegram intake', 160),
    summary: redactText(text || 'Telegram message with attachment metadata', 1000),
    sourceActor: telegramActor(message),
    receivedChannels: Array.from(new Set(channels)),
    linkRefs: extractLinkRefs(text),
    metadata: {
      hasText: Boolean(text),
      hasAttachments: channels.length > 1,
    },
    history: appendHistory(null, 'telegram-created', { metadata: { sourceMessageId } }),
  });
}

async function createEmailIntake(
  client: DynamoDBDocumentClient,
  payload: Record<string, unknown>
): Promise<IntakeItem> {
  const bodyText = typeof payload.body === 'string' ? payload.body : '';
  const subject = typeof payload.subject === 'string' ? payload.subject : 'Email intake';
  const sourceMessageId = isNonEmptyString(payload.messageId) ? payload.messageId : isNonEmptyString(payload.id) ? payload.id : undefined;
  if (sourceMessageId) {
    const existing = await findIntakeBySourceMessage(client, 'email', sourceMessageId);
    if (existing) return existing;
  }
  return await createIntakeItem(client, {
    source: 'email',
    sourceMessageId,
    sourceThreadId: isNonEmptyString(payload.threadId) ? payload.threadId : undefined,
    sourceReceivedAt: validateTimestamp(payload.receivedAt, 'receivedAt') || new Date().toISOString(),
    status: 'new',
    title: redactText(subject, 160),
    summary: redactText(bodyText || subject, 1000),
    sourceActor: {
      email: redactText(payload.from, 160),
      name: payload.fromName === undefined ? undefined : redactText(payload.fromName, 120),
    },
    receivedChannels: ['email'],
    linkRefs: extractLinkRefs(`${subject}\n${bodyText}`),
    metadata: {
      hasBody: Boolean(bodyText),
      attachmentCount: Array.isArray(payload.attachments) ? payload.attachments.length : 0,
    },
    history: appendHistory(null, 'email-created', { metadata: { sourceMessageId } }),
  });
}

export {
  createEmailIntake,
  createTelegramIntake,
  handleIntakeRoutes,
};
