import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { listTemplates, instantiateTemplate } from '../db/templates';
import { createBundle, listBundles } from '../db/bundles';
import { createNotification } from '../db/notifications';
import { generateRecurringTasks, cronMatchesDate } from '../db/recurring';
import type { Template, Bundle } from '../types';

export interface CronRunnerResult {
  created: string[];
  skipped: number;
  templates: {
    created: string[];
    skipped: number;
    recovered: number;
  };
  recurring: {
    generated: string[];
    skipped: number;
  };
  failures: number;
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
  const todayDate = today.toISOString().split('T')[0];

  // 1. List all templates and filter to automatic triggers
  const allTemplates = await listTemplates(client);
  const autoTemplates = allTemplates.filter(
    (t: Template) => t.triggerType === 'automatic' && t.triggerSchedule && t.triggerEnabled !== false
  );

  // 2. Get all existing bundles for duplicate detection
  const allBundles = await listBundles(client);

  const created: string[] = [];
  let skipped = 0;
  let recovered = 0;
  let failures = 0;
  const recurringGenerated: string[] = [];
  let recurringSkipped = 0;

  try {
    const recurringResult = await generateRecurringTasks(client, todayDate, todayDate);
    recurringSkipped = recurringResult.skipped;
    for (const task of recurringResult.generated) {
      recurringGenerated.push(task.id);
      const notificationData: Record<string, unknown> = {
        type: 'recurring-due',
        message: `Recurring task generated: ${task.description} for ${task.date}`,
        taskId: task.id,
        recurringConfigId: task.recurringConfigId,
        dueAt: task.date,
        metadata: {
          generatedDate: task.date,
          recurringConfigId: task.recurringConfigId,
        },
      };
      if (task.assigneeId) {
        notificationData.userId = task.assigneeId;
      }
      await createNotification(client, notificationData);
    }
  } catch (err: unknown) {
    failures++;
    await createNotification(client, {
      type: 'automation-failure',
      message: `Recurring task generation failed for ${todayDate}: ${(err as Error).message}`,
      dueAt: todayDate,
    });
  }

  for (const template of autoTemplates) {
    try {
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
        const recoveredTasks = await instantiateTemplate(client, template.id, duplicate.id, anchorDate);
        recovered += recoveredTasks.length;
        if (recoveredTasks.length > 0) {
          await createNotification(client, {
            type: 'automation-failure',
            message: `${template.name} workflow run was missing ${recoveredTasks.length} task(s); cron recovered them for ${formatAnchorDate(anchorDate)}`,
            bundleId: duplicate.id,
            templateId: template.id,
            dueAt: anchorDate,
            metadata: {
              recoveredTaskIds: recoveredTasks.map((task) => task.id),
              anchorDate,
            },
          });
        }
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
        type: 'stage-change',
        message: `${template.name} bundle auto-created for ${formatAnchorDate(anchorDate)}`,
        bundleId: bundle.id,
        templateId: template.id,
        dueAt: anchorDate,
      };
      if (template.defaultAssigneeId) {
        notificationData.userId = template.defaultAssigneeId;
      }
      await createNotification(client, notificationData);

      created.push(bundle.id);
    } catch (err: unknown) {
      failures++;
      await createNotification(client, {
        type: 'automation-failure',
        message: `Automatic template generation failed for ${template.name} (${template.id}) on ${todayDate}: ${(err as Error).message}`,
        templateId: template.id,
        dueAt: todayDate,
        metadata: {
          templateId: template.id,
          date: todayDate,
        },
      });
    }
  }

  return {
    created,
    skipped: skipped + recurringSkipped,
    templates: { created, skipped, recovered },
    recurring: { generated: recurringGenerated, skipped: recurringSkipped },
    failures,
  };
}

export { runCron, formatAnchorDate };
