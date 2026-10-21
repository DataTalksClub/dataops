import type { CalendarHold } from './holds';
import { formatBerlinTime } from './ownerCalendarOverlay';
import type { CalendarOverlayItem, CalendarOverlayProvider } from './overlays';

/**
 * Active holds (tentative + confirmed) as a hard-occupancy overlay. Unlike
 * the owner's soft buffers, a hold always blocks its window: the grid
 * suppresses any owner available slot the hold covers, and the day schedule
 * lists the hold so Orin can propose/confirm/release it.
 */
export function calendarHoldOverlay(holds: CalendarHold[]): CalendarOverlayProvider {
  return {
    name: 'calendar-holds',
    async project(from: string, to: string) {
      const items: CalendarOverlayItem[] = [];
      for (const hold of holds) {
        if (hold.date < from || hold.date > to) continue;
        if (hold.status !== 'tentative' && hold.status !== 'confirmed') continue;
        let time: string;
        try {
          time = `${formatBerlinTime(hold.startIso)}–${formatBerlinTime(hold.endIso)}`;
        } catch {
          time = hold.window;
        }
        items.push({
          provider: 'calendar-holds',
          id: `calendar-hold:${hold.id}`,
          startDate: hold.date,
          endDate: hold.date,
          label: `${hold.status === 'tentative' ? '(Proposal) ' : ''}${hold.title} · ${time}`,
          category: 'Calendar hold',
          slot: hold.window,
          isSlotEvent: true,
          isAvailableSlot: false,
          startsAt: hold.startIso,
          endsAt: hold.endIso,
          status: hold.status,
        });
      }
      return { items, connection: { state: 'connected' } };
    },
  };
}

/** Owner available slots a hold covers are no longer offered as free. */
export function suppressHeldSlots(
  items: CalendarOverlayItem[],
  holds: CalendarHold[],
): CalendarOverlayItem[] {
  const covered = new Set(
    holds
      .filter((h) => h.status === 'tentative' || h.status === 'confirmed')
      .map((h) => `${h.date}#${h.window}`),
  );
  if (!covered.size) return items;
  return items.filter(
    (item) =>
      !(
        item.provider === 'owner-calendar' &&
        item.isAvailableSlot &&
        covered.has(`${item.startDate}#${item.slot}`)
      ),
  );
}
