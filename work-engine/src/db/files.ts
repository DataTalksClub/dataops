import {
  PutCommand,
  GetCommand,
  DeleteCommand,
  QueryCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { TABLE_FILES } from './setup';
import type { FileRecord } from '../types';

/**
 * Strip DynamoDB key attributes (PK, SK) from an item.
 */
function cleanItem(item: Record<string, unknown> | undefined): FileRecord | null {
  if (!item) return null;
  const { PK, SK, ...rest } = item;
  return rest as unknown as FileRecord;
}

/**
 * Create a new file metadata record. Generates a UUID, sets createdAt.
 */
async function createFile(client: DynamoDBDocumentClient, data: Record<string, unknown>): Promise<FileRecord> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const item = {
    PK: `FILE#${id}`,
    SK: `FILE#${id}`,
    id,
    createdAt: now,
    ...data,
  };

  await client.send(
    new PutCommand({
      TableName: TABLE_FILES,
      Item: item,
    })
  );

  return cleanItem(item) as FileRecord;
}

/**
 * Get a file metadata record by id.
 */
async function getFile(client: DynamoDBDocumentClient, id: string): Promise<FileRecord | null> {
  const result = await client.send(
    new GetCommand({
      TableName: TABLE_FILES,
      Key: { PK: `FILE#${id}`, SK: `FILE#${id}` },
    })
  );

  return result.Item ? cleanItem(result.Item as Record<string, unknown>) : null;
}

/**
 * Delete a file metadata record by id.
 */
async function deleteFile(client: DynamoDBDocumentClient, id: string): Promise<void> {
  await client.send(
    new DeleteCommand({
      TableName: TABLE_FILES,
      Key: { PK: `FILE#${id}`, SK: `FILE#${id}` },
    })
  );
}

/**
 * List files for a specific task using GSI-Task.
 */
async function listFilesByTask(client: DynamoDBDocumentClient, taskId: string): Promise<FileRecord[]> {
  const result = await client.send(
    new QueryCommand({
      TableName: TABLE_FILES,
      IndexName: 'GSI-Task',
      KeyConditionExpression: 'taskId = :tid',
      ExpressionAttributeValues: { ':tid': taskId },
    })
  );

  return (result.Items || []).map((item) => cleanItem(item as Record<string, unknown>) as FileRecord);
}

/**
 * List files with optional category and tag filters using a scan.
 */
async function listFiles(client: DynamoDBDocumentClient, filters?: { category?: string; tag?: string }): Promise<FileRecord[]> {
  const filterExpressions: string[] = ['begins_with(PK, :prefix)'];
  const expressionAttrValues: Record<string, unknown> = { ':prefix': 'FILE#' };
  const expressionAttrNames: Record<string, string> = {};

  if (filters?.category) {
    filterExpressions.push('#cat = :cat');
    expressionAttrNames['#cat'] = 'category';
    expressionAttrValues[':cat'] = filters.category;
  }

  if (filters?.tag) {
    filterExpressions.push('contains(tags, :tag)');
    expressionAttrValues[':tag'] = filters.tag;
  }

  const params: Record<string, unknown> = {
    TableName: TABLE_FILES,
    FilterExpression: filterExpressions.join(' AND '),
    ExpressionAttributeValues: expressionAttrValues,
  };

  if (Object.keys(expressionAttrNames).length > 0) {
    params.ExpressionAttributeNames = expressionAttrNames;
  }

  const result = await client.send(new ScanCommand(params as any));

  return (result.Items || []).map((item) => cleanItem(item as Record<string, unknown>) as FileRecord);
}

export {
  createFile,
  getFile,
  deleteFile,
  listFilesByTask,
  listFiles,
};
