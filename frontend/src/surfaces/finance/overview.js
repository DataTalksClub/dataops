// Finance overview: one calm annual report. Three key numbers on top (profit,
// taxes, owner pay), then taxes, one chart and a short month table; everything
// else sits behind a disclosure. A finished year shows actuals only (assessed
// per Bescheid, paid, refunded) and never an estimate; the running year adds a
// rough planning estimate. Every figure comes from GET /api/finance/summary,
// the payload Bookkeeping month totals and `dataops finance summary` also use,
// so the three cannot disagree. Pure markup helpers are exported for tests.
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

const headRow = (labels) => html`<thead><tr>${labels.map((label, i) => html`<th scope="col"${i ? ' class="fin-num"' : ""}>${label}</th>`).join("")}</tr></thead>`;

const longMonth = (month) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleString("en-US", { month: "long", timeZone: "UTC" });

/** A year is finished once it is assessed (stored Bescheid) or simply over. */
export function isFinishedYear(summary, today) {
  return Boolean(summary.taxReturn?.closed) || Number(summary.period.label) < Number(today.slice(0, 4));
}

/** Months worth showing: never a future month; the running month is flagged. */
export function shownMonths(summary, today) {
  const current = today.slice(0, 7);
  return summary.months
    .filter((m) => !m.future && m.month <= current)
    .map((m) => ({ ...m, inProgress: m.month === current }));
}

export function statusLine(summary, today) {
  const year = summary.period.label;
  if (summary.taxReturn?.closed) return `${year} · closed · assessed per Bescheid`;
  if (isFinishedYear(summary, today)) return `${year} · finished · actual figures`;
  const current = today.slice(0, 7);
  return current.startsWith(year) ? `${year} · in progress · through ${longMonth(current)}` : year;
}

const tile = (label, value, sub, attr) => html`<section class="fin-tile">
      <h2 class="fin-tile__label">${label}</h2>
      <p class="fin-tile__value" ${attr}>${value}</p>
      <p class="fin-tile__sub">${sub}</p>
    </section>`;

/** Key numbers first: profit, taxes, owner pay; cash in/out as one quiet line. */
export function headlineMarkup(summary, e) {
  const t = summary.totals;
  const official = summary.taxReturn;
  const assessed = official ? official.assessed.incomeTax + official.assessed.soli + official.assessed.tradeTax : 0;
  const taxes = official
    ? tile("Taxes assessed", formatEur(assessed), html`Income tax, Soli and trade tax per Bescheid · refunded ${formatEur(official.refunded)}`, "data-fin-taxes-total")
    : tile("Taxes paid", formatEur(t.taxesTotal), "Income tax, trade tax and TK actually paid", "data-fin-taxes-total");
  return html`<div class="fin-top"><div class="fin-hero">
      ${tile("Profit", formatEur(t.netProfitExVat), html`Income ${formatEur(t.incomeNetOfVat)} − expenses ${formatEur(t.expensesNetOfVat)}, excluding VAT`, "data-fin-profit")}
      ${taxes}
      ${tile("Owner pay", formatEur(t.ownerPay), "Actual withdrawals to the owner", "data-fin-owner-pay")}
    </div>
    <p class="fin-cashline" data-fin-cash>Money in <strong>${formatEur(t.moneyIn)}</strong>
      <span aria-hidden="true">·</span> Money out <strong>${formatEur(t.moneyOut)}</strong>
      <span aria-hidden="true">·</span> Net cash <strong>${formatEur(t.net, { sign: true })}</strong>
      <span class="fin-muted">EUR, same totals as Bookkeeping</span></p></div>`;
}

const taxRow = (label, cells, attr = "") => html`<tr${attr ? ` ${attr}` : ""}><th scope="row">${label}</th>${cells
  .map((v) => html`<td class="fin-num">${v === null ? "" : typeof v === "string" ? v : formatEur(v)}</td>`).join("")}</tr>`;

/**
 * Taxes for the year. A closed year shows the official numbers only: assessed
 * per Bescheid, paid, and the refund that belongs to that tax year. An open
 * year shows what was actually paid, by type. Only payments count: a refund
 * is never a negative tax.
 */
export function taxesMarkup(summary, e) {
  const t = summary.totals;
  const year = e(summary.period.label);
  const official = summary.taxReturn;
  if (official) {
    const a = official.assessed, p = official.paid;
    const assessedTotal = a.incomeTax + a.soli + a.tradeTax + a.vat;
    const paidTotal = p.incomeTax + p.soli + p.tradeTax + p.vat;
    const balance = (assessed, paid) => formatEur(assessed - paid, { sign: true });
    const carried = official.offsets?.length
      ? html`<p class="fin-muted">Not paid out but carried: ${official.offsets
          .map((o) => html`<strong>${formatEur(o.amount)}</strong> to ${e(o.target)}`).join("; ")}.</p>`
      : "";
    return html`<section class="fin-block" aria-labelledby="fin-taxes-heading">
      <h2 id="fin-taxes-heading" class="fin-block__title">Taxes for ${year}
        <span class="fin-badge" data-fin-closed-badge>closed</span></h2>
      <div class="fin-table-wrap"><table class="fin-table fin-table--compact">
        ${headRow(["", "Assessed", "Paid", "Balance"])}
        <tbody>
          ${taxRow("Income tax", [a.incomeTax, p.incomeTax, balance(a.incomeTax, p.incomeTax)], "data-fin-official-income-tax")}
          ${taxRow("Solidarity surcharge", [a.soli, p.soli, balance(a.soli, p.soli)], "data-fin-official-soli")}
          ${taxRow("Trade tax", [a.tradeTax, p.tradeTax, balance(a.tradeTax, p.tradeTax)], "data-fin-official-trade-tax")}
          ${taxRow("VAT", [a.vat, p.vat, balance(a.vat, p.vat)], "data-fin-official-vat")}
          ${taxRow("TK health insurance", [null, t.healthInsurance, null], 'data-fin-tax="health-insurance"')}
        </tbody>
        <tfoot>
          ${taxRow("Total", [assessedTotal, paidTotal, balance(assessedTotal, paidTotal)], "class=\"fin-table__total\" data-fin-official-balance")}
          <tr class="fin-table__total" data-fin-official-refund><th scope="row">Refunded for ${year}${official.refundedOn
          ? html` <span class="fin-muted">paid out ${e(official.refundedOn)}</span>` : ""}</th>
          <td></td><td class="fin-num">${formatEur(official.refunded)}</td><td></td></tr>
        </tfoot>
      </table></div>
      <p class="fin-muted">Balance is assessed minus paid; refunds and amounts carried forward are shown separately.</p>
      ${carried}
      ${refundsMarkup(summary, e)}
      <details class="fin-details" data-fin-official-sources>
        <summary>Documents these figures come from</summary>
        ${official.notes?.length ? html`<ul class="fin-gaps">${official.notes.map((note) => html`<li>${e(note)}</li>`).join("")}</ul>` : ""}
        <ul class="fin-gaps">${official.sources.map((source) => html`<li>${e(source)}</li>`).join("")}</ul>
      </details>
    </section>`;
  }
  const lines = [
    ["Income tax + Soli", t.incomeTax, "income-tax"],
    ["Trade tax", t.tradeTax, "trade-tax"],
    ["TK health insurance", t.healthInsurance, "health-insurance"],
    ...(t.otherTaxes ? [["Other taxes", t.otherTaxes, "other"]] : []),
  ];
  return html`<section class="fin-block" aria-labelledby="fin-taxes-heading">
      <h2 id="fin-taxes-heading" class="fin-block__title">Taxes paid in ${year}</h2>
      <div class="fin-table-wrap"><table class="fin-table fin-table--compact">
        <tbody>${lines.map(([label, value, key]) => html`<tr><th scope="row">${label}</th>
          <td class="fin-num" data-fin-tax="${key}">${formatEur(value)}</td></tr>`).join("")}</tbody>
        <tfoot><tr class="fin-table__total"><th scope="row">Total</th><td class="fin-num" data-fin-tax="total">${formatEur(t.taxesTotal)}</td></tr></tfoot>
      </table></div>
      ${t.vatPaid || t.vatRefunded ? html`<p class="fin-muted" data-fin-vat>VAT passed on to the Finanzamt:
        ${formatEur(t.vatPaid - t.vatRefunded)} (not a cost, so not in the total).</p>` : ""}
      ${refundsMarkup(summary, e)}
    </section>`;
}

/** Refund payments that belong to this tax year, on demand, with the bank date they arrived on. */
export function refundsMarkup(summary, e) {
  const refunds = summary.taxRefunds || [];
  if (!refunds.length) return "";
  const sum = refunds.reduce((total, r) => total + (r.eur || 0), 0);
  return html`<details class="fin-details" data-fin-refunds>
      <summary>Refunds for ${e(summary.period.label)}: ${formatEur(sum)} in ${refunds.length} payment${refunds.length === 1 ? "" : "s"}</summary>
      <p class="fin-muted">A refund belongs to the tax year it settles, not the year the money arrived. It is never income, profit or a negative tax.</p>
      <div class="fin-table-wrap"><table class="fin-table fin-table--compact">
        ${headRow(["Received", "Amount"])}
        <tbody>${refunds.map((r) => html`<tr>
          <th scope="row">${MONTH.test(r.month) ? html`<a href="${e(bookkeepingMonthUrl(r.month))}">${e(r.date)}</a>` : e(r.date)}
            <span class="fin-muted">${e(r.counterparty)}</span></th>
          <td class="fin-num">${formatEur(r.eur)}</td></tr>`).join("")}</tbody>
      </table></div>
    </details>`;
}

/** Placeholder for the running year's rough estimate; finished years never get one. */
export function taxEstimateSectionMarkup(year, e) {
  return html`<section class="fin-block" aria-labelledby="fin-estimate-heading" data-fin-estimate>
      <h2 id="fin-estimate-heading" class="fin-block__title">Planning for ${e(year)} <span class="fin-badge">rough estimate</span></h2>
      <div data-fin-estimate-body><p class="fin-muted">Calculating…</p></div>
    </section>`;
}

/** Running year only: expected tax, what is already paid, and what is safe to take out. */
export function taxEstimateMarkup(est, e) {
  if (est.assessment) return "";
  const safe = est.planning.safeToWithdrawEur === null
    ? html`<span class="fin-muted">needs a bank statement</span>`
    : formatEur(est.planning.safeToWithdrawEur);
  return html`<div data-fin-estimate-result>
      <dl class="fin-stats" data-fin-planning>
        <div><dt>Expected tax for ${e(String(est.year))}</dt><dd data-fin-est-total>${formatEur(est.totalEstimate)}</dd></div>
        <div><dt>Already paid</dt><dd data-fin-est-paid>${formatEur(est.paidTotal)}</dd></div>
        <div><dt>${est.remaining >= 0 ? "Still to pay" : "Paid ahead"}</dt><dd data-fin-est-remaining>${formatEur(Math.abs(est.remaining))}</dd></div>
        <div><dt>Safe to withdraw now</dt><dd data-fin-planning-safe>${safe}</dd></div>
        <div><dt>Projected year-end after tax</dt><dd data-fin-planning-after-tax>${formatEur(est.planning.projectedAfterTaxEur)}</dd></div>
      </dl>
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
    return html`<g class="fin-chart__month${m.inProgress ? " is-in-progress" : ""}" data-fin-hover="${e(label)}">
        <rect class="fin-chart__hit" x="${left + slot * i}" y="${top}" width="${slot}" height="${plotH}"><title>${e(label)}</title></rect>
        <path class="fin-chart__in" d="${bar(x, barW, y(0) - 1, y(m.moneyIn))}"/>
        <path class="fin-chart__out" d="${bar(x, barW, y(0) + 1, y(-m.moneyOut))}"/>
        ${m.moneyIn || m.moneyOut ? html`<circle class="fin-chart__net" cx="${cx}" cy="${y(m.net)}" r="4.5"/>` : ""}
        <text class="fin-chart__tick" x="${cx}" y="${H - 8}" text-anchor="middle">${shortMonth(m.month)}</text>
      </g>`;
  }).join("");
  return html`<figure class="fin-chart">
      <figcaption class="fin-chart__caption">
                <span class="fin-legend"><span class="fin-legend__swatch fin-legend__swatch--in"></span>Money in</span>
        <span class="fin-legend"><span class="fin-legend__swatch fin-legend__swatch--out"></span>Money out</span>
        <span class="fin-legend"><span class="fin-legend__dot"></span>Net</span>
      </figcaption>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Money in and out per month; the table below has the same numbers">${grid}${marks}</svg>
    </figure>`;
}

/**
 * One row per month that has happened: money in and out (the Bookkeeping
 * totals), profit, one combined taxes figure and the owner's withdrawals. The
 * split of taxes by type appears once, under the year total.
 */
export function monthTableMarkup(summary, e, today = "9999-12-31") {
  const months = shownMonths(summary, today);
  const t = summary.totals;
  const cell = (v, opts) => html`<td class="fin-num">${formatEur(v, opts)}</td>`;
  const cash = (v) => html`<td class="fin-num fin-col-cash">${formatEur(v)}</td>`;
  const cells = (r) => html`${cash(r.moneyIn)}${cash(r.moneyOut)}${cell(r.netProfitExVat, { sign: true })}${cell(r.taxesTotal)}${cell(r.ownerPay)}`;
  const split = [["Income tax + Soli", t.incomeTax], ["Trade tax", t.tradeTax], ["TK", t.healthInsurance], ...(t.otherTaxes ? [["Other", t.otherTaxes]] : [])]
    .map(([label, value]) => html`${label} ${formatEur(value)}`).join(" · ");
  return html`<div class="fin-table-wrap"><table class="fin-table fin-table--months">
      <caption class="fin-sr">Per month, EUR</caption>
      <thead><tr><th scope="col">Month</th><th scope="col" class="fin-num fin-col-cash">Money in</th>
        <th scope="col" class="fin-num fin-col-cash">Money out</th><th scope="col" class="fin-num">Profit</th>
        <th scope="col" class="fin-num">Taxes</th><th scope="col" class="fin-num">Owner pay</th></tr></thead>
      <tbody>${months.map((r) => {
        const href = MONTH.test(r.month) ? bookkeepingMonthUrl(r.month) : "";
        const name = html`${e(longMonth(r.month))}`;
        return html`<tr${r.inProgress ? ' class="is-in-progress" data-fin-in-progress' : ""}${href ? " data-fin-bookkeeping-row" : ""}>
        <th scope="row">${href ? html`<a class="fin-table__month-link" data-fin-month-link href="${e(href)}">${name}</a>` : name}${r.inProgress
          ? html` <span class="fin-badge">in progress</span>` : ""}</th>${cells(r)}</tr>`;
      }).join("")}</tbody>
      <tfoot><tr class="fin-table__total" data-fin-year-total><th scope="row">${e(summary.period.label)} total</th>${cells(t)}</tr>
        <tr class="fin-table__split" data-fin-tax-split><th scope="row">Taxes by type</th><td colspan="5">${split}</td></tr></tfoot>
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
  return html`<div class="fin-period" role="group" aria-label="Year">
      ${years.map((y) => html`<button type="button" class="fin-period__year" data-fin-year="${e(y)}" aria-pressed="${y === year}">${e(y)}</button>`).join("")}
    </div>`;
}

const TAX_TYPE = { "income-tax": "Income tax + Soli", "trade-tax": "Trade tax", vat: "VAT", "health-insurance": "Health insurance (TK)", other: "Other" };

/** Next tax and TK auto-debits: the amount due and the balance first, the schedule on demand. */
export function upcomingMarkup(u, e) {
  const balance = u.balance
    ? html`${formatEur(u.balance.amount)} <span class="fin-muted">as of ${e(u.balance.asOf)}${u.balance.stale ? ", stale" : ""}</span>`
    : html`<span class="fin-muted">unknown</span>`;
  const status = (d) => (d.status === "paid" ? `Paid ${d.matched.date}` : d.status === "not-seen" ? "Not seen yet" : "Scheduled");
  return html`<section class="fin-block" aria-labelledby="fin-upcoming-heading">
      <h2 id="fin-upcoming-heading" class="fin-block__title">Upcoming tax debits</h2>
      <dl class="fin-stats">
        <div><dt>Due in the next 30 days</dt><dd data-fin-due30>${formatEur(u.dueNext30)}</dd></div>
        <div><dt>Due in the next ${e(String(u.days))} days</dt><dd>${formatEur(u.dueInWindow)}</dd></div>
        <div><dt>Account balance</dt><dd>${balance}</dd></div>
      </dl>
      ${u.shortfall ? html`<p class="fin-error" role="alert">Shortfall: the balance does not cover the ${formatEur(u.dueNext30)} EUR due in the next 30 days.</p>` : ""}
      ${u.debits.length ? html`<details class="fin-details" data-fin-upcoming-schedule>
        <summary>Schedule: ${u.debits.length} debit${u.debits.length === 1 ? "" : "s"}</summary>
        <div class="fin-table-wrap"><table class="fin-table fin-table--compact">
        ${headRow(["Date", "Amount", "Tax", "Status"])}
        <tbody>${u.debits.map((d) => html`<tr class="${d.status === "paid" ? "is-done" : ""}">
          <th scope="row">${e(d.date)}${d.approximate ? " ~" : ""}${d.shifted ? html` <span class="fin-muted">${e(d.shifted)}</span>` : ""}</th>
          <td class="fin-num">${formatEur(d.amount)}</td><td class="fin-num">${e(TAX_TYPE[d.taxType] || d.taxType)}</td>
          <td class="fin-num">${e(status(d))}</td></tr>`).join("")}</tbody>
      </table></div></details>` : html`<p class="fin-muted">No scheduled debits in this window.</p>`}
      ${u.warnings.length ? html`<ul class="fin-gaps">${u.warnings.map((w) => html`<li>${e(w)}</li>`).join("")}</ul>` : ""}
    </section>`;
}

export function overviewMarkup(summary, e, today = "9999-12-31") {
  const finished = isFinishedYear(summary, today);
  return html`${headlineMarkup(summary, e)}
    ${taxesMarkup(summary, e)}
    ${finished ? "" : taxEstimateSectionMarkup(summary.period.label, e)}
    <section class="fin-block" aria-labelledby="fin-months-heading">
      <h2 id="fin-months-heading" class="fin-block__title">By month</h2>
      ${cashChartMarkup(shownMonths(summary, today), e)}
      ${monthTableMarkup(summary, e, today)}
    </section>`;
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
    setRouteTitle("Finance");
    surface.innerHTML = html`<header class="dk-page-header">
        <div class="dk-page-header__main"><h1 class="dk-page-header__title">Finance</h1></div>
        <div data-fin-controls>${periodControlsMarkup(period, today, escapeHtml)}</div>
      </header>
      <p class="fin-period-label" data-fin-label></p>
      <div class="fin-body" data-fin-body aria-live="polite"><p class="fin-muted">Loading…</p></div>
      <div class="fin-body" data-fin-upcoming></div>
      <div class="fin-tooltip" data-fin-tooltip role="status" hidden></div>`;

    const body = surface.querySelector("[data-fin-body]");
    const tooltip = surface.querySelector("[data-fin-tooltip]");
    const currentYear = today.slice(0, 4);

    // The upcoming-debit schedule and its balance check are period-independent,
    // so the markup is fetched once; whether it shows is a per-year decision:
    // they belong to the live current year only, never to a closed year.
    let upcomingHtml = "";
    let estimateClosed = false;
    let estimatePending = true;

    function syncUpcoming() {
      const box = surface.querySelector("[data-fin-upcoming]");
      if (!box) return;
      box.innerHTML = !estimatePending && period.year === currentYear && !estimateClosed ? upcomingHtml : "";
    }

    request(workApiUrl("/api/finance/upcoming?days=60"))
      .then((u) => {
        upcomingHtml = upcomingMarkup(u, escapeHtml);
        syncUpcoming();
      })
      .catch((error) => {
        const message = escapeHtml(error?.message || "request failed");
        const box = surface.querySelector("[data-fin-upcoming]");
        if (box) box.innerHTML = html`<p class="fin-error" role="alert">Could not load upcoming tax debits: ${message}</p>`;
      });

    async function load() {
      const mine = ++generation;
      const query = new URLSearchParams(Object.entries(period).filter(([key]) => key === "year"));
      body.setAttribute("aria-busy", "true");
      try {
        const summary = await request(workApiUrl(`/api/finance/summary?${query}`));
        if (mine !== generation) return;
        surface.querySelector("[data-fin-label]").textContent = statusLine(summary, today);
        body.innerHTML = overviewMarkup(summary, escapeHtml, today);
        // A finished year is actuals only: no estimate is even requested.
        estimateClosed = isFinishedYear(summary, today);
        estimatePending = !estimateClosed;
        if (estimateClosed) syncUpcoming();
        else loadTaxEstimate();
      } catch (error) {
        if (mine !== generation) return;
        body.innerHTML = html`<p class="fin-error" role="alert">Could not load the finance summary: ${escapeHtml(error?.message || "request failed")}</p>
          <button type="button" class="dk-button dk-button--secondary" data-fin-retry>Retry</button>`;
      } finally {
        if (mine === generation) body.removeAttribute("aria-busy");
      }
    }

    /** The estimate renders itself when a year loads; no button. */
    async function loadTaxEstimate() {
      const mine = generation;
      const box = surface.querySelector("[data-fin-estimate-body]");
      if (!box) return;
      estimatePending = true;
      box.innerHTML = html`<p class="fin-muted">Calculating…</p>`;
      try {
        const estimate = await request(workApiUrl(`/api/finance/tax-estimate?year=${encodeURIComponent(period.year)}`));
        if (mine !== generation) return;
        estimateClosed = Boolean(estimate.assessment?.closed);
        estimatePending = false;
        box.innerHTML = taxEstimateMarkup(estimate, escapeHtml);
        syncUpcoming();
      } catch (error) {
        if (mine !== generation) return;
        estimateClosed = false;
        estimatePending = false;
        const message = escapeHtml(error?.message || "request failed");
        box.innerHTML = html`<p class="fin-error" role="alert">Could not calculate the tax estimate: ${message}</p>
          <button type="button" class="dk-button dk-button--secondary dk-button--sm" data-fin-tax-estimate>Retry</button>`;
        syncUpcoming();
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
      const yearButton = event.target.closest("[data-fin-year]");
      if (yearButton && yearButton.getAttribute("data-fin-year") !== period.year) choose({ year: yearButton.getAttribute("data-fin-year") });
      if (event.target.closest("[data-fin-retry]")) load();
      if (event.target.closest("[data-fin-tax-estimate]")) loadTaxEstimate();
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
