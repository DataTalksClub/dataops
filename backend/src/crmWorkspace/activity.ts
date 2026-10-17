import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getCrmRecord, listCrmRecords } from '../db/sponsorCrm';
import { listTasksByStatus } from '../db/tasks';
import type { Task } from '../types';
import { cursorBinding, decodeCursor, encodeCursor, pageLimit } from './cursor';
import { listKindRecords, queryHistoryEvents, MAX_ORG_DEAL_HISTORY, sourceTooLarge, workspaceErrorOf } from './reads';

export const ACTIVITY_TARGETS = ['organization', 'contact', 'deal'] as const;
export type ActivityTarget = (typeof ACTIVITY_TARGETS)[number];
const ACTIVITY_TYPES = ['note', 'touch', 'mail', 'history', 'deal-history'] as const;

type TimelineItem = {
  ts: string;
  source: string;
  id: string;
  actor: string | null;
  text: string;
  detail?: Record<string, unknown>;
  provenance: Record<string, unknown>;
};

type RelatedWork = {
  taskId: string;
  status: string;
  date: string;
  description: string;
  assigneeId?: string;
  href: string;
  scope: 'direct' | 'related-company';
};

/** Same rule as taskSubjects.subjectHref (replicated, not imported: that module is A's neighbor, not ours). */
function subjectHref(type: 'sponsor-company' | 'sponsor-deal', id: string): string {
  const family = type === 'sponsor-deal' ? 'deals' : 'companies';
  return `/sponsors/${family}/${encodeURIComponent(id)}`;
}

function snippet(text: string, max = 280): string {
  return text.length > max ? text.slice(0, max) : text;
}

/** History rows written alongside a message/touch duplicate the message row; the message is canonical. */
const DEDUPED_HISTORY_ACTIONS = new Set(['mail', 'touch']);

function historyText(event: Record<string, unknown>): string {
  const action = String(event.action || '');
  if (event.oldStatus !== undefined || event.newStatus !== undefined) {
    const note = typeof event.note === 'string' && event.note ? `: ${event.note}` : '';
    return `Status ${String(event.oldStatus ?? '—')} → ${String(event.newStatus ?? '—')}${note}`;
  }
  if (action === 'created') return 'Record created';
  if (action === 'archived') return 'Record archived';
  if (action === 'updated') return 'Record updated';
  return action ? `Record ${action}` : 'Record event';
}

export async function readActivity(
  client: DynamoDBDocumentClient,
  target: ActivityTarget,
  id: string,
  query: Record<string, string | undefined>,
): Promise<{ status: number; body: unknown }> {
  const kind = target === 'organization' ? 'organization' : target;
  const record = await getCrmRecord(client, kind, id);
  if (!record) return { status: 404, body: { error: 'Not found' } };

  const types = query.types === undefined
    ? [...ACTIVITY_TYPES]
    : query.types.split(',').map((part) => part.trim()).filter(Boolean);
  if (types.some((type) => !(ACTIVITY_TYPES as readonly string[]).includes(type))) {
    return { status: 400, body: { error: 'types must be a subset of note,touch,mail,history,deal-history' } };
  }
  const wanted = new Set(types);
  const limit = pageLimit(query.limit);
  if ('error' in limit) return { status: 400, body: { error: limit.error } };
  const binding = cursorBinding(['activity', target, id, [...wanted].sort()]);
  let offset = 0;
  if (query.cursor !== undefined) {
    const cursor = decodeCursor(binding, query.cursor);
    if ('error' in cursor) return { status: 400, body: { error: cursor.error } };
    offset = cursor.offset;
  }

  const items: TimelineItem[] = [];
  const sources: Record<string, number> = { note: 0, touch: 0, mail: 0, history: 0, 'deal-history': 0 };
  const directScans: Array<{ kind: string; itemsRead: number }> = [];
  const historyReads: Array<{ booking: string; itemsRead: number }> = [];
  const relatedWork: RelatedWork[] = [];

  try {
    if (wanted.has('note')) {
      const { items: notes, itemsRead } = await listKindRecords(client, 'note', 'notes');
      directScans.push({ kind: 'note', itemsRead });
      for (const note of notes) {
        if (note.targetType !== target || String(note.targetId) !== id) continue;
        const body = String(note.body || '');
        items.push({
          ts: String(note.createdAt || ''),
          source: 'note',
          id: String(note.id),
          actor: typeof note.authorId === 'string' ? note.authorId : null,
          text: snippet(body),
          ...(body.length > 280 ? { detail: { body } } : {}),
          provenance: { targetType: target, targetId: id },
        });
        sources.note += 1;
      }
    }

    if (wanted.has('touch') || wanted.has('mail')) {
      // MESSAGE# is outside SNAPSHOT_PREFIXES: an owned bounded scan, disclosed below.
      const { items: messages, itemsRead } = await listKindRecords(client, 'message', 'messages');
      directScans.push({ kind: 'message', itemsRead });
      const emails = target === 'contact' && Array.isArray(record.emails)
        ? new Set(record.emails.map((address) => String(address).toLowerCase()))
        : null;
      for (const message of messages) {
        let linked: 'direct' | null = null;
        if (target === 'organization' && String(message.organizationId) === id) linked = 'direct';
        else if (target === 'deal' && String(message.dealId || '') === id) linked = 'direct';
        else if (target === 'contact') {
          // Provably linked person mail only: explicit contact link or an email
          // address the contact owns. Company-wide mail stays on the org timeline.
          if (String(message.contactId || '') === id) linked = 'direct';
          else if (
            emails && typeof message.personEmail === 'string' && emails.has(message.personEmail.toLowerCase()) &&
            String(message.organizationId || '') === String(record.organizationId || '')
          ) {
            linked = 'direct';
          }
        }
        if (!linked) continue;
        const isTouch = message.sourceType === 'touch';
        if (isTouch && !wanted.has('touch')) continue;
        if (!isTouch && !wanted.has('mail')) continue;
        const text = String(message.snippet || '');
        items.push({
          ts: String(message.sentAt || ''),
          source: isTouch ? 'touch' : 'mail',
          id: String(message.id),
          actor: null,
          text: snippet(text, 280),
          ...(text.length > 280 ? { detail: { snippet: text } } : {}),
          provenance: {
            targetType: target,
            targetId: id,
            direction: message.direction,
            threadId: message.threadId,
            messageId: message.id,
            link: 'direct',
          },
        });
        sources[isTouch ? 'touch' : 'mail'] += 1;
      }
    }

    if (wanted.has('history')) {
      const booking = target === 'deal' ? id : `${target}:${id}`;
      const { items: events, itemsRead } = await queryHistoryEvents(client, booking, 'history');
      historyReads.push({ booking, itemsRead });
      for (const event of events) {
        if (DEDUPED_HISTORY_ACTIONS.has(String(event.action || ''))) continue;
        items.push({
          ts: String(event.createdAt || ''),
          source: 'history',
          id: String(event.id),
          actor: typeof event.actorId === 'string' ? event.actorId : null,
          text: snippet(historyText(event)),
          provenance: {
            targetType: target,
            targetId: id,
            action: event.action,
            ...(event.oldStatus !== undefined ? { oldStatus: event.oldStatus } : {}),
            ...(event.newStatus !== undefined ? { newStatus: event.newStatus } : {}),
          },
        });
        sources.history += 1;
      }
    }

    if (wanted.has('deal-history') && target === 'organization') {
      const deals = (await listCrmRecords(client, 'deal')).filter((deal) => String(deal.organizationId) === id);
      let read = 0;
      for (const deal of deals) {
        const { items: events, itemsRead } = await queryHistoryEvents(client, deal.id, 'deal history');
        historyReads.push({ booking: deal.id, itemsRead });
        read += itemsRead;
        if (read > MAX_ORG_DEAL_HISTORY) throw sourceTooLarge('deal history');
        for (const event of events) {
          if (event.oldStatus === undefined && event.newStatus === undefined) continue;
          items.push({
            ts: String(event.createdAt || ''),
            source: 'deal-history',
            id: String(event.id),
            actor: typeof event.actorId === 'string' ? event.actorId : null,
            text: snippet(historyText(event)),
            provenance: {
              targetType: target,
              targetId: id,
              dealId: deal.id,
              ...(event.oldStatus !== undefined ? { oldStatus: event.oldStatus } : {}),
              ...(event.newStatus !== undefined ? { newStatus: event.newStatus } : {}),
            },
          });
          sources['deal-history'] += 1;
        }
      }
    }

    // Open work is related-work, never a historical event: mutable tasks cannot
    // be completion evidence. Closed work stays in the canonical Tasks API.
    const open: Task[] = [
      ...await listTasksByStatus(client, 'todo'),
      ...await listTasksByStatus(client, 'waiting'),
    ];
    const orgId = target === 'contact' ? String(record.organizationId || '') : target === 'organization' ? id : '';
    for (const task of open) {
      const subject = task.subject;
      if (!subject || (subject.type !== 'sponsor-company' && subject.type !== 'sponsor-deal')) continue;
      let scope: RelatedWork['scope'] | null = null;
      if (target === 'deal' && subject.type === 'sponsor-deal' && subject.id === id) scope = 'direct';
      else if (target === 'organization' && subject.type === 'sponsor-company' && subject.id === id) scope = 'direct';
      else if (target === 'contact' && subject.type === 'sponsor-company' && orgId && subject.id === orgId) {
        scope = 'related-company';
      }
      if (!scope) continue;
      relatedWork.push({
        taskId: task.id,
        status: task.status,
        date: String(task.date || ''),
        description: String(task.description || ''),
        ...(task.assigneeId ? { assigneeId: task.assigneeId } : {}),
        href: subjectHref(subject.type, subject.id),
        scope,
      });
    }
    relatedWork.sort((a, b) => a.date.localeCompare(b.date) || a.taskId.localeCompare(b.taskId));
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode) {
      const err = error as { message: string; code?: string; source?: string };
      return { status: statusCode, body: { error: err.message, ...(err.code ? { code: err.code } : {}), ...(err.source ? { source: err.source } : {}) } };
    }
    throw workspaceErrorOf(error, 'activity');
  }

  items.sort((a, b) => b.ts.localeCompare(a.ts) || a.source.localeCompare(b.source) || a.id.localeCompare(b.id));
  const total = items.length;
  return {
    status: 200,
    body: {
      targetType: target,
      targetId: id,
      items: items.slice(offset, offset + limit.limit),
      total,
      nextCursor: offset + limit.limit < total ? encodeCursor(binding, offset + limit.limit) : null,
      sources,
      relatedWork,
      tasksScope: 'open',
      reads: {
        snapshot: ['ORGANIZATION#', 'CONTACT#', 'DEAL#', 'DELIVERABLE#'],
        directScans,
        historyReads,
      },
    },
  };
}
