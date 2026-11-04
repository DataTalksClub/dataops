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
import { defaultStatementSelection } from '../src/reconcile/statementSelection';
import { listStatementHistory, saveStatement } from '../src/reconcile/service';
import { assertMonthOpen, mutateMonth } from '../src/reconcile/monthService';
import { setStatementPdfTextForTests, statementPeriodForMonth } from '../src/reconcile/statementIntake';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const invoke = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}, query?: Record<string, string>) =>
  handler({ httpMethod: method, path, headers, body: body === undefined ? null : JSON.stringify(body), queryStringParameters: query || null }, {});

let client: DynamoDBDocumentClient;
const call = (method: string, path: string, body?: unknown) => handleReconcileRoutes(path, method, { httpMethod: method, path, headers: { 'x-user-id': OPERATOR }, body: body === undefined ? null : JSON.stringify(body), queryStringParameters: null }, client);

async function seedStatement(body: Record<string, any>) {
  try {
    await assertMonthOpen(client, body.period);
    const statement = await saveStatement(client, { ...body, accountId: body.account } as never);
    const records = (await listStatementHistory(client)).filter((record) => record.period === body.period);
    await mutateMonth(client, body.period, 'test-fixture', 'import-statement', {}, (month) => { month.statementSelection = defaultStatementSelection(records); });
    return { statusCode: 201, body: JSON.stringify({ statement }) };
  } catch (error) { return { statusCode: (error as { statusCode?: number }).statusCode || 400, body: JSON.stringify({ error: (error as Error).message }) }; }
}

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

  it('refuses the unvalidated caller-row statement endpoint', async () => {
    const response = await call('POST', '/api/reconcile/statements', { account: 'finom', period: '2028-03', rows: [row()] });
    assert.equal(response.statusCode, 404);
  });

  it('preserves PDF header coverage through import and idempotent re-upload', async () => {
    assert.deepEqual(statementPeriodForMonth('2026-10', { from: '2026-09-15', to: '2026-11-02' }), { from: '2026-10-01', to: '2026-10-31' });
    assert.deepEqual(statementPeriodForMonth('2026-09', { from: '2026-09-15', to: '2026-11-02' }), { from: '2026-09-15', to: '2026-09-30' });
    assert.deepEqual(statementPeriodForMonth('2026-11', { from: '2026-09-15', to: '2026-11-02' }), { from: '2026-11-01', to: '2026-11-02' });
    process.env.BOOKKEEPING_DOCUMENTS_BUCKET = 'synthetic-private-bucket';
    const objectBytes = Buffer.from('%PDF-1.4 synthetic statement');
    setBookkeepingStorageForTests({
      send: async (command: { constructor: { name: string } }) => command.constructor.name === 'GetObjectCommand'
        ? { Body: Readable.from(objectBytes), VersionId: 'synthetic' }
        : {},
    } as never);
    setStatementPdfTextForTests(async () => [
      'FINOM PAYMENTS B.V.',
      'Finom   STATEMENT OF ACCOUNT',
      'Issue date: 05.11.2026',
      'IBAN: EX00 0000 0000',
      'From: 01.10.2026',
      'To: 31.10.2026',
      'Opening balance: 100,00 €',
      'Closing balance: 90,00 €',
      'Completed   Description   Pay in/out',
      '30.10.2026   Synthetic payment',
      '- 10,00 €',
    ].join('\n'));
    let statementId: string | undefined;
    try {
      const document = (await putBookkeepingItem(client, 'document', {
        documentType: 'bank-statement', status: 'active', contentType: 'application/pdf',
        originalFilename: 'synthetic-finom-october.pdf', byteSize: objectBytes.length, sha256: 'a'.repeat(64), s3Key: 'documents/synthetic-finom-october',
      })).item;
      const importPdf = () => call('POST', '/api/reconcile/statements/import', { documentId: document.id, notify: false });
      const beforeWrongMonth = JSON.parse((await call('GET', '/api/reconcile/statements')).body).items;
      const wrongMonth = await call('POST', '/api/reconcile/statements/import', {
        documentId: document.id, period: '2026-09', preview: true, notify: false,
      });
      assert.equal(wrongMonth.statusCode, 400, wrongMonth.body);
      assert.match(JSON.parse(wrongMonth.body).error, /do not cover the selected month/);
      assert.deepEqual(JSON.parse((await call('GET', '/api/reconcile/statements')).body).items, beforeWrongMonth);
      const first = await importPdf();
      assert.equal(first.statusCode, 201, first.body);
      const firstBody = JSON.parse(first.body);
      statementId = firstBody.statements[0].id;
      assert.deepEqual(firstBody.statements.map((statement: Record<string, unknown>) => [statement.from, statement.to]), [['2026-10-01', '2026-10-31']]);

      const replay = await importPdf();
      assert.equal(replay.statusCode, 200, replay.body);
      assert.equal(JSON.parse(replay.body).committed, false);
      assert.equal(JSON.parse(replay.body).preview.requiresConfirmation, true);
      const saved = JSON.parse((await call('GET', '/api/reconcile/statements')).body).items
        .filter((statement: Record<string, unknown>) => statement.documentId === document.id);
      assert.equal(saved.length, 1);
      assert.deepEqual([saved[0].from, saved[0].to], ['2026-10-01', '2026-10-31']);
      assert.equal(saved[0].rowCount, 1);

      const report = JSON.parse((await invoke('GET', '/api/reconcile/report', undefined, AUTH, { period: '2026-10' })).body);
      const finom = report.coverage.accounts.find((account: Record<string, unknown>) => account.accountId === 'finom');
      assert.equal(finom.coveredDays, 31);
      assert.deepEqual(finom.gaps, []);
      const month = JSON.parse((await invoke('GET', '/api/reconcile/months/2026-10', undefined, AUTH)).body);
      assert.equal(month.state, 'open');
    } finally {
      if (statementId) await call('DELETE', `/api/reconcile/statements/${statementId}`);
      setStatementPdfTextForTests();
      delete process.env.BOOKKEEPING_DOCUMENTS_BUCKET;
    }
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

  it('imports a Finom CSV statement with an explicit account, replays idempotently and keeps CSV-backed stored rows readable', async () => {
    process.env.BOOKKEEPING_DOCUMENTS_BUCKET = 'synthetic-private-bucket';
    // The shared fixture shifted to a synthetic year so this test stays isolated from the 2026-10 months.
    const csvBytes = Buffer.from(readFileSync(join(__dirname, 'fixtures', 'reconcile', 'finom-main.csv'), 'utf8').replaceAll('2026', '2029'));
    let objectBytes = csvBytes;
    setBookkeepingStorageForTests({
      send: async (command: { constructor: { name: string } }) => {
        if (command.constructor.name === 'GetObjectCommand') return { Body: Readable.from(objectBytes), VersionId: 'synthetic' };
        return {};
      },
    } as never);
    const statementIds: string[] = [];
    try {
      const document = (await putBookkeepingItem(client, 'document', {
        documentType: 'bank-statement', status: 'active', contentType: 'text/csv', accountId: 'auto', statementMonth: '2029-10',
        originalFilename: 'finom_2029-10_main.csv', byteSize: csvBytes.length, sha256: '1'.repeat(64), s3Key: 'documents/finom-csv',
      })).item;

      // A CSV prints no IBAN: without an explicit account the source stays at review and nothing is written.
      const review = await call('POST', '/api/reconcile/statements/import', { documentId: document.id, notify: false });
      assert.equal(review.statusCode, 422, review.body);
      assert.match(JSON.parse(review.body).error, /stable bank account identifier/);
      const beforeReview = JSON.parse((await call('GET', '/api/reconcile/statements')).body).items;
      assert.ok(!beforeReview.some((statement: Record<string, unknown>) => statement.documentId === document.id));

      // Parse is read-only: the Finom layout is recognized from the header row alone.
      const parsed = await call('POST', '/api/reconcile/statements/parse', { account: 'finom', documentId: document.id });
      assert.equal(parsed.statusCode, 200, parsed.body);
      assert.equal(JSON.parse(parsed.body).rowCount, 7);
      assert.deepEqual(JSON.parse(parsed.body).balances, [{ currency: 'EUR', amount: '3210.55', asOf: '2029-10-31' }]);
      const mismatched = await call('POST', '/api/reconcile/statements/parse', { account: 'revolut', documentId: document.id });
      assert.equal(mismatched.statusCode, 422, mismatched.body);
      assert.match(JSON.parse(mismatched.body).error, /CSV contains a finom statement, not the selected revolut account/);

      // Naming the account stands in for the missing header identity; the rows become finom bank rows.
      const first = await call('POST', '/api/reconcile/statements/import', { documentId: document.id, account: 'finom', notify: false });
      assert.equal(first.statusCode, 201, first.body);
      const firstBody = JSON.parse(first.body);
      assert.equal(firstBody.account, 'finom');
      assert.match(firstBody.layout, /Finom statement/);
      assert.equal(firstBody.rowCount, 7);
      assert.deepEqual(firstBody.balances, [{ currency: 'EUR', amount: '3210.55', asOf: '2029-10-31' }]);
      assert.deepEqual(firstBody.statements.map((statement: Record<string, unknown>) => statement.period), ['2029-10']);
      statementIds.push(firstBody.statements[0].id);

      // Re-uploading the same file replays to the same statement id: identical preview, no change until --replace.
      const replay = async (options: Record<string, unknown>) => call('POST', '/api/reconcile/statements/import', { documentId: document.id, account: 'finom', notify: false, ...options });
      const preview = await replay({});
      assert.equal(preview.statusCode, 200, preview.body);
      assert.equal(JSON.parse(preview.body).committed, false);
      assert.equal(JSON.parse(preview.body).preview.requiresConfirmation, true);
      assert.match(JSON.parse(preview.body).preview.message, /No differences/);
      let listed = JSON.parse((await call('GET', '/api/reconcile/statements')).body).items
        .filter((statement: Record<string, unknown>) => statement.documentId === document.id);
      assert.equal(listed.length, 1);
      assert.equal(listed[0].rowCount, 7);
      const replaced = await replay({ replace: true, previewDigest: JSON.parse(preview.body).preview.digest });
      assert.equal(replaced.statusCode, 201, replaced.body);
      assert.equal(JSON.parse(replaced.body).committed, true);
      assert.deepEqual(JSON.parse(replaced.body).statements.map((statement: Record<string, unknown>) => statement.id), statementIds.slice(-1));

      const balances = JSON.parse((await invoke('GET', '/api/reconcile/balances', undefined, AUTH, { account: 'finom' })).body);
      assert.ok(balances.items.some((item: Record<string, unknown>) => item.amount === '3210.55' && item.asOf === '2029-10-31'));

      // Overlapping rows from a second export are counted once: date+amount+counterparty identity, earliest upload wins.
      const overlap = [
        'Completed date,Counterparty name,Reference,Amount,Balance',
        '05.10.2029 08:00:00,Sponsor Three Ltd,202910/03,1 000.00,3 000.00',
        '06.10.2029 09:00:00,Sponsor Four GmbH,202910/04,500.00,3 500.00',
      ].join('\n');
      objectBytes = Buffer.from(overlap);
      const second = (await putBookkeepingItem(client, 'document', {
        documentType: 'bank-statement', status: 'active', contentType: 'text/csv', accountId: 'auto', statementMonth: '2029-10',
        originalFilename: 'finom_2029-10_extra.csv', byteSize: objectBytes.length, sha256: '2'.repeat(64), s3Key: 'documents/finom-csv-2',
      })).item;
      const secondImport = await call('POST', '/api/reconcile/statements/import', { documentId: second.id, account: 'finom', notify: false });
      assert.equal(secondImport.statusCode, 201, secondImport.body);
      statementIds.push(JSON.parse(secondImport.body).statements[0].id);
      const month = JSON.parse((await invoke('GET', '/api/reconcile/months/2029-10', undefined, AUTH)).body);
      assert.equal(month.rows.filter((row: Record<string, unknown>) => row.counterparty === 'Sponsor Three Ltd').length, 1);
      assert.equal(month.rows.filter((row: Record<string, unknown>) => row.counterparty === 'Sponsor Four GmbH').length, 1);

      // A generic CSV matches no bank layout and is refused before anything is stored.
      objectBytes = Buffer.from('Date,Description,Amount\n2029-10-02,Transfer,1000.00\n');
      const unknown = (await putBookkeepingItem(client, 'document', {
        documentType: 'bank-statement', status: 'active', contentType: 'text/csv', accountId: 'auto', statementMonth: '2029-10',
        originalFilename: 'notes.csv', byteSize: objectBytes.length, sha256: '3'.repeat(64), s3Key: 'documents/notes-csv',
      })).item;
      const refused = await call('POST', '/api/reconcile/statements/import', { documentId: unknown.id, account: 'finom', notify: false });
      assert.equal(refused.statusCode, 422, refused.body);
      assert.match(JSON.parse(refused.body).error, /notes\.csv/);
      assert.match(JSON.parse(refused.body).error, /CSV is not a recognized/);
      const afterRefusal = JSON.parse((await call('GET', '/api/reconcile/statements')).body).items;
      assert.ok(!afterRefusal.some((statement: Record<string, unknown>) => statement.documentId === unknown.id));

      // Legacy CSV-backed statements stay readable without byte re-verification.
      const legacy = await seedStatement({
        account: 'revolut', period: '2030-01', documentId: 'legacy-csv-statement', filename: 'older-export.csv', contentType: 'text/csv', rows: [row({ date: '2030-01-02', amount: '20.00' })],
      });
      assert.equal(legacy.statusCode, 201, legacy.body);
      const retained = JSON.parse((await call('GET', '/api/reconcile/statements')).body).items
        .find((statement: Record<string, unknown>) => statement.documentId === 'legacy-csv-statement');
      assert.equal(retained.rowCount, 1);
      assert.equal(retained.incomingCount, 1);
    } finally {
      for (const id of statementIds) await call('DELETE', `/api/reconcile/statements/${id}`);
      delete process.env.BOOKKEEPING_DOCUMENTS_BUCKET;
    }
  });

  it('rejects malformed Finom/Revolut rows, invalid dates, zero-row PDFs and balance mismatches atomically', async () => {
    process.env.BOOKKEEPING_DOCUMENTS_BUCKET = 'synthetic-private-bucket';
    const objectBytes = Buffer.from('%PDF-1.4 synthetic statement');
    setBookkeepingStorageForTests({
      send: async (command: { constructor: { name: string } }) => command.constructor.name === 'GetObjectCommand'
        ? { Body: Readable.from(objectBytes), VersionId: 'synthetic' }
        : {},
    } as never);
    const base = [
      'FINOM PAYMENTS B.V.',
      'Finom   STATEMENT',
      'Issue date: 05.11.2026',
      'IBAN: EX00 0000 0000',
      'From: 01.10.2026',
      'To: 31.10.2026',
      'Opening balance: 0,00 €',
      'Closing balance: 0,00 €',
      'Completed   Description   Pay in/out',
    ];
    const documents = [
      {
        filename: 'finom-bad-row.pdf',
        text: [...base, '02.10.2026   Unfinished transfer'].join('\n'),
        line: /line 10/,
        source: /Unfinished transfer/,
      },
      {
        filename: 'finom-empty.pdf',
        text: base.join('\n'),
        line: /line 9/,
        source: /Completed\s+Description\s+Pay in\/out/,
      },
      {
        filename: 'finom-balance-mismatch.pdf',
        text: [...base, '02.10.2026   Customer', '1,00 ' + String.fromCharCode(0x20ac)].join('\n'),
        line: /line 8/,
        source: /Closing balance: 0,00 €/,
        failure: /does not reconcile/,
      },
      {
        filename: 'finom-invalid-date.pdf',
        text: [...base.map((line) => line.startsWith('Closing balance:') ? line.replace('0,00', '2,00') : line), '02.10.2026   First customer', '1,00 ' + String.fromCharCode(0x20ac), '99.10.2026   Bad date customer', '1,00 ' + String.fromCharCode(0x20ac)].join('\n'),
        line: /line 12/,
        source: /99\.10\.2026\s+Bad date customer/,
        failure: /date out of range/i,
      },
      {
        filename: 'revolut-unparsed-row.pdf',
        text: [
          '© 2026 Revolut Bank UAB 1/1',
          'Account name   Euro',
          'Currency   EUR',
          'Type   Local',
          'Balance summary',
          'Opening balance   €0.00',
          'Money in   €0.00',
          'Money out   - €0.00',
          'Closing balance   €0.00',
          'Transactions from 1 October 2026 to 31 October 2026',
          'Date (UTC)   Description   Money out   Money in   Balance',
          '2 Oct 2026   XYZ   Unknown transaction   €1.00   €0.00',
          'Transaction types',
          '© 2026 Revolut Bank UAB 1/1',
        ].join('\n'),
        line: /line 12/,
        source: /2 Oct 2026\s+XYZ/,
        failure: /unknown transaction type "XYZ"/,
      },
    ];
    try {
      for (const [index, fixture] of documents.entries()) {
        setStatementPdfTextForTests(async () => fixture.text);
        const document = (await putBookkeepingItem(client, 'document', {
          documentType: 'bank-statement', status: 'active', contentType: 'application/pdf',
          originalFilename: fixture.filename, byteSize: objectBytes.length, sha256: `${String(index + 3).repeat(64)}`, s3Key: `documents/${fixture.filename}`,
        })).item;
        const response = await call('POST', '/api/reconcile/statements/import', { documentId: document.id });
        assert.equal(response.statusCode, 422, response.body);
        const message = JSON.parse(response.body).error;
        assert.match(message, new RegExp(fixture.filename.replaceAll('.', '\\.')));
        assert.match(message, fixture.line);
        assert.match(message, fixture.source);
        if (fixture.failure) assert.match(message, fixture.failure);
        if (fixture.filename === 'finom-empty.pdf') assert.match(message, /zero transaction rows/i);
        const statements = JSON.parse((await call('GET', '/api/reconcile/statements')).body).items;
        assert.ok(!statements.some((statement: Record<string, unknown>) => statement.documentId === document.id));
      }
    } finally {
      setStatementPdfTextForTests();
    }
  });

  it('matches invoice references, aliases and amounts into one month-end report', async () => {
    await putBookkeepingItem(client, 'account', { id: 'business-1', displayName: 'Primary legacy account', kind: 'business', active: true }, 'report-legacy-business-1');
    await putBookkeepingItem(client, 'account', { id: 'business-2', displayName: 'Secondary legacy account', kind: 'business', active: true }, 'report-legacy-business-2');
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

    const statement = await seedStatement({
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
    assert.deepEqual(report.coverage.accountsWithoutStatement, []);
    assert.ok(!report.coverage.accounts.some((account: { accountId: string }) => ['business-1', 'business-2'].includes(account.accountId)));

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
    const year = await seedStatement({
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
    const month = await seedStatement({
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
    const again = await seedStatement({
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
    const badBalance = await seedStatement({
      account: 'finom', period: '2026-11', documentId: 'finom-bad', rows: [row()],
      balances: [{ currency: 'EUR', amount: 'lots', asOf: '2026-11-04' }],
    });
    assert.equal(badBalance.statusCode, 400);
    assert.match(JSON.parse(badBalance.body).error, /balance 0 amount/);
  });

  it('attaches a document to the ledger row already paired with a bank row', async () => {
    const operator = as(OPERATOR), period = '2027-01';
    const transaction = (await putBookkeepingItem(client, 'bookkeeping', {
      transactionDate: `${period}-12`, paidDate: `${period}-12`, counterparty: 'Paired Synthetic Vendor',
      description: 'Existing paired invoice', amount: '100.00', currency: 'EUR', entryType: 'expense', sourceType: 'manual',
    })).item;
    const receipt = (await putBookkeepingItem(client, 'document', {
      documentType: 'receipt', status: 'active', contentType: 'application/pdf', originalFilename: 'paired-receipt.pdf',
      byteSize: 10, sha256: 'f'.repeat(64), s3Key: 'documents/paired-receipt',
    })).item;
    const saved = await seedStatement({
      account: 'revolut', period, documentId: 'paired-statement',
      rows: [row({ date: `${period}-12`, amount: '-100.00', counterparty: 'Paired Synthetic Vendor', reference: 'Existing paired invoice' })],
    });
    assert.equal(saved.statusCode, 201, saved.body);
    const initial = JSON.parse((await operator('GET', `/api/reconcile/months/${period}`)).body);
    const paired = initial.rows.find((candidate: Record<string, any>) => candidate.ledger?.id === transaction.id);
    assert.ok(paired, JSON.stringify(initial.rows));

    const attached = await operator('POST', `/api/reconcile/months/${period}/ledger`, { bankKey: paired.id, documentId: receipt.id });
    assert.equal(attached.statusCode, 201, attached.body);
    const result = JSON.parse(attached.body);
    assert.equal(result.paired, true);
    assert.equal(result.duplicate, true);
    assert.equal(result.transaction.id, transaction.id);

    const final = JSON.parse((await operator('GET', `/api/reconcile/months/${period}`)).body);
    assert.equal(final.rows.length, 1);
    assert.equal(final.rows[0].ledger.id, transaction.id);
    assert.ok(final.rows[0].documents.some((document: Record<string, string>) => document.id === receipt.id));
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
    const saved = await seedStatement({
      account: 'finom', period: '2026-12', documentId: 'finom-december',
      rows: [
        row({ date: '2026-12-04', amount: '-48.60', counterparty: 'Example Cloud' }),
        row({ date: '2026-12-10', amount: '-15.00', counterparty: 'Finom account fee' }),
        row({ date: '2026-12-15', amount: '-3296.00', counterparty: 'Finanzamt Example' }),
        row({ date: '2026-12-16', amount: '43633.73', counterparty: 'Finanzamt refund' }),
        row({ date: '2026-12-20', amount: '-12.00', counterparty: 'Unbooked Shop' }),
      ],
    });
    assert.equal(saved.statusCode, 201, saved.body);

    await putBookkeepingItem(client, 'bookkeeping', {
      id: 'synthetic-booked-account-fee', transactionDate: '2026-12-10', paidDate: '2026-12-10',
      counterparty: 'Finom account fee', description: 'Synthetic booked bank fee', amount: '15.00', currency: 'EUR', entryType: 'expense', category: 'Bank fees', sourceType: 'statement',
    });
    const month = async () => JSON.parse((await operator('GET', '/api/reconcile/months/2026-12')).body);
    let view = await month();
    const status = (match: (row: Record<string, any>) => boolean) => view.rows.find(match)?.status;
    assert.equal(status((item) => item.ledger?.id === google.id), 'payment-proof-missing');
    assert.equal(status((item) => item.ledger?.id === cloud.id), 'no-invoice');
    assert.equal(status((item) => item.counterparty === 'Finom account fee'), 'matched');
    assert.equal(status((item) => item.counterparty === 'Finanzamt Example'), 'matched');
    assert.equal(view.rows.find((item: Record<string, any>) => item.counterparty === 'Finanzamt Example').tax, true);
    assert.equal(status((item) => item.counterparty === 'Finanzamt refund'), 'matched');
    assert.equal(view.rows.find((item: Record<string, any>) => item.counterparty === 'Finanzamt refund').exception.kind, 'tax_refund');
    assert.equal(view.rows.find((item: Record<string, any>) => item.counterparty === 'Finanzamt refund').tax, true);
    assert.equal(view.counters.rows, 4);
    assert.equal(view.counters.needsReview, 0);
    assert.equal(view.counters.bankWithoutInvoice, 2);
    assert.equal(status((item) => item.counterparty === 'Unbooked Shop'), 'no-invoice');

    const blocked = await operator('POST', '/api/reconcile/months/2026-12/close', {});
    assert.equal(blocked.statusCode, 409);
    assert.equal(JSON.parse(blocked.body).blockers.length, 3);

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
    const refund = view.rows.find((item: Record<string, any>) => item.counterparty === 'Finanzamt refund');
    assert.equal((await operator('POST', '/api/reconcile/months/2026-12/exception', { row: refund.id, kind: 'tax_refund' })).statusCode, 200);
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

    const pack = JSON.parse((await invoke('GET', '/api/reconcile/months/2026-12/package', undefined, AUTH)).body);
    assert.equal(pack.draft, false);
    const paths = pack.entries.map((entry: { path: string }) => entry.path);
    assert.doesNotMatch(pack.csv, /Finanzamt/);
    assert.doesNotMatch(pack.csv, /43633\.73/);
    assert.ok(paths.includes('2026-12/2026-12_reconciliation_datatalksclub.csv'), paths.join('\n'));
    assert.ok(paths.some((path: string) => /^2026-12\/statements\/2026-12_finom-main_statement\./.test(path)), paths.join('\n'));
    assert.ok(paths.includes('2026-12/expenses/2026-12-14_google_google-one_1.99EUR.pdf'), paths.join('\n'));
    assert.ok(paths.includes('2026-12/statements/2026-12-14_google_payment-proof-google-one_1.99EUR.pdf'), paths.join('\n'));
    // Taxes stay out of the accountant's package, as in every report sent so far.
    assert.ok(!paths.some((path: string) => /finanzamt/.test(path)));

    // Closed means locked.
    assert.equal((await operator('POST', '/api/reconcile/months/2026-12/exception', { row: tax.id, kind: 'bank_fee' })).statusCode, 409);
    assert.equal((await seedStatement({ account: 'finom', period: '2026-12', documentId: 'late', rows: [row({ date: '2026-12-30' })] })).statusCode, 409);
    assert.equal((await operator('POST', '/api/reconcile/months/2026-12/reopen', {})).statusCode, 400);
    const reopened = JSON.parse((await operator('POST', '/api/reconcile/months/2026-12/reopen', { reason: 'late bank fee found' })).body).month;
    assert.equal(reopened.state, 'open');
    assert.equal(reopened.exceptionConfirmation, undefined);
    assert.deepEqual(reopened.log.map((entry: { action: string }) => entry.action), ['import-statement', 'attach-proof', 'attach-document', 'create-ledger', 'exception', 'exception', 'confirm-exceptions', 'close', 'reopen']);

    const csv = await invoke('GET', '/api/reconcile/months/2026-12', undefined, AUTH, { format: 'csv' });
    assert.match(csv.body.split('\n')[0], /^date,status,counterparty/);
    const summary = JSON.parse((await invoke('GET', '/api/reconcile/months', undefined, AUTH, { from: '2026-11', to: '2026-12' })).body);
    assert.deepEqual(summary.items.map((item: { period: string }) => item.period), ['2026-11', '2026-12']);
  });

  it('keeps a Finom CSV without an account, or with the wrong account, from writing rows', async () => {
    process.env.BOOKKEEPING_DOCUMENTS_BUCKET = 'synthetic-private-bucket';
    const objectBytes = readFileSync(join(__dirname, 'fixtures', 'reconcile', 'finom-main.csv'));
    setBookkeepingStorageForTests({ send: async (command: { constructor: { name: string } }) => command.constructor.name === 'GetObjectCommand' ? { Body: Readable.from(objectBytes) } : {} } as never);
    const document = (await putBookkeepingItem(client, 'document', {
      documentType: 'bank-statement', status: 'active', contentType: 'text/csv', accountId: 'auto', statementMonth: '2026-10',
      originalFilename: 'finom_2026-10_main.csv', byteSize: objectBytes.length, sha256: 'f'.repeat(64), s3Key: 'documents/finom-auto',
    })).item;
    const accountless = await call('POST', '/api/reconcile/statements/import', { documentId: document.id });
    assert.equal(accountless.statusCode, 422, accountless.body);
    assert.match(JSON.parse(accountless.body).error, /stable bank account identifier/);
    const wrongAccount = await call('POST', '/api/reconcile/statements/import', { documentId: document.id, account: 'revolut' });
    assert.equal(wrongAccount.statusCode, 422, wrongAccount.body);
    assert.match(JSON.parse(wrongAccount.body).error, /finom_2026-10_main\.csv/);
    assert.match(JSON.parse(wrongAccount.body).error, /CSV contains a finom statement, not the selected revolut account/);
    const statements = JSON.parse((await call('GET', '/api/reconcile/statements')).body).items;
    assert.ok(!statements.some((statement: Record<string, unknown>) => statement.documentId === document.id));
  });
});
