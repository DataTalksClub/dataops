import { realDate } from '../sponsorCrm/model';

/** Berlin calendar day (YYYY-MM-DD) for `now`. The CRM reasons in Europe/Berlin days. */
export function berlinToday(now: Date = new Date()): string {
  try {
    const day = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Berlin',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
    if (realDate(day)) return day;
  } catch {
    // Fall through to the UTC day below; never throw for a clock/calendar nicety.
  }
  return now.toISOString().slice(0, 10);
}

/** Berlin day N days before `today` (both YYYY-MM-DD). */
export function berlinDaysBefore(today: string, days: number): string {
  const ms = Date.parse(`${today}T12:00:00Z`) - days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}
