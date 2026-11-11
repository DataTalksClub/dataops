import { randomUUID } from 'node:crypto';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import {
  MATERIALS_INBOX_TAG,
  createIntakeItemIfAbsent,
  getIntakeItem,
  listMaterialsInboxItems,
  updateIntakeItem,
} from '../db/intake';
import { resolveInteractiveActor } from '../identity/actor';
import { noStoreJson as json } from '../http';
import type { IntakeItem, IntakeStatus, LambdaEvent, LambdaResponse } from '../types';

export const INBOX_UNPROCESSED_STATUSES: IntakeStatus[] = ['new', 'triaged', 'blocked'];
const INBOX_STATUSES: IntakeStatus[] = [
  'new', 'triaged', 'attached', 'converted', 'ignored', 'duplicate', 'blocked', 'archived',
];
const INBOX_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
const INBOX_DATA_CLASSES = ['public', 'internal', 'private', 'sensitive'] as const;
const MAX_BODY_BYTES = 250000;
const MAX_METADATA_BYTES = 4096;
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

function isUnprocessed(status: string): boolean {
  return (INBOX_UNPROCESSED_STATUSES as string[]).includes(status);
}

function deriveSummary(body: string, title: string): string {
  const firstLine = body.split('\n').map((line) => line.trim()).find((line) => line.length > 0) || '';
  const candidate = firstLine.replace(/^#+\s*/, '').trim() || title;
  return candidate.length > 200 ? `${candidate.slice(0, 197)}...` : candidate;
}

function validateMetadata(value: unknown): string | null {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'metadata must be an object';
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_METADATA_BYTES) {
    return `metadata must be ${MAX_METADATA_BYTES} bytes or less`;
  }
  return null;
}

function statusRequirements(status: IntakeStatus, body: Record<string, unknown>): string | null {
  if (status === 'duplicate') {
    if (typeof body.duplicateOfIntakeItemId !== 'string' || !body.duplicateOfIntakeItemId.trim()) {
      return 'duplicateOfIntakeItemId is required when status is duplicate';
    }
    if (typeof body.resolutionReason !== 'string' || !body.resolutionReason.trim()) {
      return 'resolutionReason is required when status is duplicate';
    }
  }
  if (status === 'ignored' || status === 'archived') {
    if (typeof body.resolutionReason !== 'string' || !body.resolutionReason.trim()) {
      return `resolutionReason is required when status is ${status}`;
    }
  }
  if (status === 'blocked') {
    if (typeof body.blockedReason !== 'string' || !body.blockedReason.trim()) return 'blockedReason is required when status is blocked';
    if (typeof body.waitingFor !== 'string' || !body.waitingFor.trim()) return 'waitingFor is required when status is blocked';
    if (typeof body.followUpAt !== 'string' || !body.followUpAt.trim()) return 'followUpAt is required when status is blocked';
  }
  return null;
}

function publicItem(item: IntakeItem): IntakeItem {
  return item;
}

function listSummary(item: IntakeItem): Omit<IntakeItem, 'bodyRef'> {
  const { bodyRef: _bodyRef, ...rest } = item;
  return rest;
}

async function handleList(event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  const actor = await resolveInteractiveActor(client, event, 'work-read');
  if (!actor.ok) return actor.response;
  const items = await listMaterialsInboxItems(client);
  const filter = event.queryStringParameters?.status || 'all';
  const filtered = filter === 'unprocessed'
    ? items.filter((item) => isUnprocessed(item.status))
    : filter === 'processed'
      ? items.filter((item) => !isUnprocessed(item.status))
      : filter === 'all'
        ? items
        : items.filter((item) => item.status === filter);
  if (filter !== 'all' && filter !== 'unprocessed' && filter !== 'processed' && !(INBOX_STATUSES as string[]).includes(filter)) {
    return json(400, { error: 'status must be all, unprocessed, processed, or a valid intake status' });
  }
  return json(200, {
    items: filtered.map(listSummary),
    unprocessedCount: items.filter((item) => isUnprocessed(item.status)).length,
    totalCount: items.length,
  });
}

async function handleGet(id: string, event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  const actor = await resolveInteractiveActor(client, event, 'work-read');
  if (!actor.ok) return actor.response;
  const item = await getIntakeItem(client, id);
  if (!item || !item.tags.includes(MATERIALS_INBOX_TAG)) return json(404, { error: 'Inbox item not found' });
  return json(200, { item: publicItem(item) });
}

async function handleCreate(event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  const actor = await resolveInteractiveActor(client, event, 'work-write');
  if (!actor.ok) return actor.response;
  let body: Record<string, unknown>;
  try {
    body = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body as unknown as Record<string, unknown>);
  } catch { return json(400, { error: 'Invalid JSON' }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { error: 'Request body is required' });

  if (body.id !== undefined && (typeof body.id !== 'string' || !ID_PATTERN.test(body.id))) {
    return json(400, { error: 'id must match [a-zA-Z0-9][a-zA-Z0-9_-]{0,127}' });
  }
  if (typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > 160) {
    return json(400, { error: 'title must contain 1–160 characters' });
  }
  if (typeof body.body !== 'string' || !body.body.trim() || Buffer.byteLength(body.body, 'utf8') > MAX_BODY_BYTES) {
    return json(400, { error: `body must be text of 1–${MAX_BODY_BYTES} bytes` });
  }
  const title = body.title.trim();
  const content = body.body as string;
  const summary = typeof body.summary === 'string' && body.summary.trim()
    ? body.summary.trim()
    : deriveSummary(content, title);
  if (!summary || summary.length > 1000) return json(400, { error: 'summary must contain 1–1000 characters' });
  const metadataError = validateMetadata(body.metadata);
  if (metadataError) return json(400, { error: metadataError });
  if (body.priority !== undefined && !(INBOX_PRIORITIES as readonly string[]).includes(String(body.priority))) {
    return json(400, { error: 'priority must be low, normal, high, or urgent' });
  }
  if (body.dataClass !== undefined && !(INBOX_DATA_CLASSES as readonly string[]).includes(String(body.dataClass))) {
    return json(400, { error: 'dataClass must be public, internal, private, or sensitive' });
  }
  const extraTags = Array.isArray(body.tags)
    ? body.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0 && tag !== MATERIALS_INBOX_TAG)
    : [];
  if (body.tags !== undefined && !Array.isArray(body.tags)) return json(400, { error: 'tags must be an array of strings' });

  const now = new Date().toISOString();
  const id = typeof body.id === 'string' ? body.id : randomUUID();
  const history = [{
    id: randomUUID(),
    action: 'materials-inbox-created',
    actorId: actor.actor.id,
    createdAt: now,
  }];
  const reservation = await createIntakeItemIfAbsent(client, {
    id,
    source: 'manual',
    sourceMessageId: typeof body.sourceMessageId === 'string' && body.sourceMessageId.trim() ? body.sourceMessageId.trim() : undefined,
    sourceReceivedAt: now,
    status: 'new',
    title,
    summary,
    bodyRef: content,
    receivedChannels: ['manual:materials-inbox'],
    linkRefs: [],
    fileRefs: [],
    artifactRefs: [],
    taskIds: [],
    cardIds: [],
    relatedIntakeItemIds: [],
    tags: [MATERIALS_INBOX_TAG, ...extraTags],
    priority: typeof body.priority === 'string' ? body.priority : 'normal',
    dataClass: typeof body.dataClass === 'string' ? body.dataClass : 'internal',
    metadata: body.metadata === undefined ? undefined : body.metadata,
    createdBy: actor.actor.id,
    history,
    createdAt: now,
    updatedAt: now,
  });
  const statusCode = reservation.created ? 201 : 200;
  return json(statusCode, { item: publicItem(reservation.item) });
}

async function handleUpdate(id: string, event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse> {
  const actor = await resolveInteractiveActor(client, event, 'work-write');
  if (!actor.ok) return actor.response;
  const existing = await getIntakeItem(client, id);
  if (!existing || !existing.tags.includes(MATERIALS_INBOX_TAG)) return json(404, { error: 'Inbox item not found' });
  let body: Record<string, unknown>;
  try {
    body = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body as unknown as Record<string, unknown>);
  } catch { return json(400, { error: 'Invalid JSON' }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { error: 'Request body is required' });

  const updates: Record<string, unknown> = {};
  if (body.title !== undefined) {
    if (typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > 160) {
      return json(400, { error: 'title must contain 1–160 characters' });
    }
    updates.title = body.title.trim();
  }
  if (body.summary !== undefined) {
    if (typeof body.summary !== 'string' || !body.summary.trim() || body.summary.trim().length > 1000) {
      return json(400, { error: 'summary must contain 1–1000 characters' });
    }
    updates.summary = body.summary.trim();
  }
  if (body.body !== undefined) {
    if (typeof body.body !== 'string' || !body.body.trim() || Buffer.byteLength(body.body, 'utf8') > MAX_BODY_BYTES) {
      return json(400, { error: `body must be text of 1–${MAX_BODY_BYTES} bytes` });
    }
    updates.bodyRef = body.body as string;
  }
  if (body.status !== undefined) {
    if (typeof body.status !== 'string' || !(INBOX_STATUSES as string[]).includes(body.status)) {
      return json(400, { error: 'status must be a valid intake status' });
    }
    const merged = { ...existing, ...updates, ...body };
    const requirement = statusRequirements(body.status as IntakeStatus, merged);
    if (requirement) return json(400, { error: requirement });
    updates.status = body.status;
    if (body.status === 'triaged' && !existing.triagedAt) updates.triagedAt = new Date().toISOString();
    if (['archived', 'ignored', 'converted', 'attached', 'duplicate'].includes(body.status) && !existing.archivedAt) {
      updates.archivedAt = new Date().toISOString();
    }
  }
  for (const field of ['resolutionReason', 'blockedReason', 'waitingFor', 'followUpAt']) {
    if (body[field] !== undefined) {
      if (typeof body[field] !== 'string') return json(400, { error: `${field} must be a string` });
      updates[field] = (body[field] as string).trim() ? (body[field] as string).trim() : null;
    }
  }
  if (body.duplicateOfIntakeItemId !== undefined) {
    if (typeof body.duplicateOfIntakeItemId !== 'string') return json(400, { error: 'duplicateOfIntakeItemId must be a string' });
    updates.duplicateOfIntakeItemId = body.duplicateOfIntakeItemId.trim() || null;
  }
  if (body.priority !== undefined) {
    if (!(INBOX_PRIORITIES as readonly string[]).includes(String(body.priority))) {
      return json(400, { error: 'priority must be low, normal, high, or urgent' });
    }
    updates.priority = body.priority;
  }
  if (body.metadata !== undefined) {
    const metadataError = validateMetadata(body.metadata);
    if (metadataError) return json(400, { error: metadataError });
    updates.metadata = body.metadata;
  }
  if (Object.keys(updates).length === 0) return json(400, { error: 'No valid fields to update' });

  const history = [...(existing.history || []), {
    id: randomUUID(),
    action: 'materials-inbox-updated',
    actorId: actor.actor.id,
    metadata: { fields: Object.keys(updates) },
    createdAt: new Date().toISOString(),
  }];
  updates.history = history;
  updates.triagedBy = updates.status && isUnprocessed(String(updates.status)) === false
    ? actor.actor.id
    : existing.triagedBy;

  const updated = await updateIntakeItem(client, id, updates);
  if (!updated) return json(404, { error: 'Inbox item not found' });
  return json(200, { item: publicItem(updated) });
}

export async function handleInboxRoutes(event: LambdaEvent, client: DynamoDBDocumentClient): Promise<LambdaResponse | null> {
  const path = event.path || '';
  if (!path.startsWith('/api/inbox')) return null;
  const method = event.httpMethod || 'GET';
  const suffix = path.slice('/api/inbox'.length);
  if ((suffix === '' || suffix === '/') && method === 'GET') return handleList(event, client);
  if ((suffix === '' || suffix === '/') && method === 'POST') return handleCreate(event, client);
  const idMatch = suffix.match(/^\/([^/]+)\/?$/);
  if (idMatch && method === 'GET') return handleGet(decodeURIComponent(idMatch[1]), event, client);
  if (idMatch && (method === 'PUT' || method === 'PATCH')) return handleUpdate(decodeURIComponent(idMatch[1]), event, client);
  if (suffix.startsWith('/')) return json(404, { error: 'Not found' });
  return null;
}
