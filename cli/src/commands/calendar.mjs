import { apiFor } from "../session.mjs";

const client = apiFor;

export const summary = "Calendar activities and operational slot scheduling";

export const help = `dataops calendar - calendar activities and operational scheduling

Usage
  dataops calendar list [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--type TYPE] [--status STATUS]
  dataops calendar detail <id>
  dataops calendar create --title T --type TYPE [--status STATUS] [--date DATE] [--starts-at ISO --ends-at ISO]
  dataops calendar edit <id> [--title T] [--type TYPE] [--status STATUS] [--date DATE] [--version N]
  dataops calendar delete <id> [--version N]
  dataops calendar day <date>              Operational slot availability and the full day schedule
  dataops calendar slots [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--all]
  dataops calendar settings [--connection ID] [--show-available-slots true|false] [--filter-busy true|false] ...
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

function formatItemTiming(item) {
  if (item.allDay) {
    if (item.startDate === item.endDate || !item.endDate) {
      return item.startDate || item.startKey || "All day";
    }
    return `${item.startDate || item.startKey}..${item.endDate || item.endKey}`;
  }
  if (item.startsAt && item.endsAt) {
    const startBerlin = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Berlin",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(item.startsAt));
    const endBerlin = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Berlin",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(item.endsAt));
    return `${startBerlin}–${endBerlin}`;
  }
  return item.startKey || "Timed";
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
  if (args.type || args.activityType) query.set("activityType", args.type || args.activityType);
  if (args.status) query.set("status", args.status);

  const result = await client(args).get(`/api/calendar-items?${query}`);
  if (args.json) return result;

  const items = result.items || [];
  const holidays = result.holidays || [];
  const alerts = result.alerts || [];

  if (items.length === 0 && holidays.length === 0) {
    io.print(`No calendar activities between ${from} and ${to}.`);
  } else {
    io.print(`Calendar activities (${from} to ${to}):`);
    for (const item of items) {
      const timing = formatItemTiming(item);
      const statusPill = `[${item.status || "tentative"}]`.padEnd(13);
      const typePill = `[${item.activityType || "activity"}]`.padEnd(18);
      io.print(`  ${timing.padEnd(23)} ${typePill} ${statusPill} ${item.title}  (${item.id})`);
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
 * Get detailed information for a calendar activity
 */
export async function detail(args, io) {
  const id = args._[0] || args.id;
  if (!id) throw new Error("Usage: dataops calendar detail <id>");

  const item = await client(args).get(`/api/calendar-items/${encodeURIComponent(id)}`);
  if (args.json) return item;

  io.print(`Calendar Activity: ${item.title}`);
  io.print(`  ID:            ${item.id}`);
  io.print(`  Type:          ${item.activityType}`);
  io.print(`  Status:        ${item.status}`);
  io.print(`  Version:       ${item.version}`);
  io.print(`  Timing:        ${formatItemTiming(item)} (${item.allDay ? "all-day" : "timed Europe/Berlin"})`);
  if (item.url) io.print(`  URL:           ${item.url}`);
  if (item.cardId) io.print(`  Card ID:       ${item.cardId}`);
  if (item.templateId) io.print(`  Template ID:   ${item.templateId}`);
  if (item.notes) io.print(`  Notes:         ${item.notes}`);

  return item;
}

/**
 * Create a new calendar activity
 */
export async function create(args, io) {
  if (!args.title) throw new Error("--title is required.");
  const activityType = args.type || args.activityType;
  if (!activityType) throw new Error("--type is required (e.g. podcast-live, webinar, workshop).");

  const body = {
    title: String(args.title),
    activityType: String(activityType),
    status: args.status ? String(args.status) : "tentative",
  };

  if (args.startsAt && args.endsAt) {
    body.allDay = false;
    body.startsAt = String(args.startsAt);
    body.endsAt = String(args.endsAt);
    body.timeZone = "Europe/Berlin";
  } else {
    body.allDay = true;
    const date = args.date || args.from || todayBerlin();
    body.startDate = String(date);
    body.endDate = String(args.to || args.endDate || date);
  }

  const eventUrl = args.link || args.eventUrl || (args.url && !args.url.includes("portal") ? args.url : undefined);
  if (eventUrl) body.url = String(eventUrl);
  if (args.notes) body.notes = String(args.notes);
  if (args.cardId) body.cardId = String(args.cardId);
  if (args.templateId) body.templateId = String(args.templateId);

  const result = await client(args).post("/api/calendar-items", body);
  if (args.json) return result;

  io.print(`Created calendar activity "${result.title}" (${result.id})`);
  io.print(`  Timing: ${formatItemTiming(result)}`);
  io.print(`  Status: ${result.status} · Type: ${result.activityType}`);
  return result;
}

/**
 * Edit an existing calendar activity
 */
export async function edit(args, io) {
  const id = args._[0] || args.id;
  if (!id) throw new Error("Usage: dataops calendar edit <id> [options]");

  const api = client(args);
  const existing = await api.get(`/api/calendar-items/${encodeURIComponent(id)}`);

  const body = {
    version: args.version !== undefined ? Number(args.version) : existing.version,
    title: args.title !== undefined ? String(args.title) : existing.title,
    activityType: args.type || args.activityType || existing.activityType,
    status: args.status !== undefined ? String(args.status) : existing.status,
  };

  if (args.startsAt && args.endsAt) {
    body.allDay = false;
    body.startsAt = String(args.startsAt);
    body.endsAt = String(args.endsAt);
    body.timeZone = "Europe/Berlin";
  } else if (args.date || args.from || args.startDate) {
    body.allDay = true;
    const date = args.date || args.from || args.startDate;
    body.startDate = String(date);
    body.endDate = String(args.to || args.endDate || date);
  } else {
    body.allDay = existing.allDay;
    if (existing.allDay) {
      body.startDate = existing.startDate || existing.startKey;
      body.endDate = existing.endDate || existing.endKey;
    } else {
      body.startsAt = existing.startsAt;
      body.endsAt = existing.endsAt;
      body.timeZone = existing.timeZone || "Europe/Berlin";
    }
  }

  const updateUrl = args.link !== undefined ? args.link : args.eventUrl !== undefined ? args.eventUrl : (args.url && !args.url.includes("portal") ? args.url : undefined);
  if (updateUrl !== undefined) body.url = updateUrl ? String(updateUrl) : null;
  else if (existing.url) body.url = existing.url;

  if (args.notes !== undefined) body.notes = args.notes ? String(args.notes) : null;
  else if (existing.notes) body.notes = existing.notes;

  if (args.cardId !== undefined) body.cardId = args.cardId ? String(args.cardId) : null;
  else if (existing.cardId) body.cardId = existing.cardId;

  if (args.templateId !== undefined) body.templateId = args.templateId ? String(args.templateId) : null;
  else if (existing.templateId) body.templateId = existing.templateId;

  const result = await api.put(`/api/calendar-items/${encodeURIComponent(id)}`, body);
  if (args.json) return result;

  io.print(`Updated calendar activity "${result.title}" (${result.id})`);
  io.print(`  Timing: ${formatItemTiming(result)}`);
  io.print(`  Status: ${result.status} · Type: ${result.activityType}`);
  return result;
}

/**
 * Delete a calendar activity
 */
export async function remove(args, io) {
  const id = args._[0] || args.id;
  if (!id) throw new Error("Usage: dataops calendar delete <id> [--version N]");

  const api = client(args);
  let version = args.version !== undefined ? Number(args.version) : undefined;
  if (version === undefined) {
    const existing = await api.get(`/api/calendar-items/${encodeURIComponent(id)}`);
    version = existing.version;
  }

  await api.delete(`/api/calendar-items/${encodeURIComponent(id)}`, { version });
  if (args.json) return { status: "deleted", id };

  io.print(`Deleted calendar activity ${id}`);
  return { status: "deleted", id };
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
  const activities = (calendarResult.items || []).filter(
    (i) => (i.startKey || i.startDate) <= dateIso && (i.endKey || i.endDate) >= dateIso,
  );
  const holidays = (calendarResult.holidays || []).filter(
    (h) => h.startDate <= dateIso && h.endDate >= dateIso,
  );
  const alexeyItems = overlayItems.filter((o) => o.category === "Alexey");

  const blockers = alexeyItems.filter(
    (e) => e.slot === "all-day" || /vacation|holiday|flight|conference|trip/i.test(e.label),
  );
  const middayEvents = alexeyItems.filter((e) => e.slot === "midday");
  const isMiddayAvailable = blockers.length === 0 && middayEvents.length === 0;

  const eveningEvents = alexeyItems.filter((e) => e.slot === "evening");
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
  for (const a of activities) {
    timeline.push({
      time: formatItemTiming(a),
      title: a.title,
      tag: `Activity: ${a.activityType || "event"}`,
    });
  }
  for (const o of overlayItems) {
    if (o.category === "Newsletter") {
      timeline.push({
        time: "Scheduled",
        title: o.label,
        tag: "Newsletter",
      });
    } else if (o.category === "Alexey" && o.slot !== "all-day") {
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
    "showAvailableSlots",
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
    if (args.showAvailableSlots !== undefined) {
      payload.showAvailableSlots = toBoolean(args.showAvailableSlots);
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
  io.print(`  Show Available Slots:        ${Boolean(s.showAvailableSlots)}`);
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
