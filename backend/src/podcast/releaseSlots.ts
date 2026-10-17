/**
 * Podcast release slots: the stacking rule from the scheduling SOP.
 *
 * A release slot is one weekly cadence moment (default Friday 19:00
 * Europe/Berlin, DST-aware). A slot is taken when a non-cancelled episode
 * holds that calendar date as its `releaseDate` or as the local date of its
 * Spotify `publication.audioSchedule`. The next episode number is the highest
 * number already held in the current (highest) season plus one, counting
 * booked/recorded episodes that already hold a number; seasons roll over
 * after `episodesPerSeason` (default 9, so S25E9 is followed by S26E1).
 *
 * The cadence and the season length are workspace settings, never hardcoded
 * here beyond their defaults.
 */

import { localDate, validTimezone } from "./publication";
import type { PodcastEpisode } from "../db/podcastEpisodes";

export interface PodcastReleaseCadence {
  /** ISO weekday: Monday 1 .. Sunday 7. Friday is 5. */
  weekday: number;
  /** Wall-clock release time in the cadence timezone, HH:MM (24h). */
  time: string;
  /** IANA timezone the wall time is read in. */
  timezone: string;
}

export const DEFAULT_PODCAST_RELEASE_CADENCE: PodcastReleaseCadence = Object.freeze({
  weekday: 5,
  time: "19:00",
  timezone: "Europe/Berlin",
});

export const DEFAULT_PODCAST_EPISODES_PER_SEASON = 9;
export const MAX_PODCAST_EPISODES_PER_SEASON = 99;
export const MAX_NEXT_SLOT_COUNT = 52;

export interface ReleaseSlot {
  /** Calendar date of the slot in the cadence timezone. */
  date: string;
  /** Wall-clock time, from the cadence. */
  localTime: string;
  timezone: string;
  /** The wall time as a UTC instant (DST-aware). */
  utcInstant: string;
}

export interface NextSlotResult {
  cadence: PodcastReleaseCadence;
  episodesPerSeason: number;
  season: number;
  episode: number;
  code: string;
  slots: ReleaseSlot[];
  takenDates: string[];
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function validCadence(value: unknown): value is PodcastReleaseCadence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Number.isInteger(record.weekday) &&
    Number(record.weekday) >= 1 &&
    Number(record.weekday) <= 7 &&
    typeof record.time === "string" &&
    TIME.test(record.time) &&
    validTimezone(record.timezone)
  );
}

/** Stored cadence wins per field; anything else falls back to the default. */
export function normalizeCadence(value: unknown): PodcastReleaseCadence {
  const record = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const weekday =
    Number.isInteger(record.weekday) && Number(record.weekday) >= 1 && Number(record.weekday) <= 7
      ? Number(record.weekday)
      : DEFAULT_PODCAST_RELEASE_CADENCE.weekday;
  const time =
    typeof record.time === "string" && TIME.test(record.time)
      ? record.time
      : DEFAULT_PODCAST_RELEASE_CADENCE.time;
  const timezone = validTimezone(record.timezone)
    ? (record.timezone as string)
    : DEFAULT_PODCAST_RELEASE_CADENCE.timezone;
  return { weekday, time, timezone };
}

export function normalizeEpisodesPerSeason(value: unknown): number {
  return Number.isInteger(value) &&
    Number(value) >= 1 &&
    Number(value) <= MAX_PODCAST_EPISODES_PER_SEASON
    ? Number(value)
    : DEFAULT_PODCAST_EPISODES_PER_SEASON;
}

/** YYYY-MM-DD of `now` on the wall clock of `timezone`. */
export function todayInTimezone(timezone: string, now = new Date()): string {
  return localDate(now.toISOString(), timezone);
}

/** ISO weekday (Mon 1 .. Sun 7) of a Berlin-calendar `date` read in `timezone`. */
function weekdayOf(date: string, timezone: string): number {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
  }).format(new Date(`${date}T12:00:00Z`));
  return { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[weekday] ?? 0;
}

function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function timezoneOffsetMs(timezone: string, utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(utcMs));
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value;
  const wallAsUtc = Date.UTC(
    Number(part("year")),
    Number(part("month")) - 1,
    Number(part("day")),
    Number(part("hour") === "24" ? "00" : part("hour")),
    Number(part("minute")),
    Number(part("second")),
  );
  return wallAsUtc - utcMs;
}

/**
 * The UTC instant of `time` on `date` in `timezone`, DST-aware: the offset is
 * resolved for that actual date, so a 19:00 Berlin slot is 17:00Z in summer
 * and 18:00Z in winter.
 */
export function zonedTimeToUtc(date: string, time: string, timezone: string): string {
  const wallAsUtc = Date.parse(`${date}T${time}:00Z`);
  let utc = wallAsUtc - timezoneOffsetMs(timezone, wallAsUtc);
  utc = wallAsUtc - timezoneOffsetMs(timezone, utc);
  return new Date(utc).toISOString();
}

/**
 * Calendar dates already held: the `releaseDate` or the local date of the
 * Spotify schedule of every non-cancelled episode.
 */
export function takenReleaseDates(episodes: Pick<PodcastEpisode, "status" | "releaseDate" | "publication">[]): Set<string> {
  const taken = new Set<string>();
  for (const episode of episodes) {
    if (episode.status === "cancelled") continue;
    if (episode.releaseDate) taken.add(episode.releaseDate);
    const schedule = episode.publication?.audioSchedule;
    if (schedule) {
      try {
        taken.add(localDate(schedule.scheduledAt, schedule.timezone));
      } catch {
        // An unreadable schedule holds no slot.
      }
    }
  }
  return taken;
}

/**
 * The next season/episode number: the highest number already held in the
 * current (highest-numbered) season plus one, counting booked/recorded
 * episodes that already hold a number. After `episodesPerSeason` the season
 * rolls over (with the default 9, S25E9 is followed by S26E1).
 */
export function nextEpisodeNumber(
  episodes: Pick<PodcastEpisode, "status" | "season" | "episode">[],
  episodesPerSeason = DEFAULT_PODCAST_EPISODES_PER_SEASON,
): { season: number; episode: number; code: string } {
  const live = episodes.filter((episode) => episode.status !== "cancelled");
  const seasons = live.map((episode) => episode.season).filter((season): season is number => Number.isInteger(season));
  if (!seasons.length) return { season: 1, episode: 1, code: "S1E1" };
  const season = Math.max(...seasons);
  const held = live
    .filter((episode) => episode.season === season)
    .map((episode) => episode.episode)
    .filter((episode): episode is number => Number.isInteger(episode));
  if (!held.length) return { season, episode: 1, code: `S${season}E1` };
  const max = Math.max(...held);
  if (max >= episodesPerSeason) return { season: season + 1, episode: 1, code: `S${season + 1}E1` };
  return { season, episode: max + 1, code: `S${season}E${max + 1}` };
}

/** The next `count` free cadence dates on or after `fromDate` (a cadence-timezone date). */
export function freeSlotDates(
  fromDate: string,
  count: number,
  cadence: PodcastReleaseCadence,
  taken: Set<string>,
): string[] {
  const free: string[] = [];
  let date = fromDate;
  for (let step = 0; step < 730 && free.length < count; step += 1) {
    if (weekdayOf(date, cadence.timezone) === cadence.weekday && !taken.has(date)) free.push(date);
    date = addDays(date, 1);
  }
  return free;
}

export function nextReleaseSlots(input: {
  episodes: Pick<PodcastEpisode, "status" | "season" | "episode" | "releaseDate" | "publication">[];
  cadence?: PodcastReleaseCadence;
  episodesPerSeason?: number;
  count?: number;
  now?: Date;
}): NextSlotResult {
  const cadence = input.cadence ?? { ...DEFAULT_PODCAST_RELEASE_CADENCE };
  const episodesPerSeason = input.episodesPerSeason ?? DEFAULT_PODCAST_EPISODES_PER_SEASON;
  const count = input.count ?? 4;
  const taken = takenReleaseDates(input.episodes);
  const fromDate = todayInTimezone(cadence.timezone, input.now ?? new Date());
  const dates = freeSlotDates(fromDate, count, cadence, taken);
  const numbered = nextEpisodeNumber(input.episodes, episodesPerSeason);
  return {
    cadence,
    episodesPerSeason,
    ...numbered,
    slots: dates.map((date) => ({
      date,
      localTime: cadence.time,
      timezone: cadence.timezone,
      utcInstant: zonedTimeToUtc(date, cadence.time, cadence.timezone),
    })),
    takenDates: [...taken].sort(),
  };
}
