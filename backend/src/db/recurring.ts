import {
  PutCommand,
  GetCommand,
  DeleteCommand,
  UpdateCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { TABLE_TASKS } from './tableNames';
import { createTask } from './tasks';
import { cronMatchesDate, nextMatchingDate } from '../cron/cronMatch';
import { berlinDate } from '../sponsorFinance/core';
import type { RecurringConfig, RecurringRun, RecurringRunOutcome, Task } from '../types';

/**
 * Strip DynamoDB key attributes (PK, SK) from an item.
 */
function cleanItem(item: Record<string, unknown> | undefined): RecurringConfig | null {
  if (!item) return null;
  const { PK, SK, ...rest } = item;
  return rest as unknown as RecurringConfig;
}

function recurringRunKey(configId: string, date: string): { PK: string; SK: string } {
  const key = `RECURRINGRUN#${configId}#${date}`;
  return { PK: key, SK: key };
}

function addDaysToIsoDate(isoDate: string, days: number): string {
  const next = new Date(`${isoDate}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().split('T')[0];
}

/**
 * The civil date the next run is walked from. A range that reaches today ends
 * the walk after the range, so the daily pass never replays what it just did.
 * A manual backfill or a pre-generated future range instead leaves the next
 * run at the first match from today: the range neither strands the label in
 * the past nor skips over work the daily pass has not generated yet.
 */
function nextRunBase(startDate: string, endDate: string): string {
  const today = berlinDate();
  if (startDate > today || endDate < today) return today;
  return addDaysToIsoDate(endDate, 1);
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
    nextRunDate: nextMatchingDate(String(data.cronExpression || '')),
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
  if (updates.cronExpression !== undefined && updates.nextRunDate === undefined) {
    fields.nextRunDate = nextMatchingDate(String(updates.cronExpression));
  }

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

async function listRecurringRuns(client: DynamoDBDocumentClient, configId: string): Promise<RecurringRun[]> {
  const result = await client.send(
    new ScanCommand({
      TableName: TABLE_TASKS,
      FilterExpression: 'begins_with(PK, :runPrefix)',
      ExpressionAttributeValues: {
        ':runPrefix': `RECURRINGRUN#${configId}#`,
      },
    })
  );

  return (result.Items || []).map((item) => {
    const { PK, SK, ...rest } = item as Record<string, unknown>;
    return rest as unknown as RecurringRun;
  });
}

async function countRecurringConfigRuns(client: DynamoDBDocumentClient, configId: string): Promise<number> {
  return (await listRecurringRuns(client, configId)).length;
}

/**
 * Append one ledger row per config per date the daily pass fired it. The row is
 * keyed by that pair, so re-running the same date replaces the row instead of
 * accumulating one entry per attempt.
 */
async function recordRecurringRun(
  client: DynamoDBDocumentClient,
  run: { configId: string; date: string; outcome: RecurringRunOutcome; generatedTaskIds: string[] },
): Promise<void> {
  const { PK, SK } = recurringRunKey(run.configId, run.date);
  const item: RecurringRun & { PK: string; SK: string } = {
    PK,
    SK,
    configId: run.configId,
    date: run.date,
    outcome: run.outcome,
    generatedTaskIds: run.generatedTaskIds,
    createdAt: new Date().toISOString(),
  };

  await client.send(
    new PutCommand({
      TableName: TABLE_TASKS,
      Item: item,
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

function recurringTaskDefaults(config: RecurringConfig): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  const fields: (keyof RecurringConfig)[] = [
    'assigneeId',
    'instructionsUrl',
    'instructionDocId',
    'instructionStepId',
    'systems',
    'proofRequirement',
    'requiredLinkName',
    'requiresFile',
    'tags',
  ];

  for (const field of fields) {
    const value = config[field];
    if (value !== undefined) defaults[field] = value;
  }

  return defaults;
}

/**
 * Generate concrete task instances from enabled recurring configs for a date range.
 * Uses cron expression matching to determine which dates each config should generate tasks for.
 *
 * Each config that fired leaves a ledger row and its own outcome on the config,
 * so the daily pass records what happened even when a config generated nothing.
 * A config that throws does not stop the others.
 */
async function generateRecurringTasks(
  client: DynamoDBDocumentClient,
  startDate: string,
  endDate: string,
): Promise<{ generated: Task[]; skipped: number; failures: number }> {
  const configs = await listEnabledRecurringConfigs(client);

  const generated: Task[] = [];
  let skipped = 0;
  let failures = 0;

  // Build list of dates in range
  const dates: string[] = [];
  const current = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');

  while (current <= end) {
    dates.push(current.toISOString().split('T')[0]);
    current.setUTCDate(current.getUTCDate() + 1);
  }

  for (const config of configs) {
    const generatedTaskIds: string[] = [];
    let firedDate: string | null = null;
    let outcome: RecurringRunOutcome | null = null;

    try {
      for (const dateStr of dates) {
        const d = new Date(dateStr + 'T00:00:00Z');

        const matches = cronMatchesDate(config.cronExpression, d);

        if (!matches) continue;
        firedDate = dateStr;

        // Idempotency check
        const exists = await recurringTaskExists(client, config.id, dateStr);
        if (exists) {
          skipped++;
          continue;
        }

        // Create the task
        const taskData: Record<string, unknown> = {
          ...recurringTaskDefaults(config),
          description: config.description,
          date: dateStr,
          status: 'todo',
          source: 'recurring',
          recurringConfigId: config.id,
        };

        const task = await createTask(client, taskData);
        generatedTaskIds.push(task.id);
        generated.push(task);
      }
      outcome = firedDate === null ? null : 'succeeded';
    } catch (err: unknown) {
      outcome = 'failed';
      failures++;
      console.error(`Recurring generation failed for config ${config.id}:`, (err as Error).message);
    }

    if (!outcome) continue;

    await recordRecurringRun(client, {
      configId: config.id,
      date: firedDate || endDate,
      outcome,
      generatedTaskIds,
    });
    await updateRecurringConfig(client, config.id, {
      lastRunAt: new Date().toISOString(),
      lastRunOutcome: outcome,
      // Noon UTC is the same Berlin civil date whatever the offset, so the walk
      // starts from the day after the range instead of replaying it.
      ...(outcome === 'succeeded'
        ? { nextRunDate: nextMatchingDate(config.cronExpression, new Date(`${nextRunBase(startDate, endDate)}T12:00:00Z`)) }
        : {}),
    });
  }

  return { generated, skipped, failures };
}

export {
  createRecurringConfig,
  getRecurringConfig,
  updateRecurringConfig,
  deleteRecurringConfig,
  countRecurringConfigRuns,
  listRecurringRuns,
  recordRecurringRun,
  listRecurringConfigs,
  listEnabledRecurringConfigs,
  generateRecurringTasks,
  recurringTaskDefaults,
};
