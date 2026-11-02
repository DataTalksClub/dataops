import { before, after, describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { handler } from '../src/handler';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { getClient } from '../src/db/client';
import { createUserWithId } from '../src/db/users';
import { setContractEmailDepsForTests } from '../src/sponsorContracts/emailDelivery';
import { renderContractPdf, sha256Hex } from '../src/sponsorContracts/pdf';

const USER_ID = '00000000-0000-0000-0000-00000000000c';

const invoke = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const url = new URL(path, 'http://contracts.test');
  return handler({
    httpMethod: method,
    path: url.pathname,
    headers,
    queryStringParameters: Object.fromEntries(url.searchParams),
    body: body === undefined ? null : JSON.stringify(body),
  }, {});
};
const data = (response: any) => JSON.parse(response.body);
const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const termsFor = (country = 'DE') => ({
  company: 'Acme GmbH', legalPayer: 'Acme Holding GmbH', payerCountry: country,
  scope: 'One newsletter slot in the main issue', priceEur: 2500, currency: 'EUR',
  startDate: day(40), endDate: day(120), signingOrder: 'sponsor-first' as const,
});

describe('sponsor contracts', () => {
  let client: DynamoDBDocumentClient;
  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
    await createUserWithId(client, USER_ID, { name: 'Contract Tester', email: 'staff@example.test', role: 'admin' });
  });
  after(stopLocal);

  async function seededDeal() {
    const organization = data(await invoke('POST', '/api/sponsor-crm/organizations', { displayName: 'Acme' }));
    const contact = data(await invoke('POST', '/api/sponsor-crm/contacts', { organizationId: organization.id, name: 'Sponsor Person', emails: ['sponsor@example.test'], primary: true }));
    const deal = data(await invoke('POST', '/api/sponsor-crm/deals', { organizationId: organization.id, primaryContactId: contact.id, status: 'open', contractRequired: true }));
    return { organization, contact, deal };
  }

  it('renders a contract PDF with VAT rule, signatures and an audit page', async () => {
    const terms = termsFor('DE');
    const draft = await renderContractPdf(terms, { contractId: 'c-draft', signers: [
      { role: 'sponsor', name: 'Sponsor Person', email: 'sponsor@example.test', order: 0 },
      { role: 'counter', name: 'Alexey', email: 'alexey@datatalks.club', order: 1 },
    ] });
    assert.equal(Buffer.from(draft.slice(0, 4)).toString(), '%PDF');
    const signed = await renderContractPdf(terms, { contractId: 'c-signed', signers: [
      { role: 'sponsor', name: 'Sponsor Person', email: 'sponsor@example.test', order: 0, signedAt: '2026-01-01T00:00:00Z', ip: '1.2.3.4' },
      { role: 'counter', name: 'Alexey', email: 'alexey@datatalks.club', order: 1, signedAt: '2026-01-02T00:00:00Z', ip: '5.6.7.8' },
    ], auditEvents: [{ action: 'sent', at: '2026-01-01T00:00:00Z' }, { action: 'completed', at: '2026-01-02T00:00:00Z' }] });
    assert.equal(sha256Hex(signed).length, 64);
    const reverse = await renderContractPdf(termsFor('NL'), { contractId: 'c-nl', signers: [] });
    assert.ok(reverse.byteLength > 500);
  });

  it('rejects terms with less than one month lead time', async () => {
    const { deal } = await seededDeal();
    const response = await invoke('POST', '/api/sponsor-crm/contracts', { dealId: deal.id, terms: { ...termsFor(), startDate: day(10), endDate: day(90) } });
    assert.equal(response.statusCode, 400);
    assert.match(String(data(response).error), /lead time/);
  });

  it('creates a draft with a rendered PDF and public signers', async () => {
    const { deal } = await seededDeal();
    const response = await invoke('POST', '/api/sponsor-crm/contracts', { dealId: deal.id, terms: termsFor() });
    assert.equal(response.statusCode, 201, response.body);
    const contract = data(response);
    assert.equal(contract.status, 'draft');
    assert.equal(contract.dealId, deal.id);
    assert.deepEqual(contract.signers.map((s: any) => s.role), ['sponsor', 'counter']);
    assert.equal(contract.signers[0].email, 'sponsor@example.test');
    assert.equal(contract.signers[0].tokenHash, undefined);
    assert.ok(contract.draftPdf);
  });

  it('resolves the sponsor signer email from the deal contact', async () => {
    const { deal } = await seededDeal();
    const response = await invoke('POST', '/api/sponsor-crm/contracts', { dealId: deal.id, terms: termsFor(), sponsorSigner: { name: 'Custom Name' } });
    assert.equal(response.statusCode, 201);
    assert.equal(data(response).signers[0].email, 'sponsor@example.test');
    assert.equal(data(response).signers[0].name, 'Custom Name');
  });

  it('send mints expiring tokens, emails the sponsor signer and records the audit', async () => {
    const { deal } = await seededDeal();
    const created = data(await invoke('POST', '/api/sponsor-crm/contracts', { dealId: deal.id, terms: termsFor() }));
    const gmailBodies: any[] = [];
    setContractEmailDepsForTests({ fetchImpl: (async (url: any, init: any) => {
      if (String(url).includes('/api/agent/token')) return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
      gmailBodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: 'gmail-1' }), { status: 200 });
    }) as any });
    process.env.DAPIER_API_TOKEN = 'test-token';
    const sent = await invoke('POST', '/api/sponsor-crm/contracts/' + created.id + '/send', { expiresDays: 7 });
    assert.equal(sent.statusCode, 200, sent.body);
    const payload = data(sent);
    assert.equal(payload.contract.status, 'sent');
    assert.equal(payload.emailDelivery.state, 'sent');
    assert.equal(payload.emailDelivery.to, 'sponsor@example.test');
    assert.ok(payload.signingUrls.sponsor.includes('token='));
    assert.ok(payload.signingUrls.counter.includes('token='));
    assert.equal(payload.contract.signers[0].tokenHash, undefined);
    const audit = data(await invoke('GET', '/api/sponsor-crm/contracts/' + created.id + '/audit'));
    assert.ok(audit.items.some((event: any) => event.action === 'sent' && String(event.detail).includes('sponsor@example.test')));
    const raw = Buffer.from(gmailBodies[0].raw, 'base64url').toString();
    assert.ok(raw.includes('sponsor@example.test'));
    assert.ok(raw.includes(payload.signingUrls.sponsor));
  });

  it('marks viewed through the anonymous signing endpoint and refuses wrong tokens', async () => {
    const { deal } = await seededDeal();
    const created = data(await invoke('POST', '/api/sponsor-crm/contracts', { dealId: deal.id, terms: termsFor() }));
    setContractEmailDepsForTests({ fetchImpl: (async () => new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 })) as any });
    process.env.DAPIER_API_TOKEN = 'test-token';
    const sent = data(await invoke('POST', '/api/sponsor-crm/contracts/' + created.id + '/send', {}));
    process.env.SKIP_AUTH = 'false';
    const denied = await invoke('GET', '/api/sponsor-crm/contracts/' + created.id + '/signing?token=wrong');
    assert.equal(denied.statusCode, 403);
    const viewUrl = new URL(sent.signingUrls.sponsor);
    const viewed = await invoke('GET', '/api/sponsor-crm/contracts/' + created.id + '/signing' + viewUrl.search + '&today=2026-01-01');
    assert.equal(viewed.statusCode, 200, viewed.body);
    assert.equal(data(viewed).contract.status, 'viewed');
    assert.equal(data(viewed).viewer.role, 'sponsor');
    process.env.SKIP_AUTH = 'true';
    const audit = data(await invoke('GET', '/api/sponsor-crm/contracts/' + created.id + '/audit'));
    assert.ok(audit.items.some((event: any) => event.action === 'viewed' && event.role === 'sponsor'));
  });

  it('runs the full sponsor-first signing flow with countersign and final PDF', async () => {
    const { deal } = await seededDeal();
    const created = data(await invoke('POST', '/api/sponsor-crm/contracts', { dealId: deal.id, terms: termsFor() }));
    process.env.DAPIER_API_TOKEN = 'test-token';
    setContractEmailDepsForTests({ fetchImpl: (async () => new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 })) as any });
    const sent = data(await invoke('POST', '/api/sponsor-crm/contracts/' + created.id + '/send', {}));
    const sponsorToken = new URL(sent.signingUrls.sponsor).searchParams.get('token');
    const counterToken = new URL(sent.signingUrls.counter).searchParams.get('token');
    const outOfOrder = await invoke('POST', '/api/sponsor-crm/contracts/' + created.id + '/sign', { token: counterToken }, { 'x-forwarded-for': '9.9.9.9', 'user-agent': 'TestUA' });
    assert.equal(outOfOrder.statusCode, 409);
    assert.equal(data(outOfOrder).code, 'signer_out_of_order');
    const sponsorSign = await invoke('POST', '/api/sponsor-crm/contracts/' + created.id + '/sign', { token: sponsorToken }, { 'x-forwarded-for': '10.0.0.1', 'user-agent': 'SponsorUA/1.0' });
    assert.equal(sponsorSign.statusCode, 200, sponsorSign.body);
    assert.equal(data(sponsorSign).awaitingRole, 'counter');
    const counterSign = await invoke('POST', '/api/sponsor-crm/contracts/' + created.id + '/sign', { token: counterToken }, { 'x-forwarded-for': '10.0.0.2', 'user-agent': 'CounterUA/2.0' });
    assert.equal(counterSign.statusCode, 200, counterSign.body);
    const contract = data(counterSign).contract;
    assert.equal(contract.status, 'signed');
    assert.ok(contract.signedPdf);
    const sha = data(counterSign).sha256;
    assert.equal(contract.signedPdf.sha256, sha);
    const pdf = await invoke('GET', '/api/sponsor-crm/contracts/' + created.id + '/pdf');
    assert.equal(pdf.statusCode, 200);
    assert.equal(pdf.isBase64Encoded, true);
    const bytes = Buffer.from(pdf.body, 'base64');
    assert.equal(Buffer.from(bytes.subarray(0, 4)).toString(), '%PDF');
    assert.equal(sha256Hex(new Uint8Array(bytes)), sha);
    const verify = await invoke('POST', '/api/sponsor-crm/contracts/' + created.id + '/verify');
    assert.equal(verify.statusCode, 200);
    assert.equal(data(verify).intact, true);
    const audit = data(await invoke('GET', '/api/sponsor-crm/contracts/' + created.id + '/audit'));
    const actions = audit.items.map((event: any) => event.action);
    assert.ok(actions.includes('signed') && actions.includes('completed'));
    const signedEvent = audit.items.find((event: any) => event.action === 'signed' && event.role === 'sponsor');
    assert.equal(signedEvent.ip, '10.0.0.1');
    assert.equal(signedEvent.userAgent, 'SponsorUA/1.0');
    // The deal can now move to agreed.
    const agreed = await invoke('PUT', '/api/sponsor-crm/deals/' + deal.id, { version: deal.version, status: 'agreed' });
    assert.equal(agreed.statusCode, 200, agreed.body);
  });

  it('refuses agreed status while contractRequired and no signed contract exists', async () => {
    const { deal } = await seededDeal();
    const refusedUpdate = await invoke('PUT', '/api/sponsor-crm/deals/' + deal.id, { version: deal.version, status: 'agreed' });
    assert.equal(refusedUpdate.statusCode, 422);
    assert.equal(data(refusedUpdate).code, 'signed_contract_required');
    const refusedCreate = await invoke('POST', '/api/sponsor-crm/deals', { organizationId: deal.organizationId, status: 'agreed', contractRequired: true });
    assert.equal(refusedCreate.statusCode, 422);
    const allowed = await invoke('PUT', '/api/sponsor-crm/deals/' + deal.id, { version: deal.version, status: 'agreed', contractRequired: false });
    assert.equal(allowed.statusCode, 200);
    const dealPayload = data(await invoke('GET', '/api/sponsor-crm/deals/' + deal.id));
    assert.equal(dealPayload.contract, null);
  });

  it('expires tokens and supports decline', async () => {
    const { deal } = await seededDeal();
    const created = data(await invoke('POST', '/api/sponsor-crm/contracts', { dealId: deal.id, terms: termsFor(), sponsorSigner: { email: 'direct@example.test' } }));
    process.env.DAPIER_API_TOKEN = 'test-token';
    setContractEmailDepsForTests({ fetchImpl: (async () => new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 })) as any });
    const sent = data(await invoke('POST', '/api/sponsor-crm/contracts/' + created.id + '/send', {}));
    assert.equal(sent.emailDelivery.state, 'sent');
    const token = new URL(sent.signingUrls.sponsor).searchParams.get('token');
    const declined = await invoke('POST', '/api/sponsor-crm/contracts/' + created.id + '/decline', { token }, { 'x-forwarded-for': '11.0.0.9' });
    assert.equal(declined.statusCode, 200);
    assert.equal(data(declined).contract.status, 'declined');
    const reDecline = await invoke('POST', '/api/sponsor-crm/contracts/' + created.id + '/decline', { token });
    assert.equal(reDecline.statusCode, 409);
    const resend = await invoke('POST', '/api/sponsor-crm/contracts/' + created.id + '/resend', {});
    assert.equal(resend.statusCode, 409);
  });

  it('detects tampering of the stored signed PDF', async () => {
    const { deal } = await seededDeal();
    const created = data(await invoke('POST', '/api/sponsor-crm/contracts', { dealId: deal.id, terms: termsFor() }));
    process.env.DAPIER_API_TOKEN = 'test-token';
    setContractEmailDepsForTests({ fetchImpl: (async () => new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 })) as any });
    const sent = data(await invoke('POST', '/api/sponsor-crm/contracts/' + created.id + '/send', {}));
    const sponsorToken = new URL(sent.signingUrls.sponsor).searchParams.get('token');
    const counterToken = new URL(sent.signingUrls.counter).searchParams.get('token');
    await invoke('POST', '/api/sponsor-crm/contracts/' + created.id + '/sign', { token: sponsorToken });
    await invoke('POST', '/api/sponsor-crm/contracts/' + created.id + '/sign', { token: counterToken });
    const contract = data(await invoke('GET', '/api/sponsor-crm/contracts/' + created.id));
    const pdfPath = contract.signedPdf.storagePath.replace(/^tasks\x2f/, 'uploads/tasks/');
    const original = readFileSync(pdfPath);
    const tampered = Buffer.from(original);
    tampered[tampered.length - 1] = tampered[tampered.length - 1] ^ 0xff;
    writeFileSync(pdfPath, tampered);
    const verify = await invoke('POST', '/api/sponsor-crm/contracts/' + created.id + '/verify');
    assert.equal(data(verify).intact, false);
    writeFileSync(pdfPath, original);
  });
});
