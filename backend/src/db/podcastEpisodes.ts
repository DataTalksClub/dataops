import { randomUUID } from "crypto";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { PodcastPublication } from "../podcast/publication";
import { TABLE_PODCAST_EPISODES } from "./tableNames";
import {
  collectBoundedPages,
  type StoragePaginationLimits,
} from "./boundedPagination";

export const EPISODE_STATUSES = [
  "booked",
  "recorded",
  "edited",
  "scheduled",
  "published",
  "cancelled",
] as const;
export const EPISODE_LINK_KINDS = [
  "youtube",
  "spotify",
  "apple",
  "anchor",
  "website",
] as const;

export type PodcastGuest = { name: string; slug?: string };
/**
 * One page-content transcript row, mirroring the website `_podcast/*.md`
 * front matter: either a `{ header }` section marker or a spoken `{ line }`
 * with its optional timestamp and speaker.
 */
export type EpisodeTranscriptEntry = {
  header?: string;
  line?: string;
  sec?: number;
  time?: string;
  who?: string;
};
/** A quotable clip (`quotableClips` on the website page); `url` is derived. */
export type EpisodeClip = {
  name: string;
  startOffset: number;
  endOffset: number;
  url?: string;
};
/** A mentioned resource (`resources` on the website page). */
export type EpisodeResource = {
  name: string;
  type: string;
  url?: string;
  context?: string;
};
export type PodcastEpisode = {
  id: string;
  season?: number | null;
  episode?: number | null;
  title?: string | null;
  guests: PodcastGuest[];
  recordingDate?: string | null;
  releaseDate?: string | null;
  status: (typeof EPISODE_STATUSES)[number];
  links?: Partial<Record<(typeof EPISODE_LINK_KINDS)[number], string>>;
  websiteSlug?: string | null;
  scheduleSourceKey?: string | null;
  cardId?: string | null;
  notes?: string | null;
  /** Observed publication facts; readiness is derived from them on read. */
  publication?: PodcastPublication | null;
  /** Website page content, sourced from the published `_podcast/*.md` page. */
  short?: string | null;
  description?: string | null;
  intro?: string | null;
  topics?: string[];
  /** ISO-8601 duration (`PT01H03M37S`), as the website page records it. */
  duration?: string | null;
  /** Cover art URL; the website page references the downloaded file. */
  imageUrl?: string | null;
  transcript?: EpisodeTranscriptEntry[];
  clips?: EpisodeClip[];
  resources?: EpisodeResource[];
  version: number;
  createdAt: string;
  updatedAt: string;
};

const RANGE = "EPISODES";
const key = (id: string) => `EPISODE#${id}`;
/** Undated episodes sort last; the date is the episode's best known date. */
const dateKey = (episode: Pick<PodcastEpisode, "id" | "releaseDate" | "recordingDate">) =>
  `${episode.releaseDate || episode.recordingDate || "9999"}#${episode.id}`;
const clean = (item: Record<string, unknown> | undefined) => {
  if (!item) return null;
  const { PK, SK, rangeKey, dateKey: _dateKey, ...value } = item;
  return value as unknown as PodcastEpisode;
};
const stored = (episode: PodcastEpisode) => ({
  PK: key(episode.id),
  SK: key(episode.id),
  rangeKey: RANGE,
  dateKey: dateKey(episode),
  ...Object.fromEntries(
    Object.entries(episode).filter(([, value]) => value !== undefined && value !== null),
  ),
});

export async function getPodcastEpisode(
  client: DynamoDBDocumentClient,
  id: string,
) {
  const result = await client.send(
    new GetCommand({
      TableName: TABLE_PODCAST_EPISODES,
      Key: { PK: key(id), SK: key(id) },
    }),
  );
  return clean(result.Item as Record<string, unknown> | undefined);
}

/** Episodes by date; `from`/`to` bound the release-or-recording date. */
export async function listPodcastEpisodes(
  client: DynamoDBDocumentClient,
  range: { from?: string; to?: string } = {},
  limits?: StoragePaginationLimits,
) {
  const items = await collectBoundedPages<Record<string, unknown>>({
    limits,
    loadPage: async (ExclusiveStartKey, abortSignal) =>
      client.send(
        new QueryCommand({
          TableName: TABLE_PODCAST_EPISODES,
          IndexName: "GSI-Date",
          KeyConditionExpression:
            "rangeKey=:range AND dateKey BETWEEN :from AND :to",
          ExpressionAttributeValues: {
            ":range": RANGE,
            ":from": range.from || "0000",
            ":to": `${range.to || "9999"}~`,
          },
          ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
        }),
        { abortSignal },
      ),
  });
  return items.map((item) => clean(item)!).filter(Boolean);
}

export async function createPodcastEpisode(
  client: DynamoDBDocumentClient,
  value: Omit<PodcastEpisode, "id" | "version" | "createdAt" | "updatedAt">,
) {
  const now = new Date().toISOString();
  const episode: PodcastEpisode = {
    ...value,
    id: randomUUID(),
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  await client.send(
    new PutCommand({
      TableName: TABLE_PODCAST_EPISODES,
      Item: stored(episode),
      ConditionExpression: "attribute_not_exists(PK)",
    }),
  );
  return episode;
}

/** Version-conditional replace; `null` clears an optional field. */
export async function updatePodcastEpisode(
  client: DynamoDBDocumentClient,
  existing: PodcastEpisode,
  changes: Partial<PodcastEpisode>,
) {
  const next = {
    ...existing,
    ...changes,
    id: existing.id,
    version: existing.version + 1,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  } as PodcastEpisode;
  await client.send(
    new PutCommand({
      TableName: TABLE_PODCAST_EPISODES,
      Item: stored(next),
      ConditionExpression: "#version=:version",
      ExpressionAttributeNames: { "#version": "version" },
      ExpressionAttributeValues: { ":version": existing.version },
    }),
  );
  return clean(stored(next))!;
}

export async function deletePodcastEpisode(
  client: DynamoDBDocumentClient,
  existing: PodcastEpisode,
) {
  await client.send(
    new DeleteCommand({
      TableName: TABLE_PODCAST_EPISODES,
      Key: { PK: key(existing.id), SK: key(existing.id) },
      ConditionExpression: "#version=:version",
      ExpressionAttributeNames: { "#version": "version" },
      ExpressionAttributeValues: { ":version": existing.version },
    }),
  );
}
