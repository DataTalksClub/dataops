import { mountBookkeepingNavigation } from "./bookkeeping-navigation.js";
import { bookkeepingSurfaceMarkup } from "./bookkeeping-markup.js";
import {
  accountOptionsMarkup,
  documentGroupsMarkup,
  packageReviewMarkup,
} from "./bookkeeping-views.js";
import {
  accountsOf,
  CLASSIFICATION_FIELDS,
  detailMarkup,
  emptyLedgerMarkup,
  filterEntries,
  filtersFromParams,
  groupByMonth,
  inLens,
  LEDGER_PARAMS,
  ledgerTableMarkup,
  needsCategory,
  SECONDARY_VIEWS,
  vocabulary,
} from "./bookkeeping-ledger.js";
import { mountInvoiceReview } from "./invoices.js";
import { html } from "./shared.js";
import {
  FIELD_LABELS,
  formatAmount,
  latestActivityMonth,
  MONEY_PATTERN,
  monthLabel,
  monthOf,
  REPORT_EXEMPT_CATEGORIES,
  yearsOf,
} from "./bookkeeping-format.js";

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

const LENS = /^(\d{4}(-\d{2})?|all)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY = /^[A-Z]{3}$/;
// Detail fields whose empty value clears the stored one (sent as null).
const NULLABLE = new Set(["paidDate", "amountEur", "vatAmount", "vatCurrency", "quantity"]);

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
  const locationRef = context.locationRef || globalThis.location;
  const historyRef = context.historyRef || globalThis.history;

  async function renderBookkeepingSurface() {
    documentList.replaceChildren();
    const surface = document.createElement("section");
    surface.className = "bookkeeping-surface dk-fill";
    surface.innerHTML = bookkeepingSurfaceMarkup();
    documentList.append(surface);
    setRouteTitle("Bookkeeping");

    let entries = [],
      documents = [],
      links = [],
      accounts = [],
      reports = [];
    const initial = new URLSearchParams(locationRef?.search || "");
    // The lens is a month ("YYYY-MM"), a year, or "all". Without one in the
    // URL it opens on the latest month that has transactions.
    let lens = LENS.test(initial.get("month") || "") ? initial.get("month") : "";
    let filters = filtersFromParams(initial);
    let selectedId = initial.get("tx") || "";
    let view = SECONDARY_VIEWS.includes(initial.get("view")) ? initial.get("view") : "";
    let defaultLens = "";
    let invoicesMounted = false;
    let vocab = {};

    const ledger = surface.querySelector(".bookkeeping-ledger"),
      split = surface.querySelector("[data-bk-split]"),
      detail = surface.querySelector("[data-detail]"),
      entryDialog = surface.querySelector(".bookkeeping-entry-dialog"),
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
    let setupAccountsReady = false;
    // The status line is a transient toast: it clears itself shortly after
    // each message so a confirmation never lingers over the table.
    let statusTimer = null;
    if (typeof MutationObserver === "function")
      new MutationObserver(() => {
        clearTimeout(statusTimer);
        if (status.textContent) statusTimer = setTimeout(() => { status.textContent = ""; }, 6000);
      }).observe(status, { childList: true, characterData: true, subtree: true });
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

    // ---- URL state ---------------------------------------------------------
    function syncUrl() {
      if (!historyRef?.replaceState || !locationRef) return;
      const params = new URLSearchParams();
      // The default month (latest with transactions) stays out of the URL.
      const values = { month: lens === defaultLens ? "" : lens, ...filters, tx: selectedId, view };
      for (const name of LEDGER_PARAMS) if (values[name]) params.set(name, values[name]);
      const query = params.toString();
      const next = `${locationRef.pathname || "/bookkeeping"}${query ? `?${query}` : ""}`;
      if (`${locationRef.pathname}${locationRef.search}` !== next)
        historyRef.replaceState(historyRef.state, "", next);
    }

    const hasEvidence = (id) =>
      links.some((l) => l.transactionId === id && l.coverageType === "evidence");
    const isExempt = (entry) =>
      REPORT_EXEMPT_CATEGORIES.has(String(entry.category || ""));
    const lensEntries = () => entries.filter((e) => inLens(e, lens));
    function monthReport() {
      if (!/^\d{4}-\d{2}$/.test(lens)) return null;
      return reports.find(
        (r) =>
          r.month === lens && ["ready", "generated"].includes(String(r.status)),
      );
    }
    function setLens(month) {
      lens = month;
      renderAll();
    }

    // ---- main view ---------------------------------------------------------
    function renderAll() {
      navigation.refresh();
      renderView();
      renderFilterOptions();
      renderLedger();
      renderDetail();
      if (view === "package") renderPackageReview();
      syncUrl();
    }
    function renderView() {
      surface.dataset.bkView = view || "transactions";
      surface.querySelector("[data-bk-main]").hidden = Boolean(view);
      // The split also hides, so the page scrolls normally in a secondary view.
      split.hidden = Boolean(view);
      surface.classList.toggle("dk-fill", !view);
      surface.querySelectorAll("[data-secondary]").forEach((section) => {
        section.hidden = section.dataset.secondary !== view;
      });
      if (view === "invoices" && !invoicesMounted) {
        invoicesMounted = true;
        mountInvoiceReview(surface.querySelector("[data-invoice-review]"), context);
      }
    }
    function optionList(select, values, allLabel, current) {
      select.innerHTML = [
        html`<option value="">${allLabel}</option>`,
        ...[...new Set([...values, ...(current ? [current] : [])])].map(
          (value) => html`<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`,
        ),
      ].join("");
      select.value = current || "";
    }
    function renderFilterOptions() {
      vocab = Object.fromEntries(CLASSIFICATION_FIELDS.map(({ field }) => [field, vocabulary(entries, field)]));
      optionList(surface.querySelector('[data-filter="account"]'), accountsOf(entries), "All accounts", filters.account);
      optionList(surface.querySelector('[data-filter="category"]'), vocab.category, "All categories", filters.category);
      surface.querySelector('[data-filter="dir"]').value = filters.dir;
      const search = surface.querySelector('[data-filter="q"]');
      if (search.value !== filters.q) search.value = filters.q;
    }
    function renderLedger() {
      const scoped = lensEntries();
      const counts = {
        category: scoped.filter(needsCategory).length,
        receipt: scoped.filter((entry) => !hasEvidence(entry.id)).length,
      };
      surface.querySelectorAll("[data-needs]").forEach((button) => {
        const kind = button.dataset.needs;
        button.setAttribute("aria-pressed", String(filters.needs === kind));
        surface.querySelector(`[data-needs-count="${kind}"]`).textContent = counts[kind] ? String(counts[kind]) : "";
      });
      const shown = filterEntries(scoped, filters, { hasEvidence });
      surface.querySelector("[data-shown-count]").textContent =
        `${shown.length} of ${scoped.length}`;
      const active = ["account", "dir", "category", "needs"].filter((name) => filters[name]).length;
      surface.querySelector("[data-active-filters]").textContent = active ? String(active) : "";
      const filtered = Boolean(filters.q || filters.account || filters.dir || filters.category || filters.needs);
      if (!shown.length) {
        const latest = [...entries].map((e) => String(e.transactionDate || "")).sort().pop();
        ledger.innerHTML = emptyLedgerMarkup({
          lensTitle: lens === "all" ? "any period" : /^\d{4}$/.test(lens) ? lens : monthLabel(lens),
          filtered: filtered && scoped.length > 0,
          latest,
          e: escapeHtml,
        });
        return;
      }
      ledger.innerHTML = ledgerTableMarkup({
        groups: groupByMonth(shown),
        hasEvidence,
        vocab,
        selectedId,
        e: escapeHtml,
      });
    }
    function selectedEntry() {
      return entries.find((entry) => entry.id === selectedId) || null;
    }
    function renderDetail() {
      const entry = selectedEntry();
      split.dataset.pane = entry ? "open" : "closed";
      split.dataset.view = entry ? "detail" : "list";
      detail.hidden = !entry;
      if (!entry) {
        detail.innerHTML = "";
        return;
      }
      const attached = links
        .filter((l) => l.transactionId === entry.id && l.coverageType === "evidence")
        .map((l) => documents.find((d) => d.id === l.documentId))
        .filter(Boolean);
      detail.innerHTML = detailMarkup({
        entry,
        documents: attached,
        vocab,
        humanize: humanizeOptionLabel,
        e: escapeHtml,
      });
    }
    function openTransaction(id) {
      selectedId = id;
      renderDetail();
      ledger.querySelectorAll("[data-tx]").forEach((row) => {
        if (row.dataset.tx === id) row.setAttribute("aria-selected", "true");
        else row.removeAttribute("aria-selected");
      });
      syncUrl();
      globalThis.dakitSplit?.show?.(split, "detail");
    }
    function closeTransaction() {
      const previous = selectedId;
      selectedId = "";
      renderDetail();
      ledger.querySelector('[aria-selected="true"]')?.removeAttribute("aria-selected");
      syncUrl();
      ledger.querySelector(`[data-open-tx="${CSS?.escape ? CSS.escape(previous) : previous}"]`)?.focus?.();
    }
    function replaceEntry(saved) {
      entries = entries.some((e) => e.id === saved.id)
        ? entries.map((e) => (e.id === saved.id ? saved : e))
        : [saved, ...entries];
    }

    // One field saved on its own; the API merges it into the stored record.
    async function saveField(id, name, rawValue) {
      let value = typeof rawValue === "string" ? rawValue.trim() : rawValue;
      if (["currency", "vatCurrency"].includes(name)) value = String(value).toUpperCase();
      if (name === "entryType") value = String(value).toLowerCase();
      if (value === "" && NULLABLE.has(name)) value = null;
      if (name === "quantity" && value !== null) value = Number(value);
      const problem =
        ["amount", "amountEur", "vatAmount"].includes(name) && value !== null && !MONEY_PATTERN.test(String(value))
          ? "Use a positive number like 184.30. Direction sets the sign."
          : ["transactionDate", "paidDate"].includes(name) && value !== null && !DATE.test(String(value))
            ? "Use a full date."
            : ["currency", "vatCurrency"].includes(name) && value !== null && !CURRENCY.test(String(value))
              ? "Use a three-letter currency code."
              : name === "quantity" && value !== null && !(Number.isSafeInteger(value) && value >= 0)
                ? "Use a whole number."
                : ["transactionDate", "counterparty", "description", "amount", "currency"].includes(name) && !value
                  ? `${FIELD_LABELS[name] || name} is required.`
                  : "";
      if (problem) return { error: problem };
      const before = entries.find((entry) => entry.id === id);
      if (before && (before[name] ?? null) === value) return { unchanged: true };
      try {
        const saved = await api(`/transactions/${id}`, {
          method: "PUT",
          body: JSON.stringify({ [name]: value }),
        });
        replaceEntry(saved);
        return { saved };
      } catch (error) {
        const rejected = error?.payload?.fields;
        return {
          error: Array.isArray(rejected) && rejected.length
            ? `Rejected: ${rejected.map((f) => FIELD_LABELS[f] || f).join(", ")}.`
            : `Not saved: ${error.message}`,
        };
      }
    }

    // ---- evidence ------------------------------------------------------------
    async function uploadPdf({ file, documentType, transactionId, accountId, statementMonth }) {
      const bytes = await file.arrayBuffer(),
        sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
          .map((value) => value.toString(16).padStart(2, "0"))
          .join(""),
        ownership = { idempotencyKey: crypto.randomUUID() };
      const prepared = await api("/documents/prepare", {
        method: "POST",
        body: JSON.stringify({
          sha256,
          byteSize: file.size,
          documentType,
          ...ownership,
          sourceRef: `portal-${sha256.slice(0, 24)}`,
          accountId,
          statementMonth,
        }),
      });
      let completed = prepared;
      if (prepared.outcome !== "existing") {
        const uploaded = await fetch(prepared.uploadUrl, {
          method: "PUT",
          headers: prepared.uploadHeaders || { "content-type": "application/pdf" },
          body: file,
        });
        if (!uploaded.ok) throw new Error("Upload failed");
        completed = await api(`/documents/${prepared.document.id}/complete`, {
          method: "POST",
          body: JSON.stringify(ownership),
        });
      }
      if (transactionId)
        await api("/links", {
          method: "POST",
          body: JSON.stringify({
            documentId: completed.document.id,
            transactionId,
            coverageType: "evidence",
          }),
        });
      return prepared.outcome;
    }
    // Opening the tab before the signed URL arrives keeps it a direct result
    // of the click, so pop-up blockers let it through.
    async function viewDocument(id) {
      const tab = globalThis.open?.("", "_blank");
      try {
        const result = await api(`/documents/${encodeURIComponent(id)}/download?disposition=inline`);
        if (tab) {
          tab.opener = null;
          tab.location.href = result.downloadUrl;
        } else openPrivateDownload(result.downloadUrl);
      } catch (error) {
        tab?.close?.();
        throw error;
      }
    }

    // ---- secondary views --------------------------------------------------
    function documentMonth(d) {
      if (/^\d{4}-\d{2}$/.test(String(d.statementMonth || "")))
        return d.statementMonth;
      const linked = links.find((l) => l.documentId === d.id);
      const transaction = linked && entries.find((e) => e.id === linked.transactionId);
      return transaction ? monthOf(transaction) : "";
    }
    function renderDocuments() {
      const unmatched = documents.filter((d) => !links.some((l) => l.documentId === d.id)).length;
      surface.querySelector("[data-files-meta]").textContent = unmatched ? `${unmatched} unmatched` : "";
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
        documentsHost.innerHTML = html`<div class="dk-empty dk-empty--compact">
            <p class="dk-empty__title">No private documents uploaded</p>
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
      const report = monthReport();
      const preview = html`<span class="dk-mono">${monthEntries.length}</span>&nbsp;transaction${monthEntries.length === 1 ? "" : "s"} ·
        <span class="dk-mono">${evidenceDocs.length}</span>&nbsp;linked document${evidenceDocs.length === 1 ? "" : "s"}
        · <span class="dk-mono">${excludedCount}</span>&nbsp;tax/health-insurance ${excludedCount === 1 ? "entry" : "entries"} kept out`;
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
      const setupButton = surface.querySelector("[data-setup-accounts]");
      setupButton.disabled = !setupAccountsReady || accounts.length > 0;
      if (accounts.length)
        setupButton.textContent = "Business accounts ready";
      surface.querySelector("[data-account]").innerHTML =
        accountOptionsMarkup(accounts, escapeHtml);
      renderDocuments();
      renderLedger();
      renderDetail();
      if (view === "package") renderPackageReview();
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
                      (m) =>
                        html`<tr>
                          <td data-label="Month">${escapeHtml(m.month)}</td>
                          <td data-label="Currency">${escapeHtml(m.currency)}</td>
                          <td data-label="Output VAT" class="ledger-amount">
                            ${escapeHtml(formatAmount(m.outputVat, m.currency))}
                          </td>
                          <td data-label="Input VAT" class="ledger-amount">
                            ${escapeHtml(formatAmount(m.inputVat, m.currency))}
                          </td>
                          <td data-label="Net" class="ledger-amount">
                            ${escapeHtml(formatAmount(m.net, m.currency))}
                          </td>
                          <td data-label="Entries">${m.transactionCount}</td>
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
    async function refreshInvoiceCount() {
      try {
        const result = await api("/invoices");
        const pending = (result.items || []).filter((item) => item.status === "pending").length;
        surface.querySelector("[data-invoices-meta]").textContent = pending ? `${pending} to review` : "";
      } catch {
        // The count is a hint; the view itself reports load failures.
      }
    }

    const navigation = mountBookkeepingNavigation({
      surface, status, setLens, lensEntries, todayIsoDate,
      getEntries: () => entries, getLens: () => lens,
    });

    // ---- wiring --------------------------------------------------------------
    surface.querySelector(".bk-filters").addEventListener("input", (event) => {
      const name = event.target.dataset?.filter;
      if (!name) return;
      filters = { ...filters, [name]: String(event.target.value || "").trim() };
      renderLedger();
      syncUrl();
    });
    surface.querySelector(".bk-filters").addEventListener("click", (event) => {
      const disclosure = event.target.closest("[data-filters-toggle]");
      if (disclosure) {
        const open = disclosure.getAttribute("aria-expanded") !== "true";
        disclosure.setAttribute("aria-expanded", String(open));
        surface.querySelector("[data-filters]").toggleAttribute("data-open", open);
        return;
      }
      const toggle = event.target.closest("[data-needs]");
      if (!toggle) return;
      filters = { ...filters, needs: filters.needs === toggle.dataset.needs ? "" : toggle.dataset.needs };
      renderLedger();
      syncUrl();
    });
    ledger.addEventListener("click", (event) => {
      if (event.target.closest("[data-clear-filters]")) {
        filters = filtersFromParams(new URLSearchParams());
        renderFilterOptions();
        renderLedger();
        syncUrl();
        return;
      }
      if (event.target.closest("select, button, input")) return;
      const row = event.target.closest("[data-tx]");
      if (!row) return;
      event.preventDefault();
      openTransaction(row.dataset.tx);
    });
    ledger.addEventListener("change", (event) => {
      const select = event.target.closest("[data-inline-field]");
      if (!select) return;
      const { id, inlineField } = select.dataset;
      select.disabled = true;
      safeAction(async () => {
        const result = await saveField(id, inlineField, select.value);
        select.disabled = false;
        if (result.error) {
          status.textContent = result.error;
          return;
        }
        const entry = entries.find((e) => e.id === id);
        const row = select.closest("[data-tx]");
        row?.classList.toggle("is-uncategorised", needsCategory(entry));
        status.textContent = `Saved ${entry.counterparty}.`;
        if (selectedId === id) renderDetail();
      }, "Could not save");
    });
    detail.addEventListener("click", (event) => {
      if (event.target.closest("[data-close-detail]")) closeTransaction();
      const documentId = event.target.closest("[data-view-document]")?.dataset.viewDocument;
      if (documentId) safeAction(() => viewDocument(documentId), "Could not open the file");
      const del = event.target.closest("[data-delete]")?.dataset.delete;
      if (del) {
        const dialog = surface.querySelector(".bookkeeping-delete-dialog"),
          item = entries.find((e) => e.id === del);
        dialog.dataset.id = del;
        dialog.querySelector("[data-delete-entry-name]").textContent =
          item?.counterparty || "This transaction";
        openDialog(dialog);
      }
    });
    detail.addEventListener("change", (event) => {
      const attach = event.target.closest("[data-attach-file]");
      if (attach) {
        const file = attach.files?.[0];
        if (!file) return;
        const id = selectedId;
        safeAction(async () => {
          status.textContent = "Uploading…";
          const outcome = await uploadPdf({
            file,
            documentType: detail.querySelector("[data-attach-type]").value,
            transactionId: id,
          });
          await refreshEvidence();
          status.textContent = outcome === "existing" ? "That PDF was already on file; attached it." : "PDF attached.";
        }, "Could not attach the PDF");
        return;
      }
      const field = event.target.closest("[data-detail-form] [name]");
      if (!field) return;
      const id = detail.querySelector("[data-detail-form]").dataset.id;
      const holder = field.closest("[data-field]");
      const errorNote = holder?.querySelector("[data-field-error]");
      if (errorNote) errorNote.textContent = "";
      field.removeAttribute("aria-invalid");
      safeAction(async () => {
        const result = await saveField(id, field.name, field.value);
        if (result.error) {
          field.setAttribute("aria-invalid", "true");
          if (errorNote) errorNote.textContent = result.error;
          return;
        }
        if (result.unchanged) return;
        holder?.classList.add("is-saved");
        status.textContent = `Saved ${FIELD_LABELS[field.name] || field.name}.`;
        renderLedger();
        // Amount, currency and direction change the summary line.
        if (["amount", "amountEur", "currency", "entryType", "counterparty", "transactionDate"].includes(field.name))
          renderDetail();
      }, "Could not save");
    });
    detail.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeTransaction();
    });

    const more = surface.querySelector("[data-more]");
    more.addEventListener("click", (event) => {
      if (event.target.closest(".dk-menu__item")) more.open = false;
    });
    surface.addEventListener("click", (event) => {
      if (more.open && !more.contains(event.target)) more.open = false;
      const link = event.target.closest("[data-view-link]");
      if (!link) return;
      view = link.dataset.viewLink || "";
      renderView();
      if (view === "package") {
        renderPackageReview();
        renderVat();
      }
      syncUrl();
    });

    surface
      .querySelector("[data-bookkeeping-add]")
      .addEventListener("click", () => {
        form.reset();
        form.elements.currency.value = "EUR";
        form.elements.entryType.value = "expense";
        if (/^\d{4}-\d{2}$/.test(lens)) form.elements.transactionDate.value = `${lens}-01`;
        surface.querySelector(".bookkeeping-eur-only").hidden = true;
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
    surface.querySelector("[data-save]").addEventListener("click", (event) => {
      event.preventDefault();
      safeAction(async () => {
        form.querySelectorAll(".field-error").forEach((note) => note.remove());
        form.querySelectorAll("[aria-invalid]").forEach((field) => field.removeAttribute("aria-invalid"));
        surface.querySelector("[data-form-error]").textContent = "";
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
        const data = Object.fromEntries(
          [...new FormData(form)]
            .map(([key, value]) => [key, String(value).trim()])
            .filter(([, v]) => v !== ""),
        );
        const errors = ["transactionDate", "counterparty", "description", "amount", "currency"]
          .filter((name) => !data[name])
          .map((name) => ({ name, message: `${FIELD_LABELS[name]} is required.` }));
        for (const name of ["amount", "amountEur"])
          if (data[name] !== undefined && !MONEY_PATTERN.test(data[name]))
            errors.push({
              name,
              message: `${FIELD_LABELS[name] || "EUR value"} must be a positive number with no sign or currency symbol. Direction sets the sign.`,
            });
        if (errors.length) {
          showFieldErrors(errors);
          return;
        }
        data.currency = data.currency.toUpperCase();
        if (data.currency === "EUR") delete data.amountEur;
        let saved;
        try {
          saved = await api("/transactions", { method: "POST", body: JSON.stringify(data) });
        } catch (error) {
          const rejected = error?.payload?.fields;
          if (Array.isArray(rejected) && rejected.length) {
            showFieldErrors(
              rejected.map((name) => ({
                name,
                message: `${FIELD_LABELS[name] || name} was rejected. Fix this field and save again.`,
              })),
            );
            return;
          }
          throw error;
        }
        entryDialog.close();
        replaceEntry(saved);
        const month = monthOf(saved);
        if (month && lens !== "all" && !inLens(saved, lens)) lens = month;
        selectedId = saved.id;
        renderAll();
        status.textContent = "Transaction added. Fill in the rest here.";
      }, "Could not add the transaction");
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
          if (selectedId === dialog.dataset.id) selectedId = "";
          dialog.close();
          renderAll();
          status.textContent = "Transaction deleted.";
        }, "Could not delete the transaction"),
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
        const documentType = surface.querySelector("[data-document-type]").value;
        const statement = ["bank-statement", "private-account-statement"].includes(documentType);
        const outcome = await uploadPdf({
          file,
          documentType,
          accountId: statement ? surface.querySelector("[data-account]").value || undefined : undefined,
          statementMonth: statement
            ? surface.querySelector("[data-statement-month]").value ||
              (/^\d{4}-\d{2}$/.test(lens) ? lens : undefined)
            : undefined,
        });
        status.textContent =
          outcome === "existing" ? "Matching PDF already verified." : "PDF uploaded and verified.";
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
          status.textContent = "Pick the month with the navigator above.";
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
            ? `Package created with ${snapshot.warnings.missingEvidence} missing-receipt warning(s).`
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
    surface
      .querySelector("[data-vat-year]")
      .addEventListener("change", renderVat);
    setupAccountsReady = true;

    // ---- load ------------------------------------------------------------------
    try {
      const result = await api("/transactions");
      entries = result.items || [];
      defaultLens = latestActivityMonth(
        entries,
        String(todayIsoDate?.() || new Date().toISOString()).slice(0, 7),
      );
      if (!lens) lens = defaultLens;
      const vatYears = surface.querySelector("[data-vat-year]");
      const years = yearsOf(entries, lens);
      vatYears.insertAdjacentHTML(
        "beforeend",
        years.map((y) => html`<option>${y}</option>`).join(""),
      );
      vatYears.value = years[0] || "";
      // Opening a transaction by link: show its month.
      const linked = selectedEntry();
      if (linked && !inLens(linked, lens)) lens = monthOf(linked) || lens;
      renderAll();
      await refreshEvidence();
      if (view === "package") await renderVat();
      refreshInvoiceCount();
    } catch (error) {
      ledger.textContent = `Could not load bookkeeping: ${error.message}`;
      surface.querySelector(".bookkeeping-documents").textContent =
        "Could not load private documents.";
      status.textContent = "Retry by reopening Bookkeeping.";
    }
  }

  return { renderBookkeepingSurface };
}
