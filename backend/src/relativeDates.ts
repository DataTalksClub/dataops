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
  return todayIn('Europe/Berlin', now);
}

/** Civil date (YYYY-MM-DD) in `tz` for `now` (default: this instant). */
export function todayIn(tz: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
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
 * Accept an absolute date or a relative word (`+7d`, `tomorrow`, `mon`)
 * resolved against the Berlin today. Returns null when the value is neither.
 */
export function resolveTaskDate(value: unknown, today: string = berlinToday()): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (isCalendarDate(text)) return text;
  if (!isCalendarDate(today)) return null;
  return resolveRelativeDateWord(text, today);
}

/** True when `tz` names a real IANA timezone. */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function tzOffsetMs(tz: string, utcMs: number): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - utcMs;
}

/** A civil `YYYY-MM-DD` + `HH:mm:ss` in `tz` as a UTC ISO instant. */
export function civilToUtc(day: string, time: string, tz: string): string {
  const [year, month, date] = day.split('-').map(Number);
  const [hour, minute, second] = time.split(':').map(Number);
  const civilAsUtc = Date.UTC(year, month - 1, date, hour, minute, second || 0);
  let guess = civilAsUtc - tzOffsetMs(tz, civilAsUtc);
  for (let round = 0; round < 3; round += 1) {
    const next = civilAsUtc - tzOffsetMs(tz, guess);
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess).toISOString();
}

const CIVIL_DATETIME = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * Resolve a "not before" moment: an ISO instant with an offset (kept as UTC),
 * a civil `YYYY-MM-DD HH:mm` in `tz`, a plain date (midnight in `tz`), or a
 * relative word (`+7d`, `tomorrow`, `mon` — midnight that day in `tz`).
 * Returns the UTC ISO instant, or null when the value has no reading.
 */
export function resolveTaskDateTime(value: unknown, tz = 'Europe/Berlin', today: string = todayIn(tz)): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (ISO_INSTANT.test(text)) {
    const ms = Date.parse(text);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }
  const civil = CIVIL_DATETIME.exec(text);
  if (civil) {
    const [, day, hour, minute, second] = civil;
    const validTime = Number(hour) <= 23 && Number(minute) <= 59 && (second === undefined || Number(second) <= 59);
    if (!isCalendarDate(day) || !validTime) return null;
    return civilToUtc(day, `${hour}:${minute}:${second || '00'}`, tz);
  }
  if (isCalendarDate(text)) return civilToUtc(text, '00:00:00', tz);
  if (!isCalendarDate(today)) return null;
  const relative = resolveRelativeDateWord(text, today);
  if (relative) return civilToUtc(relative, '00:00:00', tz);
  return null;
}
