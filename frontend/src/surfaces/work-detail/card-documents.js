const drafts = new Map();
const workspaces = new WeakMap();
/** Private Card workspace. Text APIs keep document content inert. */
export function renderCardDocuments({ card, request, workApiUrl }) {
  let cached = workspaces.get(request);
  if (!cached) { cached = new Map(); workspaces.set(request, cached); }
  if (cached.has(card.id)) return cached.get(card.id);
  const section = document.createElement('section');
  cached.set(card.id, section);
  if (cached.size > 20) cached.delete(cached.keys().next().value);
  section.className = 'task-documents';
  section.setAttribute('aria-label', 'Staff-only card documents');
  const heading = document.createElement('h3');
  heading.textContent = 'Staff-only documents';
  const privacy = document.createElement('p');
  privacy.textContent = 'Only signed-in staff can open these documents. Guest codes do not grant access.';
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const list = document.createElement('div');
  const form = document.createElement('form');
  const kind = document.createElement('select');
  kind.setAttribute('aria-label', 'Document kind');
  for (const value of ['transcript', 'timecodes', 'summary', 'note']) {
    const option = document.createElement('option'); option.value = value; option.textContent = value[0].toUpperCase() + value.slice(1); kind.append(option);
  }
  const title = document.createElement('input');
  title.placeholder = 'Document title'; title.setAttribute('aria-label', 'New document title'); title.required = true; title.maxLength = 200;
  const create = document.createElement('button'); create.type = 'submit'; create.textContent = 'Create document';
  form.append(kind, title, create);
  form.addEventListener('submit', async event => {
    event.preventDefault(); create.disabled = true;
    try {
      const result = await request(workApiUrl('/api/card-documents'), { method: 'POST', body: JSON.stringify({ cardId: card.id, kind: kind.value, title: title.value, content: '' }) });
      title.value = ''; await load(result.document.id); status.textContent = 'Document created.';
    } catch (error) { status.textContent = error.message || 'Could not create document.'; }
    finally { create.disabled = false; }
  });
  function editor(doc, open) {
    if (typeof doc.content !== 'string') {
      const shell = document.createElement('details');
      const summary = document.createElement('summary'); summary.textContent = `${doc.title} · ${doc.kind}`;
      const feedback = document.createElement('p'); feedback.setAttribute('role', 'status');
      shell.append(summary, feedback); shell.open = open || drafts.has(doc.id);
      let pending = false;
      shell.addEventListener('toggle', async () => {
        if (!shell.open || pending) return;
        pending = true; feedback.textContent = 'Loading document…';
        try {
          const result = await request(workApiUrl(`/api/card-documents/${encodeURIComponent(doc.id)}`));
          shell.replaceWith(editor(result.document, true));
        } catch (error) { feedback.textContent = error.message || 'Could not load document. Close and reopen to retry.'; }
        finally { pending = false; }
      });
      return shell;
    }
    const draft = drafts.get(doc.id);
    if (draft) doc = { ...doc, version: draft.version };
    const details = document.createElement('details'); details.open = open || !!draft;
    const summary = document.createElement('summary'); summary.textContent = `${doc.title} · ${doc.kind}`;
    const name = document.createElement('input'); name.value = draft?.title ?? doc.title; name.maxLength = 200; name.setAttribute('aria-label', 'Document title');
    const text = document.createElement('textarea'); text.value = draft?.content ?? doc.content; text.rows = 16; text.setAttribute('aria-label', 'Document content');
    const remember = () => drafts.set(doc.id, { title: name.value, content: text.value, version: drafts.get(doc.id)?.version ?? doc.version });
    name.addEventListener('input', remember); text.addEventListener('input', remember);
    const save = document.createElement('button'); save.type = 'button'; save.textContent = 'Save document';
    const feedback = document.createElement('p'); feedback.setAttribute('role', 'status');
    save.addEventListener('click', async () => {
      save.disabled = true;
      const submittedDraft = drafts.get(doc.id);
      const submitted = { title: name.value, content: text.value, version: submittedDraft?.version ?? doc.version };
      try {
        const result = await request(workApiUrl(`/api/card-documents/${encodeURIComponent(doc.id)}`), {
          method: 'PUT',
          body: JSON.stringify(submitted),
        });
        doc = result.document; summary.textContent = `${doc.title} · ${doc.kind}`;
        const latest = drafts.get(doc.id);
        const newerDraft = latest && latest !== submittedDraft;
        const newerInputs = name.value !== submitted.title || text.value !== submitted.content;
        if (newerDraft || newerInputs || !details.isConnected) {
          const retained = newerDraft ? latest : { title: name.value, content: text.value };
          drafts.set(doc.id, { ...retained, version: doc.version });
        } else { drafts.delete(doc.id); }
        feedback.textContent = newerDraft || newerInputs ? 'Saved submitted text. You have unsaved changes.' : 'Saved.';
      } catch (error) { feedback.textContent = `${error.message || 'Could not save.'} Your text is still here. Copy it before reloading if another person changed the document.`; }
      finally { save.disabled = false; }
    });
    const exports = document.createElement('div');
    for (const format of ['txt', 'docx']) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = `Export ${format.toUpperCase()}`;
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const blob = await request(workApiUrl(`/api/card-documents/${encodeURIComponent(doc.id)}/export?format=${format}`), { responseType: 'blob' });
          const url = URL.createObjectURL(blob); const link = document.createElement('a');
          link.href = url; link.download = `${doc.title.replace(/[^a-zA-Z0-9_-]/g, '_') || 'document'}.${format}`;
          link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
          feedback.textContent = 'Exported the saved document.';
        } catch (error) { feedback.textContent = error.message || 'Could not export document.'; }
        finally { button.disabled = false; }
      });
      exports.append(button);
    }
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Delete document';
    remove.addEventListener('click', async () => {
      if (!window.confirm(`Delete “${doc.title}”?`)) return;
      remove.disabled = true;
      try {
        await request(workApiUrl(`/api/card-documents/${encodeURIComponent(doc.id)}?version=${doc.version}`), { method: 'DELETE' });
        drafts.delete(doc.id); await load();
      } catch (error) { feedback.textContent = error.message || 'Could not delete document.'; }
      finally { remove.disabled = false; }
    });
    details.append(summary, name, text, save, feedback, exports, remove);
    return details;
  }
  async function load(openId) {
    status.textContent = 'Loading documents…';
    try {
      const result = await request(workApiUrl(`/api/card-documents?cardId=${encodeURIComponent(card.id)}`));
      list.replaceChildren(...result.documents.map(doc => editor(doc, doc.id === openId)));
      status.textContent = result.documents.length ? '' : 'No documents yet. Create a transcript, timecodes, summary, or note for this card.';
    } catch (error) { status.textContent = error.message || 'Could not load documents.'; }
  }
  const refresh = document.createElement('button'); refresh.type = 'button'; refresh.textContent = 'Refresh documents';
  refresh.addEventListener('click', () => { void load(); });
  section.append(heading, privacy, form, refresh, status, list);
  void load();
  return section;
}
