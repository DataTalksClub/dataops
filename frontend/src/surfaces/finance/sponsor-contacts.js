/** Contact editing never sends or queues a message. */

function normalizeEmails(value) {
  return String(value || "")
    .split(/[,\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/**
 * Reusable sponsor contact editor (F-owned behavior, E-owned form markup).
 *
 * open(target, { companies }): target is a contact record, { id } (exact
 * record loaded by ID when the preloaded collection does not carry it — no
 * full directory load), or { organizationId } for a new contact preset to a
 * company. {} opens a blank create with the company chooser visible.
 *
 * Company association stays explicit and changeable on edit as well as
 * create: the dialog's [data-contact-org-picker] select is always usable
 * (populated here from the provided companies or getOrganizations(), plus
 * one bounded active-companies page when the cache is thin, with an honest
 * labeled fallback when the current association is unknown); the hidden
 * organizationId follows the picker and carries the submitted value. A
 * failed bounded lookup keeps the cached entries and surfaces an honest
 * chooser-unavailable hint (reopening the editor retries); explicit
 * associations are never silently rewritten. Optimistic versions are passed through untouched; a 409 surfaces as a save error
 * with the dialog kept open. lastContactedAt keeps full stored precision:
 * the date input only replaces the value when the user changes that date.
 */
export function createSponsorContactEditor({ api, surface, getContacts, getOrganizations, safe, openDialog, afterSave, captureSaveContext }) {
  const dialog = surface.querySelector("[data-contact-dialog]");
  const form = dialog.querySelector("form");
  let originalLastContactedAt = "";

  function companies(includeInactive = false) {
    if (typeof getOrganizations !== "function") return [];
    try {
      const all = getOrganizations();
      return includeInactive ? all : all.filter((item) => !item.archivedAt && item.active !== false);
    } catch {
      return [];
    }
  }

  let orgNotice = null;

  async function companyChoices(presetOrganizationId, provided = []) {
    const list = [...provided, ...companies()].filter(
      (item, index, all) => item && item.id && all.findIndex((other) => other.id === item.id) === index,
    ).filter((item) => item.id === presetOrganizationId || (!item.archivedAt && item.active !== false));
    // An unknown or inactive current association stays honest and selectable:
    // never silently drop it from the chooser, never invent a display name
    // for it. Inactive alternatives are filtered out; the current one is
    // retained with its real name when known.
    if (presetOrganizationId && !list.some((item) => item.id === presetOrganizationId)) {
      const known = [...provided, ...companies(true)].find((item) => item && item.id === presetOrganizationId);
      list.unshift({ id: presetOrganizationId, displayName: (known && known.displayName) || `Current company (${presetOrganizationId})` });
    }
    let limited = false;
    if (provided.length === 0 && list.length < 2) {
      // Cold opens (person record without a loaded directory) would offer
      // only the current org: fetch one bounded active-companies page so the
      // chooser offers real alternatives. Never a whole-directory load.
      // Active-only; archived companies stay out unless already associated.
      try {
        const page = await api("/directory/companies?limit=50&active=true");
        for (const item of page.items || []) {
          if (item && item.id && !list.some((other) => other.id === item.id)) list.push(item);
        }
      } catch {
        // Keep the cached entries; the chooser stays usable and the notice
        // below says so honestly instead of implying complete alternatives.
        limited = true;
      }
    }
    return { list, limited };
  }

  function setOrgNotice(picker, limited) {
    if (typeof document === "undefined" || typeof document.createElement !== "function" || !picker?.after) {
      return;
    }
    if (!limited) {
      orgNotice?.remove();
      orgNotice = null;
      return;
    }
    // Honest text hint only: reopening the editor retries the bounded
    // lookup. No async retry controller, no selection resets.
    if (!orgNotice) {
      const hint = document.createElement("p");
      hint.setAttribute("data-contact-org-hint", "");
      picker.after(hint);
      orgNotice = hint;
    }
    orgNotice.textContent = "Company list unavailable — showing cached and current choices only. Reopen the editor to retry.";
  }

  function paintCompanyPicker(picker, presetOrganizationId, { list, limited }) {
    picker.innerHTML = `<option value="">Select a company</option>` + list
      .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.displayName || item.id)}</option>`)
      .join("");
    const row = picker.closest("label");
    if (row) row.hidden = false;
    picker.value = presetOrganizationId || "";
    picker.disabled = false;
    setOrgNotice(picker, limited);
  }

  function fillCompanyPicker(presetOrganizationId, provided = []) {
    const picker = form.querySelector("[data-contact-org-picker]");
    const hidden = form.elements.organizationId;
    if (!picker) {
      if (hidden) hidden.value = presetOrganizationId || "";
      return Promise.resolve();
    }
    if (!picker.dataset.wiredOrg) {
      picker.dataset.wiredOrg = "true";
      picker.addEventListener("change", () => {
        if (hidden) hidden.value = picker.value || "";
      });
    }
    return companyChoices(presetOrganizationId, provided).then(({ list, limited }) => {
      paintCompanyPicker(picker, presetOrganizationId, { list, limited });
      if (hidden) hidden.value = picker.value || presetOrganizationId || "";
    });
  }

  async function fillForm(contact, presetOrganizationId = "", providedCompanies = []) {
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
    await fillCompanyPicker(contact?.organizationId || presetOrganizationId, providedCompanies);
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
    await fillForm(contact, presetOrganizationId, options.companies || []);
    openDialog(dialog);
    return contact;
  }

  surface.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-edit-contact]");
    if (!button) return;
    await safe(() => open({ id: button.dataset.editContact }), "Could not open contact");
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
