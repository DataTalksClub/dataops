export async function mountInvoiceGenerator(host, { request, workApiUrl, escapeHtml }) {
  const e = (value) => escapeHtml(String(value ?? ''));
  const api = (path, body) => request(workApiUrl(`/api/bookkeeping/invoice-generation${path}`), body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const field = (name, label, multiline = false) => `<label class="dk-label"><span>${label}</span>${multiline
    ? `<textarea class="dk-textarea" name="${name}" rows="3" required></textarea>`
    : `<input class="dk-input" name="${name}" required>`}</label>`;
  host.innerHTML = `<h3>Create contractor invoice</h3>
    <p>Choose an approved template, enter the reporting period and work items, then download the PDF for filing.</p>
    <p role="status" data-generator-status></p>
    <details data-template-details><summary>Add invoice template</summary>
      <form class="dk-stack dk-stack--tight" data-template-form>
        ${field('name', 'Template name')}${field('issuer', 'Contractor name, address and tax ID', true)}
        ${field('recipient', 'Customer name, address and tax ID', true)}
        ${field('paymentDetails', 'Payment details', true)}${field('taxNote', 'Approved tax treatment', true)}
        <label class="dk-label"><span>Currency</span>
          <select class="dk-select" name="currency"><option>EUR</option><option>USD</option><option>GBP</option></select></label>
        <button type="submit" class="dk-button dk-button--secondary">Save invoice template</button>
      </form>
    </details>
    <form class="dk-stack dk-stack--tight" data-generate-form>
      <label class="dk-label"><span>Invoice template</span>
        <select class="dk-select" name="templateId" required><option value="">Loading templates…</option></select></label>
      <div data-template-preview></div>
      ${field('invoiceNumber', 'Invoice number')}
      <label class="dk-label"><span>Invoice date</span><input class="dk-input" type="date" name="issueDate" required></label>
      ${field('servicePeriod', 'Services provided in')}
      <div data-invoice-items></div>
      <button type="button" class="dk-button dk-button--secondary" data-add-item>Add invoice item</button>
      <button type="submit" class="dk-button dk-button--primary" data-generate-pdf>Generate PDF</button>
    </form>`;
  const status = host.querySelector('[data-generator-status]');
  const form = host.querySelector('[data-generate-form]');
  const select = form.elements.templateId;
  const preview = host.querySelector('[data-template-preview]');
  const items = host.querySelector('[data-invoice-items]');
  let templates = [];
  function showTemplate() {
    const t = templates.find((item) => item.id === select.value)?.template;
    preview.replaceChildren();
    if (t) for (const text of [t.issuer, `Bill to\n${t.recipient}`, t.paymentDetails, t.taxNote, `Currency: ${t.currency}`]) {
      const paragraph = document.createElement('p');
      text.split('\n').forEach((line, index) => {
        if (index) paragraph.append(document.createElement('br'));
        paragraph.append(document.createTextNode(line));
      });
      preview.append(paragraph);
    }
  }
  async function refresh(selected = select.value) {
    templates = (await api('/templates')).items;
    select.innerHTML = `<option value="">Choose a template</option>${templates.map((t) => `<option value="${e(t.id)}">${e(t.name)}</option>`).join('')}`;
    select.value = selected;
    showTemplate();
    if (!templates.length) {
      host.querySelector('[data-template-details]').open = true;
      status.textContent = 'Add an approved invoice template to begin.';
    }
  }
  function addItem() {
    const row = document.createElement('fieldset');
    row.className = 'dk-card';
    row.dataset.invoiceItem = '';
    row.innerHTML = `<legend>Invoice item</legend>${field('description', 'Work item')}
      <label class="dk-label"><span>Amount (template currency)</span>
        <input class="dk-input" name="amount" type="number" min="0.01" step="0.01" required></label>
      <button type="button" class="dk-button dk-button--secondary">Remove item</button>`;
    row.querySelector('button').addEventListener('click', () => {
      if (items.children.length > 1) row.remove();
      else status.textContent = 'At least one invoice item is required.';
    });
    items.append(row);
  }
  addItem();
  host.querySelector('[data-add-item]').addEventListener('click', () => {
    if (items.children.length < 50) {
      addItem();
      items.lastElementChild.querySelector('input').focus();
    }
    else status.textContent = 'Use at most 50 invoice items.';
  });
  select.addEventListener('change', showTemplate);
  const templateForm = host.querySelector('[data-template-form]');
  templateForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = templateForm.querySelector('button');
    button.disabled = true;
    try {
      const saved = await api('/templates', Object.fromEntries(new FormData(templateForm)));
      await refresh(saved.id);
      host.querySelector('[data-template-details]').open = false;
      status.textContent = 'Invoice template saved. Complete the invoice below.';
    } catch (error) { status.textContent = `Cannot save template: ${error.message}`; }
    finally { button.disabled = false; }
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('[data-generate-pdf]');
    button.disabled = true;
    try {
      const value = Object.fromEntries(new FormData(form));
      delete value.description; delete value.amount;
      value.items = [...items.children].map((row) => ({
        description: row.querySelector('[name=description]').value,
        amount: row.querySelector('[name=amount]').value,
      }));
      const result = await api('/render', value);
      const bytes = Uint8Array.from(atob(result.contentBase64), (char) => char.charCodeAt(0));
      if (result.contentType !== 'application/pdf' || new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') throw new Error('Server did not return a PDF');
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      const link = document.createElement('a');
      link.href = url; link.download = result.filename; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      status.textContent = `PDF downloaded. Invoice total: ${result.total} ${result.currency}. Review the PDF before filing it.`;
    } catch (error) { status.textContent = `Cannot generate PDF: ${error.message}`; }
    finally { button.disabled = false; }
  });
  try { await refresh(); }
  catch (error) { status.textContent = `Cannot load invoice templates: ${error.message}`; }
}
