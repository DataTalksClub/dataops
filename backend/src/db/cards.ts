import {
  PutCommand,
  GetCommand,
  DeleteCommand,
  UpdateCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { TABLE_CARDS } from './setup';
import type { Card } from '../types';

/**
 * Strip DynamoDB key attributes (PK, SK) from an item.
 */
function cleanItem(item: Record<string, unknown> | undefined): Card | null {
  if (!item) return null;
  const { PK, SK, ...rest } = item;
  return { ...rest, version: typeof rest.version === 'number' ? rest.version : 1 } as unknown as Card;
}

/**
 * Create a new card. Generates a UUID, sets createdAt/updatedAt.
 */
async function createCard(client: DynamoDBDocumentClient, data: Record<string, unknown>): Promise<Card> {
  const id = typeof data.id === 'string' && data.id.trim().length > 0 ? data.id : crypto.randomUUID();
  const now = new Date().toISOString();

  const item = {
    PK: `CARD#${id}`,
    SK: `CARD#${id}`,
    id,
    createdAt: now,
    updatedAt: now,
    ...data,
    version: 1,
  };

  await client.send(
    new PutCommand({
      TableName: TABLE_CARDS,
      Item: item,
    })
  );

  return cleanItem(item) as Card;
}

/**
 * Get a card by id.
 */
async function getCard(client: DynamoDBDocumentClient, id: string): Promise<Card | null> {
  const result = await client.send(
    new GetCommand({
      TableName: TABLE_CARDS,
      Key: { PK: `CARD#${id}`, SK: `CARD#${id}` },
    })
  );

  return result.Item ? cleanItem(result.Item as Record<string, unknown>) : null;
}

/**
 * Partial update of a card.
 */
async function updateCard(client: DynamoDBDocumentClient, id: string, updates: Record<string, unknown>): Promise<Card | null> {
  const now = new Date().toISOString();
  const { version: _ignoredVersion, ...safeUpdates } = updates;
  const fields: Record<string, unknown> = { ...safeUpdates, updatedAt: now };

  const expressionParts: string[] = [];
  const expressionAttrNames: Record<string, string> = {};
  const expressionAttrValues: Record<string, unknown> = {};

  let i = 0;
  for (const [key, value] of Object.entries(fields)) {
    const nameToken = `#f${i}`;
    const valueToken = `:v${i}`;
    expressionParts.push(`${nameToken} = ${valueToken}`);
    expressionAttrNames[nameToken] = key;
    expressionAttrValues[valueToken] = value;
    i++;
  }
  expressionParts.push('#version = if_not_exists(#version, :versionBase) + :versionIncrement');
  expressionAttrNames['#version'] = 'version';
  expressionAttrValues[':versionBase'] = 1;
  expressionAttrValues[':versionIncrement'] = 1;

  const result = await client.send(
    new UpdateCommand({
      TableName: TABLE_CARDS,
      Key: { PK: `CARD#${id}`, SK: `CARD#${id}` },
      UpdateExpression: `SET ${expressionParts.join(', ')}`,
      ExpressionAttributeNames: expressionAttrNames,
      ExpressionAttributeValues: expressionAttrValues,
      ReturnValues: 'ALL_NEW',
    })
  );

  return cleanItem(result.Attributes as Record<string, unknown>);
}

/**
 * Delete a card by id.
 */
async function deleteCard(client: DynamoDBDocumentClient, id: string): Promise<void> {
  await client.send(
    new DeleteCommand({
      TableName: TABLE_CARDS,
      Key: { PK: `CARD#${id}`, SK: `CARD#${id}` },
    })
  );
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
  getCard,
  updateCard,
  deleteCard,
  listCards,
};
