// Podcast release dates must fall on the configured release weekday (Friday by
// default). Fixtures that assign a release slot use this to get a valid date.
const FRIDAY = 5;

/** The Friday nearest `offsetDays` from today, rounded forward for future offsets and back for past ones. */
function releaseFriday(offsetDays) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  const weekday = date.getUTCDay() || 7;
  const shift = offsetDays > 0 ? (FRIDAY - weekday + 7) % 7 : -((weekday - FRIDAY + 7) % 7);
  date.setUTCDate(date.getUTCDate() + shift);
  return date.toISOString().slice(0, 10);
}

module.exports = { releaseFriday };
