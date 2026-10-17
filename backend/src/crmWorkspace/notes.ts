import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createCrmRecord, getCrmRecord } from '../db/sponsorCrm';
import { cursorBinding, decodeCursor, encodeCursor, pageLimit } from './cursor';
import { listKindRecords, workspaceErrorOf } from './reads';

export const NOTE_TARGETS = ['organization', 'contact', 'deal'] as const;
export type NoteTarget = (typeof NOTE_TARGETS)[number];

const KIND_OF: Record<NoteTarget, string> = { organization: 'organization', contact: 'contact', deal: 'deal' };

const publicNote = (note: Record<string, unknown>) => ({
  id: note.id,
  targetType: note.targetType,
  targetId: note.targetId,
  authorId: note.authorId,
  body: note.body,
  createdAt: note.createdAt,
  version: note.version,
});

/**
 * Resolve a note target without writing anything. Archived contacts read as
 * missing (mirrors touchTarget); archived organizations, contacts under an
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
  if (body.sourceKey !== undefined && typeof body.sourceKey !== 'string') {
    return { status: 400, body: { error: 'Invalid sourceKey' } };
  }
  const resolved = await resolveTarget(client, target, id);
  if (!('record' in resolved)) return { status: resolved.status, body: resolved.body };
  const value = {
    targetType: target,
    targetId: id,
    authorId,
    body: body.body,
    ...(typeof body.sourceKey === 'string' ? { sourceKey: body.sourceKey } : {}),
  };
  try {
    const created = await createCrmRecord(client, 'note', value);
    return { status: created.duplicate ? 200 : 201, body: publicNote(created.item) };
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode === 409) return { status: 409, body: { error: (error as Error).message } };
    throw error;
  }
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
  let itemsRead: number;
  try {
    ({ items: notes, itemsRead } = await listKindRecords(client, 'note', 'notes'));
  } catch (error) {
    const err = workspaceErrorOf(error, 'notes');
    return { status: (err as { statusCode?: number }).statusCode || 500, body: { error: err.message } };
  }
  const items = notes
    .filter((note) => note.targetType === target && note.targetId === id)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || String(a.id).localeCompare(String(b.id)))
    .map(publicNote);
  const total = items.length;
  return {
    status: 200,
    body: {
      items: items.slice(offset, offset + limit.limit),
      total,
      nextCursor: offset + limit.limit < total ? encodeCursor(binding, offset + limit.limit) : null,
      reads: { directScans: [{ kind: 'note', itemsRead }] },
    },
  };
}
