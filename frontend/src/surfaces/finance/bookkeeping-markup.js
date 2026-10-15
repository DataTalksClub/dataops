import "../../dakit/collection.js";
// Static shell for the bookkeeping surface. The page is the transaction
// list: header with the month navigator and actions, one filter row, the
// table with its detail pane. Files, the accountant package/VAT and
// forwarded invoices are secondary views (?view=…) reached from the ⋯ menu.
import { financeSectionHead, html } from "./shared.js";
import { periodNavMarkup } from "../period-nav.js";

const backLink = html`<button type="button" class="dk-button dk-button--secondary dk-button--sm bk-back" data-view-link="">
    ← Transactions
  </button>`;

export function bookkeepingSurfaceMarkup() {
  return html`<header class="dk-page-header bk-header">
      <div class="dk-page-header__main"><h1 class="dk-page-header__title">Bookkeeping</h1></div>
      <div class="period-toolbar bookkeeping-period" data-period-toolbar>
        ${periodNavMarkup({
          headingId: "bookkeeping-period-heading",
          todayLabel: "This month",
          groupLabel: "Change bookkeeping period",
          shortcuts: [
            { action: "current", label: "This month" },
            { action: "year", label: "Whole year" },
            { action: "all", label: "All records" },
          ],
        })}
      </div>
    </header>
    <p data-bookkeeping-status class="dk-toast bk-status" role="status"></p>
    <div class="bk-main dk-fill" data-bk-main>
      <div class="bk-filters" role="search" aria-label="Filter transactions" data-filters>
        <input class="dk-input bk-filters__search" type="search" data-filter="q" placeholder="Search counterparty, what, amount…" aria-label="Search transactions" />
        <button type="button" class="dk-button dk-button--secondary bk-filters__toggle" data-filters-toggle aria-expanded="false" aria-controls="bk-filters-more">
          Filters <span class="dk-mono" data-active-filters></span>
        </button>
        <div class="bk-filters__more" id="bk-filters-more">
          <select class="dk-select" data-filter="account" aria-label="Account"><option value="">All accounts</option></select>
          <select class="dk-select" data-filter="dir" aria-label="Money in or out">
            <option value="">In &amp; out</option>
            <option value="expense">Expenses</option>
            <option value="income">Income</option>
          </select>
          <select class="dk-select" data-filter="category" aria-label="Category"><option value="">All categories</option></select>
          <button type="button" class="bk-toggle" data-needs="category" aria-pressed="false">Needs category <span class="dk-mono" data-needs-count="category"></span></button>
          <button type="button" class="bk-toggle" data-needs="receipt" aria-pressed="false">No receipt <span class="dk-mono" data-needs-count="receipt"></span></button>
          <span class="bk-filters__count" data-shown-count aria-live="polite"></span>
        </div>
        ${globalThis.dakitCollection.createButtonMarkup({ label: "Add transaction", attributes: "data-bookkeeping-add" })}
        <details class="bk-more" data-more>
          <summary class="dk-icon-button" aria-label="More bookkeeping actions" title="More actions">
            <svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
              <circle cx="3" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="13" cy="8" r="1.4"/>
            </svg>
          </summary>
          <div class="dk-menu bk-more__menu" role="menu">
            <button type="button" class="dk-menu__item" role="menuitem" data-export-report-csv>Export accountant CSV</button>
            <button type="button" class="dk-menu__item" role="menuitem" data-copy-report>Copy accountant table</button>
            <button type="button" class="dk-menu__item" role="menuitem" data-export-full-csv>Export all fields (CSV)</button>
            <hr class="bk-more__rule" />
            <button type="button" class="dk-menu__item" role="menuitem" data-view-link="files">Files &amp; statements <span class="bk-more__meta" data-files-meta></span></button>
            <button type="button" class="dk-menu__item" role="menuitem" data-view-link="package">Accountant package &amp; VAT</button>
            <button type="button" class="dk-menu__item" role="menuitem" data-view-link="invoices">Forwarded invoices <span class="bk-more__meta" data-invoices-meta></span></button>
          </div>
        </details>
      </div>
      <div class="dk-split bk-split" data-bk-split data-view="list" data-pane="closed">
        <div class="dk-split__list bk-split__list">
          <div class="dk-split__scroll bk-scroll bookkeeping-ledger" aria-live="polite">Loading transactions…</div>
        </div>
        <aside class="dk-split__detail bk-detail" data-detail aria-labelledby="bk-detail-title" hidden></aside>
      </div>
    </div>
    <section id="bookkeeping-evidence" class="bookkeeping-section bookkeeping-evidence bk-secondary" data-secondary="files" aria-labelledby="bookkeeping-evidence-heading" hidden>
      ${backLink}
      ${financeSectionHead({
        id: "bookkeeping-evidence-heading",
        title: "Files & statements",
        hint: "Private PDFs, grouped by month. Attach a receipt to one transaction from its details.",
        actions: html`<button class="dk-button dk-button--secondary dk-button--sm" type="button" data-setup-accounts disabled>
          Set up business accounts
        </button>`,
      })}
      <details class="bookkeeping-upload-panel">
        <summary>Upload a PDF</summary>
        <div class="bookkeeping-upload">
          <label class="bookkeeping-file"
            >PDF
            <input type="file" accept="application/pdf,.pdf" data-pdf /></label
          ><label
            >Document type
            <select data-document-type>
              <option value="invoice">Invoice</option>
              <option value="receipt">Receipt</option>
              <option value="bank-statement">Bank statement</option>
              <option value="private-account-statement">
                Private account statement
              </option>
            </select></label
          ><label class="bookkeeping-statement-only" hidden
            >Account
            <select data-account>
              <option value="">No account</option>
            </select></label
          ><label class="bookkeeping-statement-only" hidden
            >Statement month <input type="month" data-statement-month /></label
          ><button class="dk-button dk-button--secondary" data-upload>Upload PDF</button>
        </div>
      </details>
      <div class="bookkeeping-documents" aria-live="polite">Loading documents…</div>
    </section>
    <section id="bookkeeping-package" class="bookkeeping-section bookkeeping-package-section bk-secondary"
      data-secondary="package" aria-labelledby="bookkeeping-package-heading" hidden>
      ${backLink}
      ${financeSectionHead({
        id: "bookkeeping-package-heading",
        title: "Accountant package",
        hint: "Pick the month with the navigator above.",
      })}
      <div class="bookkeeping-package-review" data-package-review></div>
      <div class="bookkeeping-private-statements" role="group" aria-labelledby="bookkeeping-private-statements-heading">
        <h3 id="bookkeeping-private-statements-heading" class="finance-subhead">
          Optional private-account statements
        </h3>
        <div data-private-statements>No eligible private statements.</div>
      </div>
      <div class="bookkeeping-package">
        <label>Report month <input type="month" data-report-month /></label
        ><button class="dk-button dk-button--secondary" data-report>
          Create monthly package
        </button>
      </div>
      ${financeSectionHead({
        id: "bookkeeping-vat-heading",
        title: "VAT summary",
        hint: "Tax and health-insurance payments are excluded from the package.",
        actions: html`<label class="finance-inline-field"
            >VAT year
            <select class="dk-select" data-vat-year><option value="">All years</option></select></label
          >`,
      })}
      <div class="bookkeeping-vat-summary" data-vat-summary aria-live="polite">
        Loading VAT summary…
      </div>
    </section>
    <section class="bookkeeping-section invoice-review-section bk-secondary" data-secondary="invoices" hidden>
      ${backLink}
      <div aria-labelledby="invoice-review-heading" data-invoice-review></div>
    </section>
    <dialog class="surface-dialog bookkeeping-entry-dialog">
      <form method="dialog" novalidate>
        <header>
          <h3>Add transaction</h3>
          <p>Fields marked * are required; everything else can be filled in later from the transaction's details.</p>
        </header>
        <div class="dialog-fields bookkeeping-entry-fields">
          <label
            ><span class="label-text">Date
            <span class="required-mark" aria-hidden="true">*</span></span>
            <input name="transactionDate" type="date" /></label
          ><label
            >Direction
            <select name="entryType">
              <option value="expense">Expense (money out)</option>
              <option value="income">Income (money in)</option>
            </select></label
          ><label class="span-all"
            ><span class="label-text">Counterparty
            <span class="required-mark" aria-hidden="true">*</span></span>
            <input name="counterparty" /></label
          ><label class="span-all"
            ><span class="label-text">What
            <span class="required-mark" aria-hidden="true">*</span></span>
            <input name="description" /></label
          ><label
            ><span class="label-text">Amount
            <span class="required-mark" aria-hidden="true">*</span></span>
            <input name="amount" inputmode="decimal" /></label
          ><label
            ><span class="label-text">Currency
            <span class="required-mark" aria-hidden="true">*</span></span>
            <input name="currency" maxlength="3" value="EUR" /></label
          ><label class="bookkeeping-eur-only" hidden
            ><span class="label-text">EUR value</span>
            <input name="amountEur" inputmode="decimal" /></label
          ><label
            >Account / statement <input name="statementRef" /></label
          >
          <small class="field-hint span-all">Enter amounts as positive numbers; Direction sets the sign.</small>
          <p class="span-all" role="alert" data-form-error></p>
        </div>
        <footer class="bookkeeping-actions">
          <button class="primary-button" data-save>Add transaction</button
          ><button value="cancel">Cancel</button>
        </footer>
      </form>
    </dialog>
    <dialog class="surface-dialog bookkeeping-delete-dialog">
      <form method="dialog">
        <header>
          <h3>Delete this transaction?</h3>
          <p>
            <strong data-delete-entry-name>This transaction</strong> will be
            permanently removed. Attached files are kept.
          </p>
        </header>
        <footer>
          <button type="button" class="danger-button" data-delete-confirm>
            Delete transaction</button
          ><button value="cancel" data-delete-cancel>Keep it</button>
        </footer>
      </form>
    </dialog>`;
}
