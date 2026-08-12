export function createPlanningSurface(context) {
  const {
    documentList,
    escapeHtml,
    request,
    setPageTitle,
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

  function calendarAlertCopy(reasonCode) {
    return {
      "public-holiday-overlap": "Activity overlaps a public holiday",
      "school-holiday-overlap": "Activity overlaps a school holiday",
      "school-free-day-overlap": "Activity overlaps a school-free day",
    }[reasonCode] || "Calendar timing needs review";
  }

  function newsletterAlertCopy(reasonCode) {
    return {
      "near-term-open-unbooked": "An open slot needs booking soon",
      "duplicate-campaign-number": "Campaign numbers need review",
      "publication-date-overlap": "Multiple campaigns share a publication date",
    }[reasonCode] || "Newsletter planning needs review";
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
      <header class="planner-header">
        <div class="planner-heading">
          <p class="planner-eyebrow">Planning</p>
          <h2 id="calendar-surface-title">Operations calendar</h2>
          <p>Coordinate public activities, holidays, and newsletter dates. Europe/Berlin · Monday–Sunday.</p>
        </div>
        <button class="primary-button" data-add>Add activity</button>
      </header>
      <div class="calendar-controls" aria-label="Calendar controls">
        <div class="calendar-period-actions" role="group" aria-label="Change calendar period">
          <button type="button" data-prev aria-label="Previous period">Previous</button>
          <button type="button" data-today>Today</button>
          <button type="button" data-next aria-label="Next period">Next</button>
        </div>
        <div class="planner-filter-fields">
          <label>Plan by
            <select data-view><option value="month">Month</option><option value="week">Week</option></select>
          </label>
          <label>Activity type
            <select data-type>
              <option value="">All activities</option>
              ${activityTypeOptions}
            </select>
          </label>
        </div>
        <fieldset class="calendar-layers">
          <legend>Show on calendar</legend>
          <label><input data-layer="activities" type="checkbox" checked> Activities</label>
          <label><input data-layer="public" type="checkbox" checked> Public holidays</label>
          <label><input data-layer="school" type="checkbox" checked> School holidays</label>
          <label><input data-layer="overlay" type="checkbox" checked> Newsletter dates</label>
        </fieldset>
      </div>
      <p class="planner-load-state" role="status">Loading calendar…</p>
      <div class="planner-alerts" data-alerts></div>
      <div data-calendar></div>
      <dialog class="planner-dialog">
        <form>
          <header>
            <h3>Calendar activity</h3>
            <p>Add the timing and planning context operators need.</p>
          </header>
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
            <label class="planner-field-wide">Card reference <input name="bundleId" autocomplete="off"></label>
            <label class="planner-field-wide">Planning notes <textarea name="notes" maxlength="2000" rows="4"></textarea></label>
          </div>
          <p class="planner-form-error" role="alert"></p>
          <footer class="planner-form-actions">
            <button class="primary-button">Save activity</button>
            <button type="button" data-cancel>Cancel</button>
          </footer>
        </form>
      </dialog>`;
    documentList.append(surface);
    setPageTitle("Calendar", "Operations calendar");

    const status = surface.querySelector('[role="status"]'),
      grid = surface.querySelector("[data-calendar]"),
      alertsBox = surface.querySelector("[data-alerts]"),
      dialog = surface.querySelector("dialog"),
      form = dialog.querySelector("form");
    let cursor = new Date(), items = [], holidays = [], overlays = [];
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
      const first = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), 1)),
        last = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0));
      return [iso(monday(first)), iso(sunday(last))];
    }

    function render() {
      const [from, to] = bounds(),
        isWeek = surface.querySelector("[data-view]").value === "week",
        showActivities = surface.querySelector('[data-layer="activities"]').checked,
        showPublic = surface.querySelector('[data-layer="public"]').checked,
        showSchool = surface.querySelector('[data-layer="school"]').checked,
        showOverlay = surface.querySelector('[data-layer="overlay"]').checked,
        type = surface.querySelector("[data-type]").value,
        visibleItems = showActivities ? items.filter((item) => !type || item.activityType === type) : [],
        periodLabel = isWeek
          ? `Week of ${new Date(`${from}T00:00:00Z`).toLocaleDateString("en", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })}`
          : cursor.toLocaleDateString("en", { month: "long", year: "numeric", timeZone: "UTC" });
      const weekdayHeadings = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
        .map((day) => `<strong>${day}</strong>`)
        .join("");
      let html = `
        <div class="calendar-content-header">
          <div>
            <h3 class="calendar-period">${periodLabel}</h3>
            <p>${isWeek ? "Seven-day planning view" : "Month overview"} · ISO week numbers</p>
          </div>
          <span>${visibleItems.length} ${visibleItems.length === 1 ? "activity" : "activities"}</span>
        </div>
      `;
      if (!visibleItems.length) {
        html += `
          <div class="calendar-empty">
            <strong>No matching activities</strong>
            <p>Adjust the activity filter or add an activity. Holiday and newsletter layers remain visible.</p>
          </div>
        `;
      }
      html += `
        <div class="calendar-grid">
          <div class="calendar-weekdays">${weekdayHeadings}</div>
      `;
      for (let dateValue = new Date(`${from}T00:00:00Z`); dateValue <= new Date(`${to}T00:00:00Z`); dateValue.setUTCDate(dateValue.getUTCDate() + 1)) {
        const date = iso(dateValue),
          isOutside = !isWeek && dateValue.getUTCMonth() !== cursor.getUTCMonth(),
          isToday = date === iso(new Date()),
          week = dateValue.getUTCDay() === 1 ? `<small class="iso-week">ISO ${weekNumber(dateValue)}</small>` : "",
          dayItems = visibleItems.filter((item) => item.startKey.slice(0, 10) <= date && item.endKey.slice(0, 10) >= date),
          dayHolidays = holidays.filter((holiday) => (
            holiday.startDate <= date
            && holiday.endDate >= date
            && (
              (holiday.kind === "berlin-public-holiday" && showPublic)
              || (holiday.kind !== "berlin-public-holiday" && showSchool)
            )
          )),
          dayOverlays = showOverlay ? overlays.filter((overlay) => overlay.startDate <= date && overlay.endDate >= date) : [],
          fullDate = dateValue.toLocaleDateString("en", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }),
          compactDate = dateValue.toLocaleDateString("en", { day: "numeric", month: "short", timeZone: "UTC" }),
          weekday = dateValue.toLocaleDateString("en", { weekday: "short", timeZone: "UTC" }),
          holidayMarkup = dayHolidays.map((holiday) => {
            const kind = holiday.kind === "berlin-public-holiday"
              ? "Public holiday"
              : holiday.kind === "school-free-day"
                ? "School-free day"
                : "School holiday";
            return `
              <span class="calendar-holiday">
                <small>${kind}</small>
                <span>${escapeHtml(holiday.name)}</span>
              </span>
            `;
          }).join(""),
          activityMarkup = dayItems.map((item) => `
            <button
              class="calendar-activity ${plannerStatusClass(item.status)}"
              data-edit="${escapeHtml(item.id)}"
            >
              <small>${escapeHtml(plannerLabel(item.activityType))}</small>
              <span>${escapeHtml(item.title)}</span>
            </button>
          `).join(""),
          overlayMarkup = dayOverlays.map((overlay) => `
            <a class="calendar-overlay" href="${escapeHtml(overlay.href || "#")}">
              <small>Newsletter</small>
              <span>${escapeHtml(overlay.label)}</span>
            </a>
          `).join("");
        html += `
          <section
            class="calendar-day${isOutside ? " is-outside" : ""}${isToday ? " is-today" : ""}"
            aria-label="${fullDate}"
          >
            <div class="calendar-day-heading">
              <time datetime="${date}">
                <span class="calendar-mobile-weekday">${weekday}</span>${compactDate}
              </time>
              ${week}
            </div>
            <div class="calendar-day-items">
              ${holidayMarkup}
              ${activityMarkup}
              ${overlayMarkup}
            </div>
          </section>
        `;
      }
      grid.innerHTML = `
        ${html}
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
        alertsBox.innerHTML = (result.alerts || []).map((alert) => `
          <article class="calendar-alert planner-alert is-${escapeHtml(alert.severity || "warning")}">
            <div>
              <strong>${escapeHtml(calendarAlertCopy(alert.reasonCode))}</strong>
              <p>${plannerLabel(alert.severity || "warning")} · Check the affected date before publishing.</p>
            </div>
            <button data-dismiss="${encodeURIComponent(alert.fingerprint)}">Dismiss</button>
          </article>
        `).join("");
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
        status.textContent = `${holidayStaleMessage}${holidayHorizonMessage}${newsletterMessage}Calendar ready.`;
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
    surface.querySelector("[data-today]").onclick = () => { cursor = new Date(); load(); };
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
          <h2 id="newsletter-surface-title">Newsletter planner</h2>
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
      <dialog class="planner-dialog">
        <form method="dialog">
          <header>
            <h3>Newsletter slot</h3>
            <p>Keep the publication plan and booking context together.</p>
          </header>
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
            <label class="planner-field-wide">Card reference <input name="bundleId" autocomplete="off"></label>
            <label class="planner-field-wide">Public campaign URL <input name="publicUrl" type="url"></label>
            <label class="planner-field-wide">Planning note <textarea name="planningNote" rows="4"></textarea></label>
          </div>
          <p class="planner-form-error" role="alert"></p>
          <footer class="planner-form-actions">
            <button class="primary-button" data-save>Save slot</button>
            <button value="cancel">Cancel</button>
          </footer>
        </form>
      </dialog>`;
    documentList.append(surface);
    setPageTitle("Newsletter", "Newsletter planner");
    const status = surface.querySelector('[role="status"]'),
      dialog = surface.querySelector("dialog"),
      form = dialog.querySelector("form"),
      api = (path, options = {}) =>
        request(workApiUrl(`/api/newsletter-slots${path}`), {
          headers: { "content-type": "application/json" },
          ...options,
        });
    let items = [];
    const now = new Date().toISOString().slice(0, 10);
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
      return `
        <article class="planner-alert is-${escapeHtml(alert.severity || "warning")}">
          <div>
            <strong>${escapeHtml(newsletterAlertCopy(alert.reasonCode))}</strong>
            <p>${plannerLabel(alert.severity || "warning")} · Review the affected slot before scheduling.</p>
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
            <span>${slots.length} ${slots.length === 1 ? "slot" : "slots"}</span>
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
        surface.querySelector("[data-alerts]").innerHTML = (result.alerts || [])
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
        status.textContent = "Newsletter schedule ready.";
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
