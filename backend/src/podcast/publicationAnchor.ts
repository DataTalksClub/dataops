import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import { getCard, updateCardAdditive } from "../db/cards";
import type { PodcastEpisode } from "../db/podcastEpisodes";
import { getTaskConsistent, listTasksByCard, updateTask } from "../db/tasks";
import { makeTaskHistoryEvent } from "../routes/taskValidation";
import { dateFromTemplateOffset } from "../templates/cardTemplateProjection";
import type { Task } from "../types";

/**
 * A podcast Card has two independent schedule anchors:
 *
 * - START (`card.anchorDate`) is the recording date, the primary anchor.
 * - END (`card.endDate`) is the publication date, the secondary anchor.
 *
 * Template Tasks pick one with the existing `anchor: start | end` plus
 * `offsetDays`, so page creation and release prep (`anchor: end`, negative
 * offsets) follow publication while recording work follows the recording.
 */
export interface PublicationAnchorMove {
  taskId: string;
  templateTaskRef?: string;
  from: string;
  to: string;
}

export interface PublicationAnchorSync {
  endDate: string;
  moved: PublicationAnchorMove[];
}

const OPEN = new Set(["todo", "waiting"]);

const isPublicationAnchored = (task: Task) =>
  ((task as { templateAnchor?: string }).templateAnchor ??
    task.templateDefinitionSnapshot?.templateAnchor) === "end";

/**
 * Pin the Card's END date to the episode's publication date and move every
 * unfinished publication-anchored Task to `releaseDate + offsetDays`. Done
 * and skipped Tasks keep their dates and history.
 */
export async function syncPublicationAnchor(
  client: DynamoDBDocumentClient,
  episode: PodcastEpisode,
): Promise<PublicationAnchorSync | null> {
  if (!episode.cardId || !episode.releaseDate) return null;
  const releaseDate = episode.releaseDate;
  const card = await getCard(client, episode.cardId);
  if (!card) return null;
  if (card.endDate !== releaseDate)
    await updateCardAdditive(client, card, (current) =>
      current.endDate === releaseDate ? {} : { endDate: releaseDate },
    );
  const moved: PublicationAnchorMove[] = [];
  for (const listed of await listTasksByCard(client, episode.cardId)) {
    if (!OPEN.has(listed.status) || !isPublicationAnchored(listed)) continue;
    if (typeof listed.templateOffsetDays !== "number") continue;
    const to = dateFromTemplateOffset(releaseDate, listed.templateOffsetDays);
    if (listed.date === to) continue;
    const task = await getTaskConsistent(client, listed.id);
    if (!task || !OPEN.has(task.status) || task.date === to) continue;
    const note = `Publication date ${releaseDate} (${episode.releaseAssignmentStatus ?? "unassigned"}): moved from ${task.date} to ${to}`;
    await updateTask(client, task.id, {
      currentTask: task,
      expectedVersion: task.version,
      patch: { date: to },
      historyEvents: [makeTaskHistoryEvent("scheduled", task, { note, createdAt: new Date().toISOString() })],
      triggerKind: "task-scheduled",
    });
    moved.push({ taskId: task.id, ...(task.templateTaskRef ? { templateTaskRef: task.templateTaskRef } : {}), from: task.date, to });
  }
  return { endDate: releaseDate, moved };
}
