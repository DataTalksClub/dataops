import vocabulary from "./metrics.json";
import { realDate } from "../sponsorCrm/model";

export { vocabulary };
export const WEEKLY_LIMIT = 2;
export type Dict = Record<string, any>;
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
  ];
  requireThat(
    Object.keys(s).every((k) => fields.includes(k)),
    "Unknown snapshot field",
  );
  const m = validSeries(s);
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
