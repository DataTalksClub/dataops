import {
  PutCommand,
  GetCommand,
  DeleteCommand,
  UpdateCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { TABLE_TASKS } from './setup';
import { createTask } from './tasks';
import type { RecurringConfig, Task } from '../types';

/**
 * Strip DynamoDB key attributes (PK, SK) from an item.
 */
function cleanItem(item: Record<string, unknown> | undefined): RecurringConfig | null {
  if (!item) return null;
  const { PK, SK, ...rest } = item;
  return rest as unknown as RecurringConfig;
}

/**
 * Match a single cron field value against a date value.
 * Supports: '*' (any), specific numbers, comma-separated lists, and step values (N).
 */
function matchCronField(fieldExpr: string, value: number): boolean {
  // Wildcard matches everything
  if (fieldExpr === '*') return true;

  // Step value: */N
  if (fieldExpr.startsWith('*/')) {
    const step = parseInt(fieldExpr.slice(2), 10);
    if (isNaN(step) || step <= 0) return false;
    return value % step === 0;
  }

  // Comma-separated list: 1,3,5
  const parts = fieldExpr.split(',');
  for (const part of parts) {
    const num = parseInt(part.trim(), 10);
    if (!isNaN(num) && num === value) return true;
  }

  return false;
}

/**
 * Check if a date matches a cron expression.
 * Cron format: minute hour day-of-month month day-of-week
 * For date-level matching, only day-of-month (field 3), month (field 4),
 * and day-of-week (field 5) matter.
 */
function cronMatchesDate(cronExpression: string, date: Date): boolean {
  const fields = cronExpression.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  const dayOfMonth = fields[2];
  const month = fields[3];
  const dayOfWeek = fields[4];

  const dateDay = date.getUTCDate();
  const dateMonth = date.getUTCMonth() + 1; // JS months are 0-based
  const dateDow = date.getUTCDay(); // 0=Sunday

  return (
    matchCronField(dayOfMonth, dateDay) &&
    matchCronField(month, dateMonth) &&
    matchCronField(dayOfWeek, dateDow)
  );
}

/**
 * Create a new recurring config. Generates a UUID, sets createdAt/updatedAt.
 */
async function createRecurringConfig(client: DynamoDBDocumentClient, data: Record<string, unknown>): Promise<RecurringConfig> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const item = {
    PK: `RECURRING#${id}`,
    SK: `RECURRING#${id}`,
    id,
    createdAt: now,
    updatedAt: now,
    enabled: true,
    ...data,
  };

  await client.send(
    new PutCommand({
      TableName: TABLE_TASKS,
      Item: item,
    })
  );

  return cleanItem(item) as RecurringConfig;
}

/**
 * Get a recurring config by id.
 */
async function getRecurringConfig(client: DynamoDBDocumentClient, id: string): Promise<RecurringConfig | null> {
  const result = await client.send(
    new GetCommand({
      TableName: TABLE_TASKS,
      Key: { PK: `RECURRING#${id}`, SK: `RECURRING#${id}` },
    })
  );

  return result.Item ? cleanItem(result.Item as Record<string, unknown>) : null;
}

/**
 * Partial update of a recurring config.
 */
async function updateRecurringConfig(client: DynamoDBDocumentClient, id: string, updates: Record<string, unknown>): Promise<RecurringConfig | null> {
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
      Key: { PK: `RECURRING#${id}`, SK: `RECURRING#${id}` },
      UpdateExpression: `SET ${expressionParts.join(', ')}`,
      ExpressionAttributeNames: expressionAttrNames,
      ExpressionAttributeValues: expressionAttrValues,
      ReturnValues: 'ALL_NEW',
    })
  );

  return cleanItem(result.Attributes as Record<string, unknown>);
}

/**
 * Delete a recurring config by id.
 */
async function deleteRecurringConfig(client: DynamoDBDocumentClient, id: string): Promise<void> {
  await client.send(
    new DeleteCommand({
      TableName: TABLE_TASKS,
      Key: { PK: `RECURRING#${id}`, SK: `RECURRING#${id}` },
    })
  );
}

/**
 * List all recurring configs by scanning for items where PK begins with "RECURRING#".
 */
async function listRecurringConfigs(client: DynamoDBDocumentClient): Promise<RecurringConfig[]> {
  const result = await client.send(
    new ScanCommand({
      TableName: TABLE_TASKS,
      FilterExpression: 'begins_with(PK, :prefix)',
      ExpressionAttributeValues: { ':prefix': 'RECURRING#' },
    })
  );

  return (result.Items || []).map((item) => cleanItem(item as Record<string, unknown>) as RecurringConfig);
}

/**
 * List only enabled recurring configs.
 */
async function listEnabledRecurringConfigs(client: DynamoDBDocumentClient): Promise<RecurringConfig[]> {
  const result = await client.send(
    new ScanCommand({
      TableName: TABLE_TASKS,
      FilterExpression: 'begins_with(PK, :prefix) AND enabled = :enabled',
      ExpressionAttributeValues: {
        ':prefix': 'RECURRING#',
        ':enabled': true,
      },
    })
  );

  return (result.Items || []).map((item) => cleanItem(item as Record<string, unknown>) as RecurringConfig);
}

/**
 * Check if a recurring task already exists for a given config and date.
 * Returns true if a matching task exists.
 */
async function recurringTaskExists(client: DynamoDBDocumentClient, recurringConfigId: string, date: string): Promise<boolean> {
  const result = await client.send(
    new ScanCommand({
      TableName: TABLE_TASKS,
      FilterExpression:
        'begins_with(PK, :taskPrefix) AND #src = :source AND recurringConfigId = :configId AND #d = :date',
      ExpressionAttributeNames: {
        '#src': 'source',
        '#d': 'date',
      },
      ExpressionAttributeValues: {
        ':taskPrefix': 'TASK#',
        ':source': 'recurring',
        ':configId': recurringConfigId,
        ':date': date,
      },
    })
  );

  return (result.Items || []).length > 0;
}

/**
 * Generate concrete task instances from enabled recurring configs for a date range.
 * Uses cron expression matching to determine which dates each config should generate tasks for.
 */
async function generateRecurringTasks(client: DynamoDBDocumentClient, startDate: string, endDate: string): Promise<{ generated: Task[]; skipped: number }> {
  const configs = await listEnabledRecurringConfigs(client);

  const generated: Task[] = [];
  let skipped = 0;

  // Build list of dates in range
  const dates: string[] = [];
  const current = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');

  while (current <= end) {
    dates.push(current.toISOString().split('T')[0]);
    current.setUTCDate(current.getUTCDate() + 1);
  }

  for (const config of configs) {
    for (const dateStr of dates) {
      const d = new Date(dateStr + 'T00:00:00Z');

      const matches = cronMatchesDate(config.cronExpression, d);

      if (!matches) continue;

      // Idempotency check
      const exists = await recurringTaskExists(client, config.id, dateStr);
      if (exists) {
        skipped++;
        continue;
      }

      // Create the task
      const taskData: Record<string, unknown> = {
        description: config.description,
        date: dateStr,
        status: 'todo',
        source: 'recurring',
        recurringConfigId: config.id,
      };

      if (config.assigneeId) {
        taskData.assigneeId = config.assigneeId;
      }

      const task = await createTask(client, taskData);
      generated.push(task);
    }
  }

  return { generated, skipped };
}

export {
  createRecurringConfig,
  getRecurringConfig,
  updateRecurringConfig,
  deleteRecurringConfig,
  listRecurringConfigs,
  listEnabledRecurringConfigs,
  generateRecurringTasks,
  cronMatchesDate,
  matchCronField,
};
