export function setupDayScheduleDialog(options) {
  const {
    surface,
    api,
    escapeHtml,
    plannerLabel,
    onAddActivity,
    onEditActivity,
    getCalendarState,
  } = options;

  const dayDialog = surface.querySelector("[data-day-dialog]"),
    dayTitle = dayDialog?.querySelector("[data-day-title]"),
    daySubtitle = dayDialog?.querySelector("[data-day-subtitle]"),
    dayBody = dayDialog?.querySelector("[data-day-body]"),
    dayAddActivityBtn = dayDialog?.querySelector("[data-day-add-activity]"),
    dayCloseBtn = dayDialog?.querySelector("[data-day-close]"),
    dayCloseFootBtn = dayDialog?.querySelector("[data-day-close-foot]");

  let selectedDayIso = "";
  const dayOverlayCache = new Map();

  function renderDaySchedule(dateIso, overlayItems, errorMessage) {
    if (!dayBody) return;
    if (errorMessage) {
      dayBody.innerHTML = `
        <div class="honest-state planner-failure">
          <strong>Schedule unavailable</strong>
          <p>${escapeHtml(errorMessage)}</p>
        </div>
      `;
      return;
    }
    if (overlayItems === null) {
      dayBody.innerHTML = `<p class="planner-load-state" role="status">Loading full day schedule…</p>`;
      return;
    }

    const { items = [], holidays = [], overlays = [] } = getCalendarState();

    const dayActivities = items.filter(
      (i) => (i.startKey || i.startDate) <= dateIso && (i.endKey || i.endDate) >= dateIso
    );
    const dayHolidays = holidays.filter(
      (h) => h.startDate <= dateIso && h.endDate >= dateIso
    );
    const dayNewsletters = overlays.filter(
      (o) => o.category === "Newsletter" && o.startDate <= dateIso && o.endDate >= dateIso
    );
    const alexeyItems = overlayItems.filter((o) => o.category === "Alexey");

    // Operational Slot Availability
    const blockers = alexeyItems.filter(
      (e) => e.slot === "all-day" || /vacation|holiday|flight|conference|trip/i.test(e.label)
    );
    const middayEvents = alexeyItems.filter((e) => e.slot === "midday");
    const isMiddayAvailable = blockers.length === 0 && middayEvents.length === 0;

    const eveningEvents = alexeyItems.filter((e) => e.slot === "evening");
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

    for (const a of dayActivities) {
      const timeLabel = a.allDay
        ? "All day"
        : (a.startsAt ? `${a.startsAt.slice(11, 16)}–${a.endsAt ? a.endsAt.slice(11, 16) : ""}` : "All day");
      timelineEntries.push({
        time: timeLabel,
        title: a.title,
        sortTime: a.allDay ? "00:00" : (a.startsAt ? a.startsAt.slice(11, 16) : "00:00"),
        tagClass: "is-activity",
        tagLabel: plannerLabel(a.activityType || "activity"),
        id: a.id,
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
      });
    }

    for (const e of alexeyItems) {
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
                    ? `<a class="calendar-day-timeline-title" href="${escapeHtml(entry.href)}" target="_blank" rel="noreferrer">${escapeHtml(entry.title)}</a>`
                    : `<span class="calendar-day-timeline-title">${escapeHtml(entry.title)}</span>`}
                </div>
                <div class="calendar-day-timeline-tags">
                  <span class="calendar-slot-tag ${entry.tagClass}">${escapeHtml(entry.tagLabel)}</span>
                  ${entry.id
                    ? `<button type="button" class="calendar-mini-edit-btn"
                        data-edit="${escapeHtml(entry.id)}"
                        style="font-size: 11px; padding: 2px 7px; border: 1px solid var(--dk-border-default);
                          border-radius: 4px; background: var(--dk-bg-muted); cursor: pointer;">Edit</button>`
                    : ""}
                </div>
              </div>
            `
          )
          .join("");

    dayBody.innerHTML = `
      ${blockerAlert}
      <div>
        <h3 class="calendar-day-section-title">Operational Slot Availability</h3>
        ${slotCardsHtml}
      </div>
      <div>
        <h3 class="calendar-day-section-title">
          <span>Full Schedule & Other Events</span>
          <small style="font-size: 11px; font-weight: normal; color: var(--dk-text-muted);">${timelineEntries.length} ${timelineEntries.length === 1 ? "entry" : "entries"}</small>
        </h3>
        <div class="calendar-day-timeline-list">
          ${timelineRowsHtml}
        </div>
      </div>
    `;
  }

  async function openDayDialog(dateIso) {
    if (!dayDialog || !dateIso) return;
    selectedDayIso = dateIso;

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

    try {
      let overlayItems = dayOverlayCache.get(dateIso);
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
  if (dayAddActivityBtn) {
    dayAddActivityBtn.onclick = () => {
      dayDialog.close();
      if (onAddActivity) onAddActivity(selectedDayIso);
    };
  }
  if (dayBody) {
    dayBody.onclick = (event) => {
      const editBtn = event.target.closest("[data-edit]");
      if (!editBtn) return;
      const itemId = editBtn.dataset.edit;
      dayDialog.close();
      if (onEditActivity) onEditActivity(itemId);
    };
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
        if (settingsForm.elements.showAvailableSlots) {
          settingsForm.elements.showAvailableSlots.checked = s.showAvailableSlots !== false;
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
        showAvailableSlots: Boolean(settingsForm.elements.showAvailableSlots?.checked),
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
