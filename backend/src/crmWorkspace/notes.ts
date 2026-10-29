import { randomUUID } from 'crypto';
import { DeleteCommand, PutCommand, QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { deterministicCrmId, getCrmRecord, transactCrmDependencies } from '../db/sponsorCrm';
import { TABLE_SPONSOR_CRM } from '../db/tableNames';
import { collectBoundedPages } from '../db/boundedPagination';
import { cursorBinding, decodeCursor, encodeCursor, pageLimit } from './cursor';
import { clean, MAX_TARGET_NOTES, workspaceErrorOf } from './reads';

export const NOTE_TARGETS = ['organization', 'contact', 'deal'] as const;
export type NoteTarget = (typeof NOTE_TARGETS)[number];

const KIND_OF: Record<NoteTarget, string> = { organization: 'organization', contact: 'contact', deal: 'deal' };

/**
 * Notes live under a target-keyed PK so a record feed Queries exactly its own
 * rows: PK `NOTE#<target>:<id>`, SK `<createdAt>#<noteId>` (or a stable
 * `key#<noteId>` for idempotent sourceKey writes, so retries converge instead
 * of duplicating). No whole-table NOTE scan exists on any path.
 */
const notePk = (target: NoteTarget, id: string) => `NOTE#${target}:${id}`;

const publicNote = (note: Record<string, unknown>) => ({
  id: note.id,
  targetType: note.targetType,
  targetId: note.targetId,
  authorId: note.authorId,
  body: note.body,
  createdAt: note.createdAt,
  ...(typeof note.updatedAt === 'string' && note.updatedAt ? { updatedAt: note.updatedAt } : {}),
  version: note.version,
});

/**
 * Resolve a note target without writing anything. Archived contacts read as
 * missing (mirrors touchTarget); archived organizations, records under an
 * archived organization, and archived deals are reference errors (422),
 * mirroring the existing contact/deal reference checks.
 */
async function resolveTarget(client: DynamoDBDocumentClient, target: NoteTarget, id: string) {
  const record = await getCrmRecord(client, KIND_OF[target], id);
  if (!record) return { status: 404 as const, body: { error: 'Not found' } };
  if (target === 'contact') {
    if (record.archivedAt) return { status: 404 as const, body: { error: 'Not found' } };
    const org = await getCrmRecord(client, 'organization', String(record.organizationId));
    if (!org || org.archivedAt) return { status: 422 as const, body: { error: 'Contact organization is archived' } };
  } else if (target === 'deal') {
    if (record.archivedAt) return { status: 422 as const, body: { error: 'Target is archived' } };
    const org = await getCrmRecord(client, 'organization', String(record.organizationId));
    if (!org || org.archivedAt) return { status: 422 as const, body: { error: 'Deal organization is archived' } };
  } else if (record.archivedAt) {
    return { status: 422 as const, body: { error: 'Target is archived' } };
  }
  return { record };
}

export async function createNote(
  client: DynamoDBDocumentClient,
  authorId: string,
  target: NoteTarget,
  id: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  if (typeof body.body !== 'string' || !body.body.trim() || body.body.length > 2000) {
    return { status: 400, body: { error: 'body must be 1..2000 characters' } };
  }
  if (body.sourceKey !== undefined && (typeof body.sourceKey !== 'string' || !body.sourceKey)) {
    return { status: 400, body: { error: 'Invalid sourceKey' } };
  }
  const resolved = await resolveTarget(client, target, id);
  if (!('record' in resolved)) return { status: resolved.status, body: resolved.body };
  const sourceKey = typeof body.sourceKey === 'string' ? body.sourceKey : undefined;
  // The idempotency scope is author + target + key: two users (or two records)
  // reusing one key never collide, and only the identical author/target/body
  // replays to the same note.
  const noteId = sourceKey
    ? deterministicCrmId('note', `note:${target}:${id}:${authorId}:${sourceKey}`)
    : randomUUID();
  const createdAt = new Date().toISOString();
  const sk = sourceKey ? `key#${noteId}` : `${createdAt}#${noteId}`;
  const item = {
    PK: notePk(target, id),
    SK: sk,
    id: noteId,
    targetType: target,
    targetId: id,
    authorId,
    body: body.body,
    createdAt,
    version: 1,
  };
  try {
    await transactCrmDependencies(client, [{ Put: {
      TableName: TABLE_SPONSOR_CRM,
      Item: item,
      ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
    } }], [{ kind: target, id }]);
    return { status: 201, body: publicNote(item) };
  } catch (error) {
    if (!['ConditionalCheckFailedException', 'TransactionCanceledException'].includes((error as Error).name) || !sourceKey) throw error;
    // Strongly consistent replay read: the failed conditional proves the key
    // exists; a lagging replica must not turn an identical retry into a 409.
    const existing = await client.send(
      new QueryCommand({
        TableName: TABLE_SPONSOR_CRM,
        ConsistentRead: true,
        KeyConditionExpression: 'PK = :pk AND SK = :sk',
        ExpressionAttributeValues: { ':pk': notePk(target, id), ':sk': sk },
      }),
    );
    const stored = existing.Items?.[0] as Record<string, unknown> | undefined;
    const same =
      stored &&
      stored.targetType === target &&
      stored.targetId === id &&
      stored.authorId === authorId &&
      stored.body === body.body;
    if (!same) {
      return { status: 409, body: { error: 'Idempotency key already used with different data' } };
    }
    return { status: 200, body: publicNote(clean(stored)) };
  }
}

/** Every note for one target, newest first. Query-only: scanned == matched. */
export async function queryTargetNotes(
  client: DynamoDBDocumentClient,
  target: NoteTarget,
  id: string,
  limit?: number,
): Promise<{ items: Record<string, unknown>[]; scanned: number; matched: number; hasMore?: boolean }> {
  if (limit !== undefined && limit > 0) {
    const result = await client.send(
      new QueryCommand({
        TableName: TABLE_SPONSOR_CRM,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': notePk(target, id) },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    const items = (result.Items || []).map(clean);
    return { items, scanned: items.length, matched: items.length, hasMore: !!result.LastEvaluatedKey };
  }
  let raw: Record<string, unknown>[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const result = await client.send(
      new QueryCommand({
        TableName: TABLE_SPONSOR_CRM,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': notePk(target, id) },
        ScanIndexForward: false,
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }),
    );
    raw.push(...(result.Items || []));
    cursor = result.LastEvaluatedKey;
  } while (cursor);
  const items = raw
    .map(clean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || String(a.id).localeCompare(String(b.id)));
  return { items, scanned: items.length, matched: items.length, hasMore: false };
}

export async function listNotes(
  client: DynamoDBDocumentClient,
  target: NoteTarget,
  id: string,
  query: Record<string, string | undefined>,
): Promise<{ status: number; body: unknown }> {
  const record = await getCrmRecord(client, KIND_OF[target], id);
  if (!record || (target === 'contact' && record.archivedAt)) {
    return { status: 404, body: { error: 'Not found' } };
  }
  const limit = pageLimit(query.limit);
  if ('error' in limit) return { status: 400, body: { error: limit.error } };
  const binding = cursorBinding(['notes', target, id]);
  let offset = 0;
  if (query.cursor !== undefined) {
    const cursor = decodeCursor(binding, query.cursor);
    if ('error' in cursor) return { status: 400, body: { error: cursor.error } };
    offset = cursor.offset;
  }
  let notes: Record<string, unknown>[];
  let scanned = 0;
  try {
    ({ items: notes, scanned } = await queryTargetNotes(client, target, id));
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode) {
      const err = error as { message: string; code?: string; source?: string };
      return { status: statusCode, body: { error: err.message, ...(err.code ? { code: err.code } : {}) } };
    }
    throw error;
  }
  const items = notes.map(publicNote);
  const total = items.length;
  return {
    status: 200,
    body: {
      items: items.slice(offset, offset + limit.limit),
      total,
      nextCursor: offset + limit.limit < total ? encodeCursor(binding, offset + limit.limit) : null,
      reads: { queries: [{ kind: 'note', scanned, matched: total }] },
    },
  };
}

async function findNoteItem(
  client: DynamoDBDocumentClient,
  target: NoteTarget,
  id: string,
  noteId: string,
): Promise<Record<string, unknown> | null> {
  const result = await client.send(
    new QueryCommand({
      TableName: TABLE_SPONSOR_CRM,
      KeyConditionExpression: 'PK = :pk',
      FilterExpression: '#id = :noteId',
      ExpressionAttributeNames: { '#id': 'id' },
      ExpressionAttributeValues: {
        ':pk': notePk(target, id),
        ':noteId': noteId,
      },
    }),
  );
  return (result.Items?.[0] as Record<string, unknown>) || null;
}

export async function getNote(
  client: DynamoDBDocumentClient,
  target: NoteTarget,
  id: string,
  noteId: string,
): Promise<{ status: number; body: unknown }> {
  const record = await getCrmRecord(client, KIND_OF[target], id);
  if (!record || (target === 'contact' && record.archivedAt)) {
    return { status: 404, body: { error: 'Not found' } };
  }
  let existing: Record<string, unknown> | null;
  try {
    existing = await findNoteItem(client, target, id, noteId);
  } catch (error) {
    const err = workspaceErrorOf(error, 'notes');
    return { status: (err as { statusCode?: number }).statusCode || 500, body: { error: err.message } };
  }
  if (!existing) return { status: 404, body: { error: 'Note not found' } };
  return { status: 200, body: publicNote(clean(existing)) };
}

export async function updateNote(
  client: DynamoDBDocumentClient,
  authorId: string,
  target: NoteTarget,
  id: string,
  noteId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  if (typeof body.body !== 'string' || !body.body.trim() || body.body.length > 2000) {
    return { status: 400, body: { error: 'body must be 1..2000 characters' } };
  }
  const resolved = await resolveTarget(client, target, id);
  if (!('record' in resolved)) return { status: resolved.status, body: resolved.body };
  let existing: Record<string, unknown> | null;
  try {
    existing = await findNoteItem(client, target, id, noteId);
  } catch (error) {
    const err = workspaceErrorOf(error, 'notes');
    return { status: (err as { statusCode?: number }).statusCode || 500, body: { error: err.message } };
  }
  if (!existing) return { status: 404, body: { error: 'Note not found' } };
  if (body.version !== undefined && body.version !== existing.version) {
    return { status: 409, body: { error: 'Note was changed; reload and retry' } };
  }
  const next = {
    ...existing,
    body: body.body,
    updatedAt: new Date().toISOString(),
    version: (Number(existing.version) || 1) + 1,
    editedBy: authorId,
  };
  try {
    await client.send(
      new PutCommand({
        TableName: TABLE_SPONSOR_CRM,
        Item: next,
        ConditionExpression: '#version = :expected',
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: { ':expected': existing.version },
      }),
    );
    return { status: 200, body: publicNote(clean(next)) };
  } catch (error) {
    if ((error as Error).name === 'ConditionalCheckFailedException') {
      return { status: 409, body: { error: 'Conflicting update; reload and retry' } };
    }
    const err = workspaceErrorOf(error, 'notes');
    return { status: (err as { statusCode?: number }).statusCode || 500, body: { error: err.message } };
  }
}

export async function deleteNote(
  client: DynamoDBDocumentClient,
  target: NoteTarget,
  id: string,
  noteId: string,
): Promise<{ status: number; body: unknown }> {
  const resolved = await resolveTarget(client, target, id);
  if (!('record' in resolved)) return { status: resolved.status, body: resolved.body };
  let existing: Record<string, unknown> | null;
  try {
    existing = await findNoteItem(client, target, id, noteId);
  } catch (error) {
    const err = workspaceErrorOf(error, 'notes');
    return { status: (err as { statusCode?: number }).statusCode || 500, body: { error: err.message } };
  }
  if (!existing) return { status: 404, body: { error: 'Note not found' } };
  try {
    await client.send(
      new DeleteCommand({
        TableName: TABLE_SPONSOR_CRM,
        Key: { PK: existing.PK, SK: existing.SK },
      }),
    );
    return { status: 200, body: { ...publicNote(clean(existing)), deleted: true } };
  } catch (error) {
    const err = workspaceErrorOf(error, 'notes');
    return { status: (err as { statusCode?: number }).statusCode || 500, body: { error: err.message } };
  }
}

