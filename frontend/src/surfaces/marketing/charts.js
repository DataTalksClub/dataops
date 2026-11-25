import { escapeHtml } from "../../core/html.js";
import { formatNumber, html } from "./shared.js";

function niceMax(value) {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (step * power >= value) return step * power;
  }
  return 10 * power;
}

function compactValue(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "";
  if (Math.abs(num) >= 1000) return `${Math.round(num / 100) / 10}k`;
  if (Number.isInteger(num)) return String(num);
  return num.toFixed(1).replace(/\.0$/, "");
}

function sortedSnapshots(snapshots) {
  return [...(snapshots || [])]
    .filter((s) => s && s.periodEnd !== undefined && s.value !== undefined && s.value !== null)
    .sort((a, b) => String(a.periodEnd).localeCompare(String(b.periodEnd)));
}

/**
 * Compact inline SVG sparkline for a goal row on the Plan page.
 * Reuses the hand-written inline-SVG approach from finance/overview.js.
 */
export function sparklineSvg(snapshots, goal) {
  const points = sortedSnapshots(snapshots);
  const W = 120;
  const H = 28;
  const padX = 4;
  const padY = 4;

  if (!points.length) {
    return html`<svg class="mkt-sparkline mkt-sparkline--empty" viewBox="0 0 ${W} ${H}" role="img" aria-label="No snapshot data">
      <line class="mkt-sparkline__baseline" x1="${padX}" x2="${W - padX}" y1="${H / 2}" y2="${H / 2}"/>
    </svg>`;
  }

  const values = points.map((p) => Number(p.value));
  const targetVal = goal?.target?.value !== undefined ? Number(goal.target.value) : null;
  const baselineVal = goal?.baseline?.value !== undefined ? Number(goal.baseline.value) : null;
  const allVals = [...values];
  if (Number.isFinite(targetVal)) allVals.push(targetVal);
  if (Number.isFinite(baselineVal)) allVals.push(baselineVal);

  const min = Math.min(...allVals, 0);
  const max = Math.max(...allVals, min + 1);
  const span = max - min || 1;
  const plotW = W - padX * 2;
  const plotH = H - padY * 2;

  const xFor = (i) =>
    points.length === 1 ? padX + plotW / 2 : padX + (i / (points.length - 1)) * plotW;
  const yFor = (v) => padY + plotH - ((v - min) / span) * plotH;

  const polyPoints = points.map((p, i) => `${xFor(i).toFixed(1)},${yFor(Number(p.value)).toFixed(1)}`).join(" ");
  const last = points[points.length - 1];
  const lastX = xFor(points.length - 1).toFixed(1);
  const lastY = yFor(Number(last.value)).toFixed(1);
  const targetLine = Number.isFinite(targetVal)
    ? html`<line class="mkt-sparkline__target" x1="${padX}" x2="${W - padX}" y1="${yFor(targetVal).toFixed(1)}" y2="${yFor(targetVal).toFixed(1)}"/>`
    : "";

  const label = `${escapeHtml(goal?.title || "Goal")}: ${points.length} snapshots, latest ${formatNumber(last.value, last.unit)}`;
  return html`<svg class="mkt-sparkline" viewBox="0 0 ${W} ${H}" role="img" aria-label="${label}">
    <title>${label}</title>
    ${targetLine}
    ${points.length > 1 ? html`<polyline class="mkt-sparkline__line" points="${polyPoints}"/>` : ""}
    <circle class="mkt-sparkline__dot" cx="${lastX}" cy="${lastY}" r="2.5"/>
  </svg>`;
}

/**
 * Full inline SVG chart for the Goal detail page: series line, baseline,
 * target line, and published step markers.
 */
export function goalChartMarkup(snapshots, goal, publishedSteps = []) {
  const points = sortedSnapshots(snapshots);
  if (!points.length) {
    return html`<div class="mkt-empty">No snapshots recorded for this series yet.</div>`;
  }

  const W = 720;
  const H = 260;
  const left = 52;
  const right = 16;
  const top = 18;
  const bottom = 30;
  const plotW = W - left - right;
  const plotH = H - top - bottom;

  const targetVal = goal?.target?.value !== undefined ? Number(goal.target.value) : null;
  const baselineVal = goal?.baseline?.value !== undefined ? Number(goal.baseline.value) : null;
  const unit = points[0]?.unit || "";

  const allVals = points.map((p) => Number(p.value));
  if (Number.isFinite(targetVal)) allVals.push(targetVal);
  if (Number.isFinite(baselineVal)) allVals.push(baselineVal);

  const rawMax = Math.max(...allVals, 1);
  const max = niceMax(rawMax);
  const min = Math.min(...allVals, 0) < 0 ? -niceMax(Math.abs(Math.min(...allVals, 0))) : 0;
  const span = max - min || 1;

  const xFor = (i) =>
    points.length === 1 ? left + plotW / 2 : left + (i / (points.length - 1)) * plotW;
  const yFor = (v) => top + plotH - ((v - min) / span) * plotH;

  const ticks = [max, min + (max - min) * 0.5, min];
  const grid = ticks
    .map(
      (v) => html`<line class="mkt-chart__grid${v === 0 ? " mkt-chart__base" : ""}" x1="${left}" x2="${W - right}" y1="${yFor(v).toFixed(1)}" y2="${yFor(v).toFixed(1)}"/>
      <text class="mkt-chart__tick" x="${left - 6}" y="${(yFor(v) + 4).toFixed(1)}" text-anchor="end">${escapeHtml(compactValue(v))}</text>`,
    )
    .join("");

  const baselineLine = Number.isFinite(baselineVal)
    ? html`<line class="mkt-chart__baseline" x1="${left}" x2="${W - right}" y1="${yFor(baselineVal).toFixed(1)}" y2="${yFor(baselineVal).toFixed(1)}"/>`
    : "";

  const targetLine = Number.isFinite(targetVal)
    ? html`<line class="mkt-chart__target" x1="${left}" x2="${W - right}" y1="${yFor(targetVal).toFixed(1)}" y2="${yFor(targetVal).toFixed(1)}"/>`
    : "";

  const polyPoints = points.map((p, i) => `${xFor(i).toFixed(1)},${yFor(Number(p.value)).toFixed(1)}`).join(" ");

  // Publish markers for steps whose publishedAt/publishDate falls within the chart dates.
  const firstDate = String(points[0].periodEnd).slice(0, 10);
  const lastDate = String(points[points.length - 1].periodEnd).slice(0, 10);
  const stepMarkers = (publishedSteps || [])
    .map((step) => {
      const pubDate = String(step.publishedAt || step.publishDate || "").slice(0, 10);
      if (!pubDate || pubDate < firstDate || pubDate > lastDate) return "";
      const idx = points.findIndex((p) => String(p.periodEnd).slice(0, 10) >= pubDate);
      const x = xFor(idx >= 0 ? idx : points.length - 1);
      const hover = `Published: ${step.title || step.id} (${pubDate})`;
      return html`<g class="mkt-chart__marker" data-mkt-hover="${escapeHtml(hover)}">
        <line class="mkt-chart__marker-line" x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${top}" y2="${top + plotH}"/>
        <circle class="mkt-chart__marker-dot" cx="${x.toFixed(1)}" cy="${top + 6}" r="3.5"><title>${escapeHtml(hover)}</title></circle>
      </g>`;
    })
    .join("");

  const marks = points
    .map((p, i) => {
      const cx = xFor(i);
      const cy = yFor(Number(p.value));
      const label = `${p.periodEnd}: ${formatNumber(p.value, p.unit || unit)}${p.provisional ? " (provisional)" : ""}${p.note ? ` — ${p.note}` : ""}`;
      const showTick =
        points.length <= 8 || i === 0 || i === points.length - 1 || i % Math.ceil(points.length / 6) === 0;
      const slotW = points.length === 1 ? plotW : plotW / points.length;
      return html`<g class="mkt-chart__point-group" data-mkt-hover="${escapeHtml(label)}">
        <rect class="mkt-chart__hit" x="${(cx - slotW / 2).toFixed(1)}" y="${top}" width="${slotW.toFixed(1)}" height="${plotH}"><title>${escapeHtml(label)}</title></rect>
        <circle class="mkt-chart__dot${p.provisional ? " is-provisional" : ""}" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="4"/>
        ${showTick ? html`<text class="mkt-chart__tick" x="${cx.toFixed(1)}" y="${H - 8}" text-anchor="middle">${escapeHtml(String(p.periodEnd).slice(5, 10))}</text>` : ""}
      </g>`;
    })
    .join("");

  return html`<figure class="mkt-chart">
    <figcaption class="mkt-chart__caption">
      <span class="mkt-legend"><span class="mkt-legend__dot"></span>Actual</span>
      ${Number.isFinite(targetVal) ? html`<span class="mkt-legend"><span class="mkt-legend__line mkt-legend__line--target"></span>Target (${escapeHtml(formatNumber(targetVal, unit))})</span>` : ""}
      ${Number.isFinite(baselineVal) ? html`<span class="mkt-legend"><span class="mkt-legend__line mkt-legend__line--baseline"></span>Baseline (${escapeHtml(formatNumber(baselineVal, unit))})</span>` : ""}
      ${stepMarkers ? html`<span class="mkt-legend"><span class="mkt-legend__marker"></span>Step published</span>` : ""}
    </figcaption>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(goal?.title || "Goal")} trend chart">${grid}${baselineLine}${targetLine}${stepMarkers}${points.length > 1 ? html`<polyline class="mkt-chart__line" points="${polyPoints}"/>` : ""}${marks}</svg>
  </figure>`;
}
