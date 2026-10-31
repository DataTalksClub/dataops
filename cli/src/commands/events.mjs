import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { UsageError } from "../errors.mjs";
import { enc, fields, isoDate, optionalString, positional, table } from "../format.mjs";
import { apiFor } from "../session.mjs";

export const summary = "Past events archive (workshops, webinars, launches, Luma copy, recordings)";

export const help = `dataops events - the past events archive (Luma descriptions, speakers, recordings)

Usage
  dataops events list [--course COURSE] [--date YYYY-MM-DD|YYYY-MM|YYYY]
      [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--type TYPE]
      [--speaker NAME] [--search TEXT]
  dataops events show <id-or-slug>
  dataops events create --title TITLE --date YYYY-MM-DD [--course COURSE]
      [--series SERIES] [--module MODULE] [--related-course TEXT]
      [--type TYPE] [--time TIME] [--speakers "Name, Name"]
      [--luma-url URL] [--recording-url URL] [--registrations N]
      [--slug SLUG] [--description TEXT | --description-file PATH | --file PATH]
  dataops events update <id-or-slug> [same flags as create]
      ("none" clears an optional field)
  dataops events delete <id-or-slug>
  dataops events import <folder-or-file> [--events-yaml PATH] [--course COURSE]
`;

const MONTHS = {
  january: "01",
  february: "02",
  march: "03",
  april: "04",
  may: "05",
  june: "06",
  july: "07",
  august: "08",
  september: "09",
  october: "10",
  november: "11",
  december: "12",
};

export function parseSpeakers(value) {
  if (Array.isArray(value)) {
    return value.map((s) => String(s).trim()).filter(Boolean);
  }
  return String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseHumanOrIsoDate(raw, label = "date") {
  const text = String(raw || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return isoDate(text, label);
  }
  // Matches e.g. "Monday, August 11, 2025" or "August 11, 2025"
  const match = text.match(/^(?:[A-Za-z]+,\s*)?([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (match) {
    const month = MONTHS[match[1].toLowerCase()];
    if (month) {
      const day = String(Number(match[2])).padStart(2, "0");
      return isoDate(`${match[3]}-${month}-${day}`, label);
    }
  }
  throw new UsageError(`Invalid --${label} "${raw}". Expected YYYY-MM-DD.`);
}

export function lumaShortSlug(url) {
  if (!url) return "";
  try {
    const parsed = new URL(String(url).trim());
    return parsed.pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Parse a simple `_data/events.yaml` file for `link:` -> `youtube:` pairs
 * without requiring a YAML dependency in the CLI.
 */
export function parseEventsYamlRecordingMap(yamlText) {
  const map = new Map();
  const blocks = String(yamlText || "").split(/\n(?=-\s+time:|\s*-\s+title:)/);
  for (const block of blocks) {
    const linkMatch = block.match(/^\s*link:\s*(\S+)\s*$/m);
    const ytMatch = block.match(/^\s*youtube:\s*(\S+)\s*$/m);
    if (linkMatch && ytMatch) {
      const slug = lumaShortSlug(linkMatch[1]);
      const yt = ytMatch[1].trim();
      if (slug && yt.startsWith("https://")) {
        map.set(slug, yt);
      }
    }
  }
  return map;
}

export function parseEventMarkdown(
  markdown,
  { filePath = "", series = undefined, course = undefined, recordingMap = undefined } = {},
) {
  const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  let idx = 0;
  while (idx < lines.length && !lines[idx].trim()) idx += 1;

  let title = "";
  if (idx < lines.length && lines[idx].startsWith("# ")) {
    title = lines[idx].slice(2).trim();
    idx += 1;
  }

  while (idx < lines.length && !lines[idx].trim()) idx += 1;

  const meta = {};
  while (idx < lines.length && lines[idx].startsWith("- **")) {
    const m = lines[idx].match(/^- \*\*([^:]+):\*\*\s*(.*)$/);
    if (!m) break;
    meta[m[1].trim().toLowerCase()] = m[2].trim();
    idx += 1;
  }

  while (idx < lines.length && !lines[idx].trim()) idx += 1;
  const description = lines.slice(idx).join("\n").trim();

  const baseName = filePath ? path.basename(filePath, path.extname(filePath)) : "";
  const fileDatePrefix = /^\d{4}-\d{2}-\d{2}/.test(baseName) ? baseName.slice(0, 10) : "";
  const slug =
    baseName && /^[a-z0-9][a-z0-9-]{0,199}$/i.test(baseName) ? baseName.toLowerCase() : undefined;

  if (!title && baseName) {
    title = baseName.replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/-/g, " ");
  }
  if (!title) {
    throw new UsageError(`Missing "# Title" heading${filePath ? ` in ${filePath}` : ""}.`);
  }

  const dateRaw = meta.date || fileDatePrefix;
  if (!dateRaw) {
    throw new UsageError(`Missing Date metadata or YYYY-MM-DD filename prefix${filePath ? ` in ${filePath}` : ""}.`);
  }
  const date = parseHumanOrIsoDate(dateRaw, "date");

  let parsedCourse = course || meta.course || undefined;
  let parsedModule = meta.module || undefined;
  if (parsedCourse && !parsedModule) {
    const commaIdx = parsedCourse.indexOf(",");
    if (commaIdx > 0) {
      const rest = parsedCourse.slice(commaIdx + 1).trim();
      if (/^(module\b|docker\s+module\b|bonus\s+module\b)/i.test(rest)) {
        parsedModule = rest;
        parsedCourse = parsedCourse.slice(0, commaIdx).trim();
      }
    }
  }

  const lumaUrl = meta.luma || meta["luma url"] || undefined;
  let recordingUrl =
    meta.recording || meta["recording url"] || meta.youtube || meta["youtube url"] || undefined;
  if (!recordingUrl && lumaUrl && recordingMap instanceof Map) {
    recordingUrl = recordingMap.get(lumaShortSlug(lumaUrl));
  }

  const speakersRaw = meta.instructor || meta.instructors || meta.speaker || meta.speakers || "";
  const speakers = parseSpeakers(speakersRaw);

  let registrations;
  if (meta.registrations !== undefined && meta.registrations !== "") {
    const num = Number.parseInt(meta.registrations, 10);
    if (Number.isInteger(num) && num >= 0) registrations = num;
  }

  return {
    title,
    ...(slug ? { slug } : {}),
    date,
    ...(meta.time ? { time: meta.time } : {}),
    ...(meta.type ? { type: meta.type } : {}),
    ...(parsedCourse ? { course: parsedCourse } : {}),
    ...(series ? { series } : {}),
    ...(parsedModule ? { module: parsedModule } : {}),
    ...(meta["related course"] ? { relatedCourse: meta["related course"] } : {}),
    ...(lumaUrl ? { lumaUrl } : {}),
    ...(recordingUrl ? { recordingUrl } : {}),
    speakers,
    description,
    ...(registrations !== undefined ? { registrations } : {}),
  };
}

export function collectMarkdownFiles(targetPath) {
  const resolved = path.resolve(String(targetPath));
  let stat;
  try {
    stat = statSync(resolved);
  } catch {
    throw new UsageError(`Path not found: ${targetPath}`);
  }
  if (stat.isFile()) {
    return [{ filePath: resolved, series: undefined }];
  }
  const results = [];
  function walk(dir, relativeSeries) {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, relativeSeries || entry.name);
      } else if (
        entry.isFile() &&
        entry.name.toLowerCase().endsWith(".md") &&
        entry.name.toLowerCase() !== "readme.md"
      ) {
        results.push({ filePath: full, series: relativeSeries });
      }
    }
  }
  walk(resolved, undefined);
  return results;
}

function eventBody(args) {
  const fileFlag = optionalString(args, "file");
  const body = fileFlag
    ? parseEventMarkdown(readFileSync(fileFlag, "utf8"), { filePath: fileFlag })
    : {};

  for (const [flag, key] of [
    ["title", "title"],
    ["slug", "slug"],
    ["time", "time"],
    ["type", "type"],
    ["course", "course"],
    ["series", "series"],
    ["module", "module"],
    ["relatedCourse", "relatedCourse"],
  ]) {
    const val = optionalString(args, flag);
    if (val !== undefined) body[key] = val === "none" ? null : val;
  }

  const lumaVal = optionalString(args, "lumaUrl") ?? optionalString(args, "luma");
  if (lumaVal !== undefined) body.lumaUrl = lumaVal === "none" ? null : lumaVal;

  const recVal =
    optionalString(args, "recordingUrl") ??
    optionalString(args, "recording") ??
    optionalString(args, "youtube");
  if (recVal !== undefined) body.recordingUrl = recVal === "none" ? null : recVal;

  const dateVal = optionalString(args, "date");
  if (dateVal !== undefined) {
    body.date = parseHumanOrIsoDate(dateVal, "date");
  }

  const speakersVal =
    optionalString(args, "speakers") ??
    optionalString(args, "speaker") ??
    optionalString(args, "instructor");
  if (speakersVal !== undefined) {
    body.speakers = speakersVal === "none" ? [] : parseSpeakers(speakersVal);
  }

  const regVal = optionalString(args, "registrations");
  if (regVal !== undefined) {
    if (regVal === "none") {
      body.registrations = null;
    } else {
      const parsed = Number.parseInt(regVal, 10);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new UsageError("--registrations must be a non-negative integer.");
      }
      body.registrations = parsed;
    }
  }

  const descFile = optionalString(args, "descriptionFile");
  const descText = optionalString(args, "description");
  if (descFile !== undefined) {
    body.description = readFileSync(descFile, "utf8");
  } else if (descText !== undefined) {
    body.description = descText === "none" ? "" : descText;
  }

  return body;
}

export async function list(args, io) {
  const query = {};
  const course = optionalString(args, "course") ?? optionalString(args, "series");
  if (course) query.course = course;
  const date = optionalString(args, "date");
  if (date) query.date = date;
  const from = optionalString(args, "from");
  if (from) query.from = isoDate(from, "from");
  const to = optionalString(args, "to");
  if (to) query.to = isoDate(to, "to");
  const type = optionalString(args, "type");
  if (type) query.type = type;
  const speaker = optionalString(args, "speaker");
  if (speaker) query.speaker = speaker;
  const search = optionalString(args, "search") ?? optionalString(args, "q");
  if (search) query.search = search;

  const result = await apiFor(args).get("/api/event-records", { query });
  if (args.json) return result;
  table(
    io,
    result.items || [],
    [
      ["ID", (ev) => ev.id],
      ["DATE", (ev) => ev.date || ""],
      ["COURSE", (ev) => ev.course || ev.series || ""],
      ["TYPE", (ev) => ev.type || ""],
      ["SPEAKERS", (ev) => (ev.speakers || []).join(", ")],
      ["TITLE", (ev) => ev.title || ""],
    ],
    "No past events.",
  );
  return result;
}

export async function show(args, io) {
  const id = positional(args, 0, "dataops events show <id-or-slug>");
  const ev = await apiFor(args).get(`/api/event-records/${enc(id)}`);
  if (args.json) return ev;
  fields(io, [
    ["id", ev.id],
    ["title", ev.title],
    ["slug", ev.slug],
    ["date", ev.date],
    ["time", ev.time],
    ["type", ev.type],
    ["course", ev.course],
    ["series", ev.series],
    ["module", ev.module],
    ["relatedCourse", ev.relatedCourse],
    ["speakers", (ev.speakers || []).join(", ")],
    ["luma", ev.lumaUrl],
    ["recording", ev.recordingUrl],
    ["registrations", ev.registrations],
    ["version", ev.version],
  ]);
  if (ev.description) {
    io.print("");
    io.print(ev.description);
  }
  return ev;
}

export async function create(args, io) {
  const body = eventBody(args);
  if (!body.title) throw new UsageError("--title is required.");
  if (!body.date) throw new UsageError("--date YYYY-MM-DD is required.");
  if (!body.speakers) body.speakers = [];
  if (body.description === undefined) body.description = "";
  const ev = await apiFor(args).post("/api/event-records", body);
  if (args.json) return ev;
  io.print(`Created event ${ev.id}: ${ev.date} ${ev.title}.`);
  return ev;
}

export async function update(args, io) {
  const id = positional(args, 0, "dataops events update <id-or-slug> ...");
  const api = apiFor(args);
  const current = await api.get(`/api/event-records/${enc(id)}`);
  const body = eventBody(args);
  if (!Object.keys(body).length) {
    throw new UsageError("Nothing to change. See `dataops events --help`.");
  }
  const ev = await api.put(`/api/event-records/${enc(current.id)}`, {
    ...body,
    version: current.version,
  });
  if (args.json) return ev;
  io.print(`Updated event ${ev.id}: ${ev.date} ${ev.title}.`);
  return ev;
}

export async function remove(args, io) {
  const id = positional(args, 0, "dataops events delete <id-or-slug>");
  const api = apiFor(args);
  const current = await api.get(`/api/event-records/${enc(id)}`);
  await api.delete(`/api/event-records/${enc(current.id)}`, { version: current.version });
  const out = { deleted: current.id, title: current.title };
  if (args.json) return out;
  io.print(`Deleted event ${current.id}: ${current.title}.`);
  return out;
}

export async function importEvents(args, io) {
  const targetPath = positional(
    args,
    0,
    "dataops events import <folder-or-file> [--events-yaml PATH] [--course COURSE]",
  );
  const courseOverride = optionalString(args, "course");
  const eventsYamlPath = optionalString(args, "eventsYaml");
  const recordingMap = eventsYamlPath
    ? parseEventsYamlRecordingMap(readFileSync(eventsYamlPath, "utf8"))
    : undefined;

  const files = collectMarkdownFiles(targetPath);
  if (!files.length) {
    throw new UsageError(`No Markdown event files found in ${targetPath}.`);
  }

  const items = files.map(({ filePath, series }) =>
    parseEventMarkdown(readFileSync(filePath, "utf8"), {
      filePath,
      series,
      course: courseOverride,
      recordingMap,
    }),
  );

  const result = await apiFor(args).post("/api/event-records/import", { items });
  if (args.json) return result;
  io.print(
    `Imported ${result.total} event(s) (${result.created} created, ${result.updated} updated, ${result.unchanged} unchanged).`,
  );
  return result;
}

export const commands = {
  list,
  show,
  create,
  update,
  delete: remove,
  import: importEvents,
};
