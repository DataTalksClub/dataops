/**
 * Standalone signing page for sponsors and the DataTalks.Club counter-signer.
 * Reached through the emailed unique expiring link (/contracts/:id?token=...).
 * No portal session: the token is the credential and the backend rate-limits
 * failed attempts. Every shown detail comes from the token-gated
 * GET /api/sponsor-crm/contracts/:id/signing response; nothing is inferred.
 */
import { escapeHtml } from "../../core/html.js";

export function createContractSignPage({ documentRef, request, locationRef }) {
  const identity = documentRef.getElementById('contract-sign-identity');
  const root = documentRef.getElementById('contract-sign-root');
  let contract = null;
  let viewer = null;
  let pendingRole = null;

  const setIdentity = (text) => { identity.textContent = text; };
  const contractId = () => decodeURIComponent((locationRef.pathname || '').split('/').pop() || '');
  const token = () => new URLSearchParams(locationRef.search).get('token') || '';

  const termsRows = (terms) => {
    const rows = [
      ['Sponsor', terms.company],
      ['Legal payer', terms.legalPayer + ' (' + terms.payerCountry + ')'],
      ['Scope', terms.scope],
      ['Fee', Number(terms.priceEur).toFixed(2) + ' ' + terms.currency],
      ['Contract period', terms.startDate + ' to ' + terms.endDate],
    ];
    return rows.map((row) => '<p><strong>' + escapeHtml(row[0]) + ':</strong> ' + escapeHtml(row[1]) + '</p>').join('');
  };

  const render = () => {
    if (!contract) return;
    const status = contract.status;
    const signer = viewer ? (contract.signers || []).find((item) => item.role === viewer.role) : null;
    const mySigned = Boolean(signer && signer.signedAt);
    const isMyTurn = Boolean(viewer && pendingRole === viewer.role);
    let actions;
    if (status === 'signed' || status === 'declined' || mySigned) {
      actions = '<p>' + (mySigned ? 'You signed this agreement. Nothing further to do.' : 'This agreement has been ' + escapeHtml(status) + '.') + '</p>';
    } else if (isMyTurn) {
      actions = '<button type="button" id="contract-sign-accept">Sign electronically</button> '
        + '<button type="button" id="contract-sign-decline">Decline</button>';
    } else {
      actions = '<p>It is not your turn yet. The ' + escapeHtml(pendingRole || 'other party') + ' signs first.</p>';
    }
    root.innerHTML = '<h2>Sponsorship agreement' + (contract.terms && contract.terms.company ? ': ' + escapeHtml(contract.terms.company) : '') + '</h2>'
      + '<p>Status: <strong>' + escapeHtml(status) + '</strong>' + (pendingRole ? ' · waiting for: ' + escapeHtml(pendingRole) : '') + '</p>'
      + (contract.terms ? termsRows(contract.terms) : '')
      + '<p class="muted">Signing happens electronically under EU regulation 910/2014 (eIDAS) as a Simple Electronic Signature.'
      + ' Your signature is recorded with a timestamp, IP address and browser user agent, and listed on the audit page of the signed document.</p>'
      + '<div class="sponsor-doc-actions">' + actions + '</div>';
    const accept = root.querySelector('#contract-sign-accept');
    const decline = root.querySelector('#contract-sign-decline');
    if (accept) accept.addEventListener('click', () => { act('sign', 'Signing' + String.fromCharCode(8230)); });
    if (decline) decline.addEventListener('click', () => { act('decline', 'Declining' + String.fromCharCode(8230)); });
  };

  const act = async (action, busyText) => {
    setIdentity(busyText);
    try {
      const result = await request('/api/sponsor-crm/contracts/' + encodeURIComponent(contractId()) + '/' + action, {
        method: 'POST',
        body: JSON.stringify({ token: token() }),
      });
      if (action === 'decline') { setIdentity('You declined this agreement.'); await load(); return; }
      if (result.awaitingRole) { setIdentity('Signature recorded. Waiting for the ' + result.awaitingRole + ' to sign.'); }
      else { setIdentity('Signature complete. Thank you.'); }
      await load();
    } catch (error) {
      setIdentity(error.message || 'The signing action failed');
      root.innerHTML = '<p role="alert">' + escapeHtml(error.message || 'The signing action failed') + '</p>';
    }
  };

  const load = async () => {
    try {
      const result = await request('/api/sponsor-crm/contracts/' + encodeURIComponent(contractId()) + '/signing?token=' + encodeURIComponent(token()));
      contract = result.contract;
      viewer = result.viewer || null;
      pendingRole = result.pendingRole || null;
      setIdentity(viewer ? 'Signing as: ' + (viewer.name || viewer.role) : '');
      render();
      return true;
    } catch (error) {
      setIdentity(error.message || 'This signing link is not valid');
      root.innerHTML = '<p role="alert">' + escapeHtml(error.message || 'This signing link is invalid or expired') + '</p><p>Ask DataTalks.Club to send a fresh link to your email address.</p>';
      return false;
    }
  };

  return { start: () => { load(); } };
}
