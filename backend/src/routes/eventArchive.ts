/**
 * /api/event-records: the DataOps past events archive (workshops, webinars,
 * course launches, Q&A sessions, and community events with Luma descriptions
 * and recording URLs).
 */
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { LambdaEvent, LambdaResponse } from "../types";
import {
  createArchivedEvent,
  deleteArchivedEvent,
  getArchivedEvent,
  listArchivedEvents,
  lumaSlug,
  resolveCourseAndSeries,
  updateArchivedEvent,
  type ArchivedEvent,
} from "../db/eventArchive";
import { resolveInteractiveActor } from "../identity/actor";

const json = (statusCode: number, body: unknown): LambdaResponse => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,199}$/;

const WRITABLE = new Set([
  "title",
  "slug",
  "date",
  "time",
  "type",
  "course",
  "series",
  "module",
  "relatedCourse",
  "lumaUrl",
  "recordingUrl",
  "speakers",
  "description",
  "registrations",
  "version",
]);

const realDate = (value: unknown): value is string => {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

const httpsUrl = (value: unknown): value is string => {
  try {
    return typeof value === "string" && new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

function normalizeInputBody(raw: Record<string, any>): Record<string, any> {
  const out = { ...raw };
  if (out.description === undefined && out.descriptionMarkdown !== undefined) {
    out.description = out.descriptionMarkdown;
    delete out.descriptionMarkdown;
  } else if (out.descriptionMarkdown !== undefined) {
    delete out.descriptionMarkdown;
  }
  return out;
}

function validate(body: Record<string, any>): string {
  const unknown = Object.keys(body).find((name) => !WRITABLE.has(name));
  if (unknown) return `Unknown field: ${unknown}`;
  if (typeof body.title !== "string" || !body.title.trim() || body.title.length > 400) {
    return "Invalid title";
  }
  if (!realDate(body.date)) {
    return "Invalid date";
  }
  if (
    body.slug !== null &&
    body.slug !== undefined &&
    (typeof body.slug !== "string" || !SLUG.test(body.slug))
  ) {
    return "Invalid slug";
  }
  for (const [field, maxLen] of [
    ["time", 100],
    ["type", 100],
    ["course", 200],
    ["series", 100],
    ["module", 200],
    ["relatedCourse", 300],
  ] as const) {
    const val = body[field];
    if (val !== null && val !== undefined) {
      if (typeof val !== "string" || !val.trim() || val.length > maxLen) {
        return `Invalid ${field}`;
      }
    }
  }
  if (body.lumaUrl !== null && body.lumaUrl !== undefined && !httpsUrl(body.lumaUrl)) {
    return "Invalid lumaUrl";
  }
  if (
    body.recordingUrl !== null &&
    body.recordingUrl !== undefined &&
    !httpsUrl(body.recordingUrl)
  ) {
    return "Invalid recordingUrl";
  }
  if (
    !Array.isArray(body.speakers) ||
    body.speakers.length > 20 ||
    !body.speakers.every(
      (speaker: unknown) =>
        typeof speaker === "string" && speaker.trim().length > 0 && speaker.length <= 200,
    )
  ) {
    return "Invalid speakers";
  }
  if (
    typeof body.description !== "string" ||
    body.description.length > 100_000
  ) {
    return "Invalid description";
  }
  if (body.registrations !== null && body.registrations !== undefined) {
    if (
      typeof body.registrations !== "number" ||
      !Number.isInteger(body.registrations) ||
      body.registrations < 0
    ) {
      return "Invalid registrations";
    }
  }
  return "";
}

function duplicateOf(
  candidate: Partial<ArchivedEvent>,
  events: ArchivedEvent[],
  selfId: string | null,
): string {
  const candidateLuma = lumaSlug(candidate.lumaUrl);
  for (const other of events) {
    if (other.id === selfId) continue;
    if (candidate.slug && other.slug === candidate.slug) {
      return `slug already used by event ${other.id}`;
    }
    if (candidateLuma && lumaSlug(other.lumaUrl) === candidateLuma) {
      return `lumaUrl already used by event ${other.id}`;
    }
  }
  return "";
}

function findMatchingExisting(
  candidate: Partial<ArchivedEvent>,
  events: ArchivedEvent[],
): ArchivedEvent | undefined {
  const candidateLuma = lumaSlug(candidate.lumaUrl);
  if (candidateLuma) {
    const byLuma = events.find((e) => lumaSlug(e.lumaUrl) === candidateLuma);
    if (byLuma) return byLuma;
  }
  if (candidate.slug) {
    const bySlug = events.find((e) => e.slug === candidate.slug);
    if (bySlug) return bySlug;
  }
  if (candidate.date && candidate.title) {
    const titleLower = candidate.title.trim().toLowerCase();
    return events.find(
      (e) => e.date === candidate.date && e.title.trim().toLowerCase() === titleLower,
    );
  }
  return undefined;
}

function isSameEventContent(existing: ArchivedEvent, candidate: Record<string, any>): boolean {
  const norm = resolveCourseAndSeries({
    course: candidate.course,
    series: candidate.series,
    module: candidate.module,
  });
  const fields: Array<[unknown, unknown]> = [
    [existing.title, candidate.title],
    [existing.slug ?? null, candidate.slug ?? null],
    [existing.date, candidate.date],
    [existing.time ?? null, candidate.time ?? null],
    [existing.type ?? null, candidate.type ?? null],
    [existing.course ?? null, norm.course ?? null],
    [existing.series ?? null, norm.series ?? null],
    [existing.module ?? null, norm.module ?? null],
    [existing.relatedCourse ?? null, candidate.relatedCourse ?? null],
    [existing.lumaUrl ?? null, candidate.lumaUrl ?? null],
    [existing.recordingUrl ?? null, candidate.recordingUrl ?? null],
    [JSON.stringify(existing.speakers || []), JSON.stringify(candidate.speakers || [])],
    [existing.description ?? "", candidate.description ?? ""],
    [existing.registrations ?? null, candidate.registrations ?? null],
  ];
  return fields.every(([a, b]) => a === b);
}

const parse = (event: LambdaEvent): Record<string, any> | null => {
  try {
    const value = event.body ? JSON.parse(String(event.body)) : {};
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
};

export async function handleEventArchiveRoutes(
  path: string,
  method: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse> {
  const resolved = await resolveInteractiveActor(
    client,
    event,
    method === "GET" ? "work-read" : "work-write",
  );
  if (!resolved.ok) return resolved.response;

  if (/^\/api\/event-records\/import\/?$/.test(path)) {
    if (method !== "POST") return json(405, { error: "Method not allowed" });
    const body = parse(event);
    if (!body || !Array.isArray(body.items)) {
      return json(400, { error: "Expected { items: [...] }" });
    }
    if (body.items.length > 500) {
      return json(400, { error: "Too many items in one import batch (max 500)" });
    }

    const candidates: Array<Record<string, any>> = [];
    for (let index = 0; index < body.items.length; index += 1) {
      const rawItem = body.items[index];
      if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
        return json(400, { error: `Item ${index}: invalid object` });
      }
      if (Object.hasOwn(rawItem, "version")) {
        return json(400, { error: `Item ${index}: version is system-owned` });
      }
      const candidate = {
        speakers: [],
        description: "",
        ...normalizeInputBody(rawItem),
      };
      const error = validate(candidate);
      if (error) {
        return json(400, { error: `Item ${index}: ${error}` });
      }
      candidates.push(candidate);
    }

    const existingEvents = await listArchivedEvents(client);
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    const resultItems: ArchivedEvent[] = [];

    for (const candidate of candidates) {
      const existing = findMatchingExisting(candidate, existingEvents);
      if (!existing) {
        const record = await createArchivedEvent(
          client,
          candidate as Parameters<typeof createArchivedEvent>[1],
        );
        existingEvents.push(record);
        resultItems.push(record);
        created += 1;
      } else if (isSameEventContent(existing, candidate)) {
        resultItems.push(existing);
        unchanged += 1;
      } else {
        const next = await updateArchivedEvent(client, existing, candidate);
        const idx = existingEvents.findIndex((e) => e.id === existing.id);
        if (idx >= 0) existingEvents[idx] = next;
        resultItems.push(next);
        updated += 1;
      }
    }

    return json(200, {
      created,
      updated,
      unchanged,
      total: resultItems.length,
      items: resultItems,
    });
  }

  const match = path.match(/^\/api\/event-records(?:\/([^/]+))?\/?$/);
  if (!match) return json(404, { error: "Not found" });
  const rawId = match[1] ? decodeURIComponent(match[1]) : undefined;
  if (rawId && !ID.test(rawId)) return json(404, { error: "Not found" });

  if (method === "GET" && !rawId) {
    const q = event.queryStringParameters || {};
    const items = await listArchivedEvents(client, {
      course: q.course || q.series || undefined,
      date: q.date || undefined,
      from: q.from || undefined,
      to: q.to || undefined,
      type: q.type || undefined,
      speaker: q.speaker || undefined,
      search: q.search || q.q || undefined,
    });
    return json(200, { items });
  }

  if (method === "GET" && rawId) {
    const item = await getArchivedEvent(client, rawId);
    return item ? json(200, item) : json(404, { error: "Not found" });
  }

  const rawBody = parse(event);
  if (!rawBody) return json(400, { error: "Invalid JSON" });
  const body = normalizeInputBody(rawBody);

  if (method === "POST" && !rawId) {
    if (Object.hasOwn(body, "version")) return json(400, { error: "version is system-owned" });
    const candidate = { speakers: [], description: "", ...body } as Record<string, any>;
    const error = validate(candidate);
    if (error) return json(400, { error });
    const duplicate = duplicateOf(candidate, await listArchivedEvents(client), null);
    if (duplicate) return json(409, { error: duplicate });
    const created = await createArchivedEvent(
      client,
      candidate as Parameters<typeof createArchivedEvent>[1],
    );
    return json(201, created);
  }

  if (!rawId) return json(405, { error: "Method not allowed" });
  const existing = await getArchivedEvent(client, rawId);
  if (!existing) return json(404, { error: "Not found" });
  if (body.version !== existing.version) {
    return json(409, { error: "Event record changed; reload and retry" });
  }

  if (method === "PUT") {
    const unknown = Object.keys(body).find((name) => !WRITABLE.has(name));
    if (unknown) return json(400, { error: `Unknown field: ${unknown}` });
    const { version: _version, ...changes } = body;
    const merged = Object.fromEntries(
      [...WRITABLE]
        .filter((name) => name !== "version")
        .map((name) => [
          name,
          Object.hasOwn(changes, name) ? changes[name] : (existing as any)[name],
        ]),
    );
    if (merged.speakers === undefined || merged.speakers === null) merged.speakers = [];
    if (merged.description === undefined || merged.description === null) merged.description = "";
    const error = validate(merged);
    if (error) return json(400, { error });
    const duplicate = duplicateOf(merged, await listArchivedEvents(client), existing.id);
    if (duplicate) return json(409, { error: duplicate });
    let next: ArchivedEvent;
    try {
      next = await updateArchivedEvent(client, existing, changes);
    } catch {
      return json(409, { error: "Conflicting update" });
    }
    return json(200, next);
  }

  if (method === "DELETE") {
    try {
      await deleteArchivedEvent(client, existing);
      return { statusCode: 204, headers: {}, body: "" };
    } catch {
      return json(409, { error: "Conflicting delete" });
    }
  }

  return json(405, { error: "Method not allowed" });
}
