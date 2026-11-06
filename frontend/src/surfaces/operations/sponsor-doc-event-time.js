export function validEventTimeZone(zone) {
  try { new Intl.DateTimeFormat("en", { timeZone: zone }).format(); return Boolean(zone); } catch { return false; }
}
export function guestEventTimeZone(saved) {
  if (validEventTimeZone(saved)) return saved;
  const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return validEventTimeZone(detected) ? detected : "Europe/Berlin";
}
function durationMinutes(startIso, endIso, fallback) {
  const duration = (Date.parse(endIso) - Date.parse(startIso)) / 60000;
  return Number.isFinite(duration) && duration > 0 ? Math.round(duration) : Number(fallback) || 0;
}
export function formatGuestEventTime(startIso, endIso, zone, fallbackDuration, includeDuration = true) {
  const start = new Date(startIso), end = new Date(endIso);
  if (!startIso || Number.isNaN(start.getTime()) || !validEventTimeZone(zone)) return "";
  const validEnd = endIso && !Number.isNaN(end.getTime()) && end > start;
  const dateFormat = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: zone });
  const timeFormat = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: zone });
  const offsetFormat = new Intl.DateTimeFormat("en-GB", { timeZone: zone, timeZoneName: "short" });
  const offset = instant => offsetFormat.formatToParts(instant).find(part => part.type === "timeZoneName")?.value || zone;
  let range = `${timeFormat.format(start)} ${offset(start)}`;
  if (validEnd) {
    const sameDay = dateFormat.format(start) === dateFormat.format(end);
    const sameOffset = offset(start) === offset(end);
    range = `${timeFormat.format(start)}${sameOffset ? "" : ` ${offset(start)}`}–${sameDay ? "" : `${dateFormat.format(end)}, `}${timeFormat.format(end)} ${offset(end)}`;
  }
  const duration = durationMinutes(startIso, endIso, fallbackDuration);
  return `${dateFormat.format(start)}, ${range} (${zone})${includeDuration && duration ? `; ${duration} minutes` : ""}`;
}
export function dualZoneEventTime(startIso, endIso, guestZone, fallbackDuration) {
  const berlin = formatGuestEventTime(startIso, endIso, "Europe/Berlin", fallbackDuration, false);
  if (!berlin) return "";
  const duration = durationMinutes(startIso, endIso, fallbackDuration);
  const rows = [`Berlin: ${berlin}`];
  if (guestZone !== "Europe/Berlin") rows.push(`Your time: ${formatGuestEventTime(startIso, endIso, guestZone, fallbackDuration, false)}`);
  return `${rows.join("\n")}${duration ? `; ${duration} minutes` : ""}`;
}
