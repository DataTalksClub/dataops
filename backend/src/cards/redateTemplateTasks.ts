import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { listTasksByCardConsistent, updateTask } from '../db/tasks';
import { makeTaskHistoryEvent } from '../routes/taskValidation';
import { dateFromTemplateOffset } from '../templates/cardTemplateProjection';
import type { Card, Task } from '../types';

const OPEN_STATUSES = new Set(['todo', 'waiting']);

export interface RedateTaskChange {
  taskId: string;
  description: string;
  status: string;
  templateTaskRef?: string;
  templateOffsetDays: number;
  from: string;
  to: string;
}

export interface RedateCardTasksResult {
  cardId: string;
  anchorDate: string | null;
  dryRun: boolean;
  changes: RedateTaskChange[];
  updatedCount: number;
}

function isEndAnchored(task: Task): boolean {
  const anchor = (task as { templateAnchor?: string }).templateAnchor
    ?? task.templateDefinitionSnapshot?.templateAnchor;
  return anchor === 'end';
}

/**
 * Re-date open (`todo` and `waiting`) start-anchored Template Tasks on a Card
 * to `card.anchorDate + templateOffsetDays`. Done and skipped Tasks keep their
 * existing dates.
 */
export async function redateCardTemplateTasks(
  client: DynamoDBDocumentClient,
  card: Card,
  options: { dryRun?: boolean; actorId?: string; reason?: string } = {},
): Promise<RedateCardTasksResult> {
  const dryRun = options.dryRun === true;
  if (!card.anchorDate) {
    return { cardId: card.id, anchorDate: null, dryRun, changes: [], updatedCount: 0 };
  }
  const anchorDate = card.anchorDate.slice(0, 10);
  const tasks = await listTasksByCardConsistent(client, card.id);
  const changes: RedateTaskChange[] = [];
  let updatedCount = 0;

  for (const task of tasks) {
    if (!OPEN_STATUSES.has(task.status) || typeof task.templateOffsetDays !== 'number') continue;
    if (isEndAnchored(task)) continue;
    const to = dateFromTemplateOffset(anchorDate, task.templateOffsetDays);
    if (task.date === to) continue;

    changes.push({
      taskId: task.id,
      description: task.description,
      status: task.status,
      ...(task.templateTaskRef ? { templateTaskRef: task.templateTaskRef } : {}),
      templateOffsetDays: task.templateOffsetDays,
      from: task.date,
      to,
    });

    if (!dryRun) {
      const offsetLabel = task.templateOffsetDays >= 0
        ? `+${task.templateOffsetDays}`
        : String(task.templateOffsetDays);
      const note = options.reason
        || `Re-dated to Card anchor ${anchorDate} (${offsetLabel}d): ${task.date} -> ${to}`;
      await updateTask(client, task.id, {
        expectedVersion: task.version,
        currentTask: task,
        patch: {
          date: to,
          ...(task.templateDefinitionSnapshot
            ? { templateDefinitionSnapshot: { ...task.templateDefinitionSnapshot, date: to } }
            : {}),
        },
        ...(options.actorId ? { actorId: options.actorId } : {}),
        historyEvents: [
          makeTaskHistoryEvent('scheduled', task, {
            ...(options.actorId ? { actorId: options.actorId } : {}),
            createdAt: new Date().toISOString(),
            note,
          }),
        ],
        triggerKind: 'task-scheduled',
      });
      updatedCount += 1;
    }
  }

  return { cardId: card.id, anchorDate, dryRun, changes, updatedCount };
}
