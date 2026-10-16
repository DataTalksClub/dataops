import { after, before, describe, it } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'crypto';
import { Readable } from 'stream';
import { PutCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { handler } from '../src/handler';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { getClient } from '../src/db/client';
import { putBookkeepingItem } from '../src/db/bookkeeping';
import { TABLE_BOOKKEEPING } from '../src/db/tableNames';
import { setBookkeepingStorageForTests } from '../src/routes/bookkeepingShared';
import { scoreDocument, scoreSponsorDeal } from '../src/routes/bookkeepingSuggestions';
import type { LedgerRow } from '../src/sponsorFinance/ledger';

const invoke = (method: string, path: string, body?: unknown) =>
  handler({ httpMethod: method, path, headers: {}, body: body === undefined ? null : JSON.stringify(body), queryStringParameters: null }, {});
const transaction = {
  transactionDate: '2026-09-02', paidDate: '2026-09-03', counterparty: 'Example Cloud', description: 'Cloud services',
  amount: '120.50', currency: 'USD', amountEur: '110.25', entryType: 'expense', sourceType: 'manual',
};
const ledgerRow = (fields: Partial<LedgerRow>): LedgerRow => ({
  dealId: 'deal-1', organizationId: 'org-1', organizationName: 'Example Sponsor GmbH', dealStatus: 'agreed',
  invoiceState: 'sent', paymentState: 'unpaid', timingState: 'due', followUp: {} as LedgerRow['followUp'], ...fields,
} as LedgerRow);

describe('bookkeeping matching suggestions', () => {
  it('scores documents by amount, provider and date, and drops weak or distant ones', () => {
    const exact = scoreDocument(transaction, { amount: '120.50', currency: 'USD', transactionDate: '2026-09-01', counterparty: 'Example Cloud Inc', method: 'deterministic-text', extractedAt: '' });
    assert.deepEqual(exact, { score: 7, reasons: ['same amount', 'provider matches', '1 day apart'], gap: 1 });
    const converted = scoreDocument(transaction, { amount: '110.25', currency: 'EUR', method: 'deterministic-text', extractedAt: '' });
    assert.deepEqual(converted?.reasons, ['same amount']);
    assert.equal(scoreDocument(transaction, { amount: '9.99', currency: 'USD', transactionDate: '2026-09-02', method: 'x', extractedAt: '' }), null, 'a date alone is not a match');
    assert.equal(scoreDocument(transaction, { amount: '120.50', currency: 'USD', transactionDate: '2025-01-01', method: 'x', extractedAt: '' }), null, 'months apart is not a match');
    assert.equal(scoreDocument(transaction, { counterparty: 'Example Services Ltd', method: 'x', extractedAt: '' }), null, 'generic words do not match a provider');
  });

  it('suggests only sponsor deals still waiting for money, for income', () => {
    const income = { ...transaction, entryType: 'income', counterparty: 'EXAMPLE SPONSOR', amount: '5000.00', currency: 'EUR' };
    assert.deepEqual(scoreSponsorDeal(income, ledgerRow({ amountDue: '5000', outstanding: '5000', currency: 'EUR', dueOn: '2026-09-10' }))?.reasons,
      ['same amount', 'sponsor name matches', 'around the due date']);
    assert.equal(scoreSponsorDeal(income, ledgerRow({ paymentState: 'paid', amountDue: '5000', currency: 'EUR' })), null);
    assert.equal(scoreSponsorDeal({ ...income, entryType: 'expense' }, ledgerRow({ amountDue: '5000', currency: 'EUR' })), null);
    assert.equal(scoreSponsorDeal({ ...income, counterparty: 'Someone Else' }, ledgerRow({ amountDue: '7000', currency: 'EUR' })), null);
  });

  describe('API', () => {
    let client: DynamoDBDocumentClient;
    before(async () => { const port = await startLocal(); client = await getClient(port); await createTables(client); });
    after(() => { delete process.env.SPONSOR_FINANCE_ENABLED; return stopLocal(); });

    const document = async (name: string, fields: Record<string, unknown>) => (await putBookkeepingItem(client, 'document', {
      documentType: 'invoice', status: 'active', contentType: 'application/pdf', byteSize: 9, linkRefCount: 0,
      sha256: createHash('sha256').update(name).digest('hex'), s3Key: `documents/${name}`, ...fields,
    })).item;

    it('lists unattached documents that fit the transaction', async () => {
      const created = JSON.parse((await invoke('POST', '/api/bookkeeping/transactions', transaction)).body);
      const fits = await document('fits', { facts: { amount: '120.50', currency: 'USD', transactionDate: '2026-09-02', counterparty: 'Example Cloud', method: 'deterministic-text', extractedAt: '2026-10-16T00:00:00Z' } });
      await document('attached', { linkRefCount: 1, facts: { amount: '120.50', currency: 'USD', method: 'x', extractedAt: '' } });
      await document('other', { facts: { amount: '3.00', currency: 'USD', counterparty: 'Unrelated', method: 'x', extractedAt: '' } });
      await document('statement', { documentType: 'bank-statement', facts: { amount: '120.50', currency: 'USD', method: 'x', extractedAt: '' } });
      const response = await invoke('GET', `/api/bookkeeping/transactions/${created.id}/suggestions`);
      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body);
      assert.deepEqual(body.documents.map((item: any) => item.id), [fits.id]);
      assert.equal(body.documents[0].s3Key, undefined);
      assert.deepEqual(body.sponsor, { linkedDealId: null, deals: [] });
      assert.equal((await invoke('GET', '/api/bookkeeping/transactions/missing/suggestions')).statusCode, 404);
    });

    it('marks transactions a sponsor deal claimed, in the list and the suggestions', async () => {
      process.env.SPONSOR_FINANCE_ENABLED = 'true';
      const income = JSON.parse((await invoke('POST', '/api/bookkeeping/transactions', { ...transaction, entryType: 'income', description: 'Sponsorship' })).body);
      const claim = `SPONSOR_FINANCE_CLAIM#transaction#${income.id}`;
      await client.send(new PutCommand({ TableName: TABLE_BOOKKEEPING, Item: { PK: claim, SK: claim, recordType: 'sponsor-finance-claim', kind: 'transaction', sourceId: income.id, dealId: 'deal-claimed' } }));
      const listed = JSON.parse((await invoke('GET', '/api/bookkeeping/transactions')).body).items;
      assert.equal(listed.find((item: any) => item.id === income.id).sponsorDealId, 'deal-claimed');
      assert.ok(listed.filter((item: any) => item.id !== income.id).every((item: any) => item.sponsorDealId === undefined));
      assert.equal(listed.some((item: any) => String(item.PK || '').startsWith('SPONSOR')), false);
      const body = JSON.parse((await invoke('GET', `/api/bookkeeping/transactions/${income.id}/suggestions`)).body);
      assert.deepEqual(body.sponsor, { linkedDealId: 'deal-claimed', deals: [] });
    });

    it('stores what a document says, and keeps an unreadable one marked as read', async () => {
      process.env.BOOKKEEPING_DOCUMENTS_BUCKET = 'synthetic-private-bucket';
      setBookkeepingStorageForTests({ send: async () => ({ Body: Readable.from([Buffer.from('%PDF-not-really')]) }) } as any);
      const target = await document('to-read', {});
      const response = await invoke('POST', `/api/bookkeeping/documents/${target.id}/facts`);
      assert.equal(response.statusCode, 200);
      const body = JSON.parse(response.body);
      assert.equal(body.facts.method, 'unreadable');
      assert.equal(body.s3Key, undefined);
      const listed = JSON.parse((await invoke('GET', '/api/bookkeeping/documents')).body).items;
      assert.equal(listed.find((item: any) => item.id === target.id).facts.method, 'unreadable');
      assert.equal((await invoke('POST', '/api/bookkeeping/documents/missing/facts')).statusCode, 404);
    });
  });
});
