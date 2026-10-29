/**
 * A Task linked to the Card that carries it out: a course Card's "Workshop 2"
 * Task links that workshop's own Card.
 *
 * The Task's `linkedCardId` is the link. The linked Card keeps a
 * back-reference (`Card.linkedFrom`) written in the same transaction so it
 * can show which Task it serves without scanning Tasks. Deleting a Task or
 * its Card does not rewrite the back-reference, so a reader confirms each
 * entry against its Task (`liveBackReferences`); the Card deletion guard
 * looks the Tasks up itself.
 */
import {
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

import type { Card, Task, TaskCardBackReference } from '../types';
import { usesLocalTransactionEmulation } from './client';
import { cardKey, getCardConsistent } from './cards';
import { compact } from './plannedWrite';
import { TABLE_CARDS, TABLE_TASKS } from './tableNames';
import { getTask } from './tasks';

type Dict = Record<string, unknown>;
type TransactionItems = NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']>;

export class TaskCardLinkConflictError extends Error {
  constructor() {
    super('Task or Card changed while linking; reload and retry');
    this.name = 'TaskCardLinkConflictError';
  }
}

function taskKey(id: string) {
  return { PK: `TASK#${id}`, SK: `TASK#${id}` };
}

function versionCondition(version: number) {
  return {
    ConditionExpression: 'attribute_exists(PK) AND #version = :expectedVersion',
    ExpressionAttributeNames: { '#version': 'version' },
    ExpressionAttributeValues: { ':expectedVersion': version },
  };
}

function withBackReferences(card: Card, linkedFrom: TaskCardBackReference[], now: string): Card {
  const next = { ...card, version: card.version + 1, updatedAt: now } as Card;
  if (linkedFrom.length > 0) next.linkedFrom = linkedFrom;
  else delete next.linkedFrom;
  return next;
}

/** Back-references whose Task still exists and still links `cardId`. */
export async function liveBackReferences(
  client: DynamoDBDocumentClient,
  cardId: string,
  references: readonly TaskCardBackReference[] | undefined,
): Promise<Array<TaskCardBackReference & { task: Task }>> {
  // A Card is linked by one Task, rarely a few: plain reads, no batch grant.
  const live: Array<TaskCardBackReference & { task: Task }> = [];
  for (const reference of references || []) {
    const task = await getTask(client, reference.taskId);
    if (task && task.linkedCardId === cardId) live.push({ ...reference, task });
  }
  return live;
}

/**
 * Set (`targetCardId`) or clear (`null`) the Card a Task links, moving the
 * back-reference with it. Every row written is conditioned on the version it
 * was read at.
 */
export async function setTaskLinkedCard(
  client: DynamoDBDocumentClient,
  task: Task,
  targetCardId: string | null,
): Promise<Task> {
  const now = new Date().toISOString();
  const nextTask = { ...task, version: task.version + 1, updatedAt: now } as Task;
  if (targetCardId) nextTask.linkedCardId = targetCardId;
  else delete nextTask.linkedCardId;

  const cardWrites: Array<{ before: Card; after: Card }> = [];
  const previousCardId = task.linkedCardId || null;
  if (previousCardId && previousCardId !== targetCardId) {
    const previous = await getCardConsistent(client, previousCardId);
    if (previous) {
      const kept = (previous.linkedFrom || []).filter(({ taskId }) => taskId !== task.id);
      cardWrites.push({ before: previous, after: withBackReferences(previous, kept, now) });
    }
  }
  if (targetCardId) {
    const target = await getCardConsistent(client, targetCardId);
    if (!target) throw new TaskCardLinkConflictError();
    const others = (target.linkedFrom || []).filter(({ taskId }) => taskId !== task.id);
    cardWrites.push({
      before: target,
      after: withBackReferences(target, [...others, { taskId: task.id, cardId: task.cardId! }], now),
    });
  }

  const transaction: TransactionItems = [
    { Put: { TableName: TABLE_TASKS, Item: compact({ ...taskKey(task.id), ...nextTask }) as Dict, ...versionCondition(task.version) } },
    ...cardWrites.map(({ before, after }) => ({
      Put: { TableName: TABLE_CARDS, Item: compact({ ...cardKey(after.id), ...after }) as Dict, ...versionCondition(before.version) },
    })),
  ];

  if (usesLocalTransactionEmulation()) {
    await emulate(client, transaction);
    return nextTask;
  }
  try {
    await client.send(new TransactWriteCommand({ TransactItems: transaction }));
  } catch (error) {
    if ((error as Error).name === 'TransactionCanceledException') throw new TaskCardLinkConflictError();
    throw error;
  }
  return nextTask;
}

/** Local DynamoDB without transactions: check every condition, then write. */
async function emulate(client: DynamoDBDocumentClient, transaction: TransactionItems): Promise<void> {
  for (const { Put } of transaction) {
    const item = Put!.Item as Dict;
    const current = await client.send(new GetCommand({
      TableName: Put!.TableName,
      Key: { PK: item.PK, SK: item.SK },
      ConsistentRead: true,
    }));
    if (current.Item?.version !== Put!.ExpressionAttributeValues?.[':expectedVersion']) {
      throw new TaskCardLinkConflictError();
    }
  }
  for (const { Put } of transaction) {
    await client.send(new PutCommand({ TableName: Put!.TableName, Item: Put!.Item as Dict }));
  }
}
