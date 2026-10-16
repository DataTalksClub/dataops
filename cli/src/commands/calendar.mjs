import { apiFor } from "../session.mjs";

const client = apiFor;

export const summary = "Calendar of events (Cards, podcast episodes, newsletter issues) and open slots";

export const help = `dataops calendar - the calendar of events and operational scheduling

The calendar is read-only: every entry is an event Card (by its anchor date) or
a podcast episode (recording and release dates), and newsletter issues show as
an overlay. Change an event on its Card or episode (dataops cards update
<id> --date D, dataops podcast update).

Usage
  dataops calendar list [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--type KIND]
  dataops calendar day <date>              Operational slot availability and the full day schedule
  dataops calendar slots [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--all]
  dataops calendar settings [--connection ID] [--filter-busy true|false] ...
  dataops calendar dismiss-alert <fingerprint>
  dataops calendar sync-holidays
`;

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

function toBoolean(val) {
  if (val === true || val === "true") return true;
  if (val === false || val === "false") return false;
  return Boolean(val);
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

  const api = client(args);
  const [overlayResult, calendarResult] = await Promise.all([
    api.get(`/api/calendar-items/overlays?from=${dateIso}&to=${dateIso}&includeAll=true`),
    api.get(`/api/calendar-items?from=${dateIso}&to=${dateIso}`),
  ]);

  const overlayItems = overlayResult.items || [];
  const events = (calendarResult.items || []).filter((item) => item.date === dateIso);
  const holidays = (calendarResult.holidays || []).filter(
    (h) => h.startDate <= dateIso && h.endDate >= dateIso,
  );
  const ownerCalendarItems = overlayItems.filter((o) => o.provider === "owner-calendar");

  const blockers = ownerCalendarItems.filter(
    (e) => e.slot === "all-day" || /vacation|holiday|flight|conference|trip/i.test(e.label),
  );
  const middayEvents = ownerCalendarItems.filter((e) => e.slot === "midday");
  const isMiddayAvailable = blockers.length === 0 && middayEvents.length === 0;

  const eveningEvents = ownerCalendarItems.filter((e) => e.slot === "evening");
  const isEveningAvailable = blockers.length === 0 && eveningEvents.length === 0;

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
    slots: {
      midday: {
        slot: "11:30–14:00",
        available: isMiddayAvailable,
        conflicts: middayEvents.map((e) => e.label),
      },
      evening: {
        slot: "16:30–18:30",
        available: isEveningAvailable,
        conflicts: eveningEvents.map((e) => e.label),
      },
      blockers: blockers.map((b) => b.label),
    },
    timeline,
  };

  if (args.json) return payload;

  io.print(`Day Schedule: ${formatBerlinDay(dateIso)} (Europe/Berlin)`);
  if (blockers.length > 0) {
    io.print(`\n  ⚠ ALL-DAY BLOCKER: ${blockers.map((b) => b.label).join(" · ")}`);
  }

  io.print("\nOperational Slot Availability:");
  io.print(
    `  ● Midday Event Slot (11:30–14:00):  ${isMiddayAvailable ? "AVAILABLE" : "BUSY / RESERVED"}`,
  );
  if (isMiddayAvailable) {
    io.print("    No conflicts. Preferred operational window for podcasts and lunch discussions.");
  } else {
    io.print(`    Conflicting: ${middayEvents.map((e) => e.label).join(", ") || "Blocked by all-day event"}`);
  }

  io.print(
    `  ● Evening Event Slot (16:30–18:30): ${isEveningAvailable ? "AVAILABLE" : "BUSY / RESERVED"}`,
  );
  if (isEveningAvailable) {
    io.print("    No conflicts. Preferred operational window for workshops, live Q&As and webinars.");
  } else {
    io.print(`    Conflicting: ${eveningEvents.map((e) => e.label).join(", ") || "Blocked by all-day event"}`);
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

  const query = new URLSearchParams({ from, to });
  if (args.all || args.includeAll) query.set("includeAll", "true");

  const result = await client(args).get(`/api/calendar-items/overlays?${query}`);
  if (args.json) return result;

  const items = result.items || [];
  io.print(`Calendar Overlays & Event Slots (${from} to ${to}):`);
  if (items.length === 0) {
    io.print("  No overlay items in this range.");
    return result;
  }

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

  return result;
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

    const saved = await api.put("/api/calendar-items/settings", payload);
    if (args.json) return saved;

    io.print("Saved calendar overlay settings:");
    io.print(JSON.stringify(saved.settings || saved, null, 2));
    return saved;
  }

  const result = await api.get("/api/calendar-items/settings");
  if (args.json) return result;

  const s = result.settings || {};
  const connections = result.connections || [];

  io.print("Calendar Overlay Settings:");
  io.print(`  Connection ID:               ${s.connectionId || "default"}`);
  io.print(`  Filter Non-Slot Hours:       ${s.filterNonSlotHours !== false}`);
  io.print(`  Filter DTC Placeholders:     ${s.filterDtcPlaceholders !== false}`);
  io.print(`  Filter Transparent Events:   ${s.filterTransparent !== false}`);
  io.print(`  Filter Lunch:                ${Boolean(s.filterLunch)}`);
  io.print(`  Filter Routines:             ${Boolean(s.filterRoutines)}`);
  io.print(`  Filter Fitness:              ${Boolean(s.filterFitness)}`);
  io.print(`  Filter Focus:                ${Boolean(s.filterFocus)}`);
  io.print(`  Filter Busy:                 ${Boolean(s.filterBusy)}`);
  io.print(`  Custom Keywords:             ${(s.customKeywords || []).join(", ") || "(none)"}`);

  if (connections.length > 0) {
    io.print(`\nAvailable Dapier Calendar Connections (${connections.length}):`);
    for (const c of connections) {
      const active = c.id === s.connectionId ? " (current)" : "";
      io.print(`  - ${c.id}: ${c.label || c.accountEmail || "Calendar"}${active}`);
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
