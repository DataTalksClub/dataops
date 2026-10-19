import { before, after, describe, it } from 'node:test';
import assert from 'node:assert';
import { createServer, type Server } from 'http';
import { handler } from '../src/handler';
import { setupLocalDynamo, stopLocal } from '../scripts/local-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const invoke = (method: string, path: string, body?: unknown, query?: Record<string, string>) =>
  handler({ httpMethod: method, path, headers: {}, body: body === undefined ? null : JSON.stringify(body), queryStringParameters: query || null }, {});

describe('VIES API', () => {
  let client: DynamoDBDocumentClient;
  let server: Server, baseUrl: string;
  let requests: string[];
  const answer = (status: number, body: unknown) => (req: any, res: any) => {
    requests.push(String(req.url));
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  before(async () => {
    client = await setupLocalDynamo();
    requests = [];
    server = createServer(answer(200, { isValid: true, name: 'Synthetic ApS', requestDate: '2026-10-19' }));
    await new Promise<void>((resolve) => { server.listen(0, () => resolve()); });
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    process.env.VIES_BASE_URL = baseUrl;
  });
  after(async () => { delete process.env.VIES_BASE_URL; await new Promise<void>((resolve) => server.close(() => resolve())); await stopLocal(); });

  it('checks one VAT ID, caches the answer and forces a live re-check on demand', async () => {
    const first = await invoke('POST', '/api/vies/check', { vatId: 'dk 12345678' });
    assert.equal(first.statusCode, 200);
    const check = JSON.parse(first.body).check;
    assert.equal(check.status, 'valid');
    assert.equal(check.vatId, 'DK12345678');
    assert.equal(requests.length, 1);
    await invoke('POST', '/api/vies/check', { vatId: 'DK12345678' });
    assert.equal(requests.length, 1, 'a fresh recorded answer answers without VIES');
    const forced = await invoke('POST', '/api/vies/check', { vatId: 'DK12345678', force: true });
    assert.equal(JSON.parse(forced.body).check.status, 'valid');
    assert.equal(requests.length, 2);
    assert.equal((await invoke('POST', '/api/vies/check', {})).statusCode, 400);
  });

  it('rejects organization VAT data that cannot be a VIES identifier', async () => {
    const bare = await invoke('POST', '/api/sponsor-crm/organizations', { displayName: 'Bare CVR ApS', vatId: '12345678', country: 'DK' });
    assert.equal(bare.statusCode, 400);
    assert.match(JSON.parse(bare.body).error, /missing EU member-state prefix/);
    const malformed = await invoke('POST', '/api/sponsor-crm/organizations', { displayName: 'Malformed ApS', vatId: 'DK876543210' });
    assert.equal(malformed.statusCode, 400);
    assert.match(JSON.parse(malformed.body).error, /Invalid vatId format/);
    const badCountry = await invoke('POST', '/api/sponsor-crm/organizations', { displayName: 'Bad Country', country: 'Denmark' });
    assert.equal(badCountry.statusCode, 400);
    const good = await invoke('POST', '/api/sponsor-crm/organizations', { displayName: 'Synthetic ApS', vatId: 'DK23456789', country: 'DK' });
    assert.equal(good.statusCode, 201);
    const organization = JSON.parse(good.body);
    assert.equal(await (async () => {
      const detail = await invoke('GET', `/api/sponsor-crm/organizations/${organization.id}`);
      return JSON.parse(detail.body).viesCheck === undefined;
    })(), true, 'an unchecked organization has no viesCheck yet');
  });

  it('reports customer VAT state without the network and refreshes on demand', async () => {
    const checked = await invoke('POST', '/api/vies/check', { vatId: 'DK34567890' });
    assert.equal(JSON.parse(checked.body).check.status, 'valid');
    await invoke('POST', '/api/sponsor-crm/organizations', { displayName: 'Checked IVS', vatId: 'DK34567890', country: 'DK' });
    await invoke('POST', '/api/sponsor-crm/organizations', { displayName: 'No VAT Oy', country: 'FI' });
    await invoke('POST', '/api/sponsor-crm/organizations', { displayName: 'Stale AB', vatId: 'SE5555555555', country: 'SE' });
    const before = JSON.parse((await invoke('GET', '/api/vies/preflight')).body);
    assert.equal(before.scanned, 4);
    assert.deepEqual(before.entries.find((e: any) => e.vatId === 'DK34567890')?.flags, []);
    assert.deepEqual(before.entries.find((e: any) => e.displayName === 'No VAT Oy')?.flags, ['missing-vat-id']);
    assert.deepEqual(before.entries.find((e: any) => e.displayName === 'Stale AB')?.flags, ['stale']);
    const requestsBefore = requests.length;
    const refreshed = JSON.parse((await invoke('POST', '/api/vies/preflight', {})).body);
    assert.ok(refreshed.refreshed >= 1);
    assert.ok(requests.length > requestsBefore, 'the refresh pass talks to VIES');
    assert.deepEqual(refreshed.entries.find((e: any) => e.vatId === 'SE5555555555')?.flags, []);
    const organization = JSON.parse((await invoke('POST', '/api/sponsor-crm/organizations', { displayName: 'Checked Detail', vatId: 'DK34567890', country: 'DK' })).body);
    const detail = JSON.parse((await invoke('GET', `/api/sponsor-crm/organizations/${organization.id}`)).body);
    assert.equal(detail.viesCheck.status, 'valid');
    assert.equal(detail.viesCheck.vatId, 'DK34567890');
  });
});
