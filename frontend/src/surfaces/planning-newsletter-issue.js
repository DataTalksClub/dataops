// The per-issue page at /newsletter/<issueId>: one newsletter issue's
// details, reached from the planner's rows and addressable as a deep link.
// Read-only: the planner's rows and its dialog stay the editing surfaces.
import { sponsorRecordPath } from "../core/sponsor-routes.js";
import { renderPageHeaderMarkup } from "./operations-overview.js";
import {
  SLOT_POSITIONS,
  cardDueLabel,
  issueStatsSummaryMarkup,
  plannerLabel,
  plannerStatusClass,
  slotName,
  stageLabel,
} from "./planning-newsletter-slots.js";

const enc = encodeURIComponent;

function formatIssueDate(iso) {
  const parsed = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(parsed.getTime())
    ? String(iso)
    : new Intl.DateTimeFormat("en-GB", {
        weekday: "long",
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      }).format(parsed);
}

export function createNewsletterIssuePage(context) {
  const {
    documentList,
    escapeHtml,
    getActiveWorkspaceRoute,
    request,
    setRouteTitle,
    todayIsoDate,
    workApiUrl,
  } = context;

  function routeIssueId() {
    return getActiveWorkspaceRoute?.()?.params?.get("issueId") || "";
  }

  /** One slot's sponsor, linked to its company when the booking recorded one. */
  function sponsorLine(item, position) {
    const slot = item.slots?.[position] || {};
    const sponsor = slot.sponsor
      ? slot.organizationId
        ? `<a href="${escapeHtml(sponsorRecordPath("company", slot.organizationId))}">${escapeHtml(slot.sponsor)}</a>`
        : escapeHtml(slot.sponsor)
      : "open";
    const doc = slot.documentUrl
      ? ` <a class="newsletter-issue-doc" href="${escapeHtml(slot.documentUrl)}" target="_blank" rel="noreferrer">document</a>`
      : "";
    return `<li class="newsletter-issue-sponsor"><strong>${escapeHtml(slotName(item, position))}:</strong> ${sponsor}${doc}</li>`;
  }

  function sponsorsMarkup(item) {
    const positions = SLOT_POSITIONS[item.kind] || [];
    return `<ul class="newsletter-issue-sponsors" data-issue-sponsors aria-label="Sponsor slots">${positions
      .map((position) => sponsorLine(item, position))
      .join("")}</ul>`;
  }

  /** The campaign and any links recorded on the issue. */
  function docLinksMarkup(item) {
    const anchors = [];
    if (item.publicUrl) {
      anchors.push(
        `<a class="newsletter-issue-doc" data-issue-campaign-link href="${escapeHtml(item.publicUrl)}" target="_blank" rel="noreferrer">Open campaign</a>`,
      );
    }
    for (const link of item.links || []) {
      if (link?.name && link?.url) {
        anchors.push(
          `<a class="newsletter-issue-doc" href="${escapeHtml(link.url)}" target="_blank" rel="noreferrer">${escapeHtml(link.name)}</a>`,
        );
      }
    }
    if (!anchors.length) return "";
    return `<div class="newsletter-issue-docs">${anchors.join(" ")}</div>`;
  }

  function statsMarkup(item) {
    return (
      issueStatsSummaryMarkup(item, escapeHtml)
      || `<p class="dk-hint" data-issue-stats-empty>No performance stats recorded.</p>`
    );
  }

  /** The issue's Card with its open/total Tasks, or the honest state of having none. */
  function cardMarkup(item) {
    if (item.card) {
      const card = item.card;
      const name = `Open card: ${card.title || "Untitled card"}`;
      return `
        <a class="newsletter-card-chip" data-issue-card-link href="/cards?cardId=${enc(card.id)}"
          title="${escapeHtml(name)}">
          <span class="newsletter-card-chip__label">Card</span>
          <span class="newsletter-card-chip__meta">${escapeHtml(stageLabel(card.stage))} ·
            <span class="dk-mono">${escapeHtml(`${card.openTaskCount}/${card.taskCount}`)}</span> open</span>
        </a>`;
    }
    if (item.cardId) return `<span class="dk-badge dk-badge--danger">Card unavailable</span>`;
    const due = cardDueLabel(item.cardDueDate, todayIsoDate());
    return `<span class="newsletter-card-due" data-no-card>${escapeHtml(due || "No card yet")}</span>`;
  }

  function readyMarkup(item) {
    const numberMarkup = item.issueNumber != null
      ? `<div><dt>Number</dt><dd data-issue-number><strong class="dk-mono">#${escapeHtml(item.issueNumber)}</strong></dd></div>`
      : "";
    const timeMarkup = item.publicationTime
      ? ` <span>Time: ${escapeHtml(item.publicationTime)} Europe/Berlin</span>`
      : "";
    const docLinks = docLinksMarkup(item);
    return `
      <article class="newsletter-issue-details" data-issue-details>
        <div class="newsletter-slot-title">
          <span class="planner-status ${plannerStatusClass(item.status)}">${escapeHtml(plannerLabel(item.status))}</span>
          <small class="newsletter-kind-badge">${item.kind === "standalone" ? "Stand-alone" : "Weekly"}</small>
        </div>
        <dl class="newsletter-issue-facts">
          <div><dt>Date</dt><dd><time datetime="${escapeHtml(item.publicationDate)}">${escapeHtml(formatIssueDate(item.publicationDate))}</time>${timeMarkup}</dd></div>
          ${numberMarkup}
          <div><dt>Kind</dt><dd>${item.kind === "standalone" ? "Stand-alone" : "Weekly"}</dd></div>
          <div><dt>Sponsors</dt><dd>${sponsorsMarkup(item)}</dd></div>
          ${docLinks ? `<div><dt>Documents</dt><dd data-issue-doc-links>${docLinks}</dd></div>` : ""}
          <div><dt>Stats</dt><dd>${statsMarkup(item)}</dd></div>
          <div><dt>Card</dt><dd>${cardMarkup(item)}</dd></div>
        </dl>
        <div class="newsletter-issue-actions">
          <a class="newsletter-issue-preview-link" data-issue-preview-link href="/newsletter-issues/${enc(item.id)}/preview">Open Markdown &amp; HTML preview</a>
        </div>
      </article>
    `;
  }

  function notFoundMarkup() {
    return `
      <div class="honest-state planner-empty" data-issue-notfound>
        <strong>Newsletter issue not found</strong>
        <p>The issue may have been removed, or the link is not an issue's id.</p>
        <a class="collection-empty-action" href="/newsletter">Back to all issues</a>
      </div>
    `;
  }

  function failureMarkup(message) {
    return `
      <div class="honest-state planner-failure">
        <strong>Newsletter issue unavailable</strong>
        <p>${escapeHtml(message || "Reopen the issue to retry.")}</p>
        <a class="collection-empty-action" href="/newsletter">Back to all issues</a>
      </div>
    `;
  }

  /** Renders the issue page when the route addresses one; false for the planner. */
  async function renderNewsletterIssuePage() {
    const issueId = routeIssueId();
    if (!issueId) return false;
    setRouteTitle("Newsletter");
    const surface = document.createElement("section");
    surface.className = "newsletter-surface newsletter-issue-page";
    surface.setAttribute("aria-labelledby", "newsletter-issue-title");
    surface.innerHTML = `
      <nav class="newsletter-issue-toolbar" aria-label="Newsletter"><a href="/newsletter">All issues</a></nav>
      ${renderPageHeaderMarkup({ title: "Newsletter issue", titleId: "newsletter-issue-title", className: "planner-header" })}
      <p class="planner-load-state" role="status">Loading newsletter issue…</p>
      <div class="newsletter-schedule" data-issue-body></div>
    `;
    documentList.replaceChildren();
    documentList.append(surface);
    const status = surface.querySelector('[role="status"]');
    const body = surface.querySelector("[data-issue-body]");
    let item = null;
    try {
      item = await request(workApiUrl(`/api/newsletter-issues/${enc(issueId)}`));
    } catch (error) {
      status.textContent = "";
      body.innerHTML = error?.status === 404 ? notFoundMarkup() : failureMarkup(error?.message);
      return true;
    }
    status.textContent = "";
    surface.querySelector("#newsletter-issue-title").textContent = item.label || "Newsletter issue";
    body.innerHTML = readyMarkup(item);
    return true;
  }

  return { renderNewsletterIssuePage, routeIssueId };
}
