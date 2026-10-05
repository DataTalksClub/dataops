// Static shell for the bookkeeping surface: the month lens header, the
// ledger, evidence and package sections, and the entry/EUR/delete dialogs.
// All dynamic state renders into [data-close-state], [data-worklist],
// .bookkeeping-ledger, .bookkeeping-documents and [data-package-review].
import { html } from "./shared.js";

export function bookkeepingSurfaceMarkup() {
  return html` <header class="bookkeeping-header">
        <div>
          <p class="surface-eyebrow">Monthly close</p>
          <h1>Bookkeeping</h1>
          <p>
            One month at a time: record the transactions, attach the evidence,
            and close the month with a reviewable package.
          </p>
        </div>
        <button class="primary-button" data-bookkeeping-add>Add entry</button>
      </header>
      <section
        class="bookkeeping-monthlens"
        aria-label="Month close state"
        data-monthlens
      >
        <div class="bookkeeping-lens-nav">
          <button
            class="bookkeeping-lens-step"
            type="button"
            data-lens-prev
            aria-label="Previous month"
          >
            ‹
          </button>
          <label class="bookkeeping-lens-month"
            >Month <input type="month" data-lens-month
          /></label>
          <button
            class="bookkeeping-lens-step"
            type="button"
            data-lens-next
            aria-label="Next month"
          >
            ›
          </button>
          <button class="quiet-button" type="button" data-lens-toggle>
            All months
          </button>
        </div>
        <div class="bookkeeping-close-state" data-close-state></div>
      </section>
      <p data-bookkeeping-status class="surface-status" role="status"></p>
      <section
        class="bookkeeping-section bookkeeping-worklist-section"
        data-worklist-section
        aria-labelledby="bookkeeping-worklist-heading"
      >
        <header class="section-header">
          <div>
            <p class="section-kicker">Needs attention</p>
            <h3 id="bookkeeping-worklist-heading">
              Fix what the close is missing
            </h3>
            <p>
              Every open item for this month with its fix one click away — the
              monthly reconcile list, made actionable.
            </p>
          </div>
        </header>
        <div class="bookkeeping-worklist" data-worklist aria-live="polite"></div>
      </section>
      <section
        id="bookkeeping-ledger"
        class="bookkeeping-section bookkeeping-ledger-section"
        aria-labelledby="bookkeeping-ledger-heading"
      >
        <header class="section-header">
          <div>
            <p class="section-kicker">Ledger</p>
            <h3 id="bookkeeping-ledger-heading">
              Record and review the ledger
            </h3>
            <p>
              Transactions for the selected month. Open an entry only when it
              needs work.
            </p>
          </div>
          <p class="bookkeeping-totals" aria-live="polite"></p>
        </header>
        <div class="bookkeeping-filters">
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
        <header class="section-header">
          <div>
            <p class="section-kicker">Evidence</p>
            <h3 id="bookkeeping-evidence-heading">
              Match transaction evidence
            </h3>
            <p>
              Private PDFs grouped by month, each connected to the ledger entry
              it supports.
            </p>
          </div>
          <button class="quiet-button" data-setup-accounts>
            Set up business accounts
          </button>
        </header>
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
            ><button class="primary-button" data-upload>Upload PDF</button>
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
        <header class="section-header">
          <div>
            <p class="section-kicker">Monthly package</p>
            <h3 id="bookkeeping-package-heading">
              Close the month with a package
            </h3>
            <p>
              Review what the archive will contain — transactions, evidence,
              statements — before creating it.
            </p>
          </div>
        </header>
        <div class="bookkeeping-package-review" data-package-review></div>
        <fieldset class="bookkeeping-private-statements">
          <legend>Optional private-account statements</legend>
          <div data-private-statements>No eligible private statements.</div>
        </fieldset>
        <div class="bookkeeping-package">
          <label>Report month <input type="month" data-report-month /></label
          ><button class="primary-button" data-report>
            Create monthly package
          </button>
        </div>
        <section class="bookkeeping-vat" aria-labelledby="bookkeeping-vat-heading">
          <header class="section-header">
            <div>
              <h4 id="bookkeeping-vat-heading">VAT summary</h4>
              <p>
                Value-added tax recorded on income and expense entries. Tax and
                health-insurance entries stay out of the monthly package but
                their VAT payments appear here.
              </p>
            </div>
            <label
              >VAT year
              <select data-vat-year><option value="">All years</option></select></label
            >
          </header>
          <div class="bookkeeping-vat-summary" data-vat-summary aria-live="polite">
            Loading VAT summary…
          </div>
        </section>
      </section>
      <section class="bookkeeping-section invoice-review-section" data-invoice-review></section>
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
