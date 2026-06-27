import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { listTemplates, instantiateTemplate } from '../db/templates';
import { createBundle, listBundles } from '../db/bundles';
import { createNotification } from '../db/notifications';
import { cronMatchesDate } from '../db/recurring';
import type { Template, Bundle } from '../types';

export interface CronRunnerResult {
  created: string[];
  skipped: number;
}

/**
 * Format an anchor date as a human-readable string (e.g., "Mar 15").
 */
function formatAnchorDate(dateStr: string): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const parts = dateStr.split('-');
  const monthIdx = parseInt(parts[1], 10) - 1;
  const day = parseInt(parts[2], 10);
  return `${months[monthIdx]} ${day}`;
}

/**
 * Run the cron logic: scan templates with triggerType "automatic",
 * evaluate their schedule against the current date, and create bundles
 * for matches (with duplicate prevention).
 */
async function runCron(client: DynamoDBDocumentClient, now?: Date): Promise<CronRunnerResult> {
  const today = now || new Date();

  // 1. List all templates and filter to automatic triggers
  const allTemplates = await listTemplates(client);
  const autoTemplates = allTemplates.filter(
    (t: Template) => t.triggerType === 'automatic' && t.triggerSchedule
  );

  // 2. Get all existing bundles for duplicate detection
  const allBundles = await listBundles(client);

  const created: string[] = [];
  let skipped = 0;

  for (const template of autoTemplates) {
    // 3. Check if today matches the cron schedule
    if (!cronMatchesDate(template.triggerSchedule!, today)) {
      continue;
    }

    // 4. Calculate anchor date: today + triggerLeadDays
    const leadDays = template.triggerLeadDays || 0;
    const anchorDateObj = new Date(today);
    anchorDateObj.setUTCDate(anchorDateObj.getUTCDate() + leadDays);
    const anchorDate = anchorDateObj.toISOString().split('T')[0];

    // 5. Duplicate check: same templateId + anchorDate
    const duplicate = allBundles.find(
      (b: Bundle) => b.templateId === template.id && b.anchorDate === anchorDate
    );

    if (duplicate) {
      skipped++;
      continue;
    }

    // 6. Create the bundle
    const bundleData: Record<string, unknown> = {
      title: `${template.name} - ${formatAnchorDate(anchorDate)}`,
      anchorDate,
      templateId: template.id,
      stage: 'preparation',
      status: 'active',
    };

    // Copy template fields to bundle
    if (template.emoji) {
      bundleData.emoji = template.emoji;
    }
    if (template.tags && template.tags.length > 0) {
      bundleData.tags = template.tags;
    }
    if (template.references && template.references.length > 0) {
      bundleData.references = template.references;
    }
    if (template.bundleLinkDefinitions && template.bundleLinkDefinitions.length > 0) {
      bundleData.bundleLinks = template.bundleLinkDefinitions.map((def) => ({
        name: def.name,
        url: '',
      }));
    }

    const bundle = await createBundle(client, bundleData);

    // 7. Instantiate template tasks
    await instantiateTemplate(client, template.id, bundle.id, anchorDate);

    // 8. Create notification (targeted to template's defaultAssigneeId if set)
    const notificationData: Record<string, unknown> = {
      message: `${template.name} bundle auto-created for ${formatAnchorDate(anchorDate)}`,
      bundleId: bundle.id,
      templateId: template.id,
    };
    if (template.defaultAssigneeId) {
      notificationData.userId = template.defaultAssigneeId;
    }
    await createNotification(client, notificationData);

    created.push(bundle.id);
  }

  return { created, skipped };
}

export { runCron, formatAnchorDate };
