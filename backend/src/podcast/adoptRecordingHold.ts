/**
 * create-card time carry-over: a recording hold booked before the Card exists
 * (for example the 12:30 midday hold) is adopted by the new Card instead of
 * leaving it all-day or proposing a second hold. The hold row gains the
 * cardId, the Card projects its time, and the episode records the hold id, so
 * later `event reschedule` upgrades this same hold.
 */
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { calendarInviteUrl } from '../calendar/cardInvite';
import type { CalendarHold } from '../calendar/holds';
import { listCalendarHolds, putCalendarHold } from '../db/calendarHolds';
import { updateCardAdditive } from '../db/cards';
import type { PodcastEpisode } from '../db/podcastEpisodes';
import type { Card } from '../types';

/** The one active, still-unlinked hold on the episode's recording date, or the hold the episode already names. */
export async function findAdoptableRecordingHold(
  client: DynamoDBDocumentClient,
  episode: Pick<PodcastEpisode, 'recordingDate' | 'recordingHoldId'>,
): Promise<CalendarHold | null> {
  if (!episode.recordingDate && !episode.recordingHoldId) return null;
  const active = (await listCalendarHolds(client, { activeOnly: true })).filter(
    (hold) => hold.status === 'tentative' || hold.status === 'confirmed',
  );
  if (episode.recordingHoldId) {
    const named = active.find((hold) => hold.id === episode.recordingHoldId);
    return named && !named.cardId ? named : null;
  }
  const candidates = active.filter((hold) => !hold.cardId && hold.date === episode.recordingDate);
  return candidates.length === 1 ? candidates[0] : null;
}

/** Link `hold` to `card`; returns the hold id and local time the episode should record. */
export async function adoptRecordingHold(
  client: DynamoDBDocumentClient,
  card: Card,
  hold: CalendarHold,
  actorId: string,
): Promise<{ holdId: string; time: string }> {
  const now = new Date().toISOString();
  await putCalendarHold(client, { ...hold, cardId: card.id, updatedAt: now, version: hold.version + 1 });
  await updateCardAdditive(client, card, (current) => {
    const invites = [...(current.calendarInvites || [])];
    for (const [calendar, eventId] of Object.entries(hold.googleEventIds || {})) {
      if (invites.some((invite) => invite.calendar === calendar && invite.eventId === eventId)) continue;
      invites.push({ calendar, eventId, url: calendarInviteUrl(calendar, eventId), createdAt: now, createdBy: actorId });
    }
    return {
      anchorDate: hold.date,
      calendarInvites: invites,
      eventTime: {
        eventKey: hold.id,
        startIso: hold.startIso,
        endIso: hold.endIso,
        timeZone: hold.timeZone,
        durationMinutes: hold.durationMinutes,
        googleEventIds: hold.googleEventIds || {},
        sync: hold.googleSync?.state === 'synced' ? 'synced' : 'deferred',
        syncStartedAt: now,
        status: hold.status === 'confirmed' ? 'approved' : 'proposed',
        ...(hold.googleSync?.state === 'deferred' && hold.googleSync.reason ? { reason: hold.googleSync.reason } : {}),
      },
    };
  });
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: hold.timeZone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(hold.startIso));
  return { holdId: hold.id, time };
}
