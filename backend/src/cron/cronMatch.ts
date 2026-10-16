const BERLIN_TIME_ZONE = 'Europe/Berlin';

/**
 * A schedule is five cron fields, but the daily pass only ever fires on day
 * granularity, so minute and hour are parsed and rejected when malformed and
 * then ignored: they say when the operator thinks of the work, not when the
 * batch runs.
 */
const CRON_FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dayOfMonth', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dayOfWeek', min: 0, max: 7 },
] as const;

// `*/N`, `N`, `N-M`, and either range with `/N`. Anything else is rejected
// before it can be stored, so the generator never sees syntax it would miss.
const CRON_TERM = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/;

/**
 * The longest gap any day-of-month/month pair can have. Eight years is the
 * worst leap-day gap (2096-02-29 to 2104-02-29), so an expression that still
 * has not matched after that cannot match at all.
 */
const MAX_SCHEDULE_SEARCH_DAYS = 366 * 8 + 1;

export interface CronExpression {
  minute: string;
  hour: string;
  dayOfMonth: string;
  month: string;
  dayOfWeek: string;
}

type FieldMatcher = (value: number) => boolean;

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = zoneFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    zoneFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * The civil date an instant falls on in `timeZone`. Calendar parts keep the
 * answer exact across a DST boundary, where a fixed UTC offset would shift the
 * date by a day on either side of the switch.
 */
function civilDateInZone(instant: Date, timeZone: string): string {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function addCivilDays(civilDate: string, days: number): string {
  const [year, month, day] = civilDate.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + days));
  return next.toISOString().slice(0, 10);
}

function parseTerm(term: string, min: number, max: number): FieldMatcher | null {
  const match = CRON_TERM.exec(term);
  if (!match) return null;
  const [, range, stepText] = match;
  const step = stepText === undefined ? 1 : Number(stepText);
  if (!Number.isInteger(step) || step < 1) return null;
  if (range === '*') return (value) => value % step === 0;
  const [startText, endText] = range.split('-');
  const start = Number(startText);
  const end = endText === undefined ? start : Number(endText);
  if (start < min || end > max || start > end) return null;
  return (value) => value >= start && value <= end && (value - start) % step === 0;
}

function parseField(field: string, min: number, max: number): FieldMatcher | null {
  const matchers: FieldMatcher[] = [];
  for (const term of field.split(',')) {
    const matcher = parseTerm(term.trim(), min, max);
    if (!matcher) return null;
    matchers.push(matcher);
  }
  return matchers.length > 0 ? (value) => matchers.some((matcher) => matcher(value)) : null;
}

export function parseCronExpression(expression: string): CronExpression | null {
  const fields = String(expression || '').trim().split(/\s+/);
  if (fields.length !== CRON_FIELDS.length) return null;
  const parsed: Record<string, string> = {};
  for (const [index, field] of CRON_FIELDS.entries()) {
    if (!parseField(fields[index], field.min, field.max)) return null;
    parsed[field.name] = fields[index];
  }
  return parsed as unknown as CronExpression;
}

export function cronFieldMatches(field: string, value: number): boolean {
  const matcher = parseField(String(field || ''), 0, Number.MAX_SAFE_INTEGER);
  return matcher ? matcher(value) : false;
}

function matchesDay(cron: CronExpression, dayOfMonth: number, month: number, dayOfWeek: number): boolean {
  if (!cronFieldMatches(cron.dayOfMonth, dayOfMonth)) return false;
  if (!cronFieldMatches(cron.month, month)) return false;
  // Cron accepts 0 and 7 as Sunday; the calendar only ever produces 0.
  return cronFieldMatches(cron.dayOfWeek, dayOfWeek)
    || (dayOfWeek === 0 && cronFieldMatches(cron.dayOfWeek, 7));
}

/** True when a civil date (YYYY-MM-DD) satisfies the day fields of a schedule. */
export function cronMatchesCivilDate(cron: CronExpression, civilDate: string): boolean {
  const [year, month, day] = civilDate.split('-').map(Number);
  return matchesDay(cron, day, month, new Date(Date.UTC(year, month - 1, day)).getUTCDay());
}

function civilWeekday(civilDate: string): number {
  const [year, month, day] = civilDate.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/**
 * The team works weekdays and the calendar hides weekends, so no work item
 * lands on a Saturday or Sunday (Berlin civil dates): a weekend date moves to
 * the following Monday and a weekday stays where it is. Recurring schedules
 * and automatic Template Cards share this rule.
 */
export function moveWeekendToMonday(civilDate: string): string {
  const weekday = civilWeekday(civilDate);
  if (weekday === 6) return addCivilDays(civilDate, 2);
  if (weekday === 0) return addCivilDays(civilDate, 1);
  return civilDate;
}

/**
 * The schedule dates whose occurrence falls on a civil date, oldest first.
 *
 * A schedule date occurs on itself, or on the following Monday when it is a
 * Saturday or Sunday. Saturdays and Sundays therefore never carry an
 * occurrence, and a Monday carries the schedule's matches on that Monday and
 * the weekend before it.
 */
export function scheduleDatesOccurringOn(cron: CronExpression, civilDate: string): string[] {
  return [-2, -1, 0]
    .map((days) => addCivilDays(civilDate, days))
    .filter((date) => moveWeekendToMonday(date) === civilDate && cronMatchesCivilDate(cron, date));
}

/**
 * True when a schedule has an occurrence on a Berlin civil date, weekend
 * dates moved to Monday: a daily schedule's Saturday, Sunday and Monday
 * collapse into one Monday occurrence, not three.
 */
export function scheduleOccursOn(cron: CronExpression, civilDate: string): boolean {
  return scheduleDatesOccurringOn(cron, civilDate).length > 0;
}

/**
 * First Berlin civil date on or after `fromDate`'s civil date in `timeZone`
 * that a schedule occurs on, weekend dates moved to Monday. Returns
 * '' when the expression cannot match any date.
 */
export function nextOccurrenceDate(
  expression: string,
  fromDate: Date = new Date(),
  timeZone: string = BERLIN_TIME_ZONE,
): string {
  const cron = parseCronExpression(expression);
  if (!cron) return '';
  let civilDate = civilDateInZone(fromDate, timeZone);
  // Two extra days let a final weekend match still reach its Monday.
  for (let step = 0; step < MAX_SCHEDULE_SEARCH_DAYS + 2; step += 1) {
    if (scheduleOccursOn(cron, civilDate)) return civilDate;
    civilDate = addCivilDays(civilDate, 1);
  }
  return '';
}
