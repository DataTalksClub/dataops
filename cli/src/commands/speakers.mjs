import { UsageError } from "../errors.mjs";
import { enc, fields, optionalString, positional, table } from "../format.mjs";
import { apiFor } from "../session.mjs";

export const summary = "Website speaker/author profiles (the _people register)";

export const help = `dataops speakers - the website speaker/author profiles behind _people pages

Usage
  dataops speakers list
  dataops speakers show <person-id>
  dataops speakers create --name NAME --slug SLUG --job-title TEXT --company TEXT
      [--bio TEXT] [--bio-short TEXT] [--photo-url URL] [--github HANDLE] [--twitter HANDLE]
      [--linkedin HANDLE] [--website URL]
  dataops speakers update <person-id> [same flags as create]
                                  "none" clears the bio, photo or a link

A profile holds only public facts: name, job title, company, bio, photo and
social links. Private contact details never live here. The website script
resolves speaker names to profile slugs from this register.

Job title and company are required for a new profile and cannot be cleared:
the website shows every guest as "<job title> at <company>" next to the photo
(e.g. --job-title "AI Engineer" --company IBM). Take both from the guest form,
never from the bio. Plain text, at most 80 characters each, no links.

The photo feeds the event picture: at least 800 px on the shorter side,
square-ish, one face, no text or logos, JPG/PNG/WebP. A photo hosted by
DataOps below 800 px is refused; a link elsewhere is not measured.
`;

const LINK_FLAGS = [
  ["github", "github"],
  ["twitter", "twitter"],
  ["linkedin", "linkedin"],
  ["website", "website"],
];

/** The website headline: "AI Engineer at IBM". */
export function headline(person) {
  return person.jobTitle && person.company ? `${person.jobTitle} at ${person.company}` : "";
}

function speakerBody(args, current = {}) {
  const body = {};
  const name = optionalString(args, "name");
  if (name !== undefined) body.name = name;
  const slug = optionalString(args, "slug");
  if (slug !== undefined) body.slug = slug;
  for (const key of ["jobTitle", "company"]) {
    const value = optionalString(args, key);
    if (value !== undefined) body[key] = value;
  }
  for (const [flag, key] of [["bio", "bio"], ["bioShort", "bioShort"], ["photoUrl", "photoUrl"]]) {
    const value = optionalString(args, flag);
    if (value !== undefined) body[key] = value === "none" ? null : value;
  }
  const links = {};
  for (const [flag, kind] of LINK_FLAGS) {
    const value = optionalString(args, flag);
    if (value !== undefined) links[kind] = value === "none" ? null : value;
  }
  if (Object.keys(links).length) body.links = { ...(current.links || {}), ...links };
  return body;
}

export async function list(args, io) {
  const result = await apiFor(args).get("/api/people");
  if (args.json) return result;
  table(io, result.items || [], [
    ["ID", (person) => person.id],
    ["SLUG", (person) => person.slug],
    ["NAME", (person) => person.name],
    ["TITLE", (person) => headline(person) || "(missing job title/company)"],
  ], "No speaker profiles.");
  return result;
}

export async function show(args, io) {
  const id = positional(args, 0, "dataops speakers show <person-id>");
  const person = await apiFor(args).get(`/api/people/${enc(id)}`);
  if (args.json) return person;
  fields(io, [
    ["id", person.id],
    ["slug", person.slug],
    ["name", person.name],
    ["jobTitle", person.jobTitle],
    ["company", person.company],
    ["headline", headline(person)],
    ["bioShort", person.bioShort],
    ["bio", person.bio ? `${person.bio.length} chars` : ""],
    ["photo", person.photoUrl],
    ...LINK_FLAGS.map(([, kind]) => [kind, person.links?.[kind]]),
    ["version", person.version],
  ]);
  return person;
}

export async function create(args, io) {
  const body = speakerBody(args);
  if (!body.name) throw new UsageError("--name is required.");
  if (!body.slug) throw new UsageError("--slug is required: the website _people short id.");
  if (!body.jobTitle) throw new UsageError('--job-title is required, e.g. --job-title "AI Engineer".');
  if (!body.company) throw new UsageError('--company is required, e.g. --company IBM.');
  if (body.links) body.links = Object.fromEntries(Object.entries(body.links).filter(([, value]) => value));
  const person = await apiFor(args).post("/api/people", body);
  if (args.json) return person;
  io.print(`Created speaker ${person.id}: ${person.name} (${person.slug}).`);
  return person;
}

export async function update(args, io) {
  const id = positional(args, 0, "dataops speakers update <person-id> ...");
  const api = apiFor(args);
  const current = await api.get(`/api/people/${enc(id)}`);
  const body = speakerBody(args, current);
  if (!Object.keys(body).length) {
    throw new UsageError("Nothing to change. See `dataops speakers --help`.");
  }
  if (body.links) body.links = Object.fromEntries(Object.entries(body.links).filter(([, value]) => value));
  const person = await api.put(`/api/people/${enc(id)}`, { ...body, version: current.version });
  if (args.json) return person;
  io.print(`Updated speaker ${person.id}: ${person.name} (${person.slug}).`);
  return person;
}

export const commands = {
  list,
  show,
  create,
  update,
};
