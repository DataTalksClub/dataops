import { randomUUID } from 'node:crypto';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getCardConsistent } from '../db/cards';
import {
  createTask,
  getTaskConsistent,
  listTasksByCardConsistent,
  listTasksByStatus,
  TaskVersionConflictError,
  updateTask,
} from '../db/tasks';
import { resolveDefaultAssigneeId } from '../db/workspaceSettings';
import type { SponsorDoc } from '../db/sponsorDocs';
import type { Task } from '../types';
import { getSponsorDocTemplate } from './templates';

export const PORTAL_EDIT_TASK_SOURCE = 'portal-doc-edit';
const ACTOR = 'system:portal-doc-edit';
const VALUE_EXCERPT = 160;
const OPEN_STATUSES = ['todo', 'waiting'];

export interface PortalDocChange {
  field: string;
  before: string;
  after: string;
}

function excerpt(value: unknown): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > VALUE_EXCERPT ? `${text.slice(0, VALUE_EXCERPT - 1)}…` : text;
}

/** Content fields and status that differ between two versions of one doc. */
export function diffPortalDoc(before: SponsorDoc, after: SponsorDoc): PortalDocChange[] {
  const changes: PortalDocChange[] = [];
  const keys = new Set([...Object.keys(before.content), ...Object.keys(after.content)]);
  for (const key of keys) {
    const was = String(before.content[key] ?? '');
    const now = String(after.content[key] ?? '');
    if (was !== now) changes.push({ field: key, before: excerpt(was), after: excerpt(now) });
  }
  if (before.status !== after.status) changes.push({ field: 'status', before: before.status, after: after.status });
  return changes;
}

function describeChanges(changes: PortalDocChange[]): string {
  return changes
    .map((change) => `- ${change.field}: ${change.before ? `"${change.before}"` : '(empty)'} → ${change.after ? `"${change.after}"` : '(empty)'}`)
    .join('\n');
}

async function findOpenTask(client: DynamoDBDocumentClient, docId: string, cardId: string | null): Promise<Task | null> {
  const tag = `doc:${docId}`;
  const candidates = cardId
    ? await listTasksByCardConsistent(client, cardId)
    : (await Promise.all(OPEN_STATUSES.map((status) => listTasksByStatus(client, status)))).flat();
  return candidates.find((task) =>
    task.source === PORTAL_EDIT_TASK_SOURCE
    && OPEN_STATUSES.includes(task.status)
    && (task.tags || []).includes(tag)) || null;
}

/**
 * Surface an external (guest or sponsor) edit to a shared portal doc as one
 * open Task for the default owner team. A burst of edits appends to the open
 * Task; a new Task appears only once the previous one is closed.
 */
export async function recordPortalDocEdit(
  client: DynamoDBDocumentClient,
  input: { before: SponsorDoc; after: SponsorDoc; docUrl: string },
): Promise<Task | null> {
  const { before, after, docUrl } = input;
  const changes = diffPortalDoc(before, after);
  if (changes.length === 0) return null;

  const card = await getCardConsistent(client, after.cardId);
  const activeCardId = card && card.status === 'active' ? card.id : null;
  const label = getSponsorDocTemplate(after.template).shortLabel;
  const cardTitle = card?.title || after.title;
  const now = new Date().toISOString();
  const noteText = `${after.lastEditedByName || 'External editor'} edited ${label} "${after.title}" (${docUrl}):\n${describeChanges(changes)}`;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const open = await findOpenTask(client, after.id, activeCardId);
    if (!open) break;
    try {
      return await updateTask(client, open.id, {
        currentTask: open,
        expectedVersion: open.version,
        patch: {
          comment: noteText,
          notesLog: [...(open.notesLog || []), { id: randomUUID(), text: noteText, authorId: ACTOR, createdAt: now }],
        },
        historyEvents: [{
          id: randomUUID(), taskId: open.id, ...(activeCardId ? { cardId: activeCardId } : {}),
          action: 'noted', actorId: ACTOR, note: noteText, createdAt: now,
        }],
        actorId: ACTOR,
        triggerKind: 'portal-doc-edit',
      });
    } catch (error) {
      if (!(error instanceof TaskVersionConflictError)) throw error;
      const stillThere = await getTaskConsistent(client, open.id);
      if (!stillThere || !OPEN_STATUSES.includes(stillThere.status)) break;
    }
  }

  const assigneeId = await resolveDefaultAssigneeId(client);
  return createTask(client, {
    description: `Review portal doc edit: ${label} "${after.title}" (${cardTitle}${activeCardId ? '' : `, card ${after.cardId}`})`,
    date: now.slice(0, 10),
    status: 'todo',
    source: PORTAL_EDIT_TASK_SOURCE,
    tags: ['portal-edit', `doc:${after.id}`, `card:${after.cardId}`],
    link: docUrl,
    comment: noteText,
    notesLog: [{ id: randomUUID(), text: noteText, authorId: ACTOR, createdAt: now }],
    ...(assigneeId ? { assigneeId } : {}),
    ...(activeCardId ? { cardId: activeCardId } : {}),
  });
}
