import { before, after, describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { handler } from '../src/handler';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { getClient } from '../src/db/client';
import { contractTokenHash, createContract, updateContract } from '../src/db/sponsorContracts';
import { createUserWithId } from '../src/db/users';
import { setContractEmailDepsForTests } from '../src/sponsorContracts/emailDelivery';
import { renderContractPdf, sha256Hex } from '../src/sponsorContracts/pdf';
import { addDays } from '../src/relativeDates';
import { berlinDate } from '../src/sponsorFinance/core';

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
const day = (offset: number) => addDays(berlinDate(), offset);
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

  it('enforces the 30-day minimum lead time at signing and finalization in sponsor-first order while preserving contract and audit data', async () => {
    const { deal } = await seededDeal();
    const created = data(await invoke('POST', '/api/sponsor-crm/contracts', {
      dealId: deal.id,
      terms: { ...termsFor(), startDate: day(30), endDate: day(120), signingOrder: 'sponsor-first' },
    }));
    assert.equal(created.status, 'draft');
    process.env.DAPIER_API_TOKEN = 'test-token';
    setContractEmailDepsForTests({ fetchImpl: (async () => new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 })) as any });
    const sent = data(await invoke('POST', '/api/sponsor-crm/contracts/' + created.id + '/send', { expiresDays: 14 }));
    const sponsorToken = new URL(sent.signingUrls.sponsor).searchParams.get('token');
    const counterToken = new URL(sent.signingUrls.counter).searchParams.get('token');

    // Delayed first signature (< 30 days remaining before startDate) is refused without mutating state.
    const lateFirstSign = await invoke(
      'POST',
      '/api/sponsor-crm/contracts/' + created.id + '/sign?today=' + day(1),
      { token: sponsorToken },
      { 'x-forwarded-for': '10.0.1.1', 'user-agent': 'LateSponsor/1.0' },
    );
    assert.equal(lateFirstSign.statusCode, 409, lateFirstSign.body);
    assert.equal(data(lateFirstSign).code, 'contract_lead_time_expired');
    assert.match(String(data(lateFirstSign).error), /lead time/);

    const afterLateFirst = data(await invoke('GET', '/api/sponsor-crm/contracts/' + created.id));
    assert.equal(afterLateFirst.status, 'sent');
    assert.equal(afterLateFirst.signers[0].signedAt, undefined);

    // On-time first signature (exactly 30 days before startDate) succeeds.
    const onTimeSponsorSign = await invoke(
      'POST',
      '/api/sponsor-crm/contracts/' + created.id + '/sign',
      { token: sponsorToken },
      { 'x-forwarded-for': '10.0.1.2', 'user-agent': 'SponsorOnTime/1.0' },
    );
    assert.equal(onTimeSponsorSign.statusCode, 200, onTimeSponsorSign.body);
    assert.equal(data(onTimeSponsorSign).awaitingRole, 'counter');
    const sponsorSignedAt = data(onTimeSponsorSign).contract.signers[0].signedAt;
    assert.ok(sponsorSignedAt);
    const auditBeforeLateFinal = data(await invoke('GET', '/api/sponsor-crm/contracts/' + created.id + '/audit'));

    // Delayed second/finalizing signature (5 days later -> 25 days before startDate) is refused.
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 5 * 86400000;
      const lateCounterSign = await invoke(
        'POST',
        '/api/sponsor-crm/contracts/' + created.id + '/sign',
        { token: counterToken },
        { 'x-forwarded-for': '10.0.1.3', 'user-agent': 'CounterLate/1.0' },
      );
      assert.equal(lateCounterSign.statusCode, 409, lateCounterSign.body);
      assert.equal(data(lateCounterSign).code, 'contract_lead_time_expired');
      assert.match(String(data(lateCounterSign).error), /lead time/);

      // Backdating query.today cannot bypass the wall-clock signing timestamp check.
      const backdatedBypass = await invoke(
        'POST',
        '/api/sponsor-crm/contracts/' + created.id + '/sign?today=' + day(0),
        { token: counterToken },
        { 'x-forwarded-for': '10.0.1.3', 'user-agent': 'CounterBypass/1.0' },
      );
      assert.equal(backdatedBypass.statusCode, 409, backdatedBypass.body);
      assert.equal(data(backdatedBypass).code, 'contract_lead_time_expired');
    } finally {
      Date.now = realNow;
    }

    // Existing contract data, first signer evidence, draft PDF and audit trail are preserved; no finalization occurred.
    const preserved = data(await invoke('GET', '/api/sponsor-crm/contracts/' + created.id));
    assert.equal(preserved.status, 'viewed');
    assert.equal(preserved.signedAt, undefined);
    assert.equal(preserved.signedPdf, undefined);
    assert.ok(preserved.draftPdf);
    assert.equal(preserved.signers[0].role, 'sponsor');
    assert.equal(preserved.signers[0].signedAt, sponsorSignedAt);
    assert.equal(preserved.signers[1].role, 'counter');
    assert.equal(preserved.signers[1].signedAt, undefined);

    const auditAfterLateFinal = data(await invoke('GET', '/api/sponsor-crm/contracts/' + created.id + '/audit'));
    assert.deepEqual(auditAfterLateFinal.items, auditBeforeLateFinal.items);
    assert.ok(!auditAfterLateFinal.items.some((event: any) => event.action === 'completed'));

    // Deal gate still refuses agreed because finalization was prevented.
    const refusedAgreed = await invoke('PUT', '/api/sponsor-crm/deals/' + deal.id, { version: deal.version, status: 'agreed' });
    assert.equal(refusedAgreed.statusCode, 422);
    assert.equal(data(refusedAgreed).code, 'signed_contract_required');
  });

  it('enforces the 30-day minimum lead time in counter-first order and allows timely completion', async () => {
    const { deal } = await seededDeal();
    const created = data(await invoke('POST', '/api/sponsor-crm/contracts', {
      dealId: deal.id,
      terms: { ...termsFor(), startDate: day(30), endDate: day(120), signingOrder: 'counter-first' },
    }));
    assert.deepEqual(created.signers.map((s: any) => s.role), ['counter', 'sponsor']);
    process.env.DAPIER_API_TOKEN = 'test-token';
    setContractEmailDepsForTests({ fetchImpl: (async () => new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 })) as any });
    const sent = data(await invoke('POST', '/api/sponsor-crm/contracts/' + created.id + '/send', { expiresDays: 14 }));
    const sponsorToken = new URL(sent.signingUrls.sponsor).searchParams.get('token');
    const counterToken = new URL(sent.signingUrls.counter).searchParams.get('token');

    // Out-of-order sponsor sign is refused in counter-first mode.
    const outOfOrder = await invoke('POST', '/api/sponsor-crm/contracts/' + created.id + '/sign', { token: sponsorToken });
    assert.equal(outOfOrder.statusCode, 409);
    assert.equal(data(outOfOrder).code, 'signer_out_of_order');

    // Counter signs first on time (30 days before startDate).
    const counterSign = await invoke(
      'POST',
      '/api/sponsor-crm/contracts/' + created.id + '/sign',
      { token: counterToken },
      { 'x-forwarded-for': '10.0.2.1', 'user-agent': 'CounterFirst/1.0' },
    );
    assert.equal(counterSign.statusCode, 200, counterSign.body);
    assert.equal(data(counterSign).awaitingRole, 'sponsor');
    const counterSignedAt = data(counterSign).contract.signers[0].signedAt;
    assert.ok(counterSignedAt);
    const auditBeforeLateSponsor = data(await invoke('GET', '/api/sponsor-crm/contracts/' + created.id + '/audit'));

    // Delayed sponsor finalization (< 30 days before startDate) is refused while preserving counter signature and audit history.
    const lateSponsorSign = await invoke(
      'POST',
      '/api/sponsor-crm/contracts/' + created.id + '/sign?today=' + day(3),
      { token: sponsorToken },
      { 'x-forwarded-for': '10.0.2.2', 'user-agent': 'SponsorLate/1.0' },
    );
    assert.equal(lateSponsorSign.statusCode, 409, lateSponsorSign.body);
    assert.equal(data(lateSponsorSign).code, 'contract_lead_time_expired');
    assert.match(String(data(lateSponsorSign).error), /lead time/);

    const preserved = data(await invoke('GET', '/api/sponsor-crm/contracts/' + created.id));
    assert.equal(preserved.status, 'viewed');
    assert.equal(preserved.signedAt, undefined);
    assert.equal(preserved.signedPdf, undefined);
    assert.ok(preserved.draftPdf);
    assert.equal(preserved.signers[0].role, 'counter');
    assert.equal(preserved.signers[0].signedAt, counterSignedAt);
    assert.equal(preserved.signers[1].role, 'sponsor');
    assert.equal(preserved.signers[1].signedAt, undefined);

    const auditAfterLateSponsor = data(await invoke('GET', '/api/sponsor-crm/contracts/' + created.id + '/audit'));
    assert.deepEqual(auditAfterLateSponsor.items, auditBeforeLateSponsor.items);

    const refusedAgreed = await invoke('PUT', '/api/sponsor-crm/deals/' + deal.id, { version: deal.version, status: 'agreed' });
    assert.equal(refusedAgreed.statusCode, 422);
    assert.equal(data(refusedAgreed).code, 'signed_contract_required');

    // Timely completion on day(0) (still 30 days before startDate) finalizes the contract and unlocks the deal gate.
    const timelySponsorSign = await invoke(
      'POST',
      '/api/sponsor-crm/contracts/' + created.id + '/sign',
      { token: sponsorToken },
      { 'x-forwarded-for': '10.0.2.3', 'user-agent': 'SponsorTimely/1.0' },
    );
    assert.equal(timelySponsorSign.statusCode, 200, timelySponsorSign.body);
    const finalized = data(timelySponsorSign).contract;
    assert.equal(finalized.status, 'signed');
    assert.ok(finalized.signedPdf?.sha256);
    const agreed = await invoke('PUT', '/api/sponsor-crm/deals/' + deal.id, { version: deal.version, status: 'agreed' });
    assert.equal(agreed.statusCode, 200, agreed.body);
  });

  it('refuses backdated today at creation and at signing even when synthetic startDate predates createdAt', async () => {
    const { deal } = await seededDeal();

    // Caller-supplied backdated query.today or body.today cannot create a contract with startDate before createdAt or < 30 days ahead.
    const backdatedCreateQuery = await invoke('POST', '/api/sponsor-crm/contracts?today=' + day(-60), {
      dealId: deal.id,
      terms: { ...termsFor(), startDate: day(-15), endDate: day(60) },
    });
    assert.equal(backdatedCreateQuery.statusCode, 400, backdatedCreateQuery.body);
    assert.match(String(data(backdatedCreateQuery).error), /lead time/);

    const backdatedCreateBody = await invoke('POST', '/api/sponsor-crm/contracts', {
      dealId: deal.id,
      today: day(-60),
      terms: { ...termsFor(), startDate: day(10), endDate: day(90) },
    });
    assert.equal(backdatedCreateBody.statusCode, 400, backdatedCreateBody.body);
    assert.match(String(data(backdatedCreateBody).error), /lead time/);

    // Seed a synthetic contract record whose terms.startDate predates createdAt.
    const synthetic = await createContract(client, {
      dealId: deal.id,
      organizationId: deal.organizationId,
      status: 'draft',
      terms: { ...termsFor(), startDate: day(-15), endDate: day(60), signingOrder: 'sponsor-first' },
      signers: [
        { role: 'sponsor', name: 'Sponsor Person', email: 'sponsor@example.test', order: 0 },
        { role: 'counter', name: 'Alexey Grigorev (DataTalks.Club)', email: 'alexey@datatalks.club', order: 1 },
      ],
    }, USER_ID);
    assert.ok(String(synthetic.terms.startDate) < berlinDate(new Date(String(synthetic.createdAt))));

    process.env.DAPIER_API_TOKEN = 'test-token';
    setContractEmailDepsForTests({ fetchImpl: (async () => new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 })) as any });
    const sent = data(await invoke('POST', '/api/sponsor-crm/contracts/' + synthetic.id + '/send', { expiresDays: 14 }));
    const sponsorToken = new URL(sent.signingUrls.sponsor).searchParams.get('token');
    const counterToken = new URL(sent.signingUrls.counter).searchParams.get('token');
    const auditBefore = data(await invoke('GET', '/api/sponsor-crm/contracts/' + synthetic.id + '/audit'));

    // First signer cannot bypass wall-clock lead time by backdating query.today or body.today when startDate < createdAt.
    const firstSignBackdatedQuery = await invoke(
      'POST',
      '/api/sponsor-crm/contracts/' + synthetic.id + '/sign?today=' + day(-60),
      { token: sponsorToken },
      { 'x-forwarded-for': '10.0.3.1', 'user-agent': 'BackdateSponsorQuery/1.0' },
    );
    assert.equal(firstSignBackdatedQuery.statusCode, 409, firstSignBackdatedQuery.body);
    assert.equal(data(firstSignBackdatedQuery).code, 'contract_lead_time_expired');

    const firstSignBackdatedBody = await invoke(
      'POST',
      '/api/sponsor-crm/contracts/' + synthetic.id + '/sign',
      { token: sponsorToken, today: day(-60) },
      { 'x-forwarded-for': '10.0.3.2', 'user-agent': 'BackdateSponsorBody/1.0' },
    );
    assert.equal(firstSignBackdatedBody.statusCode, 409, firstSignBackdatedBody.body);
    assert.equal(data(firstSignBackdatedBody).code, 'contract_lead_time_expired');

    const afterFirstRefusal = data(await invoke('GET', '/api/sponsor-crm/contracts/' + synthetic.id));
    assert.equal(afterFirstRefusal.status, 'sent');
    assert.equal(afterFirstRefusal.signers[0].signedAt, undefined);
    const auditAfterFirstRefusal = data(await invoke('GET', '/api/sponsor-crm/contracts/' + synthetic.id + '/audit'));
    assert.deepEqual(auditAfterFirstRefusal.items, auditBefore.items);

    // Even if the first signer was synthetically recorded 60 days ago (>= 30 days before startDate),
    // the finalizing signer cannot bypass wall-clock signer validation when startDate < createdAt.
    const earlySignedAt = new Date(Date.parse(day(-60) + 'T12:00:00Z')).toISOString();
    await updateContract(client, {
      ...synthetic,
      version: sent.contract.version,
      status: 'viewed',
      sentAt: sent.contract.sentAt,
    }, {
      status: 'viewed',
      signers: [
        { role: 'sponsor', name: 'Sponsor Person', email: 'sponsor@example.test', order: 0, signedAt: earlySignedAt },
        {
          role: 'counter',
          name: 'Alexey Grigorev (DataTalks.Club)',
          email: 'alexey@datatalks.club',
          order: 1,
          tokenHash: contractTokenHash(String(counterToken)),
          tokenExpiresAt: sent.contract.signers[1].tokenExpiresAt,
        },
      ],
    });

    const finalSignBackdated = await invoke(
      'POST',
      '/api/sponsor-crm/contracts/' + synthetic.id + '/sign?today=' + day(-60),
      { token: counterToken, today: day(-60) },
      { 'x-forwarded-for': '10.0.3.3', 'user-agent': 'BackdateCounter/1.0' },
    );
    assert.equal(finalSignBackdated.statusCode, 409, finalSignBackdated.body);
    assert.equal(data(finalSignBackdated).code, 'contract_lead_time_expired');

    const afterFinalRefusal = data(await invoke('GET', '/api/sponsor-crm/contracts/' + synthetic.id));
    assert.equal(afterFinalRefusal.status, 'viewed');
    assert.equal(afterFinalRefusal.signedAt, undefined);
    assert.equal(afterFinalRefusal.signedPdf, undefined);
    assert.equal(afterFinalRefusal.signers[0].signedAt, earlySignedAt);
    assert.equal(afterFinalRefusal.signers[1].signedAt, undefined);

    const refusedAgreed = await invoke('PUT', '/api/sponsor-crm/deals/' + deal.id, { version: deal.version, status: 'agreed' });
    assert.equal(refusedAgreed.statusCode, 422);
    assert.equal(data(refusedAgreed).code, 'signed_contract_required');
  });
});
