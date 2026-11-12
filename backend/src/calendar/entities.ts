import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { listCards } from '../db/cards';
import { listTemplates } from '../db/templates';
import { listPodcastEpisodes, type PodcastEpisode } from '../db/podcastEpisodes';
import { liveBackReferences } from '../db/taskCardLinks';
import type { Card, Template } from '../types';

/**
 * One calendar entry. The calendar stores nothing of its own: every entry is a
 * read-only projection of an entity (an event Card on its anchor date, or a
 * podcast episode on its recording and release dates) and links to it.
 * Newsletter issues are projected by the newsletter overlay.
 */
export type CalendarEntry = {
  id: string;
  /** The event Card's Template type, or podcast-recording / podcast-release. */
  kind: string;
  kindLabel: string;
  title: string;
  date: string;
  status: string;
  entity: { type: 'card' | 'podcast-episode'; id: string };
  href: string;
  /** Scheduled or held start and end ISO timestamps when known. */
  startsAt?: string;
  endsAt?: string;
  /** Whether the event time is still proposed (tentative) or confirmed. */
  timeStatus?: 'proposed' | 'confirmed';
  /** A canonical relationship used to collapse duplicate calendar projections only. */
  linkedHoldId?: string;
  /** This entry remains available through its entity page but is represented by another tile. */
  displayDuplicateOf?: string;
};

/**
 * Template types whose Cards are dated events. Podcast Cards are shown through
 * their episode when one exists (or directly when a proposed/confirmed time is
 * held on the Card before an episode record is created); newsletter Cards show
 * through their issue.
 */
export const EVENT_CARD_TYPES = new Set([
  'webinar',
  'workshop',
  'course',
  'book-of-the-week',
  'maven-ll',
  'office-hours',
  'oss',
]);

const withPeople = (title: string, people: string[]) =>
  [title, people.filter(Boolean).join(', ')].filter(Boolean).join(' · ');

export function cardCalendarEntry(card: Card, template: Template): CalendarEntry {
  const isPodcast = template.type === 'podcast';
  const eventTime = card.eventTime && card.eventTime.status !== 'released' ? card.eventTime : undefined;
  const timeStatus = eventTime
    ? (eventTime.status === 'proposed' ? 'proposed' : 'confirmed')
    : undefined;
  return {
    id: `card:${card.id}`,
    kind: isPodcast ? 'podcast-recording' : (template.type || 'event'),
    kindLabel: isPodcast ? 'Podcast recording' : template.name,
    title: withPeople(card.title || template.name, card.people || []),
    date: String(card.anchorDate).slice(0, 10),
    status: card.status === 'active' ? card.stage : card.status,
    entity: { type: 'card', id: card.id },
    href: `/cards?cardId=${encodeURIComponent(card.id)}`,
    ...(eventTime?.eventKey ? { linkedHoldId: eventTime.eventKey } : {}),
    ...(eventTime?.startIso ? { startsAt: eventTime.startIso } : {}),
    ...(eventTime?.endIso ? { endsAt: eventTime.endIso } : {}),
    ...(timeStatus ? { timeStatus } : {}),
  };
}

export function podcastCalendarEntries(episode: PodcastEpisode, linkedCard?: Card): CalendarEntry[] {
  if (episode.status === 'cancelled') return [];
  const title = withPeople(episode.title || 'Podcast', episode.guests.map((guest) => guest.name));
  const cardEventTime = linkedCard?.eventTime && linkedCard.eventTime.status !== 'released'
    ? linkedCard.eventTime
    : undefined;
  const recordingHoldId = episode.recordingHoldId || cardEventTime?.eventKey;
  const recordingStartsAt = episode.recordingStartIso || cardEventTime?.startIso;
  const recordingEndsAt = episode.recordingEndIso || cardEventTime?.endIso;
  const recordingRawStatus = episode.recordingEventStatus || cardEventTime?.status;
  const recordingTimeStatus = recordingRawStatus === 'proposed'
    ? 'proposed'
    : (recordingRawStatus || recordingStartsAt ? 'confirmed' : undefined);
  const entry = (kind: 'podcast-recording' | 'podcast-release', kindLabel: string, date: string): CalendarEntry => ({
    id: `${kind}:${episode.id}`,
    kind,
    kindLabel,
    title,
    date,
    status: episode.status,
    entity: { type: 'podcast-episode', id: episode.id },
    href: `/podcast?episodeId=${encodeURIComponent(episode.id)}`,
    ...(kind === 'podcast-recording' && recordingHoldId
      ? { linkedHoldId: recordingHoldId }
      : {}),
    ...(kind === 'podcast-recording' && recordingStartsAt
      ? { startsAt: recordingStartsAt }
      : {}),
    ...(kind === 'podcast-recording' && recordingEndsAt
      ? { endsAt: recordingEndsAt }
      : {}),
    ...(kind === 'podcast-recording' && recordingTimeStatus
      ? { timeStatus: recordingTimeStatus }
      : {}),
  });
  return [
    ...(episode.recordingDate ? [entry('podcast-recording', 'Podcast recording', episode.recordingDate)] : []),
    ...(episode.releaseDate ? [entry('podcast-release', 'Podcast release', episode.releaseDate)] : []),
  ];
}

/**
 * A course Card's linked webinar is its canonical launch event. Keep both
 * entities in the read model, but identify the parent Card as represented by
 * its linked webinar when both occupy the same calendar date.
 */
export function markCourseLaunchDuplicates(
  entries: CalendarEntry[],
  cards: Card[],
  templateById: Map<string, Template>,
  links: Array<{ sourceCardId: string; targetCardId: string }>,
): CalendarEntry[] {
  const cardsById = new Map(cards.map((card) => [card.id, card]));
  const duplicateTargets = new Map<string, string>();

  for (const link of links) {
    const webinar = cardsById.get(link.targetCardId);
    const course = cardsById.get(link.sourceCardId);
    if (!webinar || !course) continue;
    if (templateById.get(webinar.templateId)?.type !== 'webinar') continue;
    if (templateById.get(course.templateId)?.type !== 'course') continue;
    if (!course.anchorDate || course.anchorDate.slice(0, 10) !== webinar.anchorDate?.slice(0, 10)) continue;
    duplicateTargets.set(`card:${course.id}`, `card:${webinar.id}`);
  }

  return entries.map((entry) => {
    const displayDuplicateOf = duplicateTargets.get(entry.id);
    return displayDuplicateOf ? { ...entry, displayDuplicateOf } : entry;
  });
}

export async function projectCalendarEntities(client: DynamoDBDocumentClient, from: string, to: string): Promise<CalendarEntry[]> {
  const [cards, templates, episodes] = await Promise.all([
    listCards(client),
    listTemplates(client),
    listPodcastEpisodes(client),
  ]);
  const templateById = new Map(templates.map((template) => [template.id, template]));
  const cardById = new Map(cards.map((card) => [card.id, card]));
  const podcastCardIdsWithEpisodeRecording = new Set(
    episodes
      .filter((episode) => episode.status !== 'cancelled' && episode.cardId && episode.recordingDate)
      .map((episode) => episode.cardId!),
  );
  const entries: CalendarEntry[] = [];
  for (const card of cards) {
    const template = templateById.get(card.templateId);
    if (!template || !card.anchorDate) continue;
    const isEventCard = EVENT_CARD_TYPES.has(String(template.type));
    const isUnlinkedPodcastCard =
      template.type === 'podcast' &&
      card.status === 'active' &&
      Boolean(card.eventTime && card.eventTime.status !== 'released') &&
      !podcastCardIdsWithEpisodeRecording.has(card.id);
    if (!isEventCard && !isUnlinkedPodcastCard) continue;
    entries.push(cardCalendarEntry(card, template));
  }
  for (const episode of episodes) {
    entries.push(...podcastCalendarEntries(episode, episode.cardId ? cardById.get(episode.cardId) : undefined));
  }
  const linkRefs = cards
    .filter((target) => templateById.get(target.templateId)?.type === 'webinar'
      && Boolean(target.anchorDate)
      && String(target.anchorDate).slice(0, 10) >= from
      && String(target.anchorDate).slice(0, 10) <= to)
    .flatMap((target) => (target.linkedFrom || [])
      .filter((reference) => {
        const source = cardById.get(reference.cardId);
        return templateById.get(source?.templateId || '')?.type === 'course'
          && String(source?.anchorDate || '').slice(0, 10) === String(target.anchorDate).slice(0, 10);
      })
      .map((reference) => ({ target, reference })));
  const liveLinks = (await Promise.all(linkRefs.map(async ({ target, reference }) => {
    const [live] = await liveBackReferences(client, target.id, [reference]);
    return live ? { sourceCardId: live.cardId, targetCardId: target.id } : null;
  }))).filter((link): link is { sourceCardId: string; targetCardId: string } => link !== null);

  return markCourseLaunchDuplicates(entries
    .filter((entry) => entry.date >= from && entry.date <= to)
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)), cards, templateById, liveLinks);
}
