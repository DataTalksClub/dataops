import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getCardConsistent } from '../db/cards';
import { getTaskConsistent, updateTask } from '../db/tasks';
import { makeTaskHistoryEvent } from '../routes/taskValidation';
/** Acceptance resolves the waiting first-invitation Task, including accepts racing delivery bookkeeping. */
export async function resolveGuestAcceptanceTask(db: DynamoDBDocumentClient, cardId: string, eventId: string, actorId: string) {
  const card = await getCardConsistent(db, cardId);
  if (!card?.guestIntake) return;
  const task = await getTaskConsistent(db, card.guestIntake.taskId);
  if (!task || !['todo', 'waiting'].includes(task.status)) return;
  const now = new Date().toISOString();
  await updateTask(db, task.id, { currentTask: task, expectedVersion: task.version, patch: { status: 'done', completedAt: now, completedBy: actorId,
    waitingFor: null, followUpAt: null, followUpChannel: null, comment: `Guest accepted the event time; linked Calendar event ${eventId}.` },
    historyEvents: [makeTaskHistoryEvent('completed', task, { actorId, createdAt: now, note: `Guest time accepted for Calendar event ${eventId}.` })], actorId, triggerKind: 'guest-time-accepted' });
}
