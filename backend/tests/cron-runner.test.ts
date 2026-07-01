import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { startLocal, stopLocal, getClient } from '../src/db/client';
import { createTables } from '../src/db/setup';
import { createTemplate, listTemplates, updateTemplate } from '../src/db/templates';
import { listBundles } from '../src/db/bundles';
import { listUndismissedNotifications } from '../src/db/notifications';
import { createRecurringConfig, updateRecurringConfig } from '../src/db/recurring';
import { deleteTask, listTasksByBundle, listTasksByDate } from '../src/db/tasks';
import { runCron, formatAnchorDate } from '../src/cron/runner';

describe('Cron runner', () => {
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

  describe('formatAnchorDate', () => {
    it('formats 2026-03-15 as "Mar 15"', () => {
      assert.strictEqual(formatAnchorDate('2026-03-15'), 'Mar 15');
    });

    it('formats 2026-01-01 as "Jan 1"', () => {
      assert.strictEqual(formatAnchorDate('2026-01-01'), 'Jan 1');
    });

    it('formats 2026-12-25 as "Dec 25"', () => {
      assert.strictEqual(formatAnchorDate('2026-12-25'), 'Dec 25');
    });
  });

  it('creates a bundle for a weekly template when cron matches', async () => {
    // Create a template with automatic trigger, every Monday (day 1)
    const template = await createTemplate(client, {
      name: 'Weekly Newsletter',
      type: 'newsletter',
      triggerType: 'automatic',
      triggerSchedule: '0 9 * * 1', // Every Monday 9am
      triggerLeadDays: 14,
      taskDefinitions: [
        { refId: 'draft', description: 'Write draft', offsetDays: -7 },
        { refId: 'publish', description: 'Publish', offsetDays: 0 },
      ],
    });

    // Run cron on a Monday (2026-03-02 is a Monday)
    const monday = new Date('2026-03-02T09:00:00Z');
    const result = await runCron(client, monday);

    assert.strictEqual(result.created.length, 1);
    assert.strictEqual(result.skipped, 0);
    assert.strictEqual(result.templates.created.length, 1);
    assert.strictEqual(result.templates.skipped, 0);
    assert.strictEqual(result.recurring.generated.length, 0);

    // Verify the bundle was created
    const bundles = await listBundles(client);
    const createdBundle = bundles.find((b) => b.id === result.created[0]);
    assert.ok(createdBundle, 'Bundle should exist');
    assert.strictEqual(createdBundle.templateId, template.id);

    // Anchor date should be March 2 + 14 days = March 16
    assert.strictEqual(createdBundle.anchorDate, '2026-03-16');
    assert.ok(createdBundle.title!.includes('Weekly Newsletter'));
  });

  it('runs standalone recurring tasks and automatic template workflows in one cron pass', async () => {
    const recurring = await createRecurringConfig(client, {
      description: 'Handle Slack invite intake',
      cronExpression: '0 9 * * 2',
      assigneeId: 'user-grace',
    });
    const template = await createTemplate(client, {
      name: 'Issue 40 Newsletter',
      type: 'newsletter',
      triggerType: 'automatic',
      triggerSchedule: '0 9 * * 2',
      triggerLeadDays: 7,
      taskDefinitions: [
        {
          refId: 'draft',
          description: 'Draft newsletter',
          offsetDays: -2,
          proofRequirement: { type: 'comment', label: 'Draft reviewed' },
          instructionDocId: 'sop.newsletter.draft',
        },
      ],
    });

    const tuesday = new Date('2029-01-02T09:00:00Z');
    const result = await runCron(client, tuesday);

    assert.strictEqual(result.recurring.generated.length, 1);
    assert.strictEqual(result.recurring.skipped, 0);
    assert.strictEqual(result.templates.created.length, 1);
    assert.strictEqual(result.templates.skipped, 0);
    assert.strictEqual(result.failures, 0);

    const tasksForDate = await listTasksByDate(client, '2029-01-02');
    const recurringTask = tasksForDate.find((task) => task.recurringConfigId === recurring.id);
    assert.ok(recurringTask);
    assert.strictEqual(recurringTask.source, 'recurring');
    assert.strictEqual(recurringTask.assigneeId, 'user-grace');

    const bundles = await listBundles(client);
    const bundle = bundles.find((item) => item.templateId === template.id && item.anchorDate === '2029-01-09');
    assert.ok(bundle);
    const bundleTasks = await listTasksByBundle(client, bundle.id);
    assert.strictEqual(bundleTasks.length, 1);
    assert.strictEqual(bundleTasks[0].source, 'template');
    assert.strictEqual(bundleTasks[0].templateTaskRef, 'draft');
    assert.deepStrictEqual(bundleTasks[0].proofRequirement, { type: 'comment', label: 'Draft reviewed' });
    assert.strictEqual(bundleTasks[0].instructionDocId, 'sop.newsletter.draft');

    await updateRecurringConfig(client, recurring.id, { enabled: false });
  });

  it('reports recurring and template skips without creating duplicates on rerun', async () => {
    const recurring = await createRecurringConfig(client, {
      description: 'Daily intake review idempotent',
      cronExpression: '0 9 * * 4',
    });
    const template = await createTemplate(client, {
      name: 'Idempotent automatic workflow',
      type: 'workflow',
      triggerType: 'automatic',
      triggerSchedule: '0 9 * * 4',
      triggerLeadDays: 0,
      taskDefinitions: [
        { refId: 'one', description: 'One task', offsetDays: 0 },
      ],
    });

    const thursday = new Date('2029-01-04T09:00:00Z');
    await runCron(client, thursday);
    const second = await runCron(client, thursday);

    assert.strictEqual(second.recurring.generated.length, 0);
    assert.strictEqual(second.recurring.skipped, 1);
    assert.strictEqual(second.templates.created.length, 0);
    assert.strictEqual(second.templates.skipped, 1);
    assert.ok(second.skipped >= 2);

    const recurringTasks = (await listTasksByDate(client, '2029-01-04')).filter((task) => task.recurringConfigId === recurring.id);
    assert.strictEqual(recurringTasks.length, 1);
    const bundles = (await listBundles(client)).filter((bundle) => bundle.templateId === template.id && bundle.anchorDate === '2029-01-04');
    assert.strictEqual(bundles.length, 1);
    assert.strictEqual((await listTasksByBundle(client, bundles[0].id)).length, 1);

    await updateRecurringConfig(client, recurring.id, { enabled: false });
  });

  it('does not generate paused recurring configs or paused automatic template triggers', async () => {
    const recurring = await createRecurringConfig(client, {
      description: 'Paused weekly backup',
      cronExpression: '0 9 * * 6',
      enabled: false,
    });
    const template = await createTemplate(client, {
      name: 'Paused automatic workflow',
      type: 'workflow',
      triggerType: 'automatic',
      triggerSchedule: '0 9 * * 6',
      triggerLeadDays: 0,
      triggerEnabled: false,
      taskDefinitions: [
        { refId: 'paused-task', description: 'Should not generate', offsetDays: 0 },
      ],
    });

    const saturday = new Date('2029-01-06T09:00:00Z');
    const paused = await runCron(client, saturday);
    assert.strictEqual(paused.recurring.generated.length, 0);
    assert.strictEqual(paused.templates.created.length, 0);

    await updateRecurringConfig(client, recurring.id, { enabled: true });
    await updateTemplate(client, template.id, { triggerEnabled: true });
    const resumed = await runCron(client, saturday);
    assert.strictEqual(resumed.recurring.generated.length, 1);
    assert.strictEqual(resumed.templates.created.length, 1);

    const second = await runCron(client, saturday);
    assert.strictEqual(second.recurring.skipped, 1);
    assert.strictEqual(second.templates.skipped, 1);

    await updateRecurringConfig(client, recurring.id, { enabled: false });
  });

  it('recovers missing template tasks for an existing automatic bundle instead of duplicating the bundle', async () => {
    const template = await createTemplate(client, {
      name: 'Recover partial workflow',
      type: 'workflow',
      triggerType: 'automatic',
      triggerSchedule: '0 9 * * 3',
      triggerLeadDays: 0,
      taskDefinitions: [
        { refId: 'first', description: 'First generated task', offsetDays: 0 },
        { refId: 'second', description: 'Second generated task', offsetDays: 1 },
      ],
    });

    const wednesday = new Date('2029-01-10T09:00:00Z');
    await runCron(client, wednesday);
    const bundle = (await listBundles(client)).find((item) => item.templateId === template.id && item.anchorDate === '2029-01-10');
    assert.ok(bundle);
    const originalTasks = await listTasksByBundle(client, bundle.id);
    assert.strictEqual(originalTasks.length, 2);
    await deleteTask(client, originalTasks[0].id);

    const recovered = await runCron(client, wednesday);
    assert.strictEqual(recovered.templates.created.length, 0);
    assert.strictEqual(recovered.templates.skipped, 1);
    assert.strictEqual(recovered.templates.recovered, 1);

    const bundles = (await listBundles(client)).filter((item) => item.templateId === template.id && item.anchorDate === '2029-01-10');
    assert.strictEqual(bundles.length, 1);
    const recoveredTasks = await listTasksByBundle(client, bundle.id);
    assert.strictEqual(recoveredTasks.length, 2);

    const notifications = await listUndismissedNotifications(client);
    assert.ok(notifications.some((notification) => notification.type === 'automation-failure' && notification.bundleId === bundle.id));
  });

  it('is idempotent -- no duplicates on second call', async () => {
    // Get current bundle count
    const bundlesBefore = await listBundles(client);
    const countBefore = bundlesBefore.length;

    // Run cron again on the same Monday
    const monday = new Date('2026-03-02T09:00:00Z');
    const result = await runCron(client, monday);

    assert.strictEqual(result.created.length, 0);
    assert.ok(result.skipped >= 1, 'Should have skipped at least 1');

    // Bundle count should not increase
    const bundlesAfter = await listBundles(client);
    assert.strictEqual(bundlesAfter.length, countBefore);
  });

  it('creates a notification when bundle is auto-created', async () => {
    // Create a new template to get a fresh bundle
    const template = await createTemplate(client, {
      name: 'Social Media Weekly',
      type: 'social',
      triggerType: 'automatic',
      triggerSchedule: '0 9 * * 5', // Every Friday
      triggerLeadDays: 7,
      taskDefinitions: [
        { refId: 'post', description: 'Create posts', offsetDays: -2 },
      ],
    });

    // Run cron on a Friday (2026-03-06 is a Friday)
    const friday = new Date('2026-03-06T09:00:00Z');
    const result = await runCron(client, friday);

    assert.strictEqual(result.created.length, 1);

    // Check notification was created
    const notifications = await listUndismissedNotifications(client);
    const notification = notifications.find(
      (n) => n.bundleId === result.created[0]
    );

    assert.ok(notification, 'Notification should exist');
    assert.ok(notification.message.includes('Social Media Weekly'));
    assert.ok(notification.message.includes('Mar 13')); // March 6 + 7 = March 13
    assert.strictEqual(notification.templateId, template.id);
    assert.strictEqual(notification.dismissed, false);
  });

  it('skips templates without automatic trigger', async () => {
    // Create a manual template
    await createTemplate(client, {
      name: 'Manual Template',
      type: 'manual',
      triggerType: 'manual',
      taskDefinitions: [
        { refId: 'task1', description: 'Manual task', offsetDays: 0 },
      ],
    });

    // Get bundle count before
    const bundlesBefore = await listBundles(client);
    const countBefore = bundlesBefore.length;

    // Run cron on a date that would match any daily cron
    const date = new Date('2026-04-15T09:00:00Z');
    const result = await runCron(client, date);

    // Should not have created a bundle for the manual template
    // (may create for other auto templates if they match this date)
    const bundlesAfter = await listBundles(client);
    const newBundles = bundlesAfter.filter(
      (b) => !bundlesBefore.find((bb) => bb.id === b.id)
    );

    // None of the new bundles should be from the manual template
    const manualTemplates = (await listTemplates(client)).filter(
      (t) => t.name === 'Manual Template'
    );
    for (const bundle of newBundles) {
      for (const mt of manualTemplates) {
        assert.notStrictEqual(
          bundle.templateId,
          mt.id,
          'No bundle should be created from manual template'
        );
      }
    }
  });

  it('skips templates with empty triggerSchedule', async () => {
    await createTemplate(client, {
      name: 'No Schedule Template',
      type: 'test',
      triggerType: 'automatic',
      triggerSchedule: '',
      taskDefinitions: [
        { refId: 'task1', description: 'Task', offsetDays: 0 },
      ],
    });

    const bundlesBefore = await listBundles(client);

    const date = new Date('2026-04-15T09:00:00Z');
    await runCron(client, date);

    const bundlesAfter = await listBundles(client);
    const newBundles = bundlesAfter.filter(
      (b) => !bundlesBefore.find((bb) => bb.id === b.id)
    );

    const noScheduleTemplates = (await listTemplates(client)).filter(
      (t) => t.name === 'No Schedule Template'
    );
    for (const bundle of newBundles) {
      for (const nst of noScheduleTemplates) {
        assert.notStrictEqual(
          bundle.templateId,
          nst.id,
          'No bundle should be created from template with empty schedule'
        );
      }
    }
  });

  it('creates tasks from template when bundle is auto-created', async () => {
    const template = await createTemplate(client, {
      name: 'Tasks Template',
      type: 'test',
      triggerType: 'automatic',
      triggerSchedule: '0 9 1 * *', // 1st of every month
      triggerLeadDays: 0,
      taskDefinitions: [
        { refId: 'task-a', description: 'Task A', offsetDays: 0 },
        { refId: 'task-b', description: 'Task B', offsetDays: 3 },
      ],
    });

    // Run cron on the 1st (2026-05-01 is a Friday)
    const date = new Date('2026-05-01T09:00:00Z');
    const result = await runCron(client, date);

    assert.ok(result.created.length >= 1);

    // Find the bundle for this template
    const bundles = await listBundles(client);
    const bundle = bundles.find((b) => b.templateId === template.id);
    assert.ok(bundle, 'Bundle for template should exist');
  });

  it('handles triggerLeadDays of 0 correctly', async () => {
    const template = await createTemplate(client, {
      name: 'Zero Lead Template',
      type: 'test',
      triggerType: 'automatic',
      triggerSchedule: '0 9 15 6 *', // June 15
      triggerLeadDays: 0,
      taskDefinitions: [
        { refId: 'task1', description: 'Task', offsetDays: 0 },
      ],
    });

    const date = new Date('2026-06-15T09:00:00Z');
    const result = await runCron(client, date);

    const bundles = await listBundles(client);
    const bundle = bundles.find((b) => b.templateId === template.id);
    assert.ok(bundle);
    assert.strictEqual(bundle.anchorDate, '2026-06-15'); // Same day as cron fire
  });
});
