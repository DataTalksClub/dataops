import { html } from './shared.js';

/** Tuition is an obligation; only verified receipts belong in the transaction ledger. */
export async function mountTuitionAgreements(root, context, initialId) {
  const { request, workApiUrl, escapeHtml: e } = context;
  const api = (path, options) => request(workApiUrl(`/api/tuition${path}`), options);
  let cursor = '', query = '', selectedId = initialId || '', listGeneration = 0, detailGeneration = 0, retry = null;
  const previous = [];
  root.innerHTML = html`<h2>Tuition agreements &amp; installments</h2>
    <p>Individual course billing. Keep the agreed payment trigger; record the platform payout separately, once.</p>
    <div class="row-actions"><label>Search <input data-tuition-search type="search" /></label>
      <button type="button" data-tuition-add>Add agreement</button></div>
    <p role="status" data-tuition-status></p><button type="button" data-tuition-retry hidden>Retry</button>
    <div data-tuition-list></div><div data-tuition-detail></div>`;
  const status = root.querySelector('[data-tuition-status]'), retryButton = root.querySelector('[data-tuition-retry]');
  const alive = () => root.isConnected !== false;
  function message(text = '', action = null) { status.textContent = text; retry = action; retryButton.hidden = !action; }
  function recordSelection(id) {
    selectedId = id;
    const params = new URLSearchParams({ view: 'tuition' }); if (id) params.set('agreement', id);
    const url = `/bookkeeping?${params}`;
    if (context.navigateCanonicalWorkspace) context.navigateCanonicalWorkspace(url, {}, { render: false });
    else (context.historyRef || globalThis.history)?.replaceState(null, '', url);
  }
  async function load() {
    const generation = ++listGeneration;
    const params = new URLSearchParams({ limit: '30', search: query }); if (cursor) params.set('cursor', cursor);
    message('Loading agreements…');
    try {
      const page = await api(`?${params}`);
      if (!alive() || generation !== listGeneration) return;
      root.querySelector('[data-tuition-list]').innerHTML = (page.items.length ? page.items.map((item) => html`<article class="crm-directory-row">
        <div><strong>${e(item.studentName)}</strong><p>${e(item.title)} · ${e(item.status)}</p>
        <small>${e(item.dueOn || item.trigger)}</small></div><button data-tuition-open="${e(item.id)}">Open agreement</button></article>`).join('')
        : '<p>No tuition agreements match.</p>') + html`<nav aria-label="Tuition pages" class="row-actions">
          <button data-tuition-prev ${previous.length ? '' : 'disabled'}>Previous</button>
          <span>${page.total} matching agreements</span>
          <button data-tuition-next="${e(page.nextCursor || '')}" ${page.nextCursor ? '' : 'disabled'}>Next</button></nav>`;
      message();
    } catch (error) { if (alive() && generation === listGeneration) message(error.message, load); }
  }
  function evidenceMarkup(items = []) {
    if (!items.length) return '';
    return html`<details><summary>Original records &amp; finance evidence (${items.length})</summary>${items.map((source) => {
      const record = source.record || source;
      const facts = [record.title, record.amountDue && `${record.amountDue} ${record.currency || ''}`,
        record.invoiceNumber, record.dueOn, record.note, record.notes, record.trigger,
        ...(Array.isArray(record.sourceRefs) ? record.sourceRefs : [])].filter(Boolean);
      const label = { DEAL: 'Original agreement', ORGANIZATION: 'Billing party', CONTACT: 'Billing contact',
        HISTORY: 'Agreement history', STATUS_REVIEW: 'Billing classification review' }[source.sourceKind]
        || 'Original finance evidence';
      return html`<article><strong>${e(label)}</strong><p>${e(facts.join(' · ') || 'Original evidence retained with this agreement.')}</p></article>`;
    }).join('')}</details>`;
  }
  function drawForm(item, id, generation) {
    const detail = root.querySelector('[data-tuition-detail]');
    detail.innerHTML = html`<form data-tuition-form>
      <h3>${id ? 'Edit tuition agreement' : 'New tuition agreement'}</h3><div class="dialog-fields">
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
      ${evidenceMarkup(item.evidence)}</form>`;
    const form = detail.querySelector('[data-tuition-form]'), button = form.querySelector('[type="submit"]');
    let saving = false;
    form.onsubmit = async (event) => {
      event.preventDefault(); if (saving) return;
      saving = true; button.disabled = true; form.setAttribute('aria-busy', 'true');
      const fields = Object.fromEntries(new FormData(form));
      for (const key of ['amount', 'currency', 'dueOn']) fields[key] = fields[key] || null;
      try {
        const saved = await api(id ? `/${encodeURIComponent(id)}` : '', { method: id ? 'PUT' : 'POST',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...fields, ...(id ? { version: item.version } : {}) }) });
        if (!alive()) return;
        await load(); if (generation === detailGeneration) await open(saved.id);
      } catch (error) { if (alive() && generation === detailGeneration) message(error.message); }
      finally { saving = false; button.disabled = false; form.removeAttribute('aria-busy'); }
    };
  }
  async function open(id) {
    const generation = ++detailGeneration;
    recordSelection(id); message('Loading agreement…');
    const detail = root.querySelector('[data-tuition-detail]');
    detail.innerHTML = '<p role="status">Loading selected agreement…</p>';
    detail.setAttribute('aria-busy', 'true');
    try {
      const item = id ? await api(`/${encodeURIComponent(id)}`) : {};
      if (!alive() || generation !== detailGeneration) return;
      drawForm(item, id, generation); message();
    } catch (error) {
      if (alive() && generation === detailGeneration) {
        detail.innerHTML = '<p>Could not load the selected agreement.</p>';
        message(error.message, () => open(id));
      }
    } finally { if (alive() && generation === detailGeneration) detail.removeAttribute('aria-busy'); }
  }
  root.addEventListener('click', (event) => {
    const id = event.target.closest('[data-tuition-open]')?.dataset.tuitionOpen;
    const next = event.target.closest('[data-tuition-next]')?.dataset.tuitionNext;
    if (id) open(id);
    if (next) { previous.push(cursor); cursor = next; load(); }
    if (event.target.closest('[data-tuition-prev]') && previous.length) { cursor = previous.pop(); load(); }
    if (event.target.closest('[data-tuition-add]')) open('');
    if (event.target.closest('[data-tuition-retry]') && retry) retry();
  });
  let searchTimer;
  root.querySelector('[data-tuition-search]').oninput = (event) => {
    query = event.target.value; cursor = ''; previous.length = 0; listGeneration += 1;
    clearTimeout(searchTimer); searchTimer = setTimeout(load, 180);
  };
  await load(); if (selectedId) await open(selectedId); else recordSelection('');
}

export function createTuitionLoader(root, context, initialId) {
  let mounted = false;
  return () => { if (!mounted) { mounted = true; return mountTuitionAgreements(root, context, initialId); } };
}
