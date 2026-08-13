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
import { createUserWithId, getUser, getUserByEmail } from './db/users';
import {
  type AuthoredTemplateDefinition,
  loadAuthoredTemplatesFromGithub,
  reconcileAuthoredTemplates,
} from './templates/authoredTemplates';
import type { RecurringConfig, Task } from './types';

export const OPERATOR_USER_ID = '00000000-0000-0000-0000-000000000001';
const SLACK_INVITE_DOC_ID = 'sop.community.book-of-the-week.invite-people-to-slack-from-the-airtable-form';
const TRELLO_EVENT_DOC_ID = 'sop.internal-admin.trello.how-to-create-an-event-through-trello';
const DEFAULT_PASSWORD = '111';

export const USERS = [
  { id: OPERATOR_USER_ID, name: 'Grace', email: 'grace@datatalks.club', role: 'admin' as const },
  { id: '00000000-0000-0000-0000-000000000002', name: 'Valeriia', email: 'valeriia@datatalks.club', role: 'admin' as const },
  { id: '00000000-0000-0000-0000-000000000003', name: 'Alexey', email: 'alexey@datatalks.club', role: 'admin' as const },
] as const;

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

export const BASELINE_RECURRING_CONFIGS: readonly BaselineRecurringConfig[] = [
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
  { description: 'Ensure newsletter for next week is prepared', cronExpression: '0 9 * * 2' },
  { description: 'Prepare newsletter for the week after next', cronExpression: '0 9 * * 3' },
  { description: 'Backup MailChimp mailing list to Google Drive', cronExpression: '0 9 * * 4' },
  { description: 'Create Slack dump', cronExpression: '0 9 1 * *' },
  { description: 'Check bookkeeping, invoices, and receipts', cronExpression: '0 9 * * 1' },
] as const;

export interface UserSeedReport {
  processed: number;
  created: number;
  updated: number;
  unchanged: number;
}

export interface RecurringSeedReport {
  created: number;
  updated: number;
  skipped: number;
  repairedTasks: number;
  total: number;
}

export interface DeploymentSeedReport {
  users: UserSeedReport;
  templates: {
    total: number;
    created: number;
    updated: number;
    unchanged: number;
  };
  recurring: RecurringSeedReport;
}

type AuthoredTemplateLoader = () => Promise<AuthoredTemplateDefinition[]>;
const canonicalDeploymentTemplateLoader: AuthoredTemplateLoader = loadAuthoredTemplatesFromGithub;
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

async function hashPassword(password: string): Promise<string> {
  const data = new TextEncoder().encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function seedRuntimeUsers(client: DynamoDBDocumentClient): Promise<UserSeedReport> {
  const passwordHash = await hashPassword(DEFAULT_PASSWORD);
  const report: UserSeedReport = { processed: USERS.length, created: 0, updated: 0, unchanged: 0 };

  for (const userData of USERS) {
    const { id, ...data } = userData;
    const existing = await getUserByEmail(client, data.email);
    if (!existing) {
      await createUserWithId(client, id, { ...data, passwordHash });
      report.created++;
    } else if (!existing.passwordHash) {
      await createUserWithId(client, id, { ...data, passwordHash });
      report.updated++;
    } else {
      report.unchanged++;
    }
  }

  console.log(
    `User seed complete. processed=${report.processed} created=${report.created} updated=${report.updated} unchanged=${report.unchanged}`
  );
  return report;
}

function recurringKey(config: Pick<RecurringConfig, 'description' | 'cronExpression'>): string {
  return `${config.description}\u001f${config.cronExpression}`;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function desiredRecurringConfig(baseline: BaselineRecurringConfig): Record<string, unknown> {
  return { ...baseline, enabled: true, assigneeId: OPERATOR_USER_ID };
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
  if (!(await getUser(client, OPERATOR_USER_ID))) {
    throw new Error(`Recurring seed requires seeded operator user ${OPERATOR_USER_ID}`);
  }

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
  const users = await seedRuntimeUsers(client);
  const templates = await reconcileAuthoredTemplates(client, await loadTemplates());
  const recurring = await seedRecurringConfigs(client);
  return { users, templates, recurring };
}
