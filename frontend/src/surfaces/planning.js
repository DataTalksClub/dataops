import { parseIsoDateValue } from "../core/workspace.js";

export function createPlanningSurface(context) {
  const {
    documentList,
    escapeHtml,
    request,
    setRouteTitle,
    todayIsoDate,
    workApiUrl,
  } = context;

  function plannerLabel(value) {
    const label = String(value || "").replaceAll("-", " ");
    return label ? label[0].toUpperCase() + label.slice(1) : "";
  }

  function plannerStatusClass(value) {
    if (["sent", "published", "confirmed"].includes(value)) return "is-success";
    if (["cancelled"].includes(value)) return "is-danger";
    if (["reserved", "drafting", "scheduled", "announced"].includes(value)) return "is-info";
    if (["tentative", "open"].includes(value)) return "is-warning";
    return "";
  }

  function formatShortPlanningDate(iso) {
    const parsed = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
    return Number.isNaN(parsed.getTime())
      ? String(iso)
      : new Intl.DateTimeFormat("en-GB", {
          day: "numeric",
          month: "short",
          timeZone: "UTC",
        }).format(parsed);
  }

  function calendarAlertCopy(reasonCode) {
    return {
      "public-holiday-overlap": "Activity overlaps a public holiday",
      "school-holiday-overlap": "Activity overlaps a school holiday",
      "school-free-day-overlap": "Activity overlaps a school-free day",
      "activity-overlap": "Two activities overlap",
      "missing-workflow-context": "Activity has no linked workflow",
    }[reasonCode] || "Calendar timing needs review";
  }

  function newsletterAlertCopy(reasonCode) {
    return {
      "near-term-open-unbooked": "An open slot needs booking soon",
      "duplicate-campaign-number": "Campaign numbers need review",
      "publication-date-overlap": "Multiple campaigns share a publication date",
      "publication-missing-workflow": "Publication is missing its workflow card",
      "reserved-missing-booker": "A reserved slot has no booker",
    }[reasonCode] || "Newsletter planning needs review";
  }

  // Advice is per reason: two alerts on one slot must read as two different
  // facts, never the same sentence twice.
  function newsletterAlertAdvice(reasonCode) {
    return {
      "near-term-open-unbooked": "Book an owner or move the date.",
      "duplicate-campaign-number": "Renumber one of the campaigns.",
      "publication-date-overlap": "Stagger the publication dates.",
      "publication-missing-workflow": "Attach the issue's workflow card.",
      "reserved-missing-booker": "Name the booker or release the slot.",
    }[reasonCode] || "Open the slot and resolve it before it ships.";
  }

  async function renderCalendarSurface() {
    documentList.replaceChildren();
    const activityTypes = ["podcast-live", "podcast-release", "webinar", "workshop", "book-of-the-week", "course", "cohort", "other"];
    const activityTypeOptions = activityTypes
      .map((value) => `
        <option value="${value}">${plannerLabel(value)}</option>
      `)
      .join("");
    const activityStatusOptions = ["tentative", "confirmed", "announced", "published", "cancelled"]
      .map((value) => `
        <option value="${value}">${plannerLabel(value)}</option>
      `)
      .join("");
    const surface = document.createElement("section");
    surface.className = "calendar-surface";
    surface.setAttribute("aria-labelledby", "calendar-surface-title");
    surface.innerHTML = `
      <header class="planner-header calendar-header-bar">
        <div class="calendar-header-main">
          <div class="calendar-nav-group">
            <button type="button" class="calendar-today-btn" data-today>Today</button>
            <div class="calendar-nav-arrows" role="group" aria-label="Change calendar period">
              <button type="button" class="calendar-nav-arrow" data-prev aria-label="Previous period" title="Previous period">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
              </button>
              <button type="button" class="calendar-nav-arrow" data-next aria-label="Next period" title="Next period">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
              </button>
            </div>
            <div class="calendar-picker-container">
              <h1 id="calendar-surface-title" class="calendar-heading-wrapper">
                <button type="button" class="calendar-period-btn" data-picker-toggle aria-haspopup="dialog" aria-expanded="false" title="Choose month and year">
                  <span class="calendar-period-title" data-period-heading>Calendar</span>
                  <svg class="calendar-period-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="6 9 12 15 18 9"></polyline>
                  </svg>
                </button>
              </h1>
              <span class="calendar-timezone-badge">Europe/Berlin time</span>
              <div class="calendar-month-picker-popover" data-picker-popover hidden role="dialog" aria-label="Choose month and year">
                <div class="calendar-picker-year-nav">
                  <button type="button" class="calendar-picker-year-btn" data-picker-prev-year aria-label="Previous year">‹</button>
                  <span class="calendar-picker-year-label" data-picker-year>2026</span>
                  <button type="button" class="calendar-picker-year-btn" data-picker-next-year aria-label="Next year">›</button>
                </div>
                <div class="calendar-picker-months-grid" role="grid" aria-label="Months">
                  ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
                    .map((m, i) => `<button type="button" class="calendar-picker-month-btn" data-picker-month="${i}">${m}</button>`)
                    .join("")}
                </div>
                <div class="calendar-picker-foot">
                  <button type="button" class="calendar-picker-today-btn" data-picker-current-month>Current month</button>
                </div>
              </div>
            </div>
          </div>
          <div class="calendar-header-actions">
            <select data-view aria-label="Calendar view" hidden>
              <option value="month" selected>Month</option>
              <option value="week">Week</option>
            </select>
            <button class="primary-button calendar-add-button" data-add>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
              <span>Add activity</span>
            </button>
          </div>
        </div>
      </header>
      <p class="planner-load-state" role="status">Loading calendar…</p>
      <div class="planner-alerts" data-alerts></div>
      <div data-calendar></div>
      <footer class="calendar-footer-controls" aria-label="Calendar controls">
        <div class="calendar-footer-controls-bar">
          <div class="calendar-filter-section">
            <span class="calendar-control-label">Filter:</span>
            <label class="calendar-select-label" title="Filter by activity type">
              <select data-type aria-label="Activity type">
                <option value="">All activities</option>
                ${activityTypeOptions}
              </select>
            </label>
          </div>
          <div class="calendar-layers" role="toolbar" aria-label="Show on calendar">
            <span class="calendar-control-label">Show:</span>
            <input data-layer="activities" type="checkbox" checked hidden>
            <label class="calendar-layer-chip is-public">
              <input data-layer="public" type="checkbox" checked>
              <span class="chip-dot"></span>
              <span>Public holidays</span>
            </label>
            <label class="calendar-layer-chip is-school">
              <input data-layer="school" type="checkbox" checked>
              <span class="chip-dot"></span>
              <span>School holidays</span>
            </label>
            <label class="calendar-layer-chip is-overlay">
              <input data-layer="overlay" type="checkbox" checked>
              <span class="chip-dot"></span>
              <span>Newsletter dates</span>
            </label>
            <label class="calendar-layer-chip is-alexey">
              <input data-layer="alexey" type="checkbox" checked>
              <span class="chip-dot"></span>
              <span>Alexey's calendar</span>
            </label>
            <button type="button" class="calendar-layer-settings-btn" data-calendar-settings title="Configure overlay filters & connection">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="3"></circle>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
              </svg>
              <span>Settings</span>
            </button>
          </div>
        </div>
      </footer>
      <dialog class="dk-dialog" data-activity-dialog style="--dk-dialog-width: 620px">
        <form>
          <div class="dk-dialog__head"><div>
            <h2>Calendar activity</h2>
            <p>Add the timing and planning context operators need.</p>
          </div></div>
          <div class="dk-dialog__body">
          <input name="id" type="hidden">
          <input name="version" type="hidden">
          <div class="planner-form-grid">
            <label class="planner-field-wide">Title <input name="title" required maxlength="200"></label>
            <label>Type
              <select name="activityType">${activityTypeOptions}</select>
            </label>
            <label>Status
              <select name="status">${activityStatusOptions}</select>
            </label>
            <label>Start date <input name="startDate" type="date" required></label>
            <label>End date <input name="endDate" type="date" required></label>
            <label class="planner-field-wide">Card reference <input name="cardId" autocomplete="off"></label>
            <label class="planner-field-wide">Planning notes <textarea name="notes" maxlength="2000" rows="4"></textarea></label>
          </div>
          <p class="planner-form-error" role="alert"></p>
          </div>
          <div class="dk-dialog__foot">
            <button class="primary-button">Save activity</button>
            <button type="button" data-cancel>Cancel</button>
          </div>
        </form>
      </dialog>
      <dialog class="dk-dialog calendar-settings-dialog" data-settings-dialog style="--dk-dialog-width: 520px">
        <form data-settings-form>
          <div class="dk-dialog__head"><div>
            <h2>Alexey's calendar overlay settings</h2>
            <p>Configure which Google Calendar connection to use and filter out personal routines.</p>
          </div></div>
          <div class="dk-dialog__body">
            <div class="calendar-settings-group">
              <label class="calendar-settings-field">
                <strong>Dapier calendar connection</strong>
                <span class="calendar-settings-hint">Select a connected calendar or enter a custom connection ID</span>
                <input name="connectionId" list="dapier-calendar-connections" required autocomplete="off" placeholder="google-calendar">
                <datalist id="dapier-calendar-connections"></datalist>
              </label>
            </div>
            <div class="calendar-settings-group">
              <strong>Operational event slot focus</strong>
              <span class="calendar-settings-hint">Focus strictly on operational availability slots and all-day blockers per SOP:</span>
              <div class="calendar-settings-checkboxes">
                <label class="calendar-settings-checkbox">
                  <input type="checkbox" name="filterNonSlotHours">
                  <span>Focus on operational event slots <small>(Lunch 11:30–14:00 & Evening 16:30–18:30 + all-day blockers)</small></span>
                </label>
                <label class="calendar-settings-checkbox">
                  <input type="checkbox" name="filterDtcPlaceholders">
                  <span>Filter DTC placeholder blocks <small>(DTC event block)</small></span>
                </label>
                <label class="calendar-settings-checkbox">
                  <input type="checkbox" name="filterTransparent">
                  <span>Filter transparent / free events <small>(Hotel stays, campaign periods; preserves flights/travel)</small></span>
                </label>
              </div>
            </div>
            <div class="calendar-settings-group">
              <strong>Filter out preset categories</strong>
              <span class="calendar-settings-hint">Selected categories are removed from the calendar view:</span>
              <div class="calendar-settings-checkboxes">
                <label class="calendar-settings-checkbox">
                  <input type="checkbox" name="filterLunch">
                  <span>Lunch and meal breaks <small>(Lunch, обед, lunch break)</small></span>
                </label>
                <label class="calendar-settings-checkbox">
                  <input type="checkbox" name="filterRoutines">
                  <span>Personal routines & chores <small>(Morning no, домашка, меню, ручки, bills)</small></span>
                </label>
                <label class="calendar-settings-checkbox">
                  <input type="checkbox" name="filterFitness">
                  <span>Fitness & health <small>(BEAT81, physio, dental)</small></span>
                </label>
                <label class="calendar-settings-checkbox">
                  <input type="checkbox" name="filterCampaigns">
                  <span>Marketing campaign windows <small>(campaign window)</small></span>
                </label>
                <label class="calendar-settings-checkbox">
                  <input type="checkbox" name="filterBusy">
                  <span>Busy / private blocks <small>(Busy, занято)</small></span>
                </label>
              </div>
            </div>
            <div class="calendar-settings-group">
              <label class="calendar-settings-field">
                <strong>Custom filter keywords</strong>
                <span class="calendar-settings-hint">Events containing any of these keywords (case-insensitive) will be hidden. Separate with commas or newlines.</span>
                <textarea name="customKeywords" rows="3" placeholder="e.g. haircut, dentist, school run"></textarea>
              </label>
            </div>
            <p class="planner-form-error" data-settings-error role="alert"></p>
          </div>
          <div class="dk-dialog__foot">
            <button class="primary-button" type="submit">Save settings</button>
            <button type="button" data-settings-cancel>Cancel</button>
          </div>
        </form>
      </dialog>`;
    documentList.append(surface);
    setRouteTitle("Calendar");

    const status = surface.querySelector('[role="status"]'),
      grid = surface.querySelector("[data-calendar]"),
      alertsBox = surface.querySelector("[data-alerts]"),
      dialog = surface.querySelector("dialog"),
      form = dialog.querySelector("form");
    let cursor = parseIsoDateValue(todayIsoDate()),
      items = [],
      holidays = [],
      overlays = [];
    const api = (path, options = {}) => request(workApiUrl(`/api/calendar-items${path}`), {
        headers: { "content-type": "application/json", ...(options.headers || {}) },
        ...options,
      }),
      iso = (date) => date.toISOString().slice(0, 10),
      monday = (date) => {
        const value = new Date(date), offset = (value.getUTCDay() + 6) % 7;
        value.setUTCDate(value.getUTCDate() - offset);
        return value;
      },
      sunday = (date) => {
        const value = monday(date);
        value.setUTCDate(value.getUTCDate() + 6);
        return value;
      },
      weekNumber = (date) => {
        const value = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
        value.setUTCDate(value.getUTCDate() + 4 - (value.getUTCDay() || 7));
        const yearStart = new Date(Date.UTC(value.getUTCFullYear(), 0, 1));
        return String(Math.ceil((((value - yearStart) / 86400000) + 1) / 7)).padStart(2, "0");
      };

    function bounds() {
      if (surface.querySelector("[data-view]").value === "week") return [iso(monday(cursor)), iso(sunday(cursor))];
      const year = cursor.getUTCFullYear(), month = cursor.getUTCMonth();
      const first = new Date(Date.UTC(year, month, 1));
      const day = first.getUTCDay();
      if (day === 0) first.setUTCDate(2);
      else if (day === 6) first.setUTCDate(3);
      const last = new Date(Date.UTC(year, month + 1, 0));
      return [iso(monday(first)), iso(sunday(last))];
    }

    function render() {
      const [from, to] = bounds(),
        isWeek = surface.querySelector("[data-view]").value === "week",
        showActivities = surface.querySelector('[data-layer="activities"]').checked,
        showPublic = surface.querySelector('[data-layer="public"]').checked,
        showSchool = surface.querySelector('[data-layer="school"]').checked,
        showOverlay = surface.querySelector('[data-layer="overlay"]')?.checked ?? true,
        showAlexey = surface.querySelector('[data-layer="alexey"]')?.checked ?? true,
        type = surface.querySelector("[data-type]").value,
        visibleItems = showActivities ? items.filter((item) => !type || item.activityType === type) : [],
        periodLabel = isWeek
          ? `Week of ${new Date(`${from}T00:00:00Z`).toLocaleDateString("en", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })}`
          : cursor.toLocaleDateString("en", { month: "long", year: "numeric", timeZone: "UTC" });
      const periodHeadingEl = surface.querySelector("[data-period-heading]");
      if (periodHeadingEl) periodHeadingEl.textContent = periodLabel;
      const weekdayHeadings = [
        '<strong class="calendar-week-heading" aria-label="Week number">Week</strong>',
        ...["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]
          .map((day) => `<strong>${day}</strong>`),
      ].join("");
      let weekMarkup = "";
      for (let dateValue = new Date(`${from}T00:00:00Z`); dateValue <= new Date(`${to}T00:00:00Z`); dateValue.setUTCDate(dateValue.getUTCDate() + 1)) {
        const dayOfWeek = dateValue.getUTCDay();
        if (dayOfWeek === 0 || dayOfWeek === 6) continue;
        const date = iso(dateValue),
          isOutside = !isWeek && dateValue.getUTCMonth() !== cursor.getUTCMonth(),
          isToday = date === todayIsoDate(),
          dayItems = visibleItems.filter((item) => item.startKey.slice(0, 10) <= date && item.endKey.slice(0, 10) >= date),
          dayHolidays = holidays.filter((holiday) => (
            holiday.startDate <= date
            && holiday.endDate >= date
            && (
              (holiday.kind === "berlin-public-holiday" && showPublic)
              || (holiday.kind !== "berlin-public-holiday" && showSchool)
            )
          )),
          dayOverlays = overlays.filter((overlay) => {
            if (overlay.startDate > date || overlay.endDate < date) return false;
            if (overlay.provider === "alexey-calendar") return showAlexey;
            return showOverlay;
          }),
          fullDate = dateValue.toLocaleDateString("en", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }),
          compactDate = dateValue.toLocaleDateString("en", { day: "numeric", month: "short", timeZone: "UTC" }),
          weekday = dateValue.toLocaleDateString("en", { weekday: "short", timeZone: "UTC" }),
          holidayMarkup = dayHolidays.map((holiday) => {
            const kind = holiday.kind === "berlin-public-holiday"
              ? "Public holiday"
              : holiday.kind === "school-free-day"
                ? "School-free day"
                : "School holiday";
            const isPublic = holiday.kind === "berlin-public-holiday";
            return `
              <span class="calendar-holiday ${isPublic ? "is-public" : "is-school"}" title="${escapeHtml(holiday.name)} (${kind})">
                <small>${kind}</small>
                <span>${escapeHtml(holiday.name)}</span>
              </span>
            `;
          }).join(""),
          activityMarkup = dayItems.map((item) => `
            <button
              class="calendar-activity ${plannerStatusClass(item.status)}"
              data-edit="${escapeHtml(item.id)}"
              title="${escapeHtml(item.title)} (${escapeHtml(plannerLabel(item.activityType))})"
            >
              <small>${escapeHtml(plannerLabel(item.activityType))}</small>
              <span>${escapeHtml(item.title)}</span>
            </button>
          `).join(""),
          overlayMarkup = dayOverlays.map((overlay) => {
            const isAlexey = overlay.provider === "alexey-calendar";
            const category = overlay.category || (isAlexey ? "Alexey" : "Newsletter");
            const hrefAttr = overlay.href ? `href="${escapeHtml(overlay.href)}"` : "";
            const tag = overlay.href ? "a" : "span";
            return `
              <${tag} class="calendar-overlay ${isAlexey ? "is-alexey" : "is-newsletter"}" ${hrefAttr} title="${escapeHtml(overlay.label)}">
                <small>${escapeHtml(category)}</small>
                <span>${escapeHtml(overlay.label)}</span>
              </${tag}>
            `;
          }).join("");
        if (dayOfWeek === 1) {
          const currentWeek = weekNumber(dateValue);
          weekMarkup += `
            <div class="calendar-week">
              <div class="calendar-week-number" aria-label="Week ${currentWeek}">
                <small class="iso-week">${currentWeek}</small>
              </div>
          `;
        }
        weekMarkup += `
          <section
            class="calendar-day${isOutside ? " is-outside" : ""}${isToday ? " is-today" : ""}"
            aria-label="${fullDate}"
          >
            <div class="calendar-day-heading">
              <time datetime="${date}">
                <span class="calendar-mobile-weekday">${weekday}</span>
                <span class="calendar-day-date${isToday ? " is-today-badge" : ""}">${compactDate}</span>
              </time>
            </div>
            <div class="calendar-day-items">
              ${holidayMarkup}
              ${activityMarkup}
              ${overlayMarkup}
            </div>
          </section>
        `;
        if (dayOfWeek === 5) weekMarkup += `</div>`;
      }
      if (weekMarkup && !weekMarkup.trimEnd().endsWith("</div>")) {
        weekMarkup += `</div>`;
      }
      grid.innerHTML = `
        <div class="calendar-grid">
          <div class="calendar-weekdays">${weekdayHeadings}</div>
          <div class="calendar-weeks">${weekMarkup}</div>
        </div>
      `;
    }

    async function load() {
      const [from, to] = bounds();
      status.textContent = "Loading calendar…";
      try {
        const [calendarResult, overlayResult] = await Promise.allSettled([
          api(`?from=${from}&to=${to}`),
          api(`/overlays?from=${from}&to=${to}`),
        ]);
        if (calendarResult.status === "rejected") throw calendarResult.reason;
        const result = calendarResult.value;
        items = result.items || [];
        holidays = result.holidays || [];
        overlays = overlayResult.status === "fulfilled" ? overlayResult.value.items || [] : [];
        const itemById = new Map(
          (result.items || []).map((item) => [item.id, item]),
        );
        alertsBox.innerHTML = (result.alerts || []).map((alert) => {
          const named = (alert.affectedIds || [])
            .map((id) => {
              const item = itemById.get(id);
              if (!item) return "";
              const when = item.startKey ? item.startKey.slice(0, 10) : "";
              return `${item.title}${when ? ` — ${formatShortPlanningDate(when)}` : ""}`;
            })
            .filter(Boolean)
            .join(" · ");
          return `
          <article class="calendar-alert planner-alert is-${escapeHtml(alert.severity || "warning")}">
            <div>
              <strong>${escapeHtml(calendarAlertCopy(alert.reasonCode))}</strong>
              <p>${named ? `${escapeHtml(named)}. ` : ""}${plannerLabel(alert.severity || "warning")} · Check the affected date before publishing.</p>
            </div>
            <button data-dismiss="${encodeURIComponent(alert.fingerprint)}">Dismiss</button>
          </article>
        `;}).join("");
        render();
        const holidayStaleMessage = result.holidayMetadata?.stale
          ? "Holiday information may be out of date. "
          : "";
        const holidayHorizonMessage = result.holidayMetadata?.outOfHorizon
          ? "This range is outside the verified holiday window. "
          : "";
        const newsletterMessage = overlayResult.status === "rejected"
          ? "Newsletter dates are temporarily unavailable. "
          : "";
        status.textContent = `${holidayStaleMessage}${holidayHorizonMessage}${newsletterMessage}`.trimEnd();
      } catch (error) {
        items = [];
        holidays = [];
        overlays = [];
        alertsBox.replaceChildren();
        status.textContent = `Could not load calendar: ${error.message}`;
        grid.innerHTML = `
          <div class="honest-state planner-failure">
            <strong>Calendar unavailable</strong>
            <p>Reopen Calendar to retry. No activities have been changed.</p>
          </div>
        `;
      }
    }

    surface.querySelector("[data-prev]").onclick = () => {
      surface.querySelector("[data-view]").value === "week" ? cursor.setUTCDate(cursor.getUTCDate() - 7) : cursor.setUTCMonth(cursor.getUTCMonth() - 1);
      load();
    };
    surface.querySelector("[data-next]").onclick = () => {
      surface.querySelector("[data-view]").value === "week" ? cursor.setUTCDate(cursor.getUTCDate() + 7) : cursor.setUTCMonth(cursor.getUTCMonth() + 1);
      load();
    };
    surface.querySelector("[data-today]").onclick = () => {
      cursor = parseIsoDateValue(todayIsoDate());
      load();
    };

    const pickerToggle = surface.querySelector("[data-picker-toggle]"),
      pickerPopover = surface.querySelector("[data-picker-popover]"),
      pickerYearLabel = surface.querySelector("[data-picker-year]"),
      pickerPrevYear = surface.querySelector("[data-picker-prev-year]"),
      pickerNextYear = surface.querySelector("[data-picker-next-year]"),
      pickerCurrentMonth = surface.querySelector("[data-picker-current-month]"),
      pickerMonthBtns = surface.querySelectorAll("[data-picker-month]");

    let pickerYear = cursor.getUTCFullYear();

    function updatePickerState() {
      if (!pickerPopover || pickerPopover.hidden) return;
      if (pickerYearLabel) pickerYearLabel.textContent = String(pickerYear);
      const today = parseIsoDateValue(todayIsoDate());
      const selectedYear = cursor.getUTCFullYear();
      const selectedMonth = cursor.getUTCMonth();
      const todayYear = today.getUTCFullYear();
      const todayMonth = today.getUTCMonth();

      pickerMonthBtns.forEach((btn) => {
        const monthIndex = Number(btn.dataset.pickerMonth);
        const isSelected = pickerYear === selectedYear && monthIndex === selectedMonth;
        const isCurrent = pickerYear === todayYear && monthIndex === todayMonth;
        btn.classList.toggle("is-selected", isSelected);
        btn.classList.toggle("is-current", isCurrent);
      });
    }

    function openPicker() {
      pickerYear = cursor.getUTCFullYear();
      updatePickerState();
      pickerPopover.hidden = false;
      pickerToggle?.setAttribute("aria-expanded", "true");
    }

    function closePicker() {
      if (pickerPopover && !pickerPopover.hidden) {
        pickerPopover.hidden = true;
        pickerToggle?.setAttribute("aria-expanded", "false");
      }
    }

    if (pickerToggle) {
      pickerToggle.onclick = (e) => {
        e.stopPropagation();
        pickerPopover?.hidden ? openPicker() : closePicker();
      };
    }

    if (pickerPrevYear) {
      pickerPrevYear.onclick = (e) => {
        e.stopPropagation();
        pickerYear -= 1;
        updatePickerState();
      };
    }

    if (pickerNextYear) {
      pickerNextYear.onclick = (e) => {
        e.stopPropagation();
        pickerYear += 1;
        updatePickerState();
      };
    }

    pickerMonthBtns.forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const monthIndex = Number(btn.dataset.pickerMonth);
        cursor = new Date(Date.UTC(pickerYear, monthIndex, 1));
        const viewSelect = surface.querySelector("[data-view]");
        if (viewSelect) viewSelect.value = "month";
        closePicker();
        load();
      };
    });

    if (pickerCurrentMonth) {
      pickerCurrentMonth.onclick = (e) => {
        e.stopPropagation();
        cursor = parseIsoDateValue(todayIsoDate());
        const viewSelect = surface.querySelector("[data-view]");
        if (viewSelect) viewSelect.value = "month";
        closePicker();
        load();
      };
    }

    surface.addEventListener("click", (e) => {
      if (pickerPopover && !pickerPopover.contains(e.target) && !pickerToggle?.contains(e.target)) {
        closePicker();
      }
    });

    surface.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closePicker();
    });

    surface.querySelector("[data-view]").onchange = load;
    surface.querySelector("[data-type]").onchange = render;
    surface.querySelectorAll("[data-layer]").forEach((control) => { control.onchange = render; });
    surface.querySelector("[data-add]").onclick = () => {
      form.reset();
      form.querySelector('[role="alert"]').textContent = "";
      const date = iso(cursor);
      form.elements.startDate.value = date;
      form.elements.endDate.value = date;
      dialog.showModal();
    };
    grid.onclick = (event) => {
      const item = items.find((value) => value.id === event.target.closest("[data-edit]")?.dataset.edit);
      if (!item) return;
      form.reset();
      form.querySelector('[role="alert"]').textContent = "";
      Object.keys(item).forEach((key) => { if (form.elements[key]) form.elements[key].value = item[key] || ""; });
      dialog.showModal();
    };
    surface.querySelector("[data-cancel]").onclick = () => dialog.close();
    alertsBox.onclick = async (event) => {
      const fingerprint = event.target.closest("[data-dismiss]")?.dataset.dismiss;
      if (!fingerprint) return;
      await api(`/alerts/${fingerprint}/dismiss`, { method: "POST", body: "{}" });
      load();
    };
    form.onsubmit = async (event) => {
      event.preventDefault();
      form.querySelector('[role="alert"]').textContent = "";
      const value = Object.fromEntries([...new FormData(form)].filter(([, fieldValue]) => fieldValue !== "")), id = value.id;
      delete value.id;
      value.allDay = true;
      value.timeZone = "Europe/Berlin";
      if (value.version) value.version = Number(value.version);
      try {
        await api(id ? `/${encodeURIComponent(id)}` : "", { method: id ? "PUT" : "POST", body: JSON.stringify(value) });
        dialog.close();
        load();
      } catch (error) {
        form.querySelector('[role="alert"]').textContent = `Could not save activity: ${error.message}`;
      }
    };

    const settingsDialog = surface.querySelector("[data-settings-dialog]"),
      settingsForm = settingsDialog?.querySelector("form"),
      settingsBtn = surface.querySelector("[data-calendar-settings]"),
      settingsError = settingsDialog?.querySelector("[data-settings-error]"),
      connectionsDatalist = settingsDialog?.querySelector("#dapier-calendar-connections");

    if (settingsBtn && settingsDialog && settingsForm) {
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
            if (settingsForm.elements.connectionId) settingsForm.elements.connectionId.value = s.connectionId || "google-calendar";
            if (settingsForm.elements.filterNonSlotHours) settingsForm.elements.filterNonSlotHours.checked = s.filterNonSlotHours !== false;
            if (settingsForm.elements.filterDtcPlaceholders) settingsForm.elements.filterDtcPlaceholders.checked = s.filterDtcPlaceholders !== false;
            if (settingsForm.elements.filterTransparent) settingsForm.elements.filterTransparent.checked = s.filterTransparent !== false;
            if (settingsForm.elements.filterLunch) settingsForm.elements.filterLunch.checked = s.filterLunch !== false;
            if (settingsForm.elements.filterRoutines) settingsForm.elements.filterRoutines.checked = s.filterRoutines !== false;
            if (settingsForm.elements.filterFitness) settingsForm.elements.filterFitness.checked = s.filterFitness !== false;
            if (settingsForm.elements.filterCampaigns) settingsForm.elements.filterCampaigns.checked = s.filterCampaigns !== false;
            if (settingsForm.elements.filterBusy) settingsForm.elements.filterBusy.checked = Boolean(s.filterBusy);
            if (settingsForm.elements.customKeywords) settingsForm.elements.customKeywords.value = (s.customKeywords || []).join("\n");
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
          load();
        } catch (err) {
          if (settingsError) settingsError.textContent = `Could not save settings: ${err.message}`;
        } finally {
          if (submitBtn) submitBtn.disabled = false;
        }
      };
    }

    load();
  }

  async function renderNewsletterSurface() {
    documentList.replaceChildren();
    const newsletterStatuses = ["open", "reserved", "drafting", "scheduled", "sent", "cancelled"];
    const newsletterStatusOptions = newsletterStatuses
      .map((value) => `
        <option value="${value}">${plannerLabel(value)}</option>
      `)
      .join("");
    const surface = document.createElement("section");
    surface.className = "newsletter-surface";
    surface.setAttribute("aria-labelledby", "newsletter-surface-title");
    surface.innerHTML = `
      <header class="planner-header">
        <div class="planner-heading">
          <p class="planner-eyebrow">Planning</p>
          <h1 id="newsletter-surface-title">Newsletter planner</h2>
          <p>Plan campaign slots, booking readiness, and publication progress in Europe/Berlin.</p>
        </div>
        <button class="primary-button" data-newsletter-add>Add slot</button>
      </header>
      <div class="newsletter-filters" aria-label="Newsletter filters">
        <div class="planner-filter-fields">
          <label>From <input data-from type="date"></label>
          <label>To <input data-to type="date"></label>
          <label>Group by
            <select data-view>
              <option value="month">Month</option>
              <option value="week">Week</option>
            </select>
          </label>
          <label>Status
            <select data-status>
              <option value="">Any status</option>
              ${newsletterStatusOptions}
            </select>
          </label>
          <label>Booking
            <select data-booked>
              <option value="">Any booking</option>
              <option value="true">Booked</option>
              <option value="false">Unbooked</option>
            </select>
          </label>
        </div>
      </div>
      <p class="planner-load-state" role="status">Loading newsletter slots…</p>
      <div class="planner-alerts" data-alerts></div>
      <div class="newsletter-schedule" data-slots>Loading slots…</div>
      <dialog class="dk-dialog" style="--dk-dialog-width: 620px">
        <form method="dialog">
          <div class="dk-dialog__head"><div>
            <h2>Newsletter slot</h2>
            <p>Keep the publication plan and booking context together.</p>
          </div></div>
          <div class="dk-dialog__body">
          <input name="id" type="hidden">
          <input name="version" type="hidden">
          <div class="planner-form-grid">
            <label>Publication date <input name="publicationDate" type="date" required></label>
            <label>Campaign number <input name="campaignNumber" type="number" min="1"></label>
            <label class="planner-field-wide">Campaign label <input name="campaignLabel" required maxlength="200"></label>
            <label>Status
              <select name="status">${newsletterStatusOptions}</select>
            </label>
            <label>Booked by <input name="bookedByDisplayName" autocomplete="off"></label>
            <label class="planner-field-wide">Sponsor booking reference <input name="sponsorBookingId" autocomplete="off"></label>
            <label class="planner-field-wide">Card reference <input name="cardId" autocomplete="off"></label>
            <label class="planner-field-wide">Public campaign URL <input name="publicUrl" type="url"></label>
            <label class="planner-field-wide">Planning note <textarea name="planningNote" rows="4"></textarea></label>
          </div>
          <p class="planner-form-error" role="alert"></p>
          </div>
          <div class="dk-dialog__foot">
            <button class="primary-button" data-save>Save slot</button>
            <button value="cancel">Cancel</button>
          </div>
        </form>
      </dialog>`;
    documentList.append(surface);
    setRouteTitle("Newsletter");
    const status = surface.querySelector('[role="status"]'),
      dialog = surface.querySelector("dialog"),
      form = dialog.querySelector("form"),
      api = (path, options = {}) =>
        request(workApiUrl(`/api/newsletter-slots${path}`), {
          headers: { "content-type": "application/json" },
          ...options,
        });
    let items = [];
    const now = todayIsoDate();
    surface.querySelector("[data-from]").value = now.slice(0, 8) + "01";
    surface.querySelector("[data-to]").value =
      `${Number(now.slice(0, 4)) + 1}-12-31`;
    const isoWeekKey = (date) => {
        const day = new Date(`${date}T00:00:00Z`);
        day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
        const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1)),
          week = Math.ceil(((day - yearStart) / 86400000 + 1) / 7);
        return `${day.getUTCFullYear()} · week ${String(week).padStart(2, "0")}`;
      },
      groupKey = (item) =>
      surface.querySelector("[data-view]").value === "month"
        ? item.publicationDate.slice(0, 7)
        : isoWeekKey(item.publicationDate);

    function newsletterAlertMarkup(alert) {
      const slot = (items || []).find((candidate) => candidate.id === alert.slotId);
      const naming = slot
        ? `${slot.campaignLabel || "Slot"}${slot.publicationDate ? ` — ${formatShortPlanningDate(slot.publicationDate)}` : ""}`
        : "";
      return `
        <article class="planner-alert is-${escapeHtml(alert.severity || "warning")}">
          <div>
            <strong>${escapeHtml(newsletterAlertCopy(alert.reasonCode))}</strong>
            <p>${naming ? `${escapeHtml(naming)}. ` : ""}${plannerLabel(alert.severity || "warning")} · ${escapeHtml(newsletterAlertAdvice(alert.reasonCode))}</p>
          </div>
        </article>
      `;
    }

    function newsletterSlotMarkup(item) {
      const bookedBy = item.bookedByDisplayName
        || (item.sponsorBookingId
          ? "Sponsor booking linked"
          : item.bookedByUserId
            ? "Team member"
            : "Unbooked");
      const publicationLabel = new Date(`${item.publicationDate}T00:00:00Z`)
        .toLocaleDateString("en", {
          weekday: "short",
          day: "numeric",
          month: "short",
          timeZone: "UTC",
        });
      const campaignNumber = item.campaignNumber
        ? `<small>Campaign ${escapeHtml(item.campaignNumber)}</small>`
        : "";
      const planningNote = item.planningNote
        ? `<small>${escapeHtml(item.planningNote)}</small>`
        : "";
      const campaignLink = item.publicUrl
        ? `
          <a href="${escapeHtml(item.publicUrl)}" target="_blank" rel="noreferrer">
            Open campaign
          </a>
        `
        : "";
      return `
        <article class="newsletter-slot-row">
          <div class="newsletter-slot-date">
            <time datetime="${escapeHtml(item.publicationDate)}">${publicationLabel}</time>
            ${campaignNumber}
          </div>
          <div class="newsletter-slot-main">
            <div class="newsletter-slot-title">
              <h4>${escapeHtml(item.campaignLabel)}</h4>
              <span class="planner-status ${plannerStatusClass(item.status)}">
                ${escapeHtml(plannerLabel(item.status))}
              </span>
            </div>
            <p>Booked by: ${escapeHtml(bookedBy)}</p>
            ${planningNote}
          </div>
          <div class="newsletter-slot-actions">
            ${campaignLink}
            <button data-edit="${escapeHtml(item.id)}">Edit</button>
          </div>
        </article>
      `;
    }

    function newsletterPeriodMarkup(period, slots) {
      const periodLabel = surface.querySelector("[data-view]").value === "month"
        ? new Date(`${period}-01T00:00:00Z`).toLocaleDateString("en", {
          month: "long",
          year: "numeric",
          timeZone: "UTC",
        })
        : period;
      return `
        <section class="newsletter-period">
          <header>
            <h3>${escapeHtml(periodLabel)}</h3>
            <span class="planner-count">${slots.length} ${slots.length === 1 ? "slot" : "slots"}</span>
          </header>
          <div class="newsletter-slot-list">
            ${slots.map(newsletterSlotMarkup).join("")}
          </div>
        </section>
      `;
    }

    async function load() {
      status.textContent = "Loading newsletter slots…";
      try {
        const query = new URLSearchParams({
            from: surface.querySelector("[data-from]").value,
            to: surface.querySelector("[data-to]").value,
            status: surface.querySelector("[data-status]").value,
            booked: surface.querySelector("[data-booked]").value,
          }),
          result = await api(`?${query}`);
        items = result.items || [];
        // One banner per reason: the same warning about different slots
        // reads as noise repeated, so identical reasons collapse.
        const uniqueAlerts = [
          ...new Map((result.alerts || []).map((alert) => [alert.reasonCode, alert])).values(),
        ];
        surface.querySelector("[data-alerts]").innerHTML = uniqueAlerts
          .map(newsletterAlertMarkup)
          .join("");
        const groups = {};
        for (const item of [...items].sort((a, b) => a.publicationDate.localeCompare(b.publicationDate))) (groups[groupKey(item)] ||= []).push(item);
        surface.querySelector("[data-slots]").innerHTML = items.length
          ? Object.entries(groups)
              .map(([period, slots]) => newsletterPeriodMarkup(period, slots))
              .join("")
          : `
            <div class="honest-state planner-empty">
              <strong>No newsletter slots</strong>
              <p>Create the first slot or adjust the date, status, and booking filters.</p>
            </div>
          `;
        status.textContent = "";
      } catch (error) {
        status.textContent = `Could not load newsletter schedule: ${error.message}`;
        surface.querySelector("[data-alerts]").replaceChildren();
        surface.querySelector("[data-slots]").innerHTML = `
          <div class="honest-state planner-failure">
            <strong>Newsletter schedule unavailable</strong>
            <p>Reopen Newsletter to retry. No slots have been changed.</p>
          </div>
        `;
      }
    }
    surface
      .querySelectorAll(".newsletter-filters input,.newsletter-filters select")
      .forEach((el) => (el.onchange = load));
    surface.querySelector("[data-newsletter-add]").onclick = () => {
      form.reset();
      form.querySelector('[role="alert"]').textContent = "";
      dialog.showModal();
    };
    surface.querySelector("[data-slots]").onclick = (event) => {
      const item = items.find(
        (value) => value.id === event.target.closest("[data-edit]")?.dataset.edit,
      );
      if (!item) return;
      form.reset();
      form.querySelector('[role="alert"]').textContent = "";
      for (const key of Object.keys(item))
        if (form.elements[key]) form.elements[key].value = item[key] || "";
      dialog.showModal();
    };
    surface.querySelector("[data-save]").onclick = async (event) => {
      event.preventDefault();
      form.querySelector('[role="alert"]').textContent = "";
      const value = Object.fromEntries(
          [...new FormData(form)].filter(([, v]) => v !== ""),
        ),
        id = value.id;
      delete value.id;
      if (value.version) value.version = Number(value.version);
      if (value.campaignNumber)
        value.campaignNumber = Number(value.campaignNumber);
      try {
        await api(id ? `/${id}` : "", {
          method: id ? "PUT" : "POST",
          body: JSON.stringify(value),
        });
        dialog.close();
        await load();
      } catch (error) {
        form.querySelector('[role="alert"]').textContent =
          `Could not save slot: ${error.message}`;
      }
    };
    await load();
  }


  return {
    renderCalendarSurface,
    renderNewsletterSurface,
  };
}
