import { escapeHtml } from "../../core/html.js";
import { formatDelta, formatNumber, html, marketingTabsMarkup, statusBadge, snapshotRange } from "./shared.js";

// Alexey's weekly review capacity is constant 2 (warns, does not block).
export const ALEXEY_WEEKLY_REVIEW_LIMIT = 2;

export function weeklyReviewMarkup(review, loadError = "") {
  const week = review?.week || "Current week";
  const range = review?.from && review?.to ? ` (${review.from} to ${review.to})` : "";
  const dataAsOf = review?.dataAsOf ? `Data as of ${review.dataAsOf}` : "";

  const missing = review?.missing || [];
  const goals = (review?.plans || []).flatMap((plan) => (plan.goals || []).map((goal) => {
    const snapshots = [...(goal.snapshots || [])]
      .sort((a, b) => snapshotRange(a).to.localeCompare(snapshotRange(b).to));
    const prior = snapshots.slice(0, -1);
    const last = prior.at(-1);
    const selected = goal.window === "rolling28" && last
      ? prior.filter((row) => +new Date(snapshotRange(last).to)
        - +new Date(snapshotRange(row).to) < 28 * 86400000) : prior.slice(-1);
    const previous = selected.length ? selected.reduce((sum, row) => sum + row.value, 0)
      / (goal.window === "rolling28" && last.unit !== "count" ? selected.length : 1) : null;
    return { ...goal, planId: plan.id, planTitle: plan.title, goalTitle: goal.title,
      previousValue: previous, currentValue: goal.value,
      delta: previous != null && goal.value != null ? goal.value - previous : null };
  }));

  const goalRows = goals
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

  const shipped = review?.shipped || [];
  const due = review?.due || [];
  const overdue = review?.overdue || [];
  const capacityRows = review?.capacity?.items || [];
  const overLimit = capacityRows.some((row) => row.reviews > ALEXEY_WEEKLY_REVIEW_LIMIT);

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
      ${loadError
        ? html`<div class="dk-callout dk-callout--warning" role="status">
            ${escapeHtml(loadError)}
            <button type="button" class="dk-button dk-button--secondary dk-button--sm" data-mkt-retry>Retry</button>
          </div>`
        : ""}
      ${missing.length
        ? html`<div class="dk-callout dk-callout--warning" role="status">
            <strong>Missing data:</strong> ${missing
              .map((m) => escapeHtml(typeof m === "string" ? m : `${m.metricKey || m.metric} (${m.source || m.reason || "missing"})`))
              .join("; ")}
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

    ${goals.some((g) => g.status === "off-track") ? html`<section class="mkt-section">
      <h3>Needs a decision</h3>
      <ul class="mkt-work-list">${goals.filter((g) => g.status === "off-track").map((g) => html`<li>
        <a class="mkt-link" href="/marketing/plans/${encodeURIComponent(g.planId)}/goals/${encodeURIComponent(g.ref)}" data-mkt-nav>${escapeHtml(g.goalTitle)}</a>
        <span class="mkt-muted">Review the goal and record the decision in the plan notes.</span>
      </li>`).join("")}</ul>
    </section>` : ""}

    ${capacityRows.length ? html`<p class="mkt-capacity-line${overLimit ? " is-over-limit" : ""}">
      ${capacityRows.map((row) => html`<span>${escapeHtml(row.week)}: ${escapeHtml(row.small)} S + ${escapeHtml(row.large)} L;
        Alexey reviews: <strong>${escapeHtml(row.reviews)}</strong>
        (weekly limit ${ALEXEY_WEEKLY_REVIEW_LIMIT}${row.reviews > ALEXEY_WEEKLY_REVIEW_LIMIT ? " — over capacity" : ""})</span>`).join(" · ")}
    </p>` : ""}
    ${review?.idle?.length ? html`<p class="mkt-muted">No work scheduled in the next two weeks: ${review.idle.map((id) => escapeHtml(id)).join(", ")}</p>` : ""}
    ${review?.stale?.length ? html`<section class="mkt-section"><h3>Planned for more than six weeks</h3>${renderWorkList(review.stale, "None")}</section>` : ""}`;
}
