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
      "card-date-mismatch": "A linked card's date differs from its slot",
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
      "card-date-mismatch":
        "The slot's date wins: save the slot to move the card, or link the right card.",
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

  function stageLabel(stage) {
    return {
      preparation: "Preparation",
      announced: "Announced",
      "after-event": "After event",
      done: "Done",
    }[stage] || plannerLabel(stage);
  }

  /**
   * The slot's Card as a chip in the actions row: title, stage, open/total
   * Tasks, and a warning when the Card's date drifted from the slot's (the
   * slot wins on the next save). Unlinked slots offer Create card and Link
   * card instead; on phones those two live in the More menu.
   */
  function slotCardMarkup(item) {
    const slotId = escapeHtml(item.id);
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
    if (item.cardId) {
      return `
        <div class="newsletter-slot-card">
          <span class="dk-badge dk-badge--danger">Linked card unavailable</span>
        </div>`;
    }
    if (item.status === "cancelled") return "";
    return `
      <div class="newsletter-slot-card">
        <button type="button" class="newsletter-slot-card__action" data-card-create="${slotId}">Create card</button>
        <button type="button" class="newsletter-slot-card__action" data-card-link="${slotId}">Link card…</button>
      </div>`;
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
    // The card-link picker sits beside the surface, so the issue dialog stays
    // the surface's only dialog.
    const cardLinkDialog = document.createElement("dialog");
    cardLinkDialog.className = "dk-dialog";
    cardLinkDialog.dataset.cardLinkDialog = "";
    cardLinkDialog.setAttribute("aria-labelledby", "newsletter-card-link-title");
    cardLinkDialog.innerHTML = cardLinkDialogMarkup();
    documentList.append(surface, cardLinkDialog);
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
      const cardMenuItems = item.cardId
        ? `<button type="button" class="newsletter-overflow-item" role="menuitem" data-card-link="${slotId}">Change card link…</button>`
        : item.status === "cancelled"
          ? ""
          : `<button type="button" class="newsletter-overflow-item newsletter-overflow-item--compact" role="menuitem" data-card-create="${slotId}">Create card</button>
             <button type="button" class="newsletter-overflow-item newsletter-overflow-item--compact" role="menuitem" data-card-link="${slotId}">Link card…</button>`;
      const actions = `
            ${slotCardMarkup(item)}
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
                ${cardMenuItems}
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

    const linking = setupCardLinkDialog(cardLinkDialog, api, load);

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
      const createCardBtn = target.closest("[data-card-create]");
      if (createCardBtn?.dataset.cardCreate) {
        closeAllSlotOverflows(surface);
        const item = items.find((value) => value.id === createCardBtn.dataset.cardCreate);
        if (item) linking.createCard(createCardBtn, item);
        return;
      }
      const linkCardBtn = target.closest("[data-card-link]");
      if (linkCardBtn?.dataset.cardLink) {
        closeAllSlotOverflows(surface);
        const item = items.find((value) => value.id === linkCardBtn.dataset.cardLink);
        if (item) linking.open(linkCardBtn, item, items);
        return;
      }
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

  function cardLinkDialogMarkup() {
    return `
        <form method="dialog">
          <div class="dk-dialog__head">
            <h2 id="newsletter-card-link-title">Link a card</h2>
          </div>
          <div class="dk-dialog__body">
            <p class="dk-hint" data-card-link-slot></p>
            <fieldset class="newsletter-card-options" data-card-options>
              <legend class="dk-visually-hidden">Newsletter cards without a slot</legend>
            </fieldset>
            <p role="alert" class="dk-field-error"></p>
          </div>
          <div class="dk-dialog__foot">
            <button type="button" class="dk-button dk-button--danger" data-card-unlink hidden>Unlink card</button>
            <button value="cancel" class="dk-button dk-button--secondary">Cancel</button>
            <button class="dk-button dk-button--primary" data-card-link-save>Link card</button>
          </div>
        </form>`;
  }

  async function newsletterCardCandidates(signal) {
    const templatesPayload = await request(workApiUrl("/api/templates"), { signal });
    const templates = Array.isArray(templatesPayload)
      ? templatesPayload
      : templatesPayload?.templates || [];
    const newsletterTemplateIds = new Set(
      templates
        .filter((template) => ["newsletter", "newsletter-standalone"].includes(template.type))
        .map((template) => template.id),
    );
    const cards = [];
    let cursor = "";
    for (let page = 0; page < 10; page += 1) {
      const query = new URLSearchParams({ limit: "200", ...(cursor ? { cursor } : {}) });
      const payload = await request(workApiUrl(`/api/cards?${query}`), { signal });
      cards.push(...(payload?.cards?.items || []));
      cursor = payload?.cards?.nextCursor || "";
      if (!cursor) break;
    }
    return cards.filter(
      (card) => newsletterTemplateIds.has(card.templateId) && card.status !== "archived",
    );
  }

  function setupCardLinkDialog(dialog, api, load) {
    const form = dialog.querySelector("form");
    const alert = form.querySelector('[role="alert"]');
    const setBusy = (button, busy) => {
      if (busy) {
        button.setAttribute("aria-busy", "true");
        button.setAttribute("aria-disabled", "true");
      } else {
        button.removeAttribute("aria-busy");
        button.removeAttribute("aria-disabled");
      }
    };

    async function createCard(button, item) {
      if (button.getAttribute("aria-busy") === "true") return;
      setBusy(button, true);
      try {
        await api(`/${encodeURIComponent(item.id)}/card`, {
          method: "POST",
          body: JSON.stringify({ version: item.version }),
        });
        await load();
      } catch (error) {
        setBusy(button, false);
        (button.closest(".newsletter-slot-row")?.querySelector(".newsletter-slot-main") || button.parentElement)?.insertAdjacentHTML(
          "beforeend",
          `<span class="dk-field-error" role="alert">Could not create card: ${escapeHtml(error.message)}</span>`,
        );
      }
    }

    function render(item, items, cards) {
      const linkedElsewhere = new Set(
        items.filter((slot) => slot.cardId && slot.id !== item.id).map((slot) => slot.cardId),
      );
      const options = cards
        .filter((card) => !linkedElsewhere.has(card.id))
        .sort((a, b) => String(b.anchorDate || "").localeCompare(String(a.anchorDate || "")));
      dialog.querySelector("[data-card-link-slot]").textContent =
        `${item.campaignLabel || "Slot"} · ${formatShortPlanningDate(item.publicationDate)}. Linking moves the card to the slot's date.`;
      const fieldset = dialog.querySelector("[data-card-options]");
      fieldset.querySelectorAll(":scope > :not(legend)").forEach((node) => node.remove());
      fieldset.insertAdjacentHTML(
        "beforeend",
        options.length
          ? options
              .map((card) => `
                <label class="newsletter-card-option">
                  <input type="radio" name="cardId" value="${escapeHtml(card.id)}" ${card.id === item.cardId ? "checked" : ""}>
                  <span>
                    <span class="newsletter-card-chip__title">${escapeHtml(card.title || "Untitled card")}</span>
                    <span class="newsletter-card-chip__meta">${escapeHtml(stageLabel(card.stage))}${
                      card.anchorDate ? ` · ${escapeHtml(formatShortPlanningDate(card.anchorDate))}` : ""
                    }</span>
                  </span>
                </label>`)
              .join("")
          : `<p class="dk-muted">No newsletter card is free to link. Use Create card on the slot instead.</p>`,
      );
      alert.textContent = "";
      const unlink = dialog.querySelector("[data-card-unlink]");
      unlink.hidden = !item.cardId;
      const save = async (cardId) => {
        alert.textContent = "";
        try {
          await api(`/${encodeURIComponent(item.id)}`, {
            method: "PUT",
            body: JSON.stringify({ version: item.version, cardId }),
          });
          dialog.close();
          await load();
        } catch (error) {
          alert.textContent = `Could not ${cardId ? "link" : "unlink"} card: ${error.message}`;
        }
      };
      unlink.onclick = () => save(null);
      dialog.querySelector("[data-card-link-save]").disabled = options.length === 0;
      form.onsubmit = (event) => {
        if (event.submitter?.value === "cancel") return;
        event.preventDefault();
        const cardId = new FormData(form).get("cardId");
        if (!cardId) {
          alert.textContent = "Choose a card to link.";
          return;
        }
        if (cardId === item.cardId) {
          dialog.close();
          return;
        }
        save(String(cardId));
      };
      return dialog;
    }

    function open(trigger, item, items) {
      globalThis.dakitDialogs.openWhenReady(
        trigger,
        (signal) => newsletterCardCandidates(signal),
        (cards) => render(item, items, cards),
        { label: "Loading cards…" },
      );
    }

    return { createCard, open };
  }

  return {
    renderNewsletterSurface,
  };
}
