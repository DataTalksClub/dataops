import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { getClient } from '../src/db/client';
import { startLocal, stopLocal } from '../scripts/local-dynamodb';
import { createTables } from '../scripts/local-dynamodb';
import {
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
} from '../src/db/recurring';
import { nextMatchingDate } from '../src/cron/cronMatch';
import { berlinDate } from '../src/sponsorFinance/core';
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

  function shiftIsoDate(isoDate: string, days: number): string {
    const next = new Date(`${isoDate}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + days);
    return next.toISOString().split('T')[0];
  }

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

  it('persists the next matching civil date as the next run', async () => {
    const created = await createRecurringConfig(client, {
      description: 'Daily run',
      cronExpression: '0 9 * * *',
    });

    assert.strictEqual(created.nextRunDate, berlinDate());
    const fetched = await getRecurringConfig(client, created.id);
    assert.strictEqual(fetched!.nextRunDate, berlinDate());

    // Changing the schedule recomputes the run. A weekday that has to be walked
    // to is still a date the daily pass will honour.
    await new Promise((r) => setTimeout(r, 10));
    const weekday = await updateRecurringConfig(client, created.id, {
      cronExpression: '0 9 * * 4',
    });
    assert.strictEqual(weekday!.nextRunDate, nextMatchingDate('0 9 * * 4'));
    assert.strictEqual(new Date(`${weekday!.nextRunDate}T00:00:00Z`).getUTCDay(), 4);
  });

  it('leaves the next run date alone when the schedule did not change', async () => {
    const created = await createRecurringConfig(client, {
      description: 'Stable next run',
      cronExpression: '0 9 * * *',
    });

    const renamed = await updateRecurringConfig(client, created.id, {
      description: 'Renamed',
    });

    assert.strictEqual(renamed!.nextRunDate, created.nextRunDate);
  });

  it('records the last outcome of a firing on the config', async () => {
    await disableAllConfigs();

    const created = await createRecurringConfig(client, {
      description: 'Outcome tracking',
      cronExpression: '0 9 * * *',
    });

    const today = berlinDate();
    const first = await generateRecurringTasks(client, today, today);
    assert.strictEqual(first.generated.length, 1);
    const afterFirst = await getRecurringConfig(client, created.id);
    assert.strictEqual(afterFirst!.lastRunOutcome, 'succeeded');
    assert.ok(afterFirst!.lastRunAt);
    assert.strictEqual(
      afterFirst!.nextRunDate,
      nextMatchingDate('0 9 * * *', new Date(`${shiftIsoDate(today, 1)}T12:00:00Z`)),
    );

    // Idempotent replay still counts as a run, and the ledger row is replaced.
    const second = await generateRecurringTasks(client, today, today);
    assert.strictEqual(second.generated.length, 0);
    assert.strictEqual(second.skipped, 1);
    const afterSecond = await getRecurringConfig(client, created.id);
    assert.strictEqual(afterSecond!.lastRunOutcome, 'succeeded');

    assert.strictEqual(await countRecurringConfigRuns(client, created.id), 1);
  });

  it('a backfill over past dates leaves the next run at today or later', async () => {
    await disableAllConfigs();

    const created = await createRecurringConfig(client, {
      description: 'Backfill next run',
      cronExpression: '0 9 * * *',
    });

    const today = berlinDate();
    const result = await generateRecurringTasks(client, shiftIsoDate(today, -3), shiftIsoDate(today, -1));
    assert.strictEqual(result.generated.length, 3);

    const after = await getRecurringConfig(client, created.id);
    assert.strictEqual(after!.lastRunOutcome, 'succeeded');
    assert.ok(after!.nextRunDate >= today);
    assert.strictEqual(
      after!.nextRunDate,
      nextMatchingDate('0 9 * * *', new Date(`${today}T12:00:00Z`)),
    );
  });

  it('pre-generating a future range leaves the next run at the first match from today', async () => {
    await disableAllConfigs();

    const created = await createRecurringConfig(client, {
      description: 'Future pre-generate next run',
      cronExpression: '0 9 * * *',
    });

    const today = berlinDate();
    const result = await generateRecurringTasks(client, shiftIsoDate(today, 7), shiftIsoDate(today, 9));
    assert.strictEqual(result.generated.length, 3);

    // The days between today and the range still belong to the daily pass.
    const after = await getRecurringConfig(client, created.id);
    assert.strictEqual(
      after!.nextRunDate,
      nextMatchingDate('0 9 * * *', new Date(`${today}T12:00:00Z`)),
    );
  });

  it('countRecurringConfigRuns counts ledger rows only for the config asked about', async () => {
    const created = await createRecurringConfig(client, {
      description: 'Ledger owner',
      cronExpression: '0 9 * * *',
    });
    const other = await createRecurringConfig(client, {
      description: 'Ledger bystander',
      cronExpression: '0 9 * * *',
    });

    await recordRecurringRun(client, {
      configId: created.id,
      date: '2027-01-10',
      outcome: 'succeeded',
      generatedTaskIds: [],
    });
    await recordRecurringRun(client, {
      configId: created.id,
      date: '2027-01-11',
      outcome: 'failed',
      generatedTaskIds: [],
    });
    await recordRecurringRun(client, {
      configId: other.id,
      date: '2027-01-10',
      outcome: 'succeeded',
      generatedTaskIds: [],
    });

    assert.strictEqual(await countRecurringConfigRuns(client, created.id), 2);
    assert.strictEqual(await countRecurringConfigRuns(client, other.id), 1);
    assert.strictEqual(await countRecurringConfigRuns(client, 'not-a-config'), 0);
  });

  it('countRecurringConfigRuns does not read generated tasks as history', async () => {
    const created = await createRecurringConfig(client, {
      description: 'Conflicting config id',
      cronExpression: '0 9 * * *',
    });

    // The ledger prefix must not be reachable by prefixing a config id that
    // extends past the '#<date>' separator.
    await recordRecurringRun(client, {
      configId: `${created.id}0`,
      date: '2027-01-10',
      outcome: 'succeeded',
      generatedTaskIds: [],
    });

    assert.strictEqual(await countRecurringConfigRuns(client, created.id), 0);
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

  it('generateRecurringTasks honours day-of-week ranges the matcher now supports (cron: 0 9 * * 1-5)', async () => {
    await disableAllConfigs();

    const config = await createRecurringConfig(client, {
      description: 'Gen weekday report',
      cronExpression: '0 9 * * 1-5',
    });

    // 2027-06-01 is a Tuesday and 2027-06-05 a Saturday, so the week has five
    // weekdays, not six.
    const result = await generateRecurringTasks(client, '2027-06-01', '2027-06-07');

    assert.strictEqual(result.generated.length, 5);
    const dates = result.generated.map((t) => t.date).sort();
    assert.deepStrictEqual(dates, [
      '2027-06-01',
      '2027-06-02',
      '2027-06-03',
      '2027-06-04',
      '2027-06-07',
    ]);

    await updateRecurringConfig(client, config.id, { enabled: false });
  });

  it('records a failed firing and still generates for every other config', async () => {
    await disableAllConfigs();

    const failing = await createRecurringConfig(client, {
      description: 'Throws on creation',
      cronExpression: '0 9 * * *',
    });
    const healthy = await createRecurringConfig(client, {
      description: 'Creates fine',
      cronExpression: '0 9 * * *',
    });

    // Only the generated task write for the failing config is rejected; every
    // other command still reaches the table.
    const failTaskWrites = {
      send: (command: { input?: Record<string, unknown> }) => {
        const item = command.input?.Item as { description?: string } | undefined;
        if (item?.description === 'Throws on creation') {
          return Promise.reject(new Error('dynamodb capacity exceeded'));
        }
        return client.send(command as never);
      },
    } as unknown as DynamoDBDocumentClient;

    const today = berlinDate();
    const result = await generateRecurringTasks(failTaskWrites, today, today);

    assert.strictEqual(result.generated.length, 1);
    assert.strictEqual(result.generated[0].description, 'Creates fine');
    assert.strictEqual(result.failures, 1);

    const failedRuns = await listRecurringRuns(client, failing.id);
    assert.strictEqual(failedRuns.length, 1);
    assert.strictEqual(failedRuns[0].date, today);
    assert.strictEqual(failedRuns[0].outcome, 'failed');
    assert.deepStrictEqual(failedRuns[0].generatedTaskIds, []);

    const failedConfig = await getRecurringConfig(client, failing.id);
    assert.strictEqual(failedConfig!.lastRunOutcome, 'failed');
    assert.strictEqual(failedConfig!.nextRunDate, failing.nextRunDate);

    const healthyRuns = await listRecurringRuns(client, healthy.id);
    assert.strictEqual(healthyRuns.length, 1);
    assert.strictEqual(healthyRuns[0].outcome, 'succeeded');
    assert.strictEqual(healthyRuns[0].generatedTaskIds.length, 1);
    const healthyConfig = await getRecurringConfig(client, healthy.id);
    assert.strictEqual(
      healthyConfig!.nextRunDate,
      nextMatchingDate('0 9 * * *', new Date(`${shiftIsoDate(today, 1)}T12:00:00Z`)),
    );

    await updateRecurringConfig(client, failing.id, { enabled: false });
    await updateRecurringConfig(client, healthy.id, { enabled: false });
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
