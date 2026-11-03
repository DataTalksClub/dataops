import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { getClient } from '../src/db/client';
import { createUserWithId } from '../src/db/users';
import { putBookkeepingItem } from '../src/db/bookkeeping';
import { createInvoice } from '../src/invoices/store';
import { TABLE_SPONSOR_CRM } from '../src/db/tableNames';
import { handleReconcileRoutes } from '../src/routes/reconcile';
import { saveStatement } from '../src/reconcile/service';
import { autoMatchMonths, matchesOf } from '../src/reconcile/autoMatch';
import { amountFit, buildMonthTable, DEFAULT_TOLERANCES, pairAll, type BankTx, type LedgerRow, type ManualDecisions } from '../src/reconcile/month';

const bank = (key: string, overrides: Partial<BankTx> = {}): BankTx => ({
  key, accountId: 'finom', statementId: 's', date: '2026-10-05', amount: '-10.00', currency: 'EUR', counterparty: 'Synthetic', ...overrides,
});
const ledger = (id: string, overrides: Partial<LedgerRow> = {}): LedgerRow => ({
  id, date: '2026-10-05', amount: '-10.00', currency: 'EUR', counterparty: 'Synthetic', documents: [{ id: `doc-${id}` }], ...overrides,
});
const none = (): ManualDecisions => ({ pairs: [], rejected: [], exceptions: {}, proofs: {} });

describe('matcher scoring', () => {
  it('converts a USD ledger row to a EUR bank row by the dated reference rate', () => {
    const fx = (currency: string) => (currency === 'USD' ? 1.1 : null);
    const row = bank('b', { amount: '-9.10', counterparty: 'Example SaaS' });
    const usd = ledger('l', { amount: '-10.00', currency: 'USD', counterparty: 'Example SaaS' });
    assert.equal(amountFit(row, usd, DEFAULT_TOLERANCES, false)?.basis, 'unknown');
    assert.deepEqual(amountFit(row, usd, DEFAULT_TOLERANCES, false, fx), { basis: 'fx', score: 4 });
    assert.equal(amountFit(bank('b', { amount: '-12.00' }), usd, DEFAULT_TOLERANCES, false, fx), null);
    const pairing = pairAll([row], [usd], none(), DEFAULT_TOLERANCES, fx);
    assert.equal(pairing.pairs.get('b')?.confidence, 'strong');
  });

  it('matches trading names of one vendor through canonical vendor names', () => {
    const pairing = pairAll(
      [bank('b', { counterparty: 'AMAZON WEB SERVICES EMEA SARL', amount: '-42.00' })],
      [ledger('l', { counterparty: 'AWS', amount: '-42.00' })],
      none(), DEFAULT_TOLERANCES,
    );
    assert.equal(pairing.pairs.get('b')?.confidence, 'exact');
  });

  it('scores a received-invoice-document-only candidate and an issued-invoice-only candidate against bank rows or lists them without a bank row', () => {
    const fx = (currency: string) => (currency === 'USD' ? 1.1 : null);
    const table = buildMonthTable({
      period: '2026-10',
      bank: [
        bank('b-aws', { date: '2026-10-03', counterparty: 'AMAZON WEB SERVICES EMEA SARL', amount: '-90.91', currency: 'EUR' }),
        bank('b-sponsor', { date: '2026-10-06', counterparty: 'ACME DATA INC.', reference: 'INV 202610/99', amount: '5000.00', currency: 'EUR' }),
      ],
      ledger: [],
      receivedInvoiceDocuments: [
        { id: 'doc-aws-only', date: '2026-10-02', amount: '100.00', currency: 'USD', counterparty: 'AWS', invoiceNumber: 'EUINDE26-100' },
        { id: 'doc-unpaid-only', date: '2026-10-28', amount: '59.04', currency: 'EUR', counterparty: 'Google Cloud EMEA Limited', invoiceNumber: 'GC-5904' },
      ],
      issuedInvoices: [
        { id: 'deal-acme', date: '2026-10-05', amount: '5000.00', currency: 'EUR', counterparty: 'Acme Data Inc.', invoiceNumber: '202610/99' },
        { id: 'deal-unpaid-sponsor', date: '2026-10-20', amount: '3000.00', currency: 'EUR', counterparty: 'Pending Sponsor Corp', invoiceNumber: '202610/100' },
      ],
      decisions: none(),
      rules: [],
      fx,
    });
    const view = matchesOf(table);
    assert.equal(view.counts.matched, 2);
    assert.equal(view.counts.unmatchedBank, 0);
    assert.equal(view.counts.invoicesWithoutBank, 2);
    const matchedByBank = Object.fromEntries(view.matched.map((row) => [row.bankKey, row]));
    assert.equal(matchedByBank['b-aws'].invoice.transactionId, 'doc-aws-only');
    assert.equal(matchedByBank['b-aws'].basis, 'fx');
    assert.equal(matchedByBank['b-aws'].confidence, 'strong');
    assert.equal(matchedByBank['b-sponsor'].invoice.transactionId, 'deal-acme');
    assert.equal(matchedByBank['b-sponsor'].basis, 'exact');
    assert.equal(matchedByBank['b-sponsor'].confidence, 'exact');
    assert.deepEqual(
      view.invoicesWithoutBank.map((row) => [row.transactionId, row.counterparty, row.amount, row.currency, row.invoiceNumber]),
      [
        ['deal-unpaid-sponsor', 'Pending Sponsor Corp', '3000.00', 'EUR', '202610/100'],
        ['doc-unpaid-only', 'Google Cloud EMEA Limited', '-59.04', 'EUR', 'GC-5904'],
      ],
    );
  });
});

describe('auto-match after upload', () => {
  let client: DynamoDBDocumentClient;
  const call = (method: string, path: string, body?: unknown) => handleReconcileRoutes(path, method, { httpMethod: method, path, headers: { 'x-user-id': 'am-operator' }, body: body === undefined ? null : JSON.stringify(body), queryStringParameters: null }, client);
  const put = (value: Record<string, unknown>) => putBookkeepingItem(client, 'bookkeeping', { entryType: 'expense', currency: 'EUR', ...value });

  before(async () => {
    client = await getClient(await startLocal());
    await createTables(client);
    await createUserWithId(client, 'am-operator', { name: 'Operator', email: 'am@datatalks.club', role: 'operator' });
  });
  after(stopLocal);

  it('persists exact pairs, leaves weak ones open and reports the three sections', async () => {
    await put({ transactionDate: '2026-07-03', paidDate: '2026-07-03', amount: '48.60', counterparty: 'Example Cloud' });
    await put({ transactionDate: '2026-07-10', paidDate: '2026-07-10', amount: '99.00', counterparty: 'Vendor Without Payment' });
    await put({ transactionDate: '2026-07-20', paidDate: '2026-07-20', amount: '30.00', counterparty: 'Other Thing' });
    await saveStatement(client, {
      accountId: 'finom', period: '2026-07',
      rows: [
        { date: '2026-07-03', amount: '-48.60', currency: 'EUR', counterparty: 'Example Cloud' },
        { date: '2026-07-21', amount: '-35.00', currency: 'EUR', counterparty: 'Mystery Shop' },
      ],
    } as never);

    const run = await autoMatchMonths(client, ['2026-07']);
    assert.equal(run.attached, 1);
    assert.equal((await autoMatchMonths(client, ['2026-07'])).attached, 0, 'a second run adds nothing');

    const response = await call('GET', '/api/reconcile/months/2026-07/matches');
    assert.equal(response.statusCode, 200, response.body);
    const view = JSON.parse(response.body);
    assert.deepEqual(view.counts, { matched: 1, autoMatched: 1, needsReview: 0, unmatchedBank: 1, invoicesWithoutBank: 2 });
    assert.equal(view.matched[0].invoice.counterparty, 'Example Cloud');
    assert.equal(view.matched[0].basis, 'exact');
    assert.equal(view.unmatchedBank[0].counterparty, 'Mystery Shop');
    assert.deepEqual(view.invoicesWithoutBank.map((row: { counterparty: string }) => row.counterparty).sort(), ['Other Thing', 'Vendor Without Payment']);

    // An unmatch sticks: the matcher does not bring the pair back.
    const bankKey = view.matched[0].bankKey, transactionId = view.matched[0].invoice.transactionId;
    await call('POST', '/api/reconcile/months/2026-07/unpair', { bankKey, transactionId });
    assert.equal((await autoMatchMonths(client, ['2026-07'])).attached, 0);
    assert.equal(JSON.parse((await call('GET', '/api/reconcile/months/2026-07/matches')).body).counts.matched, 0);
  });

  it('skips a closed month and exposes the action as a route', async () => {
    const table = buildMonthTable({ period: '2026-10', bank: [bank('b')], ledger: [ledger('l')], decisions: none(), rules: [] });
    assert.equal(matchesOf(table).counts.matched, 1);
    const response = await call('POST', '/api/reconcile/months/2026-07/auto-match');
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(JSON.parse(response.body).autoMatch.attached, 0);
  });

  it('auto-matches and lists received invoice documents and issued invoices that have no bookkeeping ledger row yet', async () => {
    const awsDoc = (await putBookkeepingItem(client, 'document', {
      documentType: 'invoice',
      status: 'active',
      contentType: 'application/pdf',
      originalFilename: 'aws-aug.pdf',
      byteSize: 120,
      sha256: '1'.repeat(64),
      s3Key: 'documents/aws-aug.pdf',
      facts: {
        paidDate: '2026-08-02',
        amount: '245.95',
        currency: 'USD',
        counterparty: 'AWS',
        invoiceNumber: 'EUINDE26-8001',
        extraction: { method: 'synthetic', needsReview: false, direction: 'expense' },
      },
    })).item;

    const now = new Date().toISOString();
    await createInvoice(client, {
      id: '2'.repeat(64),
      revision: 1,
      status: 'pending',
      fields: {
        transactionDate: '2026-08-31',
        counterparty: 'Contabo GmbH',
        amount: '95.44',
        currency: 'EUR',
        invoiceNumber: '20262041335',
      },
      extraction: { method: 'synthetic', evidence: [], issues: [], needsReview: false, direction: 'expense' },
      source: { intakeItemIds: ['intake-aug-contabo'], artifactId: 'email-doc-contabo', checksum: '3'.repeat(64) },
      destinations: { dropbox: { state: 'pending', operationId: 'dbx' }, sheets: { state: 'pending', operationId: 'sh' } },
      audit: [],
      createdAt: now,
      updatedAt: now,
    });

    await client.send(new PutCommand({
      TableName: TABLE_SPONSOR_CRM,
      Item: { PK: 'ORGANIZATION#org-aug', SK: 'ORGANIZATION#org-aug', id: 'org-aug', name: 'Sponsor Aug Corp', version: 1, createdAt: now, updatedAt: now },
    }));
    await client.send(new PutCommand({
      TableName: TABLE_SPONSOR_CRM,
      Item: { PK: 'DEAL#deal-aug-paid', SK: 'DEAL#deal-aug-paid', id: 'deal-aug-paid', organizationId: 'org-aug', name: 'Aug Sponsorship', status: 'agreed', version: 1, createdAt: now, updatedAt: now },
    }));
    await client.send(new PutCommand({
      TableName: TABLE_SPONSOR_CRM,
      Item: {
        PK: 'SPONSOR_FINANCE#deal-aug-paid',
        SK: 'SPONSOR_FINANCE#deal-aug-paid',
        recordType: 'sponsor-finance',
        dealId: 'deal-aug-paid',
        invoiceNumber: '202608/42',
        amountDue: '4000.00',
        currency: 'EUR',
        issuedOn: '2026-08-05',
        dueOn: '2026-08-25',
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
    }));

    await saveStatement(client, {
      accountId: 'revolut',
      period: '2026-08',
      rows: [
        {
          date: '2026-08-03',
          amount: '-208.33',
          currency: 'EUR',
          origAmount: '-245.95',
          origCurrency: 'USD',
          counterparty: 'AMAZON WEB SERVICES EMEA SARL',
        },
        {
          date: '2026-08-06',
          amount: '4000.00',
          currency: 'EUR',
          counterparty: 'SPONSOR AUG CORP',
          reference: 'INV 202608/42',
        },
      ],
    } as never);

    const run = await autoMatchMonths(client, ['2026-08'], { fx: (currency) => (currency === 'USD' ? 1.18 : null) });
    assert.equal(run.attached, 2);

    const response = await call('GET', '/api/reconcile/months/2026-08/matches');
    assert.equal(response.statusCode, 200, response.body);
    const view = JSON.parse(response.body);
    assert.deepEqual(view.counts, { matched: 2, autoMatched: 2, needsReview: 0, unmatchedBank: 0, invoicesWithoutBank: 1 });
    assert.deepEqual(
      view.matched.map((row: { invoice: { transactionId: string }; basis: string; confidence: string; auto: boolean }) => [
        row.invoice.transactionId,
        row.basis,
        row.confidence,
        row.auto,
      ]),
      [
        [String(awsDoc.id), 'fx', 'exact', true],
        ['deal-aug-paid', 'exact', 'exact', true],
      ],
    );
    assert.deepEqual(
      view.invoicesWithoutBank.map((row: { transactionId: string; counterparty: string; amount: string; currency: string; invoiceNumber?: string }) => [
        row.transactionId,
        row.counterparty,
        row.amount,
        row.currency,
        row.invoiceNumber,
      ]),
      [['2'.repeat(64), 'Contabo GmbH', '-95.44', 'EUR', '20262041335']],
    );
  });
});
