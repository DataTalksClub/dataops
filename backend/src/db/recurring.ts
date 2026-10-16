import {
  PutCommand,
  GetCommand,
  DeleteCommand,
  UpdateCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { readAllPages } from './readAllPages';
import { TABLE_TASKS } from './tableNames';
import { loadAssignmentPolicy } from './workspaceSettings';
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
 * Get a live recurring config by id. A deleted schedule's tombstone is not a
 * schedule: it reads as missing.
 */
async function getRecurringConfig(client: DynamoDBDocumentClient, id: string): Promise<RecurringConfig | null> {
  const result = await client.send(
    new GetCommand({
      TableName: TABLE_TASKS,
      Key: { PK: `RECURRING#${id}`, SK: `RECURRING#${id}` },
    })
  );

  const config = result.Item ? cleanItem(result.Item as Record<string, unknown>) : null;
  return config && !config.deletedAt ? config : null;
}

/**
 * Partial update of a recurring config.
 */
async function updateRecurringConfig(client: DynamoDBDocumentClient, id: string, updates: Record<string, unknown>): Promise<RecurringConfig | null> {
  const now = new Date().toISOString();
  const fields: Record<string, unknown> = { ...updates, updatedAt: now };
  // The next run is walked again from today whenever the schedule changes or
  // comes back from a pause; a paused schedule's stored date went stale while
  // the daily pass skipped it.
  if (updates.nextRunDate === undefined) {
    if (updates.cronExpression !== undefined) {
      fields.nextRunDate = nextMatchingDate(String(updates.cronExpression));
    } else if (updates.enabled === true) {
      const current = await getRecurringConfig(client, id);
      if (current) fields.nextRunDate = nextMatchingDate(current.cronExpression);
    }
  }

  const expressionParts: string[] = [];
  const expressionAttrNames: Record<string, string> = {};
  const expressionAttrValues: Record<string, unknown> = {};

  const removeParts: string[] = [];
  let i = 0;
  for (const [key, value] of Object.entries(fields)) {
    const nameToken = `#f${i}`;
    expressionAttrNames[nameToken] = key;
    i++;
    // null clears the field (e.g. an assignee, so the schedule uses the default).
    if (value === null) {
      removeParts.push(nameToken);
      continue;
    }
    const valueToken = `:v${i}`;
    expressionParts.push(`${nameToken} = ${valueToken}`);
    expressionAttrValues[valueToken] = value;
  }

  const result = await client.send(
    new UpdateCommand({
      TableName: TABLE_TASKS,
      Key: { PK: `RECURRING#${id}`, SK: `RECURRING#${id}` },
      UpdateExpression: `SET ${expressionParts.join(', ')}${removeParts.length ? ` REMOVE ${removeParts.join(', ')}` : ''}`,
      ExpressionAttributeNames: expressionAttrNames,
      ExpressionAttributeValues: expressionAttrValues,
      ReturnValues: 'ALL_NEW',
    })
  );

  return cleanItem(result.Attributes as Record<string, unknown>);
}

/**
 * Delete a paused schedule that has generated history. The row stays as a
 * tombstone holding the schedule's name and settings, so every Task,
 * notification and run that cites it still resolves to what generated it; it
 * is gone from every list, lookup and daily pass.
 */
async function tombstoneRecurringConfig(client: DynamoDBDocumentClient, id: string): Promise<void> {
  const now = new Date().toISOString();
  await client.send(
    new UpdateCommand({
      TableName: TABLE_TASKS,
      Key: { PK: `RECURRING#${id}`, SK: `RECURRING#${id}` },
      UpdateExpression: 'SET deletedAt = :now, updatedAt = :now REMOVE nextRunDate',
      ConditionExpression: 'attribute_exists(PK) AND enabled = :paused AND attribute_not_exists(deletedAt)',
      ExpressionAttributeValues: { ':now': now, ':paused': false },
    })
  );
}

/**
 * Hard-delete a schedule that never generated anything: nothing cites it.
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
  const items = await readAllPages(client, (exclusiveStartKey) => new ScanCommand({
    TableName: TABLE_TASKS,
    FilterExpression: 'begins_with(PK, :runPrefix)',
    ExpressionAttributeValues: {
      ':runPrefix': `RECURRINGRUN#${configId}#`,
    },
    ExclusiveStartKey: exclusiveStartKey,
  }));

  return items.map((item) => {
    const { PK, SK, ...rest } = item as Record<string, unknown>;
    return rest as unknown as RecurringRun;
  });
}

/**
 * What a schedule has generated: its run-ledger rows and the Tasks that cite
 * it. Tasks from before the ledger existed count too.
 */
async function countRecurringConfigHistory(
  client: DynamoDBDocumentClient,
  configId: string,
): Promise<{ runs: number; tasks: number }> {
  const runs = (await listRecurringRuns(client, configId)).length;
  const tasks = (await readAllPages(client, (exclusiveStartKey) => new ScanCommand({
    TableName: TABLE_TASKS,
    FilterExpression: 'begins_with(PK, :taskPrefix) AND recurringConfigId = :configId',
    ExpressionAttributeValues: { ':taskPrefix': 'TASK#', ':configId': configId },
    ProjectionExpression: 'PK',
    ExclusiveStartKey: exclusiveStartKey,
  }))).length;
  return { runs, tasks };
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
 * List every live recurring config; deleted schedules' tombstones are left out.
 */
async function listRecurringConfigs(client: DynamoDBDocumentClient): Promise<RecurringConfig[]> {
  const items = await readAllPages(client, (exclusiveStartKey) => new ScanCommand({
    TableName: TABLE_TASKS,
    FilterExpression: 'begins_with(PK, :prefix) AND attribute_not_exists(deletedAt)',
    ExpressionAttributeValues: { ':prefix': 'RECURRING#' },
    ExclusiveStartKey: exclusiveStartKey,
  }));

  return items.map((item) => cleanItem(item as Record<string, unknown>) as RecurringConfig);
}

/**
 * List only enabled recurring configs.
 */
async function listEnabledRecurringConfigs(client: DynamoDBDocumentClient): Promise<RecurringConfig[]> {
  const items = await readAllPages(client, (exclusiveStartKey) => new ScanCommand({
    TableName: TABLE_TASKS,
    FilterExpression: 'begins_with(PK, :prefix) AND enabled = :enabled AND attribute_not_exists(deletedAt)',
    ExpressionAttributeValues: {
      ':prefix': 'RECURRING#',
      ':enabled': true,
    },
    ExclusiveStartKey: exclusiveStartKey,
  }));

  return items.map((item) => cleanItem(item as Record<string, unknown>) as RecurringConfig);
}

/**
 * Check if a recurring task already exists for a given config and date.
 * Returns true if a matching task exists.
 */
async function recurringTaskExists(client: DynamoDBDocumentClient, recurringConfigId: string, date: string): Promise<boolean> {
  const items = await readAllPages(client, (exclusiveStartKey) => new ScanCommand({
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
    ExclusiveStartKey: exclusiveStartKey,
  }));

  return items.length > 0;
}

function recurringTaskDefaults(config: RecurringConfig): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  const fields: (keyof RecurringConfig)[] = [
    'assigneeId',
    'instructionsUrl',
    'instructionDocId',
    'instructionStepId',
    'requires',
    'browserRequirement',
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
  // A schedule without an assignee, or naming one who has left, goes to the
  // workspace default.
  const assignment = await loadAssignmentPolicy(client, configs.map(({ assigneeId }) => assigneeId));

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
        const assigneeId = assignment.assigneeFor(taskData.assigneeId as string | undefined);
        if (assigneeId) taskData.assigneeId = assigneeId;
        else delete taskData.assigneeId;

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
  tombstoneRecurringConfig,
  countRecurringConfigHistory,
  listRecurringRuns,
  recordRecurringRun,
  listRecurringConfigs,
  listEnabledRecurringConfigs,
  generateRecurringTasks,
  recurringTaskDefaults,
};
