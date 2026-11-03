import { html } from "./shared.js";
import { formatAmount, isOwnerWithdrawalReportExempt, ledgerDate, monthLabel, monthOf } from "./bookkeeping-format.js";
import { groupByMonth, ledgerTableMarkup } from "./bookkeeping-ledger.js";

const MANDATORY_LABELS = {
  vat: "VAT / USt",
  taxes: "Other taxes",
  "health-insurance": "Health insurance / TK",
};
const TAX_HEALTH_KINDS = new Set(["tax_debit", "tk_debit"]);

function isTaxHealthEntry(entry) {
  return TAX_HEALTH_KINDS.has(String(entry?.mandatoryKind || ""));
}

function isOwnerWithdrawalEntry(entry) {
  return isOwnerWithdrawalReportExempt(entry)
    || (entry?.reconciliationOnly === true
      && entry.category === "Owner withdrawal"
      && entry.reconciliationLabel === "Owner withdrawal");
}

function isRefund(entry) {
  return Boolean(entry?.refund) || entry?.direction === "in";
}

function mandatoryAmount(entry) {
  const sign = isRefund(entry) ? 1 : -1;
  const eur = Number(entry.eur);
  if (entry.eur !== null && entry.eur !== undefined && Number.isFinite(eur))
    return formatAmount(sign * Math.abs(eur), "EUR");
  const amount = Number(entry.amount);
  return Number.isFinite(amount)
    ? formatAmount(sign * Math.abs(amount), entry.currency || "EUR")
    : "—";
}

function mandatoryLabel(entry) {
  const label = MANDATORY_LABELS[entry.line] || "Mandatory payment";
  return isRefund(entry) ? `${label} refund` : label;
}

// Share the explicit tax/health classification between the monthly list and its separate section.
export function monthlyLedgerEntries(entries, lens, financeEntriesById) {
  if (!/^\d{4}-\d{2}$/.test(lens)) return entries;
  return entries.filter((entry) => {
    const mandatory = financeEntriesById.get(String(entry.id));
    const taxHealth = mandatory?.month === lens && isTaxHealthEntry(mandatory);
    const ownerWithdrawal = monthOf(entry) === lens && isOwnerWithdrawalEntry(entry);
    return !taxHealth && !ownerWithdrawal;
  });
}

export function ownerWithdrawalEntries(entries, lens) {
  if (!/^\d{4}-\d{2}$/.test(lens)) return [];
  return (entries || []).filter((entry) => monthOf(entry) === lens && isOwnerWithdrawalEntry(entry));
}

export function ownerWithdrawalsMarkup(entries, lens, ledgerOptions) {
  if (!/^\d{4}-\d{2}$/.test(lens)) return "";
  const e = ledgerOptions.e;
  const withdrawals = ownerWithdrawalEntries(entries, lens);
  const rows = withdrawals.length
    ? ledgerTableMarkup({ ...ledgerOptions, groups: groupByMonth(withdrawals) })
    : html`<p class="bk-mandatory-payments__state">No owner withdrawals recorded for this month.</p>`;
  return html`<section class="bk-mandatory-payments bk-owner-withdrawals" aria-labelledby="bk-owner-withdrawals-heading" data-owner-withdrawals>
    <h2 id="bk-owner-withdrawals-heading">Owner withdrawals · ${e(monthLabel(lens))}</h2>
    <p class="bk-mandatory-payments__hint">Shown separately for internal review; source and reconciliation rows remain visible.</p>
    ${rows}
  </section>`;
}

export function mandatoryPaymentsMarkup(entries, lens, escapeHtml, state = "ready") {
  if (!/^\d{4}-\d{2}$/.test(lens)) return "";
  const periodLabel = monthLabel(lens);
  const sectionTitle = `Taxes & health insurance · ${periodLabel}`;
  if (state === "loading")
    return html`<section class="bk-mandatory-payments" aria-labelledby="bk-mandatory-payments-heading">
      <h2 id="bk-mandatory-payments-heading">${escapeHtml(sectionTitle)}</h2>
      <p class="bk-mandatory-payments__state" role="status">Loading tax and health-insurance entries…</p>
    </section>`;
  if (state === "error")
    return html`<section class="bk-mandatory-payments" aria-labelledby="bk-mandatory-payments-heading">
      <h2 id="bk-mandatory-payments-heading">${escapeHtml(sectionTitle)}</h2>
      <p class="bk-mandatory-payments__state" role="status">Could not load tax and health-insurance entries.</p>
    </section>`;

  const exceptions = (entries || [])
    .filter((entry) => entry.month === lens && isTaxHealthEntry(entry))
    .sort((a, b) => String(a.date || "").localeCompare(String(b.date || ""))
      || String(a.id || "").localeCompare(String(b.id || "")));
  const subtotal = exceptions.reduce((sum, entry) => {
    const value = Number(entry.eur);
    return entry.eur !== null && entry.eur !== undefined && Number.isFinite(value)
      ? sum + (isRefund(entry) ? -Math.abs(value) : Math.abs(value))
      : sum;
  }, 0);
  const unconvertedCount = exceptions.filter((entry) => entry.eur === null
    || entry.eur === undefined || !Number.isFinite(Number(entry.eur))).length;
  const rows = exceptions.length
    ? exceptions.map((entry) => html`<tr>
        <td><time datetime="${escapeHtml(entry.date || "")}">${escapeHtml(ledgerDate(entry.date || ""))}</time></td>
        <td>${escapeHtml(entry.counterparty || entry.description || "Unlabelled payment")}</td>
        <td>${escapeHtml(mandatoryLabel(entry))}</td>
        <td class="bk-mandatory-payments__amount">${escapeHtml(mandatoryAmount(entry))}</td>
      </tr>`).join("")
    : html`<tr><td colspan="4">No tax or health-insurance entries recorded for this month.</td></tr>`;

  return html`<section class="bk-mandatory-payments" aria-labelledby="bk-mandatory-payments-heading" data-mandatory-payments>
    <h2 id="bk-mandatory-payments-heading">${escapeHtml(sectionTitle)}</h2>
    <p class="bk-mandatory-payments__hint">Shown separately for your review and excluded from the accountant report and package.</p>
    <div class="bk-mandatory-payments__table-wrap" tabindex="0" role="region" aria-label="Scrollable tax and health-insurance entries">
      <table aria-label="Taxes and health insurance for ${escapeHtml(periodLabel)}">
      <thead><tr><th>Date</th><th>Counterparty</th><th>Kind</th><th>Amount</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p class="bk-mandatory-payments__subtotal">
      <span>Net month total</span><strong>${escapeHtml(formatAmount(subtotal, "EUR"))}</strong>
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
    return isTaxHealthEntry(entryIndex.get(String(id)));
  }

  return { ensure, entries, entryMap: () => entryIndex, hasMandatoryEntry, invalidate, markup };
}
