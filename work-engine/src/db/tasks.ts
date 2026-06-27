import {
  PutCommand,
  GetCommand,
  DeleteCommand,
  UpdateCommand,
  QueryCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { TABLE_TASKS } from './setup';
import type { Task } from '../types';

/**
 * Strip DynamoDB key attributes (PK, SK) from an item, returning a clean object.
 */
function cleanItem(item: Record<string, unknown> | undefined): Task | null {
  if (!item) return null;
  const { PK, SK, ...rest } = item;
  return rest as unknown as Task;
}

/**
 * Create a new task. Generates a UUID, sets createdAt/updatedAt, and writes to DynamoDB.
 * Returns the clean task object (without PK/SK).
 */
async function createTask(client: DynamoDBDocumentClient, taskData: Record<string, unknown>): Promise<Task> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const item = {
    PK: `TASK#${id}`,
    SK: `TASK#${id}`,
    id,
    createdAt: now,
    updatedAt: now,
    status: 'todo',
    ...taskData,
  };

  await client.send(
    new PutCommand({
      TableName: TABLE_TASKS,
      Item: item,
    })
  );

  return cleanItem(item) as Task;
}

/**
 * Get a task by id. Returns the clean object or null if not found.
 */
async function getTask(client: DynamoDBDocumentClient, id: string): Promise<Task | null> {
  const result = await client.send(
    new GetCommand({
      TableName: TABLE_TASKS,
      Key: { PK: `TASK#${id}`, SK: `TASK#${id}` },
    })
  );

  return result.Item ? cleanItem(result.Item as Record<string, unknown>) : null;
}

/**
 * Partial update of a task. Builds an UpdateExpression from the updates object.
 * Always updates updatedAt.
 */
async function updateTask(client: DynamoDBDocumentClient, id: string, updates: Record<string, unknown>): Promise<Task | null> {
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
      TableName: TABLE_TASKS,
      Key: { PK: `TASK#${id}`, SK: `TASK#${id}` },
      UpdateExpression: `SET ${expressionParts.join(', ')}`,
      ExpressionAttributeNames: expressionAttrNames,
      ExpressionAttributeValues: expressionAttrValues,
      ReturnValues: 'ALL_NEW',
    })
  );

  return cleanItem(result.Attributes as Record<string, unknown>);
}

/**
 * Delete a task by id.
 */
async function deleteTask(client: DynamoDBDocumentClient, id: string): Promise<void> {
  await client.send(
    new DeleteCommand({
      TableName: TABLE_TASKS,
      Key: { PK: `TASK#${id}`, SK: `TASK#${id}` },
    })
  );
}

/**
 * List tasks for a specific date using GSI-Date.
 */
async function listTasksByDate(client: DynamoDBDocumentClient, date: string): Promise<Task[]> {
  const result = await client.send(
    new QueryCommand({
      TableName: TABLE_TASKS,
      IndexName: 'GSI-Date',
      KeyConditionExpression: '#d = :date',
      ExpressionAttributeNames: { '#d': 'date' },
      ExpressionAttributeValues: { ':date': date },
    })
  );

  return (result.Items || []).map((item) => cleanItem(item as Record<string, unknown>) as Task);
}

/**
 * List tasks within a date range. Uses a Scan with a FilterExpression since
 * date is the partition key on GSI-Date and range queries require sort key.
 */
async function listTasksByDateRange(client: DynamoDBDocumentClient, startDate: string, endDate: string): Promise<Task[]> {
  const result = await client.send(
    new ScanCommand({
      TableName: TABLE_TASKS,
      FilterExpression:
        '#d BETWEEN :start AND :end AND begins_with(PK, :prefix)',
      ExpressionAttributeNames: { '#d': 'date' },
      ExpressionAttributeValues: {
        ':start': startDate,
        ':end': endDate,
        ':prefix': 'TASK#',
      },
    })
  );

  return (result.Items || []).map((item) => cleanItem(item as Record<string, unknown>) as Task);
}

/**
 * List tasks for a specific bundle using GSI-Bundle.
 */
async function listTasksByBundle(client: DynamoDBDocumentClient, bundleId: string): Promise<Task[]> {
  const result = await client.send(
    new QueryCommand({
      TableName: TABLE_TASKS,
      IndexName: 'GSI-Bundle',
      KeyConditionExpression: 'bundleId = :bid',
      ExpressionAttributeValues: { ':bid': bundleId },
    })
  );

  return (result.Items || []).map((item) => cleanItem(item as Record<string, unknown>) as Task);
}

/**
 * List tasks by status using GSI-Status.
 */
async function listTasksByStatus(client: DynamoDBDocumentClient, status: string): Promise<Task[]> {
  const result = await client.send(
    new QueryCommand({
      TableName: TABLE_TASKS,
      IndexName: 'GSI-Status',
      KeyConditionExpression: '#s = :status',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':status': status },
    })
  );

  return (result.Items || []).map((item) => cleanItem(item as Record<string, unknown>) as Task);
}

export {
  createTask,
  getTask,
  updateTask,
  deleteTask,
  listTasksByDate,
  listTasksByDateRange,
  listTasksByBundle,
  listTasksByStatus,
};
