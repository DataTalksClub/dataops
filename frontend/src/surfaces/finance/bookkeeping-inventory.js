// Inventory: physical purchases derived from the ledger, so the balance shows
// what hardware, phones, audio and furniture the company owns. The view is a
// table over /api/bookkeeping/inventory; "Scan ledger" runs the import that
// turns 2022+ expenses (and per-invoice allocation rows) into items.
import { html } from "./shared.js";
import { formatAmount } from "./bookkeeping-format.js";

const TYPES = ["computer", "phone", "audio", "furniture", "accessory", "other"];

export function createBookkeepingInventory({ surface, api, escapeHtml, safeAction, setStatus, todayIsoDate }) {
  const host = surface.querySelector("[data-inventory]");
  const scanButton = surface.querySelector("[data-inventory-scan]");
  let items = [];

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

  function rowMarkup(item) {
    const disposed = item.status === "disposed";
    return html`<tr class="bk-row bk-inv-row${disposed ? " is-disposed" : ""}" data-inv="${escapeHtml(item.id)}">
      <td class="bk-col-date">${escapeHtml(item.acquisitionDate || "")}</td>
      <td class="bk-inv-what">
        <span class="bk-who__name">${escapeHtml(item.name)}</span>
        ${item.vendor ? html`<span class="bk-inv-vendor">${escapeHtml(item.vendor)}</span>` : ""}
      </td>
      <td class="bk-inv-type">
        <select class="bk-inline-select" data-inv-field="type" aria-label="Type of ${escapeHtml(item.name)}">
          ${TYPES.map((type) => html`<option value="${type}"${type === item.type ? " selected" : ""}>${type}</option>`).join("")}
        </select>
      </td>
      <td class="bk-col-money bk-col-eur">${amountText(item)}</td>
      <td class="bk-inv-status">
        <select class="bk-inline-select" data-inv-field="status" aria-label="Status of ${escapeHtml(item.name)}">
          <option value="in-use"${!disposed ? " selected" : ""}>in use</option>
          <option value="disposed"${disposed ? " selected" : ""}>disposed</option>
        </select>
        ${disposed && item.disposedDate ? html`<span class="bk-inv-disposed-date">${escapeHtml(item.disposedDate)}</span>` : ""}
      </td>
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
        <tbody>${visible.map(rowMarkup).join("")}</tbody>
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

  host.addEventListener("change", (event) => {
    if (event.target.closest("[data-inv-year]")) {
      render();
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
      else if (field.dataset.invField === "status")
        await save(item.id, value === "disposed"
          ? { status: "disposed", disposedDate: todayIsoDate?.() || new Date().toISOString().slice(0, 10) }
          : { status: "in-use" });
      else if (field.dataset.invField === "notes") await save(item.id, { notes: value || null });
      field.disabled = false;
      setStatus("Inventory updated.");
    }, "Could not save the inventory change");
  });
  host.addEventListener("click", (event) => {
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
