
import {
  calendarDisplayEntries,
  calendarTileLabel,
  formatCalendarTimeRanges,
} from "../core/calendar-display.js";

function formatBerlinTime(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Europe/Berlin",
  }).format(date);
}

function formatBerlinRange(startIso, endIso, fallbackWindow) {
  const start = formatBerlinTime(startIso);
  const end = formatBerlinTime(endIso);
  if (start && end) return `${start}-${end}`;
  if (start) return start;
  if (fallbackWindow === "midday") return "11:30-14:00";
  if (fallbackWindow === "evening") return "16:30-18:30";
  return "All day";
}

function windowForRange(timeRange, explicitWindow) {
  if (explicitWindow === "midday" || explicitWindow === "evening") return explicitWindow;
  const match = String(timeRange || "").match(/^(\d{2}):(\d{2})/);
  if (!match) return "";
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  if (minutes >= 11 * 60 && minutes <= 14 * 60 + 30) return "midday";
  if (minutes >= 15 * 60 + 30 && minutes <= 19 * 60 + 30) return "evening";
  return "";
}

export function setupDayScheduleDialog(options) {
  const {
    surface,
    api,
    escapeHtml,
    todayIsoDate,
    getCalendarState,
    holdsApi,
    onHoldsChanged,
  } = options;

  const dayDialog = surface.querySelector("[data-day-dialog]"),
    dayTitle = dayDialog?.querySelector("[data-day-title]"),
    daySubtitle = dayDialog?.querySelector("[data-day-subtitle]"),
    dayBody = dayDialog?.querySelector("[data-day-body]"),
    dayCloseBtn = dayDialog?.querySelector("[data-day-close]"),
    dayCloseFootBtn = dayDialog?.querySelector("[data-day-close-foot]");

  let selectedDayIso = "";
  let proposeSlot = "";
  const dayOverlayCache = new Map();
  let lastOverlayItems;
  let lastOverlayError = "";
  let holdsForDay = { date: "", holds: null, error: "", busy: "" };

  function proposeFormHtml(windowKey, busyAttr) {
    return `
      <form class="calendar-day-propose-form" data-hold-propose>
        <input type="hidden" name="window" value="${escapeHtml(windowKey)}">
        <label class="calendar-day-propose-field">
          <span>Title</span>
          <input name="title" type="text" placeholder="Name at DataTalks.Club Podcast / Webinar" required maxlength="200"
            aria-label="Hold title"${busyAttr}>
        </label>
        <label class="calendar-day-propose-field">
          <span>Topic</span>
          <input name="topic" type="text" placeholder="Intended episode topic" required maxlength="300"
            aria-label="Intended episode topic"${busyAttr}>
        </label>
        <label class="calendar-day-propose-field">
          <span>Guest</span>
          <input name="guestRef" type="email" placeholder="guest@example.com" required
            aria-label="Guest email"${busyAttr}>
        </label>
        <div class="calendar-day-propose-field">
          <span>Length</span>
          <div class="calendar-day-propose-inline">
            <select name="duration" aria-label="Hold duration"${busyAttr}>
              <option value="60" selected>60 min</option>
              <option value="90">90 min</option>
            </select>
            <input name="documentUrl" type="url" placeholder="Outline doc URL (optional)"
              aria-label="Guest document URL"${busyAttr}>
          </div>
        </div>
        <div class="calendar-day-propose-actions">
          <button type="button" class="calendar-day-action-quiet" data-propose-cancel${busyAttr}>Cancel</button>
          <button type="submit" class="primary-button calendar-day-action-primary"${busyAttr}>Propose</button>
        </div>
      </form>
    `;
  }

  function renderDaySchedule(dateIso, nextOverlays, nextError) {
    if (nextOverlays !== undefined) lastOverlayItems = nextOverlays;
    if (nextError !== undefined) lastOverlayError = nextError;
    if (!dayBody) return;
    const overlayItems = lastOverlayItems;
    const errorMessage = lastOverlayError;
    if (errorMessage) {
      dayBody.innerHTML = `
        <div class="honest-state planner-failure">
          <strong>Schedule unavailable</strong>
          <p>${escapeHtml(errorMessage)}</p>
        </div>
      `;
      return;
    }
    if (overlayItems === undefined || overlayItems === null) {
      dayBody.innerHTML = `<p class="planner-load-state">Loading full day schedule…</p>`;
      return;
    }

    const { items = [], holidays = [], overlays = [] } = getCalendarState();
    const dayEvents = calendarDisplayEntries(items).filter((item) => item.date === dateIso);
    const dayHolidays = holidays.filter(
      (h) => h.startDate <= dateIso && h.endDate >= dateIso
    );
    const dayNewsletters = calendarDisplayEntries(overlays).filter(
      (o) => o.provider === "newsletter-issues-readonly" && o.startDate <= dateIso && o.endDate >= dateIso
    );
    const ownerCalendarItems = overlayItems.filter(
      (o) => o.provider === "owner-calendar" && !o.isAvailableSlot
    );

    const holdsState = holdsForDay.date === dateIso
      ? holdsForDay
      : { holds: null, error: "", busy: "" };
    const activeHolds = Array.isArray(holdsState.holds)
      ? holdsState.holds.filter((h) => h.status === "tentative" || h.status === "confirmed")
      : [];
    const busyAttr = holdsState.busy ? " disabled" : "";
    const isPast = dateIso < todayIsoDate();

    const matchedHoldIds = new Set();
    const holdByEventId = new Map();
    for (const event of dayEvents) {
      const matched = activeHolds.find((h) => {
        if (matchedHoldIds.has(h.id)) return false;
        if (event.linkedHoldId && event.linkedHoldId === h.id) return true;
        if (h.cardId && event.entity?.id === h.cardId) return true;
        return false;
      });
      if (matched) {
        matchedHoldIds.add(matched.id);
        holdByEventId.set(event.id, matched);
      }
    }
    for (const event of dayEvents) {
      if (holdByEventId.has(event.id)) continue;
      const eventLabel = calendarTileLabel(event.title).toLowerCase();
      const matched = activeHolds.find((h) => {
        if (matchedHoldIds.has(h.id)) return false;
        const holdTitle = calendarTileLabel(h.title || "").toLowerCase();
        const holdTopic = calendarTileLabel(h.topic || "").toLowerCase();
        return (holdTitle && (eventLabel.includes(holdTitle) || holdTitle.includes(eventLabel)))
          || (holdTopic && (eventLabel.includes(holdTopic) || holdTopic.includes(eventLabel)));
      });
      if (matched) {
        matchedHoldIds.add(matched.id);
        holdByEventId.set(event.id, matched);
      }
    }
    const unlinkedHolds = activeHolds.filter((h) => !matchedHoldIds.has(h.id));

    const occupiedWindows = new Set();
    const rows = [];

    for (const h of dayHolidays) {
      rows.push({
        sortTime: "00:00",
        time: "All day",
        titleHtml: `<span class="calendar-day-timeline-title">${escapeHtml(h.name)}</span>`,
        metaHtml: `<span class="calendar-day-row-meta">${h.kind === "berlin-school-holiday" ? "School holiday" : "Public holiday"}</span>`,
        actionsHtml: "",
        extraHtml: "",
      });
    }

    const blockers = ownerCalendarItems.filter(
      (e) => e.slot === "all-day" || /vacation|holiday|flight|conference|trip/i.test(e.label)
    );
    const usedOwnerItemIds = new Set(blockers.map((b) => b.id));
    for (const b of blockers) {
      rows.push({
        sortTime: "00:01",
        time: "All day",
        titleHtml: `<span class="calendar-day-timeline-title">${escapeHtml(formatCalendarTimeRanges(b.label))}</span>`,
        metaHtml: `<span class="calendar-day-row-meta"><span class="planner-status is-danger">Blocked</span> · no slots today</span>`,
        actionsHtml: "",
        extraHtml: "",
      });
    }

    for (const n of dayNewsletters) {
      const issueCard = n.newsletter || {};
      const href = issueCard.cardId
        ? `/cards?cardId=${encodeURIComponent(issueCard.cardId)}`
        : n.href;
      const label = calendarTileLabel(n.label);
      rows.push({
        sortTime: "08:00",
        time: "Scheduled",
        titleHtml: href
          ? `<a class="calendar-day-timeline-title" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`
          : `<span class="calendar-day-timeline-title">${escapeHtml(label)}</span>`,
        metaHtml: `<span class="calendar-day-row-meta">Newsletter</span>`,
        actionsHtml: "",
        extraHtml: "",
      });
    }

    for (const event of dayEvents) {
      const hold = holdByEventId.get(event.id);
      const time = formatBerlinRange(
        hold?.startIso || event.startsAt,
        hold?.endIso || event.endsAt,
        hold?.window
      );
      const sortTime = time === "All day" ? "00:02" : time.slice(0, 5);
      const w = windowForRange(time, hold?.window);
      if (w) occupiedWindows.add(w);
      const isProposed = hold ? hold.status === "tentative" : event.timeStatus === "proposed";
      const label = calendarTileLabel(event.title);
      const titleHtml = event.href
        ? `<a class="calendar-day-timeline-title" href="${escapeHtml(event.href)}">${escapeHtml(label)}</a>`
        : `<span class="calendar-day-timeline-title">${escapeHtml(label)}</span>`;
      const metaParts = [escapeHtml(event.kindLabel)];
      if (hold?.topic && !label.toLowerCase().includes(hold.topic.toLowerCase())) {
        metaParts.push(`Topic: ${escapeHtml(hold.topic)}`);
      }
      if (isProposed) {
        metaParts.push('<span class="planner-status is-warning">Proposed</span>');
      }
      let actionsHtml = "";
      if (hold) {
        if (hold.status === "tentative") {
          actionsHtml = `
            <button type="button" class="primary-button calendar-day-action-primary" data-hold-confirm="${escapeHtml(hold.id)}"${busyAttr}>Confirm</button>
            <button type="button" class="calendar-day-action-quiet" data-hold-release="${escapeHtml(hold.id)}"${busyAttr}>Release</button>
          `;
        } else if (hold.googleSync?.state === "deferred") {
          actionsHtml = `<button type="button" class="calendar-day-action-quiet" data-hold-confirm="${escapeHtml(hold.id)}"${busyAttr}>Retry</button>`;
        }
      }
      const extraHtml = hold?.googleSync?.state === "deferred"
        ? `<p class="planner-form-error calendar-day-sync-error" role="alert">Google sync deferred: ${escapeHtml(hold.googleSync.reason || "Calendar connection unavailable")}</p>`
        : "";
      rows.push({
        sortTime,
        time,
        titleHtml,
        metaHtml: `<span class="calendar-day-row-meta">${metaParts.join(" · ")}</span>`,
        actionsHtml,
        extraHtml,
      });
    }

    for (const hold of unlinkedHolds) {
      const time = formatBerlinRange(hold.startIso, hold.endIso, hold.window);
      const sortTime = /^\d{2}:\d{2}/.test(time)
        ? time.slice(0, 5)
        : hold.window === "midday" ? "12:30" : "17:00";
      const w = windowForRange(time, hold.window);
      if (w) occupiedWindows.add(w);
      const isProposed = hold.status === "tentative";
      const label = calendarTileLabel(hold.title || "Calendar hold");
      const metaParts = [];
      if (hold.topic) metaParts.push(`Topic: ${escapeHtml(hold.topic)}`);
      metaParts.push(isProposed ? '<span class="planner-status is-warning">Proposed</span>' : "Confirmed");
      const retryBtn = !isProposed && hold.googleSync?.state === "deferred"
        ? `<button type="button" class="calendar-day-action-quiet" data-hold-confirm="${escapeHtml(hold.id)}"${busyAttr}>Retry</button>`
        : "";
      const actionsHtml = isProposed
        ? `<button type="button" class="primary-button calendar-day-action-primary" data-hold-confirm="${escapeHtml(hold.id)}"${busyAttr}>Confirm</button>
           <button type="button" class="calendar-day-action-quiet" data-hold-release="${escapeHtml(hold.id)}"${busyAttr}>Release</button>`
        : `${retryBtn}<button type="button" class="calendar-day-action-quiet" data-hold-release="${escapeHtml(hold.id)}"${busyAttr}>Release</button>`;
      const extraHtml = hold.googleSync?.state === "deferred"
        ? `<p class="planner-form-error calendar-day-sync-error" role="alert">Google sync deferred: ${escapeHtml(hold.googleSync.reason || "Calendar connection unavailable")}</p>`
        : "";
      rows.push({
        sortTime,
        time,
        titleHtml: `<span class="calendar-day-timeline-title">${escapeHtml(label)}</span>`,
        metaHtml: `<span class="calendar-day-row-meta">${metaParts.join(" · ")}</span>`,
        actionsHtml,
        extraHtml,
      });
    }

    if (!isPast && blockers.length === 0) {
      const slotDefs = [
        { key: "midday", label: "Midday slot", time: "11:30-14:00", sortTime: "11:30" },
        { key: "evening", label: "Evening slot", time: "16:30-18:30", sortTime: "16:30" },
      ];
      for (const slotDef of slotDefs) {
        const slotOwnerEvents = ownerCalendarItems.filter((e) => e.slot === slotDef.key);
        if (occupiedWindows.has(slotDef.key)) {
          for (const e of slotOwnerEvents) usedOwnerItemIds.add(e.id);
          continue;
        }
        if (slotOwnerEvents.length > 0) {
          for (const e of slotOwnerEvents) usedOwnerItemIds.add(e.id);
          const busyMeta = slotOwnerEvents.map((e) => formatCalendarTimeRanges(e.label)).join(" · ");
          rows.push({
            sortTime: slotDef.sortTime,
            time: slotDef.time,
            titleHtml: `<span class="calendar-day-timeline-title is-muted">${slotDef.label} · busy</span>`,
            metaHtml: `<span class="calendar-day-row-meta">${escapeHtml(busyMeta)}</span>`,
            actionsHtml: "",
            extraHtml: "",
          });
        } else {
          const isOpenForm = proposeSlot === slotDef.key;
          const expanded = isOpenForm ? "true" : "false";
          const proposeBtn = typeof holdsApi === "function"
            ? `<button type="button" class="calendar-day-propose-btn" data-propose-slot="${slotDef.key}" ` +
              `aria-expanded="${expanded}"${busyAttr}>Propose</button>`
            : "";
          rows.push({
            sortTime: slotDef.sortTime,
            time: slotDef.time,
            titleHtml: `<span class="calendar-day-timeline-title is-free-slot">${slotDef.label} · free</span>`,
            metaHtml: "",
            actionsHtml: proposeBtn,
            extraHtml: isOpenForm ? proposeFormHtml(slotDef.key, busyAttr) : "",
          });
        }
      }
    }

    rows.sort((a, b) => a.sortTime.localeCompare(b.sortTime));

    const otherOwnerEvents = ownerCalendarItems.filter((e) => !usedOwnerItemIds.has(e.id));
    const otherRowsHtml = otherOwnerEvents.map((e) => {
      const ownerLabel = formatCalendarTimeRanges(e.label);
      const match = ownerLabel.match(/^(\d{2}:\d{2}(?:-\d{2}:\d{2})?)\s+(.+)$/);
      const timeLabel = match ? match[1] : "All day";
      const title = match ? match[2] : ownerLabel;
      return `
        <div class="calendar-day-row is-other-event">
          <span class="calendar-day-timeline-time">${escapeHtml(timeLabel)}</span>
          <div class="calendar-day-row-main">
            ${e.href
              ? `<a class="calendar-day-timeline-title" href="${escapeHtml(e.href)}" target="_blank" rel="noreferrer">${escapeHtml(title)}</a>`
              : `<span class="calendar-day-timeline-title">${escapeHtml(title)}</span>`}
          </div>
        </div>
      `;
    }).join("");
    const otherEventsHtml = otherOwnerEvents.length > 0
      ? `
        <details class="calendar-day-other-events">
          <summary>${otherOwnerEvents.length} other calendar ${otherOwnerEvents.length === 1 ? "event" : "events"}</summary>
          <div class="calendar-day-list is-compact">${otherRowsHtml}</div>
        </details>
      `
      : "";

    const rowsHtml = rows.length === 0
      ? `<p class="planner-empty-hint">No events or activities scheduled on this date.</p>`
      : rows.map((row) => `
          <div class="calendar-day-row">
            <span class="calendar-day-timeline-time">${escapeHtml(row.time)}</span>
            <div class="calendar-day-row-main">
              ${row.titleHtml}
              ${row.metaHtml}
              ${row.extraHtml}
            </div>
            ${row.actionsHtml ? `<div class="calendar-day-row-actions">${row.actionsHtml}</div>` : ""}
          </div>
        `).join("");

    dayBody.innerHTML = `
      <div class="calendar-day-list" data-holds-list>
        ${rowsHtml}
      </div>
      ${otherEventsHtml}
      ${holdsState.error ? `<p class="planner-form-error" role="alert">${escapeHtml(holdsState.error)}</p>` : ""}
      ${holdsState.busy ? `<p class="planner-load-state">${escapeHtml(holdsState.busy)}</p>` : ""}
    `;
  }

  async function refreshHolds(dateIso) {
    if (typeof holdsApi !== "function" || selectedDayIso !== dateIso) return;
    try {
      const res = await holdsApi(`?from=${dateIso}&to=${dateIso}`);
      if (selectedDayIso !== dateIso) return;
      holdsForDay = { date: dateIso, holds: res.holds || [], error: "", busy: "" };
    } catch (err) {
      if (selectedDayIso !== dateIso) return;
      holdsForDay = { date: dateIso, holds: holdsForDay.holds, error: err.message, busy: "" };
    }
    renderDaySchedule(dateIso);
  }

  async function holdAction(kind, id, form) {
    if (typeof holdsApi !== "function") return;
    const dateIso = selectedDayIso;
    if (!dateIso) return;
    holdsForDay = { ...holdsForDay, date: dateIso, error: "", busy: kind === "propose" ? "Proposing hold…" : "Updating hold…" };
    renderDaySchedule(dateIso);
    try {
      if (kind === "propose") {
        const data = new FormData(form);
        await holdsApi("", {
          method: "POST",
          body: JSON.stringify({
            date: dateIso,
            title: String(data.get("title") || ""),
            topic: String(data.get("topic") || ""),
            guestRef: String(data.get("guestRef") || ""),
            documentUrl: String(data.get("documentUrl") || ""),
            window: String(data.get("window") || "evening"),
            duration: Number(data.get("duration") || 60),
          }),
        });
        proposeSlot = "";
      } else if (kind === "confirm") {
        await holdsApi(`/${encodeURIComponent(id)}/confirm`, { method: "POST", body: "{}" });
      } else {
        await holdsApi(`/${encodeURIComponent(id)}/release`, {
          method: "POST",
          body: JSON.stringify({ reason: "manual" }),
        });
      }
      dayOverlayCache.delete(dateIso);
      holdsForDay = { date: dateIso, holds: holdsForDay.holds, error: "", busy: "" };
      renderDaySchedule(dateIso);
      await refreshHolds(dateIso);
      try {
        const res = dateIso < todayIsoDate()
          ? { items: [] }
          : await api(`/overlays?from=${dateIso}&to=${dateIso}&includeAll=true`);
        dayOverlayCache.set(dateIso, res.items || []);
        if (selectedDayIso === dateIso) renderDaySchedule(dateIso, res.items || []);
      } catch {
        // Holds already refreshed; the overlay reload can retry on reopen.
      }
      if (typeof onHoldsChanged === "function") onHoldsChanged();
    } catch (err) {
      if (selectedDayIso !== dateIso) return;
      holdsForDay = { date: dateIso, holds: holdsForDay.holds, error: err.message, busy: "" };
      renderDaySchedule(dateIso);
    }
  }

  async function openDayDialog(dateIso) {
    if (!dayDialog || !dateIso) return;
    selectedDayIso = dateIso;
    proposeSlot = "";
    holdsForDay = { date: dateIso, holds: null, error: "", busy: "" };

    const formattedHeading = new Date(`${dateIso}T12:00:00Z`).toLocaleDateString("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });

    if (dayTitle) dayTitle.textContent = formattedHeading;
    if (daySubtitle) daySubtitle.textContent = "Berlin time";

    renderDaySchedule(dateIso, null);
    dayDialog.showModal();
    refreshHolds(dateIso);

    try {
      // The owner's calendar is not read for past days, so there is nothing
      // to fetch for one.
      let overlayItems = dateIso < todayIsoDate() ? [] : dayOverlayCache.get(dateIso);
      if (!overlayItems) {
        const res = await api(`/overlays?from=${dateIso}&to=${dateIso}&includeAll=true`);
        overlayItems = res.items || [];
        dayOverlayCache.set(dateIso, overlayItems);
      }
      if (selectedDayIso === dateIso) {
        renderDaySchedule(dateIso, overlayItems);
      }
    } catch (err) {
      if (selectedDayIso === dateIso && dayBody) {
        renderDaySchedule(dateIso, [], err.message);
      }
    }
  }

  if (dayCloseBtn) dayCloseBtn.onclick = () => dayDialog.close();
  if (dayCloseFootBtn) dayCloseFootBtn.onclick = () => dayDialog.close();
  if (dayBody) {
    dayBody.addEventListener("click", (event) => {
      const proposeBtn = event.target.closest("[data-propose-slot]");
      if (proposeBtn) {
        const next = proposeBtn.dataset.proposeSlot;
        proposeSlot = proposeSlot === next ? "" : next;
        renderDaySchedule(selectedDayIso);
        return;
      }
      const cancelBtn = event.target.closest("[data-propose-cancel]");
      if (cancelBtn) {
        proposeSlot = "";
        renderDaySchedule(selectedDayIso);
        return;
      }
      const confirmBtn = event.target.closest("[data-hold-confirm]");
      const releaseBtn = event.target.closest("[data-hold-release]");
      if (confirmBtn) holdAction("confirm", confirmBtn.dataset.holdConfirm);
      else if (releaseBtn) holdAction("release", releaseBtn.dataset.holdRelease);
    });
    dayBody.addEventListener("submit", (event) => {
      const form = event.target.closest("[data-hold-propose]");
      if (!form) return;
      event.preventDefault();
      holdAction("propose", "", form);
    });
  }
  return {
    openDayDialog,
    clearCache: () => dayOverlayCache.clear(),
  };
}

export function setupCalendarSettingsDialog(options) {
  const {
    surface,
    api,
    escapeHtml,
    onSettingsSaved,
  } = options;

  const settingsDialog = surface.querySelector("[data-settings-dialog]"),
    settingsForm = settingsDialog?.querySelector("form"),
    settingsBtn = surface.querySelector("[data-calendar-settings]"),
    settingsError = settingsDialog?.querySelector("[data-settings-error]"),
    connectionsPicker = settingsDialog?.querySelector("#dapier-calendar-connections");

  if (!settingsBtn || !settingsDialog || !settingsForm) return;

  settingsBtn.onclick = async () => {
    if (settingsError) settingsError.textContent = "";
    settingsBtn.disabled = true;
    try {
      const res = await api("/settings");
      if (connectionsPicker && Array.isArray(res.connections)) {
        connectionsPicker.innerHTML = '<option value="">Choose a Google Calendar connection</option>' + res.connections
          .map((c) => `<option value="${escapeHtml(c.connectionId)}">${escapeHtml(c.title)}</option>`)
          .join("");
      }
      if (settingsError) settingsError.textContent = res.connectionProblem || "";
      if (res.settings) {
        const s = res.settings;
        if (settingsForm.elements.connectionId) {
          const selected = s.connectionId || "";
          if (selected && !res.connections?.some((c) => c.connectionId === selected) && connectionsPicker) {
            connectionsPicker.innerHTML += `<option value="${escapeHtml(selected)}">${escapeHtml(selected)} (unavailable — check Dapier grant)</option>`;
          }
          settingsForm.elements.connectionId.value = selected;
        }
        if (settingsForm.elements.filterNonSlotHours) {
          settingsForm.elements.filterNonSlotHours.checked = s.filterNonSlotHours !== false;
        }
        if (settingsForm.elements.filterDtcPlaceholders) {
          settingsForm.elements.filterDtcPlaceholders.checked = s.filterDtcPlaceholders !== false;
        }
        if (settingsForm.elements.filterTransparent) {
          settingsForm.elements.filterTransparent.checked = s.filterTransparent !== false;
        }
        if (settingsForm.elements.filterLunch) {
          settingsForm.elements.filterLunch.checked = s.filterLunch !== false;
        }
        if (settingsForm.elements.filterRoutines) {
          settingsForm.elements.filterRoutines.checked = s.filterRoutines !== false;
        }
        if (settingsForm.elements.filterFitness) {
          settingsForm.elements.filterFitness.checked = s.filterFitness !== false;
        }
        if (settingsForm.elements.filterCampaigns) {
          settingsForm.elements.filterCampaigns.checked = s.filterCampaigns !== false;
        }
        if (settingsForm.elements.filterBusy) {
          settingsForm.elements.filterBusy.checked = s.filterBusy !== false;
        }
        if (settingsForm.elements.customKeywords) {
          settingsForm.elements.customKeywords.value = (s.customKeywords || []).join("\n");
        }
      }
      settingsDialog.showModal();
    } catch (err) {
      if (settingsError) settingsError.textContent = `Could not load settings: ${err.message}`;
      settingsDialog.showModal();
    } finally {
      settingsBtn.disabled = false;
    }
  };

  const settingsCancelBtn = settingsDialog.querySelector("[data-settings-cancel]");
  if (settingsCancelBtn) {
    settingsCancelBtn.onclick = () => settingsDialog.close();
  }

  settingsForm.onsubmit = async (e) => {
    e.preventDefault();
    if (settingsError) settingsError.textContent = "";
    const submitBtn = settingsForm.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    try {
      const rawKeywords = settingsForm.elements.customKeywords?.value || "";
      const customKeywords = rawKeywords
        .split(/[\n,]+/)
        .map((k) => k.trim())
        .filter(Boolean);
      const body = {
        connectionId: settingsForm.elements.connectionId?.value?.trim() || "",
        filterNonSlotHours: Boolean(settingsForm.elements.filterNonSlotHours?.checked),
        filterDtcPlaceholders: Boolean(settingsForm.elements.filterDtcPlaceholders?.checked),
        filterTransparent: Boolean(settingsForm.elements.filterTransparent?.checked),
        filterLunch: Boolean(settingsForm.elements.filterLunch?.checked),
        filterRoutines: Boolean(settingsForm.elements.filterRoutines?.checked),
        filterFitness: Boolean(settingsForm.elements.filterFitness?.checked),
        filterCampaigns: Boolean(settingsForm.elements.filterCampaigns?.checked),
        filterBusy: Boolean(settingsForm.elements.filterBusy?.checked),
        customKeywords,
      };
      await api("/settings", { method: "PUT", body: JSON.stringify(body) });
      settingsDialog.close();
      if (onSettingsSaved) onSettingsSaved();
    } catch (err) {
      if (settingsError) settingsError.textContent = `Could not save settings: ${err.message}`;
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  };
}
