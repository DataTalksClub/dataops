// Static shell for the bookkeeping surface: the month lens header, the
// ledger, evidence and package sections, and the entry/EUR/delete dialogs.
// All dynamic state renders into [data-close-state], [data-worklist],
// .bookkeeping-ledger, .bookkeeping-documents and [data-package-review].
import { financeSectionHead, html } from "./shared.js";
import { collectionCreateButtonMarkup, renderPageHeaderMarkup } from "../operations-overview.js";

export function bookkeepingSurfaceMarkup() {
  return html`${renderPageHeaderMarkup({
    title: "Bookkeeping",
    subtitle: "One month at a time: record the transactions, attach the evidence, and close the month with a reviewable package.",
    className: "bookkeeping-header",
  })}
      <section
        class="bookkeeping-monthlens"
        aria-label="Month close state"
        data-monthlens
      >
        <div class="bookkeeping-lens-nav">
          <button
            class="dk-icon-button bookkeeping-lens-step"
            type="button"
            data-lens-prev
            aria-label="Previous month"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m14 6-6 6 6 6"/></svg>
          </button>
          <label class="bookkeeping-lens-field"
            ><span class="dk-visually-hidden">Year</span>
            <select class="dk-select dk-mono" data-lens-year></select
          ></label>
          <label class="bookkeeping-lens-field"
            ><span class="dk-visually-hidden">Month</span>
            <select class="dk-select" data-lens-month-select></select
          ></label>
          <button
            class="dk-icon-button bookkeeping-lens-step"
            type="button"
            data-lens-next
            aria-label="Next month"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m10 6 6 6-6 6"/></svg>
          </button>
          <button class="dk-button dk-button--secondary bookkeeping-lens-all" type="button" data-lens-toggle>
            All months
          </button>
        </div>
        <div class="bookkeeping-close-state" data-close-state></div>
      </section>
      <p data-bookkeeping-status class="surface-status" role="status"></p>
      <details
        class="bookkeeping-section bookkeeping-worklist-section"
        data-worklist-section
        open
      >
        <summary class="bookkeeping-worklist-summary">
          ${financeSectionHead({
            id: "bookkeeping-worklist-heading",
            title: "Needs attention",
            hint: "Every open item for this month, each with its fix.",
            actions: html`<p class="bookkeeping-worklist-hint" data-worklist-hint></p>`,
          })}
        </summary>
        <div class="bookkeeping-worklist" data-worklist aria-live="polite"></div>
      </details>
      <section
        id="bookkeeping-ledger"
        class="bookkeeping-section bookkeeping-ledger-section"
        aria-labelledby="bookkeeping-ledger-heading"
      >
        ${financeSectionHead({
          id: "bookkeeping-ledger-heading",
          title: "Ledger",
          create: collectionCreateButtonMarkup({ label: "Add entry", attributes: "data-bookkeeping-add" }),
          hint: "Transactions for the selected period. Open an entry only when it needs work.",
          meta: html`<p class="bookkeeping-totals" aria-live="polite"></p>`,
          actions: html`<div class="bookkeeping-export-actions">
              <button
                class="dk-button dk-button--secondary dk-button--sm bookkeeping-export-btn"
                type="button"
                data-export-report-csv
                title="Export accountant report CSV (with signed EUR prices and report columns)"
              >
                Export report CSV
              </button>
              <button
                class="dk-button dk-button--secondary dk-button--sm bookkeeping-export-btn"
                type="button"
                data-copy-report
                title="Copy formatted report table to clipboard for email or spreadsheet"
              >
                Copy for report
              </button>
              <button
                class="dk-button dk-button--secondary dk-button--sm bookkeeping-export-btn"
                type="button"
                data-export-full-csv
                title="Export full raw ledger CSV"
              >
                Full CSV
              </button>
            </div>`,
        })}
        <div class="dk-toolbar bookkeeping-filters">
          <label
            >Search
            <input
              data-filter="search"
              type="search"
              placeholder="Provider, description, or category" /></label
          >
          <details>
            <summary>More filters</summary>
            <div class="bookkeeping-filter-more">
              <label>Type <input data-filter="entryType" /></label
              ><label>Category <input data-filter="category" /></label
              ><label
                >Provider / payee <input data-filter="counterparty" /></label
              ><label
                >Currency <input data-filter="currency" maxlength="3"
              /></label>
            </div>
          </details>
        </div>
        <div class="bookkeeping-ledger" aria-live="polite">Loading ledger…</div>
      </section>
      <section
        id="bookkeeping-evidence"
        class="bookkeeping-section bookkeeping-evidence"
        aria-labelledby="bookkeeping-evidence-heading"
      >
        ${financeSectionHead({
          id: "bookkeeping-evidence-heading",
          title: "Evidence",
          hint: "Private PDFs grouped by month, each linked to the ledger entry it supports.",
          actions: html`<button class="dk-button dk-button--secondary dk-button--sm" type="button" data-setup-accounts disabled>
            Set up business accounts
          </button>`,
        })}
        <details class="bookkeeping-upload-panel">
          <summary>Upload evidence PDF</summary>
          <div class="bookkeeping-upload">
            <label class="bookkeeping-file"
              >PDF evidence
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
            ><label class="bookkeeping-transaction-link"
              >Link to transaction
              <select data-transaction>
                <option value="">No transaction</option>
              </select></label
            ><button class="dk-button dk-button--secondary" data-upload>Upload PDF</button>
          </div>
        </details>
        <div class="bookkeeping-documents" aria-live="polite">
          Loading documents…
        </div>
      </section>
      <section
        id="bookkeeping-package"
        class="bookkeeping-section bookkeeping-package-section"
        aria-labelledby="bookkeeping-package-heading"
      >
        ${financeSectionHead({
          id: "bookkeeping-package-heading",
          title: "Monthly package",
          hint: "What the archive will contain, before you create it.",
        })}
        <div class="bookkeeping-package-review" data-package-review></div>
        <div
          class="bookkeeping-private-statements"
          role="group"
          aria-labelledby="bookkeeping-private-statements-heading"
        >
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
      </section>
      <section
        id="bookkeeping-vat"
        class="bookkeeping-section bookkeeping-vat"
        aria-labelledby="bookkeeping-vat-heading"
      >
        ${financeSectionHead({
          id: "bookkeeping-vat-heading",
          title: "VAT summary",
          hint: "VAT on income and expenses, including tax and health-insurance payments kept out of the package.",
          actions: html`<label class="finance-inline-field"
              >VAT year
              <select class="dk-select" data-vat-year><option value="">All years</option></select></label
            >`,
        })}
        <div class="bookkeeping-vat-summary" data-vat-summary aria-live="polite">
          Loading VAT summary…
        </div>
      </section>
      <section class="bookkeeping-section invoice-review-section" aria-labelledby="invoice-review-heading" data-invoice-review></section>
      <dialog class="surface-dialog bookkeeping-entry-dialog">
        <form method="dialog" novalidate>
          <header>
            <p class="surface-eyebrow">Ledger record</p>
            <h3>Bookkeeping entry</h3>
            <p>
              What happened, how much, and whether money moved in or out —
              that is the record. Fields marked * are required; everything
              else can wait.
            </p>
          </header>
          <div class="dialog-fields bookkeeping-entry-fields">
            <input type="hidden" name="id" /><label
              ><span class="label-text">Transaction date
              <span class="required-mark" aria-hidden="true">*</span></span>
              <input name="transactionDate" type="date" /></label
            ><label class="span-all"
              ><span class="label-text">Provider / payee
              <span class="required-mark" aria-hidden="true">*</span></span>
              <input name="counterparty" /></label
            ><label class="span-all"
              ><span class="label-text">Description
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
              ><span class="label-text">Actual EUR value</span>
              <input name="amountEur" inputmode="decimal" /></label
            ><label
              >Type
              <select name="entryType" data-entry-type>
                <option value="">Unclassified</option>
                <option value="expense">Expense — money out</option>
                <option value="income">Income — money in</option>
              </select></label
            >
            <small class="field-hint span-all"
              >Enter amounts as positive numbers; Type sets the direction. For
              non-EUR entries, the actual EUR value keeps the conversion
              defensible.</small
            >
            <details class="bookkeeping-entry-optional span-all">
              <summary>Optional details</summary>
              <div class="dialog-fields">
                <label>Paid date <input name="paidDate" type="date" /></label
                ><label
                  >VAT amount <input name="vatAmount" inputmode="decimal" /></label
                ><label
                  >VAT currency <input name="vatCurrency" maxlength="3" /></label
                ><label
                  >Category
                  <input name="category" list="bookkeeping-category-options" /></label
                ><label
                  >Statement / reference <input name="statementRef"
                /></label>
              </div>
            </details>
            <datalist
              id="bookkeeping-category-options"
              data-category-options
            ></datalist>
            <p class="span-all" role="alert" data-form-error></p>
          </div>
          <footer class="bookkeeping-actions">
            <button class="primary-button" data-save>Save</button
            ><button value="cancel">Cancel</button>
          </footer>
        </form>
      </dialog>
      <dialog class="surface-dialog bookkeeping-eur-dialog">
        <form method="dialog" novalidate>
          <header>
            <p class="surface-eyebrow">EUR conversion</p>
            <h3>Record the EUR value</h3>
            <p data-eur-context></p>
          </header>
          <div class="dialog-fields">
            <label
              ><span class="label-text">Actual EUR value
              <span class="required-mark" aria-hidden="true">*</span></span>
              <input name="amountEur" inputmode="decimal" /></label>
            <small class="field-hint span-all"
              >Use the settled bank value — a Revolut settlement or a dated
              historical rate keeps it defensible.</small
            >
            <p class="span-all" role="alert" data-eur-error></p>
          </div>
          <footer class="bookkeeping-actions">
            <button class="primary-button" data-eur-save>
              Save EUR value</button
            ><button value="cancel">Cancel</button>
          </footer>
        </form>
      </dialog>
      <dialog class="surface-dialog bookkeeping-delete-dialog">
        <form method="dialog">
          <header>
            <p class="surface-eyebrow">Destructive change</p>
            <h3>Delete bookkeeping entry?</h3>
            <p>
              <strong data-delete-entry-name>This ledger entry</strong> will be
              permanently removed. Linked evidence is not deleted.
            </p>
          </header>
          <footer>
            <button type="button" class="danger-button" data-delete-confirm>
              Delete entry</button
            ><button value="cancel" data-delete-cancel>Keep entry</button>
          </footer>
        </form>
      </dialog>`;
}
