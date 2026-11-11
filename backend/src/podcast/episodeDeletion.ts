import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { deletePodcastEpisode, type PodcastEpisode } from '../db/podcastEpisodes';
import { getCardConsistent } from '../db/cards';
import { listTasksByCard } from '../db/tasks';
import { listCalendarHolds } from '../db/calendarHolds';

export type DeletionConfirmation = { version: number; evidence: string };
export type DeletionPolicy = Readonly<Record<string, DeletionConfirmation | null>>;

// Candidate identities only. Null deliberately blocks deletion. Replace an entry
// only after exact identity confirmation is recorded on the private intake, with
// the reviewed episode version and an evidence reference. Never infer from names.
export const EPISODE_DELETION_POLICY: DeletionPolicy = Object.freeze({
  '0ba64623-47cb-40d8-a395-e1131d5f0b8d': null,
  'c452570a-f682-49d5-8b4b-0837cf71e47c': null,
  'faa77c54-e560-435f-9199-6574b84d84ae': null,
  'bcbfb38a-0bd0-4996-bf9c-ae89f3b86042': null,
});

export function deletionBlockers(episode: PodcastEpisode, policy: DeletionPolicy): string[] {
  const reasons: string[] = [];
  if (!Object.hasOwn(policy, episode.id)) reasons.push('Episode is not allowlisted');
  const confirmation = policy[episode.id];
  if (!confirmation?.evidence?.trim()) reasons.push('Exact episode identity is not confirmed');
  else if (confirmation.version !== episode.version) reasons.push('Confirmed episode version changed');
  if (episode.status !== 'cancelled') reasons.push('Episode must already be cancelled');
  if (episode.season || episode.episode || episode.releaseDate || episode.websiteSlug || episode.scheduleSourceKey
    || Object.values(episode.links || {}).some(Boolean)
    || Object.keys(episode.publication || {}).length) reasons.push('Historical or publication evidence must be preserved');
  return reasons;
}

/** Reads references only. Missing Cards are safe; no lifecycle/Google/mail writes. */
export async function previewEpisodeDeletion(
  client: DynamoDBDocumentClient,
  episode: PodcastEpisode,
  policy: DeletionPolicy = EPISODE_DELETION_POLICY,
) {
  const blockers = deletionBlockers(episode, policy);
  const card = episode.cardId ? await getCardConsistent(client, episode.cardId) : null;
  const tasks = episode.cardId ? await listTasksByCard(client, episode.cardId) : [];
  const holds = (await listCalendarHolds(client)).filter(hold =>
    hold.id === episode.recordingHoldId || Boolean(episode.cardId && hold.cardId === episode.cardId));
  if (card) blockers.push('Linked Card still exists');
  if (tasks.length) blockers.push('Linked Card still has Tasks');
  if (holds.some(hold => hold.status !== 'released' && hold.status !== 'expired')) {
    blockers.push('Recording calendar hold is not released or expired');
  }
  return {
    id: episode.id, version: episode.version, status: episode.status,
    title: episode.title, guests: episode.guests, recordingDate: episode.recordingDate,
    cardId: episode.cardId || null,
    cardState: card ? 'exists' : episode.cardId ? 'stale' : 'none',
    taskCount: tasks.length,
    holds: holds.map(hold => ({ id: hold.id, status: hold.status })),
    eligible: blockers.length === 0, blockers,
    effects: ['Delete episode register row only'],
  };
}

/** Keep the write separate from preview, with the episode's version condition. */
export async function executeEpisodeDeletion(
  client: DynamoDBDocumentClient,
  episode: PodcastEpisode,
  policy: DeletionPolicy = EPISODE_DELETION_POLICY,
) {
  const preview = await previewEpisodeDeletion(client, episode, policy);
  if (!preview.eligible) return { deleted: false, ...preview };
  await deletePodcastEpisode(client, episode);
  return { deleted: true, ...preview };
}
