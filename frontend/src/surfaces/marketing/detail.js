import { escapeHtml } from "../../core/html.js";
import { goalChartMarkup } from "./charts.js";
import { formatNumber, html, statusBadge } from "./shared.js";

export function goalDetailMarkup(plan, goal, snapshots = [], publishedSteps = []) {
  const planId = plan?.id || goal?.planId || "";
  const planTitle = plan?.title || planId;
  const rows = [...(snapshots || [])]
    .sort((a, b) => String(b.periodEnd || "").localeCompare(String(a.periodEnd || "")))
    .map((s) => {
      const period = s.periodStart && s.periodStart !== s.periodEnd
        ? `${s.periodStart} – ${s.periodEnd}`
        : s.periodEnd || "–";
      const artifact = s.artifactId
        ? html`<a class="mkt-link" href="/api/artifacts/${encodeURIComponent(s.artifactId)}" target="_blank" rel="noopener">${escapeHtml(s.artifactId)}</a>`
        : "–";
      return html`<tr>
        <td class="mkt-nowrap">${escapeHtml(period)}</td>
        <td class="mkt-num">${escapeHtml(formatNumber(s.value, s.unit))}</td>
        <td>${escapeHtml(s.source || goal?.source || "–")}</td>
        <td>${escapeHtml(s.note || "–")}</td>
        <td>${s.provisional ? html`<span class="dk-badge dk-badge--warning">provisional</span>` : "final"}</td>
        <td>${artifact}</td>
        <td class="mkt-muted mkt-nowrap">${escapeHtml(s.pushedBy || "")} ${escapeHtml(String(s.pushedAt || "").slice(0, 10))}</td>
      </tr>`;
    })
    .join("");

  return html`<header class="dk-page-header">
      <div class="dk-page-header__main">
        <p class="mkt-breadcrumb">
          <a href="/marketing" data-mkt-nav>Marketing</a> /
          ${planId ? html`<a href="/marketing/plans/${encodeURIComponent(planId)}" data-mkt-nav>${escapeHtml(planTitle)}</a> /` : ""}
        </p>
        <h1 class="dk-page-header__title">${escapeHtml(goal?.title || goal?.ref || "Goal")} ${statusBadge(goal?.status || "no-data", "goal")}</h1>
        <p class="mkt-meta">
          <span>Metric: <code>${escapeHtml(goal?.metricKey || "–")}</code></span>
          <span>Scope: <code>${escapeHtml(goal?.scope || "–")}</code></span>
          <span>Source: <code>${escapeHtml(goal?.source || "–")}</code></span>
          ${goal?.window ? html`<span>Window: ${escapeHtml(goal.window)}</span>` : ""}
        </p>
        <p class="mkt-meta">
          ${goal?.baseline ? html`<span>Baseline: <strong>${escapeHtml(formatNumber(goal.baseline.value))}</strong> (${escapeHtml(goal.baseline.date || "")}${goal.baseline.note ? `, ${escapeHtml(goal.baseline.note)}` : ""})</span>` : ""}
          ${goal?.target ? html`<span>Target: <strong>${escapeHtml(formatNumber(goal.target.value))}</strong> by ${escapeHtml(goal.target.date || "")}</span>` : ""}
        </p>
      </div>
    </header>

    <section class="mkt-section" aria-labelledby="mkt-goal-chart-heading">
      <h2 id="mkt-goal-chart-heading" class="dk-section-header__title">Series</h2>
      ${goalChartMarkup(snapshots, goal, publishedSteps)}
    </section>

    <section class="mkt-section" aria-labelledby="mkt-snapshots-heading">
      <header class="dk-section-header">
        <h2 id="mkt-snapshots-heading" class="dk-section-header__title">Snapshots</h2>
      </header>
      ${rows
        ? html`<div class="mkt-table-wrap"><table class="dk-table mkt-table">
            <thead>
              <tr>
                <th scope="col">Period</th>
                <th scope="col" class="mkt-num">Value</th>
                <th scope="col">Source</th>
                <th scope="col">Note</th>
                <th scope="col">State</th>
                <th scope="col">Artifact</th>
                <th scope="col">Pushed</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table></div>`
        : html`<p class="mkt-muted">No snapshots yet.</p>`}
    </section>`;
}

const UTM_SOURCES = [
  "linkedin",
  "newsletter",
  "x",
  "slack",
  "youtube",
  "podcast",
  "aishippingblog",
  "reddit",
  "hackernews",
  "devto",
  "github",
  "outreach",
];

export function stepDetailMarkup(step, plan = null, utmResult = null) {
  const status = step.status || (step.dropped ? "dropped" : step.cardId || step.taskId ? "scheduled" : "planned");
  const planId = step.planId || plan?.id || "";
  const planTitle = plan?.title || planId;
  const prompts = Array.isArray(step.prompts) ? step.prompts : [];
  const goalRefs = Array.isArray(step.goalRefs) ? step.goalRefs : [];
  const links = Array.isArray(step.links) ? step.links : [];

  return html`<header class="dk-page-header">
      <div class="dk-page-header__main">
        <p class="mkt-breadcrumb">
          <a href="/marketing" data-mkt-nav>Marketing</a> /
          ${planId ? html`<a href="/marketing/plans/${encodeURIComponent(planId)}" data-mkt-nav>${escapeHtml(planTitle)}</a> /` : ""}
        </p>
        <h1 class="dk-page-header__title">${escapeHtml(step.title || step.id)} ${statusBadge(status, "step")}</h1>
        <p class="mkt-meta">
          <span>ID: <code>${escapeHtml(step.id)}</code></span>
          <span>Kind: <strong>${escapeHtml(step.kind || "other")}</strong></span>
          ${step.size ? html`<span>Size: <strong>${escapeHtml(step.size)}</strong></span>` : ""}
          ${step.ownerId ? html`<span>Owner: <strong>${escapeHtml(step.ownerId)}</strong></span>` : ""}
          ${step.requestRef ? html`<span>Ref: <span class="dk-badge">${escapeHtml(step.requestRef)}</span></span>` : ""}
        </p>
      </div>
    </header>

    <section class="mkt-section" aria-labelledby="mkt-step-brief-heading">
      <header class="dk-section-header">
        <h2 id="mkt-step-brief-heading" class="dk-section-header__title">Brief</h2>
      </header>
      <dl class="mkt-dl">
        <div>
          <dt>Target URL</dt>
          <dd>${step.targetUrl ? html`<a class="mkt-link" href="${escapeHtml(step.targetUrl)}" target="_blank" rel="noopener">${escapeHtml(step.targetUrl)}</a>` : "–"}${step.targetType ? html` <span class="dk-badge">${escapeHtml(step.targetType)}</span>` : ""}</dd>
        </div>
        <div>
          <dt>Primary keyword</dt>
          <dd>${escapeHtml(step.primaryKeyword || "–")}</dd>
        </div>
        <div>
          <dt>Done criteria</dt>
          <dd>${escapeHtml(step.doneCriteria || "–")}</dd>
        </div>
        <div>
          <dt>Target goals</dt>
          <dd>${goalRefs.length ? goalRefs.map((ref) => html`<a class="dk-badge mkt-link" href="/marketing/plans/${encodeURIComponent(planId)}/goals/${encodeURIComponent(ref)}" data-mkt-nav>${escapeHtml(ref)}</a>`).join(" ") : "–"}</dd>
        </div>
        ${prompts.length ? html`<div><dt>AEO prompts</dt><dd>${prompts.map((p) => html`<span class="dk-badge">${escapeHtml(p)}</span>`).join(" ")}</dd></div>` : ""}
      </dl>
      ${step.brief ? html`<div class="mkt-brief-body"><pre class="mkt-pre">${escapeHtml(step.brief)}</pre></div>` : ""}
      ${links.length ? html`<ul class="mkt-links-list">${links.map((l) => html`<li><a class="mkt-link" href="${escapeHtml(l.url)}" target="_blank" rel="noopener">${escapeHtml(l.name || l.url)}</a></li>`).join("")}</ul>` : ""}
    </section>

    <section class="mkt-section" aria-labelledby="mkt-step-work-heading">
      <header class="dk-section-header">
        <h2 id="mkt-step-work-heading" class="dk-section-header__title">Execution &amp; Schedule</h2>
      </header>
      <dl class="mkt-dl">
        <div><dt>Publish date</dt><dd>${escapeHtml(step.publishDate || "Not scheduled")}</dd></div>
        ${step.publishedAt ? html`<div><dt>Published at</dt><dd>${escapeHtml(step.publishedAt)}</dd></div>` : ""}
        ${step.publishedUrl ? html`<div><dt>Published URL</dt><dd><a class="mkt-link" href="${escapeHtml(step.publishedUrl)}" target="_blank" rel="noopener">${escapeHtml(step.publishedUrl)}</a></dd></div>` : ""}
        ${step.cardId ? html`<div><dt>Card</dt><dd><a class="mkt-link" href="/cards?cardId=${encodeURIComponent(step.cardId)}">${escapeHtml(step.cardId)}</a></dd></div>` : ""}
        ${step.taskId ? html`<div><dt>Task</dt><dd><a class="mkt-link" href="/tasks?taskId=${encodeURIComponent(step.taskId)}">${escapeHtml(step.taskId)}</a></dd></div>` : ""}
        ${step.dropped ? html`<div><dt>Dropped</dt><dd>${escapeHtml(step.dropped.reason || "Dropped")} (${escapeHtml(step.dropped.at || "")})</dd></div>` : ""}
      </dl>

      ${status === "planned" && !step.dropped
        ? html`<form class="mkt-inline-form" data-mkt-schedule-form>
            <label>Publish date <input type="date" class="dk-input" name="publishDate" value="${escapeHtml(step.publishDate || "")}" required></label>
            <label>Mode
              <select class="dk-select" name="mode">
                <option value="card">card</option>
                <option value="task">task</option>
                <option value="link">link</option>
              </select>
            </label>
            <button type="submit" class="dk-button dk-button--primary dk-button--sm">Schedule</button>
          </form>`
        : ""}

      ${step.kind === "technical" && status !== "published" && status !== "done" && !step.dropped
        ? html`<form class="mkt-inline-form" data-mkt-live-form>
            <input type="url" class="dk-input mkt-inline-form__grow" name="url" placeholder="Live URL" value="${escapeHtml(step.targetUrl || "")}">
            <input type="date" class="dk-input" name="date">
            <button type="submit" class="dk-button dk-button--primary dk-button--sm">Mark live</button>
          </form>`
        : ""}

      ${!step.dropped && status !== "done"
        ? html`<form class="mkt-inline-form" data-mkt-drop-form>
            <input type="text" class="dk-input mkt-inline-form__grow" name="reason" placeholder="Reason to drop…" required>
            <button type="submit" class="dk-button dk-button--danger dk-button--sm">Drop step</button>
          </form>`
        : ""}
    </section>

    ${step.targetUrl
      ? html`<section class="mkt-section" aria-labelledby="mkt-utm-heading">
          <header class="dk-section-header">
            <h2 id="mkt-utm-heading" class="dk-section-header__title">UTM Link</h2>
          </header>
          <form class="mkt-inline-form" data-mkt-utm-form>
            <label>Source
              <select class="dk-select" name="source">
                ${UTM_SOURCES.map((src) => html`<option value="${src}">${src}</option>`).join("")}
              </select>
            </label>
            <button type="submit" class="dk-button dk-button--secondary dk-button--sm">Build UTM</button>
          </form>
          ${utmResult ? html`<p class="mkt-utm-result"><code>${escapeHtml(utmResult)}</code></p>` : ""}
        </section>`
      : ""}`;
}
