import { html } from "./shared.js";
import { formatAmount, ledgerDate } from "./bookkeeping-format.js";
import { followUpSummary } from "./sponsor-finance-records.js";

const MONTH = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

export function forecastBucketLabel(bucket) {
  if (bucket === "overdue") return "Overdue";
  if (bucket === "not-invoiced") return "Not invoiced yet";
  if (bucket === "no-due-date") return "No due date";
  const parsed = new Date(`${bucket}-01T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? bucket : MONTH.format(parsed);
}

function dealName(row) {
  return row.dealTitle ? `${row.organizationName} · ${row.dealTitle}` : row.organizationName;
}

/**
 * Markup for the Money view: what to follow up on first, each row carrying its fix,
 * then outstanding money per currency and expected cash by month as compact
 * lists. Fed by GET /api/sponsor-crm/finance/ledger.
 */
export function moneyMarkup(ledger, escapeHtml) {
  const followUpRow = (row) => {
    const next = followUpSummary(row.followUp);
    const amount = row.outstanding || row.amountDue;
    return html`<li class="money-follow-up-row" data-money-tone="${escapeHtml(next.tone)}">
      <div class="money-follow-up-row__main">
        <span><strong>${escapeHtml(next.title)}</strong> · ${escapeHtml(dealName(row))}</span>
        ${next.detail ? html`<span class="dk-muted">${escapeHtml(next.detail)}</span>` : ""}
        ${row.recordedPayments?.length ? html`<span class="dk-muted">Payment reported; verify receipt before chasing or marking paid.</span>` : ""}
      </div>
      ${amount
        ? html`<span class="dk-mono money-follow-up-row__amount">${escapeHtml(formatAmount(amount, row.currency))}</span>`
        : ""}
      <button
        type="button"
        class="dk-button dk-button--secondary dk-button--sm"
        data-money-open-deal="${escapeHtml(row.dealId)}"
      >
        Open deal
      </button>
    </li>`;
  };
  // Unclassified agreed deals are real chores but rarely urgent; they sit
  // under one disclosure so they don't bury the overdue and blocked money.
  const urgent = ledger.followUps.filter((row) => row.followUp.code !== "classify");
  const unclassified = ledger.followUps.filter((row) => row.followUp.code === "classify");
  const unclassifiedMarkup = unclassified.length
    ? html`<details open class="money-unclassified" data-money-unclassified>
        <summary>
          ${escapeHtml(`${unclassified.length} agreed deal${unclassified.length === 1 ? " has" : "s have"} no money recorded`)}
        </summary>
        <ul class="money-list">${unclassified.map(followUpRow).join("")}</ul>
      </details>`
    : "";
  const followUps = urgent.length
    ? html`<ul class="money-list">${urgent.map(followUpRow).join("")}</ul>`
    : html`<div class="dk-empty dk-empty--compact">
        <p class="dk-empty__title">Nothing overdue or blocked</p>
        <p class="dk-empty__desc">
          No invoice to send, payment to follow up on or blocker on our side.
        </p>
      </div>`;
  const totals = ledger.totals.filter(
    (item) => Number(item.outstanding) || Number(item.overdue) || Number(item.notInvoiced),
  );
  const totalRows = totals
    .map(
      (item) => html`<li class="money-total-row" data-money-currency="${escapeHtml(item.currency)}">
        <span class="dk-mono money-total-row__currency">${escapeHtml(item.currency)}</span>
        <span>
          <span class="dk-mono">${escapeHtml(formatAmount(item.outstanding, item.currency))}</span> invoiced and open${
            Number(item.overdue)
              ? html`, <span class="dk-mono money-overdue">${escapeHtml(formatAmount(item.overdue, item.currency))}</span> overdue`
              : ""
          }${
            Number(item.notInvoiced)
              ? html`; <span class="dk-mono">${escapeHtml(formatAmount(item.notInvoiced, item.currency))}</span> agreed, not invoiced`
              : ""
          }
        </span>
      </li>`,
    )
    .join("");
  const forecastRows = ledger.forecast
    .map(
      (item) => html`<li class="money-forecast-row" data-money-bucket="${escapeHtml(item.bucket)}">
        <span class="${item.bucket === "overdue" ? "money-overdue" : ""}">${escapeHtml(forecastBucketLabel(item.bucket))}</span>
        <span class="dk-mono">${escapeHtml(formatAmount(item.amount, item.currency))}</span>
        <span class="dk-muted">${escapeHtml(`${item.dealIds.length} deal${item.dealIds.length === 1 ? "" : "s"}`)}</span>
      </li>`,
    )
    .join("");
  return html`<section class="money-block" aria-labelledby="money-follow-up-heading">
      <h4 id="money-follow-up-heading">
        What to follow up on${urgent.length ? html` <span class="dk-count">${urgent.length}</span>` : ""}
      </h4>
      ${followUps} ${unclassifiedMarkup}
    </section>
    <div class="money-summary">
    <section class="money-block" aria-labelledby="money-outstanding-heading">
      <h4 id="money-outstanding-heading">Outstanding</h4>
      ${totals.length
        ? html`<ul class="money-list">${totalRows}</ul>`
        : html`<p class="dk-muted">No open sponsor money.</p>`}
    </section>
    <section class="money-block" aria-labelledby="money-forecast-heading">
      <h4 id="money-forecast-heading">Expected cash</h4>
      ${ledger.forecast.length
        ? html`<ul class="money-list">${forecastRows}</ul>`
        : html`<p class="dk-muted">No cash expected from open deals.</p>`}
    </section>
    </div>
    <p class="dk-hint">As of ${escapeHtml(ledgerDate(ledger.asOf))}.</p>`;
}

export function createSponsorMoney(context) {
  const { escapeHtml, request, surface, workApiUrl, openDeal, onAvailability = () => {} } = context;
  let loaded = null;

  function container() {
    return surface.querySelector("[data-crm-money]");
  }

  async function loadMoney() {
    const target = container();
    if (!target) return;
    if (!loaded) target.innerHTML = html`<span class="dk-spinner" role="status" aria-label="Loading"></span>`;
    try {
      loaded = await request(workApiUrl("/api/sponsor-crm/finance/ledger"));
    } catch (error) {
      if (error.status === 404) {
        // The backend answers 404 when SPONSOR_FINANCE_ENABLED is off.
        onAvailability(false);
        target.innerHTML = html`<div class="dk-empty">
          <p class="dk-empty__title">Sponsor finance is off</p>
          <p class="dk-empty__desc">This environment does not record sponsor invoices and payments.</p>
        </div>`;
        return;
      }
      target.innerHTML = html`<div class="dk-callout dk-callout--danger" role="alert">
        <div class="dk-callout__body">
          <div class="dk-callout__title">Couldn't load sponsor money</div>
          <p>${escapeHtml(error.message || "Sponsor finance is temporarily unavailable.")}</p>
        </div>
        <div class="dk-callout__actions">
          <button type="button" class="dk-button dk-button--secondary dk-button--sm" data-money-retry>Retry</button>
        </div>
      </div>`;
      target.querySelector("[data-money-retry]").addEventListener("click", () => loadMoney());
      return;
    }
    onAvailability(true);
    target.innerHTML = moneyMarkup(loaded, escapeHtml);
  }

  surface.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-money-open-deal]");
    if (button && container()?.contains(button)) openDeal(button.dataset.moneyOpenDeal);
  });

  return { loadMoney };
}
