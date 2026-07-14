import {
  PutCommand,
  GetCommand,
  UpdateCommand,
  ScanCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { TABLE_ARTIFACTS } from './setup';
import type { ArtifactRecord } from '../types';

export interface ArtifactFilters {
  taskId?: string;
  bundleId?: string;
  assistantJobId?: string;
  fileId?: string;
  status?: string;
  type?: string;
}

function cleanItem(item: Record<string, unknown> | undefined): ArtifactRecord | null {
  if (!item) return null;
  const { PK, SK, ...rest } = item;
  return rest as unknown as ArtifactRecord;
}

async function createArtifact(
  client: DynamoDBDocumentClient,
  data: Record<string, unknown>
): Promise<ArtifactRecord> {
  const id = typeof data.id === 'string' && data.id.trim().length > 0 ? data.id : crypto.randomUUID();
  const now = new Date().toISOString();
  const item = {
    PK: `ARTIFACT#${id}`,
    SK: `ARTIFACT#${id}`,
    id,
    status: 'draft',
    createdAt: now,
    updatedAt: now,
    ...data,
  };

  await client.send(new PutCommand({
    TableName: TABLE_ARTIFACTS,
    Item: item,
  }));

  return cleanItem(item) as ArtifactRecord;
}

async function createArtifactIfAbsent(
  client: DynamoDBDocumentClient,
  data: Record<string, unknown>
): Promise<{ artifact: ArtifactRecord; created: boolean }> {
  const id = typeof data.id === 'string' && data.id.trim().length > 0 ? data.id : crypto.randomUUID();
  const now = new Date().toISOString();
  const item = {
    PK: `ARTIFACT#${id}`,
    SK: `ARTIFACT#${id}`,
    id,
    status: 'draft',
    createdAt: now,
    updatedAt: now,
    ...data,
  };
  try {
    await client.send(new PutCommand({
      TableName: TABLE_ARTIFACTS,
      Item: item,
      ConditionExpression: 'attribute_not_exists(PK)',
    }));
    return { artifact: cleanItem(item) as ArtifactRecord, created: true };
  } catch (error) {
    if ((error as { name?: string })?.name !== 'ConditionalCheckFailedException') throw error;
    const existing = await getArtifact(client, id);
    if (!existing) throw error;
    return { artifact: existing, created: false };
  }
}

async function getArtifact(client: DynamoDBDocumentClient, id: string): Promise<ArtifactRecord | null> {
  const result = await client.send(new GetCommand({
    TableName: TABLE_ARTIFACTS,
    Key: { PK: `ARTIFACT#${id}`, SK: `ARTIFACT#${id}` },
  }));

  return result.Item ? cleanItem(result.Item as Record<string, unknown>) : null;
}

async function deleteArtifact(client: DynamoDBDocumentClient, id: string): Promise<void> {
  await client.send(new DeleteCommand({
    TableName: TABLE_ARTIFACTS,
    Key: { PK: `ARTIFACT#${id}`, SK: `ARTIFACT#${id}` },
  }));
}

async function updateArtifact(
  client: DynamoDBDocumentClient,
  id: string,
  updates: Record<string, unknown>
): Promise<ArtifactRecord | null> {
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

  const result = await client.send(new UpdateCommand({
    TableName: TABLE_ARTIFACTS,
    Key: { PK: `ARTIFACT#${id}`, SK: `ARTIFACT#${id}` },
    UpdateExpression: `SET ${expressionParts.join(', ')}`,
    ExpressionAttributeNames: expressionAttrNames,
    ExpressionAttributeValues: expressionAttrValues,
    ReturnValues: 'ALL_NEW',
  }));

  return cleanItem(result.Attributes as Record<string, unknown>);
}

async function listArtifacts(
  client: DynamoDBDocumentClient,
  filters: ArtifactFilters = {}
): Promise<ArtifactRecord[]> {
  const filterExpressions: string[] = ['begins_with(PK, :prefix)'];
  const expressionAttrValues: Record<string, unknown> = { ':prefix': 'ARTIFACT#' };
  const expressionAttrNames: Record<string, string> = {};

  for (const [key, value] of Object.entries(filters)) {
    if (!value) continue;
    const nameToken = `#${key}`;
    const valueToken = `:${key}`;
    filterExpressions.push(`${nameToken} = ${valueToken}`);
    expressionAttrNames[nameToken] = key;
    expressionAttrValues[valueToken] = value;
  }

  const result = await client.send(new ScanCommand({
    TableName: TABLE_ARTIFACTS,
    FilterExpression: filterExpressions.join(' AND '),
    ExpressionAttributeNames: Object.keys(expressionAttrNames).length > 0 ? expressionAttrNames : undefined,
    ExpressionAttributeValues: expressionAttrValues,
  }));

  return (result.Items || []).map((item) => cleanItem(item as Record<string, unknown>) as ArtifactRecord);
}

export {
  createArtifact,
  createArtifactIfAbsent,
  deleteArtifact,
  getArtifact,
  updateArtifact,
  listArtifacts,
};
