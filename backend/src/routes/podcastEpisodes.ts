/**
 * /api/podcast-episodes: the podcast episode register.
 *
 * An episode is the planning record for one podcast episode from booking to
 * publication. `episode.cardId` is the single canonical link to the Card that
 * executes it; the episode pushes its recording date and guests onto that
 * Card one way, and reads its status back from the Card's done stage Tasks
 * (podcast/cardStatus.ts).
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
import { listTasksByCard } from "../db/tasks";
import { cardCanAdvance, statusFromCard } from "../podcast/cardStatus";
import {
  derivePublicationReadiness,
  normalizePublication,
} from "../podcast/publication";
import { resolveInteractiveActor } from "../identity/actor";
import { podcastEpisodeTitleValues, recordTemplateTypes } from "../cards/cardTitlePattern";
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
  "short",
  "description",
  "intro",
  "topics",
  "duration",
  "imageUrl",
  "transcript",
  "clips",
  "resources",
  "version",
]);
const PODCAST_CARD_TYPES = recordTemplateTypes("podcast-episode");

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
/** Resource mentions keep legacy http links; everything else must be https. */
const httpUrl = (value: unknown) => {
  try {
    const protocol = new URL(value as string).protocol;
    return typeof value === "string" && (protocol === "https:" || protocol === "http:");
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
  for (const name of ["short", "description", "intro", "duration", "imageUrl"] as const) {
    if (body[name] === null || body[name] === undefined) continue;
    if (typeof body[name] !== "string") return `Invalid ${name}`;
  }
  if (typeof body.short === "string" && (!body.short.trim() || body.short.length > 200))
    return "Invalid short";
  if (typeof body.description === "string" && (!body.description.trim() || body.description.length > 5000))
    return "Invalid description";
  if (typeof body.intro === "string" && (!body.intro.trim() || body.intro.length > 20000))
    return "Invalid intro";
  if (typeof body.duration === "string" && !/^PT(\d+H)?(\d+M)?(\d+(\.\d+)?S)?$/.test(body.duration))
    return "Invalid duration";
  if (typeof body.imageUrl === "string" && !httpsUrl(body.imageUrl)) return "Invalid imageUrl";
  if (body.topics !== undefined && body.topics !== null) {
    if (
      !Array.isArray(body.topics) ||
      body.topics.length > 30 ||
      !body.topics.every(
        (topic: any) => typeof topic === "string" && topic.trim().length > 0 && topic.length <= 80,
      )
    )
      return "Invalid topics";
  }
  if (body.transcript !== undefined && body.transcript !== null) {
    if (!Array.isArray(body.transcript) || body.transcript.length > 5000) return "Invalid transcript";
    for (const entry of body.transcript) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return "Invalid transcript";
      const keys = Object.keys(entry);
      if (keys.some((name) => !["header", "line", "sec", "time", "who"].includes(name)))
        return "Invalid transcript";
      if (typeof entry.header === "string") {
        if (!entry.header.trim() || entry.header.length > 500 || entry.line !== undefined)
          return "Invalid transcript";
      } else if (typeof entry.line === "string") {
        if (!entry.line.trim() || entry.line.length > 10000) return "Invalid transcript";
        if (entry.sec !== undefined && (!Number.isSafeInteger(entry.sec) || entry.sec < 0))
          return "Invalid transcript";
        if (entry.time !== undefined && (typeof entry.time !== "string" || entry.time.length > 32))
          return "Invalid transcript";
        if (entry.who !== undefined && (typeof entry.who !== "string" || entry.who.length > 2000))
          return "Invalid transcript";
      } else return "Invalid transcript";
    }
  }
  if (body.clips !== undefined && body.clips !== null) {
    if (!Array.isArray(body.clips) || body.clips.length > 500) return "Invalid clips";
    for (const clip of body.clips) {
      if (!clip || typeof clip !== "object" || Array.isArray(clip)) return "Invalid clips";
      if (Object.keys(clip).some((name) => !["name", "startOffset", "endOffset", "url"].includes(name)))
        return "Invalid clips";
      if (typeof clip.name !== "string" || !clip.name.trim() || clip.name.length > 300)
        return "Invalid clips";
      for (const name of ["startOffset", "endOffset"] as const)
        if (!Number.isSafeInteger(clip[name]) || clip[name] < 0) return "Invalid clips";
      if (clip.url !== undefined && !httpsUrl(clip.url)) return "Invalid clips";
    }
  }
  if (body.resources !== undefined && body.resources !== null) {
    if (!Array.isArray(body.resources) || body.resources.length > 500) return "Invalid resources";
    for (const resource of body.resources) {
      if (!resource || typeof resource !== "object" || Array.isArray(resource)) return "Invalid resources";
      if (Object.keys(resource).some((name) => !["name", "type", "url", "context"].includes(name)))
        return "Invalid resources";
      if (typeof resource.name !== "string" || !resource.name.trim() || resource.name.length > 300)
        return "Invalid resources";
      if (typeof resource.type !== "string" || !resource.type.trim() || resource.type.length > 40)
        return "Invalid resources";
      if (resource.url !== undefined && !httpUrl(resource.url)) return "Invalid resources";
      if (resource.context !== undefined && (typeof resource.context !== "string" || resource.context.length > 2000))
        return "Invalid resources";
    }
  }
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
    await pushFieldsToCard(
      client,
      String(episode.cardId),
      {
        ...(episode.recordingDate ? { anchorDate: episode.recordingDate } : {}),
        ...(episode.guests.length ? { people: episode.guests.map((guest) => guest.name) } : {}),
      },
      podcastEpisodeTitleValues(episode),
    );
    return "synced";
  } catch (error) {
    console.error("Podcast episode card sync failed:", error);
    return "failed";
  }
}

/** The status the episode's Card has moved it to, or the stored one. */
async function derivedStatus(client: DynamoDBDocumentClient, episode: PodcastEpisode) {
  if (!episode.cardId || !cardCanAdvance(episode.status)) return episode.status;
  const stageRefs = (await getCard(client, episode.cardId))?.templateDefinitionSnapshot?.episodeStages;
  if (!stageRefs) return episode.status;
  const done = new Set(
    (await listTasksByCard(client, episode.cardId))
      .filter((task) => task.status === "done" && task.templateTaskRef)
      .map((task) => String(task.templateTaskRef)),
  );
  return statusFromCard(episode.status, stageRefs, done);
}

/** List items stay light: full page content (transcript, clips, resources,
 *  intro) is only served on the single-episode read the page generator uses. */
const HEAVY_PAGE_CONTENT = ["transcript", "clips", "resources", "intro"] as const;
const summarizeEpisode = (episode: PodcastEpisode): PodcastEpisode => {
  const copy = { ...episode };
  for (const name of HEAVY_PAGE_CONTENT) delete copy[name];
  return copy;
};

/** The episode as every response shows it: status and readiness derived, never stored. */
const presented = async (client: DynamoDBDocumentClient, episode: PodcastEpisode) => ({
  ...episode,
  status: await derivedStatus(client, episode),
  readiness: derivePublicationReadiness(episode.publication),
});

async function withCard(client: DynamoDBDocumentClient, episode: PodcastEpisode) {
  const card = episode.cardId ? await getCard(client, episode.cardId) : null;
  return { ...(await presented(client, episode)), card: card ? await summarizeCard(client, card) : null };
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
        (query.season === undefined || episode.season === Number(query.season)) &&
        (query.cardId === undefined || episode.cardId === query.cardId),
    );
    const enriched = [];
    for (const episode of items) enriched.push(await withCard(client, summarizeEpisode(episode)));
    return json(200, {
      items: enriched.filter((episode) => query.status === undefined || episode.status === query.status),
    });
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
      return json(201, { ...(await presented(client, created)), cardSync: await pushEpisodeToCard(client, created) });
    return json(201, await presented(client, created));
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
        next.title !== existing.title ||
        next.season !== existing.season ||
        next.episode !== existing.episode ||
        JSON.stringify(next.guests) !== JSON.stringify(existing.guests))
    )
      return json(200, { ...(await presented(client, next)), cardSync: await pushEpisodeToCard(client, next) });
    return json(200, await presented(client, next));
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
      podcastEpisodeTitleValues(episode),
      async (card) => {
        linked = await updatePodcastEpisode(client, episode, { cardId: card.id });
      },
    );
    if (!created.ok) return created.response;
    return json(201, {
      episode: linked && (await presented(client, linked)),
      card: await summarizeCard(client, created.card),
    });
  } catch (error) {
    if ((error as Error).name === "ConditionalCheckFailedException")
      return json(409, { error: "Episode changed; reload and retry" });
    throw error;
  }
}
