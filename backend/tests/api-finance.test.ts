import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handler } from '../src/handler';
import { useTestDatabase } from './helpers/db';
import { berlinToday } from '../src/finance/service';
import { saveStatement } from '../src/reconcile/service';
import { getClient } from '../src/db/client';

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
});
