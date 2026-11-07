// Inventory: physical purchases derived from the ledger, so the balance shows
// what hardware, phones, audio and furniture the company owns. The view is a
// table over /api/bookkeeping/inventory; "Scan ledger" runs the import that
// turns 2022+ expenses (and per-invoice allocation rows) into items. Every
// item links back to the ledger record it came from, and selling or
// decommissioning writes a disposal record so exits are documented too.
import { html } from "./shared.js";
import { formatAmount } from "./bookkeeping-format.js";

const TYPES = ["computer", "phone", "audio", "furniture", "accessory", "other"];
const DISPOSAL_KINDS = ["sold", "decommissioned"];
const DISPOSAL_LABELS = { sold: "sold", decommissioned: "decommissioned" };

export function createBookkeepingInventory({ surface, api, escapeHtml, safeAction, setStatus, todayIsoDate, openTransaction }) {
  const host = surface.querySelector("[data-inventory]");
  const scanButton = surface.querySelector("[data-inventory-scan]");
  let items = [];
  // The in-row disposal form: one item records its exit at a time.
  let disposeForm = null;

  const today = () => todayIsoDate?.() || new Date().toISOString().slice(0, 10);
  const eurValue = (item) => {
    if (item.amountEur) return Number(item.amountEur);
    if (item.amount && String(item.currency || "").toUpperCase() === "EUR") return Number(item.amount);
    return null;
  };
  const amountText = (item) => eurValue(item) === null && item.amount
    ? `${item.amount} ${item.currency || ""}`.trim()
    : formatAmount(eurValue(item), "EUR");
  const sorted = () => [...items].sort((a, b) =>
    String(b.acquisitionDate || "").localeCompare(String(a.acquisitionDate || "")));
  const disposalsOf = (item) => (Array.isArray(item.disposals) ? item.disposals : []);

  function sourceMarkup(item) {
    const source = item.source;
    if (!source) return "";
    return html`<button type="button" class="bk-inv-source" data-inv-source="${escapeHtml(source.transactionId)}"
        title="Open the ledger record from ${escapeHtml(source.date || item.acquisitionDate || "")}"
        aria-label="Open the ledger record for ${escapeHtml(item.name)}">↳ ledger: ${escapeHtml(source.description || item.name)}</button>`;
  }

  function statusMarkup(item) {
    if (item.status === "disposed") {
      return html`<span class="bk-inv-badge bk-inv-badge--disposed">disposed${item.disposedDate ? html` · ${escapeHtml(item.disposedDate)}` : ""}</span>`;
    }
    return html`<span class="bk-inv-badge">in use</span>
      <button type="button" class="dk-button dk-button--sm bk-inv-dispose" data-inv-dispose="${escapeHtml(item.id)}"
        title="Record selling or decommissioning ${escapeHtml(item.name)}">Dispose…</button>`;
  }

  function disposalsMarkup(item) {
    const records = disposalsOf(item);
    if (!records.length) return "";
    return html`<tr class="bk-inv-extras"><td></td><td colspan="6" class="bk-inv-disposals">
      ${records.map((record) => html`<span class="bk-inv-disposal">
          <strong>${DISPOSAL_LABELS[record.kind] || escapeHtml(String(record.kind))}</strong> ${escapeHtml(String(record.date))}
          ${record.proceeds ? html` · proceeds ${formatAmount(String(record.proceeds), String(record.currency || "EUR"))}` : ""}
          ${record.notes ? html` · ${escapeHtml(String(record.notes))}` : ""}
          <button type="button" class="dk-icon-button bk-inv-disposal-remove" data-inv-disposal-remove="${escapeHtml(String(record.id))}"
            title="Remove this disposal record" aria-label="Remove the ${escapeHtml(String(record.kind))} record">✕</button>
        </span>`).join("")}
    </td></tr>`;
  }

  function disposeFormMarkup(item) {
    if (disposeForm?.itemId !== item.id) return "";
    const sold = disposeForm.kind === "sold";
    return html`<tr class="bk-inv-extras"><td></td><td colspan="6" class="bk-inv-dispose">
        <label>Kind
          <select class="bk-inline-select" data-inv-disposal="kind" aria-label="Disposal kind">
            ${DISPOSAL_KINDS.map((kind) => html`<option value="${kind}"${kind === disposeForm.kind ? " selected" : ""}>${DISPOSAL_LABELS[kind]}</option>`).join("")}
          </select>
        </label>
        <label>Date <input type="date" class="dk-input" data-inv-disposal="date" value="${escapeHtml(disposeForm.date)}" aria-label="Disposal date" /></label>
        ${sold ? html`<label>Proceeds <input class="dk-input bk-inv-proceeds" data-inv-disposal="proceeds" value="${escapeHtml(disposeForm.proceeds || "")}"
            inputmode="decimal" placeholder="0.00" aria-label="Sale proceeds in EUR" /></label>` : ""}
        <label>Note <input class="dk-input" data-inv-disposal="notes" value="${escapeHtml(disposeForm.notes || "")}" placeholder="optional" aria-label="Disposal note" /></label>
        <button type="button" class="dk-button dk-button--sm dk-button--primary" data-inv-disposal-save>Record</button>
        <button type="button" class="dk-button dk-button--sm dk-button--secondary" data-inv-disposal-cancel>Cancel</button>
      </td></tr>`;
  }

  function rowMarkup(item) {
    const disposed = item.status === "disposed";
    return html`<tr class="bk-row bk-inv-row${disposed ? " is-disposed" : ""}" data-inv="${escapeHtml(item.id)}">
      <td class="bk-col-date">${escapeHtml(item.acquisitionDate || "")}</td>
      <td class="bk-inv-what">
        <span class="bk-who__name">${escapeHtml(item.name)}</span>
        ${item.vendor ? html`<span class="bk-inv-vendor">${escapeHtml(item.vendor)}</span>` : ""}
        ${sourceMarkup(item)}
      </td>
      <td class="bk-inv-type">
        <select class="bk-inline-select" data-inv-field="type" aria-label="Type of ${escapeHtml(item.name)}">
          ${TYPES.map((type) => html`<option value="${type}"${type === item.type ? " selected" : ""}>${type}</option>`).join("")}
        </select>
      </td>
      <td class="bk-col-money bk-col-eur">${amountText(item)}</td>
      <td class="bk-inv-status">${statusMarkup(item)}</td>
      <td class="bk-inv-notes">
        <input class="dk-input bk-inv-note" data-inv-field="notes" value="${escapeHtml(item.notes || "")}"
          placeholder="Note…" aria-label="Note for ${escapeHtml(item.name)}" />
      </td>
      <td class="bk-inv-actions">
        <button type="button" class="dk-icon-button bk-inv-remove" data-inv-remove="${escapeHtml(item.id)}"
          title="Remove ${escapeHtml(item.name)} from the inventory" aria-label="Remove ${escapeHtml(item.name)}">✕</button>
      </td>
    </tr>`;
  }

  function render() {
    const yearSelect = surface.querySelector("[data-inv-year]");
    const year = yearSelect?.value || "";
    const visible = sorted().filter((item) => !year || String(item.acquisitionDate || "").startsWith(year));
    const years = [...new Set(sorted().map((item) => String(item.acquisitionDate || "").slice(0, 4)).filter(Boolean))];
    const inUse = visible.filter((item) => item.status !== "disposed");
    const total = inUse.reduce((sum, item) => sum + (eurValue(item) || 0), 0);
    if (yearSelect) {
      const previous = yearSelect.value;
      yearSelect.innerHTML = ['<option value="">All years</option>',
        ...years.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`)].join("");
      yearSelect.value = years.includes(previous) ? previous : "";
    }
    if (!items.length) {
      host.innerHTML = html`<div class="dk-empty dk-empty--compact">
          <p class="dk-empty__title">No inventory yet</p>
          <p>Scan the ledger to find physical purchases since 2022.</p>
        </div>`;
      return;
    }
    host.innerHTML = html`<p class="bk-inv-total" data-inv-total aria-live="polite">
        ${visible.length === items.length ? `${items.length} items` : `${visible.length} of ${items.length} items`} ·
        in use: ${formatAmount(total.toFixed(2), "EUR")}
      </p>
      <table class="bk-table bk-inv-table">
        <thead>
          <tr><th>Acquired</th><th>Item</th><th>Type</th><th class="bk-col-money">Paid</th><th>Status</th><th>Note</th><th></th></tr>
        </thead>
        <tbody>${visible.map((item) => rowMarkup(item) + disposeFormMarkup(item) + disposalsMarkup(item)).join("")}</tbody>
      </table>`;
  }

  async function save(id, body) {
    const saved = await api(`/inventory/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
    items = items.map((item) => (item.id === id ? saved : item));
    render();
    return saved;
  }

  function submitDisposal() {
    if (!disposeForm) return;
    const form = disposeForm;
    if (!form.date) {
      setStatus("Pick a disposal date.");
      return;
    }
    disposeForm = null;
    safeAction(async () => {
      await save(form.itemId, { disposal: {
        kind: form.kind,
        date: form.date,
        proceeds: form.kind === "sold" ? String(form.proceeds || "").trim() : undefined,
        notes: String(form.notes || "").trim() || undefined,
      } });
      setStatus(form.kind === "sold" ? "Recorded the sale." : "Recorded the decommissioning.");
    }, "Could not record the disposal");
  }

  host.addEventListener("change", (event) => {
    if (event.target.closest("[data-inv-year]")) {
      render();
      return;
    }
    const disposalField = event.target.closest("[data-inv-disposal]");
    if (disposalField) {
      // The kind decides whether proceeds apply; other form fields only
      // update the draft, they never re-render mid-typing.
      if (disposeForm && disposalField.dataset.invDisposal === "kind") {
        disposeForm.kind = String(disposalField.value || "sold");
        render();
      }
      return;
    }
    const field = event.target.closest("[data-inv-field]");
    if (!field) return;
    const row = field.closest("[data-inv]");
    const item = items.find((candidate) => candidate.id === row?.dataset.inv);
    if (!item) return;
    const value = String(field.value || "").trim();
    field.disabled = true;
    safeAction(async () => {
      if (field.dataset.invField === "type") await save(item.id, { type: value });
      else if (field.dataset.invField === "notes") await save(item.id, { notes: value || null });
      field.disabled = false;
      setStatus("Inventory updated.");
    }, "Could not save the inventory change");
  });

  host.addEventListener("click", (event) => {
    const source = event.target.closest("[data-inv-source]");
    if (source) {
      openTransaction?.(source.dataset.invSource);
      return;
    }
    const disposeButton = event.target.closest("[data-inv-dispose]");
    if (disposeButton) {
      disposeForm = { itemId: disposeButton.dataset.invDispose, kind: "sold", date: today(), proceeds: "", notes: "" };
      render();
      return;
    }
    if (event.target.closest("[data-inv-disposal-cancel]")) {
      disposeForm = null;
      render();
      return;
    }
    if (event.target.closest("[data-inv-disposal-save]")) {
      submitDisposal();
      return;
    }
    const removeDisposal = event.target.closest("[data-inv-disposal-remove]");
    if (removeDisposal) {
      const row = removeDisposal.closest("[data-inv]");
      const item = items.find((candidate) => candidate.id === row?.dataset.inv);
      if (!item) return;
      safeAction(async () => {
        await save(item.id, { removeDisposalId: removeDisposal.dataset.invDisposalRemove });
        setStatus("Disposal record removed.");
      }, "Could not remove the disposal record");
      return;
    }
    const button = event.target.closest("[data-inv-remove]");
    if (!button) return;
    const item = items.find((candidate) => candidate.id === button.dataset.invRemove);
    if (!item || !globalThis.confirm?.(`Remove ${item.name} from the inventory?`)) return;
    safeAction(async () => {
      await api(`/inventory/${encodeURIComponent(item.id)}`, { method: "DELETE" });
      items = items.filter((candidate) => candidate.id !== item.id);
      render();
      setStatus(`Removed ${item.name} from the inventory.`);
    }, "Could not remove the inventory item");
  });

  host.addEventListener("input", (event) => {
    if (event.target.closest("[data-inv-year]")) render();
    const disposalField = event.target.closest("[data-inv-disposal]");
    if (disposalField && disposeForm && disposalField.dataset.invDisposal !== "kind")
      disposeForm[disposalField.dataset.invDisposal] = disposalField.value;
  });

  scanButton.addEventListener("click", () =>
    safeAction(async () => {
      scanButton.disabled = true;
      try {
        const result = await api("/inventory/import", {
          method: "POST",
          body: JSON.stringify({ apply: true }),
        });
        setStatus(result.created
          ? `Added ${result.created} item${result.created === 1 ? "" : "s"} from the ledger.`
          : `No new physical purchases (${result.matched} matched, all already present).`);
        await load();
      } finally {
        scanButton.disabled = false;
      }
    }, "Could not scan the ledger"));

  async function load() {
    const result = await api("/inventory");
    items = result.items || [];
    render();
  }

  return {
    renderInventory: () => safeAction(load, "Could not load inventory"),
  };
}
