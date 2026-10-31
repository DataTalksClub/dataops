// Finance overview: money in, money out and net per month, year or YTD,
// with the two numbers that matter on top (net profit excluding VAT and the
// projected VAT position). Every figure comes from GET /api/finance/summary,
// the same payload `dataops finance summary --json` prints, so the portal and
// the CLI cannot disagree. Pure markup helpers are exported for tests.
import { html } from "./shared.js";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const YEAR = /^\d{4}$/;

export function periodFromParams(params, today) {
  if (MONTH.test(params.get("month") || "")) return { month: params.get("month") };
  if (YEAR.test(params.get("year") || "")) return { year: params.get("year") };
  if (params.get("ytd")) return { ytd: "1" };
  return { ytd: "1", implicit: true, today };
}

export function formatEur(value, { sign = false } = {}) {
  if (value === null || value === undefined) return "–";
  const rounded = Math.round(Number(value) * 100) / 100 || 0;
  const text = Math.abs(rounded).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (rounded < 0) return `−${text}`;
  return sign && rounded > 0 ? `+${text}` : text;
}

const shortMonth = (month) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleString("en-US", { month: "short", timeZone: "UTC" });

const headRow = (labels) => html`<thead><tr>${labels.map((label) => html`<th scope="col">${label}</th>`).join("")}</tr></thead>`;

const vatWord = (value) => (value > 0 ? "owed to the Finanzamt" : value < 0 ? "refund from the Finanzamt" : "nothing owed");

export function headlineMarkup(summary, e) {
  const t = summary.totals;
  const settled = t.vatPaid - t.vatRefunded;
  const vatNote = t.vatUnknownCount
    ? html`<p class="fin-tile__warn" role="note"><span aria-hidden="true">!</span>
        ${e(String(t.vatUnknownCount))} operating ${t.vatUnknownCount === 1 ? "row has" : "rows have"} no VAT amount; counted as zero</p>`
    : "";
  return html`<div class="fin-hero">
      <section class="fin-tile fin-tile--hero" aria-labelledby="fin-profit-label">
        <h2 id="fin-profit-label" class="fin-tile__label">Net profit excluding VAT</h2>
        <p class="fin-tile__value" data-fin-profit>${formatEur(t.netProfitExVat)} <span class="fin-tile__unit">EUR</span></p>
        <p class="fin-tile__sub">Income net of VAT ${formatEur(t.incomeNetOfVat)} − expenses net of VAT ${formatEur(t.expensesNetOfVat)}</p>
        <p class="fin-tile__sub">After taxes ${formatEur(t.otherTaxes)} and TK ${formatEur(t.healthInsurance)}: <strong>${formatEur(t.netAfterTaxes)}</strong></p>
      </section>
      <section class="fin-tile fin-tile--hero" aria-labelledby="fin-vat-label">
        <h2 id="fin-vat-label" class="fin-tile__label">Projected VAT position</h2>
        <p class="fin-tile__value" data-fin-vat>${formatEur(t.projectedVat)} <span class="fin-tile__unit">EUR</span></p>
        <p class="fin-tile__sub">${vatWord(t.projectedVat)} · output VAT ${formatEur(t.outputVat)} − input VAT ${formatEur(t.inputVat)}</p>
        <p class="fin-tile__sub">Actually ${settled < 0 ? "refunded" : "paid"} in this period: <strong>${formatEur(Math.abs(settled))}</strong></p>
        ${vatNote}
      </section>
    </div>
    <dl class="fin-stats">
      <div><dt>Money in</dt><dd>${formatEur(t.moneyIn)}</dd></div>
      <div><dt>Money out</dt><dd>${formatEur(t.moneyOut)}</dd></div>
      <div><dt>Net (cash)</dt><dd>${formatEur(t.net, { sign: true })}</dd></div>
      <div><dt>Other taxes</dt><dd>${formatEur(t.otherTaxes)}</dd></div>
      <div><dt>Health insurance (TK)</dt><dd>${formatEur(t.healthInsurance)}</dd></div>
    </dl>`;
}

// Bar path with a 4px rounded data end and a flat end on the baseline.
function bar(x, width, base, end) {
  const r = Math.min(4, width / 2, Math.abs(end - base));
  if (Math.abs(end - base) < 0.5) return "";
  const up = end < base;
  const tip = up ? end + r : end - r;
  const sweepY = up ? end : end;
  return up
    ? `M${x},${base}V${tip}Q${x},${sweepY} ${x + r},${sweepY}H${x + width - r}Q${x + width},${sweepY} ${x + width},${tip}V${base}Z`
    : `M${x},${base}V${tip}Q${x},${sweepY} ${x + r},${sweepY}H${x + width - r}Q${x + width},${sweepY} ${x + width},${tip}V${base}Z`;
}

function niceMax(value) {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) if (step * power >= value) return step * power;
  return 10 * power;
}

const compact = (value) =>
  Math.abs(value) >= 1000 ? `${Math.round(value / 100) / 10}k` : String(Math.round(value));

/**
 * One axis in EUR: money in rises above the baseline, money out hangs below
 * it, and a dot marks the month's net. Position carries direction, so the two
 * fills need no status colours.
 */
export function cashChartMarkup(months, e) {
  const W = 720, H = 260, left = 48, right = 12, top = 16, bottom = 28;
  const plotW = W - left - right, plotH = H - top - bottom;
  const max = niceMax(Math.max(...months.map((m) => Math.max(m.moneyIn, m.moneyOut)), 1));
  const y = (v) => top + plotH / 2 - (v / max) * (plotH / 2);
  const slot = plotW / months.length;
  const barW = Math.max(6, Math.min(28, slot * 0.5));
  const ticks = [max, max / 2, 0, -max / 2, -max];
  const grid = ticks.map((v) => html`<line class="fin-chart__grid${v === 0 ? " fin-chart__base" : ""}" x1="${left}" x2="${W - right}" y1="${y(v)}" y2="${y(v)}"/>
      <text class="fin-chart__tick" x="${left - 6}" y="${y(v) + 4}" text-anchor="end">${v < 0 ? "−" : ""}${compact(Math.abs(v))}</text>`).join("");
  const marks = months.map((m, i) => {
    const cx = left + slot * i + slot / 2;
    const x = cx - barW / 2;
    const label = `${m.month}: in ${formatEur(m.moneyIn)}, out ${formatEur(m.moneyOut)}, net ${formatEur(m.net, { sign: true })} EUR`;
    return html`<g class="fin-chart__month${m.future ? " is-future" : ""}" data-fin-hover="${e(label)}">
        <rect class="fin-chart__hit" x="${left + slot * i}" y="${top}" width="${slot}" height="${plotH}"><title>${e(label)}</title></rect>
        <path class="fin-chart__in" d="${bar(x, barW, y(0) - 1, y(m.moneyIn))}"/>
        <path class="fin-chart__out" d="${bar(x, barW, y(0) + 1, y(-m.moneyOut))}"/>
        ${m.moneyIn || m.moneyOut ? html`<circle class="fin-chart__net" cx="${cx}" cy="${y(m.net)}" r="4.5"/>` : ""}
        <text class="fin-chart__tick" x="${cx}" y="${H - 8}" text-anchor="middle">${shortMonth(m.month)}</text>
      </g>`;
  }).join("");
  return html`<figure class="fin-chart">
      <figcaption class="fin-chart__caption">
        <span class="fin-chart__title">Money in and out per month (EUR)</span>
        <span class="fin-legend"><span class="fin-legend__swatch fin-legend__swatch--in"></span>Money in (above)</span>
        <span class="fin-legend"><span class="fin-legend__swatch fin-legend__swatch--out"></span>Money out (below)</span>
        <span class="fin-legend"><span class="fin-legend__dot"></span>Net</span>
      </figcaption>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Money in and out per month; the table below has the same numbers">${grid}${marks}</svg>
    </figure>`;
}

export function profitChartMarkup(months, e) {
  const W = 720, H = 180, left = 48, right = 12, top = 12, bottom = 28;
  const plotW = W - left - right, plotH = H - top - bottom;
  const values = months.map((m) => m.netProfitExVat);
  const hi = Math.max(0, ...values), lo = Math.min(0, ...values);
  const span = niceMax(Math.max(hi, -lo, 1));
  const top0 = hi > 0 ? span : 0, bot0 = lo < 0 ? -span : 0;
  const range = top0 - bot0 || 1;
  const y = (v) => top + ((top0 - v) / range) * plotH;
  const slot = plotW / months.length;
  const barW = Math.max(6, Math.min(28, slot * 0.5));
  const ticks = [...new Set([top0, 0, bot0])];
  const grid = ticks.map((v) => html`<line class="fin-chart__grid${v === 0 ? " fin-chart__base" : ""}" x1="${left}" x2="${W - right}" y1="${y(v)}" y2="${y(v)}"/>
      <text class="fin-chart__tick" x="${left - 6}" y="${y(v) + 4}" text-anchor="end">${v < 0 ? "−" : ""}${compact(Math.abs(v))}</text>`).join("");
  const marks = months.map((m, i) => {
    const cx = left + slot * i + slot / 2;
    const label = `${m.month}: net profit excluding VAT ${formatEur(m.netProfitExVat, { sign: true })} EUR`;
    return html`<g class="fin-chart__month${m.future ? " is-future" : ""}" data-fin-hover="${e(label)}">
        <rect class="fin-chart__hit" x="${left + slot * i}" y="${top}" width="${slot}" height="${plotH}"><title>${e(label)}</title></rect>
        <path class="${m.netProfitExVat < 0 ? "fin-chart__loss" : "fin-chart__in"}" d="${bar(cx - barW / 2, barW, y(0), y(m.netProfitExVat))}"/>
        <text class="fin-chart__tick" x="${cx}" y="${H - 8}" text-anchor="middle">${shortMonth(m.month)}</text>
      </g>`;
  }).join("");
  return html`<figure class="fin-chart">
      <figcaption class="fin-chart__caption"><span class="fin-chart__title">Net profit excluding VAT per month (EUR)</span></figcaption>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Net profit excluding VAT per month; the table below has the same numbers">${grid}${marks}</svg>
    </figure>`;
}

export function monthTableMarkup(summary, e) {
  const rows = summary.months.length > 1 ? [...summary.months, { month: "Total", ...summary.totals, total: true }] : summary.months;
  const cell = (v, opts) => html`<td class="fin-num">${formatEur(v, opts)}</td>`;
  return html`<div class="fin-table-wrap"><table class="fin-table">
      <caption class="fin-sr">Per month, EUR</caption>
      <thead><tr><th scope="col">Month</th><th scope="col">Money in</th><th scope="col">Money out</th><th scope="col">Net</th>
        <th scope="col">Income net of VAT</th><th scope="col">Expenses net of VAT</th><th scope="col">Profit ex VAT</th>
        <th scope="col">Other taxes</th><th scope="col">TK</th><th scope="col">VAT position</th><th scope="col">VAT paid</th><th scope="col">Rows</th></tr></thead>
      <tbody>${rows.map((r) => html`<tr class="${r.total ? "fin-table__total" : r.future ? "is-future" : ""}">
        <th scope="row">${e(r.month)}${r.future ? " <small>(not over)</small>" : ""}</th>
        ${cell(r.moneyIn)}${cell(r.moneyOut)}${cell(r.net, { sign: true })}${cell(r.incomeNetOfVat)}${cell(r.expensesNetOfVat)}
        ${cell(r.netProfitExVat, { sign: true })}${cell(r.otherTaxes)}${cell(r.healthInsurance)}${cell(r.projectedVat)}${cell(r.vatPaid - r.vatRefunded)}
        <td class="fin-num">${e(String(r.entryCount))}</td></tr>`).join("")}</tbody>
    </table></div>`;
}

export function currencyMarkup(summary, e) {
  if (!summary.byCurrency.length) return "";
  const source = { booked: "Booked by the bank", ecb: "ECB reference rate", eur: "EUR" };
  const conversions = summary.conversions.length
    ? html`<table class="fin-table">
        <caption class="fin-table__caption">Conversions to EUR</caption>
        ${headRow(["Paid", "Counterparty", "Original", "EUR", "Rate (per EUR)", "Rate date", "Source"])}
        <tbody>${summary.conversions.map((c) => {
          const entry = summary.entries.find((x) => x.id === c.id) || {};
          return html`<tr><td>${e(c.date)}</td><td>${e(entry.counterparty || "")}</td><td class="fin-num">${e(formatEur(c.amount))} ${e(c.currency)}</td>
            <td class="fin-num">${c.eur === null ? "<em>not converted</em>" : formatEur(c.eur)}</td><td class="fin-num">${e(c.rate ? String(c.rate) : "–")}</td>
            <td>${e(c.rateDate || "–")}</td><td>${e(source[c.rateSource] || "No rate")}</td></tr>`;
        }).join("")}</tbody></table>`
    : "";
  return html`<section class="fin-block" aria-labelledby="fin-currency-heading">
      <h2 id="fin-currency-heading" class="fin-block__title">Currencies</h2>
      <table class="fin-table">
        ${headRow(["Currency", "In (original)", "In (EUR)", "Out (original)", "Out (EUR)"])}
        <tbody>${summary.byCurrency.map((c) => html`<tr><th scope="row">${e(c.currency)}</th>
          ${[c.moneyIn, c.moneyInEur, c.moneyOut, c.moneyOutEur].map((v) => html`<td class="fin-num">${formatEur(v)}</td>`).join("")}</tr>`).join("")}</tbody>
      </table>
      ${conversions}
    </section>`;
}

export function gapsMarkup(summary, e) {
  const notes = [
    ...summary.gaps.map((g) => `${g.month ? `${g.month}: ` : ""}${g.message} (${g.count})`),
    ...(summary.duplicates.length ? [`Bookkeeping-sheet rows dropped as duplicates of invoice or receipt rows (${summary.duplicates.length})`] : []),
    ...(summary.rateErrors || []).map((message) => `Exchange-rate lookup failed: ${message}`),
  ];
  return html`<section class="fin-block" aria-labelledby="fin-gaps-heading">
      <h2 id="fin-gaps-heading" class="fin-block__title">Data gaps ${notes.length ? html`<span class="fin-count">${notes.length}</span>` : ""}</h2>
      ${notes.length ? html`<ul class="fin-gaps">${notes.map((n) => html`<li>${e(n)}</li>`).join("")}</ul>` : html`<p class="fin-muted">None found for this period.</p>`}
      <details class="fin-rules"><summary>How these numbers are made</summary>
        <ol>${summary.rules.map((rule) => html`<li>${e(rule)}</li>`).join("")}</ol>
      </details>
    </section>`;
}

function periodControlsMarkup(period, today, e) {
  const year = period.year || (period.month || today).slice(0, 4);
  const month = period.month || today.slice(0, 7);
  const years = [];
  for (let y = Number(today.slice(0, 4)); y >= 2024; y -= 1) years.push(String(y));
  const pressed = (kind) => (kind in period && !period.implicit) || (kind === "ytd" && period.implicit) ? "true" : "false";
  return html`<div class="fin-period" role="group" aria-label="Period">
      <button type="button" class="dk-button dk-button--secondary dk-button--sm" data-fin-period="ytd" aria-pressed="${pressed("ytd")}">Year to date</button>
      <label class="fin-period__field"><span>Year</span>
        <select class="dk-select" data-fin-year aria-pressed="${pressed("year")}">
          ${years.map((y) => html`<option value="${y}"${y === year ? " selected" : ""}>${y}</option>`).join("")}
        </select></label>
      <label class="fin-period__field"><span>Month</span>
        <input class="dk-input" type="month" data-fin-month value="${e(month)}" aria-pressed="${pressed("month")}" /></label>
    </div>`;
}

const cliFlag = (period) =>
  period.kind === "month" ? `--month ${period.label}` : period.kind === "year" ? `--year ${period.label}` : "--ytd";

export function overviewMarkup(summary, e) {
  const multi = summary.months.length > 1;
  return html`${headlineMarkup(summary, e)}
    ${multi ? cashChartMarkup(summary.months, e) + profitChartMarkup(summary.months, e) : ""}
    <section class="fin-block" aria-labelledby="fin-months-heading">
      <h2 id="fin-months-heading" class="fin-block__title">${multi ? "By month" : "This month"}</h2>
      ${monthTableMarkup(summary, e)}
    </section>
    ${currencyMarkup(summary, e)}
    ${gapsMarkup(summary, e)}
    <p class="fin-muted">Same numbers on the command line: <code>dataops finance summary ${e(cliFlag(summary.period))}</code></p>`;
}

export function createFinanceOverviewSurface(context) {
  const { documentList, escapeHtml, request, setRouteTitle, todayIsoDate, workApiUrl } = context;
  const locationRef = context.locationRef || globalThis.location;
  const historyRef = context.historyRef || globalThis.history;
  let generation = 0;

  async function renderFinanceOverviewSurface() {
    const today = typeof todayIsoDate === "function" ? todayIsoDate() : new Date().toISOString().slice(0, 10);
    let period = periodFromParams(new URLSearchParams(locationRef?.search || ""), today);
    documentList.replaceChildren();
    const surface = document.createElement("section");
    surface.className = "finance-overview-surface";
    documentList.append(surface);
    setRouteTitle("Finance overview");
    surface.innerHTML = html`<header class="dk-page-header">
        <div class="dk-page-header__main"><h1 class="dk-page-header__title">Finance overview</h1></div>
        <div data-fin-controls>${periodControlsMarkup(period, today, escapeHtml)}</div>
      </header>
      <p class="fin-period-label" data-fin-label></p>
      <div class="fin-body" data-fin-body aria-live="polite"><p class="fin-muted">Loading…</p></div>
      <div class="fin-tooltip" data-fin-tooltip role="status" hidden></div>`;

    const body = surface.querySelector("[data-fin-body]");
    const tooltip = surface.querySelector("[data-fin-tooltip]");

    async function load() {
      const mine = ++generation;
      const query = new URLSearchParams(Object.entries(period).filter(([key]) => ["month", "year", "ytd"].includes(key)));
      body.setAttribute("aria-busy", "true");
      try {
        const summary = await request(workApiUrl(`/api/finance/summary?${query}`));
        if (mine !== generation) return;
        surface.querySelector("[data-fin-label]").textContent = `${summary.period.label} · ${summary.period.from} to ${summary.period.to} · EUR`;
        body.innerHTML = overviewMarkup(summary, escapeHtml);
      } catch (error) {
        if (mine !== generation) return;
        body.innerHTML = html`<p class="fin-error" role="alert">Could not load the finance summary: ${escapeHtml(error?.message || "request failed")}</p>
          <button type="button" class="dk-button dk-button--secondary" data-fin-retry>Retry</button>`;
      } finally {
        if (mine === generation) body.removeAttribute("aria-busy");
      }
    }

    function choose(next) {
      period = next;
      const params = new URLSearchParams(Object.entries(next).filter(([key]) => ["month", "year", "ytd"].includes(key)));
      historyRef?.pushState?.({}, "", `${locationRef?.pathname || "/finance"}?${params}`);
      surface.querySelector("[data-fin-controls]").innerHTML = periodControlsMarkup(period, today, escapeHtml);
      load();
    }

    surface.addEventListener("click", (event) => {
      if (event.target.closest("[data-fin-period='ytd']")) choose({ ytd: "1" });
      if (event.target.closest("[data-fin-retry]")) load();
    });
    surface.addEventListener("change", (event) => {
      if (event.target.matches("[data-fin-year]")) choose({ year: event.target.value });
      if (event.target.matches("[data-fin-month]") && MONTH.test(event.target.value)) choose({ month: event.target.value });
    });
    surface.addEventListener("pointerover", (event) => {
      const mark = event.target.closest?.("[data-fin-hover]");
      if (!mark) return;
      tooltip.textContent = mark.getAttribute("data-fin-hover");
      tooltip.hidden = false;
    });
    surface.addEventListener("pointermove", (event) => {
      if (tooltip.hidden) return;
      const box = surface.getBoundingClientRect();
      tooltip.style.left = `${Math.min(event.clientX - box.left + 12, box.width - 240)}px`;
      tooltip.style.top = `${event.clientY - box.top + 12}px`;
    });
    surface.addEventListener("pointerout", (event) => {
      if (event.target.closest?.("[data-fin-hover]") && !event.relatedTarget?.closest?.("[data-fin-hover]")) tooltip.hidden = true;
    });

    await load();
  }

  return { renderFinanceOverviewSurface };
}
