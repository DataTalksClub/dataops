import { UsageError } from "../errors.mjs";
import { readFileSync } from "node:fs";
import { enc, fields, integer, isoDate, optionalString, positional, table } from "../format.mjs";
import { apiFor } from "../session.mjs";
import { domainDocCommand } from "./sponsorDocs.mjs";

export const summary = "Plan podcast episodes and create their Cards";

export const STATUSES = ["booked", "recorded", "edited", "scheduled", "published", "cancelled"];
const LINK_KINDS = ["youtube", "spotify", "apple", "anchor", "website"];

export const help = `dataops podcast - the podcast episode register (the web Operations > Podcast view)

Usage
  dataops podcast list [--season N] [--status S] [--card <card-id>] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
  dataops podcast show <episode-id>
  dataops podcast invite --guest "Full Name" --email guest@example.com --date YYYY-MM-DD --topic TOPIC
      [--title T] [--window midday|evening] [--duration N] [--form-url URL]
                                   First contact: tentative Google "(Proposal)"
                                   hold for one slot, a standalone follow-up
                                   Task (no Card), and the send-ready email
                                   from orin@ (one slot, form link, no invent-
                                   alternate ask). Midday 12:30–13:30 by default;
                                   evening 17:00–18:00 (workshop 12:00/16:30+90
                                   never used for podcasts). Send from Orin's
                                   mailbox; nothing is mailed automatically.
  dataops podcast schedule [--season N] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
                                  Publication schedule: audio time and timezone, Spotify
                                  public check, transcript review, website readiness
  dataops podcast create [--title T] [--guests "Name[:slug],Name"] [--season N] [--episode N]
      [--recording-date YYYY-MM-DD] [--release-date YYYY-MM-DD] [--status S]
      [--youtube URL] [--spotify URL] [--apple URL] [--anchor URL] [--website URL]
      [--slug website-slug] [--card ID] [--notes TEXT]
      [--short T] [--description T] [--intro T] [--topics "a,b"] [--duration PT..]
      [--image-url URL] [--transcript-file F] [--clips-file F] [--resources-file F]
                                  --status defaults to booked; a title or a guest is required
                                   --title is the intended episode topic: set it at invite time
                                   omit --recording-date to auto-pick the next free recording
                                   slot (prefer midday ~12:30 Europe/Berlin, else evening ~17:00;
                                   not the workshop 16:30 window). Occupancy: CalendarHolds +
                                   episodes + event Cards. Pass --recording-date to override.
  dataops podcast update <episode-id> [same flags as create]
                                  "none" clears a date, link, slug, card, notes or episode number
                                  Page content (what the website page renders):
      --short TEXT --description TEXT --intro TEXT --topics "a,b,c"
      --duration PT1H2M3S --image-url https://...
      --transcript-file transcript.json --clips-file clips.json
      --resources-file resources.json
                                  JSON files hold the website front-matter arrays;
                                  "none" clears one
  dataops podcast create-card <episode-id>
                                   Create the episode Card from the podcast Template and link it.
                                   If the episode has no recording date, auto-picks the next free
                                   recording slot (same preference as create) then creates the Card
  dataops podcast doc create <card-id> [--sponsor NAME] [--date YYYY-MM-DD] [--email]
                                   Create the portal sponsor content document for the
                                   podcast Card (or episode), link it on the Card's
                                   "Sponsorship document" field, and print the shareable
                                   link with the access code
  dataops podcast doc show <doc-id>
  dataops podcast doc export <doc-id>
  dataops podcast doc delete <doc-id> --yes
  dataops podcast next-slot [--count N]
                                   Next free release slots and the next season/episode
                                   number (stacking rule: next free Friday 19:00
                                   Europe/Berlin, 9 episodes per season)
  dataops podcast next-recording-slot [--count N]
                                   Next free recording windows (prefer midday ~12:30
                                   Europe/Berlin, else evening ~17:00 Mon/Tue; not
                                   workshop 16:30). Occupancy: CalendarHolds + episodes
                                   + event Cards
  dataops podcast cadence [--weekday N] [--time HH:MM] [--timezone TZ]
                          [--episodes-per-season N]
                                   Show the release cadence, or set it (admin)

Statuses: ${STATUSES.join(", ")}.
Publication evidence is recorded with update flags; each observation is stamped now:
  --spotify-schedule "2026-11-20T06:00:00+01:00" --timezone Europe/Berlin [--schedule-proof URL]
  --spotify-verified https://open.spotify.com/episode/...   public episode played
  --transcript-reviewed PROOF_URL                           review proof is required
  --website-released PAGE_URL      the released page
  --website-observed PAGE_URL      a page already seen live
  "none" clears one of them. --release-date is the intended release, not Spotify evidence.
Recording --spotify-schedule also times the Card's Spotify verification Task to
that instant (downstream Tasks chained after it with template depends_on follow
through task rescheduling); clearing the schedule puts the Task back in the queue.
Unrecorded evidence shows as not-recorded, never as a definite no.
--from/--to filter on the episode's release date, else its recording date.
Writes send the episode's current version; a changed episode exits 5.
An episode links at most one podcast Card; its recording date and guests are
pushed onto that Card, and ticking the Card's recording, audio edit, Spotify
scheduling and Spotify verification Tasks moves the episode to recorded,
edited, scheduled and published. --status corrects or cancels an episode.

Examples
  dataops podcast list --status booked
  dataops podcast invite --guest "Sofiia" --email sofiia@example.com --date 2026-11-04 --topic "LLM evals in production"
  dataops podcast create --guests "Jane Doe:jane-doe" --title "Shipping ML" --recording-date 2026-11-04
  dataops podcast update 6f1c... --status cancelled
  dataops podcast create-card 6f1c...
  dataops podcast doc create <card-id> --sponsor "Acme AI" --email
`;

const NULLABLE = new Set(["season", "episode", "recordingDate", "releaseDate", "websiteSlug", "cardId", "notes", "title", "short", "description", "intro", "topics", "duration", "imageUrl", "transcript", "clips", "resources"]);

/** "Jane Doe:jane-doe, Bob" -> [{ name: "Jane Doe", slug: "jane-doe" }, { name: "Bob" }] */
export function parseGuests(value) {
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const separator = item.lastIndexOf(":");
      if (separator <= 0) return { name: item };
      return { name: item.slice(0, separator).trim(), slug: item.slice(separator + 1).trim() };
    });
}

function nullable(args, flag, key, body, parse = (value) => value) {
  const value = optionalString(args, flag);
  if (value === undefined) return;
  body[key] = value === "none" && NULLABLE.has(key) ? null : parse(value, flag);
}

const jsonFile = (value, flag) => {
  try {
    return JSON.parse(readFileSync(value, "utf8"));
  } catch {
    throw new UsageError(`--${flag} must be a readable JSON file.`);
  }
};

function episodeBody(args) {
  const body = {};
  nullable(args, "title", "title", body);
  nullable(args, "season", "season", body, (value) => integer(value, "season"));
  nullable(args, "episode", "episode", body, (value) => integer(value, "episode"));
  nullable(args, "recordingDate", "recordingDate", body, (value) => isoDate(value, "recording-date"));
  nullable(args, "releaseDate", "releaseDate", body, (value) => isoDate(value, "release-date"));
  nullable(args, "slug", "websiteSlug", body);
  nullable(args, "card", "cardId", body);
  nullable(args, "notes", "notes", body);
  nullable(args, "short", "short", body);
  nullable(args, "description", "description", body);
  nullable(args, "intro", "intro", body);
  nullable(args, "topics", "topics", body, (value) =>
    value.split(",").map((topic) => topic.trim()).filter(Boolean),
  );
  nullable(args, "duration", "duration", body);
  nullable(args, "imageUrl", "imageUrl", body);
  nullable(args, "transcriptFile", "transcript", body, jsonFile);
  nullable(args, "clipsFile", "clips", body, jsonFile);
  nullable(args, "resourcesFile", "resources", body, jsonFile);
  const status = optionalString(args, "status");
  if (status !== undefined) {
    if (!STATUSES.includes(status)) throw new UsageError(`--status must be one of: ${STATUSES.join(", ")}.`);
    body.status = status;
  }
  const guests = optionalString(args, "guests");
  if (guests !== undefined) body.guests = guests === "none" ? [] : parseGuests(guests);
  const links = {};
  for (const kind of LINK_KINDS) {
    const value = optionalString(args, kind);
    if (value !== undefined) links[kind] = value === "none" ? null : value;
  }
  return { body, links };
}

/** S25E3, S25, or "" for an unnumbered episode. */
export function episodeCode(episode) {
  if (!episode.season) return "";
  return `S${episode.season}${episode.episode ? `E${episode.episode}` : ""}`;
}

function guestNames(episode) {
  return (episode.guests || []).map((guest) => guest.name).join(", ");
}

function describe(episode) {
  const code = episodeCode(episode);
  const who = guestNames(episode);
  return [code, who, episode.title].filter(Boolean).join(" - ");
}

export async function list(args, io) {
  const status = optionalString(args, "status");
  if (status !== undefined && !STATUSES.includes(status)) throw new UsageError(`--status must be one of: ${STATUSES.join(", ")}.`);
  const query = {
    season: args.season === undefined ? undefined : integer(args.season, "season"),
    status,
    cardId: optionalString(args, "card"),
    from: isoDate(args.from, "from"),
    to: isoDate(args.to, "to"),
  };
  const result = await apiFor(args).get("/api/podcast-episodes", { query });
  if (args.json) return result;
  table(io, result.items || [], [
    ["ID", (episode) => episode.id],
    ["EPISODE", (episode) => episodeCode(episode)],
    ["STATUS", (episode) => episode.status],
    ["RECORDING", (episode) => episode.recordingDate || ""],
    ["RELEASE", (episode) => episode.releaseDate || ""],
    ["CARD", (episode) => episode.cardId || ""],
    ["GUESTS / TITLE", (episode) => [guestNames(episode), episode.title].filter(Boolean).join(" - ")],
  ], "No podcast episodes match.");
  return result;
}

/** "2026-11-20T05:00:00.000Z Europe/Berlin" or "". */
function scheduledAt(episode) {
  const schedule = episode.publication?.audioSchedule;
  return schedule ? `${schedule.scheduledAt} ${schedule.timezone}` : "";
}

const PUBLICATION_FLAGS = ["spotifySchedule", "timezone", "scheduleProof", "spotifyVerified", "transcriptReviewed", "websiteReleased", "websiteObserved"];

/**
 * The `publication` body after applying the evidence flags to the current one,
 * or undefined when no flag was given. An observation keeps its recorded time
 * while its proof link is unchanged.
 */
export function publicationFromFlags(args, current, nowIso) {
  const given = Object.fromEntries(
    PUBLICATION_FLAGS.map((flag) => [flag, optionalString(args, flag)]).filter(([, value]) => value !== undefined),
  );
  if (!Object.keys(given).length) return undefined;
  const next = { ...(current || {}) };
  const clears = (flag) => given[flag] === "none";
  if (given.spotifySchedule !== undefined || given.timezone !== undefined || given.scheduleProof !== undefined) {
    if (clears("spotifySchedule")) delete next.audioSchedule;
    else {
      const before = next.audioSchedule || {};
      const scheduledAt = given.spotifySchedule ?? before.scheduledAt;
      const timezone = given.timezone ?? before.timezone;
      if (!scheduledAt || !timezone) throw new UsageError("--spotify-schedule and --timezone are given together.");
      if (Number.isNaN(Date.parse(scheduledAt))) throw new UsageError("--spotify-schedule must be an ISO time with an offset.");
      const same = before.scheduledAt && Date.parse(before.scheduledAt) === Date.parse(scheduledAt) && before.timezone === timezone;
      next.audioSchedule = { scheduledAt: new Date(scheduledAt).toISOString(), timezone, observedAt: same ? before.observedAt : nowIso };
      const proof = given.scheduleProof === "none" ? undefined : (given.scheduleProof ?? before.proofUrl);
      if (proof) next.audioSchedule.proofUrl = proof;
    }
  }
  const observation = (flag, key, timeKey, url) => {
    if (given[flag] === undefined) return;
    if (clears(flag)) delete next[key];
    else next[key] = { [timeKey]: next[key]?.[url] === given[flag] ? next[key][timeKey] : nowIso, [url]: given[flag] };
  };
  observation("spotifyVerified", "spotify", "publicVerifiedAt", "episodeUrl");
  observation("transcriptReviewed", "transcript", "reviewedAt", "proofUrl");
  observation("websiteReleased", "website", "releasedAt", "proofUrl");
  observation("websiteObserved", "websiteObserved", "observedAt", "proofUrl");
  return Object.keys(next).length ? next : null;
}

export async function schedule(args, io) {
  const query = {
    season: args.season === undefined ? undefined : integer(args.season, "season"),
    from: isoDate(args.from, "from"),
    to: isoDate(args.to, "to"),
  };
  const api = apiFor(args);
  const result = await api.get("/api/podcast-episodes", { query });
  const items = (result.items || []).filter((episode) => episode.status !== "cancelled");
  const free = await api.get("/api/podcast-episodes/next-slot", { query: { count: "4" } }).catch(() => null);
  if (args.json) return free ? { items, nextSlot: free } : { items };
  table(io, items, [
    ["ID", (episode) => episode.id],
    ["EPISODE", (episode) => episodeCode(episode)],
    ["AUDIO", (episode) => scheduledAt(episode) || episode.releaseDate || ""],
    ["SPOTIFY", (episode) => episode.readiness?.spotify || ""],
    ["TRANSCRIPT", (episode) => episode.readiness?.transcript || ""],
    ["WEBSITE", (episode) => episode.readiness?.website || ""],
    ["CARD", (episode) => episode.cardId || ""],
  ], "No podcast episodes match.");
  if (free) {
    io.print(`Next free slot: ${free.slots?.[0] ? `${free.slots[0].date} ${free.slots[0].localTime} ${free.slots[0].timezone} (${free.slots[0].utcInstant})` : "none in range"} as ${free.code}.`);
  }
  return free ? { items, nextSlot: free } : { items };
}

export async function show(args, io) {
  const id = positional(args, 0, "dataops podcast show <episode-id>");
  const episode = await apiFor(args).get(`/api/podcast-episodes/${enc(id)}`);
  if (args.json) return episode;
  fields(io, [
    ["id", episode.id],
    ["episode", episodeCode(episode)],
    ["title", episode.title],
    ["guests", (episode.guests || []).map((guest) => (guest.slug ? `${guest.name} (${guest.slug})` : guest.name))],
    ["status", episode.status],
    ["recordingDate", episode.recordingDate],
    ["releaseDate", episode.releaseDate],
    ...Object.entries(episode.links || {}),
    ["websiteSlug", episode.websiteSlug],
    ["short", episode.short],
    ["description", episode.description],
    ["topics", (episode.topics || []).join(", ")],
    ["duration", episode.duration],
    ["image", episode.imageUrl],
    ["intro", episode.intro ? `${episode.intro.length} chars` : ""],
    ["page transcript", `${(episode.transcript || []).length} entries`],
    ["clips", `${(episode.clips || []).length} clips`],
    ["resources", `${(episode.resources || []).length} resources`],
    ["spotify schedule", scheduledAt(episode)],
    ["spotify", episode.readiness?.spotify],
    ["transcript", episode.readiness?.transcript],
    ["website", episode.readiness?.website],
    ["cardId", episode.cardId],
    ["notes", episode.notes],
    ["version", episode.version],
  ]);
  if (episode.card) {
    io.print(`card: ${episode.card.title} [${episode.card.stage}] ${episode.card.openTaskCount}/${episode.card.taskCount} Tasks open`);
  }
  return episode;
}

export async function create(args, io) {
  const { body, links } = episodeBody(args);
  const setLinks = Object.fromEntries(Object.entries(links).filter(([, value]) => value));
  if (Object.keys(setLinks).length) body.links = setLinks;
  if (!body.title && !body.guests?.length) throw new UsageError("--title or --guests is required.");
  body.status = body.status || "booked";
  for (const [key, value] of Object.entries(body)) if (value === null) delete body[key];
  const episode = await apiFor(args).post("/api/podcast-episodes", body);
  if (args.json) return episode;
  io.print(`Created episode ${episode.id}: ${describe(episode)} [${episode.status}].`);
  if (episode.recordingDateAutoSelected && episode.recordingSlot) {
    const slot = episode.recordingSlot;
    io.print(`Auto-selected recording slot: ${slot.label} (override with --recording-date).`);
  }
  return episode;
}

export async function update(args, io) {
  const id = positional(args, 0, "dataops podcast update <episode-id> [--status S] ...");
  const { body, links } = episodeBody(args);
  const hasPublicationFlag = PUBLICATION_FLAGS.some((flag) => optionalString(args, flag) !== undefined);
  if (!Object.keys(body).length && !Object.keys(links).length && !hasPublicationFlag) {
    throw new UsageError("Nothing to change. See `dataops podcast --help`.");
  }
  const api = apiFor(args);
  const current = await api.get(`/api/podcast-episodes/${enc(id)}`);
  const publication = publicationFromFlags(args, current.publication, new Date().toISOString());
  if (publication !== undefined) body.publication = publication;
  if (Object.keys(links).length) {
    const merged = { ...(current.links || {}), ...links };
    body.links = Object.fromEntries(Object.entries(merged).filter(([, value]) => value));
  }
  const episode = await api.put(`/api/podcast-episodes/${enc(id)}`, { ...body, version: current.version });
  if (args.json) return episode;
  io.print(`Updated episode ${episode.id}: ${describe(episode)} [${episode.status}]${episode.cardId ? `, Card ${episode.cardId}` : ""}.`);
  if (episode.cardSync === "failed") io.print("The linked Card did not take the new date or guests; update it with `dataops cards update`.");
  if (episode.scheduleSync?.notBeforeAt) {
    io.print(`Verify Task ${episode.scheduleSync.taskId} now surfaces at ${episode.scheduleSync.notBeforeAt}.`);
  } else if (episode.scheduleSync && episode.scheduleSync.notBeforeAt === null) {
    io.print(`Verify Task ${episode.scheduleSync.taskId} is back in the queue (schedule removed).`);
  }
  return episode;
}

export async function createCard(args, io) {
  const id = positional(args, 0, "dataops podcast create-card <episode-id>");
  const api = apiFor(args);
  const episode = await api.get(`/api/podcast-episodes/${enc(id)}`);
  if (episode.cardId) throw new UsageError(`Episode ${id} is already linked to Card ${episode.cardId}.`);
  const result = await api.post(`/api/podcast-episodes/${enc(id)}/card`, { version: episode.version });
  if (args.json) return result;
  if (result.recordingDateAutoSelected && result.recordingSlot) {
    io.print(`Auto-selected recording slot: ${result.recordingSlot.label} before creating the Card.`);
  }
  io.print(`Created Card ${result.card.id} - ${result.card.title} and linked it to episode ${id}.`);
  return result;
}

const WEEKDAY_NAMES = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function describeCadence(cadence) {
  const day = WEEKDAY_NAMES[cadence.weekday] || `day ${cadence.weekday}`;
  return `${day} ${cadence.time} ${cadence.timezone}`;
}

/** Next free release slots with the next season/episode number (the SOP stacking rule). */
export async function nextSlot(args, io) {
  const count = args.count === undefined ? 4 : integer(args.count, "count");
  if (count < 1 || count > 52) throw new UsageError("--count must be 1 to 52.");
  const result = await apiFor(args).get("/api/podcast-episodes/next-slot", { query: { count: String(count) } });
  if (args.json) return result;
  io.print(`Next episode: ${result.code} (season ${result.season}, episode ${result.episode}; ${result.episodesPerSeason} per season)`);
  io.print(`Cadence: ${describeCadence(result.cadence)}`);
  table(io, result.slots || [], [
    ["DATE", (slot) => slot.date],
    ["LOCAL", (slot) => `${slot.localTime} ${slot.timezone}`],
    ["UTC", (slot) => slot.utcInstant],
  ], "No free slots in range.");
  if ((result.takenDates || []).length) io.print(`Taken: ${result.takenDates.join(", ")}`);
  const first = (result.slots || [])[0];
  if (first) io.print(`To book one: dataops podcast update <episode-id> --season ${result.season} --episode ${result.episode} --release-date ${first.date}`);
  return result;
}

/** Next free recording windows (midday preferred; evening ~17:00 fallback). */
export async function nextRecordingSlot(args, io) {
  const count = args.count === undefined ? 4 : integer(args.count, "count");
  if (count < 1 || count > 52) throw new UsageError("--count must be 1 to 52.");
  const result = await apiFor(args).get("/api/podcast-episodes/next-recording-slot", { query: { count: String(count) } });
  if (args.json) return result;
  io.print(`Recording slot preference: midday ~12:30 Europe/Berlin, else evening ~17:00 (not workshop 16:30).`);
  table(io, result.slots || [], [
    ["DATE", (slot) => slot.date],
    ["WINDOW", (slot) => slot.window],
    ["LOCAL", (slot) => `${slot.localTime} ${slot.timezone}`],
    ["LABEL", (slot) => slot.label],
  ], "No free recording slots in range.");
  if ((result.takenDates || []).length) io.print(`Taken recording dates: ${result.takenDates.slice(0, 12).join(", ")}${result.takenDates.length > 12 ? "…" : ""}`);
  const first = (result.slots || [])[0];
  if (first) io.print(`To book one: dataops podcast create --guests "Name" --title "Topic" --recording-date ${first.date}`);
  return result;
}

function parseWeekday(raw) {
  const names = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 };
  const key = String(raw).trim().toLowerCase().slice(0, 3);
  if (names[key] !== undefined && !/^\d+$/.test(String(raw).trim())) return names[key];
  return integer(raw, "weekday");
}

/** Show the release cadence, or set it (admin). */
export async function cadence(args, io) {
  const api = apiFor(args);
  const current = await api.get("/api/workspace-settings");
  const hasChange = args.weekday !== undefined || args.time !== undefined || args.timezone !== undefined || args.episodesPerSeason !== undefined;
  if (!hasChange) {
    if (args.json) return { podcastReleaseCadence: current.podcastReleaseCadence, podcastEpisodesPerSeason: current.podcastEpisodesPerSeason, version: current.version };
    io.print(`Release cadence: ${describeCadence(current.podcastReleaseCadence)} (${current.podcastEpisodesPerSeason} episodes per season).`);
    return current;
  }
  const cadenceValue = { ...(current.podcastReleaseCadence || {}) };
  if (args.weekday !== undefined) cadenceValue.weekday = parseWeekday(args.weekday);
  if (args.time !== undefined) cadenceValue.time = String(args.time);
  if (args.timezone !== undefined) cadenceValue.timezone = String(args.timezone);
  const body = { expectedVersion: current.version };
  if (args.weekday !== undefined || args.time !== undefined || args.timezone !== undefined) {
    if (!Number.isInteger(cadenceValue.weekday) || cadenceValue.weekday < 1 || cadenceValue.weekday > 7) {
      throw new UsageError("--weekday must be 1 (Monday) to 7 (Sunday), or Mon..Sun.");
    }
    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(cadenceValue.time || "")) throw new UsageError("--time must be HH:MM (24h).");
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: cadenceValue.timezone });
    } catch {
      throw new UsageError("--timezone must be an IANA timezone (for example Europe/Berlin).");
    }
    body.podcastReleaseCadence = cadenceValue;
  }
  if (args.episodesPerSeason !== undefined) {
    const perSeason = integer(args.episodesPerSeason, "episodes-per-season");
    if (perSeason < 1 || perSeason > 99) throw new UsageError("--episodes-per-season must be 1 to 99.");
    body.podcastEpisodesPerSeason = perSeason;
  }
  const result = await api.put("/api/workspace-settings", body);
  if (args.json) return result;
  io.print(`Release cadence is now ${describeCadence(result.podcastReleaseCadence)} (${result.podcastEpisodesPerSeason} episodes per season).`);
  return result;
}

export const doc = domainDocCommand("podcast");

export const PODCAST_DOCS_URL = "https://datatalksclub.github.io/docs/activities/podcast/";
export const PODCAST_FIRST_CONTACT_FROM = "orin@datatalks.club";

/** Berlin wall-clock label for a hold instant, mirroring the backend renderer. */
export function formatInviteSlotLabel(startIso) {
  const instant = Date.parse(startIso);
  if (Number.isNaN(instant)) throw new UsageError("--date must be a real calendar date.");
  const date = new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "Europe/Berlin",
  }).format(new Date(instant));
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Europe/Berlin",
    timeZoneName: "short",
  }).format(new Date(instant));
  return `${date} at ${time}`;
}

/**
 * First contact for a podcast guest (Orin's ask).
 *
 * One command, three DataOps writes, zero Cards:
 *  1. POST /api/calendar-holds — tentative hold; the backend mirrors it as a
 *     Google "(Proposal)" event (or reports Google sync deferred).
 *  2. POST /api/tasks — standalone follow-up Task (no cardId): the Task half
 *     of the Task+template pair. No draft Card is created; the episode Card
 *     comes only after the recording date is confirmed (create-card).
 *  3. POST /api/podcast-first-contact/email — the template half: send-ready
 *     copy from orin@ with exactly one proposed slot, no topic ask, and the
 *     public podcast docs page link.
 *
 * The operator sends the printed email from Orin's mailbox; DataOps never
 * mails the guest automatically (hold expiry says so explicitly too).
 */
export async function invite(args, io) {
  const guest = optionalString(args, "guest");
  if (!guest) throw new UsageError('Usage: dataops podcast invite --guest "Full Name" --email guest@example.com --date YYYY-MM-DD --topic TOPIC [--title T] [--window midday|evening] [--duration N] [--form-url URL].');
  const email = optionalString(args, "email");
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new UsageError("A guest --email address is required so the follow-up Task names its recipient.");
  }
  const date = optionalString(args, "date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new UsageError("--date must be YYYY-MM-DD.");
  }
  const topic = optionalString(args, "topic");
  if (!topic) throw new UsageError("A hold needs --topic: record the intended episode topic at invite time (the email itself never asks the guest for topics).");
  const window = String(args.window ?? "midday").trim().toLowerCase();
  if (window !== "evening" && window !== "midday") {
    throw new UsageError("Invalid --window for invite: must be 'midday' (default) or 'evening' (fallback ~17:00; workshops never use invite).");
  }
  const rawDuration = args.duration ?? args.durationMinutes;
  const durationMinutes = rawDuration === undefined ? 60 : Number(rawDuration);
  if (!Number.isInteger(durationMinutes) || durationMinutes <= 0) {
    throw new UsageError("--duration must be a positive integer number of minutes (podcasts use 60).");
  }
  const title = optionalString(args, "title") || `Podcast with ${guest}`;

  const api = apiFor(args);
  const holdRes = await api.post("/api/calendar-holds", {
    date,
    window,
    durationMinutes,
    title,
    topic,
    guestRef: email,
    expiresDays: 7,
  });
  const hold = holdRes.hold || holdRes;

  const task = await api.post("/api/tasks", {
    description: `Podcast first-contact to ${guest} — await reply`,
    date,
    comment: `First-contact email to ${email} for "${title}". Proposed slot ${date} (${window}); hold ${hold.id}. No Card until the recording date is confirmed.`,
    materials: [{ url: PODCAST_DOCS_URL, label: "Podcast docs page" }],
  });

  let slotLabel = `${date} (${window}, Europe/Berlin)`;
  if (hold.startIso) {
    try {
      slotLabel = formatInviteSlotLabel(hold.startIso);
    } catch {
      // Keep the date+window fallback; never fail the invite on a label.
    }
  }
  const firstName = guest.split(/\s+/)[0];
  const formUrl = optionalString(args, "form-url") || optionalString(args, "formUrl") || undefined;
  if (formUrl && !/^https:\/\//.test(formUrl)) {
    throw new UsageError("--form-url must be an https URL (guest materials share link).");
  }
  const rendered = await api.post("/api/podcast-first-contact/email", {
    guestFirstName: firstName,
    slotLabel,
    formUrl,
    topicSeed: topic,
  });

  if (args.json) return { hold, task, email: rendered };
  io.print(`Proposed hold ${hold.id}: ${hold.date} [${hold.status}] (${hold.window}, ${hold.durationMinutes} min) ${hold.title} (${hold.id})`);
  if (hold.googleSync?.state === "deferred") {
    io.print(`Google sync deferred: ${hold.googleSync.reason || "broker unavailable"}`);
  }
  io.print(`Created Task ${task.id} - ${task.description} (due ${task.date}). No Card created.`);
  io.print("");
  io.print(`From: ${rendered.from}`);
  io.print(`To: ${email}`);
  io.print(`Subject: ${rendered.subject}`);
  io.print("");
  io.print(rendered.body);
  io.print("");
  io.print(`Send the email above from Orin's mailbox (${PODCAST_FIRST_CONTACT_FROM}); nothing was mailed automatically.`);
  return { hold, task, email: rendered };
}

export const commands = {
  list,
  show,
  invite,
  schedule,
  create,
  update,
  "create-card": createCard,
  doc,
  "next-slot": nextSlot,
  "next-recording-slot": nextRecordingSlot,
  cadence,
};
