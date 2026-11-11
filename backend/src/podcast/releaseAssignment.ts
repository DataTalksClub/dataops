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

/**
 * The release tuple state every response shows. A stored state wins; a slot
 * saved without one reads as provisional, never final: final needs an
 * explicit confirmation after the stream.
 */
export function effectiveReleaseAssignment(episode: Partial<PodcastEpisode>): ReleaseAssignmentStatus {
  if (episode.releaseAssignmentStatus) return episode.releaseAssignmentStatus;
  return episode.releaseDate || episode.season != null || episode.episode != null ? "provisional" : "unassigned";
}

export type ReleaseWarningCode =
  | "missing-release-slot"
  | "slot-not-final"
  | "missing-provider-schedule"
  | "provider-date-mismatch";

export interface ReleaseWarning {
  code: ReleaseWarningCode;
  message: string;
}

/**
 * Release readiness warnings. A DataOps release date alone never makes an
 * episode fully scheduled: that needs the provider schedule proof
 * (`publication.audioSchedule` with a proofUrl) on the same local date.
 */
export function releaseWarnings(
  episode: Partial<PodcastEpisode>,
  scheduledLocalDate: string | null,
): { fullyScheduled: boolean; warnings: ReleaseWarning[] } {
  const warnings: ReleaseWarning[] = [];
  if (episode.status === "cancelled" || episode.status === "published") return { fullyScheduled: episode.status === "published", warnings };
  const state = effectiveReleaseAssignment(episode);
  const recorded = episode.status !== "booked";
  if (state === "unassigned" || !episode.releaseDate) {
    warnings.push({
      code: "missing-release-slot",
      message: recorded
        ? "Recorded without a season, episode and publication date: assign the final slot"
        : "No preliminary season, episode and publication date yet",
    });
  } else if (state === "provisional" && recorded) {
    warnings.push({ code: "slot-not-final", message: "Recorded, but the release slot is still provisional: confirm the final slot" });
  }
  const proof = episode.publication?.audioSchedule?.proofUrl;
  if (state === "final" && episode.releaseDate && !proof)
    warnings.push({
      code: "missing-provider-schedule",
      message: "Final slot booked in DataOps only: record the Spotify for Creators schedule proof",
    });
  if (proof && episode.releaseDate && scheduledLocalDate && scheduledLocalDate !== episode.releaseDate)
    warnings.push({
      code: "provider-date-mismatch",
      message: `Spotify schedule is ${scheduledLocalDate} but the DataOps publication date is ${episode.releaseDate}`,
    });
  const fullyScheduled =
    state === "final" && Boolean(proof) && Boolean(episode.releaseDate) && scheduledLocalDate === episode.releaseDate;
  return { fullyScheduled, warnings };
}
