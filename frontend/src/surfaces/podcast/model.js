// The podcast episode register as the page reads it: which episodes are
// still in flight, how the list groups, and what each row and status says.
// Pure functions over the /api/podcast-episodes records; no DOM.

export const EPISODE_STATUSES = Object.freeze([
  "booked",
  "recorded",
  "edited",
  "scheduled",
  "published",
  "cancelled",
]);

export const UPCOMING_STATUSES = Object.freeze(["booked", "recorded", "edited", "scheduled"]);

export const STATUS_LABELS = Object.freeze({
  booked: "Booked",
  recorded: "Recorded",
  edited: "Edited",
  scheduled: "Scheduled",
  published: "Published",
  cancelled: "Cancelled",
});

// The one step forward from each in-flight status.
const NEXT_STATUS = Object.freeze({
  booked: "recorded",
  recorded: "edited",
  edited: "scheduled",
  scheduled: "published",
});

export const STATUS_FILTERS = Object.freeze([
  Object.freeze(["upcoming", "Upcoming"]),
  Object.freeze(["published", "Published"]),
  Object.freeze(["all", "All"]),
]);

export const LINK_KINDS = Object.freeze([
  Object.freeze({ id: "youtube", label: "YouTube", icon: "play" }),
  Object.freeze({ id: "spotify", label: "Spotify", icon: "audio" }),
  Object.freeze({ id: "apple", label: "Apple Podcasts", icon: "podcast" }),
  Object.freeze({ id: "anchor", label: "Anchor", icon: "mic" }),
  Object.freeze({ id: "website", label: "Website", icon: "globe" }),
]);

export function isUpcoming(episode) {
  return UPCOMING_STATUSES.includes(episode?.status);
}

export function nextStatus(status) {
  return NEXT_STATUS[status] || "";
}

export function statusLabel(status) {
  return STATUS_LABELS[status] || String(status || "Unknown");
}

/** S25E3, S25 for an unnumbered episode, "" without a season. */
export function episodeCode(episode) {
  if (!episode?.season) return "";
  return `S${episode.season}${episode.episode ? `E${episode.episode}` : ""}`;
}

export function guestNames(episode) {
  return (Array.isArray(episode?.guests) ? episode.guests : [])
    .map((guest) => String(guest?.name || "").trim())
    .filter(Boolean)
    .join(", ");
}

/** The heading an episode goes by: its title, else its guests. */
export function episodeTitle(episode) {
  const title = String(episode?.title || "").trim();
  if (title) return title;
  const guests = guestNames(episode);
  return guests ? `Podcast with ${guests}` : "Untitled episode";
}

/** "Guest — Title", or whichever half exists. */
export function episodeSummary(episode) {
  const guests = guestNames(episode);
  const title = String(episode?.title || "").trim();
  if (guests && title) return `${guests} — ${title}`;
  return guests || title || "Untitled episode";
}

/**
 * The date that matters for where an episode is: a booked episode waits for
 * its recording, everything after that waits for (or had) its release.
 */
export function episodeKeyDate(episode) {
  if (episode?.status === "booked") {
    return { kind: "recording", value: episode.recordingDate || "" };
  }
  if (episode?.releaseDate) return { kind: "release", value: episode.releaseDate };
  return { kind: "recording", value: episode?.recordingDate || "" };
}

function byKeyDateAscending(left, right) {
  const a = episodeKeyDate(left).value || "9999-99-99";
  const b = episodeKeyDate(right).value || "9999-99-99";
  if (a !== b) return a < b ? -1 : 1;
  return String(left.id).localeCompare(String(right.id));
}

function byEpisodeDescending(left, right) {
  const a = Number(left.episode) || 0;
  const b = Number(right.episode) || 0;
  if (a !== b) return b - a;
  const dateA = episodeKeyDate(left).value;
  const dateB = episodeKeyDate(right).value;
  if (dateA !== dateB) return dateA < dateB ? 1 : -1;
  return String(left.id).localeCompare(String(right.id));
}

export function matchesStatusFilter(episode, filter) {
  if (filter === "upcoming") return isUpcoming(episode);
  if (filter === "published") return episode?.status === "published";
  return true;
}

export function matchesSearch(episode, query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return true;
  return [
    episode?.title,
    guestNames(episode),
    episodeCode(episode),
    ...(Array.isArray(episode?.guests) ? episode.guests.map((guest) => guest?.slug) : []),
  ].some((value) => String(value || "").toLowerCase().includes(needle));
}

export function filterEpisodes(episodes, { status = "upcoming", season = "", query = "" } = {}) {
  return (Array.isArray(episodes) ? episodes : []).filter(
    (episode) =>
      matchesStatusFilter(episode, status) &&
      (!season || String(episode.season || "") === String(season)) &&
      matchesSearch(episode, query),
  );
}

/**
 * Groups for the list: everything still in flight first (soonest date
 * first), then each season newest first, then episodes with no season.
 */
export function groupEpisodes(episodes) {
  const upcoming = [];
  const seasons = new Map();
  const unnumbered = [];
  for (const episode of Array.isArray(episodes) ? episodes : []) {
    if (isUpcoming(episode)) upcoming.push(episode);
    else if (episode.season) {
      const list = seasons.get(episode.season) || [];
      list.push(episode);
      seasons.set(episode.season, list);
    } else unnumbered.push(episode);
  }
  const groups = [];
  if (upcoming.length) {
    groups.push({ id: "upcoming", label: "Upcoming", episodes: upcoming.sort(byKeyDateAscending) });
  }
  for (const season of [...seasons.keys()].sort((a, b) => b - a)) {
    groups.push({
      id: `season-${season}`,
      label: `Season ${season}`,
      episodes: seasons.get(season).sort(byEpisodeDescending),
    });
  }
  if (unnumbered.length) {
    groups.push({ id: "no-season", label: "No season", episodes: unnumbered.sort(byEpisodeDescending) });
  }
  return groups;
}

export function seasonsOf(episodes) {
  return [...new Set((Array.isArray(episodes) ? episodes : []).map((episode) => episode.season).filter(Boolean))]
    .sort((a, b) => b - a);
}

/** The next free number: the latest season, one past its highest episode. */
export function suggestNextNumber(episodes) {
  const numbered = (Array.isArray(episodes) ? episodes : []).filter((episode) => episode.season);
  if (!numbered.length) return { season: null, episode: null };
  const season = Math.max(...numbered.map((episode) => episode.season));
  const highest = Math.max(
    0,
    ...numbered.filter((episode) => episode.season === season).map((episode) => Number(episode.episode) || 0),
  );
  return { season, episode: highest + 1 };
}

/**
 * Guests typed as "Jane Doe, Bob" keep the slug they already had, matched by
 * name, so editing a name list never drops a website link.
 */
export function parseGuestNames(value, existing = []) {
  const slugs = new Map(
    (Array.isArray(existing) ? existing : [])
      .filter((guest) => guest?.slug)
      .map((guest) => [String(guest.name).trim().toLowerCase(), guest.slug]),
  );
  return String(value || "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => {
      const slug = slugs.get(name.toLowerCase());
      return slug ? { name, slug } : { name };
    });
}

export function cardStageLabel(stage) {
  return (
    {
      preparation: "Preparation",
      announced: "Announced",
      "after-event": "After event",
      done: "Done",
    }[stage] || String(stage || "")
  );
}
