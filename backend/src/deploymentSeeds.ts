import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import {
  createRecurringConfig,
  listRecurringConfigs,
  recurringTaskDefaults,
  updateRecurringConfig,
} from './db/recurring';
import { TABLE_TASKS } from './db/tableNames';
import { updateTask } from './db/tasks';
import {
  type AuthoredTemplateDefinition,
  loadAuthoredTemplatesFromKnowledge,
  reconcileAuthoredTemplates,
} from './templates/authoredTemplates';
import type { RecurringConfig, Task } from './types';

const SLACK_INVITE_DOC_ID = 'sop.community.book-of-the-week.invite-people-to-slack-from-the-airtable-form';
const TRELLO_EVENT_DOC_ID = 'sop.internal-admin.trello.how-to-create-an-event-through-trello';

type BaselineRecurringConfig = Pick<
  RecurringConfig,
  | 'description'
  | 'cronExpression'
  | 'instructionsUrl'
  | 'instructionDocId'
  | 'instructionStepId'
  | 'requires'
  | 'requiredLinkName'
  | 'requiresFile'
  | 'tags'
>;

export const BASELINE_RECURRING_CONFIGS: readonly BaselineRecurringConfig[] = [
  {
    description: 'Invite people to Slack from Airtable',
    cronExpression: '0 9 * * *',
    instructionDocId: SLACK_INVITE_DOC_ID,
    requires: ['airtable', 'slack'],
    tags: ['community', 'book-of-the-week', 'airtable', 'slack'],
  },
  {
    description: 'Create new Trello cards and review existing ones',
    cronExpression: '0 9 * * *',
    instructionDocId: TRELLO_EVENT_DOC_ID,
    requires: ['trello'],
    tags: ['internal-admin', 'trello', 'podcast'],
  },
  { description: 'Ensure newsletter for next week is prepared', cronExpression: '0 9 * * 2' },
  { description: 'Prepare newsletter for the week after next', cronExpression: '0 9 * * 3' },
  { description: 'Create Slack dump', cronExpression: '0 9 1 * *' },
  { description: 'Check bookkeeping, invoices, and receipts', cronExpression: '0 9 * * 1' },
] as const;

export interface RecurringSeedReport {
  created: number;
  updated: number;
  skipped: number;
  repairedTasks: number;
  total: number;
}

export interface DeploymentSeedReport {
  templates: {
    total: number;
    created: number;
    updated: number;
    unchanged: number;
  };
  recurring: RecurringSeedReport;
}

type AuthoredTemplateLoader = () => Promise<AuthoredTemplateDefinition[]>;
const canonicalDeploymentTemplateLoader: AuthoredTemplateLoader = loadAuthoredTemplatesFromKnowledge;
let deploymentTemplateLoader: AuthoredTemplateLoader = canonicalDeploymentTemplateLoader;

export function setDeploymentTemplateLoaderForTest(loader: AuthoredTemplateLoader | null): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Deployment template loader injection is test-only');
  }
  deploymentTemplateLoader = loader || canonicalDeploymentTemplateLoader;
}

export function assertCanonicalDeploymentTemplateLoader(): void {
  if (deploymentTemplateLoader !== canonicalDeploymentTemplateLoader) {
    throw new Error('Deployment template loader injection must not be active outside tests');
  }
}

function recurringKey(config: Pick<RecurringConfig, 'description' | 'cronExpression'>): string {
  return `${config.description}\u001f${config.cronExpression}`;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function desiredRecurringConfig(baseline: BaselineRecurringConfig): Record<string, unknown> {
  // No person is seeded onto a schedule: its Tasks go to the workspace default
  // assignee unless an admin names someone for that schedule.
  return { ...baseline, enabled: true };
}

function configUpdate(existing: RecurringConfig, desired: Record<string, unknown>): Record<string, unknown> {
  const updates: Record<string, unknown> = {};
  for (const [field, desiredValue] of Object.entries(desired)) {
    if (!valuesEqual(existing[field as keyof RecurringConfig], desiredValue)) updates[field] = desiredValue;
  }
  return updates;
}

function missingTaskFieldValue(value: unknown): boolean {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

async function listGeneratedRecurringTasks(client: DynamoDBDocumentClient): Promise<Task[]> {
  const tasks: Task[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;
  do {
    const result = await client.send(
      new ScanCommand({
        TableName: TABLE_TASKS,
        FilterExpression: 'begins_with(PK, :taskPrefix) AND #src = :source',
        ExpressionAttributeNames: { '#src': 'source' },
        ExpressionAttributeValues: { ':taskPrefix': 'TASK#', ':source': 'recurring' },
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
  client: DynamoDBDocumentClient,
  seededConfigs: RecurringConfig[]
): Promise<number> {
  const defaultsByConfigId = new Map<string, Record<string, unknown>>();
  for (const config of seededConfigs) defaultsByConfigId.set(config.id, recurringTaskDefaults(config));

  let repaired = 0;
  for (const task of await listGeneratedRecurringTasks(client)) {
    if (!task.recurringConfigId) continue;
    const defaults = defaultsByConfigId.get(task.recurringConfigId);
    if (!defaults) continue;
    const updates: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(defaults)) {
      if (value !== undefined && missingTaskFieldValue(task[field as keyof Task])) updates[field] = value;
    }
    if (Object.keys(updates).length === 0) continue;
    await updateTask(client, task.id, { expectedVersion: task.version, patch: updates });
    repaired++;
  }
  return repaired;
}

export async function seedRecurringConfigs(client: DynamoDBDocumentClient): Promise<RecurringSeedReport> {
  const existingByKey = new Map<string, RecurringConfig[]>();
  for (const config of await listRecurringConfigs(client)) {
    const key = recurringKey(config);
    existingByKey.set(key, [...(existingByKey.get(key) || []), config]);
  }

  const report: RecurringSeedReport = {
    created: 0,
    updated: 0,
    skipped: 0,
    repairedTasks: 0,
    total: BASELINE_RECURRING_CONFIGS.length,
  };
  const seededConfigs: RecurringConfig[] = [];
  for (const baseline of BASELINE_RECURRING_CONFIGS) {
    const existing = (existingByKey.get(recurringKey(baseline)) || [])[0];
    const desired = desiredRecurringConfig(baseline);
    if (!existing) {
      seededConfigs.push(await createRecurringConfig(client, desired));
      report.created++;
      continue;
    }
    const updates = configUpdate(existing, desired);
    if (Object.keys(updates).length > 0) {
      const updated = await updateRecurringConfig(client, existing.id, updates);
      seededConfigs.push(updated || { ...existing, ...updates });
      report.updated++;
      continue;
    }
    seededConfigs.push(existing);
    report.skipped++;
  }

  report.repairedTasks = await repairExistingGeneratedTasks(client, seededConfigs);
  console.log(
    `Recurring seed complete. total=${report.total} created=${report.created} updated=${report.updated} skipped=${report.skipped} repairedTasks=${report.repairedTasks}`
  );
  return report;
}

export async function seedDeploymentRuntime(
  client: DynamoDBDocumentClient,
  loadTemplates: AuthoredTemplateLoader = deploymentTemplateLoader
): Promise<DeploymentSeedReport> {
  const templates = await reconcileAuthoredTemplates(client, await loadTemplates());
  const recurring = await seedRecurringConfigs(client);
  return { templates, recurring };
}
