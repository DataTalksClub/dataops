/**
 * Relative date words the Task API accepts wherever it takes a civil date:
 * `+Nd` days ahead, `today`/`tomorrow`/`yesterday`, or a weekday name (`mon`
 * is the next Monday, strictly after today). "Today" is the Europe/Berlin
 * civil date, matching the agent queue.
 */

const WEEKDAY_INDEX: Record<string, number> = {
  mon: 0, monday: 0,
  tue: 1, tues: 1, tuesday: 1,
  wed: 2, weds: 2, wednesday: 2,
  thu: 3, thur: 3, thurs: 3, thursday: 3,
  fri: 4, friday: 4,
  sat: 5, saturday: 5,
  sun: 6, sunday: 6,
};

export function berlinToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  if (Number.isNaN(Date.parse(`${value}T00:00:00Z`))) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Resolve one relative word against `today`, or null when not relative. */
export function resolveRelativeDateWord(value: string, today: string): string | null {
  const text = value.trim().toLowerCase();
  const plus = /^\+(\d+)\s*d(ays?)?$/.exec(text) || /^\+(\d+)$/.exec(text);
  if (plus) return addDays(today, Number(plus[1]));
  if (text === 'today') return today;
  if (text === 'tomorrow') return addDays(today, 1);
  if (text === 'yesterday') return addDays(today, -1);
  if (Object.hasOwn(WEEKDAY_INDEX, text)) {
    const todayIndex = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
    const delta = ((WEEKDAY_INDEX[text] - todayIndex + 7) % 7) || 7;
    return addDays(today, delta);
  }
  return null;
}

/**
 * Accept an absolute date (passed through) or a relative word (resolved
 * against the Berlin today). Returns null when the value is neither.
 */
export function resolveTaskDate(value: unknown, today: string = berlinToday()): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (isCalendarDate(text)) return text;
  if (!isCalendarDate(today)) return null;
  return resolveRelativeDateWord(text, today);
}
