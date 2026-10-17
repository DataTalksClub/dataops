/** Contact editing never sends or queues a message. */

function normalizeEmails(value) {
  return String(value || "")
    .split(/[,\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Reusable sponsor contact editor (F-owned behavior, E-owned form markup).
 *
 * open(target, { companies }): target is a contact record, { id } (exact
 * record loaded by ID when the preloaded collection does not carry it — no
 * full directory load), or { organizationId } for a new contact preset to a
 * company. {} opens a blank create with the company chooser visible.
 *
 * Company association stays explicit: the dialog's hidden organizationId
 * always carries the associated company; E's [data-contact-org-picker]
 * select (populated here from the provided companies or
 * getOrganizations()) offers the choice when no org is preset. Optimistic
 * versions are passed through untouched; a 409 surfaces as a save error
 * with the dialog kept open. lastContactedAt keeps full stored precision:
 * the date input only replaces the value when the user changes that date.
 */
export function createSponsorContactEditor({ api, surface, getContacts, getOrganizations, safe, openDialog, afterSave, captureSaveContext }) {
  const dialog = surface.querySelector("[data-contact-dialog]");
  const form = dialog.querySelector("form");
  let originalLastContactedAt = "";

  function companies() {
    if (typeof getOrganizations === "function") {
      try {
        return getOrganizations().filter((item) => !item.archivedAt);
      } catch {
        return [];
      }
    }
    return [];
  }

  function fillCompanyPicker(presetOrganizationId, provided = []) {
    const picker = form.querySelector("[data-contact-org-picker]");
    const hidden = form.elements.organizationId;
    const list = [...provided, ...companies()].filter(
      (item, index, all) => item && item.id && all.findIndex((other) => other.id === item.id) === index,
    );
    if (picker) {
      picker.innerHTML = `<option value="">Select a company</option>` + list
        .map((item) => `<option value="${item.id}">${item.displayName || item.id}</option>`)
        .join("");
      const row = picker.closest("label");
      if (row) row.hidden = Boolean(presetOrganizationId);
      picker.value = presetOrganizationId || "";
      picker.disabled = Boolean(presetOrganizationId);
    }
    if (hidden) hidden.value = presetOrganizationId || "";
  }

  function fillForm(contact, presetOrganizationId = "") {
    form.reset();
    originalLastContactedAt = String(contact?.lastContactedAt || "");
    for (const name of ["name", "role", "notes", "linkedin", "telegram", "organizationId", "version"]) {
      if (form.elements[name]) form.elements[name].value = contact?.[name] ?? "";
    }
    if (form.elements.contactId) form.elements.contactId.value = contact?.id || "";
    if (form.elements.email) form.elements.email.value = (contact?.emails || []).join(", ");
    if (form.elements.lastContactedAt) {
      form.elements.lastContactedAt.value = originalLastContactedAt.slice(0, 10);
      form.elements.lastContactedAt.dataset.original = originalLastContactedAt;
    }
    if (form.elements.primary) form.elements.primary.checked = Boolean(contact?.primary);
    fillCompanyPicker(contact?.organizationId || presetOrganizationId);
  }

  async function open(target = {}, options = {}) {
    let contact = null;
    let presetOrganizationId = "";
    if (target && typeof target === "object" && !Array.isArray(target)) {
      if (target.id && !target.emails && typeof target.name !== "string") {
        const known = (typeof getContacts === "function" ? getContacts() : []).find((item) => item.id === target.id);
        contact = known || await api(`/contacts/${encodeURIComponent(target.id)}`);
      } else if (target.id || target.name !== undefined || target.emails !== undefined) {
        contact = target;
      } else if (target.organizationId) {
        presetOrganizationId = target.organizationId;
      }
    }
    if (contact?.organizationId) presetOrganizationId = contact.organizationId;
    fillForm(contact, presetOrganizationId);
    if (options.companies) fillCompanyPicker(presetOrganizationId, options.companies);
    openDialog(dialog);
    return contact;
  }

  surface.addEventListener("click", (event) => {
    const button = event.target.closest("[data-edit-contact]");
    if (!button) return;
    safe(() => open({ id: button.dataset.editContact }), "Could not open contact");
  });

  surface.querySelector("[data-contact-save]").onclick = async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    // Capture the navigation context synchronously at submit: E's afterSave
    // runs only after the async contact API settles, by which time the user
    // may have navigated elsewhere. The captured snapshot travels as the
    // second afterSave argument so E can check it across awaits.
    const saveContext = typeof captureSaveContext === "function" ? captureSaveContext() : undefined;
    await safe(async () => {
      const raw = Object.fromEntries(new FormData(form));
      const id = raw.contactId;
      const picked = form.querySelector("[data-contact-org-picker]");
      const organizationId = raw.organizationId || picked?.value || "";
      // Preserve full stored precision unless the user changed that date.
      const editedDay = String(raw.lastContactedAt || "");
      const originalDay = String(form.elements.lastContactedAt?.dataset.original || "").slice(0, 10);
      const lastContactedAt = !editedDay
        ? null
        : editedDay === originalDay
          ? (form.elements.lastContactedAt?.dataset.original || editedDay)
          : editedDay;
      const payload = {
        organizationId,
        name: raw.name,
        role: raw.role,
        emails: normalizeEmails(raw.email),
        notes: raw.notes,
        linkedin: raw.linkedin,
        telegram: raw.telegram,
        lastContactedAt,
        primary: form.elements.primary.checked,
        ...(id ? { version: Number(raw.version) } : {}),
      };
      const saved = await api(`/contacts${id ? `/${encodeURIComponent(id)}` : ""}`, {
        method: id ? "PUT" : "POST",
        body: JSON.stringify(payload),
      });
      dialog.close();
      await afterSave(saved.organizationId || organizationId, saveContext);
    }, "Could not save contact");
  };

  return { open };
}
