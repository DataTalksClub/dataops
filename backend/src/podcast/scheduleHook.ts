import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getCard } from '../db/cards';
import type { PodcastEpisode } from '../db/podcastEpisodes';
import { getTaskConsistent, listTasksByCard, updateTask } from '../db/tasks';
import { makeTaskHistoryEvent } from '../routes/taskValidation';

export interface VerifySyncResult {
  taskId: string;
  notBeforeAt: string | null;
}

/**
 * Point the episode Card's verify Task at the Spotify schedule: the open
 * Task carrying the Template's `published` stage ref surfaces at the
 * scheduled instant, so the "Verify the public playable Spotify episode"
 * check (and everything chained after it) waits for the release.
 *
 * Removing the schedule unschedules a Task that still holds the old instant;
 * a Task someone retimed by hand keeps its own moment. Done Tasks keep
 * their history either way.
 */
export async function syncVerifyTaskTime(
  client: DynamoDBDocumentClient,
  episode: PodcastEpisode,
  previousScheduledAt: string | null,
): Promise<VerifySyncResult | null> {
  const scheduledAt = episode.publication?.audioSchedule?.scheduledAt ?? null;
  if (!episode.cardId) return null;
  if ((scheduledAt ?? null) === (previousScheduledAt ?? null)) return null;
  const card = await getCard(client, episode.cardId);
  const ref = card?.templateDefinitionSnapshot?.episodeStages?.published;
  if (!ref) return null;
  const candidate = (await listTasksByCard(client, episode.cardId)).find(
    (task) => task.templateTaskRef === ref && (task.status === 'todo' || task.status === 'waiting'),
  );
  if (!candidate) return null;
  const verify = await getTaskConsistent(client, candidate.id);
  if (!verify || (verify.status !== 'todo' && verify.status !== 'waiting')) return null;
  const now = new Date().toISOString();

  if (scheduledAt) {
    if (verify.notBeforeAt === scheduledAt) return { taskId: verify.id, notBeforeAt: scheduledAt };
    const historyEvent = makeTaskHistoryEvent('scheduled', verify, {
      note: `Spotify schedule recorded: surfaces at ${scheduledAt}`,
      createdAt: now,
    });
    await updateTask(client, verify.id, {
      currentTask: verify,
      expectedVersion: verify.version,
      patch: { notBeforeAt: scheduledAt },
      historyEvents: [historyEvent],
      triggerKind: 'task-scheduled',
    });
    return { taskId: verify.id, notBeforeAt: scheduledAt };
  }

  if (!previousScheduledAt || verify.notBeforeAt !== previousScheduledAt) return null;
  const historyEvent = makeTaskHistoryEvent('scheduled', verify, {
    note: 'Spotify schedule removed; back in the queue',
    createdAt: now,
  });
  await updateTask(client, verify.id, {
    currentTask: verify,
    expectedVersion: verify.version,
    patch: { notBeforeAt: null },
    historyEvents: [historyEvent],
    triggerKind: 'task-unscheduled',
  });
  return { taskId: verify.id, notBeforeAt: null };
}
