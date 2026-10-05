import { bookkeepingSurfaceMarkup } from "./bookkeeping-markup.js";
import {
  accountOptionsMarkup,
  closeStateAllMarkup,
  closeStateMonthMarkup,
  documentGroupsMarkup,
  ledgerTableMarkup,
  packageReviewMarkup,
  transactionOptionsMarkup,
  worklistMarkup,
} from "./bookkeeping-views.js";
import { mountInvoiceReview } from "./invoices.js";
import { html } from "./shared.js";
import {
  entryDirection,
  FIELD_LABELS,
  latestActivityMonth,
  ledgerDate,
  MONEY_PATTERN,
  monthLabel,
  monthOf,
  shiftMonth,
} from "./bookkeeping-format.js";

// Categories the backend keeps out of the monthly package (private-money
// payments reported separately); mirrored so the package review can say what
// will be excluded before anything is created.
const REPORT_EXEMPT_CATEGORIES = new Set(["Taxes", "Health Insurance"]);

function focusFirstUsableControl(dialog) {
  const control = dialog.querySelector(
    [
      'input:not([type="hidden"]):not([disabled]):not([hidden])',
      'select:not([disabled]):not([hidden])',
      'textarea:not([disabled]):not([hidden])',
      'button:not([disabled]):not([hidden])',
      'a[href]:not([hidden])',
    ].join(","),
  );
  control?.focus();
}

function openDialog(dialog) {
  dialog.showModal();
  focusFirstUsableControl(dialog);
}

export function createBookkeepingSurface(context) {
  const {
    documentList,
    escapeHtml,
    humanizeOptionLabel,
    request,
    setRouteTitle,
    todayIsoDate,
    workApiUrl,
  } = context;

  async function renderBookkeepingSurface() {
    documentList.replaceChildren();
    const surface = document.createElement("section");
    surface.className = "bookkeeping-surface";
    surface.innerHTML = bookkeepingSurfaceMarkup();
    documentList.append(surface);
    setRouteTitle("Bookkeeping");
    await mountInvoiceReview(surface.querySelector("[data-invoice-review]"), context);

    let entries = [],
      documents = [],
      links = [],
      accounts = [],
      reports = [];
    // The lens is the month being closed ("YYYY-MM") or "all" for the
    // all-time lookup view. It opens on the month that has work.
    let lens = "";
    const ledger = surface.querySelector(".bookkeeping-ledger"),
      totals = surface.querySelector(".bookkeeping-totals"),
      closeState = surface.querySelector("[data-close-state]"),
      worklist = surface.querySelector("[data-worklist]"),
      worklistSection = surface.querySelector("[data-worklist-section]"),
      lensInput = surface.querySelector("[data-lens-month]"),
      entryDialog = surface.querySelector(".bookkeeping-entry-dialog"),
      eurDialog = surface.querySelector(".bookkeeping-eur-dialog"),
      form = entryDialog.querySelector("form"),
      status = surface.querySelector("[data-bookkeeping-status]");
    const api = (path, options = {}) =>
      request(workApiUrl(`/api/bookkeeping${path}`), {
        headers: {
          "content-type": "application/json",
          ...(options.headers || {}),
        },
        ...options,
      });
    async function safeAction(action, fallback) {
      try {
        await action();
      } catch (error) {
        status.textContent = `${fallback}: ${error.message}`;
      }
    }
    function openPrivateDownload(url) {
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener";
      link.click();
    }
    const lensEntries = () =>
      lens === "all" ? entries : entries.filter((e) => monthOf(e) === lens);
    const hasEvidence = (id) =>
      links.some((l) => l.transactionId === id && l.coverageType === "evidence");
    const isExempt = (entry) =>
      REPORT_EXEMPT_CATEGORIES.has(String(entry.category || ""));
    // What still stands between this month and its package.
    function openItems(monthEntries) {
      return {
        missingEvidence: monthEntries.filter((e) => !hasEvidence(e.id)),
        conversions: monthEntries.filter(
          (e) => e.currency !== "EUR" && !String(e.amountEur || "").trim(),
        ),
        unclassified: monthEntries.filter((e) => !entryDirection(e)),
      };
    }
    function monthReport() {
      return reports.find(
        (r) =>
          r.month === lens && ["ready", "generated"].includes(String(r.status)),
      );
    }
    function setLens(month, { resetInput = true } = {}) {
      lens = month;
      if (resetInput && month !== "all") lensInput.value = month;
      renderAll();
    }
    function renderAll() {
      renderCloseState();
      renderWorklist();
      renderLedger();
      renderPackageReview();
    }
    function renderCloseState() {
      const lensSection = surface.querySelector("[data-monthlens]");
      lensSection.classList.toggle("is-lens-all", lens === "all");
      surface.querySelector("[data-lens-toggle]").textContent =
        lens === "all" ? "Back to month view" : "All months";
      if (lens === "all") {
        closeState.innerHTML = closeStateAllMarkup(entries.length);
        return;
      }
      const monthEntries = lensEntries();
      const open = openItems(monthEntries);
      const openCount =
        open.missingEvidence.length +
        open.conversions.length +
        open.unclassified.length;
      const report = monthReport();
      closeState.innerHTML = closeStateMonthMarkup({
        title: monthLabel(lens),
        transactions: monthEntries.length,
        missingEvidence: open.missingEvidence.length,
        conversions: open.conversions.length,
        packageReady: Boolean(report),
        cta: !monthEntries.length
          ? { kind: "add" }
          : openCount
            ? { kind: "worklist", count: openCount }
            : report
              ? { kind: "download" }
              : { kind: "package" },
        e: escapeHtml,
      });
    }
    function renderWorklist() {
      worklistSection.hidden = lens === "all";
      if (lens === "all") return;
      const open = openItems(lensEntries());
      worklist.innerHTML = worklistMarkup({
        rows: [
          ...open.missingEvidence.map((entry) => ({ kind: "evidence", entry })),
          ...open.conversions.map((entry) => ({ kind: "eur", entry })),
          ...open.unclassified.map((entry) => ({ kind: "classify", entry })),
        ],
        monthTitle: monthLabel(lens),
        e: escapeHtml,
      });
    }
    function renderLedger() {
      const filters = Object.fromEntries(
        [...surface.querySelectorAll("[data-filter]")].map((el) => [
          el.dataset.filter,
          el.value.trim(),
        ]),
      );
      const shown = lensEntries().filter(
        (e) =>
          (!filters.entryType ||
            String(e.entryType || "")
              .toLowerCase()
              .includes(filters.entryType.toLowerCase())) &&
          (!filters.category ||
            String(e.category || "")
              .toLowerCase()
              .includes(filters.category.toLowerCase())) &&
          (!filters.counterparty ||
            e.counterparty
              .toLowerCase()
              .includes(filters.counterparty.toLowerCase())) &&
          (!filters.currency ||
            e.currency === filters.currency.toUpperCase()) &&
          (!filters.search ||
            [e.counterparty, e.description, e.category, e.entryType]
              .join(" ")
              .toLowerCase()
              .includes(filters.search.toLowerCase())),
      );
      const sums = {};
      shown.forEach((e) => {
        const bucket = (sums[e.currency] ??= {
          income: 0,
          expense: 0,
          unclassified: 0,
        });
        const amount = Number(e.amount);
        const direction = entryDirection(e);
        if (direction === "income") bucket.income += amount;
        else if (direction === "expense") bucket.expense += amount;
        else bucket.unclassified += amount;
      });
      totals.textContent =
        Object.entries(sums)
          .flatMap(([currency, s]) => [
            ...(s.income ? [`${currency} Income ${s.income.toFixed(2)}`] : []),
            ...(s.expense
              ? [`${currency} Expenses ${s.expense.toFixed(2)}`]
              : []),
            ...(s.unclassified
              ? [`${currency} Unclassified ${s.unclassified.toFixed(2)}`]
              : []),
          ])
          .join(" · ") || "No filtered total";
      ledger.innerHTML = ledgerTableMarkup({
        shown,
        hasEvidence,
        lensTitle: lens === "all" ? "" : monthLabel(lens),
        e: escapeHtml,
      });
    }
    // Category suggestions and type options stay seeded from the ledger so
    // the dialog cannot grow duplicate vocabularies like "Income"/"income".
    // Types seed from the raw stored values, deduped case-insensitively, so
    // editing keeps whatever wording the ledger already uses; classification
    // itself is entryDirection's job.
    let entryTypeChoices = ["", "expense", "income"];
    function refreshVocabulary() {
      const categories = [
        ...new Set(
          entries.map((e) => String(e.category || "").trim()).filter(Boolean),
        ),
      ].sort((a, b) => a.localeCompare(b));
      surface.querySelector("[data-category-options]").innerHTML = categories
        .map((category) => html`<option value="${escapeHtml(category)}"></option>`)
        .join("");
      const typeChoices = ["", "expense", "income"];
      entries.forEach((e) => {
        const stored = String(e.entryType || "").trim();
        if (
          stored &&
          !typeChoices.some(
            (option) => option.toLowerCase() === stored.toLowerCase(),
          )
        )
          typeChoices.push(stored);
      });
      entryTypeChoices = typeChoices;
      surface.querySelector("[data-entry-type]").innerHTML = typeChoices
        .map((option) =>
          html`<option value="${escapeHtml(option)}">
            ${escapeHtml(
              option === "expense"
                ? "Expense — money out"
                : option === "income"
                  ? "Income — money in"
                  : option === ""
                    ? "Unclassified"
                    : option,
            )}
          </option>`,
        )
        .join("");
    }
    // The evidence link select only offers the lens month's transactions,
    // entries missing evidence first — the operator picks from what the
    // close actually needs instead of an all-time list.
    function renderTransactionOptions() {
      const scoped = [...lensEntries()].sort((a, b) => {
        const aMissing = hasEvidence(a.id) ? 1 : 0;
        const bMissing = hasEvidence(b.id) ? 1 : 0;
        return (
          aMissing - bMissing ||
          String(a.transactionDate).localeCompare(String(b.transactionDate))
        );
      });
      surface.querySelector("[data-transaction]").innerHTML =
        transactionOptionsMarkup(scoped, escapeHtml);
    }
    // Evidence documents grouped by the month they belong to: statement
    // month for statements, the linked transaction's month otherwise.
    function documentMonth(d) {
      if (/^\d{4}-\d{2}$/.test(String(d.statementMonth || "")))
        return d.statementMonth;
      const linked = links.find((l) => l.documentId === d.id);
      const transaction = linked && entries.find((e) => e.id === linked.transactionId);
      return transaction ? monthOf(transaction) : "";
    }
    function renderDocuments() {
      const groups = new Map();
      documents.forEach((d) => {
        const month = documentMonth(d);
        (groups.get(month) ?? groups.set(month, []).get(month)).push(d);
      });
      const ordered = [...groups.keys()].sort((a, b) =>
        a === "" ? 1 : b === "" ? -1 : b.localeCompare(a),
      );
      const documentsHost = surface.querySelector(".bookkeeping-documents");
      if (!documents.length) {
        documentsHost.innerHTML = html`<div class="honest-state">
            <strong>No private documents uploaded</strong>
            <p>Open “Upload evidence PDF” to add the first piece of evidence.</p>
          </div>`;
        return;
      }
      documentsHost.innerHTML =
        `<p class="bookkeeping-download-hint">Downloads are private and expire after five minutes.</p>` +
        documentGroupsMarkup({
          groups: ordered.map((month) => ({
            month: month ? monthLabel(month) : "",
            docs: groups.get(month).map((d) => ({
              ...d,
              links: links
                .filter((l) => l.documentId === d.id)
                .map((l) => ({
                  ...l,
                  transaction: entries.find((e) => e.id === l.transactionId),
                })),
            })),
          })),
          e: escapeHtml,
          humanizeOptionLabel,
        });
    }
    function renderPackageReview() {
      const review = surface.querySelector("[data-package-review]");
      const reportInput = surface.querySelector("[data-report-month]");
      reportInput.value = lens === "all" ? "" : lens;
      if (lens === "all") {
        review.innerHTML = html`<div class="honest-state">
            <strong>Choose a month to review</strong>
            <p>
              Pick a month with the lens above — the package review follows the
              month being closed.
            </p>
          </div>`;
        return;
      }
      const businessAccounts = accounts.filter(
        (a) => a.kind === "business" && a.active !== false,
      );
      const monthEntries = lensEntries().filter((e) => !isExempt(e));
      const excludedCount = lensEntries().filter(isExempt).length;
      const linkedDocIds = new Set(
        links
          .filter((l) => monthEntries.some((e) => e.id === l.transactionId))
          .map((l) => String(l.documentId)),
      );
      const evidenceDocs = documents.filter(
        (d) => d.documentType !== "bank-statement" && linkedDocIds.has(d.id),
      );
      const statementStates = businessAccounts.map((a) => ({
        account: a,
        hasStatement: documents.some(
          (d) =>
            d.documentType === "bank-statement" &&
            d.accountId === a.id &&
            d.statementMonth === lens,
        ),
      }));
      const missingStatements = statementStates.filter((s) => !s.hasStatement);
      const preflightRows = statementStates.map((s) =>
        html`<p class="preflight-row ${s.hasStatement ? "is-ok" : "is-blocked"}">
          ${s.hasStatement ? "✓" : "✗"} Bank statement —
          ${escapeHtml(s.account.displayName)}
        </p>`,
      );
      if (businessAccounts.length < 2)
        preflightRows.push(
          html`<p class="preflight-row is-blocked">
            ✗ Two business accounts are required; set them up in Evidence.
          </p>`,
        );
      const preflightNote = missingStatements.length
        ? html`<p class="preflight-note">
            The accountant package needs each business account's statement
            for ${escapeHtml(monthLabel(lens))} — upload them under Evidence
            (document type “Bank statement”).
          </p>`
        : "";
      const report = monthReport();
      const preview = html`${monthEntries.length} transaction${monthEntries.length === 1 ? "" : "s"} ·
        ${evidenceDocs.length} linked evidence document${evidenceDocs.length === 1 ? "" : "s"}
        · ${excludedCount} tax/health-insurance ${excludedCount === 1 ? "entry" : "entries"} kept out`;
      review.innerHTML = packageReviewMarkup({
        title: monthLabel(lens),
        preflightRows,
        preflightNote,
        preview,
        ready: report
          ? {
              id: report.id,
              transactionCount:
                report.reconciliation?.transactionCount ??
                monthEntries.length,
              documentCount: report.reconciliation?.documentCount ?? "—",
            }
          : null,
        e: escapeHtml,
      });
    }
    async function refreshEvidence() {
      const [docResult, linkResult, accountResult, reportResult] =
        await Promise.all([
          api("/documents"),
          api("/links"),
          api("/accounts"),
          api("/reports"),
        ]);
      documents = docResult.items || [];
      links = linkResult.items || [];
      accounts = accountResult.items || [];
      reports = reportResult.items || [];
      refreshVocabulary();
      renderTransactionOptions();
      const setupButton = surface.querySelector("[data-setup-accounts]");
      setupButton.disabled = accounts.length > 0;
      if (accounts.length)
        setupButton.textContent = "Business accounts ready";
      surface.querySelector("[data-account]").innerHTML =
        accountOptionsMarkup(accounts, escapeHtml);
      renderDocuments();
      renderCloseState();
      renderWorklist();
      renderLedger();
      renderPackageReview();
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
              <table>
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
                      (m) =>
                        html`<tr>
                          <td data-label="Month">${escapeHtml(m.month)}</td>
                          <td data-label="Currency">${escapeHtml(m.currency)}</td>
                          <td data-label="Output VAT" class="ledger-amount">
                            ${m.outputVat.toFixed(2)}
                          </td>
                          <td data-label="Input VAT" class="ledger-amount">
                            ${m.inputVat.toFixed(2)}
                          </td>
                          <td data-label="Net" class="ledger-amount">
                            ${m.net.toFixed(2)}
                          </td>
                          <td data-label="Entries">${m.transactionCount}</td>
                        </tr>`,
                    )
                    .join("")}
                </tbody>
              </table>
            </div>`
          : html`<div class="honest-state">
              <strong>
                No VAT recorded${year ? ` in ${escapeHtml(year)}` : ""}
              </strong>
              <p>
                Set a VAT amount on income or expense entries to build the VAT
                report.
              </p>
            </div>`;
      }, "Could not load VAT summary");
    }
    function replaceEntry(saved) {
      entries = entries.some((e) => e.id === saved.id)
        ? entries.map((e) => (e.id === saved.id ? saved : e))
        : [saved, ...entries];
      refreshVocabulary();
      renderAll();
    }
    function attachEvidenceFor(id) {
      const item = entries.find((e) => e.id === id);
      renderTransactionOptions();
      surface.querySelector("[data-transaction]").value = id;
      const panel = surface.querySelector(".bookkeeping-upload-panel");
      panel.open = true;
      surface.querySelector("#bookkeeping-evidence").scrollIntoView({ block: "start" });
      surface.querySelector("[data-pdf]").focus();
      status.textContent = `Attach evidence for ${item?.counterparty || "this entry"}.`;
    }
    function openEurDialog(id) {
      const item = entries.find((e) => e.id === id);
      if (!item) return;
      eurDialog.dataset.id = id;
      eurDialog.querySelector("form").reset();
      eurDialog.querySelector("[data-eur-error]").textContent = "";
      eurDialog.querySelector("[data-eur-context]").textContent =
        `${item.counterparty} — ${item.amount} ${item.currency}, ${ledgerDate(item.transactionDate)}.`;
      openDialog(eurDialog);
    }
    async function saveEurValue() {
      await safeAction(async () => {
        const value = String(
          eurDialog.querySelector("input[name=amountEur]").value,
        ).trim();
        const errorNote = eurDialog.querySelector("[data-eur-error]");
        errorNote.textContent = "";
        if (!MONEY_PATTERN.test(value)) {
          errorNote.textContent =
            "Enter the EUR value as a positive number, e.g. 184.30.";
          return;
        }
        const saved = await api(`/transactions/${eurDialog.dataset.id}`, {
          method: "PUT",
          body: JSON.stringify({ amountEur: value }),
        });
        eurDialog.close();
        replaceEntry(saved);
        status.textContent = "EUR value recorded; the conversion is closed.";
      }, "Could not save the EUR value");
    }
    const eurForm = eurDialog.querySelector("form");
    eurForm.addEventListener("submit", (event) => {
      event.preventDefault();
      saveEurValue();
    });
    eurDialog
      .querySelector("[data-eur-save]")
      .addEventListener("click", (event) => {
        event.preventDefault();
        saveEurValue();
      });
    try {
      const result = await api("/transactions");
      entries = result.items || [];
      lens = latestActivityMonth(
        entries,
        String(todayIsoDate?.() || new Date().toISOString()).slice(0, 7),
      );
      lensInput.value = lens;
      const years = [
        ...new Set(entries.map((e) => e.transactionDate.slice(0, 4))),
      ]
        .sort()
        .reverse();
      const vatYears = surface.querySelector("[data-vat-year]");
      vatYears.insertAdjacentHTML(
        "beforeend",
        years.map((y) => html`<option>${y}</option>`).join(""),
      );
      vatYears.value = years[0] || "";
      renderAll();
      await refreshEvidence();
      await renderVat();
    } catch (error) {
      ledger.textContent = `Could not load bookkeeping: ${error.message}`;
      surface.querySelector(".bookkeeping-documents").textContent =
        "Could not load private documents.";
      status.textContent = "Retry by reopening Bookkeeping.";
    }
    surface
      .querySelectorAll("[data-filter]")
      .forEach((el) => el.addEventListener("input", renderLedger));
    surface
      .querySelector("[data-vat-year]")
      .addEventListener("change", renderVat);
    const stepLens = (step) => {
      if (lens !== "all") setLens(shiftMonth(lens, step));
    };
    surface.querySelector("[data-lens-prev]").addEventListener("click", () => stepLens(-1));
    surface.querySelector("[data-lens-next]").addEventListener("click", () => stepLens(1));
    lensInput.addEventListener("change", () => {
      if (/^\d{4}-\d{2}$/.test(lensInput.value)) setLens(lensInput.value);
    });
    surface
      .querySelector("[data-lens-toggle]")
      .addEventListener("click", () => {
        setLens(
          lens === "all"
            ? latestActivityMonth(
                entries,
                String(todayIsoDate?.() || new Date().toISOString()).slice(0, 7),
              )
            : "all",
          { resetInput: false },
        );
      });
    closeState.addEventListener("click", (event) => {
      if (event.target.closest("[data-cta-add]")) {
        form.reset();
        form.elements.currency.value = "EUR";
        form.elements.entryType.value = "expense";
        form.elements.transactionDate.value = `${lens}-01`;
        entryDialog.querySelector("h3").textContent = "Add ledger entry";
        openDialog(entryDialog);
      }
      if (event.target.closest("[data-cta-worklist]"))
        worklistSection.scrollIntoView({ block: "start" });
      if (event.target.closest("[data-cta-package]"))
        surface.querySelector("#bookkeeping-package").scrollIntoView({ block: "start" });
      if (event.target.closest("[data-cta-download]") && monthReport())
        safeAction(async () => {
          const archive = await api(
            `/reports/${monthReport().id}/archive`,
            { method: "POST" },
          );
          openPrivateDownload(archive.downloadUrl);
        }, "Could not download the package");
    });
    surface
      .querySelector("[data-bookkeeping-add]")
      .addEventListener("click", () => {
        form.reset();
        form.elements.currency.value = "EUR";
        form.elements.entryType.value = "expense";
        if (lens !== "all") form.elements.transactionDate.value = `${lens}-01`;
        entryDialog.querySelector("h3").textContent = "Add ledger entry";
        openDialog(entryDialog);
      });
    form.addEventListener("input", (event) => {
      const field = event.target;
      field.removeAttribute("aria-invalid");
      field.closest?.("label")?.querySelector(".field-error")?.remove();
      surface.querySelector("[data-form-error]").textContent = "";
      if (field.name === "currency")
        surface.querySelector(".bookkeeping-eur-only").hidden =
          field.value.trim().toUpperCase() === "EUR";
    });
    worklist.addEventListener("click", (event) => {
      const attach = event.target.closest("[data-attach-evidence]")?.dataset
        .attachEvidence;
      const addEur = event.target.closest("[data-add-eur]")?.dataset.addEur;
      if (attach) attachEvidenceFor(attach);
      if (addEur) openEurDialog(addEur);
    });
    worklist.addEventListener("change", (event) => {
      const classify = event.target.closest("[data-classify]");
      if (!classify || !classify.value) return;
      safeAction(async () => {
        const saved = await api(
          `/transactions/${classify.dataset.classify}`,
          { method: "PUT", body: JSON.stringify({ entryType: classify.value }) },
        );
        replaceEntry(saved);
        status.textContent = "Entry classified.";
      }, "Could not classify entry");
    });
    ledger.addEventListener("click", (event) => {
      const edit = event.target.closest("[data-edit]")?.dataset.edit,
        del = event.target.closest("[data-delete]")?.dataset.delete,
        attach = event.target.closest("[data-attach-evidence]")
          ?.dataset.attachEvidence;
      if (edit) {
        const item = entries.find((e) => e.id === edit);
        Object.keys(item).forEach((k) => {
          if (form.elements[k]) form.elements[k].value = item[k] || "";
        });
        // Selects only accept their option values; match the stored type
        // case-insensitively onto the seeded options, keep untyped entries
        // unclassified instead of guessing, and preserve stored wording that
        // is not seeded by adding its option first.
        const storedType = String(item.entryType || "").trim();
        const seededType = entryTypeChoices.find(
          (option) => option.toLowerCase() === storedType.toLowerCase(),
        );
        if (!seededType && storedType) {
          entryTypeChoices.push(storedType);
          surface
            .querySelector("[data-entry-type]")
            .insertAdjacentHTML(
              "beforeend",
              `<option value="${escapeHtml(storedType)}">${escapeHtml(storedType)}</option>`,
            );
        }
        form.elements.entryType.value = seededType || storedType;
        surface.querySelector(".bookkeeping-eur-only").hidden =
          String(item.currency || "").toUpperCase() === "EUR";
        entryDialog.querySelector("h3").textContent = "Edit ledger entry";
        openDialog(entryDialog);
      }
      if (del) {
        const dialog = surface.querySelector(".bookkeeping-delete-dialog"),
          item = entries.find((e) => e.id === del);
        dialog.dataset.id = del;
        dialog.querySelector("[data-delete-entry-name]").textContent =
          item?.counterparty || "This ledger entry";
        openDialog(dialog);
      }
      if (attach) attachEvidenceFor(attach);
    });
    surface.querySelector("[data-save]").addEventListener("click", (event) => {
      event.preventDefault();
      safeAction(async () => {
        const clearFieldErrors = () => {
          form.querySelectorAll(".field-error").forEach((note) => note.remove());
          form
            .querySelectorAll("[aria-invalid]")
            .forEach((field) => field.removeAttribute("aria-invalid"));
          surface.querySelector("[data-form-error]").textContent = "";
        };
        // Messages render inside the failing field's label so the operator
        // sees which value to fix; the summary repeats the first one.
        const showFieldErrors = (errors) => {
          let firstField = null;
          errors.forEach(({ name, message }) => {
            const field = form.elements[name];
            if (!field) return;
            field.setAttribute("aria-invalid", "true");
            const label = field.closest?.("label");
            if (label) {
              let note = label.querySelector(".field-error");
              if (!note) {
                note = document.createElement("small");
                note.className = "field-error";
                label.append(note);
              }
              note.textContent = message;
            }
            if (!firstField) {
              firstField = field;
              surface.querySelector("[data-form-error]").textContent = message;
            }
          });
          firstField?.focus();
        };
        clearFieldErrors();
        const data = Object.fromEntries(
          [...new FormData(form)]
            .map(([key, value]) => [key, String(value).trim()])
            .filter(([, v]) => v !== ""),
        );
        const errors = [
          "transactionDate",
          "counterparty",
          "description",
          "amount",
          "currency",
        ]
          .filter((name) => !data[name])
          .map((name) => ({
            name,
            message: `${FIELD_LABELS[name]} is required.`,
          }));
        for (const name of ["amount", "vatAmount", "amountEur"])
          if (data[name] !== undefined && !MONEY_PATTERN.test(data[name]))
            errors.push({
              name,
              message: `${FIELD_LABELS[name] || "Actual EUR value"} must be a positive number — no minus sign or currency symbol. The Type field records the direction.`,
            });
        if (errors.length) {
          showFieldErrors(errors);
          return;
        }
        data.currency = data.currency.toUpperCase();
        if (data.vatCurrency)
          data.vatCurrency = data.vatCurrency.toUpperCase();
        if (data.entryType)
          data.entryType = data.entryType.toLowerCase();
        const id = form.elements.id.value;
        let saved;
        try {
          saved = await api(`/transactions${id ? `/${id}` : ""}`, {
            method: id ? "PUT" : "POST",
            body: JSON.stringify(data),
          });
        } catch (error) {
          const rejected = error?.payload?.fields;
          if (Array.isArray(rejected) && rejected.length) {
            showFieldErrors(
              rejected.map((name) => ({
                name,
                message: `${FIELD_LABELS[name] || name} was rejected. Fix this field and save again.`,
              })),
            );
            surface.querySelector("[data-form-error]").textContent =
              `The API rejected: ${rejected.map((name) => FIELD_LABELS[name] || name).join(", ")}. Fix the highlighted fields and save again.`;
            return;
          }
          throw error;
        }
        entryDialog.close();
        replaceEntry(saved);
        if (saved.currency !== "EUR" && !String(saved.amountEur || "").trim())
          status.textContent =
            "Entry saved. Add the EUR value from the worklist when the bank settles.";
      }, "Could not save entry");
    });
    surface
      .querySelector("[data-delete-cancel]")
      .addEventListener("click", () =>
        surface.querySelector(".bookkeeping-delete-dialog").close(),
      );
    surface
      .querySelector("[data-delete-confirm]")
      .addEventListener("click", () =>
        safeAction(async () => {
          const dialog = surface.querySelector(".bookkeeping-delete-dialog");
          await api(`/transactions/${dialog.dataset.id}`, { method: "DELETE" });
          entries = entries.filter((e) => e.id !== dialog.dataset.id);
          dialog.close();
          renderAll();
        }, "Could not delete entry"),
      );
    surface
      .querySelector("[data-setup-accounts]")
      .addEventListener("click", () =>
        safeAction(async () => {
          const result = await api("/accounts/setup", { method: "POST" });
          status.textContent = `${result.accounts.length} business accounts ready.`;
          await refreshEvidence();
        }, "Could not set up accounts"),
      );
    surface
      .querySelector("[data-document-type]")
      .addEventListener("change", (event) => {
        const statement = ["bank-statement", "private-account-statement"].includes(
          event.target.value,
        );
        surface
          .querySelectorAll(".bookkeeping-statement-only")
          .forEach((label) => {
            label.hidden = !statement;
          });
      });
    surface.querySelector("[data-upload]").addEventListener("click", () =>
      safeAction(async () => {
        const file = surface.querySelector("[data-pdf]").files[0];
        if (!file) {
          status.textContent = "Choose a PDF first.";
          return;
        }
        const bytes = await file.arrayBuffer(),
          sha256 = [
            ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
          ]
            .map((value) => value.toString(16).padStart(2, "0"))
            .join(""),
          idempotencyKey = crypto.randomUUID(),
          documentType = surface.querySelector("[data-document-type]").value;
        const ownership = { idempotencyKey };
        const prepared = await api("/documents/prepare", {
          method: "POST",
          body: JSON.stringify({
            sha256,
            byteSize: file.size,
            documentType,
            ...ownership,
            sourceRef: `portal-${sha256.slice(0, 24)}`,
            accountId: ["bank-statement", "private-account-statement"].includes(
              documentType,
            )
              ? surface.querySelector("[data-account]").value || undefined
              : undefined,
            statementMonth: [
              "bank-statement",
              "private-account-statement",
            ].includes(documentType)
              ? surface.querySelector("[data-statement-month]").value ||
                (lens !== "all" ? lens : undefined)
              : undefined,
          }),
        });
        let completed = prepared;
        if (prepared.outcome !== "existing") {
          const uploaded = await fetch(prepared.uploadUrl, {
            method: "PUT",
            headers: prepared.uploadHeaders || {
              "content-type": "application/pdf",
            },
            body: file,
          });
          if (!uploaded.ok) throw new Error("Upload failed");
          completed = await api(`/documents/${prepared.document.id}/complete`, {
            method: "POST",
            body: JSON.stringify(ownership),
          });
        }
        const transactionId = surface.querySelector("[data-transaction]").value;
        if (transactionId)
          await api("/links", {
            method: "POST",
            body: JSON.stringify({
              documentId: completed.document.id,
              transactionId,
              coverageType: "evidence",
            }),
          });
        status.textContent =
          prepared.outcome === "existing"
            ? "Matching PDF already verified."
            : "PDF uploaded and verified.";
        await refreshEvidence();
      }, "Could not upload PDF"),
    );
    surface
      .querySelector(".bookkeeping-documents")
      .addEventListener("click", (event) =>
        safeAction(async () => {
          const download =
              event.target.closest("[data-download]")?.dataset.download,
            unlink = event.target.closest("[data-unlink]")?.dataset.unlink;
          if (download) {
            const result = await api(`/documents/${download}/download`);
            openPrivateDownload(result.downloadUrl);
          }
          if (unlink) {
            await api(`/links/${unlink}`, { method: "DELETE" });
            await refreshEvidence();
          }
        }, "Could not update document"),
      );
    surface.querySelector("[data-report]").addEventListener("click", () =>
      safeAction(async () => {
        const month = surface.querySelector("[data-report-month]").value;
        if (!month) {
          status.textContent = "Pick the month to close with the lens above.";
          return;
        }
        const privateDocumentIds = [
          ...surface.querySelectorAll(
            "[data-private-statements] input:checked",
          ),
        ].map((input) => input.value);
        const snapshot = await api("/reports/snapshot", {
          method: "POST",
          body: JSON.stringify({ month, privateDocumentIds }),
        });
        await refreshEvidence();
        const excluded =
          snapshot.report?.reconciliation?.excludedTransactionCount;
        status.textContent = [
          snapshot.warnings?.missingEvidence
            ? `Package created with ${snapshot.warnings.missingEvidence} missing-evidence warning(s).`
            : "Package created.",
          excluded
            ? `${excluded} tax/health-insurance ${excluded === 1 ? "entry" : "entries"} kept out.`
            : "",
        ]
          .filter(Boolean)
          .join(" ");
      }, "Could not create monthly package"),
    );
    surface
      .querySelector("[data-package-review]")
      .addEventListener("click", (event) => {
        const reportId = event.target.closest("[data-download-archive]")
          ?.dataset.downloadArchive;
        if (!reportId) return;
        safeAction(async () => {
          const archive = await api(`/reports/${reportId}/archive`, {
            method: "POST",
          });
          openPrivateDownload(archive.downloadUrl);
        }, "Could not download the package");
      });
  }

  return { renderBookkeepingSurface };
}
