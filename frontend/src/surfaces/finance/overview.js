// Finance overview: an annual report of money in, money out and net, with the
// two numbers that matter on top (net profit excluding VAT and the projected
// VAT position). Every figure comes from GET /api/finance/summary,
// the same payload `dataops finance summary --json` prints, so the portal and
// the CLI cannot disagree; the tax estimate comes from
// GET /api/finance/tax-estimate?year=YYYY. Pure markup helpers are exported
// for tests.
import { html } from "./shared.js";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const YEAR = /^\d{4}$/;

export function bookkeepingMonthUrl(month) {
  if (!MONTH.test(month)) return "";
  return `/bookkeeping?${new URLSearchParams({ month })}`;
}

export function periodFromParams(params, today) {
  const year = params.get("year") || "";
  return { year: YEAR.test(year) ? year : today.slice(0, 4) };
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

function berlinToday() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

const headRow = (labels) => html`<thead><tr>${labels.map((label) => html`<th scope="col">${label}</th>`).join("")}</tr></thead>`;

const vatWord = (value) => (value > 0 ? "owed to the Finanzamt" : value < 0 ? "refund from the Finanzamt" : "nothing owed");

export function headlineMarkup(summary, e) {
  const t = summary.totals;
  const settled = t.vatPaid - t.vatRefunded;
  return html`<div class="fin-hero">
      <section class="fin-tile fin-tile--hero" aria-labelledby="fin-profit-label">
        <h2 id="fin-profit-label" class="fin-tile__label">Net profit excluding VAT</h2>
        <p class="fin-tile__value" data-fin-profit>${formatEur(t.netProfitExVat)} <span class="fin-tile__unit">EUR</span></p>
        <p class="fin-tile__sub">Income net of VAT ${formatEur(t.incomeNetOfVat)}
          − expenses net of VAT ${formatEur(t.expensesNetOfVat)}</p>
        <p class="fin-tile__sub">After taxes and TK paid ${formatEur(t.taxesTotal)}: <strong>${formatEur(t.netAfterTaxes)}</strong></p>
      </section>
      <section class="fin-tile fin-tile--hero" aria-labelledby="fin-vat-label">
        <h2 id="fin-vat-label" class="fin-tile__label">Projected VAT position</h2>
        <p class="fin-tile__value" data-fin-vat>${formatEur(t.projectedVat)} <span class="fin-tile__unit">EUR</span></p>
        <p class="fin-tile__sub">${vatWord(t.projectedVat)} · output VAT ${formatEur(t.outputVat)} − input VAT ${formatEur(t.inputVat)}</p>
        <p class="fin-tile__sub">Actually ${settled < 0 ? "refunded" : "paid"} in this period: <strong>${formatEur(Math.abs(settled))}</strong></p>
      </section>
    </div>
    <dl class="fin-stats">
      <div><dt>Money in</dt><dd>${formatEur(t.moneyIn)}</dd></div>
      <div><dt>Money out</dt><dd>${formatEur(t.moneyOut)}</dd></div>
      <div><dt>Net (cash)</dt><dd>${formatEur(t.net, { sign: true })}</dd></div>
      <div><dt>Taxes and TK paid</dt><dd data-fin-taxes-total>${formatEur(t.taxesTotal)}</dd></div>
      <div><dt>Owner pay (below net profit)</dt><dd data-fin-owner-pay>${formatEur(t.ownerPay)}</dd></div>
      <div><dt>Net after owner pay</dt><dd>${formatEur(t.netAfterOwnerPay, { sign: true })}</dd></div>
    </dl>`;
}

/**
 * Taxes paid this year by type and together. Only payments count: a refund
 * is never a negative tax, so it is listed on its own below.
 */
export function taxesMarkup(summary, e) {
  const t = summary.totals;
  const lines = [
    ["Einkommensteuer + Soli", t.incomeTax, "income-tax"],
    ["Gewerbesteuer", t.tradeTax, "trade-tax"],
    ["TK health insurance", t.healthInsurance, "health-insurance"],
    ...(t.otherTaxes ? [["Other taxes", t.otherTaxes, "other"]] : []),
  ];
  return html`<section class="fin-block" aria-labelledby="fin-taxes-heading">
      <h2 id="fin-taxes-heading" class="fin-block__title">Taxes paid in ${e(summary.period.label)}</h2>
      <dl class="fin-stats">
        ${lines.map(([label, value, key]) => html`<div><dt>${label}</dt><dd data-fin-tax="${key}">${formatEur(value)}</dd></div>`).join("")}
        <div class="fin-stats__total"><dt>Total taxes and TK</dt><dd data-fin-tax="total">${formatEur(t.taxesTotal)}</dd></div>
      </dl>
      ${refundsMarkup(summary, e)}
    </section>`;
}

/**
 * "Calculate tax" block for the selected year: the button starts a rough
 * ESt/Soli/GewSt estimate from the profit earned so far; the result (or the
 * retry error) replaces the body content.
 */
export function taxEstimateSectionMarkup(year, e) {
  return html`<section class="fin-block" aria-labelledby="fin-estimate-heading" data-fin-estimate>
      <h2 id="fin-estimate-heading" class="fin-block__title">Tax estimate <span class="fin-muted">rough, Berlin, from the profit earned so far in ${e(year)}</span></h2>
      <div data-fin-estimate-body>
        <button type="button" class="dk-button dk-button--secondary dk-button--sm" data-fin-tax-estimate>Calculate tax</button>
      </div>
    </section>`;
}

/**
 * The estimate itself: Einkommensteuer (§ 32a tariff after § 35 relief),
 * Solidaritätszuschlag and Gewerbesteuer separately and in total, the
 * comparison with the taxes already paid that year, and the inputs, formula
 * and statutory sources behind the numbers.
 */
export function taxEstimateMarkup(est, e) {
  const remainingWord = est.remaining >= 0
    ? html`an estimated <strong>${formatEur(est.remaining)}</strong> still to pay in ${e(String(est.year))}`
    : html`already <strong>${formatEur(-est.remaining)}</strong> more paid than this rough estimate`;
  return html`<div data-fin-estimate-result>
      <dl class="fin-stats">
        <div><dt>Profit earned so far (ex VAT)</dt><dd>${formatEur(est.profitEur)}</dd></div>
        <div><dt>Einkommensteuer <span class="fin-muted">after § 35 relief</span></dt><dd data-fin-est-income-tax>${formatEur(est.incomeTax.einkommensteuer)}</dd></div>
        <div><dt>Solidaritätszuschlag</dt><dd data-fin-est-soli>${formatEur(est.soli)}</dd></div>
        <div><dt>Gewerbesteuer <span class="fin-muted">Berlin Hebesatz 410 %</span></dt><dd data-fin-est-trade-tax>${formatEur(est.tradeTax.steuer)}</dd></div>
        <div class="fin-stats__total"><dt>Total tax estimate</dt><dd data-fin-est-total>${formatEur(est.totalEstimate)}</dd></div>
      </dl>
      <p class="fin-muted" data-fin-est-paid-line>Already paid in ${e(String(est.year))}:
        ESt + Soli ${formatEur(est.paid.incomeTax)}, GewSt ${formatEur(est.paid.tradeTax)}
        — total <strong>${formatEur(est.paidTotal)}</strong>. Compared with the estimate: ${remainingWord}.
        Refunds for earlier years never count as negative tax.</p>
      <details class="fin-estimate-details" data-fin-est-details>
        <summary>Inputs, formula and statutory sources</summary>
        <ul class="fin-gaps">${[...est.inputs, ...est.formula].map((line) => html`<li>${e(line)}</li>`).join("")}</ul>
        <ul class="fin-gaps">${est.sources.map((line) => html`<li><em>${e(line)}</em></li>`).join("")}</ul>
        <p class="fin-muted">${e(est.disclaimer)}</p>
      </details>
    </div>`;
}

/** Refunds stay visible as cash with their ledger rows; they are not tax, revenue or profit. */
export function refundsMarkup(summary, e) {
  const refunds = summary.taxRefunds || [];
  if (!refunds.length) return "";
  const t = summary.totals;
  return html`<div class="fin-refunds" data-fin-refunds>
      <h3 class="fin-block__subtitle">Tax refunds received: ${formatEur(t.taxRefunds)} EUR</h3>
      <p class="fin-muted">Counted in money in and net cash (${formatEur(t.moneyIn)} money in includes them).
        Not revenue (income net of VAT ${formatEur(t.incomeNetOfVat)} excludes them), not profit, and never a negative tax in any year:
        a refund settles an earlier assessed year.</p>
      <div class="fin-table-wrap"><table class="fin-table">
        ${headRow(["Bank date", "Amount", "From", "Booking text", "Ledger row"])}
        <tbody>${refunds.map((r) => html`<tr>
          <td>${MONTH.test(r.month) ? html`<a href="${e(bookkeepingMonthUrl(r.month))}">${e(r.date)}</a>` : e(r.date)}</td>
          <td class="fin-num">${formatEur(r.eur)}</td><td>${e(r.counterparty)}</td><td>${e(r.description)}</td>
          <td><code>${e(r.id)}</code></td></tr>`).join("")}</tbody>
      </table></div>
    </div>`;
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
  const ticks = [...new Set(Array.from({ length: 5 }, (_, index) => top0 - (range * index) / 4))];
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
  const rows = [...summary.months, { month: "Total", ...summary.totals, total: true }];
  const cell = (v, opts) => html`<td class="fin-num">${formatEur(v, opts)}</td>`;
  const otherTaxes = rows.some((r) => r.otherTaxes);
  return html`<div class="fin-table-wrap"><table class="fin-table">
      <caption class="fin-sr">Per month, EUR</caption>
      <thead><tr><th scope="col">Month</th><th scope="col">Money in</th><th scope="col">Money out</th><th scope="col">Net</th>
        <th scope="col">Income net of VAT</th><th scope="col">Expenses net of VAT</th><th scope="col">Profit ex VAT</th>
        <th scope="col">ESt + Soli</th><th scope="col">GewSt</th><th scope="col">TK</th>${otherTaxes ? html`<th scope="col">Other taxes</th>` : ""}
        <th scope="col">Taxes total</th><th scope="col">Tax refunds</th><th scope="col">Owner pay</th><th scope="col">Output VAT</th><th scope="col">Input VAT</th>
        <th scope="col">VAT paid</th><th scope="col">VAT refunded</th><th scope="col">VAT position</th><th scope="col">Rows</th></tr></thead>
      <tbody>${rows.map((r) => {
        const href = !r.total && MONTH.test(r.month) ? bookkeepingMonthUrl(r.month) : "";
        const month = href
          ? html`<a class="fin-table__month-link" data-fin-month-link href="${e(href)}">${e(r.month)}</a>`
          : e(r.month);
        return html`<tr class="${r.total ? "fin-table__total" : r.future ? "is-future" : ""}"${href ? " data-fin-bookkeeping-row" : ""}>
        <th scope="row">${month}${r.future ? " <small>(not over)</small>" : ""}</th>
        ${cell(r.moneyIn)}${cell(r.moneyOut)}${cell(r.net, { sign: true })}${cell(r.incomeNetOfVat)}${cell(r.expensesNetOfVat)}
        ${cell(r.netProfitExVat, { sign: true })}${cell(r.incomeTax)}${cell(r.tradeTax)}${cell(r.healthInsurance)}${otherTaxes ? cell(r.otherTaxes) : ""}
        ${cell(r.taxesTotal)}${cell(r.taxRefunds)}${cell(r.ownerPay)}${cell(r.outputVat)}${cell(r.inputVat)}
        ${cell(r.vatPaid)}${cell(r.vatRefunded)}${cell(r.projectedVat)}
        <td class="fin-num">${e(String(r.entryCount))}</td></tr>`;
      }).join("")}</tbody>
    </table></div>`;
}

export function activateFinanceMonthlyRow(event, selection = globalThis.getSelection?.()) {
  if (event.defaultPrevented) return false;
  const target = event.target;
  const row = target?.closest?.("tr[data-fin-bookkeeping-row]");
  const link = row?.querySelector?.("[data-fin-month-link]");
  if (!link) return false;

  if (event.detail > 0 && selection && !selection.isCollapsed && selection.toString()) {
    if (target.closest?.("[data-fin-month-link]")) event.preventDefault?.();
    return false;
  }
  if (target.closest?.("[data-fin-month-link],button,input,select,textarea,summary,[contenteditable='true'],[role='button']")) return false;
  if ((event.button !== undefined && event.button !== 0) || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  link.click();
  return true;
}

export function periodControlsMarkup(period, today, e) {
  const currentYear = today.slice(0, 4);
  const year = period.year || currentYear;
  const years = [];
  for (let y = Number(currentYear); y >= 2024; y -= 1) years.push(String(y));
  if (!years.includes(year)) years.push(year);
  years.sort((a, b) => Number(b) - Number(a));
  return html`<div class="fin-period" role="group" aria-label="Period">
      <button type="button" class="dk-button dk-button--secondary dk-button--sm" data-fin-period="current-year" aria-pressed="${String(year) === currentYear}">Current year</button>
      <label class="fin-period__field"><span>Year</span>
        <select class="dk-select" data-fin-year aria-label="Finance report year">
          ${years.map((y) => html`<option value="${y}"${y === year ? " selected" : ""}>${y}</option>`).join("")}
        </select></label>
    </div>`;
}

const TAX_TYPE = { "income-tax": "Income tax + Soli", "trade-tax": "Trade tax", vat: "VAT", "health-insurance": "Health insurance (TK)", other: "Other" };

/** Scheduled tax and TK auto-debits, the 30-day total and the balance check. */
export function upcomingMarkup(u, e) {
  const balance = u.balance
    ? html`${formatEur(u.balance.amount)} ${e(u.balance.currency)}
        <span class="fin-muted">(${e(u.balance.accountId)}, as of ${e(u.balance.asOf)}${u.balance.stale ? ", stale" : ""})</span>`
    : html`<span class="fin-muted">unknown</span>`;
  const status = (d) => (d.status === "paid" ? `Paid (${d.matched.kind} ${d.matched.date})` : d.status === "not-seen" ? "Not seen yet" : "Scheduled");
  return html`<section class="fin-block" aria-labelledby="fin-upcoming-heading">
      <h2 id="fin-upcoming-heading" class="fin-block__title">Upcoming tax debits <span class="fin-muted">next ${e(String(u.days))} days, auto-debited</span></h2>
      <dl class="fin-stats">
        <div><dt>Due in the next 30 days</dt><dd data-fin-due30>${formatEur(u.dueNext30)}</dd></div>
        <div><dt>Due in the next ${e(String(u.days))} days</dt><dd>${formatEur(u.dueInWindow)}</dd></div>
        <div><dt>Account balance</dt><dd>${balance}</dd></div>
      </dl>
      ${u.shortfall ? html`<p class="fin-error" role="alert">Shortfall: the balance does not cover the ${formatEur(u.dueNext30)} EUR due in the next 30 days.</p>` : ""}
      ${u.debits.length ? html`<div class="fin-table-wrap"><table class="fin-table">
        ${headRow(["Date", "Amount", "Tax type", "What", "Source", "Status"])}
        <tbody>${u.debits.map((d) => html`<tr class="${d.status === "paid" ? "is-future" : ""}">
          <td>${e(d.date)}${d.approximate ? " ~" : ""}${d.shifted ? html`<br><small class="fin-muted">${e(d.shifted)}</small>` : ""}</td>
          <td class="fin-num">${formatEur(d.amount)}</td><td>${e(TAX_TYPE[d.taxType] || d.taxType)}</td><td>${e(d.label)}</td>
          <td>${e(d.sourceRef ? `${d.source} ${d.sourceRef}` : d.source)}</td><td>${e(status(d))}</td></tr>`).join("")}</tbody>
      </table></div>` : html`<p class="fin-muted">No scheduled debits in this window.</p>`}
      ${u.warnings.length ? html`<ul class="fin-gaps">${u.warnings.map((w) => html`<li>${e(w)}</li>`).join("")}</ul>` : ""}
    </section>`;
}

const cliFlag = (period) => `--year ${period.label}`;

export function overviewMarkup(summary, e) {
  return html`${headlineMarkup(summary, e)}
    ${cashChartMarkup(summary.months, e) + profitChartMarkup(summary.months, e)}
    ${taxesMarkup(summary, e)}
    ${taxEstimateSectionMarkup(summary.period.label, e)}
    <section class="fin-block" aria-labelledby="fin-months-heading">
      <h2 id="fin-months-heading" class="fin-block__title">By month</h2>
      ${monthTableMarkup(summary, e)}
    </section>
    <p class="fin-muted">Same numbers on the command line: <code>dataops finance summary ${e(cliFlag(summary.period))}</code></p>`;
}

export function createFinanceOverviewSurface(context) {
  const { documentList, escapeHtml, request, setRouteTitle, todayIsoDate, workApiUrl } = context;
  const locationRef = context.locationRef || globalThis.location;
  const historyRef = context.historyRef || globalThis.history;
  let generation = 0;

  async function renderFinanceOverviewSurface() {
    const today = typeof todayIsoDate === "function" ? todayIsoDate() : berlinToday();
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
      <div class="fin-body" data-fin-upcoming></div>
      <div class="fin-tooltip" data-fin-tooltip role="status" hidden></div>`;

    const body = surface.querySelector("[data-fin-body]");
    const tooltip = surface.querySelector("[data-fin-tooltip]");

    // The debit schedule does not depend on the period, so it loads once.
    request(workApiUrl("/api/finance/upcoming?days=60"))
      .then((u) => { surface.querySelector("[data-fin-upcoming]").innerHTML = upcomingMarkup(u, escapeHtml); })
      .catch((error) => {
        const message = escapeHtml(error?.message || "request failed");
        surface.querySelector("[data-fin-upcoming]").innerHTML = html`<p class="fin-error" role="alert">Could not load upcoming tax debits: ${message}</p>`;
      });

    async function load() {
      const mine = ++generation;
      const query = new URLSearchParams(Object.entries(period).filter(([key]) => key === "year"));
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

    async function loadTaxEstimate() {
      const box = surface.querySelector("[data-fin-estimate-body]");
      if (!box) return;
      box.innerHTML = html`<p class="fin-muted">Calculating…</p>`;
      try {
        const estimate = await request(workApiUrl(`/api/finance/tax-estimate?year=${encodeURIComponent(period.year)}`));
        box.innerHTML = taxEstimateMarkup(estimate, escapeHtml);
      } catch (error) {
        const message = escapeHtml(error?.message || "request failed");
        box.innerHTML = html`<p class="fin-error" role="alert">Could not calculate the tax estimate: ${message}</p>
          <button type="button" class="dk-button dk-button--secondary dk-button--sm" data-fin-tax-estimate>Retry</button>`;
      }
    }

    function choose(next) {
      period = next;
      const params = new URLSearchParams(Object.entries(next).filter(([key]) => key === "year"));
      historyRef?.pushState?.({}, "", `${locationRef?.pathname || "/finance"}?${params}`);
      surface.querySelector("[data-fin-controls]").innerHTML = periodControlsMarkup(period, today, escapeHtml);
      load();
    }

    surface.addEventListener("click", (event) => {
      activateFinanceMonthlyRow(event, document.getSelection?.());
      if (event.target.closest("[data-fin-period='current-year']")) choose({ year: today.slice(0, 4) });
      if (event.target.closest("[data-fin-retry]")) load();
      if (event.target.closest("[data-fin-tax-estimate]")) loadTaxEstimate();
    });
    surface.addEventListener("change", (event) => {
      if (event.target.matches("[data-fin-year]")) choose({ year: event.target.value });
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
