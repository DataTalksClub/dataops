/**
 * /api/people: the speaker/author profile register.
 *
 * One record holds the public facts a website `_people/<slug>.md` profile
 * renders (name, job title, company, bio, photo, social links). Private contact details never
 * live here; the website script resolves names to slugs from this register.
 */
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { LambdaEvent, LambdaResponse } from "../types";
import {
  createPerson,
  deletePerson,
  getPerson,
  listPeople,
  updatePerson,
  type Person,
} from "../db/people";
import { json, parseJsonObjectEventOrEmpty as parse } from "../http";
import { resolveInteractiveActor } from "../identity/actor";
import { assertHostedGuestPhoto, GuestPhotoError } from "../guestPhoto";
import { guestHeadlineProblem } from "../guestHeadline";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,199}$/;
const WRITABLE = new Set(["name", "slug", "jobTitle", "company", "bio", "bioShort", "photoUrl", "links", "version"]);
const HEADLINE_FIELDS = [["jobTitle", "Job title"], ["company", "Company"]] as const;

const httpsUrl = (value: unknown) => {
  try {
    return typeof value === "string" && new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

/**
 * Validate a full person shape (after merging a PUT onto the current one).
 * A new profile must state its job title and company; a profile created before
 * they existed may stay without them until someone fills them in, but once
 * given they cannot be cleared.
 */
function validate(body: Record<string, any>, requireHeadline: boolean): string {
  const unknown = Object.keys(body).find((name) => !WRITABLE.has(name));
  if (unknown) return `Unknown field: ${unknown}`;
  if (
    typeof body.name !== "string" ||
    !body.name.trim() ||
    body.name.length > 200
  )
    return "Invalid name";
  if (typeof body.slug !== "string" || !SLUG.test(body.slug)) return "Invalid slug";
  for (const [name, label] of HEADLINE_FIELDS) {
    if (!requireHeadline && body[name] === undefined) continue;
    if (typeof body[name] !== "string") return `${label} is required.`;
    const problem = guestHeadlineProblem(label, body[name]);
    if (problem) return problem;
  }
  for (const name of ["bio", "bioShort", "photoUrl"] as const) {
    if (body[name] === null || body[name] === undefined) continue;
    if (typeof body[name] !== "string") return `Invalid ${name}`;
  }
  if (typeof body.bio === "string" && (body.bio.length > 20000)) return "Invalid bio";
  if (typeof body.bioShort === "string" && (!body.bioShort.trim() || body.bioShort.length > 500))
    return "Invalid bioShort";
  if (typeof body.photoUrl === "string" && !httpsUrl(body.photoUrl)) return "Invalid photoUrl";
  if (body.links !== undefined && body.links !== null) {
    if (typeof body.links !== "object" || Array.isArray(body.links)) return "Invalid links";
    for (const [kind, url] of Object.entries(body.links)) {
      if (!["github", "twitter", "linkedin", "website"].includes(kind)) return `Invalid link: ${kind}`;
      if (typeof url !== "string" || !url.trim() || url.length > 300) return `Invalid link: ${kind}`;
    }
  }
  return "";
}

/** Job title and company are stored trimmed. */
function trimHeadline(body: Record<string, any>): Record<string, any> {
  for (const [name] of HEADLINE_FIELDS) if (typeof body[name] === "string") body[name] = body[name].trim();
  return body;
}

/** A photo hosted by DataOps must be large enough for the event picture; returns the reason when not. */
async function photoProblem(photoUrl: unknown, previous: unknown): Promise<string> {
  if (typeof photoUrl !== "string" || photoUrl === previous) return "";
  try {
    await assertHostedGuestPhoto(photoUrl);
    return "";
  } catch (error) {
    if (error instanceof GuestPhotoError) return error.message;
    throw error;
  }
}

/** Another person already holds this website slug. Duplicates are refused, never merged. */
function duplicateOf(candidate: Partial<Person>, people: Person[], selfId: string | null) {
  for (const other of people) {
    if (other.id === selfId) continue;
    if (candidate.slug && other.slug === candidate.slug)
      return `slug already used by person ${other.id}`;
  }
  return "";
}

export async function handlePeopleRoutes(
  path: string,
  method: string,
  event: LambdaEvent,
  client: DynamoDBDocumentClient,
): Promise<LambdaResponse> {
  const match = path.match(/^\/api\/people(?:\/([^/]+))?\/?$/);
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
    return json(200, { items: await listPeople(client) });
  }

  if (method === "GET" && id) {
    const person = await getPerson(client, id);
    return person ? json(200, person) : json(404, { error: "Not found" });
  }

  const body = parse(event);
  if (!body) return json(400, { error: "Invalid JSON" });

  if (method === "POST" && !id) {
    if (Object.hasOwn(body, "version")) return json(400, { error: "version is system-owned" });
    const candidate = trimHeadline({ ...body } as Record<string, any>);
    const error = validate(candidate, true);
    if (error) return json(400, { error });
    const photoError = await photoProblem(candidate.photoUrl, undefined);
    if (photoError) return json(400, { error: photoError });
    const duplicate = duplicateOf(candidate, await listPeople(client), null);
    if (duplicate) return json(409, { error: duplicate });
    const created = await createPerson(client, candidate as Parameters<typeof createPerson>[1]);
    return json(201, created);
  }

  if (!id) return json(405, { error: "Method not allowed" });
  const existing = await getPerson(client, id);
  if (!existing) return json(404, { error: "Not found" });
  if (body.version !== existing.version)
    return json(409, { error: "Person changed; reload and retry" });

  if (method === "PUT") {
    const unknown = Object.keys(body).find((name) => !WRITABLE.has(name));
    if (unknown) return json(400, { error: `Unknown field: ${unknown}` });
    const { version: _version, ...changes } = trimHeadline(body);
    const merged = Object.fromEntries(
      [...WRITABLE]
        .filter((name) => name !== "version")
        .map((name) => [name, Object.hasOwn(changes, name) ? changes[name] : (existing as any)[name]]),
    );
    const error = validate(merged, false);
    if (error) return json(400, { error });
    const photoError = await photoProblem(merged.photoUrl, existing.photoUrl);
    if (photoError) return json(400, { error: photoError });
    const duplicate = duplicateOf(merged, await listPeople(client), id);
    if (duplicate) return json(409, { error: duplicate });
    let next: Person;
    try {
      next = await updatePerson(client, existing, changes);
    } catch {
      return json(409, { error: "Conflicting update" });
    }
    return json(200, next);
  }

  if (method === "DELETE") {
    try {
      await deletePerson(client, existing);
      return { statusCode: 204, headers: {}, body: "" };
    } catch {
      return json(409, { error: "Conflicting delete" });
    }
  }
  return json(405, { error: "Method not allowed" });
}
