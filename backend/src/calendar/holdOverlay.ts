import type { CalendarHold } from './holds';
import { formatBerlinTime } from './ownerCalendarOverlay';
import type { CalendarOverlayItem, CalendarOverlayProvider } from './overlays';
import type { CalendarEntry } from './entities';

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
          time = `${formatBerlinTime(hold.startIso)}-${formatBerlinTime(hold.endIso)}`;
        } catch {
          time = hold.window;
        }
        items.push({
          provider: 'calendar-holds',
          id: `calendar-hold:${hold.id}`,
          startDate: hold.date,
          endDate: hold.date,
          label: `${hold.status === 'tentative' ? '[Proposed] ' : ''}${hold.title} · ${time}`,
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

/**
 * Mark an active hold (tentative or confirmed) as a duplicate when the event
 * read model carries the hold's canonical relationship (`linkedHoldId` or
 * `cardId`). Matching titles or dates alone never suppress an item.
 */
export function markDuplicateCalendarHolds(
  items: CalendarOverlayItem[],
  holds: CalendarHold[],
  entries: CalendarEntry[],
): CalendarOverlayItem[] {
  const activeHoldById = new Map(
    holds
      .filter((hold) => hold.status === 'tentative' || hold.status === 'confirmed')
      .map((hold) => [hold.id, hold]),
  );
  const entryByHoldId = new Map<string, CalendarEntry>();
  const entryByCardId = new Map<string, CalendarEntry>();
  for (const entry of entries) {
    if (entry.linkedHoldId) {
      entryByHoldId.set(`${entry.linkedHoldId}#${entry.date}`, entry);
    }
    if (entry.entity?.type === 'card') {
      entryByCardId.set(`${entry.entity.id}#${entry.date}`, entry);
    }
  }

  return items.map((item) => {
    if (item.provider !== 'calendar-holds' || !item.id.startsWith('calendar-hold:')) return item;
    const holdId = item.id.slice('calendar-hold:'.length);
    const hold = activeHoldById.get(holdId);
    if (!hold) return item;
    const linkedEntry =
      entryByHoldId.get(`${holdId}#${hold.date}`) ||
      (hold.cardId ? entryByCardId.get(`${hold.cardId}#${hold.date}`) : undefined);
    return linkedEntry ? { ...item, displayDuplicateOf: linkedEntry.id } : item;
  });
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

/** Public DataOps events occupy their whole day, even when Google is free. */
export function suppressPublicEventSlots(
  items: CalendarOverlayItem[],
  eventDates: Iterable<string>,
): CalendarOverlayItem[] {
  const occupied = new Set(eventDates);
  if (!occupied.size) return items;
  return items.filter(
    (item) =>
      !(
        item.provider === 'owner-calendar' &&
        item.isAvailableSlot &&
        (item.slot === 'midday' || item.slot === 'evening') &&
        occupied.has(item.startDate)
      ),
  );
}
