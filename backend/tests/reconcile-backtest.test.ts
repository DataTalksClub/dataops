import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { backtestMonth, expectedSource, type TruthRow } from '../src/reconcile/backtest';
import { buildMonthTable, type BankTx, type LedgerRow } from '../src/reconcile/month';

const bank = (key: string, o: Partial<BankTx>): BankTx => ({ key, accountId: 'finom', statementId: 's', date: '2025-05-05', amount: '-10.00', currency: 'EUR', counterparty: 'X', ...o });
const ledger = (id: string, o: Partial<LedgerRow>): LedgerRow => ({ id, date: '2025-05-05', amount: '-10.00', currency: 'EUR', counterparty: 'X', documents: [{ id: `d-${id}` }], ...o });

describe('reconciliation backtest', () => {
  it('reads the report\'s Statement column', () => {
    assert.equal(expectedSource('Finom'), 'finom');
    assert.equal(expectedSource('Revolut'), 'revolut');
    assert.equal(expectedSource('revolut:dtc:2025-05'), 'revolut');
    assert.equal(expectedSource('Revolut - statement-2025-05-02-Example.pdf'), 'separate-proof');
    assert.equal(expectedSource('N96 - statement-2025-05-02-Example.pdf'), 'separate-proof');
    assert.equal(expectedSource(''), 'unknown');
  });

  it('scores a replayed month against the sent report by content', () => {
    const bankRows = [
      bank('b-cloud', { counterparty: 'Example Cloud', amount: '-48.60' }),
      bank('b-sponsor', { accountId: 'revolut', wallet: 'EUR', counterparty: 'SPONSOR EXAMPLE', amount: '9000.00', date: '2025-05-02' }),
    ];
    const ledgerRows = [
      ledger('l-cloud', { counterparty: 'Example Cloud', amount: '-48.60' }),
      ledger('l-sponsor', { counterparty: 'Sponsor Example', amount: '9000.00', date: '2025-05-02' }),
      ledger('l-card', { counterparty: 'Example App', amount: '-1.99', date: '2025-05-14' }),
      ledger('l-tax', { counterparty: 'Tax office', amount: '-1105.26', category: 'Health Insurance', date: '2025-05-15' }),
    ];
    const truth: TruthRow[] = [
      { date: '2025-05-05', counterparty: 'Example Cloud', amount: -48.6, currency: 'EUR', amountEur: -48.6, entryType: 'expense', statementRef: 'Finom' },
      // The report names the wrong bank: the payment arrived on Revolut.
      { date: '2025-05-02', counterparty: 'Sponsor Example', amount: 9000, currency: 'EUR', amountEur: 9000, entryType: 'income', statementRef: 'Finom' },
      { date: '2025-05-14', counterparty: 'Example App', amount: -1.99, currency: 'EUR', amountEur: -1.99, entryType: 'expense', statementRef: 'N96 - statement-2025-05-14-Example.pdf' },
      { date: '2025-05-20', counterparty: 'Never booked', amount: -5, currency: 'EUR', amountEur: -5, entryType: 'expense', statementRef: 'Finom' },
    ];
    const table = buildMonthTable({ period: '2025-05', bank: bankRows, ledger: ledgerRows, decisions: { pairs: [], rejected: [], exceptions: {}, proofs: {} }, rules: [] });
    const result = backtestMonth('2025-05', truth, table, ledgerRows);
    assert.deepEqual(result.rows.map((row) => row.outcome), ['match', 'wrong-account', 'agree-no-bank', 'only-in-report']);
    assert.equal(result.precision, 0.5);
    assert.equal(result.recall, 0.5);
    assert.deepEqual([result.totals.reportIncomeEur, result.totals.reportExpenseEur], [9000, 55.59]);
    assert.deepEqual([result.totals.oursIncomeEur, result.totals.oursExpenseEur, result.totals.exemptExpenseEur], [9000, 50.59, 1105.26]);
    assert.deepEqual(result.onlyInOurs.map((row) => [row.ledgerId, row.reportExempt]), [['l-tax', true]]);
  });
});
