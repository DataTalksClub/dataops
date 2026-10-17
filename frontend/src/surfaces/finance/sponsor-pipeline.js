import { html } from './shared.js';

export const SPONSOR_PIPELINE_STAGES = Object.freeze([
  { id: 'open', label: 'Opportunities' }, { id: 'agreed', label: 'Agreed' },
  { id: 'invoiced', label: 'Invoiced' }, { id: 'running', label: 'Running' },
  { id: 'closed', label: 'Closed' }, { id: 'lost', label: 'Lost' },
]);

export function renderSponsorPipelineFilters({ counts = {}, selected = '', escapeHtml }) {
  return SPONSOR_PIPELINE_STAGES.map(({ id, label }) => html`<button type="button"
    data-pipeline-status="${id}" aria-pressed="${selected === id}">
    ${label} <strong>${escapeHtml(counts[id] || 0)}</strong></button>`).join('');
}

function row(item, { escapeHtml: e, humanSponsorDate: date, ownerName }) {
  const contact = item.primaryContact;
  const task = item.nextTask;
  const review = item.replyReview && (!task || task.deferred);
  const action = review ? 'Review newer inbound (inferred)' : task ? `${task.deferred ? 'Deferred: ' : ''}${task.description}` : 'No open task';
  const when = review ? `Inbound ${date(item.inboundAt)}` : task?.date ? date(task.date) : '';
  const deferred = review && task?.deferred ? `Deferred task: ${task.description}` : '';
  const amount = item.amountEur != null ? new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(item.amountEur) : '—';
  return html`<tr>
    <td><button class="crm-row-link" data-open-deal="${e(item.id)}">${e(item.organizationName)}</button>
      ${item.title ? html`<small>${e(item.title)}</small>` : ''}
      <small>${contact ? e([contact.name, contact.email].filter(Boolean).join(' · ')) : 'No primary contact'}</small>
      <small class="crm-phone-stage">${e(item.stage)}</small></td>
    <td>${e(SPONSOR_PIPELINE_STAGES.find(({ id }) => id === item.stage)?.label || item.stage)}</td>
    <td>${task && !review
      ? html`<button class="crm-row-link" data-pipeline-task="${e(task.id)}">${e(action)}</button>` : e(action)}
      <small>${e(when)}</small>${deferred ? html`<small>${e(deferred)}</small>` : ''}</td>
    <td>${e(ownerName(item.nextTask?.assigneeId))}</td>
    <td>${e(item.lastContacted ? date(item.lastContacted) : 'Never')}</td>
    <td>${e(amount)}</td>
  </tr>`;
}

export function renderSponsorPipelineList({ items, ...context }) {
  const focused = items.filter((item) => ['agreed', 'invoiced', 'running'].includes(item.stage));
  const other = items.filter((item) => !['agreed', 'invoiced', 'running'].includes(item.stage));
  const section = (title, values) => values.length ? html`<section class="crm-funnel-section"><h3>${title} <span>${values.length} on this page</span></h3>
    <div class="crm-funnel-scroll"><table class="crm-funnel-table"><thead><tr>
    <th>Company / contact</th><th>Stage</th><th>Next action</th><th>Owner</th><th>Last touch</th><th>Value</th>
    </tr></thead><tbody>${values.map((item) => row(item, context)).join('')}</tbody></table></div></section>` : '';
  return section('Active commitments', focused) + section('Opportunities & history', other)
    || '<div class="honest-state"><strong>No matching deals</strong><p>Choose Active or All to explore the rest of the funnel.</p></div>';
}

// URL/filter/saved-view lifecycle (E): the view reads its filters from the
// pipeline controls, but the effective state lives in the URL. Pure mapping
// between saved-view vocabulary (sort next|recent) and control values
// (next-action|recent) end to end: saved views store control values, the list
// endpoint receives them, and sponsors.js owns URL read/write around load().
// Effective saved-view filters onto control values. organizationId has no
// control: it rides as an extra API param through load() instead.
export function pipelineControlsFromFilters(filters = {}, sort = 'next-action') {
  const field = sort && typeof sort === "object" ? sort.field : sort;
  return {
    view: filters.view || 'actionable',
    stage: filters.stage || '',
    search: filters.search || '',
    owner: filters.owner || '',
    sort: field === 'recent' ? 'recent' : 'next-action',
    nextActionFrom: filters.nextActionFrom || '',
    nextActionBefore: filters.nextActionBefore || '',
    ...(filters.organizationId ? { organizationId: filters.organizationId } : {}),
  };
}

export function createSponsorPipelineView({ api, surface, escapeHtml, humanSponsorDate, ownerName, openTaskPanel, safe, onChange, captureCurrent }) {
  let result = { items: [], counts: {}, total: 0 }, cursor = '', generation = 0;
  const previous = [];
  const root = surface.querySelector('[data-crm-bookings]');
  function draw() {
    surface.querySelector('[data-crm-pipeline]').setAttribute('aria-label', 'Stage totals reflect search and company; owner, date, view and stage filter the list below');
    surface.querySelector('[data-crm-pipeline]').innerHTML = renderSponsorPipelineFilters({
      counts: result.counts, selected: surface.querySelector('[data-crm-status]').value, escapeHtml,
    });
    surface.querySelector('[data-booking-count]').textContent = `${result.total} matching deals`;
    root.innerHTML = renderSponsorPipelineList({ items: result.items, escapeHtml, humanSponsorDate, ownerName }) + html`<nav class="crm-funnel-pages" aria-label="Pipeline pages">
      <button data-pipeline-prev ${previous.length ? '' : 'disabled'}>Previous</button>
      <span>${result.total ? Number(cursor || 0) + 1 : 0}–${Number(cursor || 0) + result.items.length} of ${result.total}</span>
      <button data-pipeline-next ${result.nextCursor ? '' : 'disabled'}>Next</button></nav>`;
  }
  async function load(reset = true, options = {}) {
    const isCurrent = options.isCurrent || (typeof captureCurrent === 'function' ? captureCurrent() : () => true);
    if (!isCurrent()) return;
    if (reset) { cursor = ''; previous.length = 0; surface.querySelector('[data-crm-list-scroll]').scrollTop = 0; }
    // A deep-linked cursor (refresh/back) starts a fresh page stack: Next
    // works from there, Previous needs in-session paging.
    if (options.cursor !== undefined) { cursor = options.cursor || ''; previous.length = 0; }
    const token = ++generation;
    const settled = () => token === generation && surface.isConnected && isCurrent();
    root.setAttribute('aria-busy', 'true');
    const query = new URLSearchParams({ limit: '30', view: surface.querySelector('[data-pipeline-view]').value, sort: surface.querySelector('[data-pipeline-sort]').value });
    for (const [key, selector] of [['search', '[data-crm-search]'], ['stage', '[data-crm-status]'], ['owner', '[data-pipeline-owner]'],
        ['nextActionFrom', '[data-pipeline-from]'], ['nextActionBefore', '[data-pipeline-to]']]) {
      const value = surface.querySelector(selector).value; if (value) query.set(key, value);
    }
    if (options.organizationId) query.set('organizationId', options.organizationId);
    if (cursor) query.set('cursor', cursor);
    try {
      const page = await api(`/pipeline?${query}`);
      if (!settled()) return;
      result = page;
      surface.querySelector('[data-crm-nav-tab="money"]').hidden = !page.financeEnabled;
      draw();
      onChange?.({
        filters: Object.fromEntries(query.entries()),
        cursor,
        hasPrev: previous.length > 0,
        hasNext: !!result.nextCursor,
        total: result.total,
        isCurrent: settled,
      });
    } catch (error) {
      if (!settled()) return;
      throw error;
    } finally { if (token === generation) root.removeAttribute('aria-busy'); }
  }
  root.addEventListener('click', (event) => {
    const taskId = event.target.closest('[data-pipeline-task]')?.dataset.pipelineTask;
    if (taskId) openTaskPanel(taskId);
    if (event.target.closest('[data-pipeline-next]') && result.nextCursor) {
      previous.push(cursor); cursor = result.nextCursor; safe(() => load(false), 'Could not load pipeline');
    }
    if (event.target.closest('[data-pipeline-prev]') && previous.length) {
      cursor = previous.pop(); safe(() => load(false), 'Could not load pipeline');
    }
  });
  return { load, draw };
}
