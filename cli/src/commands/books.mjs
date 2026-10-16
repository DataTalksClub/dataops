import { UsageError } from "../errors.mjs";
import { enc, fields, isoDate, optionalString, positional, table } from "../format.mjs";
import { apiFor } from "../session.mjs";

export const summary = "Book of the Week pages (the _books register)";

export const help = `dataops books - the Book of the Week register behind _books pages

Usage
  dataops books list
  dataops books show <book-id>
  dataops books create --title TITLE [--slug SLUG] [--authors "Name[:slug],Name"]
      [--description TEXT] [--start-date YYYY-MM-DD] [--end-date YYYY-MM-DD]
      [--cover-url URL] [--link "Text=URL" ...]
  dataops books update <book-id> [same flags as create]
                                  "none" clears the slug, description, a date,
                                  the cover or the authors; --link "Text=none"
                                  removes one labeled link
`;

/** "Jane Doe:jane-doe, Bob" -> [{ name: "Jane Doe", slug: "jane-doe" }, { name: "Bob" }] */
export function parseAuthors(value) {
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

/** `--link "Text=URL"` upserts by text; `--link "Text=none"` removes it. */
function linkChanges(args, current = []) {
  if (args.link === undefined) return undefined;
  const links = [...current];
  for (const value of Array.isArray(args.link) ? args.link : [args.link]) {
    const text = String(value);
    const at = text.indexOf("=");
    if (at < 1) throw new UsageError(`--link takes Text=URL, got "${text}".`);
    const name = text.slice(0, at).trim();
    const url = text.slice(at + 1).trim();
    const index = links.findIndex((link) => link.text === name);
    if (index >= 0) links.splice(index, 1);
    if (url !== "none") links.push({ text: name, url });
  }
  return links;
}

function bookBody(args, current = {}) {
  const body = {};
  for (const [flag, key] of [["title", "title"], ["slug", "slug"], ["description", "description"], ["coverUrl", "coverUrl"]]) {
    const value = optionalString(args, flag);
    if (value !== undefined) body[key] = value === "none" ? null : value;
  }
  for (const [flag, key] of [["startDate", "startDate"], ["endDate", "endDate"]]) {
    const value = optionalString(args, flag);
    if (value === undefined) continue;
    body[key] = value === "none" ? null : isoDate(value, "start-date");
  }
  const authors = optionalString(args, "authors");
  if (authors !== undefined) body.authors = authors === "none" ? [] : parseAuthors(authors);
  const links = linkChanges(args, current.links || []);
  if (links !== undefined) body.links = links;
  return body;
}

export async function list(args, io) {
  const result = await apiFor(args).get("/api/books");
  if (args.json) return result;
  table(io, result.items || [], [
    ["ID", (book) => book.id],
    ["WEEK", (book) => book.startDate || ""],
    ["AUTHORS / TITLE", (book) => [(book.authors || []).map((author) => author.name).join(", "), book.title].filter(Boolean).join(" - ")],
  ], "No books.");
  return result;
}

export async function show(args, io) {
  const id = positional(args, 0, "dataops books show <book-id>");
  const book = await apiFor(args).get(`/api/books/${enc(id)}`);
  if (args.json) return book;
  fields(io, [
    ["id", book.id],
    ["title", book.title],
    ["slug", book.slug],
    ["authors", (book.authors || []).map((author) => (author.slug ? `${author.name} (${author.slug})` : author.name))],
    ["start", book.startDate],
    ["end", book.endDate],
    ["description", book.description ? `${book.description.length} chars` : ""],
    ["cover", book.coverUrl],
    ["links", (book.links || []).map((link) => `${link.text}=${link.url}`)],
    ["version", book.version],
  ]);
  return book;
}

export async function create(args, io) {
  const body = bookBody(args);
  if (!body.title) throw new UsageError("--title is required.");
  if (!body.authors) body.authors = [];
  const book = await apiFor(args).post("/api/books", body);
  if (args.json) return book;
  io.print(`Created book ${book.id}: ${book.title}.`);
  return book;
}

export async function update(args, io) {
  const id = positional(args, 0, "dataops books update <book-id> ...");
  const api = apiFor(args);
  const current = await api.get(`/api/books/${enc(id)}`);
  const body = bookBody(args, current);
  if (!Object.keys(body).length) {
    throw new UsageError("Nothing to change. See `dataops books --help`.");
  }
  const book = await api.put(`/api/books/${enc(id)}`, { ...body, version: current.version });
  if (args.json) return book;
  io.print(`Updated book ${book.id}: ${book.title}.`);
  return book;
}

export const commands = {
  list,
  show,
  create,
  update,
};
