import {
  PutCommand,
  GetCommand,
  DeleteCommand,
  UpdateCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { TABLE_BUNDLES } from './setup';
import type { Bundle } from '../types';

/**
 * Strip DynamoDB key attributes (PK, SK) from an item.
 */
function cleanItem(item: Record<string, unknown> | undefined): Bundle | null {
  if (!item) return null;
  const { PK, SK, ...rest } = item;
  return rest as unknown as Bundle;
}

/**
 * Create a new bundle. Generates a UUID, sets createdAt/updatedAt.
 */
async function createBundle(client: DynamoDBDocumentClient, data: Record<string, unknown>): Promise<Bundle> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const item = {
    PK: `BUNDLE#${id}`,
    SK: `BUNDLE#${id}`,
    id,
    createdAt: now,
    updatedAt: now,
    ...data,
  };

  await client.send(
    new PutCommand({
      TableName: TABLE_BUNDLES,
      Item: item,
    })
  );

  return cleanItem(item) as Bundle;
}

/**
 * Get a bundle by id.
 */
async function getBundle(client: DynamoDBDocumentClient, id: string): Promise<Bundle | null> {
  const result = await client.send(
    new GetCommand({
      TableName: TABLE_BUNDLES,
      Key: { PK: `BUNDLE#${id}`, SK: `BUNDLE#${id}` },
    })
  );

  return result.Item ? cleanItem(result.Item as Record<string, unknown>) : null;
}

/**
 * Partial update of a bundle.
 */
async function updateBundle(client: DynamoDBDocumentClient, id: string, updates: Record<string, unknown>): Promise<Bundle | null> {
  const now = new Date().toISOString();
  const fields: Record<string, unknown> = { ...updates, updatedAt: now };

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

  const result = await client.send(
    new UpdateCommand({
      TableName: TABLE_BUNDLES,
      Key: { PK: `BUNDLE#${id}`, SK: `BUNDLE#${id}` },
      UpdateExpression: `SET ${expressionParts.join(', ')}`,
      ExpressionAttributeNames: expressionAttrNames,
      ExpressionAttributeValues: expressionAttrValues,
      ReturnValues: 'ALL_NEW',
    })
  );

  return cleanItem(result.Attributes as Record<string, unknown>);
}

/**
 * Delete a bundle by id.
 */
async function deleteBundle(client: DynamoDBDocumentClient, id: string): Promise<void> {
  await client.send(
    new DeleteCommand({
      TableName: TABLE_BUNDLES,
      Key: { PK: `BUNDLE#${id}`, SK: `BUNDLE#${id}` },
    })
  );
}

/**
 * List all bundles by scanning for items where PK begins with "BUNDLE#".
 */
async function listBundles(client: DynamoDBDocumentClient): Promise<Bundle[]> {
  const result = await client.send(
    new ScanCommand({
      TableName: TABLE_BUNDLES,
      FilterExpression: 'begins_with(PK, :prefix)',
      ExpressionAttributeValues: { ':prefix': 'BUNDLE#' },
    })
  );

  return (result.Items || []).map((item) => cleanItem(item as Record<string, unknown>) as Bundle);
}

export {
  createBundle,
  getBundle,
  updateBundle,
  deleteBundle,
  listBundles,
};
