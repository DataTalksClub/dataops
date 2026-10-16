import "../dakit/collection.js";
import { createPageHeader } from "./operations-overview.js";
import { parseIsoDateValue } from "../core/workspace.js";
import { createNewsletterPlanner } from "./planning-newsletter.js";
import { setupDayScheduleDialog, setupCalendarSettingsDialog } from "./planning-calendar-dialogs.js";
import { mountPeriodNav, periodNavMarkup } from "./period-nav.js";
import { berlinDateTime, berlinTime, berlinTimestamp } from "./calendar-time.js";

// Open time is either a free slot projected from Alexey's calendar or a
// newsletter issue with a slot nobody has booked yet; the server marks
// both with isAvailableSlot.
function isAvailableOverlay(overlay) {
  return Boolean(overlay.isAvailableSlot);
}

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
      <header class="calendar-controls period-toolbar">
        <div class="calendar-header-main">
          ${periodNavMarkup({
            headingId: "calendar-period-heading",
            todayLabel: "Today",
            groupLabel: "Change calendar period",
            badgeHtml: '<span class="period-nav__badge">Europe/Berlin time</span>',
            shortcuts: [{ action: "current", label: "Current month" }],
          })}

          <span class="calendar-sync-indicator" data-calendar-indicator data-state="loading" title="Loading calendar…">
            <span class="dk-spinner" aria-hidden="true"></span>
            <svg class="calendar-sync-warning" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 3 2 21h20L12 3z"></path><path d="M12 10v5M12 18h.01"></path>
            </svg>
          </span>
          <button type="button" class="icon-button calendar-controls-toggle" data-controls-toggle
            aria-label="Calendar layers and view" aria-controls="calendar-display-controls" aria-expanded="false" title="Calendar layers and view">
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M4 6h16M4 12h16M4 18h16M9 3v6M15 9v6M9 15v6"/>
            </svg>
          </button>
        </div>
      <div id="calendar-display-controls" class="calendar-display-controls" role="group" aria-label="Calendar controls">
        <div class="calendar-display-controls-bar">
          <div class="calendar-filter-section">
            <label class="calendar-select-label" title="Calendar view">
              <select data-view aria-label="Calendar view">
                <option value="month" selected>Month</option>
                <option value="week">Week</option>
              </select>
            </label>
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
            <label class="calendar-layer-chip is-available" data-layer-chip="available" title="Open event slots and free newsletter slots">
              <input data-layer="available" type="checkbox" checked>
              <span class="chip-dot"></span>
              <span>Available slots</span>
              <svg class="chip-disconnected-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M9 17H7A5 5 0 0 1 7 7h1M15 7h2a5 5 0 0 1 4 8M8 12h4M3 3l18 18"></path>
              </svg>
              <span class="dk-visually-hidden" data-layer-chip-status></span>
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
      </div>
      </header>
      <p class="dk-visually-hidden" role="status" aria-live="polite">Loading calendar…</p>
      <div class="planner-alerts" data-alerts></div>
      <div data-calendar></div>
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
            <label class="planner-field-wide calendar-all-day"><input name="allDay" type="checkbox" checked> All-day activity</label>
            <label>Start date <input name="startDate" type="date" required></label>
            <label>End date <input name="endDate" type="date" required></label>
            <label data-time-field hidden>Start time (Berlin) <input name="startTime" type="time"></label>
            <label data-time-field hidden>End time (Berlin) <input name="endTime" type="time"></label>
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
    // Add activity rides on the calendar's own toolbar, right after the
    // period it adds into; the page header keeps only title and description.
    const addActivity = globalThis.dakitCollection.createButton({
      label: "Add activity",
      onClick: () => openActivityDialog(),
    });
    addActivity.classList.add("calendar-add-button");
    const controlsToggle = surface.querySelector("[data-controls-toggle]");
    surface.querySelector("[data-calendar-indicator]").before(addActivity);
    surface.prepend(createPageHeader({
      title: "Calendar",
      titleId: "calendar-surface-title",
      className: "calendar-page-header",
    }));
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
      overlays = [],
      overlaySources = {},
      overlaysFailed = false;
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
      // The grid is Monday-Friday only, so a month that opens on a weekend
      // starts at its first workday instead of a week of previous-month days.
      // The range still begins on the 1st so that leading weekend is loaded
      // and shown as a "+ weekend" note on the first Monday.
      const day = first.getUTCDay();
      const last = new Date(Date.UTC(year, month + 1, 0));
      return [day === 0 || day === 6 ? iso(first) : iso(monday(first)), iso(sunday(last))];
    }

    function render() {
      const [from, to] = bounds(),
        isWeek = surface.querySelector("[data-view]").value === "week",
        showActivities = surface.querySelector('[data-layer="activities"]').checked,
        showPublic = surface.querySelector('[data-layer="public"]').checked,
        showSchool = surface.querySelector('[data-layer="school"]').checked,
        showOverlay = surface.querySelector('[data-layer="overlay"]')?.checked ?? true,
        showAvailable = surface.querySelector('[data-layer="available"]')?.checked ?? true,
        type = surface.querySelector("[data-type]").value,
        visibleItems = showActivities ? items.filter((item) => !type || item.activityType === type) : [],
        periodLabel = isWeek
          ? `Week of ${new Date(`${from}T00:00:00Z`).toLocaleDateString("en", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })}`
          : cursor.toLocaleDateString("en", { month: "long", year: "numeric", timeZone: "UTC" });
      periodNav.setTitle(periodLabel);
      // Weekends are excluded on purpose: the calendar plans workdays. Weekend
      // entries are folded into a "+ weekend" note on the preceding Friday.
      const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
      const weekdayHeadings = [
        '<strong class="calendar-week-heading" aria-label="Week number">Week</strong>',
        ...days.map((day) => `<strong>${day}</strong>`),
      ].join("");
      const todayIso = todayIsoDate(),
        currentMondayIso = iso(monday(parseIsoDateValue(todayIso)));
      let weekMarkup = "",
        weekIsCurrent = false;
      const itemsOn = (date) => visibleItems.filter((item) => (
          (item.startKey || item.startDate || "").slice(0, 10) <= date
          && (item.endKey || item.endDate || "").slice(0, 10) >= date
        )),
        overlaysOn = (date) => overlays.filter((overlay) => {
          if (overlay.startDate > date || overlay.endDate < date) return false;
          if (isAvailableOverlay(overlay)) return showAvailable;
          // Alexey's own events (vacations, flights, meetings) are never items on
          // the calendar: they only decide which event slots are open.
          if (overlay.provider === "alexey-calendar") return false;
          return showOverlay;
        }),
        leadingMonday = (() => {
          const value = new Date(`${from}T00:00:00Z`), day = value.getUTCDay();
          if (day !== 0 && day !== 6) return "";
          value.setUTCDate(value.getUTCDate() + (day === 6 ? 2 : 1));
          return iso(value);
        })(),
        // Weekend entries fold into a note on the Friday before them, or, for
        // a month that opens on a weekend, on its first Monday.
        weekendNote = (dayValue) => {
          const offsets = dayValue.getUTCDay() === 5 ? [1, 2] : [-2, -1];
          const entries = offsets.flatMap((offset) => {
            const value = new Date(dayValue);
            value.setUTCDate(value.getUTCDate() + offset);
            const date = iso(value);
            if (date < from || date > to) return [];
            const label = value.toLocaleDateString("en", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
            return [
              ...itemsOn(date).map((item) => ({ date, text: `${label}: ${item.title}` })),
              ...overlaysOn(date).filter((overlay) => !isAvailableOverlay(overlay))
                .map((overlay) => ({ date, text: `${label}: ${overlay.label}` })),
            ];
          });
          if (!entries.length) return "";
          const texts = entries.map((entry) => entry.text),
            noun = entries.length === 1 ? "entry" : "entries";
          return `
            <button type="button" class="calendar-weekend-note" data-open-day="${entries[0].date}"
              title="${escapeHtml(texts.join("\n"))}"
              aria-label="${entries.length} weekend ${noun}: ${escapeHtml(texts.join("; "))}">
              + weekend · ${entries.length}
            </button>
          `;
        };
      for (let dateValue = new Date(`${from}T00:00:00Z`); dateValue <= new Date(`${to}T00:00:00Z`); dateValue.setUTCDate(dateValue.getUTCDate() + 1)) {
        const dayOfWeek = dateValue.getUTCDay();
        if (dayOfWeek === 0 || dayOfWeek === 6) continue;
        const date = iso(dateValue),
          isOutside = !isWeek && dateValue.getUTCMonth() !== cursor.getUTCMonth(),
          isToday = date === todayIso,
          dayItems = itemsOn(date),
          dayHolidays = holidays.filter((holiday) => (
            holiday.startDate <= date
            && holiday.endDate >= date
            && (
              (holiday.kind === "berlin-public-holiday" && showPublic)
              || (holiday.kind !== "berlin-public-holiday" && showSchool)
            )
          )),
          dayOverlays = overlaysOn(date),
          // A holiday blocks the day whether or not its layer is shown, so an
          // open slot on it is flagged as a conflict rather than offered as free.
          blockingHoliday = holidays.find((holiday) => holiday.startDate <= date && holiday.endDate >= date),
          fullDate = dateValue.toLocaleDateString("en", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }),
          compactDate = dateValue.toLocaleDateString("en", { day: "numeric", month: "short", timeZone: "UTC" }),
          weekday = dateValue.toLocaleDateString("en", { weekday: "short", timeZone: "UTC" }),
          hasPublicHoliday = dayHolidays.some((holiday) => holiday.kind === "berlin-public-holiday"),
          hasSchoolHoliday = dayHolidays.some((holiday) => holiday.kind !== "berlin-public-holiday"),
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
              <span>${item.allDay === false && item.startsAt
                ? `<b class="calendar-chip-time">${escapeHtml(berlinTime(item.startsAt))}</b> ` : ""}${escapeHtml(item.title)}</span>
            </button>
          `).join(""),
          overlayMarkup = dayOverlays.map((overlay) => {
            const isAlexey = overlay.provider === "alexey-calendar";
            const isAvailable = isAvailableOverlay(overlay);
            const category = isAvailable
              ? (isAlexey ? "Open event slot" : "Free newsletter slot")
              : overlay.category || "Newsletter";
            const hrefAttr = overlay.href ? `href="${escapeHtml(overlay.href)}"` : "";
            const tag = overlay.href ? "a" : (isAvailable ? "button type=\"button\"" : "span");
            const conflict = isAvailable && blockingHoliday;
            const slotClass = `${isAvailable ? " is-available-slot" : ""}${conflict ? " is-holiday-conflict" : ""}`;
            const openDayAttr = isAvailable && !overlay.href ? ` data-open-day="${escapeHtml(date)}"` : "";
            const title = conflict
              ? `${category}: ${overlay.label} (conflicts with ${blockingHoliday.name})`
              : isAvailable ? `${category}: ${overlay.label}` : overlay.label;
            return `
              <${tag} class="calendar-overlay ${isAlexey ? "is-alexey" : "is-newsletter"}${slotClass}" ${hrefAttr}${openDayAttr} title="${escapeHtml(title)}">
                <small>${conflict ? "Blocked" : escapeHtml(category)}</small>
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
        const holidayClass = `${hasPublicHoliday ? " has-public-holiday" : ""}${hasSchoolHoliday ? " has-school-holiday" : ""}`;
        weekMarkup += `
          <section
            class="calendar-day${isOutside ? " is-outside" : ""}${isToday ? " is-today" : ""}${weekIsCurrent ? " is-current-week" : ""}${holidayClass}"
            aria-label="${fullDate}${hasPublicHoliday ? ", public holiday" : hasSchoolHoliday ? ", school holiday" : ""}"
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
              ${dayOfWeek === 5 || date === leadingMonday ? weekendNote(dateValue) : ""}
            </div>
          </section>
        `;
        if (dayOfWeek === 5) weekMarkup += `</div>`;
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

    let planningStatus = "";
    // Open event slots come from Alexey's calendar. No slots only means "fully
    // booked" when that source is connected; otherwise say why on the chip.
    function alexeyConnectionProblem() {
      if (overlaysFailed) return "Calendar overlays failed to load.";
      const connection = overlaySources["alexey-calendar"];
      if (!connection || connection.state === "connected") return "";
      return connection.reason || "The calendar source is not connected.";
    }

    function renderOverlayStatus() {
      const problem = alexeyConnectionProblem(),
        chip = surface.querySelector('[data-layer-chip="available"]'),
        showAvailable = surface.querySelector('[data-layer="available"]')?.checked ?? true;
      if (chip) {
        chip.classList.toggle("is-disconnected", Boolean(problem));
        chip.title = problem
          ? `Alexey's calendar is not connected, so open event slots are unknown: ${problem}`
          : "Open event slots and free newsletter slots";
        const chipStatus = chip.querySelector("[data-layer-chip-status]");
        if (chipStatus) chipStatus.textContent = problem ? ` (not connected: ${problem})` : "";
      }
      const overlayMessage = overlaysFailed
        ? "Calendar overlays are temporarily unavailable. "
        : problem && showAvailable
          ? `Alexey's calendar is not connected: ${problem} `
          : "";
      const message = `${planningStatus}${overlayMessage}`.trimEnd();
      status.textContent = message;
      setIndicator(message ? "warning" : "idle", message);
    }

    // Loading and source problems show in one fixed-size toolbar slot (spinner
    // or warning icon with a tooltip), never as a line that pushes the grid.
    // Screen readers get the same message from the visually hidden status.
    function setIndicator(state, message = "") {
      const indicator = surface.querySelector("[data-calendar-indicator]");
      if (indicator) {
        indicator.dataset.state = state;
        indicator.title = message;
      }
      grid.setAttribute("aria-busy", String(state === "loading"));
    }

    let loadRevision = 0;
    async function load() {
      const revision = ++loadRevision;
      const [from, to] = bounds();
      status.textContent = "Loading calendar…";
      setIndicator("loading", "Loading calendar…");
      try {
        // External overlays can wait on the calendar broker. Show owned planning
        // data immediately and add overlays when ready instead of blocking the grid.
        const overlayPromise = api(`/overlays?from=${from}&to=${to}`).then(
          (value) => ({ status: "fulfilled", value }),
          (reason) => ({ status: "rejected", reason }),
        );
        const result = await api(`?from=${from}&to=${to}`);
        if (revision !== loadRevision) return;
        items = result.items || [];
        holidays = result.holidays || [];
        overlays = [];
        const itemById = new Map(
          (result.items || []).map((item) => [item.id, item]),
        );
        const alertMarkup = (result.alerts || []).map((alert) => {
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
        const alertCount = (result.alerts || []).length;
        alertsBox.innerHTML = alertCount ? `
          <details class="calendar-alert-summary">
            <summary>${alertCount} planning ${alertCount === 1 ? "alert" : "alerts"}</summary>
            <div class="calendar-alert-list">${alertMarkup}</div>
          </details>` : "";
        render();
        const holidayStaleMessage = result.holidayMetadata?.stale
          ? "Holiday information may be out of date. "
          : "";
        const holidayHorizonMessage = result.holidayMetadata?.outOfHorizon
          ? "This range is outside the verified holiday window. "
          : "";
        const planningWarnings = `${holidayStaleMessage}${holidayHorizonMessage}`;
        status.textContent = planningWarnings.trimEnd();
        setIndicator("loading", "Loading open event slots…");
        const overlayResult = await overlayPromise;
        if (revision !== loadRevision) return;
        overlays = overlayResult.status === "fulfilled" ? overlayResult.value.items || [] : [];
        overlaySources = overlayResult.status === "fulfilled" ? overlayResult.value.sources || {} : {};
        overlaysFailed = overlayResult.status === "rejected";
        render();
        planningStatus = planningWarnings;
        renderOverlayStatus();
      } catch (error) {
        if (revision !== loadRevision) return;
        items = [];
        holidays = [];
        overlays = [];
        alertsBox.replaceChildren();
        status.textContent = `Could not load calendar: ${error.message}`;
        setIndicator("warning", status.textContent);
        grid.innerHTML = `
          <div class="honest-state planner-failure">
            <strong>Calendar unavailable</strong>
            <p>Reopen Calendar to retry. No activities have been changed.</p>
          </div>
        `;
      }
    }

    const showMonthOf = (date) => {
      cursor = date;
      const viewSelect = surface.querySelector("[data-view]");
      if (viewSelect) viewSelect.value = "month";
      load();
    };
    const step = (direction) => {
      surface.querySelector("[data-view]").value === "week"
        ? cursor.setUTCDate(cursor.getUTCDate() + 7 * direction)
        : cursor.setUTCMonth(cursor.getUTCMonth() + direction);
      load();
    };
    const periodNav = mountPeriodNav(surface, {
      selected: () => ({ year: cursor.getUTCFullYear(), month: cursor.getUTCMonth() }),
      current: () => {
        const today = parseIsoDateValue(todayIsoDate());
        return { year: today.getUTCFullYear(), month: today.getUTCMonth() };
      },
      onToday: () => {
        cursor = parseIsoDateValue(todayIsoDate());
        load();
      },
      onPrev: () => step(-1),
      onNext: () => step(1),
      onMonth: (year, month) => showMonthOf(new Date(Date.UTC(year, month, 1))),
      onShortcut: () => showMonthOf(parseIsoDateValue(todayIsoDate())),
    });

    controlsToggle.onclick = () => {
      const expanded = controlsToggle.getAttribute("aria-expanded") !== "true";
      controlsToggle.setAttribute("aria-expanded", String(expanded));
      surface.classList.toggle("calendar-controls-open", expanded);
    };
    surface.querySelector("[data-view]").onchange = load;
    surface.querySelector("[data-type]").onchange = render;
    surface.querySelectorAll("[data-layer]").forEach((control) => {
      control.onchange = () => {
        render();
        renderOverlayStatus();
      };
    });
    const deleteBtn = dialog.querySelector("[data-delete-activity]");
    function updateTimeFields() {
      const allDay = form.elements.allDay.checked;
      form.querySelectorAll("[data-time-field]").forEach((field) => { field.hidden = allDay; });
      for (const name of ["startTime", "endTime"]) {
        form.elements[name].disabled = allDay;
        form.elements[name].required = !allDay;
      }
    }
    form.elements.allDay.onchange = updateTimeFields;
    let editingActivity = null;
    function openActivityDialog(item = null, defaultDate = null) {
      editingActivity = item;
      form.reset();
      form.querySelector('[role="alert"]').textContent = "";
      if (item) {
        Object.keys(item).forEach((key) => {
          if (form.elements[key]) form.elements[key].value = item[key] || "";
        });
        form.elements.allDay.checked = item.allDay !== false;
        if (item.allDay === false) {
          const start = berlinDateTime(item.startsAt), end = berlinDateTime(item.endsAt);
          form.elements.startDate.value = start.slice(0, 10);
          form.elements.endDate.value = end.slice(0, 10);
          form.elements.startTime.value = start.slice(11);
          form.elements.endTime.value = end.slice(11);
        }
        if (deleteBtn?.style) deleteBtn.style.display = "";
      } else {
        form.elements.allDay.checked = true;
        const date = defaultDate || iso(cursor);
        form.elements.startDate.value = date;
        form.elements.endDate.value = date;
        if (deleteBtn?.style) deleteBtn.style.display = "none";
      }
      updateTimeFields();
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
      value.allDay = form.elements.allDay.checked;
      value.timeZone = "Europe/Berlin";
      if (value.version) value.version = Number(value.version);
      try {
        if (!value.allDay) {
          // Preserve the item's original offset when an autumn hour repeats.
          const unchangedTime = (timestamp, date, time) => timestamp
            && berlinDateTime(timestamp) === `${date}T${time}`;
          value.startsAt = unchangedTime(editingActivity?.startsAt, value.startDate, value.startTime)
            ? editingActivity.startsAt : berlinTimestamp(value.startDate, value.startTime);
          value.endsAt = unchangedTime(editingActivity?.endsAt, value.endDate, value.endTime)
            ? editingActivity.endsAt : berlinTimestamp(value.endDate, value.endTime);
          if (value.startsAt >= value.endsAt) throw new Error("End time must be after start time.");
          delete value.startDate;
          delete value.endDate;
        }
        delete value.startTime;
        delete value.endTime;
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
