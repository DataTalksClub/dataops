// Inventory: physical purchases derived from bookkeeping invoices, so the
// balance shows what hardware, phones, audio and furniture the company owns.
// The view is a table over /api/bookkeeping/inventory; new physical purchases
// land automatically, and "Add" records an item for a picked invoice. Every
// item links back to the invoice it came from, and returns, sales and
// decommissioning write exit records so items leaving the balance are
// documented too.
import { html } from "./shared.js";
import { formatAmount } from "./bookkeeping-format.js";

export const INVENTORY_TYPES = ["computer", "phone", "audio", "furniture", "accessory", "other"];
const EXIT_KINDS = ["sold", "decommissioned", "returned"];
const EXIT_LABELS = { sold: "sold", decommissioned: "decommissioned", returned: "returned" };
const USAGES = ["active", "idle"];

export function createBookkeepingInventory({ surface, api, escapeHtml, safeAction, setStatus, todayIsoDate, openTransaction }) {
  const host = surface.querySelector("[data-inventory]");
  let items = [];
  // The in-row exit form (return / sale / decommission) and the in-row
  // picture form: one item records one of them at a time.
  let exitForm = null;
  let imageForm = null;

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
  const exitsOf = (item) => (Array.isArray(item.disposals) ? item.disposals : []);
  const imagesOf = (item) => (Array.isArray(item.images) ? item.images : []);

  // One quiet provenance line under the item name: the vendor, a link to
  // the invoice the item came from, and the picture affordance. Clicking
  // anywhere on the record (not its controls) opens that invoice too.
  function metaMarkup(item) {
    const source = item.source;
    const parts = [
      item.vendor ? html`<span class="bk-inv-vendor">${escapeHtml(item.vendor)}</span>` : "",
      source ? html`<button type="button" class="bk-inv-source" data-inv-source="${escapeHtml(source.transactionId)}"
          title="Open the invoice from ${escapeHtml(source.date || item.acquisitionDate || "")}"
          aria-label="Open the invoice for ${escapeHtml(item.name)}">↳ invoice: ${escapeHtml(source.description || item.name)}</button>` : "",
      html`<button type="button" class="bk-inv-picture" data-inv-image-add="${escapeHtml(item.id)}"
          title="Attach a picture of ${escapeHtml(item.name)} (a photo or a shop product image)"
          aria-label="Add a picture of ${escapeHtml(item.name)}">Add picture…</button>`,
    ];
    return html`<span class="bk-inv-meta">${parts.join(html`<span class="bk-inv-meta-sep"> · </span>`)}</span>`;
  }

  function statusMarkup(item) {
    if (item.status === "disposed") {
      return html`<span class="bk-inv-badge bk-inv-badge--disposed">disposed${item.disposedDate ? html` · ${escapeHtml(item.disposedDate)}` : ""}</span>`;
    }
    if (item.status === "returned") {
      return html`<span class="bk-inv-badge bk-inv-badge--returned">returned${item.returnedDate ? html` · ${escapeHtml(item.returnedDate)}` : ""}</span>`;
    }
    // One quiet inline line: the usage select (its value is the state —
    // a returned or disposed row shows its badge instead) and the exit
    // actions as text. Stacking all of that vertically made every row
    // four lines tall.
    return html`<span class="bk-inv-statusline">
      <select class="bk-inline-select bk-inv-usage" data-inv-field="usage" aria-label="Is ${escapeHtml(item.name)} actively used?">
        ${USAGES.map((usage) => html`<option value="${usage}"${usage === (item.usage || "active") ? " selected" : ""}>
          ${usage === "active" ? "actively used" : "idle"}</option>`).join("")}
      </select>
      <button type="button" class="dk-button dk-button--sm bk-inv-dispose" data-inv-dispose="${escapeHtml(item.id)}" data-inv-kind="returned"
        title="Record returning ${escapeHtml(item.name)} to the vendor">Return…</button>
      <button type="button" class="dk-button dk-button--sm bk-inv-dispose" data-inv-dispose="${escapeHtml(item.id)}" data-inv-kind="sold"
        title="Record selling or decommissioning ${escapeHtml(item.name)}">Dispose…</button></span>`;
  }

  // Exit records, the exit form and the pictures live INSIDE the item cell,
  // under the provenance line — as rows of their own they would need a
  // colspan over the fixed columns, which Chromium sizes to the one auto
  // column instead of the span.
  function exitsMarkup(item) {
    const records = exitsOf(item);
    if (!records.length) return "";
    return html`<span class="bk-inv-extras bk-inv-disposals">
      ${records.map((record) => html`<span class="bk-inv-disposal">
          <strong>${EXIT_LABELS[record.kind] || escapeHtml(String(record.kind))}</strong> ${escapeHtml(String(record.date))}
          ${record.proceeds ? html` · proceeds ${formatAmount(String(record.proceeds), String(record.currency || "EUR"))}` : ""}
          ${record.notes ? html` · ${escapeHtml(String(record.notes))}` : ""}
          <button type="button" class="dk-icon-button bk-inv-disposal-remove" data-inv-disposal-remove="${escapeHtml(String(record.id))}"
            title="Remove this exit record" aria-label="Remove the ${escapeHtml(String(record.kind))} record">✕</button>
        </span>`).join("")}
    </span>`;
  }

  function imageFormMarkup(item) {
    if (imageForm?.itemId !== item.id) return "";
    return html`<span class="bk-inv-image-form">
        <label>URL
          <input class="dk-input bk-inv-image-url" data-inv-image="url" value="${escapeHtml(imageForm.url || "")}"
            placeholder="https://… photo or product image" aria-label="Picture URL for ${escapeHtml(item.name)}" />
        </label>
        <label>Caption <input class="dk-input" data-inv-image="caption" value="${escapeHtml(imageForm.caption || "")}"
            placeholder="optional" aria-label="Picture caption" /></label>
        <button type="button" class="dk-button dk-button--sm dk-button--primary" data-inv-image-save>Attach</button>
        <button type="button" class="dk-button dk-button--sm dk-button--secondary" data-inv-image-cancel>Cancel</button>
      </span>`;
  }

  function imagesMarkup(item) {
    const images = imagesOf(item);
    if (!images.length && imageForm?.itemId !== item.id) return "";
    return html`<span class="bk-inv-extras bk-inv-images">
      ${images.map((image) => html`<span class="bk-inv-image">
          <img class="bk-inv-thumb" src="${escapeHtml(String(image.url))}" loading="lazy" referrerpolicy="no-referrer"
            alt="${escapeHtml(String(image.caption || item.name))}" />
          ${image.caption ? html`<span class="bk-inv-image-caption">${escapeHtml(String(image.caption))}</span>` : ""}
          <button type="button" class="dk-icon-button bk-inv-image-remove" data-inv-image-remove="${escapeHtml(String(image.url))}"
            title="Remove this picture" aria-label="Remove a picture of ${escapeHtml(item.name)}">✕</button>
        </span>`).join("")}
      ${imageFormMarkup(item)}
    </span>`;
  }

  function exitFormMarkup(item) {
    if (exitForm?.itemId !== item.id) return "";
    const sold = exitForm.kind === "sold";
    return html`<span class="bk-inv-extras bk-inv-dispose">
        <label>Kind
          <select class="bk-inline-select" data-inv-disposal="kind" aria-label="Exit kind">
            ${EXIT_KINDS.map((kind) => html`<option value="${kind}"${kind === exitForm.kind ? " selected" : ""}>${EXIT_LABELS[kind]}</option>`).join("")}
          </select>
        </label>
        <label>Date <input type="date" class="dk-input" data-inv-disposal="date" value="${escapeHtml(exitForm.date)}" aria-label="Exit date" /></label>
        ${sold ? html`<label>Proceeds <input class="dk-input bk-inv-proceeds" data-inv-disposal="proceeds" value="${escapeHtml(exitForm.proceeds || "")}"
            inputmode="decimal" placeholder="0.00" aria-label="Sale proceeds in EUR" /></label>` : ""}
        <label>Note <input class="dk-input" data-inv-disposal="notes" value="${escapeHtml(exitForm.notes || "")}" placeholder="optional" aria-label="Exit note" /></label>
        <button type="button" class="dk-button dk-button--sm dk-button--primary" data-inv-disposal-save>Record</button>
        <button type="button" class="dk-button dk-button--sm dk-button--secondary" data-inv-disposal-cancel>Cancel</button>
      </span>`;
  }

  function rowMarkup(item) {
    const exited = item.status !== "in-use";
    return html`<tr class="bk-row bk-inv-row${exited ? " is-disposed" : ""}${item.source ? " is-openable" : ""}" data-inv="${escapeHtml(item.id)}">
      <td class="bk-col-date">${escapeHtml(item.acquisitionDate || "")}</td>
      <td class="bk-inv-what">
        <span class="bk-who__name">${escapeHtml(item.name)}</span>
        ${metaMarkup(item)}
        ${exitFormMarkup(item)}
        ${exitsMarkup(item)}
        ${imagesMarkup(item)}
      </td>
      <td class="bk-inv-type">
        <select class="bk-inline-select" data-inv-field="type" aria-label="Type of ${escapeHtml(item.name)}">
          ${INVENTORY_TYPES.map((type) => html`<option value="${type}"${type === item.type ? " selected" : ""}>${type}</option>`).join("")}
        </select>
      </td>
      <td class="bk-col-money bk-col-eur">${amountText(item)}</td>
      <td class="bk-inv-status">${statusMarkup(item)}</td>
      <td class="bk-inv-notes">
        <input class="dk-input bk-inv-note" data-inv-field="notes" value="${escapeHtml(item.notes || "")}"
          placeholder="Note…" aria-label="Note for ${escapeHtml(item.name)}" />
      </td>
    </tr>`;
  }

  function render() {
    const yearSelect = surface.querySelector("[data-inv-year]");
    const year = yearSelect?.value || "";
    const visible = sorted().filter((item) => !year || String(item.acquisitionDate || "").startsWith(year));
    const years = [...new Set(sorted().map((item) => String(item.acquisitionDate || "").slice(0, 4)).filter(Boolean))];
    const onBalance = visible.filter((item) => item.status === "in-use");
    const total = onBalance.reduce((sum, item) => sum + (eurValue(item) || 0), 0);
    if (yearSelect) {
      const previous = yearSelect.value;
      yearSelect.innerHTML = ['<option value="">All years</option>',
        ...years.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`)].join("");
      yearSelect.value = years.includes(previous) ? previous : "";
    }
    if (!items.length) {
      host.innerHTML = html`<div class="dk-empty dk-empty--compact">
          <p class="dk-empty__title">No inventory yet</p>
          <p>Physical purchases land here automatically; use Add to record one from an invoice.</p>
        </div>`;
      return;
    }
    host.innerHTML = html`<p class="bk-inv-total" data-inv-total aria-live="polite">
        ${visible.length === items.length ? `${items.length} items` : `${visible.length} of ${items.length} items`} ·
        on balance: ${formatAmount(total.toFixed(2), "EUR")}
      </p>
      <table class="bk-table bk-inv-table">
        <thead>
          <tr><th>Acquired</th><th>Item</th><th>Type</th><th class="bk-col-money">Paid</th><th>Status</th><th>Note</th></tr>
        </thead>
        <tbody>${visible.map((item) => rowMarkup(item)).join("")}</tbody>
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

  const EXIT_MESSAGES = { sold: "Recorded the sale.", decommissioned: "Recorded the decommissioning.", returned: "Recorded the return." };

  function submitExit() {
    if (!exitForm) return;
    const form = exitForm;
    if (!form.date) {
      setStatus("Pick a date for the record.");
      return;
    }
    exitForm = null;
    safeAction(async () => {
      await save(form.itemId, { disposal: {
        kind: form.kind,
        date: form.date,
        proceeds: form.kind === "sold" ? String(form.proceeds || "").trim() : undefined,
        notes: String(form.notes || "").trim() || undefined,
      } });
      setStatus(EXIT_MESSAGES[form.kind] || "Recorded the exit.");
    }, "Could not record the exit");
  }

  function submitImage() {
    if (!imageForm) return;
    const form = imageForm;
    const url = String(form.url || "").trim();
    if (!/^https?:\/\/\S+$/.test(url)) {
      setStatus("Paste a picture link starting with http(s)://.");
      return;
    }
    imageForm = null;
    safeAction(async () => {
      await save(form.itemId, { addImage: {
        url,
        ...(String(form.caption || "").trim() ? { caption: String(form.caption).trim() } : {}),
      } });
      setStatus("Picture attached.");
    }, "Could not attach the picture");
  }

  host.addEventListener("change", (event) => {
    if (event.target.closest("[data-inv-year]")) {
      render();
      return;
    }
    const exitField = event.target.closest("[data-inv-disposal]");
    if (exitField) {
      // The kind decides whether proceeds apply; other form fields only
      // update the draft, they never re-render mid-typing.
      if (exitForm && exitField.dataset.invDisposal === "kind") {
        exitForm.kind = String(exitField.value || "sold");
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
      else if (field.dataset.invField === "usage") await save(item.id, { usage: value || "active" });
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
      imageForm = null;
      exitForm = {
        itemId: disposeButton.dataset.invDispose,
        kind: disposeButton.dataset.invKind === "returned" ? "returned" : "sold",
        date: today(),
        proceeds: "",
        notes: "",
      };
      render();
      return;
    }
    if (event.target.closest("[data-inv-disposal-cancel]")) {
      exitForm = null;
      render();
      return;
    }
    if (event.target.closest("[data-inv-disposal-save]")) {
      submitExit();
      return;
    }
    const removeDisposal = event.target.closest("[data-inv-disposal-remove]");
    if (removeDisposal) {
      const row = removeDisposal.closest("[data-inv]");
      const item = items.find((candidate) => candidate.id === row?.dataset.inv);
      if (!item) return;
      safeAction(async () => {
        await save(item.id, { removeDisposalId: removeDisposal.dataset.invDisposalRemove });
        setStatus("Exit record removed.");
      }, "Could not remove the exit record");
      return;
    }
    const imageAdd = event.target.closest("[data-inv-image-add]");
    if (imageAdd) {
      exitForm = null;
      imageForm = { itemId: imageAdd.dataset.invImageAdd, url: "", caption: "" };
      render();
      return;
    }
    if (event.target.closest("[data-inv-image-cancel]")) {
      imageForm = null;
      render();
      return;
    }
    if (event.target.closest("[data-inv-image-save]")) {
      submitImage();
      return;
    }
    const imageRemove = event.target.closest("[data-inv-image-remove]");
    if (imageRemove) {
      const row = imageRemove.closest("[data-inv]");
      const item = items.find((candidate) => candidate.id === row?.dataset.inv);
      if (!item) return;
      safeAction(async () => {
        await save(item.id, { removeImageUrl: imageRemove.dataset.invImageRemove });
        setStatus("Picture removed.");
      }, "Could not remove the picture");
      return;
    }
    // The record itself opens the invoice it was derived from; clicks
    // inside its controls (type select, note input, exit-form labels) stay
    // edits.
    if (event.target.closest("input, select, button, a, label")) return;
    const row = event.target.closest("[data-inv]");
    const item = items.find((candidate) => candidate.id === row?.dataset.inv);
    if (!item?.source) return;
    openTransaction?.(item.source.transactionId);
  });

  host.addEventListener("input", (event) => {
    if (event.target.closest("[data-inv-year]")) render();
    const exitField = event.target.closest("[data-inv-disposal]");
    if (exitField && exitForm && exitField.dataset.invDisposal !== "kind")
      exitForm[exitField.dataset.invDisposal] = exitField.value;
    const imageField = event.target.closest("[data-inv-image]");
    if (imageField && imageForm)
      imageForm[imageField.dataset.invImage] = imageField.value;
  });

  async function load() {
    const result = await api("/inventory");
    items = result.items || [];
    render();
  }

  return {
    renderInventory: () => safeAction(load, "Could not load inventory"),
  };
}
