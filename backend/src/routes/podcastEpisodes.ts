/**
 * /api/podcast-episodes: the podcast episode register.
 *
 * An episode is the planning record for one podcast episode from booking to
 * publication. `episode.cardId` is the single canonical link to the Card that
 * executes it; the episode pushes its recording date and guests onto that
 * Card one way.
 */
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { LambdaEvent, LambdaResponse } from "../types";
import {
  createPodcastEpisode,
  deletePodcastEpisode,
  EPISODE_LINK_KINDS,
  EPISODE_STATUSES,
  getPodcastEpisode,
  listPodcastEpisodes,
  updatePodcastEpisode,
  type PodcastEpisode,
} from "../db/podcastEpisodes";
import { getCard } from "../db/cards";
import {
  derivePublicationReadiness,
  normalizePublication,
  statusGateError,
} from "../podcast/publication";
import { resolveInteractiveActor } from "../identity/actor";
import {
  checkCardLink,
  createLinkedCard,
  pushFieldsToCard,
  summarizeCard,
} from "../cards/recordCardLink";

const json = (statusCode: number, body: unknown): LambdaResponse => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,199}$/;
const WRITABLE = new Set([
  "season",
  "episode",
  "title",
  "guests",
  "recordingDate",
  "releaseDate",
  "status",
  "links",
  "websiteSlug",
  "scheduleSourceKey",
  "cardId",
  "notes",
  "publication",
  "version",
]);
const PODCAST_CARD_TYPES = ["podcast"];

const realDate = (value: unknown) => {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
const positive = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) > 0;
const httpsUrl = (value: unknown) => {
  try {
    return typeof value === "string" && new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

/** Validate a full episode shape (after merging a PUT onto the current one). */
function validate(body: Record<string, any>): string {
  const unknown = Object.keys(body).find((name) => !WRITABLE.has(name));
  if (unknown) return `Unknown field: ${unknown}`;
  for (const name of ["season", "episode"])
    if (body[name] != null && !positive(body[name])) return `Invalid ${name}`;
  if (
    body.title != null &&
    (typeof body.title !== "string" || !body.title.trim() || body.title.length > 300)
  )
    return "Invalid title";
  if (
    !Array.isArray(body.guests) ||
    body.guests.length > 10 ||
    !body.guests.every(
      (guest: any) =>
        guest &&
        typeof guest === "object" &&
        !Array.isArray(guest) &&
        Object.keys(guest).every((name) => ["name", "slug"].includes(name)) &&
        typeof guest.name === "string" &&
        guest.name.trim().length > 0 &&
        guest.name.length <= 200 &&
        (guest.slug === undefined || (typeof guest.slug === "string" && SLUG.test(guest.slug))),
    )
  )
    return "Invalid guests";
  if (!body.title && body.guests.length === 0)
    return "An episode needs a title or at least one guest";
  for (const name of ["recordingDate", "releaseDate"])
    if (body[name] != null && !realDate(body[name])) return `Invalid ${name}`;
  if (!EPISODE_STATUSES.includes(body.status)) return "Invalid status";
  if (body.links != null) {
    if (typeof body.links !== "object" || Array.isArray(body.links)) return "Invalid links";
    for (const [kind, url] of Object.entries(body.links))
      if (!(EPISODE_LINK_KINDS as readonly string[]).includes(kind) || !httpsUrl(url))
        return `Invalid link: ${kind}`;
  }
  if (body.websiteSlug != null && !(typeof body.websiteSlug === "string" && SLUG.test(body.websiteSlug)))
    return "Invalid websiteSlug";
  if (
    body.scheduleSourceKey != null &&
    (typeof body.scheduleSourceKey !== "string" ||
      !body.scheduleSourceKey ||
      body.scheduleSourceKey.length > 200)
  )
    return "Invalid scheduleSourceKey";
  if (body.cardId != null && !ID.test(String(body.cardId))) return "Invalid cardId";
  if (body.notes != null && (typeof body.notes !== "string" || body.notes.length > 2000))
    return "Invalid notes";
  return "";
}

/**
 * Another episode already holds this website slug, schedule row, or
 * season/episode number. Duplicates are refused, never merged.
 */
function duplicateOf(
  candidate: Partial<PodcastEpisode>,
  episodes: PodcastEpisode[],
  selfId: string | null,
) {
  for (const other of episodes) {
    if (other.id === selfId) continue;
    if (candidate.websiteSlug && other.websiteSlug === candidate.websiteSlug)
      return `websiteSlug already used by episode ${other.id}`;
    if (candidate.scheduleSourceKey && other.scheduleSourceKey === candidate.scheduleSourceKey)
      return `scheduleSourceKey already used by episode ${other.id}`;
    if (
      candidate.season != null &&
      candidate.episode != null &&
      other.season === candidate.season &&
      other.episode === candidate.episode
    )
      return `S${candidate.season}E${candidate.episode} already used by episode ${other.id}`;
  }
  return "";
}

const checkEpisodeCardLink = (
  client: DynamoDBDocumentClient,
  cardId: string,
  episodeId: string | null,
  episodes: PodcastEpisode[],
) =>
  checkCardLink(client, cardId, PODCAST_CARD_TYPES, episodeId, async (id) =>
    episodes.filter((episode) => episode.cardId === id).map((episode) => episode.id),
  );

/** The episode wins: its recording date and guests are pushed onto the Card. */
async function pushEpisodeToCard(client: DynamoDBDocumentClient, episode: PodcastEpisode) {
  try {
    await pushFieldsToCard(client, String(episode.cardId), {
      ...(episode.recordingDate ? { anchorDate: episode.recordingDate } : {}),
      ...(episode.guests.length ? { people: episode.guests.map((guest) => guest.name) } : {}),
    });
    return "synced";
  } catch (error) {
    console.error("Podcast episode card sync failed:", error);
    return "failed";
  }
}

/** The episode as every response shows it: derived readiness, never stored. */
const presented = <T extends PodcastEpisode>(episode: T) => ({
  ...episode,
  readiness: derivePublicationReadiness(episode.publication),
});

async function withCard(client: DynamoDBDocumentClient, episode: PodcastEpisode) {
  const card = episode.cardId ? await getCard(client, episode.cardId) : null;
  return { ...presented(episode), card: card ? await summarizeCard(client, card) : null };
}

/** Validate a written `publication` and normalise it in place. Returns an error text. */
function applyPublication(body: Record<string, any>, written: boolean): string {
  if (!written || body.publication == null) return "";
  const result = normalizePublication(body.publication);
  if (!result.ok) return result.error;
  body.publication = result.value;
  return "";
}

const parse = (event: LambdaEvent): Record<string, any> | null => {
  try {
    const value = event.body ? JSON.parse(String(event.body)) : {};
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
};

export async function handlePodcastEpisodeRoutes(
  path: string,
  method: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse> {
  const match = path.match(/^\/api\/podcast-episodes(?:\/([^/]+)(\/card)?)?\/?$/);
  if (!match) return json(404, { error: "Not found" });
  const [, id, cardRoute] = match;
  const resolved = await resolveInteractiveActor(
    client,
    event,
    method === "GET" ? "work-read" : "work-write",
  );
  if (!resolved.ok) return resolved.response;

  if (cardRoute) {
    if (method !== "POST") return json(405, { error: "Method not allowed" });
    return createEpisodeCard(id, event, client, resolved.actor);
  }

  if (method === "GET" && !id) {
    const query = event.queryStringParameters || {};
    for (const name of ["from", "to"] as const)
      if (query[name] !== undefined && !realDate(query[name]))
        return json(400, { error: `Invalid ${name}` });
    if (query.from && query.to && query.from > query.to)
      return json(400, { error: "Invalid range" });
    if (query.status !== undefined && !EPISODE_STATUSES.includes(query.status as any))
      return json(400, { error: "Invalid status" });
    if (query.season !== undefined && !positive(Number(query.season)))
      return json(400, { error: "Invalid season" });
    if (query.cardId !== undefined && !ID.test(query.cardId))
      return json(400, { error: "Invalid cardId" });
    const items = (await listPodcastEpisodes(client, { from: query.from, to: query.to })).filter(
      (episode) =>
        (query.status === undefined || episode.status === query.status) &&
        (query.season === undefined || episode.season === Number(query.season)) &&
        (query.cardId === undefined || episode.cardId === query.cardId),
    );
    const enriched = [];
    for (const episode of items) enriched.push(await withCard(client, episode));
    return json(200, { items: enriched });
  }

  if (method === "GET" && id) {
    const episode = await getPodcastEpisode(client, id);
    return episode ? json(200, await withCard(client, episode)) : json(404, { error: "Not found" });
  }

  const body = parse(event);
  if (!body) return json(400, { error: "Invalid JSON" });

  if (method === "POST" && !id) {
    if (Object.hasOwn(body, "version")) return json(400, { error: "version is system-owned" });
    const candidate = { guests: [], ...body } as Record<string, any>;
    const error = validate(candidate) || applyPublication(candidate, true);
    if (error) return json(400, { error });
    const gate = statusGateError(candidate.status, candidate.publication);
    if (gate) return json(422, { error: gate });
    const episodes = await listPodcastEpisodes(client);
    const duplicate = duplicateOf(candidate, episodes, null);
    if (duplicate) return json(409, { error: duplicate });
    if (candidate.cardId) {
      const link = await checkEpisodeCardLink(client, candidate.cardId, null, episodes);
      if (!link.ok) return json(link.statusCode, { error: link.error });
    }
    const created = await createPodcastEpisode(
      client,
      candidate as Parameters<typeof createPodcastEpisode>[1],
    );
    if (created.cardId)
      return json(201, { ...presented(created), cardSync: await pushEpisodeToCard(client, created) });
    return json(201, presented(created));
  }

  if (!id) return json(405, { error: "Method not allowed" });
  const existing = await getPodcastEpisode(client, id);
  if (!existing) return json(404, { error: "Not found" });
  if (body.version !== existing.version)
    return json(409, { error: "Episode changed; reload and retry" });

  if (method === "PUT") {
    const unknown = Object.keys(body).find((name) => !WRITABLE.has(name));
    if (unknown) return json(400, { error: `Unknown field: ${unknown}` });
    const { version: _version, ...changes } = body;
    const merged = Object.fromEntries(
      [...WRITABLE]
        .filter((name) => name !== "version")
        .map((name) => [name, Object.hasOwn(changes, name) ? changes[name] : (existing as any)[name]]),
    );
    const error =
      validate(merged) || applyPublication(merged, Object.hasOwn(changes, "publication"));
    if (error) return json(400, { error });
    if (Object.hasOwn(changes, "publication")) changes.publication = merged.publication;
    // Only entering a status is gated; an existing historical status stays.
    if (merged.status !== existing.status) {
      const gate = statusGateError(merged.status, merged.publication);
      if (gate) return json(422, { error: gate });
    }
    const episodes = await listPodcastEpisodes(client);
    const duplicate = duplicateOf(merged, episodes, id);
    if (duplicate) return json(409, { error: duplicate });
    const linking = changes.cardId != null && changes.cardId !== existing.cardId;
    if (linking) {
      const link = await checkEpisodeCardLink(client, changes.cardId, id, episodes);
      if (!link.ok) return json(link.statusCode, { error: link.error });
    }
    let next: PodcastEpisode;
    try {
      next = await updatePodcastEpisode(client, existing, changes);
    } catch {
      return json(409, { error: "Conflicting update" });
    }
    if (
      next.cardId &&
      (linking ||
        next.recordingDate !== existing.recordingDate ||
        JSON.stringify(next.guests) !== JSON.stringify(existing.guests))
    )
      return json(200, { ...presented(next), cardSync: await pushEpisodeToCard(client, next) });
    return json(200, presented(next));
  }

  if (method === "DELETE") {
    try {
      await deletePodcastEpisode(client, existing);
      return { statusCode: 204, headers: {}, body: "" };
    } catch {
      return json(409, { error: "Conflicting delete" });
    }
  }
  return json(405, { error: "Method not allowed" });
}

/**
 * POST /api/podcast-episodes/:id/card: create the episode's Card from the
 * podcast Template (people = guests, anchorDate = recordingDate) and link it
 * with a version-conditional episode write; a lost link discards the Card.
 */
async function createEpisodeCard(
  id: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
  actor: Parameters<typeof createLinkedCard>[1],
) {
  const body = parse(event);
  if (!body) return json(400, { error: "Invalid JSON" });
  const episode = await getPodcastEpisode(client, id);
  if (!episode) return json(404, { error: "Not found" });
  if (body.version !== undefined && body.version !== episode.version)
    return json(409, { error: "Episode changed; reload and retry" });
  if (episode.cardId)
    return json(409, { error: "Episode already has a Card", cardId: episode.cardId });
  if (!episode.recordingDate)
    return json(422, { error: "Episode needs a recordingDate before it gets a Card" });
  const guests = episode.guests.map((guest) => guest.name);
  let linked: PodcastEpisode | null = null;
  try {
    const created = await createLinkedCard(
      client,
      actor,
      "podcast",
      {
        title: episode.title || `Podcast with ${guests.join(" & ")}`,
        anchorDate: episode.recordingDate,
        ...(guests.length ? { people: guests } : {}),
      },
      async (card) => {
        linked = await updatePodcastEpisode(client, episode, { cardId: card.id });
      },
    );
    if (!created.ok) return created.response;
    return json(201, { episode: linked && presented(linked), card: await summarizeCard(client, created.card) });
  } catch (error) {
    if ((error as Error).name === "ConditionalCheckFailedException")
      return json(409, { error: "Episode changed; reload and retry" });
    throw error;
  }
}
