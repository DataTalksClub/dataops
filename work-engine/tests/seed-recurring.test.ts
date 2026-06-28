import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { startLocal, stopLocal, getClient } from '../src/db/client';
import { createTables } from '../src/db/setup';
import { listUndismissedNotifications } from '../src/db/notifications';
import {
  listRecurringConfigs,
  updateRecurringConfig,
} from '../src/db/recurring';
import { listTasksByDate } from '../src/db/tasks';
import { runCron } from '../src/cron/runner';
import { seed as seedUsers } from '../scripts/seed-users';
import {
  BASELINE_RECURRING_CONFIGS,
  OPERATOR_USER_ID,
  seed as seedRecurring,
} from '../scripts/seed-recurring';

describe('Seed recurring script', () => {
  let client: DynamoDBDocumentClient;

  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
    await seedUsers();
  });

  after(async () => {
    await stopLocal();
  });

  it('seeds baseline recurring configs idempotently and cron generates daily work without duplicates', async () => {
    const first = await seedRecurring();

    assert.deepStrictEqual(first, {
      created: BASELINE_RECURRING_CONFIGS.length,
      updated: 0,
      skipped: 0,
      total: BASELINE_RECURRING_CONFIGS.length,
    });

    const configsAfterFirstRun = await listRecurringConfigs(client);
    assert.strictEqual(configsAfterFirstRun.length, BASELINE_RECURRING_CONFIGS.length);

    for (const expected of BASELINE_RECURRING_CONFIGS) {
      const matches = configsAfterFirstRun.filter(
        (config) =>
          config.description === expected.description &&
          config.cronExpression === expected.cronExpression
      );
      assert.strictEqual(matches.length, 1, `${expected.description} should be seeded once`);
      assert.strictEqual(matches[0].enabled, true);
      assert.strictEqual(matches[0].assigneeId, OPERATOR_USER_ID);
    }

    const second = await seedRecurring();
    assert.deepStrictEqual(second, {
      created: 0,
      updated: 0,
      skipped: BASELINE_RECURRING_CONFIGS.length,
      total: BASELINE_RECURRING_CONFIGS.length,
    });

    const drifted = (await listRecurringConfigs(client)).find(
      (config) => config.description === 'Invite people to Slack from Airtable'
    );
    assert.ok(drifted);
    await updateRecurringConfig(client, drifted.id, {
      enabled: false,
      assigneeId: '00000000-0000-0000-0000-000000000099',
    });

    const repaired = await seedRecurring();
    assert.deepStrictEqual(repaired, {
      created: 0,
      updated: 1,
      skipped: BASELINE_RECURRING_CONFIGS.length - 1,
      total: BASELINE_RECURRING_CONFIGS.length,
    });

    const configsAfterRepair = await listRecurringConfigs(client);
    assert.strictEqual(configsAfterRepair.length, BASELINE_RECURRING_CONFIGS.length);
    const repairedConfig = configsAfterRepair.find(
      (config) => config.description === 'Invite people to Slack from Airtable'
    );
    assert.ok(repairedConfig);
    assert.strictEqual(repairedConfig.enabled, true);
    assert.strictEqual(repairedConfig.assigneeId, OPERATOR_USER_ID);

    const friday = new Date('2029-01-05T09:00:00Z');
    const firstCron = await runCron(client, friday);
    assert.strictEqual(firstCron.failures, 0);
    assert.strictEqual(firstCron.recurring.generated.length, 2);
    assert.strictEqual(firstCron.recurring.skipped, 0);

    const tasks = (await listTasksByDate(client, '2029-01-05')).filter(
      (task) => task.source === 'recurring'
    );
    assert.strictEqual(tasks.length, 2);
    assert.deepStrictEqual(
      tasks.map((task) => task.description).sort(),
      [
        'Create new Trello cards and review existing ones',
        'Invite people to Slack from Airtable',
      ]
    );
    for (const task of tasks) {
      assert.strictEqual(task.status, 'todo');
      assert.strictEqual(task.date, '2029-01-05');
      assert.ok(task.recurringConfigId);
      assert.strictEqual(task.assigneeId, OPERATOR_USER_ID);
    }

    const notificationsAfterFirstCron = (await listUndismissedNotifications(client)).filter(
      (notification) => notification.type === 'recurring-due'
    );
    assert.strictEqual(notificationsAfterFirstCron.length, 2);
    assert.deepStrictEqual(
      notificationsAfterFirstCron.map((notification) => notification.taskId).sort(),
      tasks.map((task) => task.id).sort()
    );

    const secondCron = await runCron(client, friday);
    assert.strictEqual(secondCron.recurring.generated.length, 0);
    assert.strictEqual(secondCron.recurring.skipped, 2);

    const tasksAfterSecondCron = (await listTasksByDate(client, '2029-01-05')).filter(
      (task) => task.source === 'recurring'
    );
    assert.strictEqual(tasksAfterSecondCron.length, 2);

    const notificationsAfterSecondCron = (await listUndismissedNotifications(client)).filter(
      (notification) => notification.type === 'recurring-due'
    );
    assert.strictEqual(notificationsAfterSecondCron.length, 2);
  });
});
