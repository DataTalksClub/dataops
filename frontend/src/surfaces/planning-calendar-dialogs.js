
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
  const dayOverlayCache = new Map();
  let lastOverlayItems;
  let lastOverlayError = "";
  let holdsForDay = { date: "", holds: null, error: "", busy: "" };

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

    const dayEvents = items.filter((item) => item.date === dateIso);
    const dayHolidays = holidays.filter(
      (h) => h.startDate <= dateIso && h.endDate >= dateIso
    );
    const dayNewsletters = overlays.filter(
      (o) => o.provider === "newsletter-issues-readonly" && o.startDate <= dateIso && o.endDate >= dateIso
    );
    const ownerCalendarItems = overlayItems.filter((o) => o.provider === "owner-calendar");

    // Operational Slot Availability
    const blockers = ownerCalendarItems.filter(
      (e) => e.slot === "all-day" || /vacation|holiday|flight|conference|trip/i.test(e.label)
    );
    const middayEvents = ownerCalendarItems.filter((e) => e.slot === "midday");
    const isMiddayAvailable = blockers.length === 0 && middayEvents.length === 0;

    const eveningEvents = ownerCalendarItems.filter((e) => e.slot === "evening");
    const isEveningAvailable = blockers.length === 0 && eveningEvents.length === 0;

    const blockerAlert = blockers.length > 0
      ? `
        <div class="calendar-alert planner-alert is-warning" style="margin-bottom: 14px">
          <div>
            <strong>All-day Blocker</strong>
            <p>${escapeHtml(blockers.map((b) => b.label).join(" · "))}</p>
          </div>
        </div>
      `
      : "";

    const slotCardsHtml = `
      <div class="calendar-slot-summary-grid">
        <div class="calendar-slot-card">
          <div class="calendar-slot-card-header">
            <span class="calendar-slot-card-title">Midday Event Slot</span>
            <span class="calendar-slot-card-time">11:30–14:00</span>
          </div>
          <span class="calendar-slot-status-pill ${isMiddayAvailable ? "is-available" : "is-busy"}">
            ${isMiddayAvailable ? "● Available" : "● Busy / Reserved"}
          </span>
          <div class="calendar-slot-card-detail">
            ${isMiddayAvailable
              ? "No conflicts. Preferred operational window for podcasts and lunch discussions."
              : escapeHtml(middayEvents.map((e) => e.label).join(", ")
                  || (blockers.length ? "Blocked by all-day event" : "Slot reserved"))}
          </div>
        </div>
        <div class="calendar-slot-card">
          <div class="calendar-slot-card-header">
            <span class="calendar-slot-card-title">Evening Event Slot</span>
            <span class="calendar-slot-card-time">16:30–18:30</span>
          </div>
          <span class="calendar-slot-status-pill ${isEveningAvailable ? "is-available" : "is-busy"}">
            ${isEveningAvailable ? "● Available" : "● Busy / Reserved"}
          </span>
          <div class="calendar-slot-card-detail">
            ${isEveningAvailable
              ? "No conflicts. Preferred operational window for workshops, live Q&As and webinars."
              : escapeHtml(eveningEvents.map((e) => e.label).join(", ")
                  || (blockers.length ? "Blocked by all-day event" : "Slot reserved"))}
          </div>
        </div>
      </div>
    `;

    // Timeline entries
    const timelineEntries = [];

    for (const h of dayHolidays) {
      timelineEntries.push({
        time: "All day",
        title: h.name,
        sortTime: "00:00",
        tagClass: "is-holiday",
        tagLabel: h.kind === "berlin-school-holiday" ? "School holiday" : "Public holiday",
      });
    }

    // Events open their Card or episode in the portal.
    for (const event of dayEvents) {
      timelineEntries.push({
        time: "All day",
        title: event.title,
        sortTime: "00:00",
        tagClass: "is-activity",
        tagLabel: event.kindLabel,
        href: event.href,
        internal: true,
      });
    }

    for (const n of dayNewsletters) {
      timelineEntries.push({
        time: "Scheduled",
        title: n.label,
        sortTime: "08:00",
        tagClass: "is-activity",
        tagLabel: "Newsletter",
        href: n.href,
        internal: true,
      });
    }

    for (const e of ownerCalendarItems) {
      let timeLabel = "All day";
      let sortTime = "00:00";
      let title = e.label;
      const match = e.label.match(/^(\d{2}:\d{2}(?:–\d{2}:\d{2})?)\s+(.+)$/);
      if (match) {
        timeLabel = match[1];
        sortTime = match[1].slice(0, 5);
        title = match[2];
      }
      let tagClass = "is-other";
      let tagLabel = "Other event";
      if (e.slot === "midday") {
        tagClass = "is-midday";
        tagLabel = "Midday slot";
      } else if (e.slot === "evening") {
        tagClass = "is-evening";
        tagLabel = "Evening slot";
      } else if (e.slot === "all-day") {
        tagClass = "is-blocker";
        tagLabel = "Blocker";
      }

      timelineEntries.push({
        time: timeLabel,
        title,
        sortTime,
        tagClass,
        tagLabel,
        href: e.href,
      });
    }

    timelineEntries.sort((a, b) => a.sortTime.localeCompare(b.sortTime));

    const timelineRowsHtml = timelineEntries.length === 0
      ? `<p class="planner-empty-hint">No events or activities scheduled on this date.</p>`
      : timelineEntries
          .map(
            (entry) => `
              <div class="calendar-day-timeline-row">
                <div class="calendar-day-timeline-main">
                  <span class="calendar-day-timeline-time">${escapeHtml(entry.time)}</span>
                  ${entry.href
                    ? `<a class="calendar-day-timeline-title" href="${escapeHtml(entry.href)}"${
                      entry.internal ? "" : ' target="_blank" rel="noreferrer"'}>${escapeHtml(entry.title)}</a>`
                    : `<span class="calendar-day-timeline-title">${escapeHtml(entry.title)}</span>`}
                </div>
                <div class="calendar-day-timeline-tags">
                  <span class="calendar-slot-tag ${entry.tagClass}">${escapeHtml(entry.tagLabel)}</span>
                </div>
              </div>
            `
          )
          .join("");

    // A past day has no slots left to offer, so it shows only what happened.
    const isPast = dateIso < todayIsoDate();
    dayBody.innerHTML = `
      ${isPast ? "" : `${blockerAlert}
      <div>
        <h3 class="calendar-day-section-title">Operational Slot Availability</h3>
        ${slotCardsHtml}
      </div>`}
      ${holdsSectionHtml(dateIso)}
      <div>
        <h3 class="calendar-day-section-title">
          <span>Full Schedule & Other Events</span>
          <small class="calendar-day-section-count">${timelineEntries.length} ${timelineEntries.length === 1 ? "entry" : "entries"}</small>
        </h3>
        <div class="calendar-day-timeline-list">
          ${timelineRowsHtml}
        </div>
      </div>
    `;
  }

  function holdsSectionHtml(dateIso) {
    if (typeof holdsApi !== "function") return "";
    const isPast = dateIso < todayIsoDate();
    const state = holdsForDay.date === dateIso
      ? holdsForDay
      : { holds: null, error: "", busy: "" };
    let listHtml;
    if (state.error && state.holds === null) {
      listHtml = `<p class="planner-form-error" role="alert">${escapeHtml(state.error)}</p>`;
    } else if (state.holds === null) {
      listHtml = `<p class="planner-load-state">Loading holds…</p>`;
    } else if (state.holds.length === 0) {
      listHtml = `<p class="planner-empty-hint">No holds on this date. Propose one to reserve the window.</p>`;
    } else {
      listHtml = state.holds.map((hold) => {
        const active = hold.status === "tentative" || hold.status === "confirmed";
        const actions = !active
          ? `<span class="calendar-slot-tag">${escapeHtml(hold.status)}</span>`
          : hold.status === "tentative"
            ? `<button type="button" data-hold-confirm="${escapeHtml(hold.id)}"${state.busy ? " disabled" : ""}>Confirm</button>
               <button type="button" data-hold-release="${escapeHtml(hold.id)}"${state.busy ? " disabled" : ""}>Release</button>`
            : `<button type="button" data-hold-release="${escapeHtml(hold.id)}"${state.busy ? " disabled" : ""}>Release</button>`;
        const title = hold.status === "tentative" ? `(Proposal) ${hold.title}` : hold.title;
        const topic = hold.topic ? `<span class="calendar-day-timeline-topic">Topic: ${escapeHtml(hold.topic)}</span>` : "";
        return `
          <div class="calendar-day-timeline-row">
            <div class="calendar-day-timeline-main">
              <span class="calendar-day-timeline-time">${escapeHtml(hold.window)} · ${escapeHtml(String(hold.durationMinutes))} min</span>
              <span class="calendar-day-timeline-title">${escapeHtml(title)}</span>
              ${topic}
            </div>
            <div class="calendar-day-timeline-tags">${actions}</div>
          </div>
        `;
      }).join("");
    }
    const count = state.holds === null ? "" : `${state.holds.length} ${state.holds.length === 1 ? "hold" : "holds"}`;
    return `
      <div>
        <h3 class="calendar-day-section-title">
          <span>Calendar holds</span>
          <small class="calendar-day-section-count">${escapeHtml(count)}</small>
        </h3>
        <div data-holds-list>${listHtml}</div>
        ${isPast ? "" : `
        <form data-hold-propose>
          <input name="title" type="text" placeholder="Hold title" required maxlength="200" aria-label="Hold title"${state.busy ? " disabled" : ""}>
          <input name="topic" type="text" placeholder="Intended episode topic (agreed at invite time)" required maxlength="300"
            aria-label="Intended episode topic"${state.busy ? " disabled" : ""}>
          <select name="window" aria-label="Hold window">
            <option value="evening">Evening 17:00 (90-min workshop starts 16:30)</option>
            <option value="midday">Midday 12:00</option>
          </select>
          <select name="duration" aria-label="Hold duration">
            <option value="60">60 min</option>
            <option value="90">90 min</option>
          </select>
          <button type="submit"${state.busy ? " disabled" : ""}>Propose hold</button>
        </form>`}
        ${state.error && state.holds !== null ? `<p class="planner-form-error" role="alert">${escapeHtml(state.error)}</p>` : ""}
        ${state.busy ? `<p class="planner-load-state">${escapeHtml(state.busy)}</p>` : ""}
      </div>
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
            window: String(data.get("window") || "evening"),
            duration: Number(data.get("duration") || 60),
          }),
        });
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
    holdsForDay = { date: dateIso, holds: null, error: "", busy: "" };

    const formattedHeading = new Date(`${dateIso}T12:00:00Z`).toLocaleDateString("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });

    if (dayTitle) dayTitle.textContent = formattedHeading;
    if (daySubtitle) {
      daySubtitle.textContent =
        `Europe/Berlin time · Full schedule & availability for event planning (${dateIso})`;
    }

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
    connectionsDatalist = settingsDialog?.querySelector("#dapier-calendar-connections");

  if (!settingsBtn || !settingsDialog || !settingsForm) return;

  settingsBtn.onclick = async () => {
    if (settingsError) settingsError.textContent = "";
    settingsBtn.disabled = true;
    try {
      const res = await api("/settings");
      if (connectionsDatalist && Array.isArray(res.connections)) {
        connectionsDatalist.innerHTML = res.connections
          .map((c) => `<option value="${escapeHtml(c.connectionId)}">${escapeHtml(c.title)}</option>`)
          .join("");
      }
      if (res.settings) {
        const s = res.settings;
        if (settingsForm.elements.connectionId) {
          settingsForm.elements.connectionId.value = s.connectionId || "google-calendar";
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
        connectionId: settingsForm.elements.connectionId?.value?.trim() || "google-calendar",
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
