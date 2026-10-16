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
