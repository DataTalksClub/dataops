import "../dakit/collection.js";
import {
  renderNewsletterDialogMarkup,
  setupNewsletterDialog,
} from "./planning-newsletter-dialog.js";
import { renderPageHeaderMarkup } from "./operations-overview.js";
import { issueSlotsMarkup, SLOT_NAMES } from "./planning-newsletter-slots.js";

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
        editor.style.resize = "none";
        editor.style.overflow = "hidden";
        editor.style.minHeight = `${Math.max(44, el.getBoundingClientRect().height)}px`;
      }
      el.replaceChildren(editor);
      const autoGrow = () => {
        if (!options.multiline) return;
        editor.style.height = "auto";
        const borderHeight = (editor.offsetHeight || 0) - (editor.clientHeight || 0);
        editor.style.height = `${Math.max(44, (editor.scrollHeight || 0) + borderHeight)}px`;
      };
      autoGrow();
      editor.addEventListener("input", autoGrow);
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
    if (["drafting", "scheduled", "announced"].includes(value)) return "is-info";
    if (["review", "tentative"].includes(value)) return "is-warning";
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
      "near-term-open-slot": "A slot needs a sponsor soon",
      "duplicate-active-issue": "Two issues share a date and number",
      "card-unavailable": "An issue's card is missing",
      "card-date-mismatch": "A card's date differs from its issue",
      "card-slot-tasks-mismatch": "A card's sponsor tasks differ from its slots",
      "sent-issue-card-incomplete": "A sent issue's card is unfinished",
    }[reasonCode] || "Newsletter planning needs review";
  }

  function newsletterAlertAdvice(reasonCode) {
    return {
      "near-term-open-slot":
        "Book a sponsor for the ticked slot, or untick it to run the issue without one.",
      "duplicate-active-issue":
        "Check the schedule sheet: one of them probably has the wrong date or number.",
      "card-unavailable":
        "Every issue keeps one card. Reload; if it stays missing, cancel and reinstate the issue.",
      "card-date-mismatch":
        "The issue's date wins: save the issue to move its card.",
      "card-slot-tasks-mismatch":
        "Save the issue's slots again to add or skip the slot tasks on its card.",
      "sent-issue-card-incomplete":
        "Add the Mailchimp link to the card and resolve its remaining tasks.",
    }[reasonCode] || "Check the publication date and slots.";
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

  function stageLabel(stage) {
    return {
      preparation: "Preparation",
      announced: "Announced",
      "after-event": "After event",
      done: "Done",
    }[stage] || plannerLabel(stage);
  }

  /**
   * The issue's Card as a chip in the actions row: title, stage, open/total
   * Tasks, and a warning when the Card's date drifted from the issue's (the
   * issue wins on the next save). Every issue that is not cancelled has its
   * Card, created with the issue, so there is nothing to create or link here.
   */
  function issueCardMarkup(item) {
    if (item.card) {
      const card = item.card;
      const mismatch = card.anchorDate && card.anchorDate !== item.publicationDate
        ? `<span class="newsletter-card-chip__warning" data-card-date-mismatch><span class="newsletter-card-chip__warning-label">Card dated </span>${
          escapeHtml(formatShortPlanningDate(card.anchorDate))}</span>`
        : "";
      return `
        <div class="newsletter-slot-card">
          <a class="newsletter-card-chip${mismatch ? " is-mismatch" : ""}" href="/cards?cardId=${encodeURIComponent(card.id)}"
            data-open-card="${escapeHtml(card.id)}">
            <span class="newsletter-card-chip__title">${escapeHtml(card.title || "Untitled card")}</span>
            <span class="newsletter-card-chip__meta">${escapeHtml(stageLabel(card.stage))} ·
              <span class="dk-mono">${escapeHtml(`${card.openTaskCount}/${card.taskCount}`)}</span> open</span>
            ${mismatch}
          </a>
        </div>`;
    }
    if (item.status === "cancelled") return "";
    return `
      <div class="newsletter-slot-card">
        <span class="dk-badge dk-badge--danger">Card unavailable</span>
      </div>`;
  }

  async function renderNewsletterSurface() {
    documentList.replaceChildren();
    const newsletterStatuses = [
      "planned",
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
        className: "planner-header",
      })}
      <div class="newsletter-toolbar">
      <div class="dk-tabs newsletter-views" role="radiogroup" data-newsletter-views aria-label="Filter newsletter issues">
        <button type="button" data-newsletter-view="all" class="dk-tab"
          role="radio"
          aria-checked="true" tabindex="0">All issues <span class="dk-count" data-view-count hidden></span></button>
        <button type="button" data-newsletter-view="upcoming" class="dk-tab"
          role="radio"
          aria-checked="false" tabindex="-1">Upcoming <span class="dk-count" data-view-count hidden></span></button>
        <button type="button" data-newsletter-view="sent" class="dk-tab"
          role="radio"
          aria-checked="false" tabindex="-1">Sent &amp; archive <span class="dk-count" data-view-count hidden></span></button>
      </div>
      ${globalThis.dakitCollection.createButtonMarkup({ label: "Add issue", attributes: "data-newsletter-add" })}
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
              <option value="true">Sponsor booked</option>
              <option value="false">Slot needs a sponsor</option>
            </select>
          </label>
        </div>
      </details>
      <p class="planner-load-state" role="status">Loading newsletter issues…</p>
      <div class="planner-alerts" data-alerts></div>
      <div class="newsletter-schedule" data-slots>Loading issues…</div>
      ${renderNewsletterDialogMarkup(newsletterStatusOptions)}`;
    documentList.append(surface);
    setRouteTitle("Newsletter");
    const status = surface.querySelector('[role="status"]'),
      dialog = surface.querySelector("dialog"),
      form = dialog.querySelector("form"),
      api = (path, options = {}) =>
        request(workApiUrl(`/api/newsletter-issues${path}`), {
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
      const issue = (items || []).find((candidate) => candidate.id === alert.issueId);
      const naming = issue
        ? `${issue.label || "Issue"}${issue.publicationDate ? ` — ${formatShortPlanningDate(issue.publicationDate)}` : ""}`
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

    function newsletterIssueMarkup(item) {
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
      const kindBadge = item.kind === "standalone"
        ? `<small>Stand-alone</small>`
        : `<small class="newsletter-campaign-badge">Weekly</small>`;
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
      const issueId = escapeHtml(item.id);
      const actions = `
            ${issueCardMarkup(item)}
            <button type="button" class="primary-button newsletter-slot-primary" data-compose="${issueId}">Compose</button>
            <div class="newsletter-overflow">
              <button
                type="button"
                class="newsletter-overflow-trigger"
                aria-haspopup="true"
                aria-expanded="false"
                aria-label="More actions for ${escapeHtml(item.label)}"
              >More</button>
              <div class="newsletter-overflow-menu" role="menu" hidden>
                ${campaignLink ? campaignLink.replace('<a ', '<a class="newsletter-overflow-item" role="menuitem" ') : ""}
                <button type="button" class="newsletter-overflow-item" role="menuitem" data-preview="${issueId}">Preview</button>
                <button type="button" class="newsletter-overflow-item" role="menuitem" data-schedule="${issueId}">Schedule</button>
                <button type="button" class="newsletter-overflow-item" role="menuitem" data-edit="${issueId}">Edit details</button>
              </div>
            </div>
          `;
      return `
        <article class="newsletter-slot-row" data-issue-id="${issueId}">
          <div class="newsletter-slot-date">
            <time datetime="${escapeHtml(item.publicationDate)}">${publicationLabel}</time>
            <div class="newsletter-date-meta">
              ${kindBadge}
              ${relMarkup}
              ${timeMarkup}
            </div>
          </div>
          <div class="newsletter-slot-main">
            <div class="newsletter-slot-title">
              <h4>${escapeHtml(item.label)}</h4>
              <span class="planner-status ${plannerStatusClass(item.status)}">
                ${escapeHtml(plannerLabel(item.status))}
              </span>
            </div>
            ${issueSlotsMarkup(item, escapeHtml)}
            ${planningNote}
          </div>
          <div class="newsletter-slot-actions">
            ${actions}
          </div>
        </article>
      `;
    }

    function newsletterPeriodMarkup(period, issues) {
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
            <span class="planner-count">${issues.length} ${issues.length === 1 ? "issue" : "issues"}</span>
          </header>
          <div class="newsletter-slot-list">
            ${issues.map(newsletterIssueMarkup).join("")}
          </div>
        </section>
      `;
    }

    async function load() {
      status.textContent = "Loading newsletter issues…";
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
          ["planned", "drafting", "review", "scheduled"].includes(i.status)
        ).length;
        // Each filter segment carries its count. There is no stats strip
        // restating them (dakit principle 4, no vanity metrics).
        const sentCount = items.filter((i) =>
          ["sent", "cancelled"].includes(i.status)
        ).length;
        const viewCounts = {
          all: totalCount,
          upcoming: upcomingCount,
          sent: sentCount,
        };
        for (const [view, count] of Object.entries(viewCounts)) {
          const badge = surface.querySelector(`[data-newsletter-view="${view}"] [data-view-count]`);
          if (badge) {
            badge.textContent = String(count);
            badge.hidden = false;
          }
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
              ["planned", "drafting", "review", "scheduled"].includes(i.status)
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
              .map(([period, issues]) => newsletterPeriodMarkup(period, issues))
              .join("")
          : `
            <div class="honest-state planner-empty">
              <strong>No newsletter issues</strong>
              <p>Add the first issue or adjust the date, status, and booking filters.</p>
              ${globalThis.dakitCollection.createButtonMarkup({
                label: "Add the first issue",
                attributes: "data-newsletter-add-first",
                className: "collection-empty-action",
                variant: "secondary",
                shortcut: false,
              })}
            </div>
          `;
        status.textContent = "";
      } catch (error) {
        status.textContent = `Could not load newsletter schedule: ${error.message}`;
        surface.querySelector("[data-alerts]").replaceChildren();
        surface.querySelector("[data-slots]").innerHTML = `
          <div class="honest-state planner-failure">
            <strong>Newsletter schedule unavailable</strong>
            <p>Reopen Newsletter to retry. No issues have been changed.</p>
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
          b.setAttribute("aria-checked", b === btn ? "true" : "false");
          b.tabIndex = b === btn ? 0 : -1;
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

    /**
     * Tick or untick a slot from the row. Unticking a slot whose Tasks are
     * partly done asks first: done Tasks stay, open ones are skipped.
     */
    async function toggleSlot(input) {
      const item = items.find((value) => value.id === input.dataset.issueId);
      const position = input.dataset.slotToggle;
      if (!item || !position) return;
      const current = item.slots?.[position] || { ticked: false };
      const slot = { ...current, ticked: input.checked };
      if (!input.checked) {
        delete slot.sponsor;
        delete slot.bookedByUserId;
        delete slot.sponsorBookingId;
      }
      const body = { version: item.version, slots: { [position]: slot } };
      input.disabled = true;
      try {
        try {
          await api(`/${encodeURIComponent(item.id)}`, { method: "PUT", body: JSON.stringify(body) });
        } catch (error) {
          if (error?.code !== "slot-has-completed-tasks") throw error;
          if (!globalThis.confirm?.(`${error.message}`)) {
            input.checked = !input.checked;
            return;
          }
          await api(`/${encodeURIComponent(item.id)}`, {
            method: "PUT",
            body: JSON.stringify({ ...body, confirmSlotRemoval: true }),
          });
        }
        await load();
      } catch (error) {
        input.checked = !input.checked;
        status.textContent = `Could not change the ${SLOT_NAMES[position].toLowerCase()} slot: ${error.message}`;
      } finally {
        input.disabled = false;
      }
    }

    surface.querySelector("[data-slots]").addEventListener("change", (event) => {
      const input = event.target.closest?.("[data-slot-toggle]");
      if (input) toggleSlot(input);
    });

    surface.querySelector("[data-slots]").onclick = (event) => {
      const target = event.target;
      const cardChip = target.closest("[data-open-card]");
      if (cardChip?.dataset.openCard) {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button) return;
        if (!context.navigateCanonicalWorkspace) return;
        event.preventDefault();
        context.navigateCanonicalWorkspace("/cards", { cardId: cardChip.dataset.openCard });
        return;
      }
      const editBtn = target.closest("[data-edit]");
      const composeBtn = target.closest("[data-compose]");
      const previewBtn = target.closest("[data-preview]");
      const scheduleBtn = target.closest("[data-schedule]");
      const issueId = (editBtn || composeBtn || previewBtn || scheduleBtn)?.dataset.edit
        || composeBtn?.dataset.compose
        || previewBtn?.dataset.preview
        || scheduleBtn?.dataset.schedule;
      if (!issueId) {
        // The empty schedule repeats Add issue.
        if (target.closest("[data-newsletter-add-first]")) {
          openIssueDialog(null, "details");
          return;
        }
        const overflowTrigger = target.closest(".newsletter-overflow-trigger");
        if (overflowTrigger) toggleSlotOverflow(overflowTrigger);
        return;
      }
      // An action chosen from inside the open overflow closes it first; the
      // dialog opens on top either way.
      if (target.classList?.contains?.("newsletter-overflow-item")) {
        closeAllSlotOverflows(surface);
      }
      const item = items.find((value) => value.id === issueId);
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
