// Inventory surface: the company's physical property at /invertory, fully
// separate from the bookkeeping ledger surface. Items derive from bookkeeping
// invoices (2022+), each row keeps its provenance link, and the record dialog
// fetches the original invoice transaction directly instead of reaching into
// the bookkeeping surface. "Add" records an item by hand for a picked
// invoice — one invoice can yield several items that share it.
import { createBookkeepingInventory, INVENTORY_TYPES } from "./bookkeeping-inventory.js";
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
      <button type="button" class="dk-button dk-button--secondary dk-button--sm" data-inventory-add>Add</button>
    </header>
    <p class="finance-section-head__hint">Physical purchases from bookkeeping invoices since 2022. New purchases land here
      automatically; Add records one by hand.</p>
    <p data-inventory-status class="dk-toast bk-status" role="status"></p>
    <div class="bookkeeping-inventory" data-inventory aria-live="polite">Loading inventory…</div>
    <!-- At the surface root: a dialog inside a hidden ancestor cannot be shown. -->
    <dialog class="surface-dialog bk-transaction-dialog" data-inventory-transaction-dialog aria-labelledby="inventory-transaction-dialog-title"></dialog>
    <dialog class="surface-dialog bk-add-dialog" data-inventory-add-dialog aria-labelledby="inventory-add-dialog-title">
      <header>
        <h3 id="inventory-add-dialog-title">Add to inventory</h3>
        <p data-add-hint>Pick the invoice the item was bought on.</p>
      </header>
      <div class="bk-add-picker" data-add-picker></div>
    </dialog>`;
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
        setStatus(`Could not open the invoice: ${error.message}`);
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

    // The Add picker: pick an invoice from the ledger list, then describe the
    // item it stands for. The form stays open so one payment that bought two
    // things records both, sharing the invoice as their source.
    const addDialog = surface.querySelector("[data-inventory-add-dialog]");
    const addPicker = addDialog.querySelector("[data-add-picker]");
    const addHint = addDialog.querySelector("[data-add-hint]");
    let addState = null;
    const money = (value) => formatAmount(String(Math.abs(Number(value || 0))), "EUR");

    function renderAddPicker() {
      if (!addState?.transactions) {
        addPicker.innerHTML = html`<p class="bk-add-loading">Loading invoices…</p>`;
        return;
      }
      if (!addState.transaction) {
        const query = String(addState.query || "").trim().toLowerCase();
        const matches = addState.transactions
          .filter((tx) => !query || `${tx.description || ""} ${tx.counterparty || ""}`.toLowerCase().includes(query))
          .slice(0, 50);
        addHint.textContent = "Pick the invoice the item was bought on.";
        addPicker.innerHTML = html`<input class="dk-input bk-add-search" data-add-search value="${escapeHtml(addState.query || "")}"
            placeholder="Search invoices…" aria-label="Search invoices" />
          ${matches.length ? html`<div class="bk-add-options">${matches.map((tx) => html`<button type="button" class="bk-add-option" data-add-tx="${escapeHtml(tx.id)}">
              <span class="bk-add-date">${escapeHtml(String(tx.paidDate || tx.transactionDate || ""))}</span>
              <span class="bk-add-what">${escapeHtml(String(tx.description || "(no description)"))}</span>
              <span class="bk-add-vendor">${escapeHtml(String(tx.counterparty || ""))}</span>
              <span class="bk-add-amount">${money(tx.amountEur || tx.amount)}</span>
            </button>`).join("")}</div>`
          : html`<p class="bk-add-loading">No invoice matches.</p>`}`;
        // Re-rendering on every keystroke replaces the input; put the caret
        // back so typing continues at the end.
        const search = addPicker.querySelector("[data-add-search]");
        if (search) {
          search.focus();
          const end = search.value.length;
          search.setSelectionRange(end, end);
        }
        return;
      }
      const tx = addState.transaction;
      addHint.textContent = "Describe the item this invoice bought. Keep the form open to record another item from the same invoice.";
      addPicker.innerHTML = html`<p class="bk-add-invoice">${escapeHtml(String(tx.paidDate || tx.transactionDate || ""))} ·
          ${escapeHtml(String(tx.counterparty || ""))} · ${money(tx.amountEur || tx.amount)} —
          ${escapeHtml(String(tx.description || "(no description)"))}</p>
        <label>Name
          <input class="dk-input" data-add-field="name" value="${escapeHtml(addState.name || "")}"
            placeholder="Make and model, e.g. Sennheiser HD 450BT" aria-label="Item name" />
        </label>
        <label>Type
          <select class="dk-input" data-add-field="type" aria-label="Item type">
            <option value="">Auto</option>
            ${INVENTORY_TYPES.map((type) => html`<option value="${type}"${type === addState.type ? " selected" : ""}>${type}</option>`).join("")}
          </select>
        </label>
        <label>Note
          <input class="dk-input" data-add-field="notes" value="${escapeHtml(addState.notes || "")}"
            placeholder="optional" aria-label="Item note" />
        </label>
        <div class="bk-add-actions">
          <button type="button" class="dk-button dk-button--sm dk-button--primary" data-add-save>Add item</button>
          <button type="button" class="dk-button dk-button--sm dk-button--secondary" data-add-back>Back</button>
          <button type="button" class="dk-button dk-button--sm dk-button--secondary" data-add-close>Close</button>
        </div>`;
    }

    async function addFromInvoice() {
      const tx = addState?.transaction;
      if (!tx) return;
      const name = String(addState.name || "").trim();
      const type = String(addState.type || "");
      const notes = String(addState.notes || "").trim();
      // No name means the backend names the item from the invoice description.
      await api("/inventory/items", {
        method: "POST",
        body: JSON.stringify({
          transactionId: tx.id,
          ...(name ? { name } : {}),
          ...(type ? { type } : {}),
          ...(notes ? { notes } : {}),
        }),
      });
      setStatus(`Added ${name || tx.description || "the item"} to the inventory.`);
      addState.name = "";
      addState.notes = "";
      renderAddPicker();
      await inventory.renderInventory();
    }

    addPicker.addEventListener("click", (event) => {
      const option = event.target.closest("[data-add-tx]");
      if (option) {
        addState.transaction = addState.transactions.find((tx) => tx.id === option.dataset.addTx) || null;
        renderAddPicker();
        return;
      }
      if (event.target.closest("[data-add-back]")) {
        addState.transaction = null;
        renderAddPicker();
        return;
      }
      if (event.target.closest("[data-add-close]")) {
        addDialog.close();
        return;
      }
      if (event.target.closest("[data-add-save]")) {
        void safeAction(addFromInvoice, "Could not add the item");
      }
    });

    addPicker.addEventListener("input", (event) => {
      const search = event.target.closest("[data-add-search]");
      if (search) {
        addState.query = search.value;
        renderAddPicker();
        return;
      }
      const field = event.target.closest("[data-add-field]");
      if (field && addState) addState[field.dataset.addField] = field.value;
    });

    surface.querySelector("[data-inventory-add]").addEventListener("click", () => {
      addState = addState && addState.transactions ? addState : { transactions: null, query: "", transaction: null, name: "", type: "", notes: "" };
      addState.transaction = null;
      renderAddPicker();
      addDialog.showModal();
      if (!addState.transactions) {
        void safeAction(async () => {
          const result = await api("/transactions");
          if (addState) addState.transactions = (result.items || [])
            .filter((tx) => tx.entryType === "expense" && tx.voidStatus !== "voided");
          renderAddPicker();
        }, "Could not load invoices");
      }
    });

    await inventory.renderInventory();
  }

  return { renderInventorySurface };
}
