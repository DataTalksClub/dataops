import {
  renderNewsletterDialogMarkup,
  setupNewsletterDialog,
} from "./planning-newsletter-dialog.js";
import { renderPageHeaderMarkup } from "./operations-overview.js";

export function createNewsletterPlanner(context) {
  const {
    documentList,
    escapeHtml,
    request,
    setRouteTitle,
    todayIsoDate,
    viewportWidth,
    workApiUrl,
  } = context;

  function renderNewsletterMarkdown(text) {
    const wrap = document.createElement("div");
    wrap.className = "md";
    let html = escapeHtml(text || "");
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
    html = html.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noreferrer" style="color: var(--dk-primary); text-decoration: underline;">$1</a>',
    );
    const heading = html.match(/^(#{1,6})\s+(.*)$/);
    wrap.innerHTML = heading
      ? `<h${heading[1].length}>${heading[2]}</h${heading[1].length}>`
      : html.replace(/\n/g, "<br>");
    return wrap;
  }

  function attachInlineEditor(el, options) {
    el.tabIndex = 0;
    el.title = "Click to edit";
    el.classList.add("inline-editable");

    function enter() {
      if (el.classList.contains("editing")) return;
      el.classList.add("editing");
      const original = options.getValue ? options.getValue() : el.textContent;
      const editor = document.createElement(options.multiline ? "textarea" : "input");
      if (!options.multiline) editor.type = "text";
      editor.className = "inline-editor";
      editor.value = original;
      editor.placeholder = options.placeholder || "";
      if (options.multiline) {
        editor.rows = Math.max(2, (editor.value.match(/\n/g) || []).length + 1);
      }
      el.replaceChildren(editor);
      editor.focus();
      if (options.selectionRange) {
        editor.setSelectionRange(options.selectionRange.start, options.selectionRange.end);
      }

      let committed = false;
      const doCommit = () => {
        if (committed) return;
        committed = true;
        el.classList.remove("editing");
        const val = editor.value;
        if (val !== original && options.commit) options.commit(val);
        if (options.restore) options.restore();
      };
      const doCancel = () => {
        if (committed) return;
        committed = true;
        el.classList.remove("editing");
        if (options.restore) options.restore();
      };

      editor.addEventListener("blur", doCommit);
      editor.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          doCancel();
        } else if (e.key === "Tab" && (e.shiftKey ? options.onOutdent : options.onIndent)) {
          e.preventDefault();
          const selection = { start: editor.selectionStart, end: editor.selectionEnd };
          doCommit();
          if (e.shiftKey) options.onOutdent(selection);
          else options.onIndent(selection);
        } else if (e.key === "Enter" && (!options.multiline || e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          doCommit();
          options.onEnterNewBlock?.();
        } else if (e.key === "/" && editor.value.trim() === "" && options.onSlash) {
          e.preventDefault();
          options.onSlash();
        }
      });
    }

    if (options.autoFocus) {
      setTimeout(() => {
        if (el.isConnected) enter();
      }, 0);
    }

    el.addEventListener("click", (e) => {
      if (e.target.closest("a, button, .notion-block-gutter, .inline-editor")) return;
      e.preventDefault();
      enter();
    });
    el.addEventListener("keydown", (e) => {
      if (e.target === el && e.key === "Enter") {
        e.preventDefault();
        enter();
      }
    });
  }

  function plannerLabel(value) {
    if (value === "review") return "In Review";
    const label = String(value || "").replaceAll("-", " ");
    return label ? label[0].toUpperCase() + label.slice(1) : "";
  }

  function plannerStatusClass(value) {
    if (["sent", "published", "confirmed"].includes(value)) return "is-success";
    if (["cancelled"].includes(value)) return "is-danger";
    if (["reserved", "drafting", "draft", "scheduled", "announced"].includes(value)) return "is-info";
    if (["review", "tentative", "open"].includes(value)) return "is-warning";
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

  function relativeDateBadge(isoDate, todayIso) {
    if (!isoDate || !todayIso) return "";
    const dTarget = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`);
    const dToday = new Date(`${todayIso.slice(0, 10)}T00:00:00Z`);
    const diffDays = Math.round((dTarget - dToday) / 86400000);
    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Tomorrow";
    if (diffDays === -1) return "Yesterday";
    if (diffDays > 1 && diffDays <= 7) return `In ${diffDays} days`;
    if (diffDays < -1 && diffDays >= -7) return `${Math.abs(diffDays)}d ago`;
    return "";
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

  function newsletterAlertAdvice(reasonCode) {
    return {
      "near-term-open-unbooked":
        "Confirm whether a sponsor is booking or convert the slot to an editorial campaign.",
      "duplicate-campaign-number":
        "Two newsletter slots share the same campaign number.",
      "publication-date-overlap":
        "Multiple campaigns share a publication date.",
      "publication-missing-workflow":
        "Create or link a workflow card so drafting and publication have a clear owner.",
      "reserved-missing-booker":
        "Add the sponsor contact or team member who reserved this slot.",
    }[reasonCode] || "Check the publication date and campaign setup.";
  }


  function closeAllSlotOverflows(scope) {
    scope.querySelectorAll(".newsletter-overflow-menu:not([hidden])").forEach((menu) => {
      menu.hidden = true;
      const trigger = menu
        .closest(".newsletter-overflow")
        .querySelector(".newsletter-overflow-trigger");
      if (trigger) trigger.setAttribute("aria-expanded", "false");
    });
  }

  function toggleSlotOverflow(trigger) {
    const menu = trigger.parentElement.querySelector(".newsletter-overflow-menu");
    if (!menu) return;
    const willOpen = menu.hidden;
    closeAllSlotOverflows(trigger.closest("[data-slots]") || trigger.closest(".newsletter-surface"));
    menu.hidden = !willOpen;
    trigger.setAttribute("aria-expanded", String(willOpen));
  }

  async function renderNewsletterSurface() {
    documentList.replaceChildren();
    const newsletterStatuses = [
      "open",
      "reserved",
      "drafting",
      "review",
      "scheduled",
      "sent",
      "cancelled",
    ];
    const newsletterStatusOptions = newsletterStatuses
      .map((value) => `
        <option value="${value}">${plannerLabel(value)}</option>
      `)
      .join("");
    const surface = document.createElement("section");
    surface.className = "newsletter-surface";
    surface.setAttribute("aria-labelledby", "newsletter-surface-title");
    surface.innerHTML = `
      ${renderPageHeaderMarkup({
        title: "Newsletter planner",
        titleId: "newsletter-surface-title",
        subtitle: "Plan campaign slots, booking readiness, and publication progress in Europe/Berlin.",
        className: "planner-header",
        actionsHtml: '<button class="primary-button" data-newsletter-add>Add slot</button>',
      })}
      <nav class="newsletter-views" data-newsletter-views aria-label="Newsletter views">
        <button type="button" data-newsletter-view="all" class="newsletter-view-tab" aria-pressed="true">All Issues</button>
        <button type="button" data-newsletter-view="upcoming" class="newsletter-view-tab" aria-pressed="false">Upcoming</button>
        <button type="button" data-newsletter-view="sent" class="newsletter-view-tab" aria-pressed="false">Sent & Archive</button>
      </nav>
      <div class="newsletter-stats-bar" data-newsletter-stats aria-label="Newsletter overview statistics">
        <div class="newsletter-stat-item">
          <span class="newsletter-stat-number" data-stat-total>0</span>
          <span class="newsletter-stat-label">Total</span>
        </div>
        <div class="newsletter-stat-item">
          <span class="newsletter-stat-number" data-stat-upcoming>0</span>
          <span class="newsletter-stat-label">Upcoming</span>
        </div>
        <div class="newsletter-stat-item">
          <span class="newsletter-stat-number" data-stat-drafting>0</span>
          <span class="newsletter-stat-label">Drafting</span>
        </div>
        <div class="newsletter-stat-item">
          <span class="newsletter-stat-number" data-stat-scheduled>0</span>
          <span class="newsletter-stat-label">Scheduled</span>
        </div>
        <div class="newsletter-stat-item">
          <span class="newsletter-stat-number" data-stat-unbooked>0</span>
          <span class="newsletter-stat-label">Unbooked</span>
        </div>
      </div>
      <details class="newsletter-filters" aria-label="Newsletter filters">
        <summary class="newsletter-filters-summary">
          <span class="newsletter-filters-title">Filter & group</span>
        </summary>
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
      </details>
      <p class="planner-load-state" role="status">Loading newsletter slots…</p>
      <div class="planner-alerts" data-alerts></div>
      <div class="newsletter-schedule" data-slots>Loading slots…</div>
      ${renderNewsletterDialogMarkup(newsletterStatusOptions)}`;
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
    let currentView = "all";
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
            <p>${naming ? `${escapeHtml(naming)}. ` : ""}${escapeHtml(newsletterAlertAdvice(alert.reasonCode))}</p>
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
            : "");
      const bookedMarkup = bookedBy
        ? `<p>Booked by: ${escapeHtml(bookedBy)}</p>`
        : `<p>No sponsor</p>`;
      const publicationLabel = new Date(`${item.publicationDate}T00:00:00Z`)
        .toLocaleDateString("en", {
          weekday: "short",
          day: "numeric",
          month: "short",
          timeZone: "UTC",
        });
      const relBadge = relativeDateBadge(item.publicationDate, todayIsoDate());
      const relMarkup = relBadge
        ? `<span class="newsletter-relative-badge">${escapeHtml(relBadge)}</span>`
        : "";
      const campaignNumber = item.campaignNumber
        ? `<small class="newsletter-campaign-badge">Campaign ${escapeHtml(item.campaignNumber)}</small>`
        : `<small>Slot</small>`;
      const timeMarkup = item.publicationTime
        ? `<span class="newsletter-time-badge">${escapeHtml(item.publicationTime)} Berlin</span>`
        : "";
      const planningNote = item.planningNote
        ? `<small class="newsletter-slot-note">${escapeHtml(item.planningNote)}</small>`
        : "";
      const campaignLink = item.publicUrl
        ? `
          <a href="${escapeHtml(item.publicUrl)}" target="_blank" rel="noreferrer">
            Open campaign
          </a>
        `
        : "";
      const slotId = escapeHtml(item.id);
      const actions = `
            <button type="button" class="primary-button newsletter-slot-primary" data-compose="${slotId}">Compose</button>
            <div class="newsletter-overflow">
              <button
                type="button"
                class="newsletter-overflow-trigger"
                aria-haspopup="true"
                aria-expanded="false"
                aria-label="More actions for ${escapeHtml(item.campaignLabel)}"
              >More</button>
              <div class="newsletter-overflow-menu" role="menu" hidden>
                ${campaignLink ? campaignLink.replace('<a ', '<a class="newsletter-overflow-item" role="menuitem" ') : ""}
                <button type="button" class="newsletter-overflow-item" role="menuitem" data-preview="${slotId}">Preview</button>
                <button type="button" class="newsletter-overflow-item" role="menuitem" data-schedule="${slotId}">Schedule</button>
                <button type="button" class="newsletter-overflow-item" role="menuitem" data-edit="${slotId}">Edit details</button>
              </div>
            </div>
          `;
      return `
        <article class="newsletter-slot-row" data-slot-id="${slotId}">
          <div class="newsletter-slot-date">
            <time datetime="${escapeHtml(item.publicationDate)}">${publicationLabel}</time>
            <div class="newsletter-date-meta">
              ${campaignNumber}
              ${relMarkup}
              ${timeMarkup}
            </div>
          </div>
          <div class="newsletter-slot-main">
            <div class="newsletter-slot-title">
              <h4>${escapeHtml(item.campaignLabel)}</h4>
              <span class="planner-status ${plannerStatusClass(item.status)}">
                ${escapeHtml(plannerLabel(item.status))}
              </span>
            </div>
            ${bookedMarkup}
            ${planningNote}
          </div>
          <div class="newsletter-slot-actions">
            ${actions}
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

        // Update stats summary bar
        const totalCount = items.length;
        const upcomingCount = items.filter((i) =>
          ["open", "reserved", "drafting", "draft", "review", "scheduled"].includes(i.status)
        ).length;
        const draftingCount = items.filter((i) => ["drafting", "draft"].includes(i.status)).length;
        const scheduledCount = items.filter((i) => i.status === "scheduled").length;
        const unbookedCount = items.filter(
          (i) =>
            i.status === "open" &&
            !i.bookedByDisplayName &&
            !i.sponsorBookingId &&
            !i.bookedByUserId
        ).length;

        const statTotal = surface.querySelector("[data-stat-total]");
        const statUpcoming = surface.querySelector("[data-stat-upcoming]");
        const statDrafting = surface.querySelector("[data-stat-drafting]");
        const statScheduled = surface.querySelector("[data-stat-scheduled]");
        const statUnbooked = surface.querySelector("[data-stat-unbooked]");
        if (statTotal) statTotal.textContent = String(totalCount);
        if (statUpcoming) statUpcoming.textContent = String(upcomingCount);
        if (statDrafting) statDrafting.textContent = String(draftingCount);
        if (statScheduled) statScheduled.textContent = String(scheduledCount);
        if (statUnbooked) statUnbooked.textContent = String(unbookedCount);

        // The mobile layout keeps the tab row but drops the stats strip, so
        // each view tab carries its count (data-count rendered as a chip by
        // the mobile stylesheet; desktop shows the full stats bar instead).
        const sentCount = items.filter((i) =>
          ["sent", "cancelled"].includes(i.status)
        ).length;
        const viewCounts = {
          all: totalCount,
          upcoming: upcomingCount,
          sent: sentCount,
        };
        for (const [view, count] of Object.entries(viewCounts)) {
          const tab = surface.querySelector(`[data-newsletter-view="${view}"]`);
          if (tab) tab.dataset.count = String(count);
        }

        const uniqueAlerts = [
          ...new Map((result.alerts || []).map((alert) => [alert.reasonCode, alert])).values(),
        ];
        surface.querySelector("[data-alerts]").innerHTML = uniqueAlerts
          .map(newsletterAlertMarkup)
          .join("");

        // Filter displayed items by current view tab (unless an explicit dropdown status is chosen)
        let displayedItems = items;
        const explicitStatus = surface.querySelector("[data-status]").value;
        if (!explicitStatus) {
          if (currentView === "upcoming") {
            displayedItems = items.filter((i) =>
              ["open", "reserved", "drafting", "draft", "review", "scheduled"].includes(i.status)
            );
          } else if (currentView === "sent") {
            displayedItems = items.filter((i) =>
              ["sent", "cancelled"].includes(i.status)
            );
          }
        }

        const groups = {};
        const sortedItems = [...displayedItems].sort((a, b) => a.publicationDate.localeCompare(b.publicationDate));
        for (const item of sortedItems) {
          (groups[groupKey(item)] ||= []).push(item);
        }
        surface.querySelector("[data-slots]").innerHTML = displayedItems.length
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
    surface.querySelectorAll("[data-newsletter-view]").forEach((btn) => {
      btn.onclick = () => {
        currentView = btn.dataset.newsletterView;
        surface.querySelectorAll("[data-newsletter-view]").forEach((b) => {
          b.setAttribute("aria-pressed", b === btn ? "true" : "false");
        });
        load();
      };
    });
    const { openIssueDialog } = setupNewsletterDialog({
      surface,
      dialog,
      form,
      context,
      escapeHtml,
      renderNewsletterMarkdown,
      attachInlineEditor,
      formatShortPlanningDate,
      api,
      load,
    });

    surface.querySelector("[data-newsletter-add]").onclick = () => {
      openIssueDialog(null, "details");
    };

    surface.querySelector("[data-slots]").onclick = (event) => {
      const target = event.target;
      const editBtn = target.closest("[data-edit]");
      const composeBtn = target.closest("[data-compose]");
      const previewBtn = target.closest("[data-preview]");
      const scheduleBtn = target.closest("[data-schedule]");
      const slotId = (editBtn || composeBtn || previewBtn || scheduleBtn)?.dataset.edit
        || composeBtn?.dataset.compose
        || previewBtn?.dataset.preview
        || scheduleBtn?.dataset.schedule;
      if (!slotId) {
        const overflowTrigger = target.closest(".newsletter-overflow-trigger");
        if (overflowTrigger) toggleSlotOverflow(overflowTrigger);
        return;
      }
      // An action chosen from inside the open overflow closes it first; the
      // dialog opens on top either way.
      if (target.classList?.contains?.("newsletter-overflow-item")) {
        closeAllSlotOverflows(surface);
      }
      const item = items.find((value) => value.id === slotId);
      if (!item) return;

      if (composeBtn) openIssueDialog(item, "compose");
      else if (previewBtn) openIssueDialog(item, "preview");
      else if (scheduleBtn) openIssueDialog(item, "schedule");
      else openIssueDialog(item, "details");
    };
    surface.querySelector("[data-slots]").addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      const openMenu = surface.querySelector(".newsletter-overflow-menu:not([hidden])");
      if (!openMenu) return;
      closeAllSlotOverflows(surface);
      const trigger = openMenu.closest(".newsletter-overflow").querySelector(".newsletter-overflow-trigger");
      if (trigger) trigger.focus();
    });
    document.addEventListener("click", (event) => {
      if (!surface.isConnected) return;
      if (event.target.closest(".newsletter-overflow")) return;
      closeAllSlotOverflows(surface);
    });
    await load();
  }

  return {
    renderNewsletterSurface,
  };
}
