import { escapeHtml } from "../../core/html.js";
import { sparklineSvg } from "./charts.js";
import {
  berlinToday,
  formatNumber,
  html,
  marketingTabsMarkup,
  seriesKeyForGoal,
  snapshotAgeLabel,
  statusBadge,
} from "./shared.js";

export function planListMarkup(plans, today = berlinToday(), loadError = "") {
  const rows = (plans || [])
    .map((plan) => {
      const goals = Array.isArray(plan.goals) ? plan.goals : [];
      const chips = goals.length
        ? goals
            .map(
              (g) =>
                html`<span class="mkt-goal-chip">${escapeHtml(g.title || g.ref)} ${statusBadge(g.status || "no-data", "goal")}</span>`,
            )
            .join("")
        : html`<span class="mkt-muted">No goals yet</span>`;
      const dueCount = plan.stepsDueThisWeek ?? plan.dueThisWeekCount;
      const dueLabel = dueCount !== undefined && dueCount !== null ? String(dueCount) : "–";
      const lastSnap = plan.lastSnapshotAt || plan.lastSnapshotDate;
      const horizon = [plan.startDate, plan.endDate].filter(Boolean).join(" – ") || "–";
      return html`<tr>
        <td><a class="mkt-link" href="/marketing/plans/${encodeURIComponent(plan.id)}" data-mkt-nav>${escapeHtml(plan.title || plan.id)}</a></td>
        <td>${statusBadge(plan.status || "draft", "plan")}</td>
        <td>${escapeHtml(plan.ownerId || "–")}</td>
        <td class="mkt-nowrap">${escapeHtml(horizon)}</td>
        <td><div class="mkt-goal-chips">${chips}</div></td>
        <td class="mkt-num">${escapeHtml(dueLabel)}</td>
        <td class="mkt-nowrap mkt-muted">${escapeHtml(snapshotAgeLabel(lastSnap, today))}</td>
      </tr>`;
    })
    .join("");

  return html`<header class="dk-page-header">
      <div class="dk-page-header__main">
        <h1 class="dk-page-header__title">Marketing</h1>
        ${marketingTabsMarkup("plans")}
      </div>
      <div class="dk-page-header__actions">
        <button type="button" class="dk-button dk-button--primary dk-button--sm" data-mkt-open-new-plan>+ New plan</button>
      </div>
    </header>
    ${loadError ? html`<div class="dk-callout dk-callout--warning" role="status">${escapeHtml(loadError)} <button type="button" class="dk-button dk-button--secondary dk-button--sm" data-mkt-retry>Retry</button></div>` : ""}
    ${rows
      ? html`<div class="mkt-table-wrap"><table class="dk-table mkt-table">
          <thead>
            <tr>
              <th scope="col">Plan</th>
              <th scope="col">Status</th>
              <th scope="col">Owner</th>
              <th scope="col">Horizon</th>
              <th scope="col">Goals</th>
              <th scope="col" class="mkt-num">Due this week</th>
              <th scope="col">Data</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table></div>`
      : html`<div class="mkt-empty">
          <p>No marketing plans yet.</p>
          <p class="mkt-muted">Create a plan to track goals, steps, and weekly snapshots.</p>
        </div>`}
    ${newPlanDialogMarkup()}`;
}

export function filterStepsByTab(steps, activeTab) {
  const list = Array.isArray(steps) ? steps : [];
  if (activeTab === "planned") return list.filter((s) => (s.status || "planned") === "planned");
  if (activeTab === "scheduled") {
    return list.filter((s) => s.status === "scheduled" || s.status === "in-progress");
  }
  if (activeTab === "published") {
    return list.filter((s) => s.status === "published" || s.status === "done");
  }
  return list;
}

export function planDetailMarkup(plan, steps = [], goalSeriesMap = new Map(), activeStepTab = "all") {
  const goals = Array.isArray(plan?.goals) ? plan.goals : [];
  const notes = Array.isArray(plan?.notesLog) ? plan.notesLog : [];
  const tags = Array.isArray(plan?.tags) ? plan.tags : [];
  const sources = Array.isArray(plan?.sources) ? plan.sources : [];
  const horizon = [plan?.startDate, plan?.endDate].filter(Boolean).join(" to ");

  const goalRows = goals
    .map((g) => {
      const series = g.snapshots || g.series || goalSeriesMap.get(seriesKeyForGoal(g)) || [];
      const latestVal = g.latestValue ?? (series.length ? series[series.length - 1].value : null);
      const unit = g.unit || (series.length ? series[series.length - 1].unit : "");
      const targetStr = g.target
        ? `${formatNumber(g.target.value, unit)}${g.target.date ? ` by ${g.target.date}` : ""}`
        : "–";
      return html`<tr>
        <td><a class="mkt-link" href="/marketing/plans/${encodeURIComponent(plan.id)}/goals/${encodeURIComponent(g.ref)}" data-mkt-nav>${escapeHtml(g.title || g.ref)}</a></td>
        <td class="mkt-sparkline-cell">${sparklineSvg(series, g)}</td>
        <td class="mkt-num">${escapeHtml(formatNumber(latestVal, unit))}</td>
        <td class="mkt-num mkt-nowrap">${escapeHtml(targetStr)}</td>
        <td>${statusBadge(g.status || "no-data", "goal")}</td>
      </tr>`;
    })
    .join("");

  const filteredSteps = filterStepsByTab(steps, activeStepTab);
  const stepRows = filteredSteps
    .map((step) => {
      const status = step.status || (step.dropped ? "dropped" : step.cardId || step.taskId ? "scheduled" : "planned");
      return html`<tr>
        <td class="mkt-nowrap">${escapeHtml(step.size || "–")}</td>
        <td class="mkt-nowrap">${escapeHtml(step.kind || "other")}</td>
        <td><a class="mkt-link" href="/marketing/steps/${encodeURIComponent(step.id)}" data-mkt-nav>${escapeHtml(step.title || step.id)}</a></td>
        <td>${escapeHtml(step.ownerId || "–")}</td>
        <td class="mkt-nowrap">${escapeHtml(step.publishDate || "–")}</td>
        <td>${statusBadge(status, "step")}</td>
      </tr>`;
    })
    .join("");

  const noteRows = notes
    .map(
      (n) => html`<li class="mkt-note-item">
        <span class="mkt-muted mkt-nowrap">${escapeHtml(String(n.createdAt || "").slice(0, 10))}</span>
        ${n.ref ? html`<span class="dk-badge">${escapeHtml(n.ref)}</span>` : ""}
        ${n.authorId ? html`<span class="mkt-muted">${escapeHtml(n.authorId)}:</span>` : ""}
        <span>${escapeHtml(n.text || "")}</span>
      </li>`,
    )
    .join("");

  const stepTabs = [
    ["all", "All"],
    ["planned", "Planned"],
    ["scheduled", "Scheduled"],
    ["published", "Published"],
  ]
    .map(
      ([id, label]) =>
        html`<button type="button" class="dk-tab" data-mkt-step-tab="${id}" aria-pressed="${activeStepTab === id}">${label}</button>`,
    )
    .join("");

  return html`<header class="dk-page-header">
      <div class="dk-page-header__main">
        <p class="mkt-breadcrumb"><a href="/marketing" data-mkt-nav>Marketing</a> /</p>
        <h1 class="dk-page-header__title">${escapeHtml(plan.title || plan.id)} ${statusBadge(plan.status || "draft", "plan")}</h1>
        <p class="mkt-meta">
          ${plan.ownerId ? html`<span>Owner: <strong>${escapeHtml(plan.ownerId)}</strong></span>` : ""}
          ${horizon ? html`<span>${escapeHtml(horizon)}</span>` : ""}
          ${tags.length ? html`<span>Tags: ${tags.map((t) => html`<span class="dk-badge">${escapeHtml(t)}</span>`).join(" ")}</span>` : ""}
        </p>
        ${plan.objective ? html`<p class="mkt-objective">${escapeHtml(plan.objective)}</p>` : ""}
        ${sources.length ? html`<p class="mkt-meta">Sources: ${sources.map((s) => html`<a class="mkt-link" href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.name || s.url)}</a>`).join(" · ")}</p>` : ""}
      </div>
    </header>

    <section class="mkt-section" aria-labelledby="mkt-goals-heading">
      <header class="dk-section-header">
        <h2 id="mkt-goals-heading" class="dk-section-header__title">Goals</h2>
      </header>
      ${goalRows
        ? html`<div class="mkt-table-wrap"><table class="dk-table mkt-table">
            <thead>
              <tr>
                <th scope="col">Goal</th>
                <th scope="col">Trend</th>
                <th scope="col" class="mkt-num">Last</th>
                <th scope="col" class="mkt-num">Target</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>${goalRows}</tbody>
          </table></div>`
        : html`<p class="mkt-muted">No goals defined for this plan yet.</p>`}
    </section>

    <section class="mkt-section" aria-labelledby="mkt-steps-heading">
      <header class="dk-section-header">
        <h2 id="mkt-steps-heading" class="dk-section-header__title">Steps</h2>
        <div class="mkt-section-actions">
          <div class="dk-tabs dk-tabs--sm" role="group" aria-label="Step status">${stepTabs}</div>
          <button type="button" class="dk-button dk-button--secondary dk-button--sm" data-mkt-open-add-step>+ Add step</button>
        </div>
      </header>
      ${stepRows
        ? html`<div class="mkt-table-wrap"><table class="dk-table mkt-table">
            <thead>
              <tr>
                <th scope="col">Size</th>
                <th scope="col">Kind</th>
                <th scope="col">Title</th>
                <th scope="col">Owner</th>
                <th scope="col">Publish</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>${stepRows}</tbody>
          </table></div>`
        : html`<p class="mkt-muted">No steps in this view.</p>`}
    </section>

    <section class="mkt-section" aria-labelledby="mkt-notes-heading">
      <header class="dk-section-header">
        <h2 id="mkt-notes-heading" class="dk-section-header__title">Notes Log</h2>
      </header>
      ${noteRows ? html`<ul class="mkt-notes-list">${noteRows}</ul>` : html`<p class="mkt-muted">No notes yet.</p>`}
      <form class="mkt-inline-form" data-mkt-note-form>
        <input type="text" class="dk-input" name="ref" placeholder="Ref (e.g. t390u)" aria-label="Request ref">
        <input type="text" class="dk-input mkt-inline-form__grow" name="text" placeholder="Add a note…" aria-label="Note text" required>
        <button type="submit" class="dk-button dk-button--secondary dk-button--sm">Add note</button>
      </form>
    </section>
    ${addStepDialogMarkup()}`;
}

function newPlanDialogMarkup() {
  return html`<dialog class="surface-dialog" data-mkt-new-plan-dialog aria-label="New marketing plan">
    <form method="dialog" class="mkt-dialog-form" data-mkt-new-plan-form>
      <h2>New marketing plan</h2>
      <label class="mkt-field">Slug ID <input class="dk-input" name="id" required pattern="[a-z0-9-]{3,48}" placeholder="academy-visibility"></label>
      <label class="mkt-field">Title <input class="dk-input" name="title" required placeholder="Academy Visibility"></label>
      <label class="mkt-field">Objective <textarea class="dk-input" name="objective" rows="3" maxlength="500" placeholder="What success looks like"></textarea></label>
      <div class="mkt-field-row">
        <label class="mkt-field">Start date <input class="dk-input" type="date" name="startDate"></label>
        <label class="mkt-field">End date <input class="dk-input" type="date" name="endDate"></label>
      </div>
      <label class="mkt-field">Tags (comma-separated) <input class="dk-input" name="tags" placeholder="academy, seo"></label>
      <div class="mkt-dialog-actions">
        <button type="button" class="dk-button dk-button--secondary" data-mkt-close-dialog>Cancel</button>
        <button type="submit" class="dk-button dk-button--primary">Create plan</button>
      </div>
    </form>
  </dialog>`;
}

function addStepDialogMarkup() {
  return html`<dialog class="surface-dialog" data-mkt-add-step-dialog aria-label="Add marketing step">
    <form method="dialog" class="mkt-dialog-form" data-mkt-add-step-form>
      <h2>Add step</h2>
      <label class="mkt-field">Title <input class="dk-input" name="title" required placeholder="Refresh free data engineering courses list"></label>
      <div class="mkt-field-row">
        <label class="mkt-field">Kind
          <select class="dk-select" name="kind">
            <option value="content">content</option>
            <option value="refresh">refresh</option>
            <option value="newsletter">newsletter</option>
            <option value="podcast">podcast</option>
            <option value="social">social</option>
            <option value="outreach">outreach</option>
            <option value="technical">technical</option>
            <option value="other">other</option>
          </select>
        </label>
        <label class="mkt-field">Size
          <select class="dk-select" name="size">
            <option value="S">S</option>
            <option value="L">L</option>
          </select>
        </label>
      </div>
      <label class="mkt-field">Target URL <input class="dk-input" type="url" name="targetUrl" placeholder="https://datatalks.club/academy/"></label>
      <label class="mkt-field">Primary keyword <input class="dk-input" name="primaryKeyword" maxlength="100"></label>
      <label class="mkt-field">Done criteria <input class="dk-input" name="doneCriteria" required maxlength="500" placeholder="Published and indexed"></label>
      <label class="mkt-field">Brief <textarea class="dk-input" name="brief" rows="3" maxlength="4000"></textarea></label>
      <div class="mkt-dialog-actions">
        <button type="button" class="dk-button dk-button--secondary" data-mkt-close-dialog>Cancel</button>
        <button type="submit" class="dk-button dk-button--primary">Add step</button>
      </div>
    </form>
  </dialog>`;
}
