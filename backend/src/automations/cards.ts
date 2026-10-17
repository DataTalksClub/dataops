/**
 * The rows Alexey actually wants in the "Recurring automations" section: the
 * Cards that get created automatically and when. Built from the real rules,
 * not hardcoded copy:
 *
 * - newsletter issue Cards: one row per newsletter kind that has a Template,
 *   with the effective lead days from the live workspace settings;
 * - automatic Template Cards: one row per Template with an automatic trigger,
 *   with its cron schedule in plain words.
 *
 * Reminder/"ensure" jobs are not card rules and never appear here; internal
 * plumbing (exports, backups, knowledge sync) stays in the automations list
 * under a collapsed "system jobs" area instead.
 */

import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import {
  addCivilDays,
  moveWeekendToMonday,
  nextOccurrenceDate,
  parseCronExpression,
} from '../cron/cronMatch';
import { listTemplates } from '../db/templates';
import { loadCardSchedule } from '../newsletter/cardSchedule';
import type { AutomationRun } from './runs';
import { AUTOMATIONS, DAILY_JOB_SCHEDULE } from './registry';
import { nextRunAt } from './view';

export interface AutomationCardRule {
  id: string;
  name: string;
  /** The cadence in plain words, with timezone. */
  scheduleLabel: string;
  /** How far ahead of the anchor the Card is created. */
  leadTime: string;
  /** The "skip if it already exists" rule. */
  skipRule: string;
  /** ISO instant of the next daily evaluation that can create the Card. */
  nextRunAt: string | null;
  /** The recorded run of the automation that creates these Cards. */
  lastRun: (AutomationRun & { source: 'recorded' }) | null;
  /** Portal deep link to the Template, when one backs the rule. */
  templateLink: string | null;
}

const BERLIN_ZONE = 'Europe/Berlin';

const WEEKDAY_PLURAL = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'] as const;
const MONTH_NAME = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

function ordinal(day: number): string {
  const teen = day % 100;
  if (teen >= 11 && teen <= 13) return `${day}th`;
  switch (day % 10) {
    case 1: return `${day}st`;
    case 2: return `${day}nd`;
    case 3: return `${day}rd`;
    default: return `${day}th`;
  }
}

const singleNumber = (field: string, min: number, max: number): number | null => {
  if (!/^\d+$/.test(field)) return null;
  const value = Number(field);
  return value >= min && value <= max ? value : null;
};

/**
 * A template trigger schedule in plain words, or null when the expression
 * uses a shape this wording does not cover (the caller then shows the raw
 * expression instead of inventing a reading). Minute and hour are
 * deliberately ignored: the daily pass runs on day granularity and they only
 * say when the operator thinks of the work.
 */
export function templateScheduleWords(expression: string): string | null {
  const cron = parseCronExpression(expression);
  if (!cron) return null;
  const any = (field: string) => field === '*';
  if (any(cron.dayOfMonth) && any(cron.month) && any(cron.dayOfWeek)) return `Every morning (${BERLIN_ZONE})`;
  const dayOfMonth = singleNumber(cron.dayOfMonth, 1, 31);
  const month = singleNumber(cron.month, 1, 12);
  const dayOfWeek = singleNumber(cron.dayOfWeek, 0, 7);
  if (dayOfMonth !== null && any(cron.month) && any(cron.dayOfWeek)) {
    return `Monthly on the ${ordinal(dayOfMonth)} (${BERLIN_ZONE})`;
  }
  if (any(cron.dayOfMonth) && any(cron.month) && dayOfWeek !== null) {
    return `Weekly on ${WEEKDAY_PLURAL[dayOfWeek === 7 ? 0 : dayOfWeek]} (${BERLIN_ZONE})`;
  }
  if (dayOfMonth !== null && month !== null && any(cron.dayOfWeek)) {
    return `Yearly on ${MONTH_NAME[month - 1]} ${ordinal(dayOfMonth)} (${BERLIN_ZONE})`;
  }
  return null;
}

function daysLabel(days: number): string {
  return days === 1 ? '1 day' : `${days} days`;
}

function nextDailyCheck(now: Date): string | null {
  const daily = AUTOMATIONS.find((automation) => automation.id === 'recurring-tasks');
  return nextRunAt(daily?.schedule || DAILY_JOB_SCHEDULE, now);
}

/**
 * The next daily-job instant on or after the anchor date of the next schedule
 * occurrence: the pass that would create the Card. Falls back to the next
 * daily check when the expression has no future occurrence.
 */
function nextTemplateRun(expression: string, leadDays: number, now: Date): string | null {
  const occurrence = nextOccurrenceDate(expression, now);
  if (!occurrence) return nextDailyCheck(now);
  const anchor = moveWeekendToMonday(addCivilDays(occurrence, leadDays));
  const candidate = nextRunAt(DAILY_JOB_SCHEDULE, new Date(`${anchor}T00:00:00Z`));
  if (candidate && new Date(candidate).getTime() > now.getTime()) return candidate;
  const later = nextOccurrenceDate(expression, new Date(`${anchor}T00:00:00Z`));
  if (!later || later === occurrence) return nextDailyCheck(now);
  const laterAnchor = moveWeekendToMonday(addCivilDays(later, leadDays));
  return nextRunAt(DAILY_JOB_SCHEDULE, new Date(`${laterAnchor}T00:00:00Z`)) || nextDailyCheck(now);
}

const NEWSLETTER_KIND_LABEL: Record<string, string> = {
  weekly: 'Weekly newsletter',
  standalone: 'Stand-alone newsletter',
};

export async function automationCardRules(
  client: DynamoDBDocumentClient,
  options: { now?: Date; recorded?: Map<string, AutomationRun> } = {},
): Promise<AutomationCardRule[]> {
  const now = options.now || new Date();
  const recorded = options.recorded || new Map();
  const rules: AutomationCardRule[] = [];

  const schedule = await loadCardSchedule(client);
  for (const kind of Object.keys(schedule.leadDays) as Array<keyof typeof schedule.leadDays>) {
    const lead = schedule.leadDays[kind];
    const template = schedule.templates[kind];
    if (lead === undefined || !template) continue;
    const label = NEWSLETTER_KIND_LABEL[String(kind)] || String(kind);
    const run = recorded.get('newsletter-cards');
    rules.push({
      id: `newsletter-${String(kind)}`,
      name: `${label} issue card`,
      scheduleLabel: `Every morning (${BERLIN_ZONE})`,
      leadTime: `${daysLabel(lead)} before the send date, earlier when the Template has a Task due further ahead`,
      skipRule: 'One Card per issue; skipped when the issue already has one',
      nextRunAt: nextDailyCheck(now),
      lastRun: run ? { ...run, source: 'recorded' } : null,
      templateLink: `/templates?templateId=${encodeURIComponent(template.id)}`,
    });
  }

  const templates = await listTemplates(client);
  const automatic = templates
    .filter((template) => template.triggerType === 'automatic' && template.triggerSchedule && template.triggerEnabled !== false)
    .sort((left, right) => left.name.localeCompare(right.name));
  const automaticRun = recorded.get('automatic-template-cards');
  for (const template of automatic) {
    const expression = String(template.triggerSchedule);
    const leadDays = template.triggerLeadDays || 0;
    rules.push({
      id: `template-${template.id}`,
      name: `${template.name} card`,
      scheduleLabel: templateScheduleWords(expression) || `${expression} (${BERLIN_ZONE})`,
      leadTime: leadDays === 0
        ? 'Created on the scheduled date'
        : `Created ${daysLabel(leadDays)} before the scheduled date`,
      skipRule: 'One Card per anchor date; missing Tasks are recovered instead of duplicating the Card',
      nextRunAt: nextTemplateRun(expression, leadDays, now),
      lastRun: automaticRun ? { ...automaticRun, source: 'recorded' } : null,
      templateLink: `/templates?templateId=${encodeURIComponent(template.id)}`,
    });
  }
  return rules;
}
