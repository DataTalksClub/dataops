import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handler } from '../src/handler';
import { useTestDatabase } from './helpers/db';
import { berlinToday, financeSummary, financeUpcoming } from '../src/finance/service';
import { listStatements, saveStatement } from '../src/reconcile/service';
import { bankRowsFrom, pairRows, unpairRows } from '../src/reconcile/monthService';
import { getClient } from '../src/db/client';
import { createDocumentLink, putBookkeepingItem } from '../src/db/bookkeeping';

const invoke = (method: string, path: string, body?: unknown, query?: Record<string, string>) =>
  handler({ httpMethod: method, path, headers: {}, body: body === undefined ? null : JSON.stringify(body), queryStringParameters: query || null }, {});
const tk = { label: 'TK health insurance', taxType: 'health-insurance', amount: '1179.36', currency: 'EUR', rule: { kind: 'monthly', day: 16 }, source: 'recurring', approximate: true };

describe('finance tax schedule and upcoming debits API', () => {
  before(async () => { await useTestDatabase(); });

  it('creates, replaces by version and refuses a stale or invalid entry', async () => {
    const created = await invoke('PUT', '/api/finance/tax-schedule/tk', tk);
    assert.equal(created.statusCode, 200);
    assert.equal(JSON.parse(created.body).version, 1);
    assert.equal((await invoke('PUT', '/api/finance/tax-schedule/tk', tk)).statusCode, 409, 'creating twice conflicts');
    const replaced = await invoke('PUT', '/api/finance/tax-schedule/tk', { ...tk, amount: '1200.00', expectedVersion: 1 });
    assert.equal(replaced.statusCode, 200);
    assert.equal(JSON.parse(replaced.body).amount, '1200.00');
    const stale = await invoke('PUT', '/api/finance/tax-schedule/tk', { ...tk, expectedVersion: 1 });
    assert.equal(stale.statusCode, 409);
    assert.equal(JSON.parse(stale.body).current.version, 2);
    const invalid = await invoke('PUT', '/api/finance/tax-schedule/tk', { ...tk, amount: 'a lot', expectedVersion: 2 });
    assert.equal(invalid.statusCode, 400);
    assert.deepEqual(JSON.parse(invalid.body).fields, ['amount']);
    const listed = JSON.parse((await invoke('GET', '/api/finance/tax-schedule')).body).items;
    assert.deepEqual(listed.map((e: { id: string; amount: string }) => [e.id, e.amount]), [['tk', '1200.00']]);
  });

  it('lists upcoming debits from the stored schedule and validates days', async () => {
    const response = await invoke('GET', '/api/finance/upcoming', undefined, { days: '45' });
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.today, berlinToday());
    assert.equal(body.days, 45);
    assert.ok(body.debits.length >= 1);
    assert.ok(body.debits.every((d: { scheduleId: string; amount: number }) => d.scheduleId === 'tk' && d.amount === 1200));
    assert.equal(body.balance, null);
    assert.equal((await invoke('GET', '/api/finance/upcoming', undefined, { days: '0' })).statusCode, 400);
    assert.equal((await invoke('POST', '/api/finance/upcoming')).statusCode, 405);
  });

  it('checks cover against the latest Finom EUR balance and marks a debit the statement shows as paid', async () => {
    const today = berlinToday();
    const client = await getClient();
    assert.equal((await invoke('PUT', '/api/finance/tax-schedule/vat-once', { label: 'VAT one-off', taxType: 'vat', amount: '777.77', currency: 'EUR', rule: { kind: 'once', date: today }, source: 'USt-VA' })).statusCode, 200);
    await saveStatement(client, {
      accountId: 'finom', period: today.slice(0, 7), filename: 'synthetic-finom.csv',
      rows: [{ date: today, amount: '-777.77', currency: 'EUR', counterparty: 'Finanzamt' }],
      balances: [{ currency: 'EUR', amount: '100.00', asOf: today }],
    });
    const body = JSON.parse((await invoke('GET', '/api/finance/upcoming', undefined, { days: '60' })).body);
    assert.deepEqual({ ...body.balance, source: undefined }, { accountId: 'finom', amount: 100, currency: 'EUR', asOf: today, source: undefined, stale: false, ageDays: 0 });
    const vat = body.debits.find((d: { scheduleId: string }) => d.scheduleId === 'vat-once');
    assert.equal(vat.status, 'paid');
    assert.equal(vat.matched.kind, 'statement');
    assert.ok(body.dueNext30 >= 1200, 'the monthly 1,200 entry falls within 30 days');
    assert.equal(body.shortfall, true);
  });

  it('uses reconciliation ambiguity and manual choices for mandatory bank payments', async () => {
    const client = await getClient();
    await saveStatement(client, {
      accountId: 'finom', period: '2024-02', filename: 'synthetic-finance-statement.csv',
      rows: [{ date: '2024-02-16', amount: '-321.98', currency: 'EUR',
        counterparty: 'Techniker Krankenkasse', reference: 'synthetic contribution' }],
    });
    for (const [id, counterparty] of [['synthetic-candidate-one', 'Alpha vendor'], ['synthetic-candidate-two', 'Beta vendor']]) {
      await putBookkeepingItem(client, 'bookkeeping', {
        id, transactionDate: '2024-02-16', paidDate: '2024-02-16',
        entryType: 'expense', amount: '321.98', currency: 'EUR', sourceType: 'manual',
        counterparty, description: '', category: 'Tools',
      });
    }
    const bank = bankRowsFrom(await listStatements(client)).find((item) => item.date === '2024-02-16')!;
    assert.equal((await invoke('PUT', '/api/finance/tax-schedule/synthetic-tk', {
      label: 'Synthetic TK', taxType: 'health-insurance', amount: '321.98', currency: 'EUR',
      rule: { kind: 'once', date: '2024-02-16' }, source: 'recurring',
    })).statusCode, 200);
    const upcoming = () => financeUpcoming(client, 14, '2024-02-16', async () => null);
    assert.equal((await upcoming()).debits.find((item) => item.scheduleId === 'synthetic-tk')?.matched?.kind, 'statement');
    const initial = await financeSummary(client, { month: '2024-02' }, '2024-03-01');
    assert.ok(initial.entries.some((entry) => entry.bankKey === bank.key),
      'an ambiguous bank payment remains visible');
    await pairRows(client, '2024-02', 'synthetic-operator', bank.key, 'synthetic-candidate-one');
    const paired = await financeSummary(client, { month: '2024-02' }, '2024-03-01');
    assert.ok(!paired.entries.some((entry) => entry.bankKey === bank.key),
      'a manual reconciliation pair explains the bank payment');
    assert.equal(paired.entries.find((entry) => entry.id === 'synthetic-candidate-one')?.line, 'health-insurance',
      'the matched bank counterparty classifies the payment');
    assert.equal((await upcoming()).debits.find((item) => item.scheduleId === 'synthetic-tk')?.matched?.kind, 'ledger');
    await unpairRows(client, '2024-02', 'synthetic-operator', bank.key, 'synthetic-candidate-one');
    await unpairRows(client, '2024-02', 'synthetic-operator', bank.key, 'synthetic-candidate-two');
    const rejected = await financeSummary(client, { month: '2024-02' }, '2024-03-01');
    assert.ok(rejected.entries.some((entry) => entry.bankKey === bank.key),
      'manual rejections keep the bank payment visible');
    assert.equal((await upcoming()).debits.find((item) => item.scheduleId === 'synthetic-tk')?.matched?.kind, 'statement');
  });

  it('does not treat an expense-encoded refund as a paid scheduled debit', async () => {
    const client = await getClient();
    assert.equal((await invoke('PUT', '/api/finance/tax-schedule/synthetic-refund-test', {
      label: 'Synthetic tax debit', taxType: 'vat', amount: '456.78', currency: 'EUR',
      rule: { kind: 'once', date: '2024-03-15' }, source: 'USt-VA',
    })).statusCode, 200);
    await putBookkeepingItem(client, 'bookkeeping', {
      id: 'synthetic-tax-refund', transactionDate: '2024-03-15', paidDate: '2024-03-15',
      entryType: 'expense', subtype: 'Refund', amount: '456.78', currency: 'EUR',
      counterparty: 'Synthetic authority', category: 'VAT', sourceType: 'manual',
    });
    const upcoming = await financeUpcoming(client, 14, '2024-03-15', async () => null);
    assert.equal(upcoming.debits.find((item) => item.scheduleId === 'synthetic-refund-test')?.status, 'scheduled');
  });

  it('uses paired EUR bank evidence and never treats unconverted foreign amounts as EUR', async () => {
    const client = await getClient();
    for (const [id, amount] of [['synthetic-fx-paired', '150.00'], ['synthetic-fx-unpaired', '200.00']]) {
      assert.equal((await invoke('PUT', `/api/finance/tax-schedule/${id}`, {
        label: id, taxType: 'vat', amount, currency: 'EUR',
        rule: { kind: 'once', date: '2023-04-17' }, source: 'USt-VA',
      })).statusCode, 200);
    }
    await saveStatement(client, {
      accountId: 'finom', period: '2023-04', filename: 'synthetic-fx-statement.csv',
      rows: [{ date: '2023-04-17', amount: '-150.00', currency: 'EUR',
        counterparty: 'Finanzamt', reference: 'synthetic VAT' }],
    });
    for (const [id, amount] of [['synthetic-fx-ledger-paired', '170.00'], ['synthetic-fx-ledger-unpaired', '200.00']]) {
      await putBookkeepingItem(client, 'bookkeeping', {
        id, transactionDate: '2023-04-17', paidDate: '2023-04-17',
        entryType: 'expense', amount, currency: 'USD', sourceType: 'manual',
        counterparty: 'Synthetic authority', category: 'VAT',
      });
    }
    const bank = bankRowsFrom(await listStatements(client)).find((item) => item.date === '2023-04-17')!;
    await pairRows(client, '2023-04', 'synthetic-operator', bank.key, 'synthetic-fx-ledger-paired');
    const result = await financeUpcoming(client, 14, '2023-04-17', async () => null);
    assert.equal(result.debits.find((item) => item.scheduleId === 'synthetic-fx-paired')?.status, 'paid');
    assert.equal(result.debits.find((item) => item.scheduleId === 'synthetic-fx-unpaired')?.status, 'scheduled');
  });

  it('derives row VAT from the linked stored invoice facts', async () => {
    const client = await getClient();
    const transaction = (await putBookkeepingItem(client, 'bookkeeping', {
      id: 'synthetic-scalevector-vat-row', transactionDate: '2026-09-04', paidDate: '2026-09-04',
      entryType: 'income', amount: '5950.00', currency: 'EUR', sourceType: 'spreadsheet',
      counterparty: 'Synthetic ScaleVector GmbH', description: 'Synthetic workshop', category: 'Sponsorship',
    })).item;
    const document = (await putBookkeepingItem(client, 'document', {
      id: 'synthetic-scalevector-invoice', documentType: 'invoice', status: 'active',
      facts: { netAmount: '5000.00', vatAmount: '950.00', vatCurrency: 'EUR', vatRate: '19', amount: '5950.00', currency: 'EUR', reverseCharge: false },
    })).item;
    await createDocumentLink(client, { documentId: document.id, transactionId: transaction.id, coverageType: 'evidence' });

    const response = await invoke('GET', '/api/finance/summary', undefined, { month: '2026-09' });
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    const row = body.entries.find((entry: { id: string }) => entry.id === transaction.id);
    assert.equal(row.vatAmount, '950.00');
    assert.equal(row.vatCurrency, 'EUR');
    assert.equal(row.vatRate, '19');
    assert.equal(body.totals.outputVat, 950);
    assert.equal(body.totals.projectedVat, 950);
  });
});
