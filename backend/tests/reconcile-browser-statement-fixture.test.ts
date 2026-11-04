import assert from 'node:assert/strict';
import { it } from 'node:test';
import { recognizeStatement } from '../src/reconcile/statementIntake';

const { syntheticStatementPdf } = require('../e2e/helpers/bookkeeping-statement');

for (const [bank, opening, closing, amount, wallet] of [
  ['finom', '100.00', '81.50', '-18.50', 'main'],
  ['revolut', '200.00', '173.00', '-27.00', 'EUR'],
]) {
  it(`recognizes the browser journey's actual synthetic ${bank} PDF bytes`, async () => {
    const result = await recognizeStatement(await syntheticStatementPdf(bank), 'application/pdf');
    assert.equal(result.account, bank);
    assert.equal(result.parsed.issueDate, '2026-09-04');
    assert.deepEqual(result.parsed.period, { from: '2026-08-01', to: '2026-08-31' });
    assert.equal(result.parsed.openingBalances?.[0].amount, opening);
    assert.equal(result.parsed.balances[0].amount, closing);
    assert.equal(result.parsed.rows.length, 1);
    assert.equal(result.parsed.rows[0].amount, amount);
    assert.match(result.parsed.bankAccounts![`${wallet}|EUR`], /^[a-f0-9]{24}$/);
  });
}
