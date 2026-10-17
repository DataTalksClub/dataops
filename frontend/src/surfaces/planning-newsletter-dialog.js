import { createIssueSlotForm, issueSlotFieldsetsMarkup, issueSlotFormMarkup, SLOT_FORM_FIELD } from "./planning-newsletter-slots.js";

/** The issue edit dialog: date, kind, slots, status, campaign link and note. */
export function renderNewsletterDialogMarkup(newsletterStatusOptions) {
  return `
    <dialog class="dk-dialog" style="--dk-dialog-width: 760px; max-width: 95vw;">
      <form method="dialog">
        <div class="dk-dialog__head">
          <div class="newsletter-dialog-head-title">
            <h2 data-dialog-title>Newsletter issue</h2>
            <p data-dialog-subtitle>One email: its date, sponsor slots and card.</p>
          </div>
        </div>
        <div class="dk-dialog__body">
          <input name="id" type="hidden">
          <input name="version" type="hidden">
          <div class="planner-form-grid">
            ${issueSlotFormMarkup()}
            <label>Status
              <select name="status">${newsletterStatusOptions}</select>
            </label>
            ${issueSlotFieldsetsMarkup()}
            <div class="planner-field-wide newsletter-campaign-field">
              <label>Public campaign URL <input name="publicUrl" type="url"></label>
              <a data-campaign-link target="_blank" rel="noreferrer" hidden>Open campaign</a>
            </div>
            <label class="planner-field-wide">Planning note <textarea name="planningNote" rows="4"></textarea></label>
          </div>
          <p class="planner-form-error" role="alert"></p>
        </div>
        <div class="dk-dialog__foot">
          <button class="primary-button" data-save>Save issue</button>
          <button value="cancel">Cancel</button>
        </div>
      </form>
    </dialog>
  `;
}

export function setupNewsletterDialog(options) {
  const { surface, dialog, form, api, load } = options;

  let currentEditingItem = null;
  const slotForm = createIssueSlotForm({ dialog, form, currentItem: () => currentEditingItem });

  function openIssueDialog(item) {
    currentEditingItem = item || null;
    form.reset();
    form.querySelector('[role="alert"]').textContent = "";
    if (item) {
      for (const key of Object.keys(item)) {
        if (form.elements[key] && typeof item[key] !== "object") form.elements[key].value = item[key] ?? "";
      }
    }
    slotForm.fill(item);
    if (form.elements.publicationTime) {
      form.elements.publicationTime.value = item?.publicationTime || "14:00";
    }
    const titleEl = dialog.querySelector("[data-dialog-title]");
    if (titleEl) titleEl.textContent = item?.label || "Newsletter issue";
    const campaignLink = dialog.querySelector("[data-campaign-link]");
    if (campaignLink) {
      campaignLink.hidden = !item?.publicUrl;
      if (item?.publicUrl) campaignLink.href = item.publicUrl;
      else campaignLink.removeAttribute?.("href");
    }
    if (dialog.showModal) {
      dialog.showModal();
    }
  }

  const saveBtn = (surface && surface.querySelector("[data-save]")) ||
    dialog.querySelector("[data-save]");
  if (saveBtn) {
    saveBtn.onclick = async (event) => {
      event.preventDefault();
      form.querySelector('[role="alert"]').textContent = "";
      const value = Object.fromEntries(
        [...new FormData(form)].filter(
          ([k, v]) =>
            v !== "" &&
            !SLOT_FORM_FIELD.test(k),
        ),
      );
      const id = value.id;
      delete value.id;
      if (value.version) value.version = Number(value.version);
      if (value.issueNumber) value.issueNumber = Number(value.issueNumber);
      if (value.kind === "standalone") delete value.issueNumber;
      if (id) delete value.kind;
      value.slots = slotForm.values(value.kind || currentEditingItem?.kind || "weekly");
      const issueStats = slotForm.issueStats();
      if (issueStats !== undefined) value.stats = issueStats;

      if (typeof value.planningNote === "string" && value.planningNote.length > 900) {
        value.planningNote = `${value.planningNote.slice(0, 890)}…`;
      }

      const send = (body) => api(id ? `/${id}` : "", {
        method: id ? "PUT" : "POST",
        body: JSON.stringify(body),
      });
      try {
        try {
          await send(value);
        } catch (error) {
          // Cancelling deletes the issue's card; it asks first when the card
          // has completed work.
          if (!["card-has-completed-tasks", "slot-has-completed-tasks"].includes(error?.code)) throw error;
          if (!globalThis.confirm?.(error.message)) return;
          await send({ ...value, confirmCardDeletion: true, confirmSlotRemoval: true });
        }
        dialog.close();
        await load();
      } catch (error) {
        form.querySelector('[role="alert"]').textContent =
          `Could not save the issue: ${error.message}`;
      }
    };
  }

  return { openIssueDialog };
}
