/**
 * Load occupancy and pick the next free podcast recording slot for create /
 * create-card. Pure selection lives in recordingSlots.ts; this file is the
 * Dynamo-backed glue.
 */
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { listCalendarHolds } from '../db/calendarHolds';
import { listCards } from '../db/cards';
import { listTemplates } from '../db/templates';
import { listPodcastEpisodes, type PodcastEpisode } from '../db/podcastEpisodes';
import { EVENT_CARD_TYPES } from '../calendar/entities';
import { berlinToday, ownerCalendarOverlay } from '../calendar/ownerCalendarOverlay';
import {
  addDays,
  DEFAULT_RECORDING_HORIZON_DAYS,
  nextRecordingSlot,
  nextRecordingSlots,
  type NextRecordingSlotsResult,
  type RecordingSlot,
} from './recordingSlots';

export async function eventCardAnchorDates(client: DynamoDBDocumentClient): Promise<string[]> {
  const [cards, templates] = await Promise.all([listCards(client), listTemplates(client)]);
  const templateById = new Map(templates.map((t) => [t.id, t]));
  const dates: string[] = [];
  for (const card of cards) {
    const template = templateById.get(card.templateId);
    if (!template || !EVENT_CARD_TYPES.has(String(template.type)) || !card.anchorDate) continue;
    dates.push(String(card.anchorDate).slice(0, 10));
  }
  return dates;
}

export async function loadRecordingOccupancy(client: DynamoDBDocumentClient): Promise<{
  episodes: PodcastEpisode[];
  holds: Awaited<ReturnType<typeof listCalendarHolds>>;
  eventCardDates: string[];
  fromDate: string;
  ownerFreeWindows?: string[];
}> {
  const fromDate = berlinToday();
  const toDate = addDays(fromDate, DEFAULT_RECORDING_HORIZON_DAYS - 1);
  const [episodes, holds, eventCardDates, ownerProjection] = await Promise.all([
    listPodcastEpisodes(client),
    listCalendarHolds(client, { activeOnly: true }),
    eventCardAnchorDates(client),
    ownerCalendarOverlay({ client, durationMinutes: 60, window: 'any' }).project(fromDate, toDate),
  ]);
  const ownerFreeWindows = ownerProjection.connection.state === 'connected'
    ? ownerProjection.items
      .filter((item) => item.provider === 'owner-calendar' && item.isAvailableSlot && item.slot)
      .map((item) => `${item.startDate}#${item.slot}`)
    : undefined;
  return { episodes, holds, eventCardDates, fromDate, ownerFreeWindows };
}

export async function pickNextRecordingSlot(
  client: DynamoDBDocumentClient,
  opts: { excludeEpisodeId?: string | null } = {},
): Promise<RecordingSlot | null> {
  const { episodes, holds, eventCardDates, fromDate, ownerFreeWindows } = await loadRecordingOccupancy(client);
  const filtered = opts.excludeEpisodeId
    ? episodes.filter((e) => e.id !== opts.excludeEpisodeId)
    : episodes;
  return nextRecordingSlot({
    fromDate,
    episodes: filtered,
    holds,
    eventCardDates,
    ownerFreeWindows,
  });
}

export async function listNextRecordingSlots(
  client: DynamoDBDocumentClient,
  count: number,
): Promise<NextRecordingSlotsResult> {
  const { episodes, holds, eventCardDates, fromDate, ownerFreeWindows } = await loadRecordingOccupancy(client);
  return nextRecordingSlots({
    fromDate,
    episodes,
    holds,
    eventCardDates,
    ownerFreeWindows,
    count,
  });
}
