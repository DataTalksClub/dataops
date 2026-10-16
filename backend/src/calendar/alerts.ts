import type { CalendarEntry } from './entities';
import type { HolidayOccurrence } from './holidays';

/**
 * Upcoming events that fall on a Berlin public or school holiday. Past events
 * are history, so they raise nothing. The fingerprint carries the event's
 * date, so moving the event raises the alert again.
 */
export function calendarAlerts(entries: CalendarEntry[], holidays: HolidayOccurrence[], today: string) {
  const out: { reasonCode: string; severity: string; affectedIds: string[]; fingerprint: string }[] = [];
  for (const entry of entries) {
    if (entry.date < today) continue;
    for (const holiday of holidays) {
      if (entry.date < holiday.startDate || entry.date > holiday.endDate) continue;
      const reasonCode = holiday.kind === 'berlin-public-holiday' ? 'public-holiday-overlap' : 'school-holiday-overlap';
      out.push({
        reasonCode,
        severity: 'warning',
        affectedIds: [entry.id],
        fingerprint: `${reasonCode}#${entry.id}#${entry.date}:${holiday.kind}:${holiday.startDate}:${holiday.endDate}`,
      });
    }
  }
  return out;
}
