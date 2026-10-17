/** Contact editing never sends or queues a message. */
export function createSponsorContactEditor({ api, surface, getContacts, safe, openDialog, afterSave }) {
  const dialog = surface.querySelector('[data-contact-dialog]'), form = dialog.querySelector('form');
  surface.addEventListener('click', (event) => {
    const button = event.target.closest('[data-edit-contact]');
    if (!button) return;
    const contact = getContacts().find((item) => item.id === button.dataset.editContact);
    if (!contact) return;
    form.reset();
    for (const name of ['name', 'role', 'notes', 'linkedin', 'telegram', 'organizationId', 'version']) form.elements[name].value = contact[name] || '';
    form.elements.contactId.value = contact.id;
    form.elements.email.value = (contact.emails || []).join(', ');
    form.elements.lastContactedAt.value = String(contact.lastContactedAt || '').slice(0, 10);
    form.elements.primary.checked = Boolean(contact.primary);
    openDialog(dialog);
  });
  surface.querySelector('[data-contact-save]').onclick = (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    safe(async () => {
      const raw = Object.fromEntries(new FormData(form));
      const id = raw.contactId;
      const payload = { organizationId: raw.organizationId, name: raw.name, role: raw.role,
        emails: String(raw.email).split(',').map((value) => value.trim()).filter(Boolean),
        notes: raw.notes, linkedin: raw.linkedin, telegram: raw.telegram,
        lastContactedAt: raw.lastContactedAt || null, primary: form.elements.primary.checked,
        ...(id ? { version: Number(raw.version) } : {}),
      };
      await api(`/contacts${id ? `/${encodeURIComponent(id)}` : ''}`, { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
      dialog.close();
      await afterSave(raw.organizationId);
    }, 'Could not save contact');
  };
}
