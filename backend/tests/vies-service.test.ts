import { before, after, describe, it } from 'node:test';
import assert from 'node:assert';
import { createServer, type Server } from 'http';
import { setupLocalDynamo, stopLocal } from '../scripts/local-dynamodb';
import { lookupVies } from '../src/vies/client';
import { EU_MEMBER_STATES, isEuMemberState, normalizeVatId, splitVatId, viesMemberState } from '../src/vies/format';
import { checkVatId, evaluateDealVat, evaluateOrganization, preflightOrganizations, refreshPreflight, vatRequired } from '../src/vies/service';
import { getViesCheck, listViesChecks } from '../src/vies/store';
import { createCrmRecord, listCrmRecords, updateCrmRecord } from '../src/db/sponsorCrm';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

describe('VAT ID format', () => {
  it('splits prefixed member-state numbers and normalizes separators', () => {
    assert.deepEqual(splitVatId('DE123456789'), { country: 'DE', number: '123456789' });
    assert.deepEqual(splitVatId(' de 123-456 789 '), { country: 'DE', number: '123456789' });
    assert.deepEqual(splitVatId('NL123456789B12'), { country: 'NL', number: '123456789B12' });
    assert.deepEqual(splitVatId('123456789', 'DE'), { country: 'DE', number: '123456789' });
    assert.deepEqual(splitVatId('12345678', 'dk'), { country: 'DK', number: '12345678' });
  });
  it('rejects values that cannot be VIES identifiers', () => {
    // A bare Danish CVR without the DK prefix is a company register number, not a VAT ID.
    assert.equal((splitVatId('12345678') as { error: string }).error, 'missing-country-prefix');
    assert.equal((splitVatId('DE12345678') as { error: string }).error, 'malformed');
    assert.equal((splitVatId('DK123456789') as { error: string }).error, 'malformed');
    assert.equal((splitVatId('XX123456789') as { error: string }).error, 'missing-country-prefix');
    assert.equal((splitVatId('12345678', 'CH') as { error: string }).error, 'unknown-member-state');
    assert.equal((splitVatId('') as { error: string }).error, 'empty');
  });
  it('knows the EU member states and the VIES spelling of Greece', () => {
    assert.ok(isEuMemberState('DK') && isEuMemberState('gr') && !isEuMemberState('GB') && !isEuMemberState('CH'));
    assert.equal(EU_MEMBER_STATES.has('DE'), true);
    assert.equal(viesMemberState('GR'), 'EL');
    assert.equal(viesMemberState('DK'), 'DK');
    assert.equal(normalizeVatId('dk–12.34 5678'), 'DK12345678');
  });
});

describe('VIES REST client', () => {
  let server: Server, baseUrl: string, requests: string[];
  const respond = (status: number, body: unknown, contentType = 'application/json') => (req: any, res: any) => {
    requests.push(req.url || '');
    res.writeHead(status, { 'Content-Type': contentType });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  before(async () => {
    requests = [];
    server = createServer(respond(200, { isValid: true, name: 'Synthetic ApS', address: 'Vej 1', requestDate: '2026-10-19' }));
    await new Promise<void>((resolve) => { server.listen(0, () => resolve()); });
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('maps a valid answer', async () => {
    const answer = await lookupVies('DK', '12345678', { fetchImpl: fetch, baseUrl });
    assert.equal(answer.kind, 'valid');
    assert.equal((answer as { name?: string }).name, 'Synthetic ApS');
    assert.equal(requests.at(-1), '/ms/DK/vat/12345678');
  });
  it('maps Greece to the EL member state code', async () => {
    await lookupVies('GR', '123456789', { fetchImpl: fetch, baseUrl });
    assert.equal(requests.at(-1), '/ms/EL/vat/123456789');
  });
  it('distinguishes not-registered from service trouble', async () => {
    server.removeAllListeners('request');
    server.on('request', respond(200, { isValid: false, userError: 'INVALID_NUMBER' }));
    assert.equal((await lookupVies('DK', '12345678', { fetchImpl: fetch, baseUrl })).kind, 'not-found');
    server.removeAllListeners('request');
    server.on('request', respond(200, { isValid: false, userError: 'SERVICE_UNAVAILABLE' }));
    assert.equal((await lookupVies('DK', '12345678', { fetchImpl: fetch, baseUrl })).kind, 'unavailable');
    server.removeAllListeners('request');
    server.on('request', respond(503, 'gone'));
    assert.equal((await lookupVies('DK', '12345678', { fetchImpl: fetch, baseUrl })).kind, 'unavailable');
    server.removeAllListeners('request');
    server.on('request', respond(200, '<html>busy</html>', 'text/html'));
    assert.equal((await lookupVies('DK', '12345678', { fetchImpl: fetch, baseUrl })).kind, 'unavailable');
  });
});

describe('VAT validation service', () => {
  let client: DynamoDBDocumentClient;
  const validLookup = async () => ({ kind: 'valid' as const, name: 'Synthetic ApS', responseDate: '2026-10-19' });
  before(async () => { client = await setupLocalDynamo(); });
  after(stopLocal);

  it('checks, persists and caches a valid VAT ID without re-calling VIES', async () => {
    let calls = 0;
    const lookup = async () => { calls += 1; return validLookup(); };
    const first = await checkVatId(client, 'DK 12 34 56 78', { lookup });
    assert.equal(first.status, 'valid');
    const again = await checkVatId(client, 'DK12345678', { lookup });
    assert.equal(calls, 1);
    assert.equal(again.checkedAt, first.checkedAt);
    const stored = await getViesCheck(client, 'DK12345678');
    assert.equal(stored?.status, 'valid');
    assert.equal(await listViesChecks(client).then((items) => items.length), 1);
  });
  it('records not-found and invalid outcomes and re-checks unavailable ones', async () => {
    const notFound = await checkVatId(client, 'DK87654321', { lookup: async () => ({ kind: 'not-found', error: 'INVALID' }) });
    assert.equal(notFound.status, 'not-found');
    let calls = 0;
    const unavailable = await checkVatId(client, 'DK11223344', { lookup: async () => { calls += 1; return { kind: 'unavailable', error: 'vies-http-503' }; } });
    assert.equal(unavailable.status, 'unavailable');
    await checkVatId(client, 'DK11223344', { lookup: async () => { calls += 1; return validLookup(); } });
    assert.equal(calls, 2, 'an unavailable outcome is never treated as an answer');
    assert.equal((await checkVatId(client, '12345678', { lookup: validLookup })).error, 'format-missing-country-prefix');
    assert.equal((await checkVatId(client, 'DE12345', { lookup: validLookup })).status, 'invalid');
  });
  it('scopes the check to EU B2B customers', () => {
    assert.equal(vatRequired({ country: 'DK', vatId: 'DK12345678' }), true);
    assert.equal(vatRequired({ country: 'DE', vatId: 'DE123456789' }), false);
    assert.equal(vatRequired({ country: 'US' }), false);
    assert.equal(vatRequired({ vatId: 'DK12345678' }), true);
    assert.equal(vatRequired({}), false);
  });
  it('blocks invoicing an EU customer without a usable VAT ID', async () => {
    const organization = (await createCrmRecord(client, 'organization', { displayName: 'Synthetic ApS', country: 'DK' })).item;
    const blocked = await evaluateOrganization(client, organization);
    assert.equal(blocked.blocking?.reason, 'missing-vat-id');
    await createCrmRecord(client, 'organization', { displayName: 'Never Checked', country: 'DK', vatId: 'DK55555555' });
    const organizations = await listCrmRecords(client, 'organization');
    const neverChecked = organizations.find((item) => item.vatId === 'DK55555555');
    let calls = 0;
    const evaluated = await evaluateOrganization(client, neverChecked!, { lookup: async () => { calls += 1; return validLookup(); } });
    assert.equal(evaluated.blocking, undefined);
    assert.equal(evaluated.check?.status, 'valid');
    assert.equal(calls, 1);
  });
  it('flags stale VAT IDs and reports them in the preflight scan', async () => {
    await checkVatId(client, 'DK99999999', { lookup: async () => ({ kind: 'not-found' }) });
    const organization = (await createCrmRecord(client, 'organization', { displayName: 'Synthetic IVS', country: 'DK', vatId: 'DK99999999' })).item;
    const preflight = await preflightOrganizations(client);
    const entry = preflight.entries.find((item) => item.organizationId === organization.id);
    assert.deepEqual(entry?.flags, ['not-found']);
    await checkVatId(client, 'DK12121212', { lookup: validLookup });
    await createCrmRecord(client, 'organization', { displayName: 'Synthetic Holding', country: 'DK', vatId: 'DK12121212' });
    const refreshed = await preflightOrganizations(client);
    assert.deepEqual(refreshed.entries.find((item) => item.vatId === 'DK12121212')?.flags, []);
  });
  it('refreshes stale preflight entries through VIES, bounded', async () => {
    await createCrmRecord(client, 'organization', { displayName: 'Synthetic Oy', country: 'FI', vatId: 'FI11111111' });
    await createCrmRecord(client, 'organization', { displayName: 'Synthetic AB', country: 'SE', vatId: 'SE2222222222' });
    let calls = 0;
    const lookup = async () => { calls += 1; return validLookup(); };
    const first = await preflightOrganizations(client);
    assert.ok(first.entries.find((item) => item.vatId === 'FI11111111')?.flags.includes('stale'));
    const { refreshed } = await refreshPreflight(client, first.entries, { lookup, limit: 1 });
    assert.equal(refreshed, 1);
    assert.equal(calls, 1);
    const second = await preflightOrganizations(client);
    const oy = second.entries.find((item) => item.vatId === 'FI11111111'), ab = second.entries.find((item) => item.vatId === 'SE2222222222');
    assert.equal(oy!.flags.includes('stale') !== ab!.flags.includes('stale'), true, 'bounded refresh re-checks exactly one stale entry');
  });
  it('re-checks when the VAT field changes and resolves deals to organizations', async () => {
    const organization = (await createCrmRecord(client, 'organization', { displayName: 'Changing BV', country: 'NL', vatId: 'NL111111111B11' })).item;
    await checkVatId(client, 'NL111111111B11', { lookup: validLookup });
    const deal = (await createCrmRecord(client, 'deal', { organizationId: organization.id, status: 'agreed', title: 'Synthetic sponsorship' })).item;
    let calls = 0;
    const lookup = async () => { calls += 1; return validLookup(); };
    const before = await evaluateDealVat(client, deal.id, { lookup });
    assert.equal(before?.blocking, undefined);
    assert.equal(calls, 0, 'an unchanged VAT ID stays cached');
    await updateCrmRecord(client, 'organization', organization, { vatId: 'NL999999999B99' });
    const after = await evaluateDealVat(client, deal.id, { lookup });
    assert.equal(calls, 1, 'a changed VAT ID triggers a fresh VIES check');
    assert.equal(after?.vatId, 'NL999999999B99');
  });
});
