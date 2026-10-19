import { before, after, describe, it } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'crypto';
import { handler } from '../src/handler';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { getClient } from '../src/db/client';
import { putBookkeepingItem } from '../src/db/bookkeeping';
import { createCrmRecord } from '../src/db/sponsorCrm';
import { putViesCheck } from '../src/vies/store';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const invoke = (method: string, path: string, body?: unknown) =>
  handler({ httpMethod: method, path, headers: {}, body: body === undefined ? null : JSON.stringify(body), queryStringParameters: null }, {});

describe('VAT preflight on the monthly tax pack', () => {
  let client: DynamoDBDocumentClient;
  before(async () => {
    client = await startLocal().then((port) => getClient(port));
    await createTables(client);
  });
  after(stopLocal);

  it('reports flagged customer VAT state alongside the assembled pack', async () => {
    const setup = await invoke('POST', '/api/bookkeeping/accounts/setup');
    assert.equal(setup.statusCode, 200);
    const accounts = JSON.parse(setup.body).accounts as Array<{ id: string }>;
    for (const account of accounts) {
      await putBookkeepingItem(client, 'document', {
        documentType: 'bank-statement', status: 'active', accountId: account.id, statementMonth: '2026-10',
        originalFilename: 'synthetic.pdf', contentType: 'application/pdf', byteSize: 9,
        sha256: createHash('sha256').update(`synthetic-${account.id}`).digest('hex'), s3Key: `documents/${account.id}`,
      });
    }
    await invoke('POST', '/api/bookkeeping/transactions', {
      transactionDate: '2026-10-05', counterparty: 'Synthetic ApS', description: 'Sponsorship',
      amount: '500', currency: 'EUR', sourceType: 'manual',
    });
    // A clean customer, a customer VIES does not know, one without any VAT ID, and a domestic one.
    await createCrmRecord(client, 'organization', { displayName: 'Clean ApS', country: 'DK', vatId: 'DK12345678' });
    await createCrmRecord(client, 'organization', { displayName: 'Unknown IVS', country: 'DK', vatId: 'DK99999999' });
    await createCrmRecord(client, 'organization', { displayName: 'No VAT Oy', country: 'FI' });
    await createCrmRecord(client, 'organization', { displayName: 'Domestic GmbH', country: 'DE', vatId: 'DE123456789' });
    const recordedCheck = (vatId: string, status: 'valid' | 'not-found') => putViesCheck(client, {
      id: vatId, recordType: 'vies-check', vatId, country: vatId.slice(0, 2), number: vatId.slice(2),
      status, source: 'vies', checkedAt: '2026-10-01T00:00:00.000Z',
    });
    await recordedCheck('DK12345678', 'valid');
    await recordedCheck('DK99999999', 'not-found');

    const snapshot = await invoke('POST', '/api/bookkeeping/reports/snapshot', { month: '2026-10' });
    assert.equal(snapshot.statusCode, 201);
    const preflight = JSON.parse(snapshot.body).vatPreflight;
    assert.equal(preflight.scanned, 3, 'domestic customers are out of scope');
    assert.equal(preflight.issueCount, 2);
    const unknown = preflight.issues.find((issue: { vatId?: string }) => issue.vatId === 'DK99999999');
    assert.deepEqual(unknown?.flags, ['not-found']);
    const noVat = preflight.issues.find((issue: { displayName?: string }) => issue.displayName === 'No VAT Oy');
    assert.deepEqual(noVat?.flags, ['missing-vat-id']);
    assert.equal(preflight.issues.some((issue: { vatId?: string }) => issue.vatId === 'DK12345678'), false);
  });
});
