import { randomUUID } from "crypto";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { TABLE_CALENDAR } from "./tableNames";

/**
 * A past event record in the DataOps events archive (workshops, webinars,
 * course launches, Q&As, and community events with Luma copy and recordings).
 */
export type ArchivedEvent = {
  id: string;
  title: string;
  /** Filename or URL slug (for example `2025-08-11-deploying-ml-models-with-fastapi-and-uv`). */
  slug?: string | null;
  /** Event date in `YYYY-MM-DD`. */
  date: string;
  /** Optional local time + zone string (for example `17:00 Europe/Berlin`). */
  time?: string | null;
  /** Event kind (for example `Workshop` or `Webinar`). */
  type?: string | null;
  /** Course or track display name (for example `ML Zoomcamp`, `DE Zoomcamp`, `Community`). */
  course?: string | null;
  /** Canonical series/folder slug (for example `ml-zoomcamp`, `de-zoomcamp`, `community`). */
  series?: string | null;
  /** Optional course module label (for example `Module 9`). */
  module?: string | null;
  /** Optional related-course note on community events. */
  relatedCourse?: string | null;
  /** Published Luma event URL (`https://lu.ma/...` or `https://luma.com/...`). */
  lumaUrl?: string | null;
  /** Published recording URL (for example YouTube link). */
  recordingUrl?: string | null;
  /** Speaker / instructor names in display order. */
  speakers: string[];
  /** Verbatim event description in Markdown. */
  description: string;
  /** Optional registration count. */
  registrations?: number | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type ArchivedEventFilter = {
  course?: string;
  date?: string;
  from?: string;
  to?: string;
  type?: string;
  speaker?: string;
  search?: string;
};

const PREFIX = "EVENTARCHIVE#";
const key = (id: string) => `${PREFIX}${id}`;

const KNOWN_SERIES_TO_COURSE: Record<string, string> = {
  "ml-zoomcamp": "ML Zoomcamp",
  "de-zoomcamp": "DE Zoomcamp",
  "data-engineering-zoomcamp": "DE Zoomcamp",
  "llm-zoomcamp": "LLM Zoomcamp",
  "open-source-llm-zoomcamp": "Open-Source LLM Zoomcamp",
  "mlops-zoomcamp": "MLOps Zoomcamp",
  "ai-dev-tools-zoomcamp": "AI Dev Tools Zoomcamp",
  "stock-markets-zoomcamp": "Stock Market Analytics Zoomcamp",
  "stock-market-analytics-zoomcamp": "Stock Market Analytics Zoomcamp",
  community: "Community",
  "community-and-partner-events": "Community",
};

const KNOWN_COURSE_TO_SERIES: Record<string, string> = {
  "ml-zoomcamp": "ml-zoomcamp",
  "machine-learning-zoomcamp": "ml-zoomcamp",
  "de-zoomcamp": "de-zoomcamp",
  "data-engineering-zoomcamp": "de-zoomcamp",
  "llm-zoomcamp": "llm-zoomcamp",
  "open-source-llm-zoomcamp": "llm-zoomcamp",
  "mlops-zoomcamp": "mlops-zoomcamp",
  "ai-dev-tools-zoomcamp": "ai-dev-tools-zoomcamp",
  "stock-markets-zoomcamp": "stock-markets-zoomcamp",
  "stock-market-analytics-zoomcamp": "stock-markets-zoomcamp",
  community: "community",
  "community-and-partner-events": "community",
};

export function normalizeCourseSlug(value: string | null | undefined): string {
  if (!value) return "";
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function canonicalSeriesSlug(value: string | null | undefined): string {
  const slug = normalizeCourseSlug(value);
  if (!slug) return "";
  return KNOWN_COURSE_TO_SERIES[slug] || slug;
}

export function resolveCourseAndSeries(input: {
  course?: string | null;
  series?: string | null;
  module?: string | null;
}): {
  course?: string | null;
  series?: string | null;
  module?: string | null;
} {
  let course = input.course === undefined ? undefined : input.course?.trim() || null;
  let series = input.series === undefined ? undefined : input.series?.trim() || null;
  let module = input.module === undefined ? undefined : input.module?.trim() || null;

  if (course && !module) {
    const commaIdx = course.indexOf(",");
    if (commaIdx > 0) {
      const rest = course.slice(commaIdx + 1).trim();
      if (/^(module\b|docker\s+module\b|bonus\s+module\b)/i.test(rest)) {
        module = rest;
        course = course.slice(0, commaIdx).trim();
      }
    }
  }

  if (series) {
    series = canonicalSeriesSlug(series);
  }
  if (!series && course) {
    series = canonicalSeriesSlug(course);
  }
  if (!course && series) {
    course = KNOWN_SERIES_TO_COURSE[series] || series;
  }

  return { course, series, module };
}

export function matchesCourseFilter(event: ArchivedEvent, rawFilter: string): boolean {
  const filterSlug = normalizeCourseSlug(rawFilter);
  if (!filterSlug) return true;
  const canonicalFilter = KNOWN_COURSE_TO_SERIES[filterSlug] || filterSlug;

  const eventCourseSlug = normalizeCourseSlug(event.course);
  const eventSeriesSlug = canonicalSeriesSlug(event.series || event.course);

  if (
    eventSeriesSlug === canonicalFilter ||
    eventSeriesSlug === filterSlug ||
    eventCourseSlug === filterSlug ||
    eventCourseSlug === canonicalFilter
  ) {
    return true;
  }

  const tokens = new Set([
    ...eventSeriesSlug.split("-").filter(Boolean),
    ...eventCourseSlug.split("-").filter(Boolean),
  ]);
  if (tokens.has(filterSlug)) return true;

  return false;
}

export function lumaSlug(url: string | null | undefined): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    return parsed.pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
  } catch {
    return "";
  }
}

const clean = (item: Record<string, unknown> | undefined): ArchivedEvent | null => {
  if (!item) return null;
  const { PK, SK, ...value } = item;
  return value as unknown as ArchivedEvent;
};

const stored = (record: ArchivedEvent) => ({
  PK: key(record.id),
  SK: key(record.id),
  ...Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined && value !== null),
  ),
});

export async function getArchivedEventById(
  client: DynamoDBDocumentClient,
  id: string,
): Promise<ArchivedEvent | null> {
  const result = await client.send(
    new GetCommand({
      TableName: TABLE_CALENDAR,
      Key: { PK: key(id), SK: key(id) },
    }),
  );
  return clean(result.Item as Record<string, unknown> | undefined);
}

export async function getArchivedEvent(
  client: DynamoDBDocumentClient,
  idOrSlug: string,
): Promise<ArchivedEvent | null> {
  const direct = await getArchivedEventById(client, idOrSlug);
  if (direct) return direct;
  const target = idOrSlug.trim().toLowerCase();
  const all = await listArchivedEvents(client);
  return (
    all.find(
      (item) =>
        (item.slug && item.slug.toLowerCase() === target) ||
        (item.lumaUrl && item.lumaUrl.toLowerCase() === target) ||
        (item.lumaUrl && lumaSlug(item.lumaUrl) === target),
    ) || null
  );
}

/** The events archive holds ~60–200 past events; a prefix scan is fast and exact. */
export async function listArchivedEvents(
  client: DynamoDBDocumentClient,
  filter: ArchivedEventFilter = {},
): Promise<ArchivedEvent[]> {
  const items: Record<string, unknown>[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await client.send(
      new ScanCommand({
        TableName: TABLE_CALENDAR,
        FilterExpression: "begins_with(PK, :prefix)",
        ExpressionAttributeValues: { ":prefix": PREFIX },
        ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
      }),
    );
    items.push(...((page.Items || []) as Record<string, unknown>[]));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  let results = items.map(clean).filter(Boolean) as ArchivedEvent[];

  if (filter.course) {
    results = results.filter((item) => matchesCourseFilter(item, filter.course!));
  }
  if (filter.date) {
    const dateFilter = filter.date.trim();
    results = results.filter(
      (item) => item.date === dateFilter || item.date.startsWith(`${dateFilter}-`),
    );
  }
  if (filter.from) {
    results = results.filter((item) => item.date >= filter.from!);
  }
  if (filter.to) {
    results = results.filter((item) => item.date <= filter.to!);
  }
  if (filter.type) {
    const typeLower = filter.type.trim().toLowerCase();
    results = results.filter((item) => (item.type || "").toLowerCase() === typeLower);
  }
  if (filter.speaker) {
    const speakerLower = filter.speaker.trim().toLowerCase();
    results = results.filter((item) =>
      (item.speakers || []).some((s) => s.toLowerCase().includes(speakerLower)),
    );
  }
  if (filter.search) {
    const q = filter.search.trim().toLowerCase();
    results = results.filter((item) => {
      const haystack = [
        item.title,
        item.course || "",
        item.series || "",
        item.module || "",
        item.type || "",
        ...(item.speakers || []),
        item.description || "",
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }

  return results.sort(
    (left, right) =>
      (right.date || "").localeCompare(left.date || "") ||
      left.title.localeCompare(right.title),
  );
}

export async function createArchivedEvent(
  client: DynamoDBDocumentClient,
  value: Omit<ArchivedEvent, "id" | "version" | "createdAt" | "updatedAt">,
): Promise<ArchivedEvent> {
  const now = new Date().toISOString();
  const normalized = resolveCourseAndSeries(value);
  const record: ArchivedEvent = {
    ...value,
    ...(normalized.course !== undefined ? { course: normalized.course } : {}),
    ...(normalized.series !== undefined ? { series: normalized.series } : {}),
    ...(normalized.module !== undefined ? { module: normalized.module } : {}),
    id: randomUUID(),
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  await client.send(
    new PutCommand({
      TableName: TABLE_CALENDAR,
      Item: stored(record),
      ConditionExpression: "attribute_not_exists(PK)",
    }),
  );
  return clean(stored(record))!;
}

/** Version-conditional replace; `null` clears an optional field. */
export async function updateArchivedEvent(
  client: DynamoDBDocumentClient,
  existing: ArchivedEvent,
  changes: Partial<ArchivedEvent>,
): Promise<ArchivedEvent> {
  const merged = {
    ...existing,
    ...changes,
  };
  const normalized = resolveCourseAndSeries({
    course: merged.course,
    series: merged.series,
    module: merged.module,
  });
  const next: ArchivedEvent = {
    ...merged,
    course: normalized.course,
    series: normalized.series,
    module: normalized.module,
    id: existing.id,
    version: existing.version + 1,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };
  await client.send(
    new PutCommand({
      TableName: TABLE_CALENDAR,
      Item: stored(next),
      ConditionExpression: "#version = :version",
      ExpressionAttributeNames: { "#version": "version" },
      ExpressionAttributeValues: { ":version": existing.version },
    }),
  );
  return clean(stored(next))!;
}

export async function deleteArchivedEvent(
  client: DynamoDBDocumentClient,
  existing: ArchivedEvent,
): Promise<void> {
  await client.send(
    new DeleteCommand({
      TableName: TABLE_CALENDAR,
      Key: { PK: key(existing.id), SK: key(existing.id) },
      ConditionExpression: "#version = :version",
      ExpressionAttributeNames: { "#version": "version" },
      ExpressionAttributeValues: { ":version": existing.version },
    }),
  );
}
