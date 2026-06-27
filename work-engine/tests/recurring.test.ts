import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { startLocal, stopLocal, getClient } from '../src/db/client';
import { createTables } from '../src/db/setup';
import {
  createRecurringConfig,
  getRecurringConfig,
  updateRecurringConfig,
  deleteRecurringConfig,
  listRecurringConfigs,
  listEnabledRecurringConfigs,
  generateRecurringTasks,
  cronMatchesDate,
  matchCronField,
} from '../src/db/recurring';
import { getTask } from '../src/db/tasks';

describe('Recurring configs data layer', () => {
  let client: DynamoDBDocumentClient;
  let port: number;

  before(async () => {
    port = await startLocal();
    client = await getClient(port);
    await createTables(client);
  });

  after(async () => {
    await stopLocal();
  });

  // ── Cron matching unit tests ─────────────────────────────────────

  describe('matchCronField', () => {
    it('matches wildcard * for any value', () => {
      assert.strictEqual(matchCronField('*', 0), true);
      assert.strictEqual(matchCronField('*', 15), true);
      assert.strictEqual(matchCronField('*', 31), true);
    });

    it('matches a specific number', () => {
      assert.strictEqual(matchCronField('3', 3), true);
      assert.strictEqual(matchCronField('3', 4), false);
      assert.strictEqual(matchCronField('15', 15), true);
    });

    it('matches comma-separated values', () => {
      assert.strictEqual(matchCronField('1,3,5', 1), true);
      assert.strictEqual(matchCronField('1,3,5', 3), true);
      assert.strictEqual(matchCronField('1,3,5', 5), true);
      assert.strictEqual(matchCronField('1,3,5', 2), false);
    });

    it('matches step values (*/N)', () => {
      assert.strictEqual(matchCronField('*/2', 0), true);
      assert.strictEqual(matchCronField('*/2', 2), true);
      assert.strictEqual(matchCronField('*/2', 4), true);
      assert.strictEqual(matchCronField('*/2', 1), false);
      assert.strictEqual(matchCronField('*/2', 3), false);
    });
  });

  describe('cronMatchesDate', () => {
    it('matches daily cron: * * * * * (every day)', () => {
      const d = new Date('2028-01-15T00:00:00Z');
      assert.strictEqual(cronMatchesDate('0 9 * * *', d), true);
    });

    it('matches weekly cron: 0 9 * * 3 (Wednesdays)', () => {
      // 2028-02-02 is a Wednesday
      const wed = new Date('2028-02-02T00:00:00Z');
      assert.strictEqual(cronMatchesDate('0 9 * * 3', wed), true);

      // 2028-02-01 is a Tuesday
      const tue = new Date('2028-02-01T00:00:00Z');
      assert.strictEqual(cronMatchesDate('0 9 * * 3', tue), false);
    });

    it('matches monthly cron: 0 9 15 * * (15th of every month)', () => {
      const d15 = new Date('2028-06-15T00:00:00Z');
      assert.strictEqual(cronMatchesDate('0 9 15 * *', d15), true);

      const d14 = new Date('2028-06-14T00:00:00Z');
      assert.strictEqual(cronMatchesDate('0 9 15 * *', d14), false);
    });

    it('matches specific month and day: 0 9 25 12 * (Dec 25th)', () => {
      const xmas = new Date('2028-12-25T00:00:00Z');
      assert.strictEqual(cronMatchesDate('0 9 25 12 *', xmas), true);

      const notXmas = new Date('2028-11-25T00:00:00Z');
      assert.strictEqual(cronMatchesDate('0 9 25 12 *', notXmas), false);
    });

    it('rejects expressions with wrong number of fields', () => {
      const d = new Date('2028-01-15T00:00:00Z');
      assert.strictEqual(cronMatchesDate('0 9 * *', d), false);
      assert.strictEqual(cronMatchesDate('0 9 * * * *', d), false);
    });
  });

  // ── CRUD tests ──────────────────────────────────────────────────

  it('createRecurringConfig returns a config with id, createdAt, updatedAt, enabled', async () => {
    const config = await createRecurringConfig(client, {
      description: 'Daily standup',
      cronExpression: '0 9 * * *',
    });

    assert.ok(config.id);
    assert.ok(config.createdAt);
    assert.ok(config.updatedAt);
    assert.strictEqual(config.description, 'Daily standup');
    assert.strictEqual(config.cronExpression, '0 9 * * *');
    assert.strictEqual(config.enabled, true);
    assert.strictEqual((config as Record<string, unknown>).PK, undefined);
    assert.strictEqual((config as Record<string, unknown>).SK, undefined);
  });

  it('createRecurringConfig with assigneeId', async () => {
    const config = await createRecurringConfig(client, {
      description: 'Weekly mailchimp dump',
      cronExpression: '0 10 * * 3',
      assigneeId: 'user-grace',
    });

    assert.strictEqual(config.cronExpression, '0 10 * * 3');
    assert.strictEqual(config.assigneeId, 'user-grace');
  });

  it('getRecurringConfig returns the config by id', async () => {
    const created = await createRecurringConfig(client, {
      description: 'Fetch test',
      cronExpression: '0 9 * * *',
    });
    const fetched = await getRecurringConfig(client, created.id);

    assert.ok(fetched);
    assert.strictEqual(fetched.id, created.id);
    assert.strictEqual(fetched.description, 'Fetch test');
    assert.strictEqual(fetched.cronExpression, '0 9 * * *');
  });

  it('getRecurringConfig returns null for non-existent id', async () => {
    const result = await getRecurringConfig(client, 'nonexistent');
    assert.strictEqual(result, null);
  });

  it('updateRecurringConfig performs partial update and refreshes updatedAt', async () => {
    const created = await createRecurringConfig(client, {
      description: 'Original',
      cronExpression: '0 9 * * *',
    });

    await new Promise((r) => setTimeout(r, 10));

    const updated = await updateRecurringConfig(client, created.id, {
      description: 'Updated',
      enabled: false,
    });

    assert.strictEqual(updated!.description, 'Updated');
    assert.strictEqual(updated!.enabled, false);
    assert.strictEqual(updated!.cronExpression, '0 9 * * *');
    assert.ok(updated!.updatedAt > created.updatedAt);
  });

  it('updateRecurringConfig updates cronExpression', async () => {
    const created = await createRecurringConfig(client, {
      description: 'Cron update test',
      cronExpression: '0 9 * * 3',
    });

    const updated = await updateRecurringConfig(client, created.id, {
      cronExpression: '0 9 * * 1',
    });

    assert.strictEqual(updated!.cronExpression, '0 9 * * 1');
  });

  it('updateRecurringConfig updates assigneeId', async () => {
    const created = await createRecurringConfig(client, {
      description: 'Assignee update test',
      cronExpression: '0 9 * * *',
    });

    const updated = await updateRecurringConfig(client, created.id, {
      assigneeId: 'user-valeriia',
    });

    assert.strictEqual(updated!.assigneeId, 'user-valeriia');
  });

  it('deleteRecurringConfig removes the config', async () => {
    const created = await createRecurringConfig(client, {
      description: 'Delete me',
      cronExpression: '0 9 * * *',
    });
    await deleteRecurringConfig(client, created.id);
    const result = await getRecurringConfig(client, created.id);
    assert.strictEqual(result, null);
  });

  it('listRecurringConfigs returns all configs', async () => {
    const c1 = await createRecurringConfig(client, {
      description: 'List 1',
      cronExpression: '0 9 * * *',
    });
    const c2 = await createRecurringConfig(client, {
      description: 'List 2',
      cronExpression: '0 9 * * 1',
    });

    const configs = await listRecurringConfigs(client);
    const ids = configs.map((c) => c.id);

    assert.ok(ids.includes(c1.id));
    assert.ok(ids.includes(c2.id));
    assert.ok(configs.length >= 2);
  });

  it('listEnabledRecurringConfigs returns only enabled configs', async () => {
    const enabled = await createRecurringConfig(client, {
      description: 'Enabled config',
      cronExpression: '0 9 * * *',
    });
    const disabled = await createRecurringConfig(client, {
      description: 'Disabled config',
      cronExpression: '0 9 * * *',
      enabled: false,
    });

    const configs = await listEnabledRecurringConfigs(client);
    const ids = configs.map((c) => c.id);

    assert.ok(ids.includes(enabled.id));
    assert.ok(!ids.includes(disabled.id));
  });

  // ── Generation tests ────────────────────────────────────────────

  async function disableAllConfigs(): Promise<void> {
    const allConfigs = await listRecurringConfigs(client);
    for (const c of allConfigs) {
      if (c.enabled) {
        await updateRecurringConfig(client, c.id, { enabled: false });
      }
    }
  }

  it('generateRecurringTasks creates daily tasks for each day in range (cron: 0 9 * * *)', async () => {
    await disableAllConfigs();

    const config = await createRecurringConfig(client, {
      description: 'Gen daily standup',
      cronExpression: '0 9 * * *',
    });

    const result = await generateRecurringTasks(client, '2027-01-02', '2027-01-04');

    assert.strictEqual(result.generated.length, 3);
    assert.strictEqual(result.skipped, 0);

    const dates = result.generated.map((t) => t.date).sort();
    assert.deepStrictEqual(dates, ['2027-01-02', '2027-01-03', '2027-01-04']);

    for (const task of result.generated) {
      assert.strictEqual(task.source, 'recurring');
      assert.strictEqual(task.status, 'todo');
      assert.strictEqual(task.description, 'Gen daily standup');
      assert.strictEqual(task.recurringConfigId, config.id);
    }

    for (const task of result.generated) {
      const fetched = await getTask(client, task.id);
      assert.ok(fetched, `Task ${task.id} should be persisted`);
    }

    await updateRecurringConfig(client, config.id, { enabled: false });
  });

  it('generateRecurringTasks creates weekly tasks only on matching day-of-week (cron: 0 9 * * 3)', async () => {
    await disableAllConfigs();

    const config = await createRecurringConfig(client, {
      description: 'Gen weekly mailchimp',
      cronExpression: '0 9 * * 3',
    });

    // 2027-02-01 is a Monday. Wednesdays are 2027-02-03 and 2027-02-10
    const result = await generateRecurringTasks(client, '2027-02-01', '2027-02-14');

    assert.strictEqual(result.generated.length, 2);
    const dates = result.generated.map((t) => t.date).sort();
    assert.deepStrictEqual(dates, ['2027-02-03', '2027-02-10']);

    await updateRecurringConfig(client, config.id, { enabled: false });
  });

  it('generateRecurringTasks creates monthly tasks only on matching day-of-month (cron: 0 9 15 * *)', async () => {
    await disableAllConfigs();

    const config = await createRecurringConfig(client, {
      description: 'Gen monthly report',
      cronExpression: '0 9 15 * *',
    });

    const result = await generateRecurringTasks(client, '2027-06-01', '2027-08-31');

    assert.strictEqual(result.generated.length, 3);
    const dates = result.generated.map((t) => t.date).sort();
    assert.deepStrictEqual(dates, ['2027-06-15', '2027-07-15', '2027-08-15']);

    await updateRecurringConfig(client, config.id, { enabled: false });
  });

  it('generateRecurringTasks is idempotent -- no duplicates on second call', async () => {
    await disableAllConfigs();

    const config = await createRecurringConfig(client, {
      description: 'Gen idempotent daily',
      cronExpression: '0 9 * * *',
    });

    const result1 = await generateRecurringTasks(client, '2027-03-02', '2027-03-04');
    assert.strictEqual(result1.generated.length, 3);
    assert.strictEqual(result1.skipped, 0);

    const result2 = await generateRecurringTasks(client, '2027-03-02', '2027-03-04');
    assert.strictEqual(result2.generated.length, 0);
    assert.strictEqual(result2.skipped, 3);

    await updateRecurringConfig(client, config.id, { enabled: false });
  });

  it('generateRecurringTasks skips disabled configs', async () => {
    await disableAllConfigs();

    await createRecurringConfig(client, {
      description: 'Gen disabled daily',
      cronExpression: '0 9 * * *',
      enabled: false,
    });

    const result = await generateRecurringTasks(client, '2027-04-02', '2027-04-04');
    assert.strictEqual(result.generated.length, 0);
    assert.strictEqual(result.skipped, 0);
  });

  it('generateRecurringTasks sets assigneeId from config', async () => {
    await disableAllConfigs();

    const config = await createRecurringConfig(client, {
      description: 'Gen assignee task',
      cronExpression: '0 9 * * *',
      assigneeId: 'user-grace',
    });

    const result = await generateRecurringTasks(client, '2027-05-02', '2027-05-02');
    assert.strictEqual(result.generated.length, 1);
    assert.strictEqual((result.generated[0] as Record<string, unknown>).assigneeId, 'user-grace');

    await updateRecurringConfig(client, config.id, { enabled: false });
  });

  it('generateRecurringTasks does not set assigneeId when not in config', async () => {
    await disableAllConfigs();

    const config = await createRecurringConfig(client, {
      description: 'Gen no assignee task',
      cronExpression: '0 9 * * *',
    });

    const result = await generateRecurringTasks(client, '2027-05-10', '2027-05-10');
    assert.strictEqual(result.generated.length, 1);
    assert.strictEqual((result.generated[0] as Record<string, unknown>).assigneeId, undefined);

    await updateRecurringConfig(client, config.id, { enabled: false });
  });
});
