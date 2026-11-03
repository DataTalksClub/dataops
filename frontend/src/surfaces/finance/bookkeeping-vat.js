import { html } from "./shared.js";
import { formatAmount, ledgerDate, monthLabel } from "./bookkeeping-format.js";

const MANDATORY_LABELS = {
  vat: "VAT / USt",
  taxes: "Other taxes",
  "health-insurance": "Health insurance / TK",
};

function mandatoryPaymentAmount(entry) {
  const eur = Number(entry.eur);
  if (entry.eur !== null && entry.eur !== undefined && Number.isFinite(eur))
    return formatAmount(-Math.abs(eur), "EUR");
  const amount = Number(entry.amount);
  return Number.isFinite(amount)
    ? formatAmount(-Math.abs(amount), entry.currency || "EUR")
    : "—";
}

// Exclude only rows actually represented in the selected month's mandatory section.
export function monthlyLedgerEntries(entries, lens, financeEntriesById) {
  if (!/^\d{4}-\d{2}$/.test(lens)) return entries;
  return entries.filter((entry) => {
    const mandatory = financeEntriesById.get(String(entry.id));
    return !(mandatory?.month === lens && mandatory.direction === "out" && mandatory.mandatoryKind && !mandatory.refund);
  });
}

export function mandatoryPaymentsMarkup(entries, lens, escapeHtml, state = "ready") {
  if (!/^\d{4}-\d{2}$/.test(lens)) return "";
  const periodLabel = monthLabel(lens);
  if (state === "loading")
    return html`<section class="bk-mandatory-payments" aria-labelledby="bk-mandatory-payments-heading">
      <h2 id="bk-mandatory-payments-heading">Mandatory payments · ${escapeHtml(periodLabel)}</h2>
      <p class="bk-mandatory-payments__state" role="status">Loading mandatory payments…</p>
    </section>`;
  if (state === "error")
    return html`<section class="bk-mandatory-payments" aria-labelledby="bk-mandatory-payments-heading">
      <h2 id="bk-mandatory-payments-heading">Mandatory payments · ${escapeHtml(periodLabel)}</h2>
      <p class="bk-mandatory-payments__state" role="status">Could not load mandatory payments.</p>
    </section>`;

  const payments = (entries || [])
    .filter((entry) => entry.month === lens && entry.direction === "out" && entry.mandatoryKind && !entry.refund)
    .sort((a, b) => String(a.date || "").localeCompare(String(b.date || ""))
      || String(a.id || "").localeCompare(String(b.id || "")));
  const subtotal = payments.reduce((sum, entry) => {
    const value = Number(entry.eur);
    return entry.eur !== null && entry.eur !== undefined && Number.isFinite(value)
      ? sum + Math.abs(value)
      : sum;
  }, 0);
  const unconvertedCount = payments.filter((entry) => entry.eur === null
    || entry.eur === undefined || !Number.isFinite(Number(entry.eur))).length;
  const rows = payments.length
    ? payments.map((entry) => html`<tr>
        <td><time datetime="${escapeHtml(entry.date || "")}">${escapeHtml(ledgerDate(entry.date || ""))}</time></td>
        <td>${escapeHtml(entry.counterparty || entry.description || "Unlabelled payment")}</td>
        <td>${escapeHtml(MANDATORY_LABELS[entry.line] || "Mandatory payment")}</td>
        <td class="bk-mandatory-payments__amount">${escapeHtml(mandatoryPaymentAmount(entry))}</td>
      </tr>`).join("")
    : html`<tr><td colspan="4">No mandatory payments recorded for this month.</td></tr>`;

  return html`<section class="bk-mandatory-payments" aria-labelledby="bk-mandatory-payments-heading" data-mandatory-payments>
    <h2 id="bk-mandatory-payments-heading">Mandatory payments · ${escapeHtml(periodLabel)}</h2>
    <p class="bk-mandatory-payments__hint">Shown separately for your review and excluded from the accountant report and package.</p>
    <div class="bk-mandatory-payments__table-wrap" tabindex="0" role="region" aria-label="Scrollable mandatory payments">
      <table aria-label="Mandatory payments for ${escapeHtml(periodLabel)}">
      <thead><tr><th>Date</th><th>Counterparty</th><th>Kind</th><th>Amount</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p class="bk-mandatory-payments__subtotal">
      <span>Month subtotal</span><strong>${escapeHtml(formatAmount(subtotal, "EUR"))}</strong>
      ${unconvertedCount ? html`<span class="bk-mandatory-payments__unconverted">
        ${unconvertedCount} amount${unconvertedCount === 1 ? "" : "s"} without an EUR conversion
      </span>` : ""}
    </p>
  </section>`;
}

export function createBookkeepingFinance({ loadYear, getLens, getEntries, getTodayIsoDate, refresh }) {
  let summaries = new Map();
  let entryIndex = new Map();
  let summaryKey = "";
  let pendingKey = "";
  let pendingPromise = null;
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

  function indexEntries() {
    entryIndex = new Map(entries().flatMap((entry) => [
      [String(entry.id), entry],
      ...(entry.bankKey ? [[`bank-only:${entry.bankKey}`, entry]] : []),
    ]));
  }

  function invalidate() {
    generation += 1;
    summaryKey = "";
    pendingKey = "";
    pendingPromise = null;
    error = "";
    summaries = new Map();
    entryIndex = new Map();
  }

  function ensure() {
    const requestedYears = years();
    const key = requestedYears.join(",");
    if (summaryKey === key && requestedYears.every((year) => summaries.has(year))) return Promise.resolve();
    if (pendingKey === key) return pendingPromise || Promise.resolve();
    const requestedGeneration = ++generation;
    pendingKey = key;
    error = "";
    if (summaryKey !== key) {
      summaries = new Map();
      entryIndex = new Map();
      refresh();
    }
    pendingPromise = Promise.all(requestedYears.map(async (year) => [year, await loadYear(year)]))
      .then((values) => {
        if (requestedGeneration !== generation || key !== years().join(",")) return;
        summaries = new Map(values);
        summaryKey = key;
        indexEntries();
      })
      .catch((failure) => {
        if (requestedGeneration !== generation) return;
        error = failure?.message || "request failed";
        summaryKey = key;
      })
      .finally(() => {
        if (requestedGeneration !== generation || pendingKey !== key) return;
        pendingKey = "";
        pendingPromise = null;
        refresh();
      });
    return pendingPromise;
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
    const vatMarkup = totals
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
    const mandatoryState = summaries.has(lens.slice(0, 4)) ? "ready" : error ? "error" : "loading";
    return `${vatMarkup}${mandatoryPaymentsMarkup(entries(), lens, escapeHtml, mandatoryState)}`;
  }

  function hasMandatoryEntry(id) {
    return Boolean(entryIndex.get(String(id))?.mandatoryKind);
  }

  return { ensure, entries, entryMap: () => entryIndex, hasMandatoryEntry, invalidate, markup };
}
