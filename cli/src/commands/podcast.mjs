import { UsageError } from "../errors.mjs";
import { enc, fields, integer, isoDate, optionalString, positional, table } from "../format.mjs";
import { apiFor } from "../session.mjs";

export const summary = "Plan podcast episodes and create their Cards";

export const STATUSES = ["booked", "recorded", "edited", "scheduled", "published", "cancelled"];
const LINK_KINDS = ["youtube", "spotify", "apple", "anchor", "website"];

export const help = `dataops podcast - the podcast episode register (the web Operations > Podcast view)

Usage
  dataops podcast list [--season N] [--status S] [--card <card-id>] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
  dataops podcast show <episode-id>
  dataops podcast create [--title T] [--guests "Name[:slug],Name"] [--season N] [--episode N]
      [--recording-date YYYY-MM-DD] [--release-date YYYY-MM-DD] [--status S]
      [--youtube URL] [--spotify URL] [--apple URL] [--anchor URL] [--website URL]
      [--slug website-slug] [--card ID] [--notes TEXT]
                                  --status defaults to booked; a title or a guest is required
  dataops podcast update <episode-id> [same flags as create]
                                  "none" clears a date, link, slug, card, notes or episode number
  dataops podcast create-card <episode-id>
                                  Create the episode Card from the podcast Template and link it
                                  (the episode needs a recording date)

Statuses: ${STATUSES.join(", ")}.
--from/--to filter on the episode's release date, else its recording date.
Writes send the episode's current version; a changed episode exits 5.
An episode links at most one podcast Card; its recording date and guests are
pushed onto that Card.

Examples
  dataops podcast list --status booked
  dataops podcast create --guests "Jane Doe:jane-doe" --title "Shipping ML" --recording-date 2026-11-04
  dataops podcast update 6f1c... --status recorded
  dataops podcast create-card 6f1c...
`;

const NULLABLE = new Set(["season", "episode", "recordingDate", "releaseDate", "websiteSlug", "cardId", "notes", "title"]);

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
  body[key] = value === "none" && NULLABLE.has(key) ? null : parse(value);
}

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
  return episode;
}

export async function update(args, io) {
  const id = positional(args, 0, "dataops podcast update <episode-id> [--status S] ...");
  const { body, links } = episodeBody(args);
  if (!Object.keys(body).length && !Object.keys(links).length) {
    throw new UsageError("Nothing to change. See `dataops podcast --help`.");
  }
  const api = apiFor(args);
  const current = await api.get(`/api/podcast-episodes/${enc(id)}`);
  if (Object.keys(links).length) {
    const merged = { ...(current.links || {}), ...links };
    body.links = Object.fromEntries(Object.entries(merged).filter(([, value]) => value));
  }
  const episode = await api.put(`/api/podcast-episodes/${enc(id)}`, { ...body, version: current.version });
  if (args.json) return episode;
  io.print(`Updated episode ${episode.id}: ${describe(episode)} [${episode.status}]${episode.cardId ? `, Card ${episode.cardId}` : ""}.`);
  if (episode.cardSync === "failed") io.print("The linked Card did not take the new date or guests; update it with `dataops cards update`.");
  return episode;
}

export async function createCard(args, io) {
  const id = positional(args, 0, "dataops podcast create-card <episode-id>");
  const api = apiFor(args);
  const episode = await api.get(`/api/podcast-episodes/${enc(id)}`);
  if (episode.cardId) throw new UsageError(`Episode ${id} is already linked to Card ${episode.cardId}.`);
  if (!episode.recordingDate) {
    throw new UsageError(`Episode ${id} has no recording date; set one with \`dataops podcast update ${id} --recording-date YYYY-MM-DD\`.`);
  }
  const result = await api.post(`/api/podcast-episodes/${enc(id)}/card`, { version: episode.version });
  if (args.json) return result;
  io.print(`Created Card ${result.card.id} - ${result.card.title} and linked it to episode ${id}.`);
  return result;
}

export const commands = {
  list,
  show,
  create,
  update,
  "create-card": createCard,
};
