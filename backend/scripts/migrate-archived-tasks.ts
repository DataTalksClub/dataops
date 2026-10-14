/**
 * One-off migration: the Task status `archived` became `skipped`.
 *
 * `skipped` always carries `skipReason`, `skippedAt`, and `skippedBy`. Each
 * stored `archived` Task becomes `skipped` with:
 * - the Template removal reason when a reviewed Template update retired it,
 * - otherwise a reason stating it was archived before skip existed,
 * plus a `skipped` history event by `system:migration`.
 * Both statuses are resolved, so Card task aggregates do not change.
 *
 * Usage against local dynalite (dev server stopped first):
 *   tsx scripts/migrate-archived-tasks.ts [--apply]
 *
 * Against production (AWS credentials, explicit table name):
 *   DATAOPS_TASKS_TABLE=dataops-v1-tasks tsx scripts/migrate-archived-tasks.ts --apply
 *
 * Default is a dry run. Each write is conditional on the row still being
 * `archived` at the read version. Delete this script and its test once applied.
 */
import { randomUUID } from 'node:crypto';

import { UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getClient } from '../src/db/client';
import { TEMPLATE_REMOVED_SKIP_REASON } from '../src/db/cardTemplateUpdates';
import { TABLE_TASKS } from '../src/db/tableNames';
import { listAllTasks } from '../src/db/tasks';
import type { Task, TaskHistoryEvent } from '../src/types';

const MIGRATION_ACTOR = 'system:migration';
const LEGACY_ARCHIVED_REASON = 'Archived before Skip existed';

export interface ArchivedTaskMigration {
  id: string;
  version: number;
  skipReason: string;
  skippedAt: string;
  skippedBy: string;
  historyEvent: TaskHistoryEvent;
}

export function planArchivedTaskMigrations(tasks: Task[], now: string): ArchivedTaskMigration[] {
  return tasks
    .filter((task) => (task.status as string) === 'archived')
    .map((task) => {
      const retired = task.templateRetiredReason === 'removed' && Boolean(task.templateRetiredAt);
      const skipReason = retired ? TEMPLATE_REMOVED_SKIP_REASON : LEGACY_ARCHIVED_REASON;
      const skippedAt = retired ? task.templateRetiredAt! : task.updatedAt;
      const historyEvent: TaskHistoryEvent = {
        id: randomUUID(),
        taskId: task.id,
        ...(task.cardId ? { cardId: task.cardId } : {}),
        action: 'skipped',
        actorId: MIGRATION_ACTOR,
        note: skipReason,
        createdAt: now,
      };
      return {
        id: task.id,
        version: task.version,
        skipReason,
        skippedAt,
        skippedBy: MIGRATION_ACTOR,
        historyEvent,
      };
    });
}

async function applyMigration(
  client: DynamoDBDocumentClient,
  migration: ArchivedTaskMigration,
  now: string,
): Promise<void> {
  await client.send(new UpdateCommand({
    TableName: TABLE_TASKS,
    Key: { PK: `TASK#${migration.id}`, SK: `TASK#${migration.id}` },
    UpdateExpression: [
      'SET #status = :skipped, skipReason = :reason, skippedAt = :skippedAt, skippedBy = :skippedBy,',
      '#version = :nextVersion, updatedAt = :now,',
      'taskHistory = list_append(taskHistory, :history)',
    ].join(' '),
    ConditionExpression: '#status = :archived AND #version = :version',
    ExpressionAttributeNames: { '#status': 'status', '#version': 'version' },
    ExpressionAttributeValues: {
      ':skipped': 'skipped',
      ':archived': 'archived',
      ':reason': migration.skipReason,
      ':skippedAt': migration.skippedAt,
      ':skippedBy': migration.skippedBy,
      ':version': migration.version,
      ':nextVersion': migration.version + 1,
      ':now': now,
      ':history': [migration.historyEvent],
    },
  }));
}

async function main(): Promise<void> {
  const apply = process.argv.slice(2).includes('--apply');
  const client = await getClient();
  const now = new Date().toISOString();
  const planned = planArchivedTaskMigrations(await listAllTasks(client), now);
  for (const migration of planned) {
    console.log(JSON.stringify({ id: migration.id, skipReason: migration.skipReason, skippedAt: migration.skippedAt }));
  }
  if (!apply) {
    console.log(JSON.stringify({ planned: planned.length, mode: 'dry-run' }));
    return;
  }
  let applied = 0;
  for (const migration of planned) {
    await applyMigration(client, migration, now);
    applied += 1;
  }
  console.log(JSON.stringify({ planned: planned.length, applied, mode: 'applied' }));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({ error: (error as Error).message }));
    process.exitCode = 1;
  });
}
