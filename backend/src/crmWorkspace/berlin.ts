import { berlinToday } from '../relativeDates';
import { realDate } from '../sponsorCrm/model';

export { berlinToday };

/** Query-param `today` when valid YYYY-MM-DD, otherwise the Europe/Berlin day for `now`. */
export function todayOf(
  event: { queryStringParameters?: Record<string, string | undefined> | null },
  now = new Date(),
): string {
  const query = event.queryStringParameters || {};
  return realDate(query.today) ? String(query.today) : berlinToday(now);
}

/** Berlin day N days before `today` (both YYYY-MM-DD). */
export function berlinDaysBefore(today: string, days: number): string {
  const ms = Date.parse(`${today}T12:00:00Z`) - days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}
