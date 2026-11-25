import { escapeHtml } from "../../core/html.js";

export function html(strings, ...values) {
  return strings.reduce(
    (markup, segment, index) =>
      markup + segment + (index < values.length ? values[index] : ""),
    "",
  );
}

export function berlinToday() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function formatNumber(value, unit = "") {
  if (value === null || value === undefined || value === "") return "–";
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value);
  if (unit === "share") {
    return `${(num * 100).toFixed(1).replace(/\.0$/, "")}%`;
  }
  if (Number.isInteger(num)) return num.toLocaleString("en-US");
  return num.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function formatDelta(delta, unit = "") {
  if (delta === null || delta === undefined || Number.isNaN(Number(delta))) return "–";
  const num = Number(delta);
  if (num === 0) return "0";
  const prefix = num > 0 ? "+" : "−";
  return `${prefix}${formatNumber(Math.abs(num), unit)}`;
}

export function snapshotAgeLabel(dateStr, today = berlinToday()) {
  if (!dateStr) return "no data";
  const d1 = new Date(`${String(dateStr).slice(0, 10)}T00:00:00Z`);
  const d2 = new Date(`${String(today).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d1.getTime()) || Number.isNaN(d2.getTime())) return String(dateStr);
  const days = Math.round((d2.getTime() - d1.getTime()) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "1 day old";
  return `${days} days old`;
}

const GOAL_BADGE_TONE = {
  "on-track": "dk-badge--success",
  "at-risk": "dk-badge--warning",
  "off-track": "dk-badge--danger",
  "off-track-2w": "dk-badge--danger",
  "no-data": "",
};

const STEP_BADGE_TONE = {
  planned: "",
  scheduled: "dk-badge--info",
  "in-progress": "dk-badge--warning",
  published: "dk-badge--success",
  done: "dk-badge--success",
  dropped: "dk-badge--danger",
};

const PLAN_BADGE_TONE = {
  active: "dk-badge--success",
  draft: "",
  paused: "dk-badge--warning",
  done: "dk-badge--info",
};

export function statusBadge(status, kind = "goal") {
  const value = String(status || "no-data");
  const map =
    kind === "step"
      ? STEP_BADGE_TONE
      : kind === "plan"
        ? PLAN_BADGE_TONE
        : GOAL_BADGE_TONE;
  const tone = map[value] || "";
  const label = value.replace(/-/g, " ");
  return html`<span class="dk-badge ${tone}">${escapeHtml(label)}</span>`;
}

// Marketing reads use collection { items } envelopes and bare detail records.
export const normalizePlansPayload = (payload) => payload.items;
export const normalizePlanPayload = (payload) => payload;
export const normalizeStepsPayload = (payload) => payload.items;
export const normalizeStepPayload = (payload) => payload;
export const normalizeGoalPayload = (payload) => ({
  goal: payload, snapshots: payload.snapshots,
});
export const normalizeSnapshotsPayload = (payload) => payload.items;

export function snapshotRange(snapshot) {
  const period = snapshot.period;
  if (/^\d{4}-W\d{2}$/.test(period)) {
    const start = new Date(Date.UTC(Number(period.slice(0, 4)), 0, 4));
    start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7)
      + (Number(period.slice(6)) - 1) * 7);
    return { from: start.toISOString().slice(0, 10),
      to: new Date(+start + 6 * 86400000).toISOString().slice(0, 10) };
  }
  if (/^\d{4}-\d{2}$/.test(period)) {
    return { from: `${period}-01`,
      to: new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5)), 0))
        .toISOString().slice(0, 10) };
  }
  return { from: period, to: period };
}

export function seriesKeyForGoal(goal) {
  return `${goal?.metricKey || ""}|${goal?.scope || ""}|${goal?.source || ""}`;
}

export function marketingTabsMarkup(activeTab) {
  return html`<nav class="dk-tabs mkt-tabs" aria-label="Marketing sections">
    <a class="dk-tab" href="/marketing" data-mkt-nav${activeTab === "plans" ? ' aria-current="page"' : ""}>Plans</a>
    <a class="dk-tab" href="/marketing/review" data-mkt-nav${activeTab === "review" ? ' aria-current="page"' : ""}>Weekly Review</a>
  </nav>`;
}
