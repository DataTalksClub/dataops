import { escapeHtml } from "../../core/html.js";
import {
  berlinToday,
  formatDelta,
  formatNumber,
  html,
  marketingTabsMarkup,
} from "./shared.js";

const BUCKET_META = [
  { key: "added_follow", label: "Added (follow)", tone: "dk-badge--success" },
  { key: "added_qualified", label: "Added (qualified)", tone: "dk-badge--info" },
  { key: "absent", label: "Absent", tone: "dk-badge--warning" },
  { key: "unavailable", label: "Unavailable", tone: "dk-badge--danger" },
  { key: "unchecked", label: "Unchecked", tone: "" },
];

const OUTREACH_STATES = [
  "not_contacted",
  "no_contact",
  "draft_provided",
  "publisher_contacted",
  "alexey_sent",
  "orin_sent",
  "added_confirmed",
  "already_present",
  "reciprocal_link",
];

function renderAuthoritySeriesCell(series) {
  if (!series || !series.latest) {
    return html`<span class="dk-badge">Unavailable</span>`;
  }
  const snap = series.latest;
  const observed = snap.observedAt ? String(snap.observedAt).slice(0, 10) : snap.period;
  const versionLabel = snap.metricVersion ? ` · ${snap.metricVersion}` : " · version unexposed";
  const deltaPart =
    series.delta !== null && series.delta !== undefined
      ? html` <span class="mkt-muted">(${escapeHtml(formatDelta(series.delta, snap.unit))})</span>`
      : "";
  const evidencePart = snap.evidenceUrl
    ? html` · <a class="mkt-link" href="${escapeHtml(snap.evidenceUrl)}" target="_blank" rel="noopener noreferrer">evidence</a>`
    : "";
  const detailsText =
    snap.details && typeof snap.details === "object"
      ? Object.entries(snap.details)
          .filter(([, v]) => v !== null && v !== undefined && v !== "")
          .map(([k, v]) => `${k}: ${v}`)
          .join(", ")
      : "";
  return html`<div>
    <strong>${escapeHtml(formatNumber(snap.value, snap.unit))}${snap.unit === "score" ? "/100" : ""}</strong>${deltaPart}
    <div class="mkt-muted">${escapeHtml(snap.source)}${escapeHtml(versionLabel)} · ${escapeHtml(observed)}${evidencePart}</div>
    ${detailsText ? html`<div class="mkt-muted">${escapeHtml(detailsText)}</div>` : ""}
  </div>`;
}

function renderSiteRows(sites, ahrefsConfigured) {
  return (sites || [])
    .map((site) => {
      const authority = Array.isArray(site.authority) ? site.authority : [];
      const drSeries = authority.filter((s) => s.metricKey === "domain_rating");
      const otherSeries = authority.filter((s) => s.metricKey !== "domain_rating");
      const drHtml = drSeries.length
        ? drSeries.map(renderAuthoritySeriesCell).join("")
        : html`<span class="dk-badge">Unavailable</span> <span class="mkt-muted">No DR snapshot yet</span>`;
      const otherHtml = otherSeries.length
        ? otherSeries
            .map(
              (s) => html`<div class="mkt-muted">
                <strong>${escapeHtml(s.metricKey)}</strong> (${escapeHtml(s.provider || s.source)}):
                ${escapeHtml(formatNumber(s.latest?.value, s.unit))}
                <span class="mkt-nowrap">(${escapeHtml(s.latest?.period || "–")})</span>
              </div>`,
            )
            .join("")
        : html`<span class="mkt-muted">–</span>`;
      const refreshBtn = ahrefsConfigured
        ? html`<button type="button" class="dk-button dk-button--secondary dk-button--sm"
            data-mkt-refresh-dr="${escapeHtml(site.domain)}">Refresh DR</button>`
        : html`<span class="mkt-muted">Manual evidence</span>`;
      return html`<tr>
        <td>
          <strong>${escapeHtml(site.domain)}</strong>
          ${site.label ? html`<div class="mkt-muted">${escapeHtml(site.label)}</div>` : ""}
        </td>
        <td>${drHtml}</td>
        <td>${otherHtml}</td>
        <td class="mkt-nowrap">
          ${refreshBtn}
          <button type="button" class="dk-button dk-button--secondary dk-button--sm"
            data-mkt-remove-site="${escapeHtml(site.domain)}"
            data-mkt-version="${escapeHtml(String(site.version || 1))}">Remove</button>
        </td>
      </tr>`;
    })
    .join("");
}

function renderBacklinkGroup(meta, items) {
  if (!items.length) return "";
  const rows = items
    .map((pair) => {
      const check = pair.latestCheck;
      const checkedAt = check?.checkedAt ? String(check.checkedAt).replace("T", " ").slice(0, 16) + "Z" : "Never";
      const relLabel = check?.matchedRel?.length ? check.matchedRel.join(", ") : "–";
      const hrefCell = check?.matchedHref
        ? html`<a class="mkt-link" href="${escapeHtml(check.matchedHref)}" target="_blank" rel="noopener noreferrer">${escapeHtml(check.matchedHref)}</a>`
        : html`<span class="mkt-muted">–</span>`;
      const ownerLabel = pair.owner ? ` (${pair.owner})` : "";
      return html`<tr>
        <td><a class="mkt-link" href="${escapeHtml(pair.sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(pair.sourceUrl)}</a></td>
        <td><a class="mkt-link" href="${escapeHtml(pair.targetUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(pair.targetUrl)}</a></td>
        <td class="mkt-nowrap"><span class="dk-badge">${escapeHtml(pair.outreachState)}${escapeHtml(ownerLabel)}</span></td>
        <td>${hrefCell}<div class="mkt-muted">rel: ${escapeHtml(relLabel)}</div></td>
        <td>
          <div class="mkt-nowrap">${escapeHtml(checkedAt)}${check?.httpStatus ? ` · HTTP ${check.httpStatus}` : ""}</div>
          <div class="mkt-muted">${escapeHtml(check?.reason || "Not checked yet")}</div>
        </td>
        <td class="mkt-nowrap">
          <button type="button" class="dk-button dk-button--secondary dk-button--sm"
            data-mkt-check-backlink="${escapeHtml(pair.id)}">Check</button>
          <button type="button" class="dk-button dk-button--secondary dk-button--sm"
            data-mkt-remove-backlink="${escapeHtml(pair.id)}"
            data-mkt-version="${escapeHtml(String(pair.version || 1))}">Remove</button>
        </td>
      </tr>`;
    })
    .join("");

  return html`<section class="mkt-section">
    <h3 class="mkt-section__title">
      <span class="dk-badge ${meta.tone}">${escapeHtml(meta.label)}</span>
      <span class="mkt-muted">(${items.length})</span>
    </h3>
    <div class="mkt-table-wrap"><table class="dk-table mkt-table">
      <thead>
        <tr>
          <th scope="col">Source page</th>
          <th scope="col">Expected target</th>
          <th scope="col">Outreach state</th>
          <th scope="col">Actual href / rel</th>
          <th scope="col">Last check</th>
          <th scope="col">Actions</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table></div>
  </section>`;
}

export function metricsSurfaceMarkup(
  sitesPayload = { items: [], ahrefsConfigured: false },
  backlinksPayload = { items: [], summary: {}, groups: {} },
  statusMessage = "",
  loadError = "",
  today = berlinToday(),
) {
  const sites = Array.isArray(sitesPayload?.items) ? sitesPayload.items : [];
  const ahrefsConfigured = Boolean(sitesPayload?.ahrefsConfigured);
  const summary = backlinksPayload?.summary || {};
  const groups = backlinksPayload?.groups || {};

  const summaryChips = BUCKET_META.map(
    (meta) =>
      html`<span class="dk-badge ${meta.tone}">${escapeHtml(meta.label)}: ${escapeHtml(String(summary[meta.key] || 0))}</span>`,
  ).join(" ");

  const groupedSections = BUCKET_META.map((meta) =>
    renderBacklinkGroup(meta, Array.isArray(groups[meta.key]) ? groups[meta.key] : []),
  ).join("");

  const stateOptions = OUTREACH_STATES.map(
    (state) => html`<option value="${escapeHtml(state)}">${escapeHtml(state)}</option>`,
  ).join("");

  return html`<header class="dk-page-header">
      <div class="dk-page-header__main">
        <h1 class="dk-page-header__title">Marketing</h1>
        ${marketingTabsMarkup("metrics")}
      </div>
      <div class="dk-page-header__actions">
        <button type="button" class="dk-button dk-button--secondary dk-button--sm" data-mkt-open-add-site>+ Add site</button>
        <button type="button" class="dk-button dk-button--secondary dk-button--sm" data-mkt-open-record-authority>+ Record authority</button>
        <button type="button" class="dk-button dk-button--secondary dk-button--sm" data-mkt-open-add-backlink>+ Add link pair</button>
        <button type="button" class="dk-button dk-button--primary dk-button--sm" data-mkt-run-backlink-audit>Run link audit</button>
      </div>
    </header>
    ${loadError
      ? html`<div class="dk-callout dk-callout--warning" role="status">
          ${escapeHtml(loadError)}
          <button type="button" class="dk-button dk-button--secondary dk-button--sm" data-mkt-retry>Retry</button>
        </div>`
      : ""}
    ${statusMessage
      ? html`<div class="dk-callout dk-callout--info" role="status">${escapeHtml(statusMessage)}</div>`
      : ""}

    <section class="mkt-section">
      <h2 class="mkt-section__title">Tracked Websites &amp; Site Authority</h2>
      <p class="mkt-muted">
        Ahrefs Domain Rating is scoped by exact site and DR version and kept separate from Moz DA
        and SE Ranking DA. Unavailable sources are never recorded as zero.
      </p>
      ${sites.length
        ? html`<div class="mkt-table-wrap"><table class="dk-table mkt-table">
            <thead>
              <tr>
                <th scope="col">Site</th>
                <th scope="col">Ahrefs Domain Rating</th>
                <th scope="col">Other authority metrics</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>${renderSiteRows(sites, ahrefsConfigured)}</tbody>
          </table></div>`
        : html`<div class="mkt-empty">
            <p>No tracked websites yet.</p>
            <p class="mkt-muted">Add a first-party domain (for example, datatalks.club) to track site authority snapshots.</p>
          </div>`}
    </section>

    <section class="mkt-section">
      <h2 class="mkt-section__title">Backlink Audit</h2>
      <div class="mkt-goal-chips">${summaryChips}</div>
      ${groupedSections ||
        html`<div class="mkt-empty">
          <p>No backlink source→target pairs registered yet.</p>
          <p class="mkt-muted">Add a pair or import the audit seed via the CLI to run bounded public HTTP(S) checks.</p>
        </div>`}
    </section>

    <dialog class="dk-dialog" data-mkt-add-site-dialog>
      <form class="mkt-form" data-mkt-add-site-form>
        <h2>Add tracked website</h2>
        <label class="mkt-field">Domain <input class="dk-input" name="domain" required placeholder="datatalks.club"></label>
        <label class="mkt-field">Label <input class="dk-input" name="label" placeholder="DataTalks.Club main site"></label>
        <label class="mkt-field">Notes <textarea class="dk-input" name="notes" rows="2"></textarea></label>
        <div class="mkt-form__actions">
          <button type="button" class="dk-button dk-button--secondary" data-mkt-close-dialog>Cancel</button>
          <button type="submit" class="dk-button dk-button--primary">Add site</button>
        </div>
      </form>
    </dialog>

    <dialog class="dk-dialog" data-mkt-record-authority-dialog>
      <form class="mkt-form" data-mkt-record-authority-form>
        <h2>Record verified authority snapshot</h2>
        <label class="mkt-field">Domain <input class="dk-input" name="domain" required placeholder="datatalks.club"></label>
        <label class="mkt-field">Metric
          <select class="dk-input" name="metricKey">
            <option value="domain_rating">domain_rating (Ahrefs DR)</option>
            <option value="referring_domains">referring_domains</option>
            <option value="moz_da">moz_da (Moz DA)</option>
            <option value="seranking_da">seranking_da (SE Ranking DA)</option>
          </select>
        </label>
        <label class="mkt-field">Source
          <select class="dk-input" name="source">
            <option value="ahrefs-free">ahrefs-free</option>
            <option value="manual">manual</option>
            <option value="treg-seranking">treg-seranking</option>
            <option value="treg-moz">treg-moz</option>
          </select>
        </label>
        <label class="mkt-field">Measurement date <input class="dk-input" type="date" name="period" required value="${escapeHtml(today)}"></label>
        <label class="mkt-field">Value <input class="dk-input" type="number" step="any" min="0" name="value" required></label>
        <label class="mkt-field">DR / Metric version <input class="dk-input" name="metricVersion" placeholder="unexposed or v3"></label>
        <label class="mkt-field">Evidence URL
          <input class="dk-input" type="url" name="evidenceUrl"
            placeholder="https://ahrefs.com/website-authority-checker/?input=datatalks.club">
        </label>
        <label class="mkt-field">Note <textarea class="dk-input" name="note" rows="2"></textarea></label>
        <div class="mkt-form__actions">
          <button type="button" class="dk-button dk-button--secondary" data-mkt-close-dialog>Cancel</button>
          <button type="submit" class="dk-button dk-button--primary">Save snapshot</button>
        </div>
      </form>
    </dialog>

    <dialog class="dk-dialog" data-mkt-add-backlink-dialog>
      <form class="mkt-form" data-mkt-add-backlink-form>
        <h2>Add backlink source→target pair</h2>
        <label class="mkt-field">Source page URL <input class="dk-input" type="url" name="sourceUrl" required placeholder="https://partner.example/article"></label>
        <label class="mkt-field">Expected target URL <input class="dk-input" type="url" name="targetUrl" required placeholder="https://datatalks.club/"></label>
        <label class="mkt-field">Outreach state
          <select class="dk-input" name="outreachState">${stateOptions}</select>
        </label>
        <label class="mkt-field">Owner <input class="dk-input" name="owner" placeholder="alexey or orin"></label>
        <label class="mkt-field">Notes <textarea class="dk-input" name="notes" rows="2"></textarea></label>
        <div class="mkt-form__actions">
          <button type="button" class="dk-button dk-button--secondary" data-mkt-close-dialog>Cancel</button>
          <button type="submit" class="dk-button dk-button--primary">Add pair</button>
        </div>
      </form>
    </dialog>`;
}
