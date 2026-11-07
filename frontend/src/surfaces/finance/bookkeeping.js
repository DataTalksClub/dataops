import { createTuitionLoader } from "./tuition.js";
import { mountBookkeepingNavigation } from "./bookkeeping-navigation.js";
import { bookkeepingSurfaceMarkup } from "./bookkeeping-markup.js";
import {
  accountOptionsMarkup,
  documentGroupsMarkup,
} from "./bookkeeping-views.js";
import { createBookkeepingReports } from "./bookkeeping-reporting.js";
import {
  accountsOf,
  bankOnlyEntryFromMonthRow,
  CLASSIFICATION_FIELDS,
  displayRowCount,
  emptyLedgerMarkup,
  filterEntries,
  filtersFromParams,
  groupByMonth,
  inLens,
  linkedEvidenceDocuments,
  LEDGER_PARAMS,
  ledgerTableMarkup,
  needsCategory,
  resolveAccountName,
  SECONDARY_VIEWS,
  suggestionLoader,
  suggestionsMarkup,
  vocabulary,
} from "./bookkeeping-ledger.js";
import { mountInvoiceReview } from "./invoices.js";
import { createBookkeepingTransactionModal } from "./bookkeeping-transaction-modal.js";
import { importStatementWithReview, confirmStatementReplacement } from "./bookkeeping-statement-import.js";
import { loadStatementLinkIndex } from "./bookkeeping-statement.js";
import { openBookkeepingDialog } from "./bookkeeping-dialogs.js";
import { createBookkeepingInventory } from "./bookkeeping-inventory.js";
import {
  createBookkeepingFinance,
  monthlyLedgerEntries,
  ownerWithdrawalsMarkup,
} from "./bookkeeping-vat.js";
import { html } from "./shared.js";
import {
  FIELD_LABELS,
  formatAmount,
  latestActivityMonth,
  MONEY_PATTERN,
  monthLabel,
  monthOf,
  isReportExempt,
  yearsOf,
} from "./bookkeeping-format.js";

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
      bankOnlyEntries = [],
      documents = [],
      links = [],
      accounts = [],
      reports = [],
      statementLinks = new Map();
    const initial = new URLSearchParams(locationRef?.search || "");
    // The lens is a month ("YYYY-MM"), a year, or "all". Without one in the
    // URL it opens on the latest month that has transactions.
    let lens = LENS.test(initial.get("month") || "") ? initial.get("month") : "";
    let filters = filtersFromParams(initial);
    let selectedId = initial.get("tx") || "";
    let view = SECONDARY_VIEWS.includes(initial.get("view")) ? initial.get("view") : "";
    let defaultLens = "", invoicesMounted = false;
    const reconciliationCache = new Map();
    let reconciliationGeneration = 0;
    const loadTuition = createTuitionLoader(surface.querySelector("[data-tuition]"), context, initial.get("agreement"));
    let vocab = {};
    const suggestions = suggestionLoader({ load: (id) => api(`/transactions/${encodeURIComponent(id)}/suggestions`),
      holder: (id) => (selectedId === id ? transactionDialog.querySelector("[data-suggestions]") : null),
      render: (result) => suggestionsMarkup({ suggestions: result, humanize: humanizeOptionLabel, e: escapeHtml }) });

    const ledger = surface.querySelector(".bookkeeping-ledger"),
      transactionDialog = surface.querySelector("#bookkeeping-transaction-dialog"),
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
    const financeSummary = createBookkeepingFinance({
      loadYear: (year) => request(workApiUrl(`/api/finance/summary?year=${encodeURIComponent(year)}`)),
      getLens: () => lens,
      getEntries: () => entries,
      getTodayIsoDate: todayIsoDate,
      refresh: () => {
        renderLedger();
        if (view === "package") renderPackageReview();
      },
    });
    const isReportExemptEntry = (entry) => isReportExempt(entry) || financeSummary.hasMandatoryEntry(entry.id);
    let setupAccountsReady = false;
    // Clear transient confirmations after six seconds.
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

    function syncUrl() {
      if (view === "tuition" || !historyRef?.replaceState || !locationRef) return;
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
      bankOnlyEntries.some((entry) => entry.id === id)
      || links.some((l) => l.transactionId === id && l.coverageType === "evidence");
    const hasInvoice = (id) => {
      const entry = entries.find((candidate) => candidate.id === id);
      const linked = linkedEvidenceDocuments(entry, links, documents);
      return linked;
    };
    const allocationDocument = (entry, allocation) =>
      linkedEvidenceDocuments(entry, links, documents)
        .find((document) => String(document.id) === String(allocation.documentId)) || null;
    const lensEntries = () => entries.filter((e) => inLens(e, lens));
    const ledgerEntriesForLens = () => [
      ...lensEntries(),
      ...bankOnlyEntries.filter((entry) => inLens(entry, lens)),
    ];
    let statementLinkLoad = 0;
    function shiftMonth(period, delta) {
      const [year, month] = period.split("-").map(Number);
      const index = year * 12 + (month - 1) + delta;
      return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
    }
    async function loadStatementLinks() {
      const mine = ++statementLinkLoad;
      const periods = /^\d{4}-\d{2}$/.test(lens)
        ? [shiftMonth(lens, -1), lens, shiftMonth(lens, 1)]
        : [...new Set(entries.map((e) => monthOf(e)).filter((m) => /^\d{4}-\d{2}$/.test(m)))].sort().slice(-13);
      try {
        const next = await loadStatementLinkIndex(periods, { request, workApiUrl });
        if (mine !== statementLinkLoad) return;
        statementLinks = next;
      } catch {
        if (mine !== statementLinkLoad) return;
        statementLinks = new Map();
      }
      renderFilterOptions();
      renderLedger();
    }
    function setLens(month) {
      lens = month;
      bankOnlyEntries = [];
      renderAll();
      void refreshBankOnlyRows();
      void loadStatementLinks();
    }
    function renderAll() {
      navigation.refresh();
      renderView();
      renderFilterOptions();
      renderLedger();
      void financeSummary.ensure();
      if (view === "package") renderPackageReview();
      syncUrl();
    }
    function renderView() {
      surface.dataset.bkView = view || "transactions";
      surface.querySelector("[data-bk-main]").hidden = Boolean(view);
      surface.classList.toggle("dk-fill", !view);
      surface.querySelectorAll("[data-secondary]").forEach((section) => {
        section.hidden = section.dataset.secondary !== view;
      });
      if (view === "tuition") loadTuition();
      if (view === "invoices" && !invoicesMounted) {
        invoicesMounted = true;
        mountInvoiceReview(surface.querySelector("[data-invoice-review]"), context);
      }
      if (view === "inventory") inventory.renderInventory();
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
      const options = [...entries, ...bankOnlyEntries];
      vocab = Object.fromEntries(CLASSIFICATION_FIELDS.map(({ field }) => [field, vocabulary(options, field)]));
      optionList(surface.querySelector('[data-filter="account"]'), accountsOf(options, statementLinks), "All accounts", filters.account);
      optionList(surface.querySelector('[data-filter="category"]'), vocab.category, "All categories", filters.category);
      surface.querySelector('[data-filter="dir"]').value = filters.dir;
      const search = surface.querySelector('[data-filter="q"]');
      if (search.value !== filters.q) search.value = filters.q;
    }
    function renderLedger() {
      const sourceRows = ledgerEntriesForLens();
      const financeEntriesById = financeSummary.entryMap();
      const scoped = monthlyLedgerEntries(sourceRows, lens, financeEntriesById);
      const ledgerOptions = {
        hasEvidence,
        hasInvoice,
        getAllocationDocument: allocationDocument,
        vocab,
        selectedId,
        financeEntriesById,
        statementLinks,
        e: escapeHtml,
      };
      const ownerSection = ownerWithdrawalsMarkup(sourceRows, lens, ledgerOptions);
      const counts = {
        category: scoped.filter(needsCategory).length,
        receipt: scoped.filter((entry) => !hasEvidence(entry.id)).length,
      };
      surface.querySelectorAll("[data-needs]").forEach((button) => {
        const kind = button.dataset.needs;
        button.setAttribute("aria-pressed", String(filters.needs === kind));
        surface.querySelector(`[data-needs-count="${kind}"]`).textContent = counts[kind] ? String(counts[kind]) : "";
      });
      const shown = filterEntries(scoped, filters, { hasEvidence, accountNameOf: (entry) => resolveAccountName(entry, statementLinks) });
      surface.querySelector("[data-shown-count]").textContent =
        `${displayRowCount(shown)} of ${displayRowCount(scoped)}`;
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
        }) + financeSummary.markup(escapeHtml) + ownerSection;
        return;
      }
      ledger.innerHTML = ledgerTableMarkup({
        groups: groupByMonth(shown),
        ...ledgerOptions,
      }) + financeSummary.markup(escapeHtml) + ownerSection;
    }
    function reconciliationPeriods() {
      if (/^\d{4}-\d{2}$/.test(lens)) return [lens];
      if (/^\d{4}$/.test(lens)) return Array.from({ length: 12 }, (_, index) => `${lens}-${String(index + 1).padStart(2, "0")}`);
      const periods = new Set([
        ...entries.map((entry) => monthOf(entry)).filter((period) => /^\d{4}-\d{2}$/.test(period)),
        ...documents.filter((document) => document.documentType === "bank-statement")
          .map((document) => String(document.statementMonth || "")).filter((period) => /^\d{4}-\d{2}$/.test(period)),
        String(todayIsoDate?.() || new Date().toISOString()).slice(0, 7),
      ]);
      return [...periods].sort();
    }
    async function refreshBankOnlyRows() {
      const requestedLens = lens;
      const generation = ++reconciliationGeneration;
      try {
        const views = await Promise.all(reconciliationPeriods().map(async (period) => {
          if (reconciliationCache.has(period)) return reconciliationCache.get(period);
          const view = await request(workApiUrl(`/api/reconcile/months/${encodeURIComponent(period)}`));
          reconciliationCache.set(period, view);
          return view;
        }));
        if (generation !== reconciliationGeneration || requestedLens !== lens) return;
        bankOnlyEntries = views.flatMap((view) => Array.isArray(view?.rows) ? view.rows : [])
          .map(bankOnlyEntryFromMonthRow).filter(Boolean);
        renderFilterOptions();
        renderLedger();
      } catch {
        if (generation !== reconciliationGeneration || requestedLens !== lens) return;
        bankOnlyEntries = [];
        renderFilterOptions();
        renderLedger();
        status.textContent = "Bank statement classifications are temporarily unavailable.";
      }
    }
    function selectedEntry() {
      return entries.find((entry) => entry.id === selectedId) || null;
    }
    function openTransaction(id) {
      const entry = entries.find((e) => e.id === id);
      if (!entry) return;
      selectedId = id;
      ledger.querySelectorAll("[data-tx]").forEach((row) => {
        if (row.dataset.tx === id) row.setAttribute("aria-selected", "true");
        else row.removeAttribute("aria-selected");
      });
      syncUrl();
      transactionModal.render(entry);
    }
    function replaceEntry(saved) {
      entries = entries.some((e) => e.id === saved.id)
        ? entries.map((e) => (e.id === saved.id ? saved : e))
        : [saved, ...entries];
      financeSummary.invalidate();
      void financeSummary.ensure();
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
          originalFilename: file.name,
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
      if (documentType === "bank-statement") {
        const imported = await importStatementWithReview(completed.document.id, { period: statementMonth, request, workApiUrl,
          confirmReplacement: (preview) => confirmStatementReplacement(preview, { document, openDialog: openBookkeepingDialog }) });
        if (!imported.committed) return "statement-kept";
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
    const { renderPackageReview, renderVat } = createBookkeepingReports({
      api,
      escapeHtml,
      getAccounts: () => accounts,
      getDocuments: () => documents,
      getLens: () => lens,
      getLinks: () => links,
      getReports: () => reports,
      isReportExemptEntry,
      lensEntries,
      safeAction,
      surface,
    });
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
      reconciliationCache.clear();
      suggestions.clear();
      accounts = accountResult.items || [];
      reports = reportResult.items || [];
      const setupButton = surface.querySelector("[data-setup-accounts]");
      setupButton.disabled = !setupAccountsReady || accounts.length > 0;
      if (accounts.length)
        setupButton.textContent = "Business accounts ready";
      surface.querySelector("[data-account]").innerHTML =
        accountOptionsMarkup(accounts, escapeHtml);
      renderDocuments();
      financeSummary.invalidate();
      renderLedger();
      void financeSummary.ensure();
      if (selectedId && transactionDialog.open) {
        const entry = entries.find((e) => e.id === selectedId);
        if (entry) transactionModal.render(entry);
      }
      if (view === "package") renderPackageReview();
      void refreshBankOnlyRows();
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

    const transactionModal = createBookkeepingTransactionModal({
      dialog: transactionDialog,
      request,
      workApiUrl,
      api,
      escapeHtml,
      formatAmount,
      suggestions,
      getSelectedId: () => selectedId,
      getEntry: (id) => entries.find((entry) => entry.id === id) || null,
      getFinanceEntry: (id) => financeSummary.entryMap().get(id) || null,
      getAttached: hasInvoice,
      openDocument: (id) => viewDocument(id),
      refreshEvidence,
      safeAction,
      setStatus: (text) => {
        status.textContent = text;
      },
      onClose: () => {
        selectedId = "";
        ledger.querySelector('[aria-selected="true"]')?.removeAttribute("aria-selected");
        syncUrl();
      },
    });

    const inventory = createBookkeepingInventory({
      surface,
      api,
      escapeHtml,
      safeAction,
      setStatus: (text) => {
        status.textContent = text;
      },
      todayIsoDate,
    });

    const navigation = mountBookkeepingNavigation({
      surface, status, setLens, lensEntries, todayIsoDate,
      prepareExemptions: () => financeSummary.ensure(),
      loadAccountantReport: (reportPeriod, format) => api(`/reports/accountant?period=${encodeURIComponent(reportPeriod)}&format=${encodeURIComponent(format)}`),
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
      const documentId = event.target.closest("[data-view-document]")?.dataset.viewDocument;
      if (documentId) {
        event.preventDefault();
        safeAction(() => viewDocument(documentId), "Could not open the file");
        return;
      }
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
      }, "Could not save");
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
        openBookkeepingDialog(entryDialog);
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
        status.textContent = "Transaction added.";
        transactionModal.render(saved);
      }, "Could not add the transaction");
    });

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
          outcome === "statement-kept"
            ? "Existing statement kept. Uploaded PDF retained in source history."
            : outcome === "existing"
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
      void loadStatementLinks();
      if (selectedId) openTransaction(selectedId);
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
