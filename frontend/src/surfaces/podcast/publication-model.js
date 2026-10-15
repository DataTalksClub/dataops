// Publication facts as the podcast page reads and writes them: the audio's
// local time in its timezone, what each readiness state says, the Upcoming /
// Past split of the schedule, and the form -> `publication` body. Pure
// functions over the /api/podcast-episodes records; no DOM. Readiness itself
// is derived by the API from recorded facts; nothing here infers "public".
import { isUpcoming } from "./model.js";

// Where no evidence is recorded the word is "Not recorded": the page never
// claims a definite "not scheduled" or "blocked" it cannot back.
export const SPOTIFY_LABELS = Object.freeze({
  "not-recorded": "Not recorded",
  scheduled: "Scheduled in Spotify",
  "awaiting-public-check": "Scheduled time passed, not verified",
  public: "Public on Spotify",
});

export const TRANSCRIPT_LABELS = Object.freeze({
  "not-recorded": "Not recorded",
  reviewed: "Reviewed",
});

export const WEBSITE_LABELS = Object.freeze({
  "not-recorded": "Not recorded",
  ready: "Ready to release",
  released: "Released",
  "observed-live": "Seen live (historical)",
});

const NO_READINESS = Object.freeze({
  spotify: "not-recorded",
  transcript: "not-recorded",
  website: "not-recorded",
  websiteGate: Object.freeze({ met: false, missing: Object.freeze([]) }),
  scheduledLocalDate: null,
});

export function readinessOf(episode) {
  return episode?.readiness || NO_READINESS;
}

function zonedParts(utcMs, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const part = (type) => Number(parts.find((entry) => entry.type === type)?.value);
  return {
    year: part("year"), month: part("month"), day: part("day"),
    hour: part("hour"), minute: part("minute"), second: part("second"),
  };
}

function offsetMs(utcMs, timezone) {
  const p = zonedParts(utcMs, timezone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(utcMs / 1000) * 1000;
}

export function isValidTimezone(timezone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return Boolean(timezone);
  } catch {
    return false;
  }
}

/** "2026-11-20T06:00" read on the wall clock of `timezone`, as a UTC ISO instant. */
export function zonedLocalToUtc(local, timezone) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(local || ""));
  if (!match || !isValidTimezone(timezone)) return "";
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let utc = wall - offsetMs(wall, timezone);
  utc = wall - offsetMs(utc, timezone);
  const result = new Date(utc);
  const back = zonedParts(utc, timezone);
  // A wall time skipped by a clock change does not exist.
  if (back.hour !== hour || back.minute !== minute || back.day !== day) return "";
  return result.toISOString();
}

/** A UTC instant as the "YYYY-MM-DDTHH:mm" a datetime-local input holds. */
export function utcToZonedLocal(instant, timezone) {
  if (!instant || !isValidTimezone(timezone)) return "";
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) return "";
  const p = zonedParts(ms, timezone);
  const two = (value) => String(value).padStart(2, "0");
  return `${p.year}-${two(p.month)}-${two(p.day)}T${two(p.hour)}:${two(p.minute)}`;
}

/** "Fri, 20 Nov 2026, 06:00 CET (Europe/Berlin)" in the evidenced schedule's own timezone. */
export function formatPublicationTime(publication) {
  const instant = publication?.audioSchedule?.scheduledAt;
  const timezone = publication?.audioSchedule?.timezone;
  if (!instant || !isValidTimezone(timezone)) return "";
  const formatted = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).format(new Date(instant));
  // Short zone names are ambiguous ("GMT+9"); the IANA name settles it.
  return `${formatted} (${timezone})`;
}

function scheduledMs(episode) {
  const value = Date.parse(episode?.publication?.audioSchedule?.scheduledAt || "");
  return Number.isNaN(value) ? null : value;
}

const hasFacts = (episode) =>
  Boolean(episode?.publication && Object.keys(episode.publication).length);

/**
 * The schedule: Upcoming is everything still on its way to being public and on
 * the website (soonest evidenced Spotify time first, then by intended release
 * date); Past is everything whose page is out plus historical episodes with no
 * recorded publication evidence (newest first). Cancelled episodes are left out.
 */
export function scheduleGroups(episodes) {
  const upcoming = [];
  const past = [];
  for (const episode of Array.isArray(episodes) ? episodes : []) {
    if (episode?.status === "cancelled") continue;
    const website = readinessOf(episode).website;
    const released = website === "released" || website === "observed-live";
    if (!released && (isUpcoming(episode) || hasFacts(episode))) upcoming.push(episode);
    else past.push(episode);
  }
  // One date per episode orders the list: the evidenced Spotify time when there
  // is one, else the intended release, else the recording.
  const when = (episode) => {
    const ms = scheduledMs(episode);
    return ms === null ? `${episode.releaseDate || episode.recordingDate || "9999"}` : new Date(ms).toISOString();
  };
  upcoming.sort((a, b) => when(a).localeCompare(when(b)) || String(a.id).localeCompare(String(b.id)));
  past.sort((a, b) => when(b).localeCompare(when(a)) || String(a.id).localeCompare(String(b.id)));
  return [
    { id: "upcoming", label: "Upcoming", episodes: upcoming },
    { id: "past", label: "Past", episodes: past },
  ];
}

/** Proof links recorded on an episode, in the order they happen. */
export function proofLinks(episode) {
  const publication = episode?.publication || {};
  return [
    ["schedule", "Spotify schedule", publication.audioSchedule?.proofUrl],
    ["spotify", "Spotify episode", publication.spotify?.episodeUrl],
    ["transcript", "Transcript review", publication.transcript?.proofUrl],
    ["website", "Website page", publication.website?.proofUrl],
    ["observed", "Website (seen live)", publication.websiteObserved?.proofUrl],
  ]
    .filter(([, , url]) => url)
    .map(([id, label, url]) => ({ id, label, url }));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((name) => [name, canonical(value[name])]));
  }
  return value;
}

export const samePublication = (a, b) =>
  JSON.stringify(canonical(a || null)) === JSON.stringify(canonical(b || null));

/**
 * Form values -> the `publication` PUT body (or null when nothing is recorded).
 * Observation times already on the record are kept; a newly recorded fact is
 * stamped `nowIso`. Returns { value } or { error } for what the form can catch.
 */
export function buildPublication(previous, values, nowIso) {
  const text = (name) => String(values[name] ?? "").trim();
  const prior = previous || {};
  const out = {};
  const timezone = text("timezone");
  const local = text("audioScheduledLocal");
  if (local || timezone) {
    if (!local || !timezone) return { error: "Spotify scheduling needs both the scheduled time and its timezone." };
    if (!isValidTimezone(timezone)) return { error: "Timezone must be an IANA name such as Europe/Berlin." };
    const before = prior.audioSchedule;
    const unchanged = before && before.timezone === timezone && utcToZonedLocal(before.scheduledAt, timezone) === local;
    const scheduledAt = unchanged ? before.scheduledAt : zonedLocalToUtc(local, timezone);
    if (!scheduledAt) return { error: "That scheduled time does not exist in the chosen timezone." };
    out.audioSchedule = { scheduledAt, timezone, observedAt: unchanged ? before.observedAt : nowIso };
    if (text("scheduleProofUrl")) out.audioSchedule.proofUrl = text("scheduleProofUrl");
  } else if (text("scheduleProofUrl")) {
    return { error: "Add the scheduled time and timezone that the Spotify schedule proof shows." };
  }
  if (values.spotifyVerified) {
    const url = text("spotifyUrl");
    if (!url) return { error: "Add the public Spotify episode link you verified." };
    out.spotify = {
      publicVerifiedAt: prior.spotify?.episodeUrl === url ? prior.spotify.publicVerifiedAt : nowIso,
      episodeUrl: url,
    };
  }
  if (values.transcriptReviewed) {
    const proof = text("transcriptUrl");
    if (!proof) return { error: "Add a proof link for the transcript review." };
    out.transcript = {
      reviewedAt: prior.transcript?.proofUrl === proof ? prior.transcript.reviewedAt : nowIso,
      proofUrl: proof,
    };
  }
  const releaseUrl = text("websiteUrl");
  if (releaseUrl) {
    out.website = {
      releasedAt: prior.website?.proofUrl === releaseUrl ? prior.website.releasedAt : nowIso,
      proofUrl: releaseUrl,
    };
  }
  const liveUrl = text("websiteObservedUrl");
  if (liveUrl) {
    out.websiteObserved = {
      observedAt: prior.websiteObserved?.proofUrl === liveUrl ? prior.websiteObserved.observedAt : nowIso,
      proofUrl: liveUrl,
    };
  }
  return { value: Object.keys(out).length ? out : null };
}

/** Form field defaults for an episode's recorded publication. */
export function publicationFormValues(episode) {
  const publication = episode?.publication || {};
  const schedule = publication.audioSchedule;
  return {
    timezone: schedule?.timezone || "",
    audioScheduledLocal: schedule ? utcToZonedLocal(schedule.scheduledAt, schedule.timezone) : "",
    scheduleProofUrl: schedule?.proofUrl || "",
    spotifyVerified: Boolean(publication.spotify),
    spotifyUrl: publication.spotify?.episodeUrl || "",
    transcriptReviewed: Boolean(publication.transcript),
    transcriptUrl: publication.transcript?.proofUrl || "",
    websiteUrl: publication.website?.proofUrl || "",
    websiteObservedUrl: publication.websiteObserved?.proofUrl || "",
  };
}

/**
 * Why a status cannot be entered yet, or "". Mirrors the API's gate: published
 * needs the verified public Spotify episode, scheduled needs Spotify
 * scheduling evidence. Scheduled audio and an intended date never count.
 */
export function statusGateHint(status, publication) {
  if (status === "published" && !publication?.spotify?.publicVerifiedAt) {
    return "Record a verified public Spotify episode first.";
  }
  if (status === "scheduled" && !publication?.audioSchedule) {
    return "Record the Spotify scheduling evidence first.";
  }
  return "";
}
