import { ScanCommand } from '@aws-sdk/lib-dynamodb';

import { getClient, startLocal } from '../src/db/client';
import { createTables, TABLE_TASKS } from '../src/db/setup';
import {
  createRecurringConfig,
  listRecurringConfigs,
  recurringTaskDefaults,
  updateRecurringConfig,
} from '../src/db/recurring';
import { updateTask } from '../src/db/tasks';
import { getUser } from '../src/db/users';
import type { RecurringConfig, Task } from '../src/types';

function shouldUseLocalDynamo(): boolean {
  return (
    process.env.IS_LOCAL === 'true' ||
    process.env.IS_LOCAL === '1' ||
    process.env.NODE_ENV === 'test' ||
    process.env.NODE_ENV === 'local' ||
    Boolean(process.env.DYNAMODB_ENDPOINT)
  );
}

const OPERATOR_USER_ID = '00000000-0000-0000-0000-000000000001';
const SLACK_INVITE_DOC_ID = 'sop.community.book-of-the-week.invite-people-to-slack-from-the-airtable-form';
const TRELLO_EVENT_DOC_ID = 'sop.internal-admin.trello.how-to-create-an-event-through-trello';

type BaselineRecurringConfig = Pick<
  RecurringConfig,
  | 'description'
  | 'cronExpression'
  | 'instructionsUrl'
  | 'instructionDocId'
  | 'instructionStepId'
  | 'systems'
  | 'requiredLinkName'
  | 'requiresFile'
  | 'tags'
>;

const BASELINE_RECURRING_CONFIGS: readonly BaselineRecurringConfig[] = [
  {
    description: 'Invite people to Slack from Airtable',
    cronExpression: '0 9 * * *',
    instructionDocId: SLACK_INVITE_DOC_ID,
    systems: ['airtable', 'slack'],
    tags: ['community', 'book-of-the-week', 'airtable', 'slack'],
  },
  {
    description: 'Create new Trello cards and review existing ones',
    cronExpression: '0 9 * * *',
    instructionDocId: TRELLO_EVENT_DOC_ID,
    systems: ['trello'],
    tags: ['internal-admin', 'trello', 'podcast'],
  },
  {
    description: 'Ensure newsletter for next week is prepared',
    cronExpression: '0 9 * * 2',
  },
  {
    description: 'Prepare newsletter for the week after next',
    cronExpression: '0 9 * * 3',
  },
  {
    description: 'Backup MailChimp mailing list to Google Drive',
    cronExpression: '0 9 * * 4',
  },
  {
    description: 'Create Slack dump',
    cronExpression: '0 9 1 * *',
  },
  {
    description: 'Check bookkeeping, invoices, and receipts',
    cronExpression: '0 9 * * 1',
  },
] as const;

interface SeedRecurringReport {
  created: number;
  updated: number;
  skipped: number;
  repairedTasks: number;
  total: number;
}

function recurringKey(config: Pick<RecurringConfig, 'description' | 'cronExpression'>): string {
  return `${config.description}\u001f${config.cronExpression}`;
}

async function assertOperatorUserExists(client: Awaited<ReturnType<typeof getClient>>): Promise<void> {
  const user = await getUser(client, OPERATOR_USER_ID);
  if (!user) {
    throw new Error(
      `Recurring seed requires seeded operator user ${OPERATOR_USER_ID}; run scripts/seed-users.ts first.`
    );
  }
}

function stable(value: unknown): string {
  return JSON.stringify(value);
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return stable(left) === stable(right);
}

function desiredRecurringConfig(baseline: BaselineRecurringConfig): Record<string, unknown> {
  return {
    ...baseline,
    enabled: true,
    assigneeId: OPERATOR_USER_ID,
  };
}

function configUpdate(existing: RecurringConfig, desired: Record<string, unknown>): Record<string, unknown> {
  const updates: Record<string, unknown> = {};
  for (const [field, desiredValue] of Object.entries(desired)) {
    if (!valuesEqual(existing[field as keyof RecurringConfig], desiredValue)) {
      updates[field] = desiredValue;
    }
  }
  return updates;
}

function missingTaskFieldValue(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}

async function listGeneratedRecurringTasks(client: Awaited<ReturnType<typeof getClient>>): Promise<Task[]> {
  const tasks: Task[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;

  do {
    const result = await client.send(
      new ScanCommand({
        TableName: TABLE_TASKS,
        FilterExpression: 'begins_with(PK, :taskPrefix) AND #src = :source',
        ExpressionAttributeNames: {
          '#src': 'source',
        },
        ExpressionAttributeValues: {
          ':taskPrefix': 'TASK#',
          ':source': 'recurring',
        },
        ExclusiveStartKey: lastEvaluatedKey,
      })
    );

    for (const item of result.Items || []) {
      const { PK, SK, ...task } = item as Record<string, unknown>;
      tasks.push(task as unknown as Task);
    }

    lastEvaluatedKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey);

  return tasks;
}

async function repairExistingGeneratedTasks(
  client: Awaited<ReturnType<typeof getClient>>,
  seededConfigs: RecurringConfig[]
): Promise<number> {
  const defaultsByConfigId = new Map<string, Record<string, unknown>>();
  for (const config of seededConfigs) {
    defaultsByConfigId.set(config.id, recurringTaskDefaults(config));
  }

  let repaired = 0;
  for (const task of await listGeneratedRecurringTasks(client)) {
    if (!task.recurringConfigId) continue;
    const defaults = defaultsByConfigId.get(task.recurringConfigId);
    if (!defaults) continue;

    const updates: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(defaults)) {
      if (value === undefined) continue;
      if (missingTaskFieldValue(task[field as keyof Task])) {
        updates[field] = value;
      }
    }

    if (Object.keys(updates).length === 0) continue;
    await updateTask(client, task.id, updates);
    repaired++;
    console.log(`Repaired generated recurring task: ${task.description} (${task.id})`);
  }

  return repaired;
}

async function seed(): Promise<SeedRecurringReport> {
  const useLocalDynamo = shouldUseLocalDynamo();
  const port = useLocalDynamo && !process.env.DYNAMODB_ENDPOINT
    ? await startLocal()
    : undefined;
  const client = await getClient(port);

  if (useLocalDynamo) {
    await createTables(client);
  }

  await assertOperatorUserExists(client);

  const existingConfigs = await listRecurringConfigs(client);
  const existingByKey = new Map<string, RecurringConfig[]>();
  for (const config of existingConfigs) {
    const key = recurringKey(config);
    const existing = existingByKey.get(key) || [];
    existing.push(config);
    existingByKey.set(key, existing);
  }

  const report: SeedRecurringReport = {
    created: 0,
    updated: 0,
    skipped: 0,
    repairedTasks: 0,
    total: BASELINE_RECURRING_CONFIGS.length,
  };
  const seededConfigs: RecurringConfig[] = [];

  for (const baseline of BASELINE_RECURRING_CONFIGS) {
    const key = recurringKey(baseline);
    const matches = existingByKey.get(key) || [];
    const existing = matches[0];
    const desired = desiredRecurringConfig(baseline);

    if (!existing) {
      const created = await createRecurringConfig(client, desired);
      seededConfigs.push(created);
      report.created++;
      console.log(`Created recurring config: ${baseline.description} (${baseline.cronExpression})`);
      continue;
    }

    const updates = configUpdate(existing, desired);
    if (Object.keys(updates).length > 0) {
      const updated = await updateRecurringConfig(client, existing.id, updates);
      seededConfigs.push(updated || { ...existing, ...updates });
      report.updated++;
      console.log(`Updated recurring config: ${baseline.description} (${baseline.cronExpression})`);
      continue;
    }

    seededConfigs.push(existing);
    report.skipped++;
    console.log(`Skipped existing recurring config: ${baseline.description} (${baseline.cronExpression})`);
  }

  report.repairedTasks = await repairExistingGeneratedTasks(client, seededConfigs);

  console.log(
    `Recurring seed complete. total=${report.total} created=${report.created} updated=${report.updated} skipped=${report.skipped} repairedTasks=${report.repairedTasks}`
  );

  return report;
}

if (require.main === module) {
  seed()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error('Recurring seed failed:', err);
      process.exit(1);
    });
}

export { seed, BASELINE_RECURRING_CONFIGS, OPERATOR_USER_ID };
