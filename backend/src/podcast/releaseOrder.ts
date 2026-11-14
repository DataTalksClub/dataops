/**
 * Shared release-date validator for podcast episodes.
 *
 * The release cadence (stored workspace setting, default Friday 19:00
 * Europe/Berlin) puts at most one episode in each ISO week, strictly in
 * episode-number order. This module is the single check behind
 * `podcast update`, `podcast create --release-date`, assign-release and
 * `next-slot`, so none of them can offer or write a date the others reject.
 *
 * It only judges the candidate against the register; it never edits existing
 * episodes, so historical public inversions stay as they are.
 */

import type { PodcastEpisode } from "../db/podcastEpisodes";
import { localDate } from "./publication";

export type ReleaseOrderViolationCode =
  | "episode-order"
  | "lower-episode-unscheduled"
  | "same-iso-week"
  | "off-cadence";

export interface ReleaseOrderViolation {
  code: ReleaseOrderViolationCode;
  message: string;
  /** The other episode the candidate collides with. */
  otherEpisodeId?: string;
}

type RegisterEntry = Pick<
  PodcastEpisode,
  "id" | "status" | "season" | "episode" | "releaseDate" | "publication"
>;

export interface ReleaseCandidate {
  id?: string | null;
  status?: PodcastEpisode["status"];
  season?: number | null;
  episode?: number | null;
  releaseDate?: string | null;
}

const code = (entry: { season?: number | null; episode?: number | null }) =>
  `S${entry.season}E${entry.episode}`;

const numbered = (entry: { season?: number | null; episode?: number | null }) =>
  Number.isInteger(entry.season) && Number.isInteger(entry.episode);

/** Sort key: season-major, episode-minor. */
const order = (entry: { season?: number | null; episode?: number | null }) =>
  Number(entry.season) * 1000 + Number(entry.episode);

/** ISO week label ("2026-W43") of a YYYY-MM-DD calendar date. */
export function isoWeekOf(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const year = d.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const week = Math.ceil(((d.getTime() - jan1) / 86400000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** The calendar date an episode comes out: its release date, else its Spotify schedule date. */
export function episodeReleaseDate(episode: Pick<PodcastEpisode, "releaseDate" | "publication">): string | null {
  if (episode.releaseDate) return episode.releaseDate;
  const schedule = episode.publication?.audioSchedule;
  if (!schedule) return null;
  try {
    return localDate(schedule.scheduledAt, schedule.timezone);
  } catch {
    return null;
  }
}

/**
 * Check one candidate release date against the register. Returns every
 * violation; an empty list means the date is safe to write or propose.
 * Cancelled episodes and the candidate's own row are ignored.
 */
export function releaseDateViolations(
  candidate: ReleaseCandidate,
  register: RegisterEntry[],
): ReleaseOrderViolation[] {
  const date = candidate.releaseDate;
  if (!date || candidate.status === "cancelled") return [];
  const others = register.filter(
    (episode) => episode.status !== "cancelled" && (!candidate.id || episode.id !== candidate.id),
  );
  const violations: ReleaseOrderViolation[] = [];

  const week = isoWeekOf(date);
  for (const other of others) {
    const otherDate = episodeReleaseDate(other);
    if (otherDate && isoWeekOf(otherDate) === week)
      violations.push({
        code: "same-iso-week",
        otherEpisodeId: other.id,
        message: `${date} is in ISO week ${week}, which ${numbered(other) ? code(other) : `episode ${other.id}`} already holds (${otherDate}). One episode per week.`,
      });
  }

  if (numbered(candidate)) {
    const mine = order(candidate);
    const label = code(candidate);
    for (const other of others) {
      if (!numbered(other)) continue;
      const theirs = order(other);
      const otherDate = episodeReleaseDate(other);
      if (otherDate) {
        if (mine > theirs && date < otherDate)
          violations.push({
            code: "episode-order",
            otherEpisodeId: other.id,
            message: `${label} on ${date} would come out before ${code(other)} on ${otherDate}. Episodes release strictly in number order.`,
          });
        else if (mine < theirs && date > otherDate)
          violations.push({
            code: "episode-order",
            otherEpisodeId: other.id,
            message: `${label} on ${date} would come out after ${code(other)} on ${otherDate}. Episodes release strictly in number order.`,
          });
      } else if (
        mine > theirs &&
        other.season === candidate.season &&
        other.status !== "published"
      ) {
        violations.push({
          code: "lower-episode-unscheduled",
          otherEpisodeId: other.id,
          message: `${label} cannot get ${date} while ${code(other)} has no release date yet. Schedule ${code(other)} first.`,
        });
      }
    }
  }
  return violations;
}

export const formatViolations = (violations: ReleaseOrderViolation[]) =>
  violations.map((violation) => violation.message).join(" ");
