/**
 * Read-side view of Task to Card links (`db/taskCardLinks.ts`): the linked
 * Card's summary on each Task, and the Tasks that link a Card.
 */
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getCard } from '../db/cards';
import { liveBackReferences } from '../db/taskCardLinks';
import type { Card, Task } from '../types';
import { summarizeCard, type CardSummary } from './recordCardLink';

export type LinkedCardSummary = Pick<CardSummary, 'id' | 'title' | 'stage' | 'status' | 'anchorDate'> & {
  url: string;
};

export interface CardBackReferenceView {
  taskId: string;
  taskDescription: string;
  taskStatus: Task['status'];
  cardId: string;
  cardTitle: string;
  url: string;
}

/** The portal address of a Card. */
export function cardPath(cardId: string): string {
  return `/cards?cardId=${encodeURIComponent(cardId)}`;
}

async function linkedCardSummary(client: DynamoDBDocumentClient, cardId: string): Promise<LinkedCardSummary | null> {
  const card = await getCard(client, cardId);
  if (!card) return null;
  const { id, title, stage, status, anchorDate } = await summarizeCard(client, card);
  return { id, title, stage, status, anchorDate, url: cardPath(id) };
}

/** Each Task with the summary of the Card it links (`linkedCard`), when it links one that exists. */
export async function attachLinkedCards<T extends Task>(
  client: DynamoDBDocumentClient,
  tasks: T[],
): Promise<Array<T & { linkedCard?: LinkedCardSummary }>> {
  const ids = [...new Set(tasks.map(({ linkedCardId }) => linkedCardId).filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return tasks;
  const summaries = new Map<string, LinkedCardSummary | null>();
  for (const id of ids) summaries.set(id, await linkedCardSummary(client, id));
  return tasks.map((task) => {
    const linkedCard = task.linkedCardId ? summaries.get(task.linkedCardId) : null;
    return linkedCard ? { ...task, linkedCard } : task;
  });
}

/** The Tasks on other Cards that link this Card, confirmed against each Task. */
export async function cardBackReferences(
  client: DynamoDBDocumentClient,
  card: Card,
): Promise<CardBackReferenceView[]> {
  const live = await liveBackReferences(client, card.id, card.linkedFrom);
  const views: CardBackReferenceView[] = [];
  for (const { task, cardId } of live) {
    const source = await getCard(client, cardId);
    if (!source) continue;
    views.push({
      taskId: task.id,
      taskDescription: task.description,
      taskStatus: task.status,
      cardId,
      cardTitle: (await summarizeCard(client, source)).title,
      url: `${cardPath(cardId)}&taskId=${encodeURIComponent(task.id)}`,
    });
  }
  return views;
}
