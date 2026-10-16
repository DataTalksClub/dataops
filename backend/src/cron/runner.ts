import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { createCardFromTemplate, listTemplates, instantiateTemplate } from '../db/templates';
import { listCards } from '../db/cards';
import { createNotification } from '../db/notifications';
import { generateRecurringTasks } from '../db/recurring';
import { emitRecurringCronMetrics } from './recurringMetrics';
import { addCivilDays, moveWeekendToMonday, parseCronExpression, scheduleDatesOccurringOn } from './cronMatch';
import type { Template, Card } from '../types';
import { evaluateSponsorBookingAlerts } from '../sponsorCrm/alerts';
import { evaluateSponsorFinanceAlerts } from '../sponsorFinance/alerts';
import { berlinDate } from '../sponsorFinance/core';
import { evaluateCommunicationSuggestions } from '../sponsorCommunications/suggestions';
import { templateCardProjection } from '../templates/cardTemplateProjection';
import { resolveDefaultAssigneeId } from '../db/workspaceSettings';
import { recordAutomationRun } from '../automations/runs';
import { createDueIssueCards, type DueCardRun } from '../newsletter/cardSchedule';

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
    failures: number;
  };
  /** Newsletter issue Cards that came due today. */
  newsletterCards: Pick<DueCardRun, 'created' | 'failures'>;
  failures: number;
}

export interface SponsorAutomationEvaluators {
  bookingAlerts: (client: DynamoDBDocumentClient, today: string) => Promise<unknown>;
  financeAlerts: (client: DynamoDBDocumentClient, today: string) => Promise<unknown>;
  communicationSuggestions: (client: DynamoDBDocumentClient, today: string) => Promise<unknown>;
}

const defaultSponsorAutomationEvaluators: SponsorAutomationEvaluators = {
  bookingAlerts: evaluateSponsorBookingAlerts,
  financeAlerts: evaluateSponsorFinanceAlerts,
  communicationSuggestions: evaluateCommunicationSuggestions,
};

/** `created 2, resolved 1` from an evaluator's counts. */
function countsSummary(result: unknown): string {
  if (!result || typeof result !== 'object') return 'Done';
  const counts = Object.entries(result as Record<string, unknown>)
    .filter(([, value]) => typeof value === 'number' || Array.isArray(value))
    .map(([name, value]) => `${name} ${Array.isArray(value) ? value.length : value}`);
  return counts.length ? counts.join(', ') : 'Done';
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

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
 * The one Card a Template has for an anchor date: created when missing, and
 * when it already exists any missing Template Tasks are recovered instead of
 * duplicating the Card, however many passes reach the same anchor.
 */
async function ensureAutomaticCard(
  client: DynamoDBDocumentClient,
  template: Template,
  anchorDate: string,
  allCards: Card[],
): Promise<{ created: Card | null; recovered: number }> {
  const duplicate = allCards.find(
    (b: Card) => b.templateId === template.id && b.anchorDate === anchorDate
  );

  if (duplicate) {
    const recoveredTasks = await instantiateTemplate(client, template.id, duplicate.id, anchorDate);
    if (recoveredTasks.length > 0) {
      await createNotification(client, {
        type: 'automation-failure',
        message: `${template.name} workflow run was missing ${recoveredTasks.length} task(s); cron recovered them for ${formatAnchorDate(anchorDate)}`,
        cardId: duplicate.id,
        templateId: template.id,
        dueAt: anchorDate,
        metadata: {
          recoveredTaskIds: recoveredTasks.map((task) => task.id),
          anchorDate,
        },
      });
    }
    return { created: null, recovered: recoveredTasks.length };
  }

  const cardData: Record<string, unknown> = {
    ...templateCardProjection(template),
    title: `${template.name} - ${formatAnchorDate(anchorDate)}`,
    anchorDate,
    templateId: template.id,
    stage: 'preparation',
    status: 'active',
  };

  // Copy template fields to card
  if (template.tags && template.tags.length > 0) {
    cardData.tags = template.tags;
  }
  if (template.references && template.references.length > 0) {
    cardData.references = template.references;
  }
  if (template.cardLinkDefinitions && template.cardLinkDefinitions.length > 0) {
    cardData.cardLinks = template.cardLinkDefinitions.map((def) => ({
      name: def.name,
      url: '',
    }));
  }

  const { card } = await createCardFromTemplate(client, cardData, template, anchorDate);

  // Notify the workspace default assignee when one is set.
  const notificationData: Record<string, unknown> = {
    type: 'stage-change',
    message: `${template.name} card auto-created for ${formatAnchorDate(anchorDate)}`,
    cardId: card.id,
    templateId: template.id,
    dueAt: anchorDate,
  };
  const defaultAssigneeId = await resolveDefaultAssigneeId(client);
  if (defaultAssigneeId) {
    notificationData.userId = defaultAssigneeId;
  }
  await createNotification(client, notificationData);

  return { created: card, recovered: 0 };
}

/**
 * Run the cron logic: scan templates with triggerType "automatic",
 * evaluate their schedule against the current date, and create cards
 * for matches (with duplicate prevention).
 */
async function runCron(
  client: DynamoDBDocumentClient,
  now?: Date,
  sponsorEvaluators: SponsorAutomationEvaluators = defaultSponsorAutomationEvaluators,
): Promise<CronRunnerResult> {
  const today = now || new Date();
  const todayDate = berlinDate(today);

  // 1. List all templates and filter to automatic triggers
  const allTemplates = await listTemplates(client);
  const autoTemplates = allTemplates.filter(
    (t: Template) => t.triggerType === 'automatic' && t.triggerSchedule && t.triggerEnabled !== false
  );

  // 2. Get all existing cards for duplicate detection
  const allCards = await listCards(client);

  const created: string[] = [];
  let skipped = 0;
  let recovered = 0;
  let failures = 0;
  let templateFailures = 0;
  const recurringGenerated: string[] = [];
  let recurringSkipped = 0;
  let recurringFailures = 0;

  const sponsorAutomations = [
    ['sponsor-booking-alerts', 'sponsor booking alerts', sponsorEvaluators.bookingAlerts],
    ['sponsor-finance-alerts', 'sponsor finance alerts', sponsorEvaluators.financeAlerts],
    ['sponsor-communication-suggestions', 'sponsor communication suggestions', sponsorEvaluators.communicationSuggestions],
  ] as const;
  for (const [automationId, name, evaluate] of sponsorAutomations) {
    try {
      const result = await evaluate(client, todayDate);
      await recordAutomationRun(client, automationId, { ok: true, summary: countsSummary(result) }, today);
    } catch (err: unknown) {
      failures++;
      await recordAutomationRun(client, automationId, { ok: false, summary: `Failed: ${(err as Error)?.message || 'unknown error'}` }, today);
      console.error(`Sponsor automation evaluator failed: ${name}`);
      try {
        await createNotification(client, {
          type: 'automation-failure',
          message: `Sponsor automation evaluator failed: ${name} for ${todayDate}`,
          dueAt: todayDate,
        });
      } catch {
        console.error(`Sponsor automation failure notification failed: ${name}`);
      }
    }
  }

  try {
    const recurringResult = await generateRecurringTasks(client, todayDate, todayDate);
    recurringSkipped = recurringResult.skipped;
    recurringFailures = recurringResult.failures;
    failures += recurringFailures;
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
    recurringFailures++;
    await createNotification(client, {
      type: 'automation-failure',
      message: `Recurring task generation failed for ${todayDate}: ${(err as Error).message}`,
      dueAt: todayDate,
    });
  } finally {
    await recordAutomationRun(client, 'recurring-tasks', {
      ok: recurringFailures === 0,
      summary: [
        `${plural(recurringGenerated.length, 'task')} created`,
        ...(recurringFailures ? [plural(recurringFailures, 'failure')] : []),
      ].join(', '),
    }, today);
    // The function's error metrics cannot see a pass that never ran, so the
    // pass reports itself: no datapoint means a missed day, and a datapoint
    // carrying a failure count says the recurring schedules are broken.
    emitRecurringCronMetrics({ passes: 1, failures: recurringFailures });
  }

  // Newsletter issue Cards come due a set number of days before the issue.
  const newsletterCards: CronRunnerResult['newsletterCards'] = { created: [], failures: [] };
  try {
    const run = await createDueIssueCards(client, todayDate);
    newsletterCards.created = run.created;
    newsletterCards.failures = run.failures;
    failures += run.failures.length;
    for (const failure of run.failures) {
      await createNotification(client, {
        type: 'automation-failure',
        message: `Newsletter Card for ${failure.label} was not created on ${todayDate}: ${failure.error}`,
        dueAt: todayDate,
      });
    }
  } catch (err: unknown) {
    failures++;
    newsletterCards.failures.push({ issueId: '', label: 'newsletter issues', error: (err as Error).message });
    await createNotification(client, {
      type: 'automation-failure',
      message: `Newsletter Card creation failed for ${todayDate}: ${(err as Error).message}`,
      dueAt: todayDate,
    });
  }
  await recordAutomationRun(client, 'newsletter-cards', {
    ok: newsletterCards.failures.length === 0,
    summary: [
      `${plural(newsletterCards.created.length, 'card')} created`,
      ...(newsletterCards.failures.length ? [plural(newsletterCards.failures.length, 'failure')] : []),
    ].join(', '),
  }, today);

  for (const template of autoTemplates) {
    try {
      // 3. The anchors whose Cards come due today. A schedule date on a
      // Saturday or Sunday occurs on the following Monday, so weekend passes
      // create nothing and Monday's pass handles the weekend's dates too.
      // Each anchor is its schedule date plus the lead days, itself moved off
      // a weekend: no Card is anchored on a Saturday or Sunday, and the
      // Tasks dated from the anchor follow it.
      const cron = parseCronExpression(template.triggerSchedule!);
      if (!cron) continue;
      const leadDays = template.triggerLeadDays || 0;
      const anchorDates = [...new Set(scheduleDatesOccurringOn(cron, todayDate)
        .map((scheduleDate) => moveWeekendToMonday(addCivilDays(scheduleDate, leadDays))))];

      for (const anchorDate of anchorDates) {
        const outcome = await ensureAutomaticCard(client, template, anchorDate, allCards);
        if (outcome.created) {
          allCards.push(outcome.created);
          created.push(outcome.created.id);
        } else {
          skipped++;
          recovered += outcome.recovered;
        }
      }
    } catch (err: unknown) {
      failures++;
      templateFailures++;
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

  await recordAutomationRun(client, 'automatic-template-cards', {
    ok: templateFailures === 0,
    summary: [
      `${plural(created.length, 'card')} created`,
      ...(recovered ? [`${plural(recovered, 'task')} recovered`] : []),
      ...(templateFailures ? [plural(templateFailures, 'failure')] : []),
    ].join(', '),
  }, today);

  return {
    created,
    skipped: skipped + recurringSkipped,
    templates: { created, skipped, recovered },
    recurring: { generated: recurringGenerated, skipped: recurringSkipped, failures: recurringFailures },
    newsletterCards,
    failures,
  };
}

export { runCron, formatAnchorDate };
