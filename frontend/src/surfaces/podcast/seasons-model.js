// The seasons overview as the page reads it: one row per season with a cell
// per episode number, the numbers nobody holds (gaps) and the numbers two
// episodes claim (duplicates); a pipeline lane for in-flight episodes that
// have no number yet; and the flags that say an episode has sat too long.
// Pure functions over the /api/podcast-episodes records; no DOM.
import { episodeKeyDate, isUpcoming, STATUS_LABELS } from "./model.js";

/** Recorded or edited this long after the recording reads as stuck. */
export const STALE_DAYS = 42;

/** Pipeline order, then the off-ramp; the order counts and the legend read in. */
export const GRID_STATUSES = Object.freeze(["booked", "recorded", "edited", "scheduled", "published", "cancelled"]);

const DAY_MS = 86400000;

function dayNumber(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / DAY_MS : null;
}

function daysBetween(from, to) {
  const start = dayNumber(from);
  const end = dayNumber(to);
  return start === null || end === null ? null : end - start;
}

/** "3 weeks", "4 months": how long, said the way a person would. */
export function formatAge(days) {
  if (days < 14) return `${days} day${days === 1 ? "" : "s"}`;
  if (days < 61) return `${Math.floor(days / 7)} weeks`;
  return `${Math.floor(days / 30)} months`;
}

/**
 * What is wrong with where an episode stands, as of `today`:
 * - stale: recorded or edited, and the recording is STALE_DAYS or more ago;
 * - overdue: booked past its recording date, or scheduled past its release.
 * Returns null when nothing is.
 */
export function episodeFlag(episode, today) {
  const status = episode?.status;
  if (status === "recorded" || status === "edited") {
    const age = daysBetween(episode.recordingDate, today);
    if (age !== null && age >= STALE_DAYS) {
      return { kind: "stale", days: age, text: `${STATUS_LABELS[status]} ${formatAge(age)} after recording` };
    }
  }
  if (status === "booked") {
    const late = daysBetween(episode.recordingDate, today);
    if (late !== null && late > 0) return { kind: "overdue", days: late, text: `Recording date passed ${formatAge(late)} ago` };
  }
  if (status === "scheduled") {
    const late = daysBetween(episode.releaseDate, today);
    if (late !== null && late > 0) return { kind: "overdue", days: late, text: `Release date passed ${formatAge(late)} ago` };
  }
  return null;
}

function byKeyDate(left, right) {
  const a = episodeKeyDate(left).value || "9999-99-99";
  const b = episodeKeyDate(right).value || "9999-99-99";
  if (a !== b) return a < b ? -1 : 1;
  return String(left.id).localeCompare(String(right.id));
}

function countStatuses(episodes) {
  const counts = {};
  for (const episode of episodes) counts[episode.status] = (counts[episode.status] || 0) + 1;
  return counts;
}

/** "6 published · 1 recorded", in pipeline order, newest work last. */
export function countsLabel(counts) {
  const order = [...GRID_STATUSES].reverse();
  return order
    .filter((status) => counts[status])
    .map((status) => `${counts[status]} ${STATUS_LABELS[status].toLowerCase()}`)
    .join(" · ");
}

/**
 * The overview of `episodes` as of `today` (YYYY-MM-DD):
 *   pipeline  in-flight episodes with no episode number, soonest date first;
 *   seasons   newest first: { season, cells, counts, gaps, duplicates };
 *             a cell is { kind: "episode", number, episode, duplicate, flag }
 *             or { kind: "gap", number }; an unnumbered episode that is not in
 *             flight sits after the numbered ones with number null;
 *   loose     episodes with no season that are not in flight.
 */
export function buildSeasonGrid(episodes, today) {
  const pipeline = [];
  const loose = [];
  const bySeason = new Map();
  for (const episode of Array.isArray(episodes) ? episodes : []) {
    if (!episode?.episode && isUpcoming(episode)) pipeline.push(episode);
    else if (!episode?.season) loose.push(episode);
    else {
      const list = bySeason.get(episode.season) || [];
      list.push(episode);
      bySeason.set(episode.season, list);
    }
  }
  const seasons = [...bySeason.keys()].sort((a, b) => b - a).map((season) => {
    const members = bySeason.get(season);
    const numbered = new Map();
    const unnumbered = [];
    for (const episode of members) {
      const number = Number(episode.episode) || 0;
      if (!number) unnumbered.push(episode);
      else numbered.set(number, [...(numbered.get(number) || []), episode]);
    }
    const highest = Math.max(0, ...numbered.keys());
    const cells = [];
    const gaps = [];
    const duplicates = [];
    for (let number = 1; number <= highest; number += 1) {
      const holders = (numbered.get(number) || []).sort(byKeyDate);
      if (!holders.length) {
        gaps.push(number);
        cells.push({ kind: "gap", number });
        continue;
      }
      if (holders.length > 1) duplicates.push(number);
      for (const episode of holders) {
        cells.push({ kind: "episode", number, episode, duplicate: holders.length > 1, flag: episodeFlag(episode, today) });
      }
    }
    for (const episode of unnumbered.sort(byKeyDate)) {
      cells.push({ kind: "episode", number: null, episode, duplicate: false, flag: episodeFlag(episode, today) });
    }
    return { season, cells, counts: countStatuses(members), gaps, duplicates };
  });
  return {
    pipeline: pipeline.sort(byKeyDate).map((episode) => ({ episode, flag: episodeFlag(episode, today) })),
    seasons,
    loose: loose.sort(byKeyDate),
  };
}

/** "E4 twice · no E5": the numbering problems of one season, or "". */
export function numberingLabel(row) {
  const parts = [];
  if (row.duplicates.length) parts.push(`${row.duplicates.map((n) => `E${n}`).join(", ")} twice`);
  if (row.gaps.length) parts.push(`no ${row.gaps.map((n) => `E${n}`).join(", ")}`);
  return parts.join(" · ");
}

/**
 * What the overview asks someone to look at: flagged episodes (stale or
 * overdue, the longest first) and seasons whose numbering has holes or
 * collisions, newest season first.
 */
export function attentionOf(grid) {
  const flagged = [
    ...grid.pipeline.filter((item) => item.flag),
    ...grid.seasons.flatMap((row) => row.cells.filter((cell) => cell.kind === "episode" && cell.flag)),
  ]
    .map((item) => ({ episode: item.episode, flag: item.flag }))
    .sort((a, b) => b.flag.days - a.flag.days);
  const numbering = grid.seasons
    .filter((row) => row.gaps.length || row.duplicates.length)
    .map((row) => ({
      season: row.season,
      label: numberingLabel(row),
      duplicates: row.cells.filter((cell) => cell.duplicate).map((cell) => cell.episode),
    }));
  return { flagged, numbering };
}
