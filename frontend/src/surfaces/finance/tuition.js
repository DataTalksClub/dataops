import { html } from './shared.js';

/** Tuition is an obligation; only verified receipts belong in the transaction ledger. */
export async function mountTuitionAgreements(root, { request, workApiUrl, escapeHtml: e }, initialId) {
  const api = (path, options) => request(workApiUrl(`/api/tuition${path}`), options);
  let cursor = '', query = '', selectedId = initialId || '';
  root.innerHTML = html`<h2>Tuition agreements &amp; installments</h2>
    <p>Individual course billing. Conditional installments retain their agreed trigger; a platform payout is recorded separately, once.</p>
    <div class="row-actions"><label>Search <input data-tuition-search type="search" /></label>
      <button type="button" data-tuition-add>Add agreement</button></div>
    <p role="status" data-tuition-status></p><div data-tuition-list></div><div data-tuition-detail></div>`;
  const status = root.querySelector('[data-tuition-status]');
  async function safe(action) { try { status.textContent = ''; await action(); } catch (error) { status.textContent = error.message; } }
  async function load() {
    const params = new URLSearchParams({ limit: '30', search: query }); if (cursor) params.set('cursor', cursor);
    const page = await api(`?${params}`);
    root.querySelector('[data-tuition-list]').innerHTML = page.items.length ? page.items.map((item) => html`<article class="crm-directory-row">
      <div><strong>${e(item.studentName)}</strong><p>${e(item.title)} · ${e(item.status)}</p>
      <small>${e(item.dueOn || item.trigger)}</small></div><button data-tuition-open="${e(item.id)}">Open agreement</button></article>`).join('')
      + (page.nextCursor ? html`<button data-tuition-next="${e(page.nextCursor)}">Next</button>` : '')
      : '<p>No tuition agreements match.</p>';
  }
  async function open(id) {
    selectedId = id;
    const item = id ? await api(`/${encodeURIComponent(id)}`) : {};
    root.querySelector('[data-tuition-detail]').innerHTML = html`<form data-tuition-form>
      <h3>${id ? 'Edit tuition agreement' : 'New tuition agreement'}</h3>
      <div class="dialog-fields">
      <label>Student <input name="studentName" required value="${e(item.studentName || '')}" /></label>
      <label>Agreement / installment <input name="title" required value="${e(item.title || '')}" /></label>
      <label>Payment trigger <input name="trigger" required value="${e(item.trigger || '')}" placeholder="Actual agreed condition" /></label>
      <label>Status <select name="status">${['conditional', 'due', 'invoiced', 'settled', 'cancelled'].map((value) =>
        html`<option ${item.status === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label>
      <label>Amount <input name="amount" inputmode="decimal" value="${e(item.amount || '')}" /></label>
      <label>Currency <input name="currency" value="${e(item.currency || '')}" /></label>
      <label>Due date, if agreed <input name="dueOn" type="date" value="${e(item.dueOn || '')}" /></label>
      <label>Notes <textarea name="notes">${e(item.notes || '')}</textarea></label></div>
      <button class="primary-button" type="submit">Save agreement</button>
      ${(item.taskIds || []).map((taskId) => html`<p><a href="/tasks?taskId=${e(taskId)}">Open billing task</a></p>`).join('')}
      ${item.evidence?.length ? html`<details><summary>Original records &amp; finance evidence (${item.evidence.length})</summary>
        ${item.evidence.map((source) => {
          const record = source.record || source;
          const facts = [record.title, record.amountDue && `${record.amountDue} ${record.currency || ''}`,
            record.invoiceNumber, record.dueOn, record.note, record.notes].filter(Boolean);
          const label = { DEAL: 'Original agreement', ORGANIZATION: 'Billing party', CONTACT: 'Billing contact', HISTORY: 'Agreement history' }[source.sourceKind]
            || 'Original finance evidence';
          return html`<article><strong>${e(label)}</strong>
            <p>${e(facts.join(' · ') || 'Original record retained with this agreement.')}</p></article>`;
        }).join('')}</details>` : ''}</form>`;
    root.querySelector('[data-tuition-form]').onsubmit = (event) => {
      event.preventDefault();
      const fields = Object.fromEntries(new FormData(event.currentTarget));
      for (const key of ['amount', 'currency']) if (!fields[key]) delete fields[key];
      fields.dueOn = fields.dueOn || null;
      safe(async () => {
        const saved = await api(id ? `/${encodeURIComponent(id)}` : '', { method: id ? 'PUT' : 'POST',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...fields, ...(id ? { version: item.version } : {}) }) });
        await load(); await open(saved.id);
      });
    };
  }
  root.addEventListener('click', (event) => {
    const id = event.target.closest('[data-tuition-open]')?.dataset.tuitionOpen;
    const next = event.target.closest('[data-tuition-next]')?.dataset.tuitionNext;
    if (id) safe(() => open(id));
    if (next) { cursor = next; safe(load); }
    if (event.target.closest('[data-tuition-add]')) safe(() => open(''));
  });
  let searchTimer;
  root.querySelector('[data-tuition-search]').oninput = (event) => {
    query = event.target.value; cursor = ''; clearTimeout(searchTimer); searchTimer = setTimeout(() => safe(load), 180);
  };
  await safe(async () => { await load(); if (selectedId) await open(selectedId); });
}

export function createTuitionLoader(root, context, initialId) {
  let mounted = false;
  return () => {
    if (mounted) return;
    mounted = true;
    return mountTuitionAgreements(root, context, initialId);
  };
}
