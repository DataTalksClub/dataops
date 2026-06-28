import { getClient, startLocal } from '../src/db/client';
import { createTables } from '../src/db/setup';
import {
  createRecurringConfig,
  listRecurringConfigs,
  updateRecurringConfig,
} from '../src/db/recurring';
import { getUser } from '../src/db/users';
import type { RecurringConfig } from '../src/types';

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

const BASELINE_RECURRING_CONFIGS = [
  {
    description: 'Invite people to Slack from Airtable',
    cronExpression: '0 9 * * *',
  },
  {
    description: 'Create new Trello cards and review existing ones',
    cronExpression: '0 9 * * *',
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
    total: BASELINE_RECURRING_CONFIGS.length,
  };

  for (const baseline of BASELINE_RECURRING_CONFIGS) {
    const key = recurringKey(baseline);
    const matches = existingByKey.get(key) || [];
    const existing = matches[0];
    const desired = {
      description: baseline.description,
      cronExpression: baseline.cronExpression,
      enabled: true,
      assigneeId: OPERATOR_USER_ID,
    };

    if (!existing) {
      await createRecurringConfig(client, desired);
      report.created++;
      console.log(`Created recurring config: ${baseline.description} (${baseline.cronExpression})`);
      continue;
    }

    if (existing.enabled !== true || existing.assigneeId !== OPERATOR_USER_ID) {
      await updateRecurringConfig(client, existing.id, {
        enabled: true,
        assigneeId: OPERATOR_USER_ID,
      });
      report.updated++;
      console.log(`Updated recurring config: ${baseline.description} (${baseline.cronExpression})`);
      continue;
    }

    report.skipped++;
    console.log(`Skipped existing recurring config: ${baseline.description} (${baseline.cronExpression})`);
  }

  console.log(
    `Recurring seed complete. total=${report.total} created=${report.created} updated=${report.updated} skipped=${report.skipped}`
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
