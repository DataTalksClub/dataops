import { apiFor } from "../session.mjs";
import { UsageError } from "../errors.mjs";

const client = apiFor;

export const summary = "Calendar of events (Cards, podcast episodes, newsletter issues) and open slots";

export const help = `dataops calendar - the calendar of events and operational scheduling

The calendar is read-only: every entry is an event Card (by its anchor date) or
a podcast episode (recording and release dates), and newsletter issues show as
an overlay. Change an event on its Card or episode (dataops cards update
<id> --date D, dataops podcast update).

Usage
  dataops calendar list [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--type KIND]
  dataops calendar day <date> [--duration MINUTES] [--window evening|midday|any]
  dataops calendar slots [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--all] [--duration MINUTES] [--window evening|midday|any|call]
  dataops calendar propose --date D --window evening|midday --duration N --title T --topic TOPIC [--guest-ref EMAIL] [--document-url URL] [--card ID] [--expires-days 7]
  dataops calendar link-hold <id> --card CARD_ID [--apply] [--expected-card-version N --expected-hold-version N --expected-episode-version N]
  dataops calendar confirm-hold <id> [--guest-ref EMAIL] [--document-url URL]
  dataops calendar move-hold <id> --date D [--window evening|midday] [--time HH:MM] [--duration N] [--title T] [--topic TOPIC] [--guest-ref EMAIL] [--document-url URL]
  dataops calendar release-hold <id> [--reason manual]
  dataops calendar expire-holds [--dry-run] [--now ISO]
  dataops calendar holds [--status tentative|confirmed|released|expired] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
  dataops calendar google-event <eventId> [--calendar ADDRESS]
  dataops calendar settings [--connection ID] [--filter-busy true|false] ...
  dataops calendar dismiss-alert <fingerprint>
  dataops calendar sync-holidays

Slot options
  --duration MINUTES   Free contiguous block length. Default 60 (backward
                       compatible). Workshops use 90. Accepts positive integers;
                       the usual values are 60 and 90.
  --window WINDOW      Which operational window(s) to check: evening, midday or
                       any. Default any. Workshops pass --window evening
                       --duration 90 explicitly (16:30 start, 90 min).

Operational windows (Europe/Berlin)
  evening 16:30–18:30 band. Podcast/recording (and 60-min webinar) preferred
          start 17:00; 16:30 is workshop-only (90 min, needs 16:30–18:00 free).
  call    11:00–16:30 weekdays, 30-minute grid (matches the public 30-minute
          Calendly event; --window call defaults --duration to 30). Lunch and
          Busy blocks are for event slots only and block calls. Call starts
          also respect the Calendly event rules recorded in settings: a
          minimum notice (default 720 minutes = 12 h), a booking horizon
          (default 60 days) and event buffers (default 0). Verify them
          against the Calendly link and tune with "dataops calendar settings
          --call-minimum-notice-minutes/--call-horizon-days/--call-buffer-
          before-minutes/--call-buffer-after-minutes".
  midday  11:30–14:00; podcast/webinar start 12:30 (60), workshop start 12:00 (90).
  Availability = a contiguous free block of at least --duration inside the
  chosen window(s). A public event reserves both windows for its date. Every
  requested future weekday is reported, including fully busy days. Single-day
  range implies --all (full event listing).

Holds
  A hold is a tentative event reservation: DataOps plus a Google
  "(Proposal)" event on the DTC and personal calendars. Tentative and
  confirmed holds occupy their window (hard occupancy); a tentative hold
  expires after --expires-days (default 7) unless confirmed. Expiry frees
  the slot and leaves Orin follow-up; it never emails the guest.
  --topic records the intended episode topic at invite/propose time and is
  required on every new hold (guests are invited to a specific theme).
  --title is plain: <NAME> at DataTalks.Club Podcast (or Webinar / Workshop).
  Google adds (Proposal) until confirmation. --guest-ref supplies the guest
  email required to confirm; --document-url links the guest
  event document. Invites are sent by the system through Orin's Calendar identity.
  Evening podcast/webinar holds start 17:00 (60 min); workshops pass
  --duration 90 explicitly and start 16:30.

Google event read-back
  google-event reads one event as Google has it right now (summary,
  description, location, attendees) on the organizer calendar plus every
  configured hold calendar, or only --calendar ADDRESS. Use it to verify
  what an invite actually shows (document label/link, Zoom).
`; 
export const DEFAULT_SLOT_DURATION_MINUTES = 60;
export const DEFAULT_SLOT_WINDOW = "any";
// --window call mirrors the public 30-minute Calendly event.
export const DEFAULT_CALL_DURATION_MINUTES = 30;

export function parseDurationMinutes(raw) {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_SLOT_DURATION_MINUTES;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error("Invalid --duration: must be a positive integer number of minutes (usual values: 60, 90).");
  }
  return n;
}

export function parseSlotWindow(raw) {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_SLOT_WINDOW;
  const v = String(raw).trim().toLowerCase();
  if (v === "midday" || v === "evening" || v === "any" || v === "call") return v;
  throw new Error("Invalid --window: must be one of 'evening', 'midday', 'any', 'call'.");
}

const MIDDAY_WINDOW = { start: "11:30", end: "14:00", preferStart: "12:30" };
const WORKSHOP_MIDDAY_WINDOW = { start: "11:30", end: "14:00", preferStart: "12:00" };
// Evening band 16:30–18:30: podcast/recording (60 min) starts 17:00, 16:30 is workshop-only.
const EVENING_WINDOW = { start: "16:30", end: "18:30", preferStart: "17:00" };
const WORKSHOP_WINDOW = { start: "16:30", end: "18:30", preferStart: "16:30" };
// 90 = workshop only; 60 = webinar AND podcast.
const WORKSHOP_DURATION_MINUTES = 90;

function toMinutes(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function toTime(n) {
  return `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
}

function eventTimes(o) {
  // Prefer ISO timestamps; fall back to the HH:MM range prefix in the label.
  if (o.startsAt && o.endsAt) {
    try {
      const s = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(o.startsAt));
      const e = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(o.endsAt));
      return { start: s, end: e };
    } catch { /* fall through to label parsing */ }
  }
  if (typeof o.label === "string") {
    const m = o.label.match(/^(\d{2}:\d{2})(?:–(\d{2}:\d{2}))?\s+/);
    if (m) return { start: m[1], end: m[2] || m[1] };
  }
  return null;
}

function preferStartFor(window, durationMinutes) {
  if (window === "evening" && durationMinutes === WORKSHOP_DURATION_MINUTES) {
    return WORKSHOP_WINDOW.preferStart;
  }
  if (window === "midday" && durationMinutes === WORKSHOP_DURATION_MINUTES) {
    return WORKSHOP_MIDDAY_WINDOW.preferStart;
  }
  return (window === "midday" ? MIDDAY_WINDOW : EVENING_WINDOW).preferStart;
}

export function isWindowFreeForDuration(window, busy, durationMinutes = DEFAULT_SLOT_DURATION_MINUTES) {
  const def = window === "midday" ? MIDDAY_WINDOW : EVENING_WINDOW;
  if (durationMinutes > toMinutes(def.end) - toMinutes(def.start)) return false;
  const blockStart = preferStartFor(window, durationMinutes);
  const blockEnd = toTime(toMinutes(preferStartFor(window, durationMinutes)) + durationMinutes);
  if (blockStart < def.start || blockEnd > def.end) return false;
  for (const b of busy) {
    if (b.start < blockEnd && b.end > blockStart) return false;
  }
  return true;
}

function busyIntervalsForDay(ownerItems, window) {
  const def = window === "midday" ? MIDDAY_WINDOW : EVENING_WINDOW;
  const out = [];
  for (const o of ownerItems) {
    if (o.slot === "all-day") continue;
    const t = eventTimes(o);
    if (!t) {
      // Unparseable timed entry inside the window counts as blocking.
      if (o.slot === window) out.push({ start: def.start, end: def.end });
      continue;
    }
    if (t.start < def.end && t.end > def.start) {
      out.push({
        start: t.start < def.start ? def.start : t.start,
        end: t.end > def.end ? def.end : t.end,
      });
    }
  }
  return out;
}

function todayBerlin() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function currentMonthBounds() {
  const today = todayBerlin();
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const first = `${today.slice(0, 7)}-01`;
  const lastDate = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = `${today.slice(0, 7)}-${String(lastDate).padStart(2, "0")}`;
  return { from: first, to: last };
}

function eachDate(from, to) {
  const dates = [];
  const current = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

function futureWeekdays(from, to) {
  const today = todayBerlin();
  return eachDate(from, to).filter((date) => {
    if (date < today) return false;
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    return weekday > 0 && weekday < 6;
  });
}

function toBoolean(val) {
  if (val === true || val === "true") return true;
  if (val === false || val === "false") return false;
  return Boolean(val);
}

function toNonNegativeInt(val, name) {
  const n = typeof val === "number" ? val : Number(String(val).trim());
  if (!Number.isInteger(n) || n < 0) {
    throw new UsageError(`Invalid ${name}: must be a non-negative integer.`);
  }
  return n;
}

function formatBerlinDay(dateIso) {
  const parsed = new Date(`${dateIso}T12:00:00Z`);
  return parsed.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * List calendar activities, holidays, and alerts
 */
export async function list(args, io) {
  let from = args.from;
  let to = args.to;
  if (!from && !to) {
    if (args.date) {
      from = args.date;
      to = args.date;
    } else {
      const bounds = currentMonthBounds();
      from = bounds.from;
      to = bounds.to;
    }
  } else if (!to) {
    to = from;
  } else if (!from) {
    from = to;
  }

  const query = new URLSearchParams({ from, to });
  const result = await client(args).get(`/api/calendar-items?${query}`);
  const kind = args.type || args.kind;
  if (kind) result.items = (result.items || []).filter((item) => item.kind === kind);
  if (args.json) return result;

  const items = result.items || [];
  const holidays = result.holidays || [];
  const alerts = result.alerts || [];

  if (items.length === 0 && holidays.length === 0) {
    io.print(`No calendar events between ${from} and ${to}.`);
  } else {
    io.print(`Calendar events (${from} to ${to}):`);
    for (const item of items) {
      const statusPill = `[${item.status}]`.padEnd(13);
      const kindPill = `[${item.kindLabel}]`.padEnd(20);
      io.print(`  ${item.date.padEnd(11)} ${kindPill} ${statusPill} ${item.title}  (${item.entity.type} ${item.entity.id})`);
    }
    if (holidays.length > 0) {
      io.print(`\nHolidays & School Breaks (${holidays.length}):`);
      for (const h of holidays) {
        const range = h.startDate === h.endDate ? h.startDate : `${h.startDate}..${h.endDate}`;
        io.print(`  ${range.padEnd(23)} [${h.kind || "holiday"}] ${h.name}`);
      }
    }
  }

  if (alerts.length > 0) {
    io.print(`\nActive Alerts (${alerts.length}):`);
    for (const alert of alerts) {
      io.print(`  ● [${alert.severity || "warning"}] ${alert.reasonCode}: Check scheduled timing (fingerprint: ${alert.fingerprint})`);
    }
  }

  return result;
}

/**
 * Day schedule view with operational slot availability and full day schedule
 */
export async function day(args, io) {
  const dateIso = args._[0] || args.date || todayBerlin();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) {
    throw new Error("Date must be formatted as YYYY-MM-DD.");
  }
  const window = parseSlotWindow(args.window);
  const durationMinutes = window === "call" && args.duration === undefined ? DEFAULT_CALL_DURATION_MINUTES : parseDurationMinutes(args.duration);

  const api = client(args);
  const overlayQuery = new URLSearchParams({ from: dateIso, to: dateIso, includeAll: "true", duration: String(durationMinutes), window });
  const [overlayResult, calendarResult] = await Promise.all([
    api.get(`/api/calendar-items/overlays?${overlayQuery}`),
    api.get(`/api/calendar-items?from=${dateIso}&to=${dateIso}`),
  ]);

  const overlayItems = overlayResult.items || [];
  const events = (calendarResult.items || []).filter((item) => item.date === dateIso);
  const holidays = (calendarResult.holidays || []).filter(
    (h) => h.startDate <= dateIso && h.endDate >= dateIso,
  );
  const ownerCalendarItems = overlayItems.filter((o) => o.provider === "owner-calendar");
  const calendarHolds = overlayItems.filter((o) => o.provider === "calendar-holds");

  const blockers = ownerCalendarItems.filter(
    (e) => e.slot === "all-day" || /vacation|holiday|flight|conference|trip/i.test(e.label),
  );
  const timedOwnerItems = ownerCalendarItems.filter((e) => !blockers.includes(e));
  const occupancyItems = [...timedOwnerItems, ...calendarHolds];
  const middayBusy = busyIntervalsForDay(occupancyItems, "midday");
  const eveningBusy = busyIntervalsForDay(occupancyItems, "evening");
  const publicEventBusy = events.length > 0;
  const isMiddayAvailable = blockers.length === 0 && !publicEventBusy && isWindowFreeForDuration("midday", middayBusy, durationMinutes);
  const isEveningAvailable = blockers.length === 0 && !publicEventBusy && isWindowFreeForDuration("evening", eveningBusy, durationMinutes);
  const middayEvents = timedOwnerItems.filter((e) => e.slot === "midday");
  const eveningEvents = timedOwnerItems.filter((e) => e.slot === "evening");
  const middayHolds = calendarHolds.filter((e) => e.slot === "midday");
  const eveningHolds = calendarHolds.filter((e) => e.slot === "evening");
  const publicEventConflicts = events.map((event) => event.title);

  // Build unified timeline
  const timeline = [];
  for (const h of holidays) {
    timeline.push({
      time: "All day",
      title: h.name,
      tag: h.kind === "berlin-school-holiday" ? "School holiday" : "Holiday",
    });
  }
  for (const b of blockers) {
    timeline.push({
      time: "All day",
      title: b.label,
      tag: "All-day blocker",
    });
  }
  for (const event of events) {
    timeline.push({
      time: "All day",
      title: event.title,
      tag: event.kindLabel,
    });
  }
  for (const o of overlayItems) {
    if (o.provider === "newsletter-issues-readonly") {
      timeline.push({
        time: "Scheduled",
        title: o.label,
        tag: "Newsletter",
      });
    } else if (o.provider === "owner-calendar" && o.slot !== "all-day") {
      let time = "Timed";
      let title = o.label;
      const match = o.label.match(/^(\d{2}:\d{2}(?:–\d{2}:\d{2})?)\s+(.+)$/);
      if (match) {
        time = match[1];
        title = match[2];
      }
      let tag = "Other event";
      if (o.slot === "midday") tag = "Midday slot";
      else if (o.slot === "evening") tag = "Evening slot";
      timeline.push({ time, title, tag });
    }
  }

  const payload = {
    date: dateIso,
    formattedDate: formatBerlinDay(dateIso),
    durationMinutes,
    window,
    slots: {
      midday: {
        slot: "11:30–14:00",
        available: isMiddayAvailable,
        conflicts: [...middayEvents.map((e) => e.label), ...middayHolds.map((e) => e.label), ...publicEventConflicts],
      },
      evening: {
        slot: "16:30–18:30",
        available: isEveningAvailable,
        conflicts: [...eveningEvents.map((e) => e.label), ...eveningHolds.map((e) => e.label), ...publicEventConflicts],
      },
      blockers: blockers.map((b) => b.label),
    },
    timeline,
  };

  if (args.json) return payload;

  io.print(`Day Schedule: ${formatBerlinDay(dateIso)} (Europe/Berlin) [${durationMinutes} min, ${window}]`);
  if (blockers.length > 0) {
    io.print(`\n  ⚠ ALL-DAY BLOCKER: ${blockers.map((b) => b.label).join(" · ")}`);
  }

  if (window === "call") {
    const byDate = {};
    for (const item of overlayItems) {
      if (item.provider === "owner-calendar" && item.isAvailableSlot && item.slot === "call") {
        (byDate[item.startDate] ||= []).push(item.label.split(" ")[0]);
      }
    }
    io.print(`\nCall availability (${durationMinutes} min, Europe/Berlin):`);
    for (const date of Object.keys(byDate).sort()) io.print(`  ${date}: ${byDate[date].join(", ")}`);
    return payload;
  }
  const showMidday = window === "any" || window === "midday";
  const showEvening = window === "any" || window === "evening";
  io.print(`\nOperational Slot Availability (${durationMinutes} min):`);
  if (showMidday) {
    io.print(
      `  ● Midday Event Slot (11:30–14:00, start ${preferStartFor("midday", durationMinutes)}):  ${isMiddayAvailable ? "AVAILABLE" : "BUSY / RESERVED"}`,
    );
    if (isMiddayAvailable) {
      io.print("    No conflicts. Preferred operational window for podcasts and lunch discussions.");
    } else {
      io.print(`    Conflicting: ${[...blockers.map((e) => e.label), ...middayEvents.map((e) => e.label), ...middayHolds.map((e) => e.label), ...publicEventConflicts].join(", ") || "Blocked by all-day event"}`);
    }
  }

  if (showEvening) {
    const eveningStart = preferStartFor("evening", durationMinutes);
    io.print(
      `  ● Evening Event Slot (16:30–18:30, start ${eveningStart}): ${isEveningAvailable ? "AVAILABLE" : "BUSY / RESERVED"}`,
    );
    if (isEveningAvailable) {
      io.print("    No conflicts. Preferred operational window for workshops, live Q&As and webinars.");
    } else {
      io.print(`    Conflicting: ${[...blockers.map((e) => e.label), ...eveningEvents.map((e) => e.label), ...eveningHolds.map((e) => e.label), ...publicEventConflicts].join(", ") || "Blocked by all-day event"}`);
    }
  }

  io.print(`\nFull Schedule & Other Events (${timeline.length} entries):`);
  if (timeline.length === 0) {
    io.print("  No scheduled events or activities.");
  } else {
    for (const entry of timeline) {
      io.print(`  ${entry.time.padEnd(16)} [${entry.tag}] ${entry.title}`);
    }
  }

  return payload;
}

/**
 * Projected overlays and event slots across a date range
 */
export async function slots(args, io) {
  let from = args.from;
  let to = args.to;
  if (!from && !to) {
    if (args.date) {
      from = args.date;
      to = args.date;
    } else {
      const bounds = currentMonthBounds();
      from = bounds.from;
      to = bounds.to;
    }
  } else if (!to) {
    to = from;
  } else if (!from) {
    from = to;
  }
  const window = parseSlotWindow(args.window);
  const durationMinutes = window === "call" && !args.duration ? DEFAULT_CALL_DURATION_MINUTES : parseDurationMinutes(args.duration);

  const api = client(args);
  const query = new URLSearchParams({ from, to, duration: String(durationMinutes), window });
  const includeAll = Boolean(args.all || args.includeAll);
  if (includeAll) query.set("includeAll", "true");

  const result = await api.get(`/api/calendar-items/overlays?${query}`);
  // includeAll returns the event details instead of free-slot markers. Keep its
  // listing while querying the normal projection for availability summaries.
  // Single-day ranges default to includeAll on the API, so explicitly turn it
  // off for this availability request.
  const availabilityResult = includeAll || from === to
    ? await api.get(`/api/calendar-items/overlays?${new URLSearchParams({ from, to, duration: String(durationMinutes), window, includeAll: "false" })}`)
    : result;

  const items = result.items || [];
  // Free/busy per window for the requested duration. The backend projects
  // only available slots, so a date/window with no slot is busy. Iterate the
  // whole requested range so fully busy dates remain visible in this view.
  const showMidday = window === "any" || window === "midday";
  const showEvening = window === "any" || window === "evening";
  const availabilityItems = availabilityResult.items || [];
  const freeByDate = {};
  for (const item of availabilityItems) {
    if (item.provider === "owner-calendar" && item.isAvailableSlot) {
      const callStart = item.slot === "call"
        ? item.id?.match(/:call:(\d{2}:\d{2})$/)?.[1] || item.label?.match(/^(\d{2}:\d{2})\b/)?.[1]
        : null;
      const slot = callStart || item.slot;
      if (slot) (freeByDate[item.startDate] ||= new Set()).add(slot);
    }
  }
  const dates = futureWeekdays(from, to);
  const availability = dates.map((date) => {
    const free = freeByDate[date] || new Set();
    if (window === "call") return { date, callStarts: [...free].sort() };
    return {
      date,
      ...(window === "any" || window === "midday" ? { midday: free.has("midday") ? "AVAILABLE" : "BUSY" } : {}),
      ...(window === "any" || window === "evening" ? { evening: free.has("evening") ? "AVAILABLE" : "BUSY" } : {}),
    };
  });

  const payload = { ...result, durationMinutes, window, availability };
  if (args.json) return payload;

  io.print(`Calendar Overlays & Event Slots (${from} to ${to}) [${durationMinutes} min, ${window}]:`);
  if (items.length === 0) {
    io.print("  No overlay items in this range.");
  } else {
    const grouped = {};
    for (const item of items) {
      const key = item.startDate || "other";
      (grouped[key] ||= []).push(item);
    }

    for (const [date, dayItems] of Object.entries(grouped)) {
      io.print(`  ${date}:`);
      for (const item of dayItems) {
        const category = `[${item.category || "Overlay"}]`.padEnd(12);
        const slot = item.slot ? `(${item.slot})`.padEnd(12) : "".padEnd(12);
        io.print(`    ${category} ${slot} ${item.label}`);
      }
    }
  }

  if (dates.length > 0) {
    io.print(`\nAvailability (${durationMinutes} min${window === "any" ? "" : `, ${window}`}):`);
    for (const date of dates) {
      const free = freeByDate[date] || new Set();
      const parts = [];
      if (window === "call") parts.push(`call ${[...free].sort().join(", ") || "busy"}`);
      else {
        if (showMidday) parts.push(`midday ${free.has("midday") ? "AVAILABLE" : "busy"}`);
        if (showEvening) parts.push(`evening ${free.has("evening") ? "AVAILABLE" : "busy"}`);
      }
      io.print(`  ${date}: ${parts.join(" · ")}`);
    }
  }

  return payload;
}

/**
 * View or update calendar overlay settings and connection
 */
export async function settings(args, io) {
  const api = client(args);

  const updateFields = [
    "connection",
    "connectionId",
    "filterNonSlotHours",
    "filterDtcPlaceholders",
    "filterTransparent",
    "filterLunch",
    "filterRoutines",
    "filterFitness",
    "filterFocus",
    "filterBusy",
    "customKeywords",
    "callMinimumNoticeMinutes",
    "callHorizonDays",
    "callBufferBeforeMinutes",
    "callBufferAfterMinutes",
  ];

  const hasUpdates = updateFields.some((f) => args[f] !== undefined);

  if (hasUpdates) {
    const current = await api.get("/api/calendar-items/settings");
    const payload = { ...(current.settings || {}) };

    if (args.connection !== undefined || args.connectionId !== undefined) {
      payload.connectionId = String(args.connection || args.connectionId);
    }
    if (args.filterNonSlotHours !== undefined) {
      payload.filterNonSlotHours = toBoolean(args.filterNonSlotHours);
    }
    if (args.filterDtcPlaceholders !== undefined) {
      payload.filterDtcPlaceholders = toBoolean(args.filterDtcPlaceholders);
    }
    if (args.filterTransparent !== undefined) {
      payload.filterTransparent = toBoolean(args.filterTransparent);
    }
    if (args.filterLunch !== undefined) {
      payload.filterLunch = toBoolean(args.filterLunch);
    }
    if (args.filterRoutines !== undefined) {
      payload.filterRoutines = toBoolean(args.filterRoutines);
    }
    if (args.filterFitness !== undefined) {
      payload.filterFitness = toBoolean(args.filterFitness);
    }
    if (args.filterFocus !== undefined) {
      payload.filterFocus = toBoolean(args.filterFocus);
    }
    if (args.filterBusy !== undefined) {
      payload.filterBusy = toBoolean(args.filterBusy);
    }
    if (args.customKeywords !== undefined) {
      payload.customKeywords = String(args.customKeywords)
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean);
    }
    // Call-slot Calendly parity: minimum notice and buffers in minutes,
    // booking horizon in days. Notice/horizon must mirror the public event.
    if (args.callMinimumNoticeMinutes !== undefined) {
      payload.callMinimumNoticeMinutes = toNonNegativeInt(args.callMinimumNoticeMinutes, "--call-minimum-notice-minutes");
    }
    if (args.callHorizonDays !== undefined) {
      payload.callHorizonDays = toNonNegativeInt(args.callHorizonDays, "--call-horizon-days");
    }
    if (args.callBufferBeforeMinutes !== undefined) {
      payload.callBufferBeforeMinutes = toNonNegativeInt(args.callBufferBeforeMinutes, "--call-buffer-before-minutes");
    }
    if (args.callBufferAfterMinutes !== undefined) {
      payload.callBufferAfterMinutes = toNonNegativeInt(args.callBufferAfterMinutes, "--call-buffer-after-minutes");
    }

    const saved = await api.put("/api/calendar-items/settings", payload);
    if (args.json) return saved;

    io.print("Saved calendar settings (connection drives propose/invite Google sync):");
    io.print(JSON.stringify(saved.settings || saved, null, 2));
    return saved;
  }

  const result = await api.get("/api/calendar-items/settings");
  if (args.json) return result;

  const s = result.settings || {};
  const connections = result.connections || [];

  io.print("Calendar settings (Dapier connection used for overlay + propose/invite):");
  io.print(`  Connection ID:               ${s.connectionId || "(none selected — use --connection <id>)"}`);
  io.print(`  Filter Non-Slot Hours:       ${s.filterNonSlotHours !== false}`);
  io.print(`  Filter DTC Placeholders:     ${s.filterDtcPlaceholders !== false}`);
  io.print(`  Filter Transparent Events:   ${s.filterTransparent !== false}`);
  io.print(`  Filter Lunch:                ${Boolean(s.filterLunch)}`);
  io.print(`  Filter Routines:             ${Boolean(s.filterRoutines)}`);
  io.print(`  Filter Fitness:              ${Boolean(s.filterFitness)}`);
  io.print(`  Filter Focus:                ${Boolean(s.filterFocus)}`);
  io.print(`  Filter Busy:                 ${Boolean(s.filterBusy)}`);
  io.print(`  Custom Keywords:             ${(s.customKeywords || []).join(", ") || "(none)"}`);
  io.print("Call slots (Calendly parity — verify against the public Calendly event):");
  io.print(`  Minimum Notice (minutes):    ${s.callMinimumNoticeMinutes ?? 720}`);
  io.print(`  Booking Horizon (days):      ${s.callHorizonDays ?? 60}`);
  io.print(`  Buffer Before (minutes):     ${s.callBufferBeforeMinutes ?? 0}`);
  io.print(`  Buffer After (minutes):      ${s.callBufferAfterMinutes ?? 0}`);

  if (result.connectionProblem) io.print(`\nGoogle Calendar connection: ${result.connectionProblem}`);
  if (connections.length > 0) {
    io.print(`\nAvailable Dapier Calendar Connections (${connections.length}):`);
    for (const c of connections) {
      const id = c.connectionId || c.id;
      const label = c.title || c.label || c.accountEmail || "Calendar";
      const active = id === s.connectionId ? " (current)" : "";
      io.print(`  - ${id}: ${label}${active}`);
    }
  }

  return result;
}

/**
 * Dismiss a calendar alert
 */
export async function dismissAlert(args, io) {
  const fingerprint = args._[0] || args.fingerprint;
  if (!fingerprint) throw new Error("Usage: dataops calendar dismiss-alert <fingerprint>");

  const result = await client(args).post(
    `/api/calendar-items/alerts/${encodeURIComponent(fingerprint)}/dismiss`,
    {},
  );
  if (args.json) return result;

  io.print(`Dismissed calendar alert ${fingerprint}`);
  return result;
}

/**
 * Sync holidays from canonical source
 */
export async function syncHolidays(args, io) {
  const result = await client(args).post("/api/calendar-items/holidays/sync", {});
  if (args.json) return result;

  io.print(`Synced holidays: ${result.count || 0} holidays fresh as of ${result.freshAsOf || "today"}`);
  return result;
}

const HOLD_WINDOWS = ["evening", "midday"];
const HOLD_STATUSES = ["tentative", "confirmed", "released", "expired"];

function holdId(args) {
  const id = args._[0] || args.id || args.hold;
  if (!id) throw new UsageError("A hold id is required: dataops calendar confirm-hold <id>.");
  return String(id);
}

function proposeArgs(args) {
  if (!args.date) throw new UsageError("Usage: dataops calendar propose --date YYYY-MM-DD --title T --topic TOPIC [--window evening|midday] [--duration N] [--card ID] [--expires-days 7].");
  if (!args.title) throw new UsageError("A hold needs --title.");
  if (!args.topic) throw new UsageError("A hold needs --topic: record the intended episode topic at invite/propose time.");
  const window = String(args.window ?? "evening").trim().toLowerCase();
  if (!HOLD_WINDOWS.includes(window)) {
    throw new UsageError("Invalid --window for propose: must be one of 'evening', 'midday' (a hold reserves one operational window).");
  }
  const duration = parseDurationMinutes(args.duration ?? args.durationMinutes);
  let expiresDays = 7;
  if (args.expiresDays !== undefined || args.expires_days !== undefined) {
    const n = Number(args.expiresDays ?? args.expires_days);
    if (!Number.isInteger(n) || n <= 0) throw new UsageError("Invalid --expires-days: must be a positive integer number of days.");
    expiresDays = n;
  }
  return {
    date: args.date,
    window,
    durationMinutes: duration,
    title: args.title,
    topic: args.topic,
    ...(args.card ? { cardId: args.card } : {}),
    ...(args.cardId ? { cardId: args.cardId } : {}),
    ...(args.guestRef ? { guestRef: args.guestRef } : {}),
    ...(args.documentUrl ? { documentUrl: args.documentUrl } : {}),
    ...(args.organizationId ? { organizationId: args.organizationId } : {}),
    expiresDays,
  };
}

function formatHold(hold) {
  const bits = [`${hold.date}`, `[${hold.status}]`, `(${hold.window}, ${hold.durationMinutes} min)`, hold.title];
  if (hold.topic) bits.push(`topic: ${hold.topic}`);
  bits.push(`(${hold.id})`);
  if (hold.expiresAt && hold.status === "tentative") bits.push(`expires ${String(hold.expiresAt).slice(0, 10)}`);
  return bits.join(" ");
}

/**
 * Propose a tentative hold: DataOps + Google "(Proposal)" events.
 */
export async function propose(args, io) {
  if (args.card) throw new UsageError("Use dataops event propose CARD_ID --date YYYY-MM-DD --guest-emails EMAIL for a linked [Proposed] guest invitation. calendar propose creates a private standalone hold.");
  const payload = proposeArgs(args);
  const result = await client(args).post("/api/calendar-holds", payload);
  if (args.json) return result;
  const hold = result.hold || result;
  io.print(`Proposed hold ${hold.id}: ${formatHold(hold)}`);
  if (hold.googleSync?.state === "deferred") {
    io.print(`Google sync deferred: ${hold.googleSync.reason || "broker unavailable"}`);
  }
  return result;
}

/**
 * Confirm a tentative hold: Proposal prefix drops.
 */
export async function confirmHold(args, io) {
  const id = holdId(args);
  const result = await client(args).post(`/api/calendar-holds/${encodeURIComponent(id)}/confirm`, {
    ...(args.guestRef ? { guestRef: args.guestRef } : {}),
    ...(args.documentUrl ? { documentUrl: args.documentUrl } : {}),
  });
  if (args.json) return result;
  io.print(`Confirmed hold ${id}: ${(result.hold || {}).title || ""}`);
  if (result.hold?.googleSync?.state === "deferred") {
    io.print(`Google sync deferred: ${result.hold.googleSync.reason || "broker unavailable"}`);
  }
  return result;
}

/**
 * Move/reschedule an existing hold in place without release+re-propose.
 */
export async function moveHold(args, io) {
  const id = holdId(args);
  if (!args.date) {
    throw new UsageError(
      "Usage: dataops calendar move-hold <id> --date YYYY-MM-DD [--window evening|midday] [--time HH:MM] [--duration N] [--title T] [--topic TOPIC].",
    );
  }
  const payload = {
    date: args.date,
    ...(args.window !== undefined ? { window: String(args.window).trim().toLowerCase() } : {}),
    ...(args.time !== undefined ? { time: String(args.time).trim() } : {}),
    ...(args.duration !== undefined || args.durationMinutes !== undefined
      ? { durationMinutes: parseDurationMinutes(args.duration ?? args.durationMinutes) }
      : {}),
    ...(args.title !== undefined ? { title: String(args.title) } : {}),
    ...(args.topic !== undefined ? { topic: String(args.topic) } : {}),
    ...(args.guestRef !== undefined ? { guestRef: String(args.guestRef) } : {}),
    ...(args.documentUrl !== undefined ? { documentUrl: String(args.documentUrl) } : {}),
  };
  const result = await client(args).post(`/api/calendar-holds/${encodeURIComponent(id)}/move`, payload);
  if (args.json) return result;
  const hold = result.hold || result;
  io.print(`Moved hold ${hold.id}: ${formatHold(hold)}`);
  if (hold.googleSync?.state === "deferred") {
    io.print(`Google sync deferred: ${hold.googleSync.reason || "broker unavailable"}`);
  }
  return result;
}

/**
 * Release an active hold: cancel Google Proposal, free the slot.
 */
export async function releaseHold(args, io) {
  const id = holdId(args);
  const reason = String(args.reason || "manual").toLowerCase();
  if (reason !== "manual" && reason !== "confirmed") {
    throw new UsageError("Invalid --reason: must be 'manual' (default) or 'confirmed'.");
  }
  const result = await client(args).post(`/api/calendar-holds/${encodeURIComponent(id)}/release`, { reason });
  if (args.json) return result;
  io.print(`Released hold ${id} (${reason}).`);
  return result;
}

/**
 * List holds, optionally filtered by status and range.
 */
export async function holds(args, io) {
  if (args.status !== undefined) {
    const v = String(args.status).toLowerCase();
    if (!HOLD_STATUSES.includes(v)) {
      throw new UsageError("Invalid --status: must be one of 'tentative', 'confirmed', 'released', 'expired'.");
    }
    args.status = v;
  }
  const query = new URLSearchParams();
  if (args.status) query.set("status", args.status);
  if (args.from) query.set("from", args.from);
  if (args.to) query.set("to", args.to);
  const suffix = query.toString() ? `?${query}` : "";
  const result = await client(args).get(`/api/calendar-holds${suffix}`);
  if (args.json) return result;
  const list = result.holds || [];
  if (list.length === 0) {
    io.print("No calendar holds.");
  } else {
    io.print(`Calendar holds (${list.length}):`);
    for (const hold of list) io.print(`  ${formatHold(hold)}`);
  }
  return result;
}

/**
 * Expire tentative holds past TTL (or preview via --dry-run).
 */
export async function expireHolds(args, io) {
  const dryRun = Boolean(args.dryRun || args.dry_run);
  const payload = {
    ...(dryRun ? { dryRun: true } : {}),
    ...(args.now ? { now: String(args.now) } : {}),
  };
  const result = await client(args).post("/api/calendar-holds/expire", payload);
  if (args.json) return result;
  const expired = result.expired || [];
  const followUps = result.followUps || [];
  const label = result.dryRun ? "Dry-run expired tentative holds" : "Expired tentative holds";
  io.print(`${label}: ${expired.length} (active holds checked: ${result.activeCount ?? 0})`);
  for (const hold of expired) io.print(`  ${formatHold(hold)}`);
  if (followUps.length > 0) {
    io.print(`Orin follow-ups (${followUps.length}):`);
    for (const f of followUps) {
      io.print(`  ${f.holdId} (${f.date}) ${f.title}${f.taskId ? ` -> task ${f.taskId}` : ""}`);
    }
  }
  return result;
}

/**
 * Read one Google event back as it exists right now: the organizer calendar
 * plus every configured hold calendar and the public DTC events calendar, or
 * only --calendar. Public-copy safety warnings are shown alongside the event.
 */
export async function googleEvent(args, io) {
  const eventId = args._[0];
  if (!eventId) throw new UsageError("Usage: dataops calendar google-event <eventId> [--calendar ADDRESS].");
  const query = new URLSearchParams();
  if (args.calendar) query.set("calendar", args.calendar);
  const suffix = query.toString() ? `?${query}` : "";
  const result = await client(args).get(
    `/api/calendar-holds/google-events/${encodeURIComponent(String(eventId))}${suffix}`,
  );
  if (args.json) return result;
  io.print(`Google event ${result.eventId}:`);
  for (const entry of result.events || []) {
    if (entry.state === "ok") {
      const event = entry.event;
      io.print(`  ${entry.calendar}: ${event.status || "confirmed"} — ${event.summary || "(no title)"}`);
      if (event.description) {
        for (const line of event.description.split("\n")) io.print(`    ${line}`);
      } else {
        io.print("    (no description)");
      }
      if (event.location) io.print(`    location: ${event.location}`);
      const guests = (event.attendees || []).map((a) => a.email).filter(Boolean);
      if (guests.length > 0) io.print(`    attendees: ${guests.join(", ")}`);
      for (const warning of entry.warnings || []) {
        const message = {
          public_calendar_contains_zoom_link: "the public calendar copy contains a Zoom link",
          public_calendar_contains_internal_link: "the public calendar copy contains an internal link",
          public_calendar_contains_attendees: "the public calendar copy contains attendees",
        }[warning] || warning;
        io.print(`    WARNING: ${message}`);
      }
    } else if (entry.state === "gone") {
      io.print(`  ${entry.calendar}: gone (Google reports the event missing or cancelled)`);
    } else {
      io.print(`  ${entry.calendar}: deferred — ${entry.reason || "Google Calendar could not be read"}`);
    }
  }
  return result;
}

/** Link an existing confirmed DataOps invitation without changing Google or sending updates. */
export async function linkHold(args, io) {
  const id = holdId(args);
  if (!args.card) throw new UsageError("Usage: dataops calendar link-hold <id> --card CARD_ID [--apply]");
  const payload = { cardId: args.card };
  for (const flag of ["expectedCardVersion", "expectedHoldVersion", "expectedEpisodeVersion"]) {
    if (args[flag] !== undefined) {
      const value = Number(args[flag]);
      if (args[flag] === true || !Number.isSafeInteger(value) || value < 0) throw new UsageError(`${flag} must be a nonnegative integer`);
      payload[flag] = value;
    }
  }
  if (args.apply && (payload.expectedCardVersion === undefined || payload.expectedHoldVersion === undefined)) throw new UsageError("Preview first, then apply with --expected-card-version and --expected-hold-version (and --expected-episode-version when present)");
  const result = await client(args).post(`/api/calendar-holds/${encodeURIComponent(id)}/link-card`, { ...payload, apply: Boolean(args.apply) });
  if (!args.json) io.print(JSON.stringify(result, null, 2));
  return result;
}
