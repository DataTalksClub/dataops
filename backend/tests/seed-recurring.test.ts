import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getClient } from '../src/db/client';
import { startLocal, stopLocal, createTables } from '../scripts/local-dynamodb';
import { listRecurringConfigs, updateRecurringConfig } from '../src/db/recurring';
import { SAMPLE_RECURRING_CONFIGS, seed as seedRecurring } from '../scripts/seed-recurring';

describe('Local sample recurring schedules', () => {
  let client: DynamoDBDocumentClient;

  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
  });

  after(async () => {
    await stopLocal();
  });

  it('keeps the weekly newsletter and monthly bookkeeping reminder samples', async () => {
    const descriptions = SAMPLE_RECURRING_CONFIGS.map((sample) => sample.description);
    for (const sample of [
      'Ensure newsletter for next week is prepared',
      'Check bookkeeping, invoices, and receipts',
    ]) {
      assert.equal(descriptions.includes(sample), true, `${sample} is a retained sample schedule`);
    }
  });

  it('creates each sample once and never touches a schedule that already exists', async () => {    assert.deepStrictEqual(await seedRecurring(), { created: SAMPLE_RECURRING_CONFIGS.length });
    const seeded = await listRecurringConfigs(client);
    assert.strictEqual(seeded.length, SAMPLE_RECURRING_CONFIGS.length);
    assert.ok(seeded.every((config) => config.assigneeId === undefined), 'no person is seeded onto a schedule');

    const slack = seeded.find((config) => config.description === 'Invite people to Slack from Airtable');
    assert.ok(slack);
    await updateRecurringConfig(client, slack.id, { enabled: false, cronExpression: '0 10 * * *' });

    assert.deepStrictEqual(await seedRecurring(), { created: 0 });
    const after = await listRecurringConfigs(client);
    assert.strictEqual(after.length, SAMPLE_RECURRING_CONFIGS.length);
    const paused = after.find((config) => config.id === slack.id);
    assert.strictEqual(paused?.enabled, false, 'a paused schedule stays paused');
    assert.strictEqual(paused?.cronExpression, '0 10 * * *', 'an edited cadence is kept');
  });
});
