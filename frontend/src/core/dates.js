// One calendar date as every task surface shows it: "18 Jan" in the current
// year, "18 Jan 2027" in any other. `today` (an ISO date) names the current
// year. Timestamps are read on their calendar day; anything that is not a
// real calendar date comes back as given.
const DAY_MONTH = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  day: "numeric",
  month: "short",
});

export function formatDayLabel(value, today) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return String(value || "");
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return String(value);
  const short = DAY_MONTH.format(date);
  return match[1] === String(today || "").slice(0, 4) ? short : `${short} ${match[1]}`;
}

// "18 Jan" for the calendar day an ISO date or timestamp names, read in UTC.
// Anything that does not parse comes back as `String(value)`.
export function formatDayMonth(value) {
  const parsed = parseUtcDay(value);
  return parsed ? DAY_MONTH.format(parsed) : String(value);
}

const ISSUE_DATE = {
  long: new Intl.DateTimeFormat("en-GB", {
    weekday: "long", day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
  }),
  short: new Intl.DateTimeFormat("en-GB", {
    weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
  }),
};

// "Wednesday, 18 Jan 2027" (weekday "long") or "Wed, 18 Jan 2027" ("short")
// for a newsletter issue's publication day, read in UTC. Anything that does
// not parse comes back as `String(value)`.
export function formatIssueDate(value, { weekday }) {
  const parsed = parseUtcDay(value);
  return parsed ? ISSUE_DATE[weekday].format(parsed) : String(value);
}

// "2027-01-18 09:30": an ISO timestamp cut to the minute, as stored (UTC).
export function formatUtcMinute(value) {
  return String(value).slice(0, 16).replace("T", " ");
}

// "2027-01-18 09:30 UTC" for an edit/send timestamp; empty when there is none.
export function formatEditedTimestamp(value) {
  return value ? `${formatUtcMinute(value)} UTC` : "";
}

function parseUtcDay(value) {
  const parsed = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
