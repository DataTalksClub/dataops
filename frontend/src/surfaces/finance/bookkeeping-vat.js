import { html } from "./shared.js";
import { formatAmount, monthLabel } from "./bookkeeping-format.js";

export function createBookkeepingFinance({ loadYear, getLens, getEntries, getTodayIsoDate, refresh }) {
  let summaries = new Map();
  let summaryKey = "";
  let pendingKey = "";
  let generation = 0;
  let error = "";

  function years() {
    const lens = getLens();
    if (/^\d{4}-\d{2}$/.test(lens)) return [lens.slice(0, 4)];
    if (/^\d{4}$/.test(lens)) return [lens];
    const entries = getEntries();
    const found = [...new Set(entries.flatMap((entry) => [entry.transactionDate, entry.paidDate]
      .map((date) => String(date || "").slice(0, 4)).filter((year) => /^\d{4}$/.test(year))))].sort();
    return found.length ? found : [String(getTodayIsoDate?.() || new Date().toISOString()).slice(0, 4)];
  }

  function entries() {
    return [...summaries.values()].flatMap((summary) => summary.entries || []);
  }

  function invalidate() {
    generation += 1;
    summaryKey = "";
    pendingKey = "";
    error = "";
    summaries = new Map();
  }

  async function ensure() {
    const requestedYears = years();
    const key = requestedYears.join(",");
    if (summaryKey === key && requestedYears.every((year) => summaries.has(year))) return;
    if (pendingKey === key) return;
    const requestedGeneration = ++generation;
    pendingKey = key;
    error = "";
    if (summaryKey !== key) {
      summaries = new Map();
      refresh();
    }
    try {
      const values = await Promise.all(requestedYears.map(async (year) => [year, await loadYear(year)]));
      if (requestedGeneration !== generation || key !== years().join(",")) return;
      summaries = new Map(values);
      summaryKey = key;
      pendingKey = "";
    } catch (failure) {
      if (requestedGeneration !== generation) return;
      error = failure?.message || "request failed";
      summaryKey = key;
      pendingKey = "";
    }
    refresh();
  }

  function selectedTotals() {
    const lens = getLens();
    if (/^\d{4}-\d{2}$/.test(lens)) {
      return summaries.get(lens.slice(0, 4))?.months?.find((month) => month.month === lens) || null;
    }
    if (/^\d{4}$/.test(lens)) return summaries.get(lens)?.totals || null;
    const yearsOfSummary = [...summaries.values()];
    if (!yearsOfSummary.length) return null;
    return yearsOfSummary.reduce((totals, summary) => {
      for (const key of ["outputVat", "inputVat", "vatPaid", "vatRefunded", "projectedVat"])
        totals[key] += Number(summary.totals?.[key] || 0);
      return totals;
    }, { outputVat: 0, inputVat: 0, vatPaid: 0, vatRefunded: 0, projectedVat: 0 });
  }

  function markup(escapeHtml) {
    const totals = selectedTotals();
    const lens = getLens();
    const periodLabel = /^\d{4}-\d{2}$/.test(lens) ? monthLabel(lens) : lens === "all" ? "All records" : lens;
    return totals
      ? html`<section class="bk-period-vat" aria-labelledby="bk-period-vat-heading">
          <h2 id="bk-period-vat-heading">VAT totals · ${escapeHtml(periodLabel)}</h2>
          <dl><div><dt>Output VAT</dt><dd>${escapeHtml(formatAmount(totals.outputVat, "EUR"))}</dd></div>
            <div><dt>Input VAT</dt><dd>${escapeHtml(formatAmount(totals.inputVat, "EUR"))}</dd></div>
            <div><dt>VAT paid</dt><dd>${escapeHtml(formatAmount(totals.vatPaid, "EUR"))}</dd></div>
            <div><dt>VAT refunded</dt><dd>${escapeHtml(formatAmount(totals.vatRefunded, "EUR"))}</dd></div>
            <div><dt>VAT position</dt><dd>${escapeHtml(formatAmount(totals.projectedVat, "EUR"))}</dd></div>
          </dl>
        </section>`
      : error
        ? html`<p class="bk-period-vat__error" role="status">Could not load monthly VAT totals.</p>`
        : html`<p class="bk-period-vat__loading" role="status">Loading monthly VAT totals…</p>`;
  }

  return { ensure, entries, invalidate, markup };
}
