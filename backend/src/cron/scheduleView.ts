import type { RecurringConfig } from '../types';
import { nextMatchingDate, parseCronExpression } from './cronMatch';

const WEEKDAY_NAMES = Object.freeze([
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
]);

const SHORT_WEEKDAY = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short' });
const SHORT_DAY = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' });

export interface RecurringScheduleView {
  scheduleLabel: string;
  nextRunDate: string;
  nextRunLabel: string;
}

/**
 * Plain-English cadence for a schedule the generator actually honours. Anything
 * the day-granular model cannot summarise -- a range, a step, a month filter --
 * is shown as the expression itself rather than a guess.
 */
export function describeSchedule(cronExpression: string): string {
  const fields = parseCronExpression(cronExpression);
  if (!fields) return String(cronExpression || 'No schedule');
  const { minute, hour, dayOfMonth, month, dayOfWeek } = fields;
  if (month !== '*' || !/^\d+$/.test(minute) || !/^\d+$/.test(hour)) return cronExpression;
  const time = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
  if (dayOfMonth === '*' && dayOfWeek === '*') return `Every day at ${time}`;
  if (dayOfMonth === '*' && /^\d$/.test(dayOfWeek)) {
    // Cron accepts 7 as Sunday; the weekday names only know 0.
    const weekday = dayOfWeek === '7' ? '0' : dayOfWeek;
    return `Every ${WEEKDAY_NAMES[Number(weekday)]} at ${time}`;
  }
  if (/^\d+$/.test(dayOfMonth) && dayOfWeek === '*') return `Monthly on day ${dayOfMonth} at ${time}`;
  return cronExpression;
}

export function nextRunLabel(nextRunDate: string, today: string): string {
  if (!nextRunDate) return '';
  if (nextRunDate === today) return 'Today';
  const instant = new Date(`${nextRunDate}T00:00:00.000Z`);
  if (Number.isNaN(instant.getTime())) return nextRunDate;
  return `${SHORT_WEEKDAY.format(instant)} ${SHORT_DAY.format(instant)}`;
}

/**
 * The schedule a config is on, as the browser and the CLI read it. The server
 * owns the next-run computation, so clients render these values verbatim.
 */
export function recurringConfigView(config: RecurringConfig, today: string): RecurringConfig & RecurringScheduleView {
  const nextRunDate = config.nextRunDate || '';
  return {
    ...config,
    scheduleLabel: describeSchedule(config.cronExpression),
    nextRunDate,
    nextRunLabel: nextRunLabel(nextRunDate, today),
  };
}
