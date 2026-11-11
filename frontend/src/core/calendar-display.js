const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_LIST_AT_END = new RegExp(`(?:\\s*[·,:;]?\\s*\\[?${UUID}(?:[\\s,;/]+${UUID})*\\]?\\s*)$`, "i");

/** Clean technical clutter from a calendar tile without changing its source record. */
export function calendarTileLabel(value) {
  return formatCalendarTimeRanges(value)
    .replace(/^\s*\[[^\]]+\]\s*/, "")
    .replace(/^\s*\d{4}-(?:[A-Z]{3}|\d{2})-\d{2}-\s*/i, "")
    .replace(UUID_LIST_AT_END, "")
    .replace(/\s*[·,;:]\s*$/, "")
    .trim();
}

/** Calendar ranges use the plain ASCII hyphen throughout the calendar UI. */
export function formatCalendarTimeRanges(value) {
  return String(value ?? "").replace(/(\d{1,2}:\d{2})\s*[–—]\s*(\d{1,2}:\d{2})/g, "$1-$2");
}

/** Keep linked duplicate records available in the read model, but show one tile. */
export function calendarDisplayEntries(entries) {
  return (Array.isArray(entries) ? entries : []).filter((entry) => !entry?.displayDuplicateOf);
}
