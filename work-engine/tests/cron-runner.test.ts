import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { startLocal, stopLocal, getClient } from '../src/db/client';
import { createTables } from '../src/db/setup';
import { createTemplate, listTemplates } from '../src/db/templates';
import { listBundles } from '../src/db/bundles';
import { listUndismissedNotifications } from '../src/db/notifications';
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

    // Verify the bundle was created
    const bundles = await listBundles(client);
    const createdBundle = bundles.find((b) => b.id === result.created[0]);
    assert.ok(createdBundle, 'Bundle should exist');
    assert.strictEqual(createdBundle.templateId, template.id);

    // Anchor date should be March 2 + 14 days = March 16
    assert.strictEqual(createdBundle.anchorDate, '2026-03-16');
    assert.ok(createdBundle.title!.includes('Weekly Newsletter'));
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
