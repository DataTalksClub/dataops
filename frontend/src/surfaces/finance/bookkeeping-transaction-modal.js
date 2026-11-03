import { bookkeepingVendorPresentation } from "./bookkeeping-vendors.js";
import { bookkeepingTransactionSummaryMarkup } from "./bookkeeping-transaction-dialog.js";
import {
  loadTransactionStatementContext,
  pairTransactionWithStatementRow,
} from "./bookkeeping-statement.js";

export function createBookkeepingTransactionModal({
  dialog,
  request,
  workApiUrl,
  api,
  escapeHtml,
  formatAmount,
  suggestions,
  getSelectedId,
  getEntry,
  getFinanceEntry = () => null,
  getAttached,
  openDocument,
  refreshEvidence,
  safeAction,
  setStatus,
  onClose,
}) {
  const statementContexts = new Map();

  function render(entry) {
    if (!entry) {
      dialog.close?.();
      dialog.innerHTML = "";
      return;
    }
    const attached = getAttached(entry.id);
    const finance = getFinanceEntry(entry.id);
    const statement = statementContexts.get(entry.id);
    const summary = bookkeepingTransactionSummaryMarkup({
      transaction: { ...entry, vatEur: finance?.vatEur ?? entry.vatEur },
      invoices: attached.filter((document) => document.documentType === "invoice"),
      statementLink: statement?.statementLink || null,
      statementCandidates: statement?.statementCandidates || [],
      statementPending: !statement,
      statementError: statement?.error || "",
      escape: escapeHtml,
      formatAmount,
    });
    const title = escapeHtml(`${bookkeepingVendorPresentation(entry).canonicalCounterparty} · ${entry.transactionDate || "Transaction"}`);
    dialog.innerHTML = `<header class="bk-transaction-dialog__header">
        <h2 id="bookkeeping-transaction-dialog-title">${title}</h2>
        <button type="button" class="bk-transaction-dialog__close" data-close-transaction-dialog aria-label="Close transaction details">Close</button>
      </header>
      <div class="bk-transaction-dialog__content">${summary}
        <section class="bk-transaction-suggestions"><h3>Suggested matches</h3><div data-suggestions></div></section>
      </div>`;
    if (!dialog.open) dialog.showModal?.();
    suggestions.show(entry.id);
    if (!statement) {
      loadTransactionStatementContext(entry, { request, workApiUrl })
        .then((context) => {
          if (getSelectedId() !== entry.id) return;
          statementContexts.set(entry.id, context);
          render(getEntry(entry.id));
        })
        .catch((error) => {
          if (getSelectedId() !== entry.id) return;
          statementContexts.set(entry.id, { error: error.message || "request failed", statementCandidates: [] });
          render(getEntry(entry.id));
        });
    }
  }

  dialog.addEventListener("close", onClose);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog || event.target.closest("[data-close-transaction-dialog]")) {
      dialog.close();
      return;
    }
    const documentId = event.target.closest("[data-view-document]")?.dataset.viewDocument;
    if (documentId) safeAction(() => openDocument(documentId), "Could not open the file");
    const suggested = event.target.closest("[data-attach-suggestion]");
    if (suggested) safeAction(async () => {
      await api("/links", {
        method: "POST",
        body: JSON.stringify({ documentId: suggested.dataset.attachSuggestion, transactionId: getSelectedId(), coverageType: "evidence" }),
      });
      await refreshEvidence();
      render(getEntry(getSelectedId()));
      setStatus("Attached the invoice.");
    }, "Could not attach the invoice");
    if (event.target.closest("[data-retry-statement-link]")) {
      statementContexts.delete(getSelectedId());
      render(getEntry(getSelectedId()));
    }
    if (event.target.closest("[data-link-statement-row]")) safeAction(async () => {
      const id = getSelectedId();
      const candidateKey = dialog.querySelector("[data-statement-candidate]")?.value;
      const candidate = (statementContexts.get(id)?.statementCandidates || []).find((row) => row.bankKey === candidateKey);
      if (!candidate) return;
      await pairTransactionWithStatementRow(id, candidate, { request, workApiUrl });
      statementContexts.delete(id);
      render(getEntry(id));
      setStatus("Linked to the statement line.");
    }, "Could not link the statement line");
  });

  return { render };
}
