import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { getCardConsistent, updateCard } from '../db/cards';
import { getPodcastEpisode, listPodcastEpisodes } from '../db/podcastEpisodes';
import { getTemplate } from '../db/templates';
import { getCalendarHold } from '../db/calendarHolds';
import { podcastEpisodeTitleValues, renderCardTitle } from '../cards/cardTitlePattern';
import { checkTitle, titleReviewError, type TitleReview } from './titleQuality';
import { EventConflictError } from './lifecycle';

export class TitleReviewInputError extends Error {}

/** Read-only: unlike event transition resolution this never upgrades old holds. */
export async function inspectEventTitle(client: DynamoDBDocumentClient, targetId: string) {
  let card = await getCardConsistent(client, targetId);
  let episode = card ? (await listPodcastEpisodes(client)).find(item => item.cardId === card!.id) : await getPodcastEpisode(client, targetId);
  let hold = !card && !episode ? await getCalendarHold(client, targetId) : null;
  if (!card) card = await getCardConsistent(client, episode?.cardId || hold?.cardId || '');
  if (!card) throw new TitleReviewInputError('Event Card not found');
  if (!episode) episode = (await listPodcastEpisodes(client)).find(item => item.cardId === card!.id);
  if (!hold) hold = await getCalendarHold(client, card.eventTime?.eventKey || episode?.recordingHoldId || `hold_${card.id}`);
  const title = episode?.title || hold?.topic || card.title || '';
  const check = checkTitle(title, episode?.guests.map(guest => guest.name) || card.people || []);
  const pattern = (await getTemplate(client, card.templateId))?.cardTitle;
  const expectedCardTitle = episode && pattern ? renderCardTitle(pattern, podcastEpisodeTitleValues(episode)) : title;
  const copies = { card: card.title || '', ...(episode ? { episode: episode.title || '' } : {}), ...(hold ? { holdTitle: hold.title, holdTopic: hold.topic } : {}) };
  const mismatches: string[] = [];
  if (card.title !== expectedCardTitle) mismatches.push('Card');
  if (hold && (hold.title !== title || hold.topic !== title)) mismatches.push('hold title/topic');
  const reviewError = titleReviewError(title, card.titleReview, episode?.guests.map(guest => guest.name) || card.people);
  return { ...check, cardId: card.id, expectedVersion: card.version, copies, mismatches,
    approved: !reviewError && !mismatches.length, reviewRequired: Boolean(reviewError || mismatches.length),
    review: card.titleReview || null,
    nextStep: mismatches.length ? `Reconcile ${mismatches.join(', ')} explicitly with the episode/Card and dataops event update. Check documents/public copies before approving; nothing is renamed or published by this check.` : reviewError,
  };
}

export async function approveEventTitle(client: DynamoDBDocumentClient, targetId: string, input: Record<string, unknown>, actor: string) {
  const check = await inspectEventTitle(client, targetId);
  if (input.expectedVersion !== check.expectedVersion) throw new EventConflictError('Card changed; rerun title-check and use its expectedVersion');
  for (const key of ['meaningful', 'broad', 'consistent']) {
    if (input[key] !== true) throw new TitleReviewInputError(`Confirm ${key}: ${check.checklist[key as keyof typeof check.checklist]}`);
  }
  if (typeof input.note !== 'string' || !input.note.trim() || input.note.length > 1000) throw new TitleReviewInputError('A review note (1–1000 characters) describing the agreed topic and checked title copies is required');
  const review: TitleReview = { title: check.title, meaningful: true, broad: true, consistent: true, note: input.note.trim(), actor, reviewedAt: new Date().toISOString() };
  const error = check.issues.filter(issue => issue.code !== 'breadth_review').map(issue => issue.message).join(' ');
  if (error) throw new TitleReviewInputError(error);
  if (check.mismatches.length) throw new TitleReviewInputError(check.nextStep || 'Reconcile title copies before approval');
  // Only this internal review is stored. No Google, email, document or public write.
  await updateCard(client, check.cardId, { expectedVersion: check.expectedVersion, patch: { titleReview: review } });
  return { ...check, expectedVersion: check.expectedVersion + 1, approved: true, reviewRequired: false, review, nextStep: null };
}
