/**
 * Sponsor contract dialog controller: the Contract button on the deal dialog.
 * Owns the [data-contract-dialog] lifecycle: create a contract from deal
 * terms, send the signing links, and link the signed PDF download. Pure
 * string concatenation: no templating that could inject deal data as HTML.
 */
export function wireSponsorContractDialog({ surface, api, safe, getDeals, setDeals }) {
  const dialog = surface.querySelector('[data-contract-dialog]');
  if (!dialog) return null;
  const summary = dialog.querySelector('[data-contract-summary]');
  const links = dialog.querySelector('[data-contract-links]');
  const createButton = dialog.querySelector('[data-contract-create]');
  const sendButton = dialog.querySelector('[data-contract-send]');
  const form = dialog.querySelector('form');
  const alert = dialog.querySelector('[role=alert]');
  let deal = null;
  const refresh = async (dealId) => {
    const fresh = await api('/deals/' + encodeURIComponent(dealId));
    setDeals([...getDeals().filter((item) => item.id !== fresh.id), fresh]);
    return fresh;
  };
  const summaryFor = (contract) => {
    if (!contract) return 'No contract yet. Review the terms below, then create one from this deal.';
    let text = 'Contract ' + String(contract.id).slice(0, 8) + ' · ' + contract.status;
    if (contract.terms && contract.terms.signingOrder) text += ' · ' + contract.terms.signingOrder;
    if (contract.signedPdf && contract.signedPdf.sha256) text += ' · sha256 ' + String(contract.signedPdf.sha256).slice(0, 12);
    return text;
  };
  const canSend = (contract) => Boolean(contract && (contract.status === 'draft' || contract.status === 'sent' || contract.status === 'viewed'));
  const showContract = (contract) => {
    summary.textContent = summaryFor(contract);
    sendButton.hidden = !canSend(contract);
    if (contract && contract.status === 'signed' && contract.id) {
      links.hidden = false;
      const contractUrl = '/api/sponsor-crm/contracts/' + encodeURIComponent(contract.id);
      links.innerHTML = 'Signed PDF: <a href="' + contractUrl + '/pdf">download</a>  b7 '
        + '<a href="' + contractUrl + '/audit">audit trail</a>';
    } else {
      links.hidden = true;
      links.textContent = '';
    }
  };
  const open = async (next) => {
    if (!next) return;
    deal = next;
    let contract = deal.contract || null;
    if (contract && contract.id) {
      try { contract = await api('/contracts/' + encodeURIComponent(contract.id)); } catch (error) { contract = deal.contract; }
    }
    form.reset();
    form.elements.contractId.value = contract ? contract.id || '' : '';
    form.elements.contractVersion.value = contract && contract.version != null ? String(contract.version) : '';
    form.elements.company.value = contract && contract.terms ? contract.terms.company || '' : (deal.organizationName || '');
    form.elements.legalPayer.value = contract && contract.terms ? contract.terms.legalPayer || '' : (deal.organizationName || '');
    form.elements.payerCountry.value = contract && contract.terms ? contract.terms.payerCountry || '' : '';
    form.elements.scope.value = contract && contract.terms ? contract.terms.scope || '' : '';
    const price = contract && contract.terms && contract.terms.priceEur != null ? contract.terms.priceEur : deal.amountEur;
    form.elements.priceEur.value = price != null ? String(price) : '';
    form.elements.startDate.value = contract && contract.terms ? contract.terms.startDate || '' : '';
    form.elements.endDate.value = contract && contract.terms ? contract.terms.endDate || '' : '';
    form.elements.signingOrder.value = contract && contract.terms && contract.terms.signingOrder ? contract.terms.signingOrder : 'sponsor-first';
    alert.textContent = '';
    showContract(contract);
    dialog.showModal();
  };
  surface.querySelector('[data-contract-open]').addEventListener('click', () => {
    const dealId = surface.querySelector('[data-deal-dialog] form')?.elements.dealId?.value;
    const found = (getDeals() || []).find((item) => item.id === dealId) || null;
    safe(() => open(found), 'Could not open the contract dialog');
  });
  createButton.addEventListener('click', (event) => {
    event.preventDefault();
    if (!deal) return;
    alert.textContent = '';
    safe(async () => {
      const terms = {
        company: form.elements.company.value.trim(),
        legalPayer: form.elements.legalPayer.value.trim(),
        payerCountry: form.elements.payerCountry.value.trim().toUpperCase(),
        scope: form.elements.scope.value.trim(),
        priceEur: Number(form.elements.priceEur.value),
        startDate: form.elements.startDate.value,
        endDate: form.elements.endDate.value,
        signingOrder: form.elements.signingOrder.value,
      };
      const created = await api('/contracts', { method: 'POST', body: JSON.stringify({ dealId: deal.id, terms }) });
      const fresh = await refresh(deal.id);
      deal = fresh;
      form.elements.contractId.value = created.id;
      form.elements.contractVersion.value = String(created.version);
      showContract(fresh.contract);
      alert.textContent = 'Contract created. Send the signing links when the terms are final.';
    }, 'Could not create the contract');
  });
  sendButton.addEventListener('click', (event) => {
    event.preventDefault();
    const contractId = form.elements.contractId.value;
    if (!contractId) return;
    alert.textContent = '';
    safe(async () => {
      const result = await api('/contracts/' + encodeURIComponent(contractId) + '/send', { method: 'POST', body: JSON.stringify({}) });
      const delivery = result.emailDelivery || {};
      const urls = result.signingUrls || {};
      let text = 'Email: ' + (delivery.state || 'unknown') + (delivery.reason ? ' (' + delivery.reason + ')' : '');
      const line = (label, url) => (url ? '<div>' + label + ' link: <a href="' + url + '">' + url + '</a></div>' : '');
      links.hidden = false;
      links.innerHTML = '<div>' + text + '</div>' + line('Sponsor', urls.sponsor) + line('Counter-sign', urls.counter);
      const fresh = await refresh(deal.id);
      deal = fresh;
      summary.textContent = summaryFor(fresh.contract);
      sendButton.hidden = !canSend(fresh.contract);
    }, 'Could not send the signing links');
  });
  return { open };
}
