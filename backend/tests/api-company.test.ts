import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';

import { handler } from '../src/handler';
import { getClient } from '../src/db/client';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { startLocal, stopLocal, TABLE_SECRETS, TABLE_AUDIT_EVENTS } from '../scripts/local-dynamodb';
import { createTables } from '../scripts/local-dynamodb';
import { createUserWithId } from '../src/db/users';
import { truncateTestTables } from './helpers/db';
import type { LambdaResponse } from '../src/types';

function invoke(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
  query?: Record<string, string>,
): Promise<LambdaResponse> {
  const event = {
    httpMethod: method,
    path,
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : null,
    headers: headers || {},
    queryStringParameters: query || null,
  };
  return handler(event, {});
}

const ADMIN_ID = 'company-admin-0001';
const OPERATOR_ID = 'company-operator-01';
const adminHeaders = { 'x-user-id': ADMIN_ID };
const operatorHeaders = { 'x-user-id': OPERATOR_ID };

/** A value distinctive enough that a substring leak check is meaningful. */
const MARKER_IBAN = 'IBAN-MARKER-9f8e7d6c5b4a';
const PROFILE = {
  legalName: 'DataTalks Club OÜ',
  registeredAddress: { line1: 'Marker Street 1', city: 'Marker City', postalCode: '00001', country: 'Markerland' },
  tax: { vatId: 'MARKER-VAT-1' },
};
const BANK = { label: 'Euro account', currency: 'EUR', details: { IBAN: MARKER_IBAN, BIC: 'MARKER-BIC' } };

describe('API — Company/vendor details', () => {
  let client: DynamoDBDocumentClient;

  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
    await createUserWithId(client, ADMIN_ID, { name: 'Admin', email: 'admin@datatalks.club', role: 'admin' });
    await createUserWithId(client, OPERATOR_ID, { name: 'Op', email: 'op@datatalks.club', role: 'operator' });
  });

  afterEach(async () => {
    await truncateTestTables(client);
    // truncateTestTables wipes the seeded users too; restore them.
    await createUserWithId(client, ADMIN_ID, { name: 'Admin', email: 'admin@datatalks.club', role: 'admin' });
    await createUserWithId(client, OPERATOR_ID, { name: 'Op', email: 'op@datatalks.club', role: 'operator' });
  });

  async function seedProfile(): Promise<number> {
    const res = await invoke('PUT', '/api/company', { ...PROFILE, expectedVersion: 0 }, adminHeaders);
    assert.strictEqual(res.statusCode, 200);
    return JSON.parse(res.body).company.version as number;
  }

  async function seedBank(id = 'eur'): Promise<void> {
    const res = await invoke('PUT', `/api/company/bank/${id}`, BANK, adminHeaders);
    assert.strictEqual(res.statusCode, 200);
  }

  describe('profile round trip', () => {
    it('starts empty, then PUT creates version 1', async () => {
      const empty = JSON.parse((await invoke('GET', '/api/company', undefined, adminHeaders)).body);
      assert.strictEqual(empty.company.legalName, null);
      assert.strictEqual(empty.company.version, 0);
      assert.deepStrictEqual(empty.company.bankAccounts, []);
      const version = await seedProfile();
      assert.strictEqual(version, 1);
      const got = JSON.parse((await invoke('GET', '/api/company', undefined, adminHeaders)).body);
      assert.strictEqual(got.company.legalName, PROFILE.legalName);
      assert.deepStrictEqual(got.company.tax, PROFILE.tax);
    });

    it('PUT merges fields and 409s on a stale version', async () => {
      await seedProfile();
      const stale = await invoke('PUT', '/api/company', { contact: { email: 'ops@datatalks.club' }, expectedVersion: 0 }, adminHeaders);
      assert.strictEqual(stale.statusCode, 409);
      assert.strictEqual(JSON.parse(stale.body).code, 'version_conflict');
      const ok = await invoke('PUT', '/api/company', { contact: { email: 'ops@datatalks.club' }, expectedVersion: 1 }, adminHeaders);
      assert.strictEqual(ok.statusCode, 200);
      const got = JSON.parse((await invoke('GET', '/api/company', undefined, adminHeaders)).body);
      assert.strictEqual(got.company.legalName, PROFILE.legalName);
      assert.deepStrictEqual(got.company.contact, { email: 'ops@datatalks.club' });
    });

    it('sections return only their slice', async () => {
      await seedProfile();
      const tax = JSON.parse((await invoke('GET', '/api/company', undefined, adminHeaders, { section: 'tax' })).body);
      assert.deepStrictEqual(tax.company.tax, PROFILE.tax);
      assert.strictEqual(tax.company.registeredAddress, undefined);
      const address = JSON.parse((await invoke('GET', '/api/company', undefined, adminHeaders, { section: 'address' })).body);
      assert.deepStrictEqual(address.company.registeredAddress, PROFILE.registeredAddress);
      const bad = await invoke('GET', '/api/company', undefined, adminHeaders, { section: 'vat' });
      assert.strictEqual(bad.statusCode, 400);
    });
  });

  describe('bank accounts live in the secrets store', () => {
    it('default show lists summaries without values; ?section=bank decrypts', async () => {
      await seedProfile();
      await seedBank();
      const shown = await invoke('GET', '/api/company', undefined, adminHeaders);
      assert.strictEqual(shown.statusCode, 200);
      assert.strictEqual(shown.body.includes(MARKER_IBAN), false);
      const summaries = JSON.parse(shown.body).company.bankAccounts;
      assert.deepStrictEqual(summaries.map((a: { id: string }) => a.id), ['eur']);
      assert.strictEqual(summaries[0].label, BANK.label);

      const full = await invoke('GET', '/api/company', undefined, adminHeaders, { section: 'bank' });
      assert.strictEqual(full.statusCode, 200);
      const accounts = JSON.parse(full.body).accounts;
      assert.strictEqual(accounts[0].details.IBAN, MARKER_IBAN);

      const single = JSON.parse((await invoke('GET', '/api/company/bank/eur', undefined, adminHeaders)).body);
      assert.strictEqual(single.account.details.BIC, 'MARKER-BIC');
    });

    it('the stored secret holds only ciphertext', async () => {
      await seedBank();
      const scan = await client.send(new ScanCommand({ TableName: TABLE_SECRETS }));
      assert.strictEqual((scan.Items || []).length, 1);
      assert.strictEqual(JSON.stringify(scan.Items?.[0]).includes(MARKER_IBAN), false);
    });

    it('bank reads and writes are audited without values', async () => {
      await seedBank();
      await invoke('GET', '/api/company/bank/eur', undefined, adminHeaders);
      const audit = await client.send(new ScanCommand({ TableName: TABLE_AUDIT_EVENTS }));
      assert.ok((audit.Items || []).length >= 2);
      for (const item of audit.Items || []) {
        assert.strictEqual(JSON.stringify(item).includes(MARKER_IBAN), false);
      }
      const names = (audit.Items || []).map((item) => item.PK);
      assert.ok(names.includes('AUDIT#SECRET#company-bank-eur'));
    });

    it('DELETE removes the secret and its summary', async () => {
      await seedBank();
      const res = await invoke('DELETE', '/api/company/bank/eur', undefined, adminHeaders);
      assert.strictEqual(res.statusCode, 200);
      assert.deepStrictEqual(JSON.parse(res.body), { deleted: true, id: 'eur' });
      const gone = await invoke('GET', '/api/company/bank/eur', undefined, adminHeaders);
      assert.strictEqual(gone.statusCode, 404);
      const shown = JSON.parse((await invoke('GET', '/api/company', undefined, adminHeaders)).body);
      assert.deepStrictEqual(shown.company.bankAccounts, []);
    });

    it('rejects bad account ids and bodies without echoing values', async () => {
      await seedProfile();
      const badId = await invoke('PUT', '/api/company/bank/UPPER', BANK, adminHeaders);
      assert.strictEqual(badId.statusCode, 400);
      const badBody = await invoke('PUT', '/api/company/bank/eur', { label: 'x', currency: 'EURO', details: { IBAN: MARKER_IBAN } }, adminHeaders);
      assert.strictEqual(badBody.statusCode, 400);
      assert.strictEqual(badBody.body.includes(MARKER_IBAN), false);
    });
  });

  describe('admin-only', () => {
    it('operator gets 403 on every route', async () => {
      for (const [method, path, body] of [
        ['GET', '/api/company', undefined],
        ['PUT', '/api/company', { legalName: 'x', expectedVersion: 0 }],
        ['GET', '/api/company/bank/eur', undefined],
        ['PUT', '/api/company/bank/eur', BANK],
        ['DELETE', '/api/company/bank/eur', undefined],
      ] as const) {
        const res = await invoke(method, path, body as unknown, operatorHeaders);
        assert.strictEqual(res.statusCode, 403, `${method} ${path}`);
        assert.strictEqual(JSON.parse(res.body).error, 'Admin access required');
      }
    });

    it('no actor at all gets 403', async () => {
      const res = await invoke('GET', '/api/company', undefined, {});
      assert.strictEqual(res.statusCode, 403);
    });
  });
});
