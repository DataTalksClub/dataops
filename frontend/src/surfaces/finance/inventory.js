// Inventory surface: the company's physical property at /invertory, fully
// separate from the bookkeeping ledger surface. Items derive from ledger
// expenses (2022+), each row keeps its provenance link, and the record dialog
// fetches the original ledger transaction directly instead of reaching into
// the bookkeeping surface.
import { createBookkeepingInventory } from "./bookkeeping-inventory.js";
import { createBookkeepingTransactionModal } from "./bookkeeping-transaction-modal.js";
import {
  INVOICE_SOURCE_PREFIX,
  linkedEvidenceDocuments,
  suggestionLoader,
  suggestionsMarkup,
} from "./bookkeeping-ledger.js";
import { formatAmount } from "./bookkeeping-format.js";
import { html } from "./shared.js";

export function inventorySurfaceMarkup() {
  return html`<header class="dk-page-header bk-header">
      <div class="dk-page-header__main"><h1 class="dk-page-header__title">Inventory</h1></div>
      <button type="button" class="dk-button dk-button--secondary dk-button--sm" data-inventory-scan>Scan ledger</button>
    </header>
    <p class="finance-section-head__hint">Physical purchases from the ledger since 2022 — computers, phones, audio, furniture. Scan the ledger after new expenses land.</p>
    <p data-inventory-status class="dk-toast bk-status" role="status"></p>
    <div class="bookkeeping-inventory" data-inventory aria-live="polite">Loading inventory…</div>
    <!-- At the surface root: a dialog inside a hidden ancestor cannot be shown. -->
    <dialog class="surface-dialog bk-transaction-dialog" data-inventory-transaction-dialog aria-labelledby="inventory-transaction-dialog-title"></dialog>`;
}

export function createInventorySurface(context) {
  const {
    documentList,
    escapeHtml,
    humanizeOptionLabel,
    request,
    setRouteTitle,
    todayIsoDate,
    workApiUrl,
  } = context;

  async function renderInventorySurface() {
    documentList.replaceChildren();
    const surface = document.createElement("section");
    surface.className = "bookkeeping-surface inventory-surface";
    surface.innerHTML = inventorySurfaceMarkup();
    documentList.append(surface);
    setRouteTitle("Inventory");

    const dialog = surface.querySelector("[data-inventory-transaction-dialog]");
    const status = surface.querySelector("[data-inventory-status]");
    const api = (path, options = {}) =>
      request(workApiUrl(`/api/bookkeeping${path}`), {
        headers: {
          "content-type": "application/json",
          ...(options.headers || {}),
        },
        ...options,
      });

    let statusTimer = null;
    const setStatus = (text) => {
      status.textContent = text;
      clearTimeout(statusTimer);
      if (text) statusTimer = setTimeout(() => { status.textContent = ""; }, 6000);
    };
    async function safeAction(action, fallback) {
      try {
        await action();
      } catch (error) {
        setStatus(`${fallback}: ${error.message}`);
      }
    }
    function openDocument(id) {
      // The tab opens inside the click task; waiting for the URL first gets
      // it blocked as a popup.
      const tab = globalThis.open?.("", "_blank");
      void safeAction(async () => {
        const fromInvoice = String(id).startsWith(INVOICE_SOURCE_PREFIX);
        const result = fromInvoice
          ? await api(`/invoices/${encodeURIComponent(String(id).slice(INVOICE_SOURCE_PREFIX.length))}/document`)
          : await api(`/documents/${encodeURIComponent(id)}/download?disposition=inline`);
        const url = fromInvoice ? result.url : result.downloadUrl;
        if (tab) tab.location.href = url;
      }, "Could not open the file");
    }

    // The record dialog owns its data: the transaction itself, plus the
    // evidence lists the first dialog open needs for invoice buttons.
    const records = new Map();
    let evidence = null;
    let selectedId = "";
    async function loadRecord(id) {
      if (!evidence) {
        const [docResult, linkResult] = await Promise.all([api("/documents"), api("/links")]);
        evidence = { documents: docResult.items || [], links: linkResult.items || [] };
      }
      const record = records.get(id) || await api(`/transactions/${encodeURIComponent(id)}`);
      records.set(id, record);
      return record;
    }

    const suggestions = suggestionLoader({
      load: (id) => api(`/transactions/${encodeURIComponent(id)}/suggestions`),
      holder: (id) => (selectedId === id ? dialog.querySelector("[data-suggestions]") : null),
      render: (result) => suggestionsMarkup({ suggestions: result, humanize: humanizeOptionLabel, e: escapeHtml }),
    });

    const transactionModal = createBookkeepingTransactionModal({
      dialog,
      request,
      workApiUrl,
      api,
      escapeHtml,
      formatAmount,
      suggestions,
      getSelectedId: () => selectedId,
      getEntry: (id) => records.get(id) || null,
      getAttached: (id) => {
        const record = records.get(id);
        if (!record || !evidence) return [];
        return linkedEvidenceDocuments(record, evidence.links, evidence.documents);
      },
      openDocument: (id) => openDocument(id),
      refreshEvidence: async () => {
        evidence = null;
        records.delete(selectedId);
        await loadRecord(selectedId);
      },
      safeAction,
      setStatus,
      onClose: () => {
        selectedId = "";
      },
    });

    async function openTransaction(id) {
      try {
        const record = await loadRecord(id);
        selectedId = id;
        transactionModal.render(record);
      } catch (error) {
        setStatus(`Could not open the ledger record: ${error.message}`);
      }
    }

    const inventory = createBookkeepingInventory({
      surface,
      api,
      escapeHtml,
      safeAction,
      setStatus,
      todayIsoDate,
      openTransaction,
    });
    await inventory.renderInventory();
  }

  return { renderInventorySurface };
}
