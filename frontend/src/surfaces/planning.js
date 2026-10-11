import { parseIsoDateValue } from "../core/workspace.js";
import { createNewsletterPlanner } from "./planning-newsletter.js";
import { setupDayScheduleDialog, setupCalendarSettingsDialog } from "./planning-calendar-dialogs.js";

export function createPlanningSurface(context) {
  const {
    documentList,
    escapeHtml,
    request,
    setRouteTitle,
    todayIsoDate,
    workApiUrl,
  } = context;

  const { renderNewsletterSurface } = createNewsletterPlanner(context);

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
      <header class="calendar-controls calendar-header-bar">
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
              <h1 id="calendar-surface-title" class="calendar-heading-wrapper" aria-label="Operations calendar">
                <button type="button" class="calendar-period-btn" data-picker-toggle aria-haspopup="dialog" aria-expanded="false" title="Choose month and year">
                  <span class="calendar-period-title" data-period-heading>Calendar</span>
                  <svg class="calendar-period-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
                    stroke-linecap="round" stroke-linejoin="round">
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
            <span class="calendar-control-label">View:</span>
            <label class="calendar-select-label" title="Calendar view">
              <select data-view aria-label="Calendar view">
                <option value="month" selected>Month</option>
                <option value="week">Week</option>
              </select>
            </label>
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
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06
                  a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09
                  A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83
                  l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2
                  h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0
                  l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2
                  v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83
                  l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2
                  h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
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
          <div class="dk-dialog__foot calendar-activity-dialog-foot">
            <div class="calendar-activity-dialog-foot-actions">
              <button class="primary-button">Save activity</button>
              <button type="button" data-cancel>Cancel</button>
            </div>
            <button type="button" class="calendar-delete-activity-btn" data-delete-activity style="display: none;">Delete activity</button>
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
                  <input type="checkbox" name="showAvailableSlots">
                  <span>Show available slots <small>(Project free 12:30 lunch & 17:00 evening slots instead of busy meetings)</small></span>
                </label>
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
      </dialog>
      <dialog class="dk-dialog calendar-day-dialog" data-day-dialog style="--dk-dialog-width: 680px">
        <div class="dk-dialog__head calendar-day-dialog-head">
          <div>
            <span class="calendar-day-dialog-eyebrow">Day schedule</span>
            <h2 data-day-title>Date</h2>
            <p data-day-subtitle>Europe/Berlin time · Full schedule & availability for event planning</p>
          </div>
          <button type="button" class="calendar-day-close-btn" data-day-close aria-label="Close day schedule">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
        <div class="dk-dialog__body calendar-day-dialog-body" data-day-body>
          <p class="planner-load-state">Loading schedule…</p>
        </div>
        <div class="dk-dialog__foot calendar-day-dialog-foot">
          <button class="primary-button" type="button" data-day-add-activity>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
            <span>Add activity on this day</span>
          </button>
          <button type="button" data-day-close-foot>Close</button>
        </div>
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
    const api = (path, options = {}) =>
      request(workApiUrl(`/api/calendar-items${path}`), {
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
      const days = isWeek
        ? ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
        : ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
      const weekdayHeadings = [
        '<strong class="calendar-week-heading" aria-label="Week number">Week</strong>',
        ...days.map((day) => `<strong>${day}</strong>`),
      ].join("");
      const todayIso = todayIsoDate(),
        currentMondayIso = iso(monday(parseIsoDateValue(todayIso)));
      let weekMarkup = "",
        weekIsCurrent = false;
      for (let dateValue = new Date(`${from}T00:00:00Z`); dateValue <= new Date(`${to}T00:00:00Z`); dateValue.setUTCDate(dateValue.getUTCDate() + 1)) {
        const dayOfWeek = dateValue.getUTCDay();
        if (!isWeek && (dayOfWeek === 0 || dayOfWeek === 6)) continue;
        const date = iso(dateValue),
          isOutside = !isWeek && dateValue.getUTCMonth() !== cursor.getUTCMonth(),
          isToday = date === todayIso,
          dayItems = visibleItems.filter((item) => (
            (item.startKey || item.startDate || "").slice(0, 10) <= date
            && (item.endKey || item.endDate || "").slice(0, 10) >= date
          )),
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
            const isAvailable = Boolean(overlay.isAvailableSlot);
            const tag = overlay.href ? "a" : (isAvailable ? "button type=\"button\"" : "span");
            const slotClass = isAvailable ? " is-available-slot" : "";
            const openDayAttr = isAvailable ? ` data-open-day="${escapeHtml(date)}"` : "";
            return `
              <${tag} class="calendar-overlay ${isAlexey ? "is-alexey" : "is-newsletter"}${slotClass}" ${hrefAttr}${openDayAttr} title="${escapeHtml(overlay.label)}">
                <small>${escapeHtml(category)}</small>
                <span>${escapeHtml(overlay.label)}</span>
              </${tag}>
            `;
          }).join("");
        if (dayOfWeek === 1) {
          const currentWeek = weekNumber(dateValue);
          weekIsCurrent = (date === currentMondayIso);
          weekMarkup += `
            <div class="calendar-week${weekIsCurrent ? " is-current-week" : ""}">
              <div
                class="calendar-week-number${weekIsCurrent ? " is-current-week" : ""}"
                aria-label="Week ${currentWeek}${weekIsCurrent ? " (Current week)" : ""}"
                title="${weekIsCurrent ? `Current week (Week ${currentWeek})` : `Week ${currentWeek}`}"
              >
                <small class="iso-week${weekIsCurrent ? " is-current" : ""}">${currentWeek}</small>
              </div>
          `;
        }
        weekMarkup += `
          <section
            class="calendar-day${isOutside ? " is-outside" : ""}${isToday ? " is-today" : ""}${weekIsCurrent ? " is-current-week" : ""}"
            aria-label="${fullDate}"
            data-day="${date}"
          >
            <div class="calendar-day-heading">
              <button
                type="button"
                class="calendar-day-date-btn"
                data-open-day="${date}"
                aria-label="Open ${fullDate} schedule"
                title="Open ${fullDate} schedule"
              >
                <time datetime="${date}">
                  <span class="calendar-mobile-weekday">${weekday}</span>
                  <span class="calendar-day-date${isToday ? " is-today-badge" : ""}">${compactDate}</span>
                </time>
              </button>
            </div>
            <div class="calendar-day-items">
              ${holidayMarkup}
              ${activityMarkup}
              ${overlayMarkup}
            </div>
          </section>
        `;
        if (isWeek ? dayOfWeek === 0 : dayOfWeek === 5) weekMarkup += `</div>`;
      }
      if (weekMarkup && !weekMarkup.trimEnd().endsWith("</div>")) {
        weekMarkup += `</div>`;
      }
      const emptyNotice = type && visibleItems.length === 0
        ? `<div class="calendar-empty honest-state"><p>No matching activities</p></div>`
        : "";
      grid.innerHTML = `
        ${emptyNotice}
        <div class="calendar-grid${isWeek ? " is-week-view" : ""}">
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
    const deleteBtn = dialog.querySelector("[data-delete-activity]");
    function openActivityDialog(item = null, defaultDate = null) {
      form.reset();
      form.querySelector('[role="alert"]').textContent = "";
      if (item) {
        Object.keys(item).forEach((key) => {
          if (form.elements[key]) form.elements[key].value = item[key] || "";
        });
        if (deleteBtn?.style) deleteBtn.style.display = "";
      } else {
        const date = defaultDate || iso(cursor);
        form.elements.startDate.value = date;
        form.elements.endDate.value = date;
        if (deleteBtn?.style) deleteBtn.style.display = "none";
      }
      dialog.showModal();
    }

    if (deleteBtn) {
      deleteBtn.onclick = async () => {
        const id = form.elements.id.value;
        const version = form.elements.version.value;
        if (!id) return;
        form.querySelector('[role="alert"]').textContent = "";
        try {
          await api(`/${encodeURIComponent(id)}`, {
            method: "DELETE",
            body: JSON.stringify({ version: Number(version) || 1 }),
          });
          dialog.close();
          load();
        } catch (error) {
          form.querySelector('[role="alert"]').textContent = `Could not delete activity: ${error.message}`;
        }
      };
    }

    surface.querySelector("[data-add]").onclick = () => openActivityDialog();

    const daySchedule = setupDayScheduleDialog({
      surface,
      api,
      escapeHtml,
      plannerLabel,
      onAddActivity: (selectedDayIso) => openActivityDialog(null, selectedDayIso),
      onEditActivity: (itemId) => {
        const item = items.find((value) => value.id === itemId);
        if (item) openActivityDialog(item);
      },
      getCalendarState: () => ({ items, holidays, overlays }),
    });

    const openDayDialog = daySchedule.openDayDialog;

    grid.onclick = (event) => {
      const editBtn = event.target.closest("[data-edit]");
      if (editBtn) {
        const item = items.find((value) => value.id === editBtn.dataset.edit);
        if (item) {
          openActivityDialog(item);
          return;
        }
      }
      const openDayBtn = event.target.closest("[data-open-day]");
      if (openDayBtn) {
        openDayDialog(openDayBtn.dataset.openDay);
        return;
      }
      const daySection = event.target.closest(".calendar-day");
      if (daySection && !event.target.closest("a") && !event.target.closest("button")) {
        const timeEl = daySection.querySelector("time");
        const date = timeEl?.getAttribute("datetime") || daySection.dataset.day;
        if (date) openDayDialog(date);
      }
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

    setupCalendarSettingsDialog({
      surface,
      api,
      escapeHtml,
      onSettingsSaved: () => load(),
    });

    await load();
  }

  return {
    renderCalendarSurface,
    renderNewsletterSurface,
  };
}
