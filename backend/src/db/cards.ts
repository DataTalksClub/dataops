import {
  PutCommand,
  GetCommand,
  UpdateCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { TABLE_CARDS } from './tableNames';
import type { Card } from '../types';

type ActiveCardStage = 'preparation' | 'announced' | 'after-event';

type CardMutableField = Exclude<
  keyof Card,
  | 'id'
  | 'version'
  | 'taskCount'
  | 'openTaskCount'
  | 'status'
  | 'completedAt'
  | 'completedBy'
  | 'activeStageBeforeCompletion'
  | 'createdAt'
  | 'updatedAt'
>;

type CardPatch = {
  [Field in CardMutableField]?: Card[Field] | null;
};

interface CardMutation {
  expectedVersion: number;
  patch: CardPatch;
}

type AdditiveCardPatch = (currentCard: Card) => CardPatch;

class CardVersionConflictError extends Error {
  readonly cardId: string;
  readonly expectedVersion: number;

  constructor(cardId: string, expectedVersion: number) {
    super(`Card ${cardId} changed from expected version ${expectedVersion}`);
    this.name = 'CardVersionConflictError';
    this.cardId = cardId;
    this.expectedVersion = expectedVersion;
  }
}

class CardNotFoundError extends Error {
  readonly cardId: string;

  constructor(cardId: string) {
    super(`Card ${cardId} was not found`);
    this.name = 'CardNotFoundError';
    this.cardId = cardId;
  }
}

const ACTIVE_CARD_STAGES = new Set<ActiveCardStage>([
  'preparation',
  'announced',
  'after-event',
]);

function isActiveCardStage(value: unknown): value is ActiveCardStage {
  return typeof value === 'string' && ACTIVE_CARD_STAGES.has(value as ActiveCardStage);
}

function cardKey(id: string) {
  return { PK: `CARD#${id}`, SK: `CARD#${id}` };
}

/**
 * Strip DynamoDB key attributes (PK, SK) from an item.
 */
function cleanItem(item: Record<string, unknown> | undefined): Card | null {
  if (!item) return null;
  const { PK, SK, ...rest } = item;
  const taskCount = typeof rest.taskCount === 'number' ? rest.taskCount : Number.NaN;
  const openTaskCount = typeof rest.openTaskCount === 'number' ? rest.openTaskCount : Number.NaN;
  const version = typeof rest.version === 'number' ? rest.version : Number.NaN;
  const active = rest.status === 'active'
    && isActiveCardStage(rest.stage)
    && (taskCount === 0 || openTaskCount > 0);
  const completed = rest.status === 'archived'
    && rest.stage === 'done'
    && taskCount > 0
    && openTaskCount === 0
    && typeof rest.completedAt === 'string'
    && rest.completedAt.length > 0
    && typeof rest.completedBy === 'string'
    && rest.completedBy.length > 0
    && isActiveCardStage(rest.activeStageBeforeCompletion);
  if (
    !Number.isInteger(version)
    || version < 1
    || !Number.isInteger(taskCount)
    || taskCount < 0
    || !Number.isInteger(openTaskCount)
    || openTaskCount < 0
    || openTaskCount > taskCount
    || (!active && !completed)
  ) {
    throw new Error(`Card ${String(rest.id || PK || 'unknown')} is not in the canonical lifecycle shape`);
  }
  if (active && (
    rest.completedAt !== undefined
    || rest.completedBy !== undefined
    || rest.activeStageBeforeCompletion !== undefined
  )) {
    throw new Error(`Card ${String(rest.id || PK || 'unknown')} is not in the canonical lifecycle shape`);
  }
  return rest as unknown as Card;
}

/**
 * Create a new card. Generates a UUID, sets createdAt/updatedAt.
 */
function buildCard(
  data: Record<string, unknown>,
  aggregate: { taskCount: number; openTaskCount: number } = { taskCount: 0, openTaskCount: 0 },
): Card {
  const id = typeof data.id === 'string' && data.id.trim().length > 0 ? data.id : crypto.randomUUID();
  const now = new Date().toISOString();

  const item = {
    id,
    createdAt: now,
    updatedAt: now,
    ...data,
    version: 1,
    taskCount: aggregate.taskCount,
    openTaskCount: aggregate.openTaskCount,
    status: 'active',
    stage: isActiveCardStage(data.stage) ? data.stage : 'preparation',
  };

  for (const field of ['completedAt', 'completedBy', 'activeStageBeforeCompletion']) {
    delete (item as Record<string, unknown>)[field];
  }

  return cleanItem(item) as Card;
}

async function createCard(client: DynamoDBDocumentClient, data: Record<string, unknown>): Promise<Card> {
  const card = buildCard(data);

  await client.send(
    new PutCommand({
      TableName: TABLE_CARDS,
      Item: { ...cardKey(card.id), ...card },
      ConditionExpression: 'attribute_not_exists(PK)',
    })
  );

  return card;
}

/**
 * Get a card by id.
 */
async function getCard(client: DynamoDBDocumentClient, id: string): Promise<Card | null> {
  return getCardWithConsistency(client, id, false);
}

async function getCardConsistent(client: DynamoDBDocumentClient, id: string): Promise<Card | null> {
  return getCardWithConsistency(client, id, true);
}

async function getCardWithConsistency(
  client: DynamoDBDocumentClient,
  id: string,
  consistentRead: boolean,
): Promise<Card | null> {
  const result = await client.send(
    new GetCommand({
      TableName: TABLE_CARDS,
      Key: cardKey(id),
      ...(consistentRead ? { ConsistentRead: true } : {}),
    })
  );

  return result.Item ? cleanItem(result.Item as Record<string, unknown>) : null;
}

/**
 * Partial update of a card.
 */
async function updateCard(
  client: DynamoDBDocumentClient,
  id: string,
  mutation: CardMutation,
): Promise<Card> {
  if (!Number.isInteger(mutation.expectedVersion) || mutation.expectedVersion < 1) {
    throw new TypeError('expectedVersion must be an integer greater than or equal to 1');
  }
  const now = new Date().toISOString();
  const forbiddenFields = [
    'PK', 'SK', 'id', 'version', 'taskCount', 'openTaskCount', 'status',
    'completedAt', 'completedBy', 'activeStageBeforeCompletion',
    'createdAt', 'updatedAt', 'expectedVersion',
  ];
  const suppliedForbiddenField = forbiddenFields.find((field) => Object.hasOwn(mutation.patch, field));
  if (suppliedForbiddenField) throw new TypeError(`${suppliedForbiddenField} is not an allowed Card patch field`);
  if (mutation.patch.stage !== undefined && !isActiveCardStage(mutation.patch.stage)) {
    throw new TypeError('stage must be preparation, announced, or after-event');
  }
  const fields: Record<string, unknown> = { ...mutation.patch, updatedAt: now };

  const expressionParts: string[] = [];
  const removedParts: string[] = [];
  const expressionAttrNames: Record<string, string> = {};
  const expressionAttrValues: Record<string, unknown> = {};

  let i = 0;
  for (const [key, value] of Object.entries(fields)) {
    const nameToken = `#f${i}`;
    expressionAttrNames[nameToken] = key;
    // `null` clears an optional attribute. A cleared field is absent, not
    // stored as an explicit null the readers would then have to interpret.
    if (value === null) {
      removedParts.push(nameToken);
      i++;
      continue;
    }
    const valueToken = `:v${i}`;
    expressionParts.push(`${nameToken} = ${valueToken}`);
    expressionAttrValues[valueToken] = value;
    i++;
  }
  expressionParts.push('#version = :nextVersion');
  expressionAttrNames['#version'] = 'version';
  expressionAttrValues[':expectedVersion'] = mutation.expectedVersion;
  expressionAttrValues[':nextVersion'] = mutation.expectedVersion + 1;
  const conditionParts = ['attribute_exists(PK)', '#version = :expectedVersion'];
  if (mutation.patch.stage !== undefined) {
    expressionAttrNames['#status'] = 'status';
    expressionAttrValues[':activeStatus'] = 'active';
    conditionParts.push('#status = :activeStatus');
  }

  try {
    const result = await client.send(new UpdateCommand({
      TableName: TABLE_CARDS,
      Key: cardKey(id),
      UpdateExpression: removedParts.length > 0
        ? `SET ${expressionParts.join(', ')} REMOVE ${removedParts.join(', ')}`
        : `SET ${expressionParts.join(', ')}`,
      ConditionExpression: conditionParts.join(' AND '),
      ExpressionAttributeNames: expressionAttrNames,
      ExpressionAttributeValues: expressionAttrValues,
      ReturnValues: 'ALL_NEW',
    }));

    return cleanItem(result.Attributes as Record<string, unknown>) as Card;
  } catch (error) {
    if ((error as { name?: string })?.name === 'ConditionalCheckFailedException') {
      throw new CardVersionConflictError(id, mutation.expectedVersion);
    }
    throw error;
  }
}

/**
 * Merge a caller-owned additive reference with at most one refetch/remerge.
 */
async function updateCardAdditive(
  client: DynamoDBDocumentClient,
  initialCard: Card,
  buildPatch: AdditiveCardPatch,
): Promise<Card> {
  let currentCard = initialCard;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await updateCard(client, currentCard.id, {
        expectedVersion: currentCard.version,
        patch: buildPatch(currentCard),
      });
    } catch (error) {
      if (!(error instanceof CardVersionConflictError) || attempt === 1) throw error;
      const refreshed = await getCardConsistent(client, currentCard.id);
      if (!refreshed) throw new CardNotFoundError(currentCard.id);
      currentCard = refreshed;
    }
  }
  throw new Error('Unreachable additive Card mutation state');
}

/**
 * List all cards by scanning for items where PK begins with "CARD#".
 */
async function listCards(client: DynamoDBDocumentClient): Promise<Card[]> {
  const result = await client.send(
    new ScanCommand({
      TableName: TABLE_CARDS,
      FilterExpression: 'begins_with(PK, :prefix)',
      ExpressionAttributeValues: { ':prefix': 'CARD#' },
    })
  );

  return (result.Items || []).map((item) => cleanItem(item as Record<string, unknown>) as Card);
}

export {
  createCard,
  buildCard,
  getCard,
  getCardConsistent,
  updateCard,
  updateCardAdditive,
  listCards,
  CardVersionConflictError,
  CardNotFoundError,
  isActiveCardStage,
  cardKey,
};
export type { ActiveCardStage, AdditiveCardPatch, CardMutation, CardPatch };
