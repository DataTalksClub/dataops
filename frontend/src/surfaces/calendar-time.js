// Calendar times are stored as UTC instants and always shown in the workspace
// timezone, Europe/Berlin, whatever the viewer's browser is set to. Intl does
// the offset lookup, so displays stay correct across daylight-saving changes.
export const CALENDAR_TIME_ZONE = "Europe/Berlin";

const berlinParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: CALENDAR_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

// "YYYY-MM-DDTHH:MM" wall-clock time in Berlin for a UTC instant.
export function berlinDateTime(timestamp) {
  const parts = berlinParts.formatToParts(new Date(timestamp));
  const part = (type) => parts.find((entry) => entry.type === type).value;
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

// "HH:MM" Berlin time for a UTC instant.
export function berlinTime(timestamp) {
  return berlinDateTime(timestamp).slice(11);
}

// UTC ISO instant for a Berlin wall-clock date and time.
export function berlinTimestamp(date, time) {
  const local = `${date}T${time}`;
  const target = Date.parse(`${local}:00Z`);
  let instant = target;
  for (let attempt = 0; attempt < 3; attempt++) {
    const represented = Date.parse(`${berlinDateTime(instant)}:00Z`);
    instant += target - represented;
  }
  if (berlinDateTime(instant) !== local) {
    throw new Error("This time does not exist in Europe/Berlin because the clocks change. Choose another time.");
  }
  return new Date(instant).toISOString();
}
