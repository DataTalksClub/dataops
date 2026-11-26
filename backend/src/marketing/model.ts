import { createHash } from "crypto";
import { isIP } from "node:net";
import vocabulary from "./metrics.json";
import { realDate } from "../sponsorCrm/model";

export { vocabulary };
export const WEEKLY_LIMIT = 2;
export type Dict = Record<string, any>;
export const BACKLINK_OUTREACH_STATES = [
  "not_contacted",
  "no_contact",
  "draft_provided",
  "publisher_contacted",
  "alexey_sent",
  "orin_sent",
  "added_confirmed",
  "already_present",
  "reciprocal_link",
  "mirror",
  "discovery_only",
] as const;
export type BacklinkOutreachState = (typeof BACKLINK_OUTREACH_STATES)[number];
export const BACKLINK_BUCKETS = [
  "added_follow",
  "added_qualified",
  "absent",
  "unavailable",
] as const;
export type BacklinkBucket = (typeof BACKLINK_BUCKETS)[number];
export interface TrackedSite extends Dict {
  domain: string;
  label?: string;
  notes?: string;
  active: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  updatedBy?: string;
}
export interface BacklinkCheck extends Dict {
  checkedAt: string;
  bucket: BacklinkBucket;
  httpStatus: number | null;
  finalUrl: string | null;
  matchedHref: string | null;
  matchedRel: string[];
  matchCount: number;
  pageNofollow?: boolean;
  pageNoindex?: boolean;
  pageRobotsDirectives?: string[];
  reason: string;
}
export interface BacklinkPair extends Dict {
  id: string;
  sourceUrl: string;
  targetUrl: string;
  outreachState: BacklinkOutreachState;
  owner?: string;
  notes?: string;
  latestCheck: BacklinkCheck | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  updatedBy?: string;
}
export interface Goal extends Dict {
  ref: string;
  title: string;
  metricKey: string;
  scope: string;
  source: string;
  baseline: { value: number; date: string; note: string } | null;
  target: { value: number; date: string } | null;
  window: "week" | "rolling28";
}
export interface Plan extends Dict {
  id: string;
  title: string;
  status: string;
  ownerId: string;
  tags: string[];
  goals: Goal[];
  notesLog: Dict[];
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface Step extends Dict {
  id: string;
  planId: string;
  title: string;
  kind: string;
  size: string;
  ownerId: string;
  goalRefs: string[];
  tags: string[];
  doneCriteria: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface Snapshot extends Dict {
  metricKey: string;
  scope: string;
  source: string;
  period: string;
  value: number;
  unit: string;
  observedAt?: string;
  evidenceUrl?: string;
  provider?: string;
  metricVersion?: string;
  details?: Record<string, string | number | boolean | null>;
  version: number;
}
export class MarketingError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export function requireThat(ok: unknown, message: string): asserts ok {
  if (!ok) throw new MarketingError(message);
}
export const slug = (v: unknown) =>
  typeof v === "string" && /^[a-z0-9][a-z0-9-]{2,47}$/.test(v);
const text = (v: unknown, max: number) =>
  typeof v === "string" && !!v.trim() && v.length <= max;
export const metric = (key: string) =>
  vocabulary.metrics.find((m) => m.key === key);
export function validSeries(s: Dict) {
  requireThat(s && typeof s === "object", "Series must be an object");
  const m = metric(s.metricKey);
  requireThat(m, `Unknown metricKey: ${s.metricKey}`);
  requireThat(m.sources.includes(s.source), `Invalid source for ${m.key}`);
  requireThat(
    text(s.scope, 2048) &&
      m.scopes.some((p) =>
        p === "site"
          ? s.scope === "site"
          : s.scope.startsWith(p) && s.scope.length > p.length,
      ),
    `Invalid scope for ${m.key}`,
  );
  return m;
}
export function validateGoal(g: Goal) {
  requireThat(
    g && typeof g === "object" && !Array.isArray(g),
    "Goal must be an object",
  );
  requireThat(slug(g.ref) && text(g.title, 300), "Invalid goal ref or title");
  validSeries(g);
  requireThat(["week", "rolling28"].includes(g.window), "Invalid goal window");
  if (g.baseline === null || g.target === null) {
    requireThat(
      g.baseline === null && g.target === null,
      "Defer both baseline and target until measurement and review",
    );
    return;
  }
  for (const k of ["baseline", "target"])
    requireThat(
      g[k] && Number.isFinite(g[k].value) && realDate(g[k].date),
      `Invalid ${k}`,
    );
  requireThat(text(g.baseline.note, 1000), "baseline.note is required");
  requireThat(g.target.date > g.baseline.date, "Target must follow baseline");
}
export function validatePlan(p: Plan) {
  requireThat(slug(p.id) && text(p.title, 300), "Invalid plan id or title");
  requireThat(
    ["draft", "active", "paused", "done"].includes(p.status),
    "Invalid plan status",
  );
  requireThat(text(p.ownerId, 128), "ownerId is required");
  requireThat(
    p.objective === undefined ||
      (typeof p.objective === "string" && p.objective.length <= 500),
    "Invalid objective",
  );
  for (const k of ["startDate", "endDate"])
    requireThat(!p[k] || realDate(p[k]), `Invalid ${k}`);
  requireThat(
    !p.startDate || !p.endDate || p.startDate <= p.endDate,
    "Invalid plan dates",
  );
  validateTags(p.tags);
  requireThat(
    Array.isArray(p.goals) &&
      p.goals.length <= 6 &&
      p.goals.every((g) => g && typeof g === "object") &&
      new Set(p.goals.map((g) => g.ref)).size === p.goals.length,
    "At most six unique goals",
  );
  p.goals.forEach(validateGoal);
  validateLinks(p.sources || []);
}
export function validateTags(tags: unknown) {
  requireThat(
    Array.isArray(tags) && tags.length <= 30 && tags.every((t) => text(t, 100)),
    "Invalid tags",
  );
}
export function validateLinks(links: unknown) {
  requireThat(
    Array.isArray(links) &&
      links.length <= 30 &&
      links.every(
        (l) =>
          l &&
          typeof l === "object" &&
          text(l.name, 200) &&
          text(l.url, 2048) &&
          /^(https?:|file:)/.test(l.url),
      ),
    "Invalid links",
  );
}
export function normalizeTarget(value: string) {
  try {
    const u = new URL(value);
    requireThat(u.protocol === "https:", "targetUrl must be HTTPS");
    u.search = "";
    u.hash = "";
    return u.href;
  } catch {
    throw new MarketingError("targetUrl must be an absolute HTTPS URL");
  }
}
export function validateStep(s: Step, plan: Plan) {
  requireThat(
    text(s.title, 300) && text(s.doneCriteria, 500),
    "title and doneCriteria are required",
  );
  requireThat(
    [
      "content",
      "refresh",
      "newsletter",
      "podcast",
      "social",
      "outreach",
      "technical",
      "other",
    ].includes(s.kind),
    "Invalid step kind",
  );
  requireThat(
    ["S", "L"].includes(s.size) && text(s.ownerId, 128),
    "Invalid size or ownerId",
  );
  requireThat(
    Array.isArray(s.goalRefs) &&
      s.goalRefs.every((r) => plan.goals.some((g) => g.ref === r)),
    "Invalid goalRefs",
  );
  validateTags(s.tags);
  validateLinks(s.links || []);
  requireThat(
    !s.brief || (typeof s.brief === "string" && s.brief.length <= 4000),
    "Invalid brief",
  );
  requireThat(!s.publishDate || realDate(s.publishDate), "Invalid publishDate");
  if (s.targetUrl) s.targetUrl = normalizeTarget(s.targetUrl);
  if (["content", "refresh"].includes(s.kind))
    requireThat(
      s.targetUrl &&
        ["new", "refresh"].includes(s.targetType) &&
        text(s.primaryKeyword, 100),
      "Content and refresh require targetUrl, targetType and primaryKeyword",
    );
  requireThat(
    !s.prompts ||
      (Array.isArray(s.prompts) &&
        s.prompts.every((p: string) => vocabulary.prompts.includes(p))),
    "Invalid prompts",
  );
}
export function isoWeek(date: string) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const y = d.getUTCFullYear();
  return `${y}-W${String(Math.ceil(((+d - +new Date(Date.UTC(y, 0, 1))) / 86400000 + 1) / 7)).padStart(2, "0")}`;
}
export function periodRange(period: string): { from: string; to: string } {
  if (/^\d{4}-\d{2}-\d{2}$/.test(period)) {
    requireThat(realDate(period), "Invalid measurement date");
    return { from: period, to: period };
  }
  let start: Date;
  let days: number;
  if (/^\d{4}-W\d{2}$/.test(period)) {
    const y = Number(period.slice(0, 4));
    const w = Number(period.slice(6));
    start = new Date(Date.UTC(y, 0, 4));
    start.setUTCDate(
      start.getUTCDate() - ((start.getUTCDay() + 6) % 7) + (w - 1) * 7,
    );
    days = 7;
    requireThat(isoWeek(start.toISOString()) === period, "Invalid ISO week");
  } else {
    requireThat(
      /^\d{4}-(0[1-9]|1[0-2])$/.test(period),
      "Period must be an ISO week or month",
    );
    start = new Date(`${period}-01T00:00:00Z`);
    days = new Date(
      start.getUTCFullYear(),
      start.getUTCMonth() + 1,
      0,
    ).getDate();
  }
  return {
    from: start.toISOString().slice(0, 10),
    to: new Date(+start + (days - 1) * 86400000).toISOString().slice(0, 10),
  };
}
export function normalizeDomain(value: unknown): string {
  requireThat(typeof value === "string" && !!value.trim(), "domain is required");
  const cleaned = value.trim().toLowerCase().replace(/\.$/, "");
  requireThat(
    cleaned.length <= 253 &&
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
        cleaned,
      ),
    `Invalid domain: ${value}`,
  );
  requireThat(
    !cleaned.endsWith(".localhost") &&
      !cleaned.endsWith(".local") &&
      !cleaned.endsWith(".internal") &&
      !cleaned.endsWith(".home.arpa"),
    `Non-public domain rejected: ${cleaned}`,
  );
  return cleaned;
}

export function normalizePublicHttpUrl(value: unknown): string {
  requireThat(
    typeof value === "string" && !!value.trim() && value.trim().length <= 2048,
    "URL must be a non-empty string up to 2048 characters",
  );
  let u: URL;
  try {
    u = new URL(value.trim());
  } catch {
    throw new MarketingError(`Invalid URL: ${value}`);
  }
  requireThat(
    u.protocol === "http:" || u.protocol === "https:",
    "Only public http(s) URLs are allowed",
  );
  requireThat(
    !u.username && !u.password,
    "Credentials in URL are not allowed",
  );
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  requireThat(
    host &&
      host !== "localhost" &&
      !host.endsWith(".localhost") &&
      !host.endsWith(".local") &&
      !host.endsWith(".internal") &&
      !host.endsWith(".home.arpa"),
    `Non-public host rejected: ${host}`,
  );
  if (isIP(host)) {
    const isV4 = isIP(host) === 4;
    if (isV4) {
      const [a, b, c] = host.split(".").map(Number);
      const nonPublic =
        a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 0 && (c === 0 || c === 2)) ||
        (a === 192 && b === 168) ||
        (a === 198 && (b === 18 || b === 19)) ||
        (a === 198 && b === 51 && c === 100) ||
        (a === 203 && b === 0 && c === 113) ||
        a >= 224;
      requireThat(!nonPublic, `Non-public IP target rejected: ${host}`);
    } else {
      const lower = host.toLowerCase();
      const first = parseInt(lower.split(":")[0] || "0", 16);
      const nonPublic =
        lower === "::" ||
        lower === "::1" ||
        lower.startsWith("::ffff:") ||
        (first & 0xfe00) === 0xfc00 ||
        (first & 0xffc0) === 0xfe80 ||
        (first & 0xff00) === 0xff00 ||
        lower.startsWith("2001:db8:");
      requireThat(!nonPublic, `Non-public IPv6 target rejected: ${host}`);
    }
  } else {
    requireThat(host.includes("."), `Non-public single-label host rejected: ${host}`);
  }
  return u.href;
}

export function backlinkPairId(sourceUrl: string, targetUrl: string): string {
  const s = normalizePublicHttpUrl(sourceUrl);
  const t = normalizePublicHttpUrl(targetUrl);
  return `bl-${createHash("sha256")
    .update(JSON.stringify([s, t]))
    .digest("hex")
    .slice(0, 12)}`;
}

export function validateTrackedSite(site: TrackedSite) {
  requireThat(site && typeof site === "object" && !Array.isArray(site), "Site must be an object");
  site.domain = normalizeDomain(site.domain);
  requireThat(
    site.label === undefined || (typeof site.label === "string" && site.label.length <= 200),
    "Invalid site label",
  );
  requireThat(
    site.notes === undefined || (typeof site.notes === "string" && site.notes.length <= 1000),
    "Invalid site notes",
  );
  requireThat(typeof site.active === "boolean", "Site active must be boolean");
}

export function validateBacklinkCheck(check: BacklinkCheck) {
  requireThat(
    check && typeof check === "object" && !Array.isArray(check),
    "Check must be an object",
  );
  requireThat(
    typeof check.checkedAt === "string" && !Number.isNaN(Date.parse(check.checkedAt)),
    "checkedAt must be a valid ISO timestamp",
  );
  requireThat(
    (BACKLINK_BUCKETS as readonly string[]).includes(check.bucket),
    `Invalid backlink bucket: ${check.bucket}`,
  );
  requireThat(
    check.httpStatus === null ||
      (Number.isInteger(check.httpStatus) && check.httpStatus >= 100 && check.httpStatus <= 599),
    "Invalid httpStatus",
  );
  requireThat(
    check.finalUrl === null ||
      (typeof check.finalUrl === "string" && check.finalUrl.length <= 2048),
    "Invalid finalUrl",
  );
  requireThat(
    check.matchedHref === null ||
      (typeof check.matchedHref === "string" && check.matchedHref.length <= 2048),
    "Invalid matchedHref",
  );
  requireThat(
    Array.isArray(check.matchedRel) &&
      check.matchedRel.length <= 20 &&
      check.matchedRel.every((r) => typeof r === "string" && r.length <= 64),
    "Invalid matchedRel",
  );
  requireThat(
    Number.isInteger(check.matchCount) && check.matchCount >= 0,
    "Invalid matchCount",
  );
  requireThat(
    check.pageNofollow === undefined || typeof check.pageNofollow === "boolean",
    "Invalid pageNofollow",
  );
  requireThat(
    check.pageNoindex === undefined || typeof check.pageNoindex === "boolean",
    "Invalid pageNoindex",
  );
  requireThat(
    check.pageRobotsDirectives === undefined ||
      (Array.isArray(check.pageRobotsDirectives) &&
        check.pageRobotsDirectives.length <= 20 &&
        check.pageRobotsDirectives.every((d) => typeof d === "string" && d.length <= 64)),
    "Invalid pageRobotsDirectives",
  );
  requireThat(
    typeof check.reason === "string" && check.reason.length <= 500,
    "Invalid check reason",
  );
}

export function validateBacklinkPair(pair: BacklinkPair) {
  requireThat(
    pair && typeof pair === "object" && !Array.isArray(pair),
    "Backlink pair must be an object",
  );
  pair.sourceUrl = normalizePublicHttpUrl(pair.sourceUrl);
  pair.targetUrl = normalizePublicHttpUrl(pair.targetUrl);
  pair.id = backlinkPairId(pair.sourceUrl, pair.targetUrl);
  requireThat(
    (BACKLINK_OUTREACH_STATES as readonly string[]).includes(pair.outreachState),
    `Invalid outreachState: ${pair.outreachState}`,
  );
  requireThat(
    pair.owner === undefined || (typeof pair.owner === "string" && pair.owner.length <= 128),
    "Invalid owner",
  );
  requireThat(
    pair.notes === undefined || (typeof pair.notes === "string" && pair.notes.length <= 1000),
    "Invalid notes",
  );
  if (pair.latestCheck !== null && pair.latestCheck !== undefined) {
    validateBacklinkCheck(pair.latestCheck);
  } else {
    pair.latestCheck = null;
  }
}

export function groupBacklinks(pairs: BacklinkPair[]) {
  const groups: Record<BacklinkBucket | "unchecked", BacklinkPair[]> = {
    added_follow: [],
    added_qualified: [],
    absent: [],
    unavailable: [],
    unchecked: [],
  };
  for (const pair of pairs) {
    const bucket = pair.latestCheck?.bucket || "unchecked";
    groups[bucket].push(pair);
  }
  const sortPairs = (a: BacklinkPair, b: BacklinkPair) =>
    a.sourceUrl.localeCompare(b.sourceUrl) || a.targetUrl.localeCompare(b.targetUrl);
  for (const key of Object.keys(groups) as Array<keyof typeof groups>) {
    groups[key].sort(sortPairs);
  }
  return {
    summary: {
      total: pairs.length,
      added_follow: groups.added_follow.length,
      added_qualified: groups.added_qualified.length,
      absent: groups.absent.length,
      unavailable: groups.unavailable.length,
      unchecked: groups.unchecked.length,
    },
    groups,
  };
}

export function validateSnapshot(s: Snapshot) {
  requireThat(
    s && typeof s === "object" && !Array.isArray(s),
    "Snapshot must be an object",
  );
  const fields = [
    "metricKey",
    "scope",
    "source",
    "period",
    "value",
    "unit",
    "artifactId",
    "note",
    "provisional",
    "observedAt",
    "evidenceUrl",
    "provider",
    "metricVersion",
    "details",
  ];
  requireThat(
    Object.keys(s).every((k) => fields.includes(k)),
    "Unknown snapshot field",
  );
  const m = validSeries(s);
  if (s.scope.startsWith("domain:")) {
    s.scope = `domain:${normalizeDomain(s.scope.slice("domain:".length))}`;
  }
  requireThat(s.source !== "dataops", "dataops series are derived, not pushed");
  periodRange(s.period);
  requireThat(
    m.period === "month"
      ? /^\d{4}-\d{2}(?:-\d{2})?$/.test(s.period)
      : /^\d{4}-W\d{2}$/.test(s.period),
    `Expected ${m.period} period`,
  );
  requireThat(
    s.unit === m.unit && Number.isFinite(s.value) && s.value >= 0,
    "Invalid value or unit",
  );
  requireThat(
    m.unit !== "score" || s.value <= 100,
    "Score must be between 0 and 100",
  );
  requireThat(
    m.unit !== "share" || s.value <= 1,
    "Share must be between 0 and 1",
  );
  requireThat(
    m.unit !== "count" || m.key.startsWith("aeo_") || Number.isInteger(s.value),
    "Count must be integer",
  );
  requireThat(
    s.provisional === undefined || typeof s.provisional === "boolean",
    "Invalid provisional",
  );
  requireThat(!s.note || text(s.note, 4000), "Invalid note");
  if (s.observedAt !== undefined) {
    requireThat(
      typeof s.observedAt === "string" &&
        !Number.isNaN(Date.parse(s.observedAt)) &&
        s.observedAt.length <= 64,
      "Invalid observedAt timestamp",
    );
  }
  if (s.evidenceUrl !== undefined) {
    s.evidenceUrl = normalizePublicHttpUrl(s.evidenceUrl);
  }
  if (s.provider !== undefined) {
    requireThat(text(s.provider, 64), "Invalid provider");
    s.provider = s.provider.trim().toLowerCase();
  }
  if (m.key === "domain_rating" && s.provider !== undefined) {
    requireThat(
      s.provider === "ahrefs",
      "domain_rating is Ahrefs-only; do not mix other authority providers",
    );
  }
  if (m.key === "moz_da" && s.provider !== undefined) {
    requireThat(
      s.provider === "moz",
      "moz_da is Moz-only; do not mix other authority providers",
    );
  }
  if (m.key === "seranking_da" && s.provider !== undefined) {
    requireThat(
      s.provider === "seranking",
      "seranking_da is SE Ranking-only; do not mix other authority providers",
    );
  }
  if (s.metricVersion !== undefined) {
    requireThat(text(s.metricVersion, 64), "Invalid metricVersion");
    s.metricVersion = s.metricVersion.trim();
  }
  if (s.details !== undefined) {
    requireThat(
      s.details &&
        typeof s.details === "object" &&
        !Array.isArray(s.details) &&
        Object.keys(s.details).length <= 12 &&
        Object.entries(s.details).every(
          ([k, v]) =>
            text(k, 64) &&
            (v === null ||
              typeof v === "boolean" ||
              (typeof v === "number" && Number.isFinite(v)) ||
              (typeof v === "string" && v.length <= 200)),
        ),
      "Invalid snapshot details",
    );
  }
}
export function goalProgress(
  goal: Goal,
  snapshots: Snapshot[],
  now = new Date(),
) {
  const ordered = [...snapshots].sort((a, b) =>
    periodRange(a.period).to.localeCompare(periodRange(b.period).to),
  );
  const last = ordered.at(-1);
  const m = metric(goal.metricKey)!;
  const threshold = m.period === "month" ? 35 : 8;
  if (
    !last ||
    +now - +new Date(periodRange(last.period).to + "T23:59:59Z") >
      threshold * 86400000
  )
    return {
      status: "no-data",
      latest: last || null,
      value: null,
      ...(goal.baseline === null || goal.target === null
        ? { expected: null, calibrationRequired: true }
        : {}),
    };
  const evaluate = (rows: Snapshot[], at: Date) => {
    const latest = rows.at(-1)!;
    const selected =
      goal.window === "rolling28"
        ? rows.filter(
            (s) =>
              +new Date(periodRange(latest.period).to) -
                +new Date(periodRange(s.period).to) <
              28 * 86400000,
          )
        : [latest];
    const value =
      selected.reduce((n, s) => n + s.value, 0) /
      (goal.window === "rolling28" && m.unit !== "count" ? selected.length : 1);
    if (goal.baseline === null || goal.target === null)
      return {
        value,
        expected: null,
        status: "no-data",
        calibrationRequired: true,
      };
    const fraction = Math.max(
      0,
      Math.min(
        1,
        (+at - +new Date(goal.baseline.date)) /
          (+new Date(goal.target.date) - +new Date(goal.baseline.date)),
      ),
    );
    const expected =
      goal.baseline.value +
      fraction * (goal.target.value - goal.baseline.value);
    const gap = m.direction === "down" ? value - expected : expected - value;
    return {
      value,
      expected,
      status:
        gap <= 0
          ? "on-track"
          : gap <= Math.max(Math.abs(expected), 1) * 0.25
            ? "at-risk"
            : "off-track",
    };
  };
  const result = evaluate(ordered, now);
  if (result.status === "at-risk" && ordered.length > 1) {
    const prev = ordered.slice(0, -1);
    if (
      evaluate(prev, new Date(periodRange(prev.at(-1)!.period).to)).status ===
      "at-risk"
    )
      result.status = "off-track";
  }
  return { ...result, latest: last };
}
