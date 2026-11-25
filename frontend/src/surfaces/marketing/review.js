import { escapeHtml } from "../../core/html.js";
import { formatDelta, formatNumber, html, marketingTabsMarkup, statusBadge } from "./shared.js";

// Alexey's weekly review capacity is constant 2 (warns, does not block).
export const ALEXEY_WEEKLY_REVIEW_LIMIT = 2;

export function weeklyReviewMarkup(review, capacity = null, loadError = "") {
  const week = review?.week || "Current week";
  const range = review?.weekStart && review?.weekEnd ? ` (${review.weekStart} to ${review.weekEnd})` : "";
  const dataAsOf = review?.dataAsOf ? `Data as of ${review.dataAsOf}` : "";

  const missing = Array.isArray(review?.missingData)
    ? review.missingData
    : Array.isArray(review?.missing)
      ? review.missing
      : [];

  const goalRows = (review?.goals || [])
    .map((row) => {
      const planHref = `/marketing/plans/${encodeURIComponent(row.planId || "")}`;
      const goalHref = `/marketing/plans/${encodeURIComponent(row.planId || "")}/goals/${encodeURIComponent(row.ref || row.goalRef || "")}`;
      return html`<tr>
        <td><a class="mkt-link" href="${planHref}" data-mkt-nav>${escapeHtml(row.planTitle || row.planId || "–")}</a></td>
        <td><a class="mkt-link" href="${goalHref}" data-mkt-nav>${escapeHtml(row.goalTitle || row.title || row.ref || "–")}</a></td>
        <td class="mkt-num">${escapeHtml(formatNumber(row.previousValue ?? row.prev, row.unit))}</td>
        <td class="mkt-num">${escapeHtml(formatNumber(row.currentValue ?? row.current, row.unit))}</td>
        <td class="mkt-num">${escapeHtml(formatDelta(row.delta, row.unit))}</td>
        <td>${statusBadge(row.status || "no-data", "goal")}</td>
      </tr>`;
    })
    .join("");

  const shipped = review?.shippedLastWeek || review?.shipped || [];
  const due = review?.dueThisWeek || review?.due || [];
  const overdue = review?.overdue || [];
  const decisions = review?.needsDecision || review?.decisions || [];

  const capData = capacity || review?.capacity || null;
  const alexeyReviews = capData?.alexeyReviews ?? capData?.reviewsCount ?? null;
  const overLimit = alexeyReviews !== null && Number(alexeyReviews) > ALEXEY_WEEKLY_REVIEW_LIMIT;

  const renderWorkList = (items, emptyText) =>
    items.length
      ? html`<ul class="mkt-work-list">${items
          .map(
            (item) => html`<li>
              <a class="mkt-link" href="/marketing/steps/${encodeURIComponent(item.id || item.stepId || "")}" data-mkt-nav>${escapeHtml(item.title || item.id)}</a>
              <span class="mkt-muted">${escapeHtml(item.publishDate || item.date || "")}${item.ownerId ? ` · ${escapeHtml(item.ownerId)}` : ""}</span>
            </li>`,
          )
          .join("")}</ul>`
      : html`<p class="mkt-muted">${escapeHtml(emptyText)}</p>`;

  return html`<header class="dk-page-header">
      <div class="dk-page-header__main">
        <h1 class="dk-page-header__title">Marketing</h1>
        ${marketingTabsMarkup("review")}
      </div>
    </header>

    <section class="mkt-section" aria-labelledby="mkt-review-heading">
      <header class="dk-section-header">
        <div>
          <h2 id="mkt-review-heading" class="dk-section-header__title">Weekly Marketing Review · ${escapeHtml(week)}${escapeHtml(range)}</h2>
          ${dataAsOf ? html`<p class="mkt-muted">${escapeHtml(dataAsOf)}</p>` : ""}
        </div>
      </header>
      ${loadError ? html`<div class="dk-callout dk-callout--warning" role="status">${escapeHtml(loadError)} <button type="button" class="dk-button dk-button--secondary dk-button--sm" data-mkt-retry>Retry</button></div>` : ""}
      ${missing.length
        ? html`<div class="dk-callout dk-callout--warning" role="status">
            <strong>Missing data:</strong> ${missing.map((m) => escapeHtml(typeof m === "string" ? m : `${m.metricKey || m.metric} (${m.source || m.reason || "missing"})`)).join("; ")}
          </div>`
        : ""}
      ${goalRows
        ? html`<div class="mkt-table-wrap"><table class="dk-table mkt-table">
            <thead>
              <tr>
                <th scope="col">Plan</th>
                <th scope="col">Goal</th>
                <th scope="col" class="mkt-num">Previous</th>
                <th scope="col" class="mkt-num">Current</th>
                <th scope="col" class="mkt-num">Δ</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>${goalRows}</tbody>
          </table></div>`
        : html`<p class="mkt-muted">No active goals in this review yet.</p>`}
    </section>

    <section class="mkt-grid-3" aria-label="Weekly step execution">
      <div class="mkt-card">
        <h3>Shipped last week (${shipped.length})</h3>
        ${renderWorkList(shipped, "None")}
      </div>
      <div class="mkt-card">
        <h3>Due this week (${due.length})</h3>
        ${renderWorkList(due, "None")}
      </div>
      <div class="mkt-card">
        <h3>Overdue (${overdue.length})</h3>
        ${renderWorkList(overdue, "None")}
      </div>
    </section>

    ${decisions.length
      ? html`<section class="mkt-section" aria-labelledby="mkt-decisions-heading">
          <header class="dk-section-header">
            <h2 id="mkt-decisions-heading" class="dk-section-header__title">Needs a Decision</h2>
          </header>
          <ul class="mkt-notes-list">${decisions
            .map(
              (d) => html`<li class="mkt-decision-item">
                <div>
                  <strong>${escapeHtml(d.goalTitle || d.title || d.goalRef || "")}</strong>
                  ${d.reason ? html` <span class="dk-badge dk-badge--danger">${escapeHtml(d.reason)}</span>` : ""}
                  ${d.proposal ? html`<p class="mkt-muted">${escapeHtml(d.proposal)}</p>` : ""}
                </div>
                ${d.planId
                  ? html`<div class="mkt-decision-actions">
                      <button type="button" class="dk-button dk-button--secondary dk-button--sm" data-mkt-decision="ignore" data-plan-id="${escapeHtml(d.planId)}" data-goal-ref="${escapeHtml(d.goalRef || "")}">Ignore 2 weeks</button>
                    </div>`
                  : ""}
              </li>`,
            )
            .join("")}</ul>
        </section>`
      : ""}

    ${alexeyReviews !== null
      ? html`<p class="mkt-capacity-line${overLimit ? " is-over-limit" : ""}">
          Alexey reviews next week: <strong>${escapeHtml(String(alexeyReviews))}</strong> (weekly limit ${ALEXEY_WEEKLY_REVIEW_LIMIT}${overLimit ? " — over capacity" : ""})
        </p>`
      : ""}`;
}
