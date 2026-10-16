import "../dakit/collection.js";
import {
  renderNewsletterDialogMarkup,
  setupNewsletterDialog,
} from "./planning-newsletter-dialog.js";
import { renderPageHeaderMarkup } from "./operations-overview.js";
import { attachSlotControls, cardDueLabel, issueSlotsMarkup } from "./planning-newsletter-slots.js";
import { sponsorRecordPath } from "../core/sponsor-routes.js";

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

  /**
   * How far the issue is from today, on every row and in one short form:
   * days under two weeks, then weeks under nine weeks, then months.
   */
  function relativeDateBadge(isoDate, todayIso) {
    const target = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`);
    const today = new Date(`${todayIso.slice(0, 10)}T00:00:00Z`);
    const days = Math.round((target - today) / 86400000);
    if (days === 0) return "today";
    const span = Math.abs(days);
    const amount = span < 14 ? `${span}d` : span < 63 ? `${Math.round(span / 7)}w` : `${Math.round(span / 30.44)}mo`;
    return days > 0 ? `in ${amount}` : `${amount} ago`;
  }

  function newsletterAlertCopy(reasonCode) {
    return {
      "near-term-open-slot": "A slot needs a sponsor soon",
      "duplicate-active-issue": "Two issues share a date and number",
      "card-unavailable": "An issue's card is missing",
      "card-not-created": "An issue's card was not created",
      "card-date-mismatch": "A card's date differs from its issue",
      "card-slot-tasks-mismatch": "A card's sponsor tasks differ from its slots",
    }[reasonCode] || "Newsletter planning needs review";
  }

  function newsletterAlertAdvice(reasonCode) {
    return {
      "near-term-open-slot":
        "Book a sponsor for the primary slot, or run the issue without one.",
      "duplicate-active-issue":
        "Check the schedule sheet: one of them probably has the wrong date or number.",
      "card-unavailable":
        "The issue points at a card that is gone. Reload; if it stays missing, remove the card and create it again.",
      "card-not-created":
        "The daily run should have made it. Use Create card now on the issue.",
      "card-date-mismatch":
        "The issue's date wins: save the issue to move its card.",
      "card-slot-tasks-mismatch":
        "Book the slot again, or turn on its task group on the card.",
    }[reasonCode] || "Check the publication date and slots.";
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
   * The issue's Card as a chip in the actions row: stage and open/total
   * Tasks, and a warning when the Card's date drifted from the issue's (the
   * issue wins on the next save). The row already names the date, number and
   * sponsors, so the chip does not repeat the Card's title; it carries it as
   * the link's name. An issue without a Card yet says when the daily run
   * creates it, with a button to create it now.
   */
  function issueCardMarkup(item) {
    if (item.card) {
      const card = item.card;
      const mismatch = card.anchorDate && card.anchorDate !== item.publicationDate
        ? `<span class="newsletter-card-chip__warning" data-card-date-mismatch><span class="newsletter-card-chip__warning-label">Card dated </span>${
          escapeHtml(formatShortPlanningDate(card.anchorDate))}</span>`
        : "";
      const name = `Open card: ${card.title || "Untitled card"}`;
      return `
        <div class="newsletter-slot-card">
          <a class="newsletter-card-chip${mismatch ? " is-mismatch" : ""}" href="/cards?cardId=${encodeURIComponent(card.id)}"
            title="${escapeHtml(name)}">
            <span class="newsletter-card-chip__label">Card</span>
            <span class="newsletter-card-chip__meta">${escapeHtml(stageLabel(card.stage))} ·
              <span class="dk-mono">${escapeHtml(`${card.openTaskCount}/${card.taskCount}`)}</span> open</span>
            ${mismatch}
          </a>
        </div>`;
    }
    if (item.cardId) {
      return `
      <div class="newsletter-slot-card">
        <span class="dk-badge dk-badge--danger">Card unavailable</span>
      </div>`;
    }
    if (!item.cardDueDate) return "";
    return `
      <div class="newsletter-slot-card">
        <span class="newsletter-card-due" data-card-due>${escapeHtml(cardDueLabel(item.cardDueDate, todayIsoDate()))}</span>
        <button type="button" class="newsletter-card-create" data-create-card="${escapeHtml(item.id)}"
          aria-label="${escapeHtml(`Create the card for ${item.label || "this issue"} now`)}">Create card now</button>
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
      <div class="dk-tabs newsletter-views" role="radiogroup" data-newsletter-views aria-label="Newsletter issues">
        <button type="button" data-newsletter-view="upcoming" class="dk-tab"
          role="radio" aria-checked="true" tabindex="0">Upcoming</button>
        <button type="button" data-newsletter-view="past" class="dk-tab"
          role="radio" aria-checked="false" tabindex="-1">Past</button>
      </div>
      ${globalThis.dakitCollection.createButtonMarkup({ label: "Add issue", attributes: "data-newsletter-add" })}
      </div>
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
    // Upcoming: today onward, soonest first. Past: everything before today,
    // newest first. Both by month.
    let currentView = "upcoming";
    const now = todayIsoDate();
    const yesterday = new Date(`${now}T00:00:00Z`);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const ranges = {
      upcoming: { from: now },
      past: { from: "2000-01-01", to: yesterday.toISOString().slice(0, 10) },
    };
    const groupKey = (item) => item.publicationDate.slice(0, 7);

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
      const relMarkup = `<span class="newsletter-relative-badge">${
        escapeHtml(relativeDateBadge(item.publicationDate, todayIsoDate()))}</span>`;
      const kindBadge = `<small class="newsletter-kind-badge">${item.kind === "standalone" ? "Stand-alone" : "Weekly"}</small>`;
      const sendTime = item.publicationTime
        ? ` title="Sends at ${escapeHtml(item.publicationTime)} Europe/Berlin"`
        : "";
      const planningNote = item.planningNote
        ? `<small class="newsletter-slot-note">${escapeHtml(item.planningNote)}</small>`
        : "";
      const issueId = escapeHtml(item.id);
      const actions = `
            ${issueCardMarkup(item)}
          `;
      return `
        <article class="newsletter-slot-row" data-issue-id="${issueId}">
          <div class="newsletter-slot-date">
            <time datetime="${escapeHtml(item.publicationDate)}"${sendTime}>${publicationLabel}</time>
            <div class="newsletter-date-meta">
              ${kindBadge}
              ${relMarkup}
            </div>
          </div>
          <div class="newsletter-slot-main">
            <div class="newsletter-slot-title">
              <h4><button type="button" class="newsletter-issue-edit" data-edit="${issueId}"
                title="Edit issue details"><span>${escapeHtml(item.label)}</span></button></h4>
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

    /** A past issue, read-only: date, type, number, sponsors, and its card if it has one. */
    function pastIssueMarkup(item) {
      const publicationLabel = new Date(`${item.publicationDate}T00:00:00Z`)
        .toLocaleDateString("en", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
      const kind = item.kind === "standalone" ? "Stand-alone" : "Weekly";
      const sponsors = pastSponsorsMarkup(item);
      return `
        <article class="newsletter-slot-row is-past" data-issue-id="${escapeHtml(item.id)}">
          <div class="newsletter-slot-date">
            <time datetime="${escapeHtml(item.publicationDate)}">${publicationLabel}</time>
            <div class="newsletter-date-meta"><small class="newsletter-kind-badge">${kind}</small></div>
          </div>
          <div class="newsletter-slot-main">
            <div class="newsletter-slot-title">
              <h4>${escapeHtml(item.label)}</h4>
              ${item.status === "sent" ? "" : `<span class="planner-status ${plannerStatusClass(item.status)}">${escapeHtml(plannerLabel(item.status))}</span>`}
            </div>
            ${sponsors}
          </div>
          <div class="newsletter-slot-actions">${item.card ? issueCardMarkup(item) : ""}</div>
        </article>
      `;
    }

    function pastSponsorsMarkup(item) {
      const names = Object.entries(item.slots || {})
        .filter(([, slot]) => slot?.sponsor)
        .map(([position, slot]) => {
          // A sponsor matched to its company links to it in the Sponsors tab.
          const name = slot.organizationId
            ? `<a href="${escapeHtml(sponsorRecordPath("company", slot.organizationId))}">${escapeHtml(slot.sponsor)}</a>`
            : escapeHtml(slot.sponsor);
          return `<span class="newsletter-past-sponsor"><strong>${
            escapeHtml(item.kind === "standalone" ? "Sponsor" : position === "primary" ? "Primary" : "Secondary")}:</strong> ${name}</span>`;
        });
      return names.length ? `<p class="newsletter-past-sponsors">${names.join(" ")}</p>` : "";
    }

    function newsletterPeriodMarkup(period, issues) {
      const periodLabel = new Date(`${period}-01T00:00:00Z`).toLocaleDateString("en", {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      });
      return `
        <section class="newsletter-period">
          <header>
            <h3>${escapeHtml(periodLabel)}</h3>
            <span class="planner-count">${issues.length} ${issues.length === 1 ? "issue" : "issues"}</span>
          </header>
          <div class="newsletter-slot-list">
            ${issues.map(currentView === "past" ? pastIssueMarkup : newsletterIssueMarkup).join("")}
          </div>
        </section>
      `;
    }

    async function load() {
      status.textContent = "Loading newsletter issues…";
      try {
        const view = currentView;
        const result = await api(`?${new URLSearchParams(ranges[view])}`);
        if (view !== currentView) return;
        items = result.items || [];

        // Alerts are about what is still to come.
        const uniqueAlerts = view === "upcoming"
          ? [...new Map((result.alerts || []).map((alert) => [alert.reasonCode, alert])).values()]
          : [];
        surface.querySelector("[data-alerts]").innerHTML = uniqueAlerts
          .map(newsletterAlertMarkup)
          .join("");

        const displayedItems = items;
        const groups = {};
        const direction = currentView === "past" ? -1 : 1;
        const sortedItems = [...displayedItems].sort((a, b) => direction * a.publicationDate.localeCompare(b.publicationDate));
        for (const item of sortedItems) {
          (groups[groupKey(item)] ||= []).push(item);
        }
        surface.querySelector("[data-slots]").innerHTML = displayedItems.length
          ? Object.entries(groups)
              .map(([period, issues]) => newsletterPeriodMarkup(period, issues))
              .join("")
          : `
            <div class="honest-state planner-empty">
              <strong>${currentView === "past" ? "No past issues" : "No upcoming issues"}</strong>
              <p>${currentView === "past" ? "Past issues come from the schedule sheet." : "Add the next issue."}</p>
              ${currentView === "past" ? "" : globalThis.dakitCollection.createButtonMarkup({
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
      api,
      load,
    });

    surface.querySelector("[data-newsletter-add]").onclick = () => {
      openIssueDialog(null);
    };

    /** "Create card now": the Card normally comes from the daily run. */
    async function createIssueCard(item, button) {
      button.disabled = true;
      try {
        await api(`/${encodeURIComponent(item.id)}/card`, {
          method: "POST",
          body: JSON.stringify({ version: item.version }),
        });
        await load();
      } catch (error) {
        button.disabled = false;
        status.textContent = `Could not create the card for ${item.label}: ${error.message}`;
      }
    }

    attachSlotControls(surface.querySelector("[data-slots]"), {
      findIssue: (id) => items.find((value) => value.id === id),
      request,
      workApiUrl,
      onChanged: () => load(),
      onError: (message) => { status.textContent = message; },
    });

    surface.querySelector("[data-slots]").onclick = (event) => {
      const target = event.target;
      const createCard = target.closest("[data-create-card]");
      if (createCard) {
        const item = items.find((value) => value.id === createCard.dataset.createCard);
        if (item) createIssueCard(item, createCard);
        return;
      }
      const issueId = target.closest("[data-edit]")?.dataset.edit;
      if (!issueId) {
        // The empty schedule repeats Add issue.
        if (target.closest("[data-newsletter-add-first]")) openIssueDialog(null);
        return;
      }
      const item = items.find((value) => value.id === issueId);
      if (!item) return;
      openIssueDialog(item);
    };
    await load();
  }

  return {
    renderNewsletterSurface,
  };
}
