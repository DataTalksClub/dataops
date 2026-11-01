import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createTables, startLocal, stopLocal } from '../scripts/local-dynamodb';
import { getClient } from '../src/db/client';
import { createUserWithId } from '../src/db/users';
import { putBookkeepingItem } from '../src/db/bookkeeping';
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
});
