import {
  RELEASE_ASSIGNMENT_STATUSES,
  type PodcastEpisode,
  type ReleaseAssignmentStatus,
} from "../db/podcastEpisodes";
import { takenReleaseDates, isReleaseCadenceDate, type PodcastReleaseCadence } from "./releaseSlots";

const positive = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;

export function isReleaseAssignmentStatus(value: unknown): value is ReleaseAssignmentStatus {
  return RELEASE_ASSIGNMENT_STATUSES.includes(value as ReleaseAssignmentStatus);
}

/** Validate the explicit release tuple, including the final-after-recording rule. */
export function validateReleaseAssignment(
  episode: Partial<PodcastEpisode>,
  cadence: PodcastReleaseCadence,
  episodesPerSeason = 9,
): string {
  const state = episode.releaseAssignmentStatus;
  if (state === undefined) return "";
  if (!isReleaseAssignmentStatus(state)) return "Invalid releaseAssignmentStatus";
  const hasSlotField = episode.season != null || episode.episode != null || episode.releaseDate != null;
  if (state === "unassigned")
    return hasSlotField ? "Clear season, episode and releaseDate when the release assignment is unassigned" : "";
  if (!positive(episode.season) || !positive(episode.episode) || !episode.releaseDate)
    return "A provisional or final release assignment needs season, episode and releaseDate";
  if (episode.episode > episodesPerSeason)
    return `episode must be 1 to ${episodesPerSeason} for the configured season length`;
  if (state === "final" && episode.status === "booked")
    return "A release assignment can be final only after the episode is recorded";
  if (!isReleaseCadenceDate(episode.releaseDate, cadence))
    return `releaseDate must fall on the configured release weekday (${cadence.weekday}) in ${cadence.timezone}`;
  return "";
}

/** A provisional or final release date already reserved by another episode. */
export function releaseDateConflict(
  candidate: Partial<PodcastEpisode>,
  episodes: PodcastEpisode[],
  selfId: string | null,
) {
  if (!candidate.releaseDate || candidate.status === "cancelled") return "";
  const others = episodes.filter((episode) => episode.id !== selfId);
  if (!takenReleaseDates(others).has(candidate.releaseDate)) return "";
  return `Release date ${candidate.releaseDate} is already held by another episode`;
}
