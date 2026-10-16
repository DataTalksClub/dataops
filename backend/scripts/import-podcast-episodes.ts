/**
 * Import the podcast episode register from its three sources.
 *
 *   1. Website (`<repo>/_podcast/*.md` front matter, guests resolved through
 *      `_people/*.md`) is primary for published episodes. Season and episode
 *      numbers always come from the website.
 *   2. The schedule sheet (read by import-calendar.ts). "Extra podcast
 *      slots" is the register: it adds recording dates to published episodes
 *      (matched by season/episode, else guest and date) and contributes
 *      upcoming episodes (booked / recorded). "Time table" is the weekly plan
 *      and never creates an episode: a row only confirms the episode recorded
 *      that week, or dates a published episode that has no recording date.
 *      The host (`--hosts "Name,Name"`) is never a guest.
 *   3. The RSS feed only fills missing anchor/spotify/apple links. Numbering
 *      that disagrees with the website is reported, never stored.
 *
 * Existing episodes are matched by websiteSlug, then scheduleSourceKey, then
 * (normalized guest name, recording within ±60 days of release). Register
 * episodes nothing matches are listed as `registerUnmatched`. The importer
 * never creates Cards and never deletes.
 *
 * Dry run is the default and prints the report to stdout; nothing is written
 * to disk. `--write` goes through the API and requires PODCAST_IMPORT_API,
 * PODCAST_IMPORT_TOKEN and PODCAST_IMPORT_CONFIRM (equal to the API URL).
 *
 *   tsx scripts/import-podcast-episodes.ts --website ../datatalksclub.github.io \
 *     --schedule <schedule.xlsx> --rss <feed.xml> --hosts "Host Name" [--write]
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

import { readPodcastSchedule, type PodcastScheduleRow } from "./import-calendar";

const LINK_KINDS = ["youtube", "spotify", "apple", "anchor", "website"] as const;
type LinkKind = (typeof LINK_KINDS)[number];
type Links = Partial<Record<LinkKind, string>>;
type Guest = { name: string; slug?: string };
const STATUS_RANK = ["booked", "recorded", "edited", "scheduled", "published"];
const MATCH_DAYS = 60;
const SAME_RECORDING_DAYS = 21;
/** A Time table row's date and the episode recorded that week. */
const WEEK_DAYS = 6;

export type WebsiteEpisode = {
  slug: string;
  season: number | null;
  episode: number | null;
  title: string;
  /** The website's short title; schedule and RSS titles usually equal it. */
  short: string | null;
  guests: Guest[];
  releaseDate: string | null;
  links: Links;
  anchorId: string | null;
};
export type RssItem = {
  title: string;
  link: string;
  pubDate: string | null;
  season: number | null;
  episode: number | null;
  anchorId: string | null;
};
export type DesiredEpisode = {
  source: "website" | "schedule";
  season?: number | null;
  episode?: number | null;
  title?: string;
  guests: Guest[];
  recordingDate?: string;
  releaseDate?: string;
  status: string;
  links?: Links;
  websiteSlug?: string;
  scheduleSourceKey?: string;
};
export type ExistingEpisode = DesiredEpisode & {
  id: string;
  version: number;
  cardId?: string | null;
  notes?: string | null;
};

export const normalizeName = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const days = (left: string, right: string) =>
  Math.abs(Date.parse(`${left}T00:00:00Z`) - Date.parse(`${right}T00:00:00Z`)) / 86_400_000;
const isoDate = (value: unknown) => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const text = String(value ?? "");
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
};
const httpsLink = (value: unknown) =>
  typeof value === "string" && /^https:\/\//.test(value) ? value : null;
/** Anchor episode ids are the last path segment of an anchor/podcasters URL. */
const anchorIdOf = (url: string | null | undefined) =>
  url ? decodeURIComponent(url.replace(/\/+$/, "").split("/").pop() || "") || null : null;
/** Guest names in "Title - Ada Example and Grace Sample" style text. */
const guestNames = (value: string) =>
  value.split(/\s*(?:&|,|\band\b)\s*/).map((name) => ({ name: name.trim() })).filter((guest) => guest.name);
/**
 * A website episode without a release date (newer pages omit `dateadded`)
 * can only be matched by title: its title or short title must equal `title`.
 */
const sameTitle = (site: Pick<WebsiteEpisode, "title" | "short">, title: string | undefined) =>
  Boolean(title) &&
  [site.title, site.short].some((value) => value && normalizeName(value) === normalizeName(title!));
/** A guest name with transliteration variants folded: Aleksandr = Alexander. */
export const nameKey = (value: string) =>
  normalizeName(value).replace(/ks/g, "x").replace(/andr\b/g, "ander");
const sameGuest = (left: Guest[], right: Guest[]) => {
  const names = new Set(left.map((guest) => nameKey(guest.name)));
  return right.some((guest) => names.has(nameKey(guest.name)));
};
const asGuests = (row: PodcastScheduleRow) => row.guests.map((name) => ({ name }));

function frontMatter(file: string): Record<string, any> {
  const source = readFileSync(file, "utf8");
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  try {
    return (yaml.load(match[1]) as Record<string, any>) || {};
  } catch {
    // Template pages (Liquid inside front matter) are not data.
    return {};
  }
}

export function readWebsiteEpisodes(repo: string): WebsiteEpisode[] {
  const people = new Map<string, string>();
  const peopleDir = path.join(repo, "_people");
  if (existsSync(peopleDir))
    for (const file of readdirSync(peopleDir).filter((name) => name.endsWith(".md"))) {
      const meta = frontMatter(path.join(peopleDir, file));
      people.set(file.replace(/\.md$/, ""), String(meta.title || meta.name || "").trim());
    }
  const dir = path.join(repo, "_podcast");
  // Jekyll does not publish files whose name starts with "_" (drafts and the
  // episode template), so they are not episodes.
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md") && !name.startsWith("_"))
    .sort()
    .map((file) => {
      const meta = frontMatter(path.join(dir, file));
      const slug = file.replace(/\.md$/, "");
      const links: Links = {};
      for (const kind of LINK_KINDS) {
        const url = httpsLink(meta.links?.[kind]);
        if (url) links[kind] = url;
      }
      links.website = `https://datatalks.club/podcast/${slug}.html`;
      return {
        slug,
        season: Number.isSafeInteger(meta.season) ? meta.season : null,
        episode: Number.isSafeInteger(meta.episode) ? meta.episode : null,
        title: String(meta.title || meta.short || slug).trim(),
        short: meta.short ? String(meta.short).trim() : null,
        guests: (Array.isArray(meta.guests) ? meta.guests : []).map((guest: unknown) => {
          const guestSlug = String(guest);
          return { name: people.get(guestSlug) || guestSlug, slug: guestSlug };
        }),
        releaseDate: isoDate(meta.dateadded),
        links,
        anchorId: meta.ids?.anchor ? String(meta.ids.anchor) : anchorIdOf(links.anchor),
      };
    });
}

const tag = (block: string, name: string) => {
  const match = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return match ? match[1].replace(/^<!\[CDATA\[|\]\]>$/g, "").trim() : "";
};

export function parseRss(xml: string): RssItem[] {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, block]) => {
    const link = tag(block, "link");
    const pub = tag(block, "pubDate");
    const season = Number(tag(block, "itunes:season"));
    const episode = Number(tag(block, "itunes:episode"));
    return {
      title: tag(block, "title"),
      link,
      pubDate: pub && !Number.isNaN(Date.parse(pub)) ? new Date(pub).toISOString().slice(0, 10) : null,
      season: Number.isSafeInteger(season) && season > 0 ? season : null,
      episode: Number.isSafeInteger(episode) && episode > 0 ? episode : null,
      anchorId: anchorIdOf(link),
    };
  });
}

export const scheduleSourceKey = (row: PodcastScheduleRow) =>
  createHash("sha256")
    .update(`podcast-schedule:${row.sheet}:${row.recordingDate}:${normalizeName(row.guests[0])}`)
    .digest("hex")
    .slice(0, 40);

export function mergeSources(input: {
  website: WebsiteEpisode[];
  schedule: PodcastScheduleRow[];
  rss: RssItem[];
  today: string;
  /** The podcast host(s): never a guest. */
  hosts?: string[];
}) {
  const where = (row: PodcastScheduleRow) => `${row.sheet}!${row.row}`;
  const report = {
    website: input.website.length,
    scheduleRows: input.schedule.length,
    rssItems: input.rss.length,
    rssLinksFilled: 0,
    numberingConflicts: [] as Array<{ websiteSlug: string; website: string; rss: string }>,
    rssUnmatched: [] as string[],
    scheduleMatched: 0,
    scheduleDuplicateRows: 0,
    scheduleHostRows: [] as string[],
    timetableMatched: 0,
    timetableRecordingDates: 0,
    timetableUnmatched: [] as string[],
    scheduleUnmatchedHistory: 0,
    scheduleNotBooked: [] as string[],
    scheduleCancelled: [] as string[],
    scheduleAmbiguous: [] as string[],
    publishedWithoutReleaseDate: input.website.filter((site) => !site.releaseDate).length,
  };
  /** Classify a schedule row that is not a booked recording; true when it is not one. */
  const unbooked = (row: PodcastScheduleRow) => {
    if (row.hidden) report.scheduleUnmatchedHistory++;
    else if (row.status.includes("cancel")) report.scheduleCancelled.push(where(row));
    else if (!row.status.includes("confirm")) report.scheduleNotBooked.push(where(row));
    else return false;
    return true;
  };
  const episodes: DesiredEpisode[] = input.website.map((site) => ({
    source: "website",
    season: site.season,
    episode: site.episode,
    title: site.title,
    guests: site.guests,
    ...(site.releaseDate ? { releaseDate: site.releaseDate } : {}),
    status: "published",
    links: { ...site.links },
    websiteSlug: site.slug,
  }));
  const bySlug = new Map(episodes.map((episode) => [episode.websiteSlug!, episode]));
  const sites = new Map(input.website.map((site) => [site.slug, site]));

  // RSS: fill missing links, report numbering conflicts.
  const byAnchor = new Map(
    input.website.filter((site) => site.anchorId).map((site) => [site.anchorId!, site]),
  );
  for (const item of input.rss) {
    const split = Math.max(item.title.lastIndexOf(" - "), item.title.lastIndexOf(" \u2013 "));
    const guests = split > 0 ? guestNames(item.title.slice(split + 3)) : [];
    const head = split > 0 ? item.title.slice(0, split) : item.title;
    const site =
      (item.anchorId && byAnchor.get(item.anchorId)) ||
      input.website.find(
        (candidate) =>
          guests.length > 0 &&
          sameGuest(candidate.guests, guests) &&
          (candidate.releaseDate
            ? Boolean(item.pubDate) && days(candidate.releaseDate, item.pubDate!) <= 14
            : sameTitle(candidate, head)),
      );
    if (!site) {
      report.rssUnmatched.push(item.title);
      continue;
    }
    const episode = bySlug.get(site.slug)!;
    if (!episode.links!.anchor && item.link) {
      episode.links!.anchor = item.link;
      report.rssLinksFilled++;
    }
    if (
      item.season !== null &&
      item.episode !== null &&
      (item.season !== site.season || item.episode !== site.episode)
    )
      report.numberingConflicts.push({
        websiteSlug: site.slug,
        website: `S${site.season}E${site.episode}`,
        rss: `S${item.season}E${item.episode}`,
      });
  }

  // The host appears in schedule cells (a week's workshop, a solo
  // recording) but is never a guest.
  const hosts = new Set((input.hosts || []).map(nameKey));
  const rows: PodcastScheduleRow[] = [];
  for (const row of input.schedule) {
    const guests = row.guests.filter((name) => !hosts.has(nameKey(name)));
    if (guests.length) rows.push({ ...row, guests });
    else if (!row.hidden) report.scheduleHostRows.push(where(row));
  }

  // "Extra podcast slots" is the episode register: recording dates for
  // published episodes, upcoming episodes otherwise. A row with a season and
  // episode matches that website episode; otherwise guest and date. Twin rows
  // for one recording keep the titled one.
  const kept: PodcastScheduleRow[] = [];
  const extra = rows.filter((row) => row.sheet === "Extra podcast slots");
  for (const row of extra.sort((left, right) => (right.title ? 1 : 0) - (left.title ? 1 : 0))) {
    const twin = kept.find(
      (other) =>
        sameGuest(asGuests(other), asGuests(row)) &&
        days(other.recordingDate, row.recordingDate) <= SAME_RECORDING_DAYS,
    );
    if (twin) report.scheduleDuplicateRows++;
    else kept.push(row);
  }
  kept.sort((left, right) => left.recordingDate.localeCompare(right.recordingDate));
  const claimed = new Map<string, { days: number; row: PodcastScheduleRow }>();
  const unmatched: PodcastScheduleRow[] = [];
  for (const row of kept) {
    const numbered = episodes.filter(
      (episode) =>
        row.season !== undefined &&
        row.episode !== undefined &&
        episode.season === row.season &&
        episode.episode === row.episode,
    );
    const candidates = (
      numbered.length === 1
        ? numbered
        : episodes.filter(
            (episode) =>
              episode.source === "website" &&
              sameGuest(episode.guests, asGuests(row)) &&
              (episode.releaseDate
                ? days(episode.releaseDate, row.recordingDate) <= MATCH_DAYS
                : sameTitle(sites.get(episode.websiteSlug!)!, row.title)),
          )
    )
      .map((episode) => ({
        episode,
        days: numbered.length === 1 || !episode.releaseDate ? 0 : days(episode.releaseDate, row.recordingDate),
      }))
      .sort((left, right) => left.days - right.days);
    if (candidates.length === 0) {
      unmatched.push(row);
      continue;
    }
    const best = candidates[0];
    const previous = claimed.get(best.episode.websiteSlug!);
    if (previous && previous.days <= best.days) {
      report.scheduleAmbiguous.push(where(row));
      continue;
    }
    if (previous) report.scheduleAmbiguous.push(where(previous.row));
    claimed.set(best.episode.websiteSlug!, { days: best.days, row });
  }
  for (const [slug, { row }] of claimed) {
    const episode = bySlug.get(slug)!;
    episode.recordingDate = row.recordingDate;
    episode.scheduleSourceKey = scheduleSourceKey(row);
    report.scheduleMatched++;
  }
  for (const row of unmatched) {
    if (!unbooked(row))
      episodes.push({
        source: "schedule",
        ...(row.title ? { title: row.title } : {}),
        guests: asGuests(row),
        recordingDate: row.recordingDate,
        status: row.recordingDate >= input.today ? "booked" : "recorded",
        scheduleSourceKey: scheduleSourceKey(row),
      });
  }

  // "Time table" is the weekly plan: it never creates an episode. A row
  // confirms the episode recorded within its week (sharing a guest, or on the
  // same day), and otherwise gives a published website episode without a
  // recording date its recording date (same guest, released within
  // MATCH_DAYS after).
  const dated: string[] = [];
  for (const row of rows
    .filter((row) => row.sheet === "Time table")
    .sort((left, right) => left.recordingDate.localeCompare(right.recordingDate))) {
    const week = episodes.filter(
      (episode) => episode.recordingDate && days(episode.recordingDate, row.recordingDate) <= WEEK_DAYS,
    );
    const named = week.filter((episode) => sameGuest(episode.guests, asGuests(row)));
    const match = named.length ? named : week.filter((episode) => episode.recordingDate === row.recordingDate);
    if (match.length === 1) {
      report.timetableMatched++;
      continue;
    }
    if (match.length > 1) {
      report.scheduleAmbiguous.push(where(row));
      continue;
    }
    const published = episodes
      .filter(
        (episode) =>
          episode.source === "website" &&
          !episode.recordingDate &&
          episode.releaseDate &&
          episode.releaseDate >= row.recordingDate &&
          days(episode.releaseDate, row.recordingDate) <= MATCH_DAYS &&
          sameGuest(episode.guests, asGuests(row)),
      )
      .sort((left, right) => left.releaseDate!.localeCompare(right.releaseDate!));
    if (published.length) {
      published[0].recordingDate = row.recordingDate;
      dated.push(published[0].websiteSlug!);
      report.timetableMatched++;
      continue;
    }
    if (!unbooked(row)) report.timetableUnmatched.push(where(row));
  }
  report.timetableRecordingDates = dated.length;
  return { episodes, report };
}

/** The register episode a desired episode updates, by the documented match order. */
function findExisting(desired: DesiredEpisode, existing: ExistingEpisode[]) {
  return (
    (desired.websiteSlug && existing.find((episode) => episode.websiteSlug === desired.websiteSlug)) ||
    (desired.scheduleSourceKey &&
      existing.find((episode) => episode.scheduleSourceKey === desired.scheduleSourceKey)) ||
    existing.find((episode) => {
      if (!sameGuest(episode.guests || [], desired.guests)) return false;
      const recording = desired.recordingDate || episode.recordingDate;
      const release = desired.releaseDate || episode.releaseDate;
      if (desired.recordingDate && episode.recordingDate)
        return days(desired.recordingDate, episode.recordingDate) <= MATCH_DAYS;
      return Boolean(recording && release && days(recording, release) <= MATCH_DAYS);
    }) ||
    null
  );
}

/** Field changes the importer owns; Card links, notes and later statuses are kept. */
function changesFor(desired: DesiredEpisode, current: ExistingEpisode) {
  const changes: Record<string, unknown> = {};
  const set = (name: keyof DesiredEpisode, value: unknown) => {
    if (value !== undefined && JSON.stringify((current as any)[name]) !== JSON.stringify(value))
      changes[name] = value;
  };
  if (desired.source === "website") {
    set("season", desired.season);
    set("episode", desired.episode);
    set("title", desired.title);
    set("guests", desired.guests);
    set("releaseDate", desired.releaseDate);
    set("websiteSlug", desired.websiteSlug);
  } else {
    if (!current.title) set("title", desired.title);
    if (!current.guests?.length) set("guests", desired.guests);
  }
  set("recordingDate", desired.recordingDate);
  set("scheduleSourceKey", desired.scheduleSourceKey);
  if (desired.links) set("links", { ...(current.links || {}), ...desired.links });
  if (
    current.status !== "cancelled" &&
    STATUS_RANK.indexOf(desired.status) > STATUS_RANK.indexOf(current.status)
  )
    set("status", desired.status);
  return changes;
}

export function planWrites(desired: DesiredEpisode[], existing: ExistingEpisode[]) {
  const creates: DesiredEpisode[] = [];
  const updates: Array<{ id: string; version: number; changes: Record<string, unknown> }> = [];
  const conflicts: string[] = [];
  const used = new Map<string, DesiredEpisode>();
  let unchanged = 0;
  for (const episode of desired) {
    const current = findExisting(episode, existing);
    if (!current) {
      creates.push(episode);
      continue;
    }
    if (used.has(current.id)) {
      conflicts.push(
        `${episode.websiteSlug || episode.scheduleSourceKey} and ${used.get(current.id)!.websiteSlug || used.get(current.id)!.scheduleSourceKey} both match episode ${current.id}`,
      );
      continue;
    }
    used.set(current.id, episode);
    const changes = changesFor(episode, current);
    if (Object.keys(changes).length) updates.push({ id: current.id, version: current.version, changes });
    else unchanged++;
  }
  // Register episodes no source row accounts for: manual entries, or junk
  // and duplicates from an earlier import to review and delete.
  const unmatched = existing
    .filter((episode) => !used.has(episode.id))
    .map((episode) => ({
      id: episode.id,
      guests: (episode.guests || []).map((guest) => guest.name),
      recordingDate: episode.recordingDate || null,
      status: episode.status,
      cardId: episode.cardId || null,
    }));
  return { creates, updates, unchanged, conflicts, unmatched };
}

const body = (episode: DesiredEpisode) => {
  const { source: _source, ...fields } = episode;
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null && value !== undefined));
};

async function api(base: string, token: string, method: string, route: string, payload?: unknown) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  return { status: response.status, body: (await response.json().catch(() => null)) as any };
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : "";
  };
  const write = args.includes("--write");
  const website = option("--website") || path.resolve(__dirname, "../../../datatalksclub.github.io");
  const schedulePath = option("--schedule");
  const rssPath = option("--rss");
  const today = new Date().toISOString().slice(0, 10);
  const { episodes, report } = mergeSources({
    website: readWebsiteEpisodes(website),
    schedule: schedulePath ? await readPodcastSchedule(schedulePath) : [],
    rss: rssPath ? parseRss(readFileSync(rssPath, "utf8")) : [],
    today,
    hosts: option("--hosts").split(",").map((name) => name.trim()).filter(Boolean),
  });
  const base = (process.env.PODCAST_IMPORT_API || "").replace(/\/$/, "");
  const token = process.env.PODCAST_IMPORT_TOKEN || "";
  if (write && (!base || !token)) throw new Error("--write requires PODCAST_IMPORT_API and PODCAST_IMPORT_TOKEN");
  if (write && process.env.PODCAST_IMPORT_CONFIRM !== process.env.PODCAST_IMPORT_API)
    throw new Error("--write requires PODCAST_IMPORT_CONFIRM to equal PODCAST_IMPORT_API");
  let existing: ExistingEpisode[] = [];
  if (base && token) {
    const listed = await api(base, token, "GET", "/api/podcast-episodes");
    if (listed.status !== 200) throw new Error(`Listing episodes failed (${listed.status})`);
    existing = listed.body.items;
  }
  const plan = planWrites(episodes, existing);
  const summary = {
    mode: write ? "write" : "dry-run",
    target: base || "none (planned against an empty register)",
    ...report,
    desired: episodes.length,
    creates: plan.creates.length,
    updates: plan.updates.length,
    unchanged: plan.unchanged,
    matchConflicts: plan.conflicts,
    registerUnmatched: plan.unmatched,
  };
  if (!write) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  const failures: Array<{ key: string; status: number; error: string }> = [];
  for (const episode of plan.creates) {
    const result = await api(base, token, "POST", "/api/podcast-episodes", body(episode));
    if (result.status !== 201)
      failures.push({ key: String(episode.websiteSlug || episode.scheduleSourceKey), status: result.status, error: result.body?.error });
  }
  for (const update of plan.updates) {
    const result = await api(base, token, "PUT", `/api/podcast-episodes/${update.id}`, {
      version: update.version,
      ...update.changes,
    });
    if (result.status !== 200)
      failures.push({ key: update.id, status: result.status, error: result.body?.error });
  }
  console.log(JSON.stringify({ ...summary, failures }, null, 2));
  if (failures.length) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({ error: (error as Error).message }));
    process.exitCode = 1;
  });
}
