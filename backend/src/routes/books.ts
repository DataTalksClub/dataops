/**
 * /api/books: the Book of the Week register.
 *
 * One record holds the public facts a website `_books/<date>-<slug>.md` page
 * renders (title, authors, description, event week, labeled links, cover).
 */
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { LambdaEvent, LambdaResponse } from "../types";
import {
  createBook,
  deleteBook,
  getBook,
  listBooks,
  updateBook,
  type Book,
} from "../db/books";
import { resolveInteractiveActor } from "../identity/actor";

const json = (statusCode: number, body: unknown): LambdaResponse => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,199}$/;
const WRITABLE = new Set([
  "title",
  "slug",
  "authors",
  "description",
  "startDate",
  "endDate",
  "links",
  "coverUrl",
  "version",
]);

const realDate = (value: unknown) => {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
const httpsUrl = (value: unknown) => {
  try {
    return typeof value === "string" && new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

/** Validate a full book shape (after merging a PUT onto the current one). */
function validate(body: Record<string, any>): string {
  const unknown = Object.keys(body).find((name) => !WRITABLE.has(name));
  if (unknown) return `Unknown field: ${unknown}`;
  if (typeof body.title !== "string" || !body.title.trim() || body.title.length > 300)
    return "Invalid title";
  if (body.slug !== null && body.slug !== undefined && (typeof body.slug !== "string" || !SLUG.test(body.slug)))
    return "Invalid slug";
  if (
    !Array.isArray(body.authors) ||
    body.authors.length < 1 ||
    body.authors.length > 10 ||
    !body.authors.every(
      (author: any) =>
        author &&
        typeof author === "object" &&
        !Array.isArray(author) &&
        Object.keys(author).every((name) => ["name", "slug"].includes(name)) &&
        typeof author.name === "string" &&
        author.name.trim().length > 0 &&
        author.name.length <= 200 &&
        (author.slug === undefined || (typeof author.slug === "string" && SLUG.test(author.slug))),
    )
  )
    return "Invalid authors";
  if (body.description !== null && body.description !== undefined) {
    if (typeof body.description !== "string" || !body.description.trim() || body.description.length > 5000)
      return "Invalid description";
  }
  for (const name of ["startDate", "endDate"] as const)
    if (body[name] !== null && body[name] !== undefined && !realDate(body[name])) return `Invalid ${name}`;
  if (
    body.startDate &&
    body.endDate &&
    realDate(body.startDate) &&
    realDate(body.endDate) &&
    body.startDate > body.endDate
  )
    return "Invalid date range";
  if (body.links !== undefined && body.links !== null) {
    if (
      !Array.isArray(body.links) ||
      body.links.length > 20 ||
      !body.links.every(
        (link: any) =>
          link &&
          typeof link === "object" &&
          !Array.isArray(link) &&
          Object.keys(link).every((name) => ["text", "url"].includes(name)) &&
          typeof link.text === "string" &&
          link.text.trim().length > 0 &&
          link.text.length <= 200 &&
          httpsUrl(link.url),
      )
    )
      return "Invalid links";
  }
  if (body.coverUrl !== null && body.coverUrl !== undefined && !httpsUrl(body.coverUrl))
    return "Invalid coverUrl";
  return "";
}

/** Another book already holds this website slug. Duplicates are refused, never merged. */
function duplicateOf(candidate: Partial<Book>, books: Book[], selfId: string | null) {
  for (const other of books) {
    if (other.id === selfId) continue;
    if (candidate.slug && other.slug === candidate.slug)
      return `slug already used by book ${other.id}`;
  }
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

export async function handleBookRoutes(
  path: string,
  method: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse> {
  const match = path.match(/^\/api\/books(?:\/([^/]+))?\/?$/);
  if (!match) return json(404, { error: "Not found" });
  const [, id] = match;
  if (id && !ID.test(id)) return json(404, { error: "Not found" });
  const resolved = await resolveInteractiveActor(
    client,
    event,
    method === "GET" ? "work-read" : "work-write",
  );
  if (!resolved.ok) return resolved.response;

  if (method === "GET" && !id) {
    return json(200, { items: await listBooks(client) });
  }

  if (method === "GET" && id) {
    const book = await getBook(client, id);
    return book ? json(200, book) : json(404, { error: "Not found" });
  }

  const body = parse(event);
  if (!body) return json(400, { error: "Invalid JSON" });

  if (method === "POST" && !id) {
    if (Object.hasOwn(body, "version")) return json(400, { error: "version is system-owned" });
    const candidate = { authors: [], ...body } as Record<string, any>;
    const error = validate(candidate);
    if (error) return json(400, { error });
    const duplicate = duplicateOf(candidate, await listBooks(client), null);
    if (duplicate) return json(409, { error: duplicate });
    const created = await createBook(client, candidate as Parameters<typeof createBook>[1]);
    return json(201, created);
  }

  if (!id) return json(405, { error: "Method not allowed" });
  const existing = await getBook(client, id);
  if (!existing) return json(404, { error: "Not found" });
  if (body.version !== existing.version)
    return json(409, { error: "Book changed; reload and retry" });

  if (method === "PUT") {
    const unknown = Object.keys(body).find((name) => !WRITABLE.has(name));
    if (unknown) return json(400, { error: `Unknown field: ${unknown}` });
    const { version: _version, ...changes } = body;
    const merged = Object.fromEntries(
      [...WRITABLE]
        .filter((name) => name !== "version")
        .map((name) => [name, Object.hasOwn(changes, name) ? changes[name] : (existing as any)[name]]),
    );
    const error = validate(merged);
    if (error) return json(400, { error });
    const duplicate = duplicateOf(merged, await listBooks(client), id);
    if (duplicate) return json(409, { error: duplicate });
    let next: Book;
    try {
      next = await updateBook(client, existing, changes);
    } catch {
      return json(409, { error: "Conflicting update" });
    }
    return json(200, next);
  }

  if (method === "DELETE") {
    try {
      await deleteBook(client, existing);
      return { statusCode: 204, headers: {}, body: "" };
    } catch {
      return json(409, { error: "Conflicting delete" });
    }
  }
  return json(405, { error: "Method not allowed" });
}
