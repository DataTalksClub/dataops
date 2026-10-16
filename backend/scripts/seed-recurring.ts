/**
 * Local development sample schedules. Never run by a deploy: in a real
 * workspace recurring schedules are user data managed on /recurring.
 *
 * Creates a sample only when no schedule with that description exists, and
 * never edits, re-enables or recreates one that is there.
 */
import { getClient } from '../src/db/client';
import { createRecurringConfig, listRecurringConfigs } from '../src/db/recurring';

const SAMPLE_RECURRING_CONFIGS = [
  {
    description: 'Invite people to Slack from Airtable',
    cronExpression: '0 9 * * *',
    instructionDocId: 'sop.community.book-of-the-week.invite-people-to-slack-from-the-airtable-form',
    requires: ['airtable', 'slack'],
    tags: ['community', 'book-of-the-week', 'airtable', 'slack'],
  },
  { description: 'Ensure newsletter for next week is prepared', cronExpression: '0 9 * * 2' },
  {
    description: 'Create Slack dump',
    cronExpression: '0 9 1 * *',
    instructionDocId: 'sop.community.slack.export-create-a-dump-of-slack-data',
    requires: ['slack'],
  },
  { description: 'Check bookkeeping, invoices, and receipts', cronExpression: '0 9 1 * *' },
] as const;

async function seed(): Promise<{ created: number }> {
  const client = await getClient();
  const existing = new Set((await listRecurringConfigs(client)).map((config) => config.description));
  let created = 0;
  for (const sample of SAMPLE_RECURRING_CONFIGS) {
    if (existing.has(sample.description)) continue;
    await createRecurringConfig(client, { ...sample, enabled: true });
    created++;
  }
  console.log(`Sample recurring schedules: created=${created}`);
  return { created };
}

if (require.main === module) {
  seed()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error('Recurring sample seed failed:', err);
      process.exit(1);
    });
}

export { seed, SAMPLE_RECURRING_CONFIGS };
