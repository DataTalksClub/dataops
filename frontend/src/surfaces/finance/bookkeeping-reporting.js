// Package and VAT views for the bookkeeping surface.
import { expandReportEntries, formatAmount, monthLabel } from "./bookkeeping-format.js";
import { packageReviewMarkup } from "./bookkeeping-views.js";
import { html } from "./shared.js";

export function createBookkeepingReports({
  api,
  escapeHtml,
  getAccounts,
  getDocuments,
  getLens,
  getLinks,
  getReports,
  isReportExemptEntry,
  lensEntries,
  safeAction,
  surface,
}) {
  function renderPackageReview() {
    const lens = getLens();
    const accounts = getAccounts();
    const documents = getDocuments();
    const links = getLinks();
    const review = surface.querySelector("[data-package-review]");
    const reportInput = surface.querySelector("[data-report-month]");
    const isMonth = /^\d{4}-\d{2}$/.test(lens);
    reportInput.value = isMonth ? lens : "";
    surface.querySelector("[data-report]").disabled = !isMonth;
    if (!isMonth) {
      review.innerHTML = html`<div class="dk-empty dk-empty--compact">
          <p class="dk-empty__title">Choose a month</p>
          <p class="dk-empty__desc">The package follows the month picked in the navigator above.</p>
        </div>`;
      return;
    }
    const businessAccounts = accounts.filter(
      (account) =>
        account.kind === "business" &&
        account.active !== false &&
        (!account.statementRequiredFromMonth ||
          lens >= account.statementRequiredFromMonth) &&
        (!account.statementRequiredThroughMonth ||
          lens <= account.statementRequiredThroughMonth),
    );
    const monthEntries = lensEntries().filter((entry) => !isReportExemptEntry(entry));
    const reportRows = expandReportEntries(monthEntries);
    const excludedCount = lensEntries().filter(isReportExemptEntry).length;
    const linkedDocIds = new Set(
      links
        .filter((link) => monthEntries.some((entry) => entry.id === link.transactionId))
        .map((link) => String(link.documentId)),
    );
    for (const entry of monthEntries) {
      for (const alloc of Array.isArray(entry.allocations) ? entry.allocations : []) {
        if (alloc?.documentId) linkedDocIds.add(String(alloc.documentId));
      }
    }
    const evidenceDocs = documents.filter(
      (document) => document.documentType !== "bank-statement" && linkedDocIds.has(document.id),
    );
    const statementStates = businessAccounts.map((account) => ({
      account,
      hasStatement: documents.some(
        (document) =>
          document.documentType === "bank-statement" &&
          document.accountId === account.id &&
          document.statementMonth === lens,
      ),
    }));
    const missingStatements = statementStates.filter((state) => !state.hasStatement);
    const preflightRows = statementStates.map((state) =>
      html`<p class="preflight-row ${state.hasStatement ? "is-ok" : "is-blocked"}">
        ${state.hasStatement ? "✓" : "✗"} Bank statement —
        ${escapeHtml(state.account.displayName)}
      </p>`,
    );
    if (businessAccounts.length < 2)
      preflightRows.push(
        html`<p class="dk-callout dk-callout--warning">
          Set up two business accounts under Files &amp; statements before preparing a monthly package.
        </p>`,
      );
    const preflightNote = missingStatements.length
      ? html`<p class="preflight-note">
          The accountant package needs each business account's statement
          for ${escapeHtml(monthLabel(lens))}. Upload them under Files &amp; statements
          (document type “Bank statement”).
        </p>`
      : "";
    const report = getReports().find(
      (item) => item.month === lens && ["ready", "generated"].includes(String(item.status)),
    );
    const reportRowSummary =
      reportRows.length !== monthEntries.length
        ? html` · <span class="dk-mono">${reportRows.length}</span>&nbsp;report row${reportRows.length === 1 ? "" : "s"}`
        : "";
    const preview = html`<span class="dk-mono">${monthEntries.length}</span>&nbsp;transaction${monthEntries.length === 1 ? "" : "s"}${reportRowSummary} ·
      <span class="dk-mono">${evidenceDocs.length}</span>&nbsp;linked document${evidenceDocs.length === 1 ? "" : "s"}
      · <span class="dk-mono">${excludedCount}</span>&nbsp;mandatory-payment ${excludedCount === 1 ? "entry" : "entries"} kept out`;
    review.innerHTML = packageReviewMarkup({
      title: monthLabel(lens),
      preflightRows,
      preflightNote,
      preview,
      ready: report
        ? {
            id: report.id,
            transactionCount:
              report.reconciliation?.transactionCount ?? monthEntries.length,
            documentCount: report.reconciliation?.documentCount ?? "—",
          }
        : null,
      e: escapeHtml,
    });
  }

  async function renderVat() {
    const yearSelect = surface.querySelector("[data-vat-year]");
    const summary = surface.querySelector("[data-vat-summary]");
    const year = yearSelect.value;
    summary.textContent = "Loading VAT summary…";
    await safeAction(async () => {
      const vat = await api(
        `/reports/vat${year ? `?year=${encodeURIComponent(year)}` : ""}`,
      );
      const months = vat.months || [];
      summary.innerHTML = months.length
        ? html`<div class="bookkeeping-table-wrap">
            <table class="dk-table">
              <thead>
                <tr>
                  <th>Month</th>
                  <th>Currency</th>
                  <th>Output VAT</th>
                  <th>Input VAT</th>
                  <th>Net</th>
                  <th>Entries</th>
                </tr>
              </thead>
              <tbody>
                ${months
                  .map(
                    (month) =>
                      html`<tr>
                        <td data-label="Month">${escapeHtml(month.month)}</td>
                        <td data-label="Currency">${escapeHtml(month.currency)}</td>
                        <td data-label="Output VAT" class="ledger-amount">
                          ${escapeHtml(formatAmount(month.outputVat, month.currency))}
                        </td>
                        <td data-label="Input VAT" class="ledger-amount">
                          ${escapeHtml(formatAmount(month.inputVat, month.currency))}
                        </td>
                        <td data-label="Net" class="ledger-amount">
                          ${escapeHtml(formatAmount(month.net, month.currency))}
                        </td>
                        <td data-label="Entries">${month.transactionCount}</td>
                      </tr>`,
                  )
                  .join("")}
              </tbody>
            </table>
          </div>`
        : html`<div class="dk-empty dk-empty--compact">
            <p class="dk-empty__title">
              No VAT recorded${year ? ` in ${escapeHtml(year)}` : ""}
            </p>
          </div>`;
    }, "Could not load VAT summary");
  }

  return { renderPackageReview, renderVat };
}
