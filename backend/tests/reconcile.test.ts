import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'stream';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { handler } from '../src/handler';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { getClient } from '../src/db/client';
import { createUserWithId } from '../src/db/users';
import { createDocumentLink, putBookkeepingItem } from '../src/db/bookkeeping';
import { TABLE_SPONSOR_CRM } from '../src/db/tableNames';
import { setBookkeepingStorageForTests } from '../src/routes/bookkeepingShared';
import { handleReconcileRoutes } from '../src/routes/reconcile';

const invoke = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}, query?: Record<string, string>) =>
  handler({ httpMethod: method, path, headers, body: body === undefined ? null : JSON.stringify(body), queryStringParameters: query || null }, {});

let client: DynamoDBDocumentClient;
const call = (method: string, path: string, body?: unknown) => handleReconcileRoutes(path, method, { httpMethod: method, path, headers: { 'x-user-id': OPERATOR }, body: body === undefined ? null : JSON.stringify(body), queryStringParameters: null }, client);

const OPERATOR = 'reconcile-operator';
const APPROVER = 'reconcile-approver';
const as = (user: string) => (method: string, path: string, body?: unknown) => handleReconcileRoutes(path, method, { httpMethod: method, path, headers: { 'x-user-id': user }, body: body === undefined ? null : JSON.stringify(body), queryStringParameters: null }, client);
const AUTH = { 'x-user-id': OPERATOR };
const row = (overrides: Record<string, unknown> = {}) => ({
  date: '2026-10-05', amount: '10.00', currency: 'EUR', counterparty: 'Synthetic counterparty', ...overrides,
});

async function putCrm(client: DynamoDBDocumentClient, kind: string, value: Record<string, unknown>) {
  const now = new Date().toISOString();
  await client.send(new PutCommand({
    TableName: TABLE_SPONSOR_CRM,
    Item: { PK: `${kind.toUpperCase()}#${value.id}`, SK: `${kind.toUpperCase()}#${value.id}`, version: 1, createdAt: now, updatedAt: now, ...value },
  }));
}

async function putFinance(client: DynamoDBDocumentClient, value: Record<string, unknown>) {
  await client.send(new PutCommand({
    TableName: TABLE_SPONSOR_CRM,
    Item: { PK: `SPONSOR_FINANCE#${value.dealId}`, SK: `SPONSOR_FINANCE#${value.dealId}`, recordType: 'sponsor-finance', version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...value },
  }));
}

describe('reconcile API', () => {
  before(async () => {
    const port = await startLocal();
    client = await getClient(port);
    await createTables(client);
    await createUserWithId(client, OPERATOR, { name: 'Reconcile operator', email: 'reconcile@datatalks.club', role: 'operator' });
    await createUserWithId(client, APPROVER, { name: 'Reconcile approver', email: 'approver@datatalks.club', role: 'admin' });
  });
  after(stopLocal);

  it('requires a finance operator', async () => {
    const anonymous = await invoke('GET', '/api/reconcile/report');
    assert.equal(anonymous.statusCode, 401);
    const forbidden = await invoke('GET', '/api/reconcile/report', undefined, { 'x-user-id': OPERATOR }, { period: '2026-10' });
    assert.equal(forbidden.statusCode, 200);
  });

  it('stores statements idempotently and rejects bad rows without echoing them', async () => {
    const bad = await call('POST', '/api/reconcile/statements', {
      account: 'revolut', period: '2026-10',
      rows: [{ date: '2026-10-05', amount: 'NaN', currency: 'EUR', counterparty: 'x' }],
    });
    assert.equal(bad.statusCode, 400);
    assert.ok(!JSON.parse(bad.body).error.includes('NaN'));
    const wrongAccount = await call('POST', '/api/reconcile/statements', { account: 'paypal', period: '2026-10', rows: [row()] });
    assert.equal(wrongAccount.statusCode, 400);

    const documentId = 'stmt-doc-1';
    const first = await call('POST', '/api/reconcile/statements', {
      account: 'revolut', period: '2026-10', documentId, filename: 'statement.pdf', contentType: 'application/pdf',
      rows: [row({ amount: '100.00', date: '2026-10-01' }), row({ amount: '-4.50', date: '2026-10-02' })],
    });
    assert.equal(first.statusCode, 201);
    const statement = JSON.parse(first.body).statement;
    assert.equal(statement.from, '2026-10-01');
    assert.equal(statement.to, '2026-10-02');

    const duplicate = await call('POST', '/api/reconcile/statements', {
      account: 'revolut', period: '2026-10', documentId,
      rows: [row({ amount: '100.00', date: '2026-10-01' }), row({ amount: '-4.50', date: '2026-10-02' })],
    });
    assert.equal(duplicate.statusCode, 201);
    assert.equal(JSON.parse(duplicate.body).statement.id, statement.id);

    const listed = JSON.parse((await call('GET', '/api/reconcile/statements')).body);
    assert.equal(listed.items.length, 1);
    const removed = await call('DELETE', `/api/reconcile/statements/${statement.id}`);
    assert.equal(removed.statusCode, 200);
    assert.equal(JSON.parse((await call('GET', '/api/reconcile/statements')).body).items.length, 0);
  });

  it('keeps a counterparty alias registry', async () => {
    const created = await call('POST', '/api/reconcile/aliases', { alias: 'OMANE', sponsor: 'Organization Two' });
    assert.equal(created.statusCode, 201);
    const upsert = await call('POST', '/api/reconcile/aliases', { alias: 'omane', sponsor: 'Organization Two' });
    assert.equal(upsert.statusCode, 201);
    const listed = JSON.parse((await call('GET', '/api/reconcile/aliases')).body);
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].sponsor, 'Organization Two');
    const missing = await call('POST', '/api/reconcile/aliases', { alias: '', sponsor: '' });
    assert.equal(missing.statusCode, 400);
    await call('DELETE', `/api/reconcile/aliases/${listed.items[0].id}`);
    assert.equal(JSON.parse((await call('GET', '/api/reconcile/aliases')).body).items.length, 0);
  });

  it('parses an uploaded statement document on demand', async () => {
    process.env.BOOKKEEPING_DOCUMENTS_BUCKET = 'synthetic-private-bucket';
    const csv = [
      'Type;Product;Started Date;Completed Date;Description;Amount;Fee;Currency;State;Balance',
      'TRANSFER;Current;02 Oct 2026;02 Oct 2026;Transfer from Sponsor One;1000.00;0.00;EUR;Completed;5000.00',
    ].join('\n');
    let objectBytes = Buffer.from(csv);
    const fake = {
      send: async (command: { constructor: { name: string } }) => {
        if (command.constructor.name === 'GetObjectCommand') return { Body: Readable.from(objectBytes), VersionId: 'synthetic' };
        return {};
      },
    };
    setBookkeepingStorageForTests(fake as never);
    const document = (await putBookkeepingItem(client, 'document', {
      documentType: 'bank-statement', status: 'active', contentType: 'text/csv',
      originalFilename: 'statement.csv', byteSize: objectBytes.length, sha256: 'a'.repeat(64), s3Key: 'documents/parse-test',
    })).item;
    const parsed = JSON.parse((await call('POST', '/api/reconcile/statements/parse', { account: 'revolut', documentId: document.id })).body);
    assert.equal(parsed.rowCount, 1);
    assert.deepEqual(parsed.rows[0], { date: '2026-10-02', amount: '1000.00', currency: 'EUR', counterparty: 'Transfer from Sponsor One' });

    const notStatement = (await putBookkeepingItem(client, 'document', {
      documentType: 'receipt', status: 'active', contentType: 'application/pdf', originalFilename: 'receipt.pdf', byteSize: 9, sha256: 'b'.repeat(64), s3Key: 'documents/receipt',
    })).item;
    const rejected = await call('POST', '/api/reconcile/statements/parse', { account: 'revolut', documentId: notStatement.id });
    assert.equal(rejected.statusCode, 400);
    objectBytes = Buffer.alloc(0);
  });

  it('matches invoice references, aliases and amounts into one month-end report', async () => {
    await putCrm(client, 'organization', { id: 'org-one', name: 'Organization One' });
    await putCrm(client, 'organization', { id: 'org-two', name: 'Organization Two' });
    await putCrm(client, 'deal', { id: 'deal-one', organizationId: 'org-one', name: 'Deal One', status: 'open' });
    await putCrm(client, 'deal', { id: 'deal-two', organizationId: 'org-two', name: 'Deal Two', status: 'open' });
    await putCrm(client, 'deal', { id: 'deal-amb-1', organizationId: 'org-one', name: 'Ambiguous One', status: 'open' });
    await putCrm(client, 'deal', { id: 'deal-amb-2', organizationId: 'org-two', name: 'Ambiguous Two', status: 'open' });
    await putCrm(client, 'deal', { id: 'deal-unpaid', organizationId: 'org-one', name: 'Unpaid Deal', status: 'open' });
    await putFinance(client, { dealId: 'deal-one', invoiceNumber: '202610/12', amountDue: '1000.00', currency: 'EUR', issuedOn: '2026-10-01', dueOn: '2026-10-31' });
    await putFinance(client, { dealId: 'deal-two', amountDue: '500.00', currency: 'EUR', issuedOn: '2026-10-01', dueOn: '2026-10-31' });
    await putFinance(client, { dealId: 'deal-amb-1', amountDue: '300.00', currency: 'EUR', issuedOn: '2026-10-01', dueOn: '2026-10-31' });
    await putFinance(client, { dealId: 'deal-amb-2', amountDue: '300.00', currency: 'EUR', issuedOn: '2026-10-01', dueOn: '2026-10-31' });
    await putFinance(client, { dealId: 'deal-unpaid', invoiceNumber: '202610/77', amountDue: '750.00', currency: 'EUR', issuedOn: '2026-09-20', dueOn: '2026-10-15' });
    await call('POST', '/api/reconcile/aliases', { alias: 'OMANE', sponsor: 'Organization Two' });

    const ledgerRow = (await putBookkeepingItem(client, 'bookkeeping', {
      transactionDate: '2026-10-07', counterparty: 'Mystery GmbH', description: 'Mystery income',
      amount: '250.00', currency: 'EUR', entryType: 'income', sourceType: 'manual',
    })).item;

    const statement = await call('POST', '/api/reconcile/statements', {
      account: 'revolut', period: '2026-10', documentId: 'report-doc-1',
      rows: [
        row({ date: '2026-10-05', amount: '1000.00', counterparty: 'Organization One OÜ', reference: '20261012' }),
        row({ date: '2026-10-06', amount: '500.00', counterparty: 'OMANE' }),
        row({ date: '2026-10-07', amount: '250.00', counterparty: 'Mystery GmbH' }),
        row({ date: '2026-10-08', amount: '300.00', counterparty: 'Ambiguous payer' }),
        row({ date: '2026-10-09', amount: '-50.00', counterparty: 'CloudServices GmbH' }),
      ],
    });
    assert.equal(statement.statusCode, 201);

    const report = JSON.parse((await invoke('GET', '/api/reconcile/report', undefined, AUTH, { period: '2026-10' })).body);
    assert.equal(report.period, '2026-10');
    assert.equal(report.totals.incomingCount, 4, JSON.stringify(report));

    const exact = report.matched.find((item: { strategy: string }) => item.strategy === 'invoice-number');
    assert.ok(exact, 'reference invoice-number match expected');
    assert.equal(exact.dealId, 'deal-one');
    assert.equal(exact.confidence, 'exact');
    assert.equal(exact.invoiceNumber, '202610/12');

    const aliasMatch = report.matched.find((item: { strategy: string }) => item.strategy === 'alias');
    assert.ok(aliasMatch, 'alias match expected');
    assert.equal(aliasMatch.dealId, 'deal-two');
    assert.equal(aliasMatch.confidence, 'strong');

    const mystery = report.unmatchedIncoming[0];
    assert.ok(mystery, 'unmatched incoming row expected');
    assert.equal(mystery.row.counterparty, 'Mystery GmbH');
    assert.equal(mystery.transactionId, ledgerRow.id);
    assert.equal(mystery.transactionClaimedBy, undefined);

    assert.equal(report.ambiguous.length, 1);
    assert.equal(report.ambiguous[0].candidates.length, 2);

    const unpaid = report.missingPayments.find((item: { dealId: string }) => item.dealId === 'deal-unpaid');
    assert.ok(unpaid, 'unpaid invoice expected in missingPayments');
    assert.equal(unpaid.invoiceNumber, '202610/77');
    assert.ok(report.missingPayments.every((item: { dealId: string }) => item.dealId !== 'deal-one'));

    assert.equal(report.statements.length, 1);
    assert.equal(report.statements[0].incomingCount, 4);
    const revolut = report.coverage.accounts.find((account: { accountId: string }) => account.accountId === 'revolut');
    assert.deepEqual(revolut.gaps, [
      { from: '2026-10-01', to: '2026-10-04' },
      { from: '2026-10-10', to: '2026-10-31' },
    ]);
    assert.equal(revolut.coveredDays, 5);
  });

  it('counts rows of overlapping statements once and keeps the latest wallet balance', async () => {
    const year = await call('POST', '/api/reconcile/statements', {
      account: 'finom', period: '2026-11', documentId: 'finom-year',
      rows: [
        row({ date: '2026-11-02', amount: '-40.00', counterparty: 'Example Bank' }),
        row({ date: '2026-11-03', amount: '900.00', counterparty: 'Sponsor Nine', bankId: 'tx-9' }),
        row({ date: '2026-11-03', amount: '-5.00', counterparty: 'Coffee' }),
        row({ date: '2026-11-03', amount: '-5.00', counterparty: 'Coffee' }),
      ],
      balances: [{ currency: 'EUR', amount: '2000.00', asOf: '2026-11-03' }],
    });
    assert.equal(year.statusCode, 201, year.body);
    const month = await call('POST', '/api/reconcile/statements', {
      account: 'finom', period: '2026-11', documentId: 'finom-month',
      rows: [
        row({ date: '2026-11-02', amount: '-40.00', counterparty: 'EXAMPLE BANK' }),
        row({ date: '2026-11-03', amount: '900.00', counterparty: 'Sponsor Nine (renamed)', bankId: 'tx-9' }),
        row({ date: '2026-11-03', amount: '-5.00', counterparty: 'Coffee' }),
        row({ date: '2026-11-03', amount: '-5.00', counterparty: 'Coffee' }),
        row({ date: '2026-11-03', amount: '-5.00', counterparty: 'Coffee' }),
        row({ date: '2026-11-04', amount: '300.00', counterparty: 'Sponsor Ten' }),
      ],
      balances: [{ currency: 'EUR', amount: '2295.00', asOf: '2026-11-04' }],
    });
    assert.equal(month.statusCode, 201, month.body);
    // Re-uploading the same document rewrites its statement instead of adding one.
    const again = await call('POST', '/api/reconcile/statements', {
      account: 'finom', period: '2026-11', documentId: 'finom-month', rows: JSON.parse(month.body).statement.rows,
      balances: [{ currency: 'EUR', amount: '2295.00', asOf: '2026-11-04' }],
    });
    assert.equal(JSON.parse(again.body).statement.id, JSON.parse(month.body).statement.id);

    const report = JSON.parse((await invoke('GET', '/api/reconcile/report', undefined, AUTH, { period: '2026-11' })).body);
    const finom = report.statements.filter((statement: { accountId: string }) => statement.accountId === 'finom');
    assert.equal(finom.length, 2);
    const yearSummary = finom.find((statement: { documentId: string }) => statement.documentId === 'finom-year');
    const monthSummary = finom.find((statement: { documentId: string }) => statement.documentId === 'finom-month');
    assert.equal(yearSummary.rowCount, 4);
    assert.equal(yearSummary.duplicateCount, undefined);
    assert.equal(monthSummary.rowCount, 2, 'the third coffee and Sponsor Ten are new');
    assert.equal(monthSummary.duplicateCount, 4);
    assert.equal(report.totals.incomingCount, 2, JSON.stringify(report.totals));

    const balances = JSON.parse((await invoke('GET', '/api/reconcile/balances', undefined, AUTH, { account: 'finom' })).body);
    assert.deepEqual(balances.items.map((item: Record<string, string>) => [item.accountId, item.currency, item.amount, item.asOf]), [
      ['finom', 'EUR', '2295.00', '2026-11-04'],
    ]);
    const badBalance = await call('POST', '/api/reconcile/statements', {
      account: 'finom', period: '2026-11', documentId: 'finom-bad', rows: [row()],
      balances: [{ currency: 'EUR', amount: 'lots', asOf: '2026-11-04' }],
    });
    assert.equal(badBalance.statusCode, 400);
    assert.match(JSON.parse(badBalance.body).error, /balance 0 amount/);
  });

  it('runs a month end to end: missing sides block close, a per-row proof fixes the Google receipt, exceptions need the approver', async () => {
    const operator = as(OPERATOR), approver = as(APPROVER);
    const proofDoc = (await putBookkeepingItem(client, 'document', {
      documentType: 'receipt', status: 'active', contentType: 'application/pdf', originalFilename: 'google-payment.pdf', byteSize: 10, sha256: 'c'.repeat(64), s3Key: 'documents/google-proof',
    })).item;
    const invoiceDoc = (await putBookkeepingItem(client, 'document', {
      documentType: 'receipt', status: 'active', contentType: 'application/pdf', originalFilename: 'cloud-invoice.pdf', byteSize: 10, sha256: 'd'.repeat(64), s3Key: 'documents/cloud-invoice',
    })).item;
    const google = (await putBookkeepingItem(client, 'bookkeeping', {
      transactionDate: '2026-12-14', paidDate: '2026-12-14', counterparty: 'Google', description: 'Google One', amount: '1.99', currency: 'EUR', entryType: 'expense', sourceType: 'manual',
    })).item;
    const googleReceipt = (await putBookkeepingItem(client, 'document', {
      documentType: 'receipt', status: 'active', contentType: 'application/pdf', originalFilename: 'google-receipt.pdf', byteSize: 10, sha256: 'e'.repeat(64), s3Key: 'documents/google-receipt',
    })).item;
    await createDocumentLink(client, { documentId: googleReceipt.id, transactionId: google.id, coverageType: 'evidence' });
    const cloud = (await putBookkeepingItem(client, 'bookkeeping', {
      transactionDate: '2026-12-03', paidDate: '2026-12-03', counterparty: 'Example Cloud', description: 'Hosting', amount: '48.60', currency: 'EUR', entryType: 'expense', sourceType: 'spreadsheet',
    })).item;
    const saved = await operator('POST', '/api/reconcile/statements', {
      account: 'finom', period: '2026-12', documentId: 'finom-december',
      rows: [
        row({ date: '2026-12-04', amount: '-48.60', counterparty: 'Example Cloud' }),
        row({ date: '2026-12-10', amount: '-15.00', counterparty: 'Finom account fee' }),
        row({ date: '2026-12-15', amount: '-3296.00', counterparty: 'Finanzamt Example' }),
        row({ date: '2026-12-20', amount: '-12.00', counterparty: 'Unbooked Shop' }),
      ],
    });
    assert.equal(saved.statusCode, 201, saved.body);

    const month = async () => JSON.parse((await operator('GET', '/api/reconcile/months/2026-12')).body);
    let view = await month();
    const status = (match: (row: Record<string, any>) => boolean) => view.rows.find(match)?.status;
    assert.equal(status((item) => item.ledger?.id === google.id), 'payment-proof-missing');
    assert.equal(status((item) => item.ledger?.id === cloud.id), 'no-invoice');
    assert.equal(status((item) => item.counterparty === 'Finom account fee'), 'matched');
    assert.equal(status((item) => item.counterparty === 'Finanzamt Example'), 'needs-review');
    assert.equal(status((item) => item.counterparty === 'Unbooked Shop'), 'no-invoice');

    const blocked = await operator('POST', '/api/reconcile/months/2026-12/close', {});
    assert.equal(blocked.statusCode, 409);
    assert.equal(JSON.parse(blocked.body).blockers.length, 4);

    // The Google receipt: a separate payment proof for that one row.
    assert.equal((await operator('POST', '/api/reconcile/months/2026-12/proof', { transactionId: google.id, documentId: proofDoc.id })).statusCode, 200);
    // The cloud invoice gets its document; the unbooked shop gets a ledger row from the bank row.
    assert.equal((await operator('POST', '/api/reconcile/months/2026-12/document', { transactionId: cloud.id, documentId: invoiceDoc.id })).statusCode, 200);
    view = await month();
    const shop = view.rows.find((item: Record<string, any>) => item.counterparty === 'Unbooked Shop');
    const created = await operator('POST', '/api/reconcile/months/2026-12/ledger', { bankKey: shop.id, category: 'Office', documentId: invoiceDoc.id });
    assert.equal(created.statusCode, 201, created.body);
    const again = await operator('POST', '/api/reconcile/months/2026-12/ledger', { bankKey: shop.id });
    assert.equal(JSON.parse(again.body).duplicate, true);
    const tax = view.rows.find((item: Record<string, any>) => item.counterparty === 'Finanzamt Example');
    assert.equal((await operator('POST', '/api/reconcile/months/2026-12/exception', { row: tax.id, kind: 'tax_debit', proof: 'GewSt Q4 schedule entry' })).statusCode, 200);
    assert.equal((await operator('POST', '/api/reconcile/months/2026-12/exception', { row: tax.id, kind: 'refund' })).statusCode, 400);

    view = await month();
    assert.equal(status((item) => item.ledger?.id === google.id), 'matched');
    assert.equal(view.rows.find((item: Record<string, any>) => item.ledger?.id === google.id).paymentProof.documentId, proofDoc.id);
    assert.equal(view.blockers, 0, JSON.stringify(view.rows.filter((item: Record<string, any>) => item.status !== 'matched')));

    const unconfirmed = await operator('POST', '/api/reconcile/months/2026-12/close', {});
    assert.equal(unconfirmed.statusCode, 409);
    assert.match(JSON.parse(unconfirmed.body).error, /approver/);
    assert.equal((await operator('POST', '/api/reconcile/months/2026-12/confirm-exceptions', {})).statusCode, 403);
    assert.equal((await approver('POST', '/api/reconcile/months/2026-12/confirm-exceptions', {})).statusCode, 200);
    const closed = await operator('POST', '/api/reconcile/months/2026-12/close', {});
    assert.equal(closed.statusCode, 200, closed.body);

    // Closed means locked.
    assert.equal((await operator('POST', '/api/reconcile/months/2026-12/exception', { row: tax.id, kind: 'bank_fee' })).statusCode, 409);
    assert.equal((await operator('POST', '/api/reconcile/statements', { account: 'finom', period: '2026-12', documentId: 'late', rows: [row({ date: '2026-12-30' })] })).statusCode, 409);
    assert.equal((await operator('POST', '/api/reconcile/months/2026-12/reopen', {})).statusCode, 400);
    const reopened = JSON.parse((await operator('POST', '/api/reconcile/months/2026-12/reopen', { reason: 'late bank fee found' })).body).month;
    assert.equal(reopened.state, 'open');
    assert.equal(reopened.exceptionConfirmation, undefined);
    assert.deepEqual(reopened.log.map((entry: { action: string }) => entry.action), ['attach-proof', 'attach-document', 'create-ledger', 'create-ledger', 'exception', 'confirm-exceptions', 'close', 'reopen']);

    const csv = await invoke('GET', '/api/reconcile/months/2026-12', undefined, AUTH, { format: 'csv' });
    assert.match(csv.body.split('\n')[0], /^date,status,counterparty/);
    const summary = JSON.parse((await invoke('GET', '/api/reconcile/months', undefined, AUTH, { from: '2026-11', to: '2026-12' })).body);
    assert.deepEqual(summary.items.map((item: { period: string }) => item.period), ['2026-11', '2026-12']);
  });
});
