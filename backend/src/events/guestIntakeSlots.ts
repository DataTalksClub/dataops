import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ownerCalendarOverlay, berlinToday } from '../calendar/ownerCalendarOverlay';
import { cardEventInterval } from '../calendar/cardEventTime';
import { listCalendarHolds } from '../db/calendarHolds';
import { listCards } from '../db/cards';
import { listPodcastEpisodes } from '../db/podcastEpisodes';
import { addDays } from '../podcast/recordingSlots';
import type { GuestIntakeJob } from './guestIntakeStore';
import type { EventPolicy } from './policy';
import { formatSlotLabel } from '../podcast/firstContact';

export function berlinParts(iso: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso)).map(p => [p.type, p.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
export interface GuestEventSlot { date: string; time: string; window: string; startIso: string; endIso: string; label: string }
export async function guestEventSlots(db: DynamoDBDocumentClient, job: GuestIntakeJob, policy: EventPolicy, count = 8): Promise<GuestEventSlot[]> {
  const from = job.requestedDate || addDays(berlinToday(), job.policy?.minimumNoticeDays || 0);
  const to = job.requestedDate || addDays(from, 59);
  const [overlay, busy, holds, cards, episodes] = await Promise.all([
    ownerCalendarOverlay({ client: db, durationMinutes: policy.durationMinutes, window: 'any' }).project(from, to),
    ownerCalendarOverlay({ client: db, includeAll: true, durationMinutes: policy.durationMinutes }).project(addDays(from, -1), addDays(to, 1)),
    listCalendarHolds(db, { activeOnly: true }), listCards(db), listPodcastEpisodes(db),
  ]);
  if (overlay.connection.state !== 'connected' || (busy && busy.connection.state !== 'connected')) throw new Error('The authoritative owner calendar is unavailable; no time was invented');
  const overlaps = (a: number,b: number,c: number,d: number) => a < d && b > c;
  const result: GuestEventSlot[] = [];
  const windows = job.requestedWindow ? [job.requestedWindow] : [...(job.policy?.preferredWindows || []), ...Object.keys(policy.windows)].filter((v,i,a) => a.indexOf(v) === i);
  for (let day = from; day <= to; day = addDays(day, 1)) {
    for (const window of job.requestedTime ? ['explicit'] : windows) {
      const interval = cardEventInterval(`${day} ${job.requestedTime || policy.windows[window]}`, policy.durationMinutes, job.requestedTime ? job.timeZone || 'Europe/Berlin' : policy.timeZone);
      const parts = berlinParts(interval.startIso);
      if ([0,6].includes(new Date(`${parts.date}T12:00:00Z`).getUTCDay())) continue;
      if (job.policy?.weekdays?.length && !job.policy.weekdays.includes(new Date(`${parts.date}T12:00:00Z`).getUTCDay())) continue;
      const start = Date.parse(interval.startIso) - policy.guests.leadMinutes * 60000, end = Date.parse(interval.endIso);
      if (start <= Date.now()) continue;
      if (!job.requestedTime && job.type === 'podcast' && !overlay.items.some(i => i.isAvailableSlot && i.startDate === day && i.slot === window)) continue;
      if (busy?.items.some(i => !i.isAvailableSlot && (i.startsAt && i.endsAt ? overlaps(start,end,Date.parse(i.startsAt),Date.parse(i.endsAt)) : i.startDate <= parts.date && i.endDate >= parts.date))) continue;
      if (holds.some(h => h.cardId !== job.cardId && overlaps(start,end,Date.parse(h.startIso) - policy.guests.leadMinutes * 60000,Date.parse(h.endIso)))) continue;
      if (cards.some(c => c.id !== job.cardId && c.status !== 'archived' && c.eventTime && overlaps(start,end,Date.parse(c.eventTime.startIso) - policy.guests.leadMinutes * 60000,Date.parse(c.eventTime.endIso)))) continue;
      if (episodes.some(e => {
        if (e.cardId === job.cardId || ['released', 'expired'].includes(e.recordingEventStatus || '')) return false;
        if (e.recordingStartIso && e.recordingEndIso) return overlaps(start,end,Date.parse(e.recordingStartIso),Date.parse(e.recordingEndIso));
        if (e.recordingDate && e.recordingTime) {
          const occupied = cardEventInterval(`${e.recordingDate.slice(0,10)} ${e.recordingTime}`, 60, e.recordingTimeZone || 'Europe/Berlin');
          return overlaps(start,end,Date.parse(occupied.startIso),Date.parse(occupied.endIso));
        }
        // Future booked episodes with no interval need reconciliation, not an invented free window.
        return e.recordingDate?.slice(0,10) === parts.date && !e.recordingHoldId && !cards.some(c => c.id === e.cardId && c.eventTime);
      })) continue;
      result.push({ ...parts, window: window === 'explicit' ? job.requestedWindow || 'explicit' : window, startIso: interval.startIso, endIso: interval.endIso, label: formatSlotLabel(interval.startIso) });
      if (result.length >= count) return result;
    }
  }
  if (job.requestedDate && !result.length) throw new Error('The requested date/time is unavailable or violates the event scheduling policy; choose another time');
  return result;
}
