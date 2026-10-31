import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  amountFit,
  buildMonthTable,
  classify,
  closeBlockers,
  DEFAULT_TOLERANCES,
  exceptionDigest,
  internalTransferLegs,
  pairAll,
  tableCsv,
  type BankTx,
  type ClassificationRule,
  type LedgerRow,
  type ManualDecisions,
} from '../src/reconcile/month';

const bank = (key: string, overrides: Partial<BankTx> = {}): BankTx => ({
  key, accountId: 'finom', statementId: 'stmt', date: '2026-10-05', amount: '-10.00', currency: 'EUR', counterparty: 'Synthetic', ...overrides,
});
const ledger = (id: string, overrides: Partial<LedgerRow> = {}): LedgerRow => ({
  id, date: '2026-10-05', amount: '-10.00', currency: 'EUR', counterparty: 'Synthetic', documents: [{ id: `doc-${id}` }], ...overrides,
});
const none = (): ManualDecisions => ({ pairs: [], rejected: [], exceptions: {}, proofs: {} });
const RULES: ClassificationRule[] = [
  { id: 'fee', kind: 'bank_fee', direction: 'out', counterparty: '^(Revolut|Finom)\\b.*fee|account fee', category: 'Bank fees' },
  { id: 'tk', kind: 'tk_debit', direction: 'out', counterparty: 'techniker krankenkasse', category: 'Health Insurance' },
  { id: 'tax', kind: 'tax_debit', direction: 'out', counterparty: 'finanzamt', category: 'Taxes' },
  { id: 'payout', kind: 'platform_payout', direction: 'in', counterparty: 'paypal|teachable', category: 'Platform payout' },
];
const table = (bankRows: BankTx[], ledgerRows: LedgerRow[], decisions = none(), rules = RULES) =>
  buildMonthTable({ period: '2026-10', bank: bankRows, ledger: ledgerRows, decisions, rules });

describe('month reconciliation', () => {
  it('pairs exact amounts with documents as matched and flags each missing side', () => {
    const result = table(
      [
        bank('b-cloud', { counterparty: 'Example Cloud', amount: '-48.60', date: '2026-10-02' }),
        bank('b-sponsor', { counterparty: 'Sponsor One BV', reference: '202610/12', amount: '2500.00', date: '2026-10-06' }),
        bank('b-orphan', { counterparty: 'Unknown Shop', amount: '-15.00', date: '2026-10-09' }),
      ],
      [
        ledger('l-cloud', { counterparty: 'Example Cloud', amount: '-48.60', date: '2026-09-30' }),
        ledger('l-sponsor', { counterparty: 'Sponsor One', amount: '2500.00', invoiceNumber: '202610/12', date: '2026-10-05', documents: [] }),
        ledger('l-nobank', { counterparty: 'Example Hosting', amount: '-20.00', date: '2026-10-12' }),
      ],
    );
    const byId = Object.fromEntries(result.rows.map((row) => [row.id, row]));
    // The ledger row dated 30 Sep pairs with the 2 Oct debit and is shown in October with it.
    assert.equal(byId['b-cloud'].status, 'matched');
    assert.equal(byId['b-cloud'].ledger?.id, 'l-cloud');
    assert.equal(byId['b-cloud'].confidence, 'exact');
    assert.equal(byId['b-sponsor'].status, 'no-invoice');
    assert.match(byId['b-sponsor'].missing!, /no invoice/);
    assert.equal(byId['b-orphan'].status, 'no-invoice');
    assert.equal(byId['ledger:l-nobank'].status, 'payment-proof-missing');
    assert.deepEqual(result.counters, { rows: 4, matched: 1, bankWithoutInvoice: 2, ledgerWithoutBank: 1, amountMismatch: 0, needsReview: 0, exceptions: 0 });
    assert.equal(closeBlockers(result).length, 3);
  });

  it('matches foreign-currency rows through the original amount or the EUR amount, and flags fee gaps', () => {
    const tolerances = DEFAULT_TOLERANCES;
    assert.equal(amountFit(bank('b', { amount: '-9.80', origAmount: '-8.50', origCurrency: 'GBP' }), ledger('l', { amount: '-8.50', currency: 'GBP' }), tolerances)?.basis, 'fx');
    assert.equal(amountFit(bank('b', { amount: '-640.10' }), ledger('l', { amount: '-691.13', currency: 'USD', amountEur: '-645.00' }), tolerances)?.basis, 'fx');
    assert.equal(amountFit(bank('b', { amount: '-600.00' }), ledger('l', { amount: '-691.13', currency: 'USD', amountEur: '-645.00' }), tolerances), null);
    assert.equal(amountFit(bank('b', { amount: '-10.20', fee: '0.20' }), ledger('l', { amount: '-10.40' }), tolerances)?.basis, 'exact');
    assert.equal(amountFit(bank('b', { amount: '-10.00' }), ledger('l', { amount: '10.00' }), tolerances), null);

    const result = table([bank('b-fee', { counterparty: 'Example SaaS', amount: '-50.75' })], [ledger('l-fee', { counterparty: 'Example SaaS', amount: '-50.00' })]);
    assert.equal(result.rows[0].status, 'amount-mismatch');
    assert.equal(result.rows[0].amountDifference, '0.75');
  });

  it('leaves equally good candidates for review instead of guessing', () => {
    const result = table(
      [bank('b-1', { counterparty: 'Payment from client', amount: '300.00' })],
      [
        ledger('l-a', { counterparty: 'Organization A', amount: '300.00', date: '2026-10-04' }),
        ledger('l-b', { counterparty: 'Organization B', amount: '300.00', date: '2026-10-06' }),
      ],
    );
    const row = result.rows.find((item) => item.id === 'b-1')!;
    assert.equal(row.status, 'needs-review');
    assert.deepEqual(row.candidates!.map((candidate) => candidate.transactionId).sort(), ['l-a', 'l-b']);
    assert.equal(result.rows.filter((item) => item.status === 'payment-proof-missing').length, 2);
  });

  it('pairs two identical payments one-to-one rather than calling them ambiguous', () => {
    const result = table(
      [bank('b-1', { counterparty: 'Coffee Bar' }), bank('b-2', { counterparty: 'Coffee Bar' })],
      [ledger('l-1', { counterparty: 'Coffee Bar' }), ledger('l-2', { counterparty: 'Coffee Bar' })],
    );
    assert.equal(result.counters.matched, 2);
  });

  it('applies manual pairs and unmatches over automatic pairing', () => {
    const bankRows = [bank('b-1', { counterparty: 'Example Vendor', amount: '-99.00' })];
    const ledgerRows = [ledger('l-1', { counterparty: 'Example Vendor', amount: '-99.00' }), ledger('l-2', { counterparty: 'Other', amount: '-90.00' })];
    const rejected = table(bankRows, ledgerRows, { ...none(), rejected: ['b-1|l-1'] });
    assert.equal(rejected.rows.find((row) => row.id === 'b-1')!.status, 'no-invoice');
    const manual = table(bankRows, ledgerRows, { ...none(), rejected: ['b-1|l-1'], pairs: [{ bankKey: 'b-1', transactionId: 'l-2', by: 'operator', at: '2026-11-01T00:00:00Z' }] });
    const row = manual.rows.find((item) => item.id === 'b-1')!;
    assert.equal(row.ledger?.id, 'l-2');
    assert.equal(row.pairBasis, 'manual');
    assert.equal(row.status, 'matched');
    assert.equal(row.amountDifference, '9.00');
  });

  it('classifies no-invoice kinds with rules and checks each kind\'s proof', () => {
    assert.equal(classify(bank('x', { counterparty: 'Techniker Krankenkasse' }), RULES)?.kind, 'tk_debit');
    assert.equal(classify(bank('x', { counterparty: 'Techniker Krankenkasse', amount: '5.00' }), RULES), undefined);
    const result = table(
      [
        bank('b-fee', { counterparty: 'Finom account fee', amount: '-15.00' }),
        bank('b-tax', { counterparty: 'Finanzamt Example', amount: '-3296.00' }),
        bank('b-out', { accountId: 'finom', counterparty: 'Synthetic Holder', reference: 'account transfer', amount: '-1000.00', date: '2026-10-10' }),
        bank('b-in', { accountId: 'revolut', wallet: 'EUR', counterparty: 'SYNTHETIC HOLDER', amount: '1000.00', date: '2026-10-11' }),
        bank('b-payout', { counterparty: 'PayPal Europe', amount: '48.32' }),
      ],
      [ledger('l-payout', { counterparty: 'PayPal Europe', amount: '48.32', documents: [] })],
      { ...none(), exceptions: {} },
    );
    const byId = Object.fromEntries(result.rows.map((row) => [row.id, row]));
    assert.deepEqual([byId['b-fee'].exception?.kind, byId['b-fee'].status], ['bank_fee', 'matched']);
    assert.deepEqual([byId['b-tax'].exception?.kind, byId['b-tax'].status], ['tax_debit', 'needs-review']);
    assert.match(byId['b-tax'].missing!, /tax-schedule/);
    assert.deepEqual([byId['b-out'].exception?.kind, byId['b-out'].status], ['internal_transfer', 'matched']);
    assert.match(byId['b-out'].exception!.evidence!, /revolut EUR/);
    assert.equal(byId['b-in'].status, 'matched');
    assert.deepEqual([byId['b-payout'].exception?.kind, byId['b-payout'].status], ['platform_payout', 'matched']);

    const withProof = table(
      [bank('b-tax', { counterparty: 'Finanzamt Example', amount: '-3296.00' })], [],
      { ...none(), exceptions: { 'bank:b-tax': { kind: 'tax_debit', proof: 'GewSt prepayment Q4 schedule entry', by: 'operator', at: '2026-11-01T00:00:00Z' } } },
    );
    assert.equal(withProof.rows[0].status, 'matched');
    assert.notEqual(exceptionDigest(withProof), exceptionDigest(result));
  });

  it('links Revolut exchange legs through their related transaction ids', () => {
    const legs = internalTransferLegs([
      bank('eur', { accountId: 'revolut', wallet: 'EUR', amount: '-460.00', bankId: 'tx-4', relatedBankId: 'tx-3' }),
      bank('usd', { accountId: 'revolut', wallet: 'USD', amount: '500.00', currency: 'USD', bankId: 'tx-3', relatedBankId: 'tx-4' }),
    ], DEFAULT_TOLERANCES);
    assert.equal(legs.get('eur'), 'usd');
  });

  it('a Google receipt with no bank row is matched once a payment proof is attached to that row', () => {
    const receipt = ledger('l-google', { counterparty: 'Google', description: 'Google One', amount: '-1.99', date: '2026-10-14' });
    const before = table([], [receipt]);
    assert.equal(before.rows[0].status, 'payment-proof-missing');
    assert.match(before.rows[0].missing!, /upload a payment proof/);
    assert.equal(closeBlockers(before).length, 1);

    const after = table([], [receipt], { ...none(), proofs: { 'l-google': { documentId: 'proof-doc', filename: 'google-receipt.pdf', by: 'operator', at: '2026-11-01T00:00:00Z' } } });
    assert.equal(after.rows[0].status, 'matched');
    assert.equal(after.rows[0].paymentProof?.documentId, 'proof-doc');
    assert.equal(closeBlockers(after).length, 0);
    assert.match(tableCsv(after), /proof:proof-doc/);
  });

  it('pairs globally, so a boundary payment lands in one month only', () => {
    const bankRows = [bank('b-1', { counterparty: 'Example Cloud', date: '2026-11-02' })];
    const ledgerRows = [ledger('l-1', { counterparty: 'Example Cloud', date: '2026-10-31' })];
    const pairing = pairAll(bankRows, ledgerRows, none(), DEFAULT_TOLERANCES);
    const october = buildMonthTable({ period: '2026-10', bank: bankRows, ledger: ledgerRows, decisions: none(), rules: [], pairing });
    const november = buildMonthTable({ period: '2026-11', bank: bankRows, ledger: ledgerRows, decisions: none(), rules: [], pairing });
    assert.equal(october.rows.length, 0);
    assert.equal(november.rows[0].status, 'matched');
  });

  it('does not take a sponsor payment and a salary of the same amount for an internal transfer (backtest 2025-03)', () => {
    const result = table(
      [
        bank('b-sponsor', { accountId: 'revolut', wallet: 'EUR', counterparty: 'EDTECH EXAMPLE B.V.', reference: '202503/5', amount: '2000.00', date: '2025-03-21' }),
        bank('b-salary', { accountId: 'finom', counterparty: 'Owner Person', reference: 'salary', amount: '-2000.00', date: '2025-03-24' }),
      ],
      [ledger('l-sponsor', { counterparty: 'Edtech Example B.V.', amount: '2000.00', date: '2025-03-17' })],
    );
    const october = buildMonthTable({ period: '2025-03', bank: [
      bank('b-sponsor', { accountId: 'revolut', wallet: 'EUR', counterparty: 'EDTECH EXAMPLE B.V.', reference: '202503/5', amount: '2000.00', date: '2025-03-21' }),
      bank('b-salary', { accountId: 'finom', counterparty: 'Owner Person', reference: 'salary', amount: '-2000.00', date: '2025-03-24' }),
    ], ledger: [ledger('l-sponsor', { counterparty: 'Edtech Example B.V.', amount: '2000.00', date: '2025-03-17' })], decisions: none(), rules: RULES });
    assert.equal(result.rows.length, 0);
    assert.equal(october.rows.find((row) => row.id === 'b-sponsor')?.ledger?.id, 'l-sponsor');
    assert.equal(october.rows.find((row) => row.id === 'b-salary')?.exception, undefined);
  });

  it('rejects an EUR-only fit when the bank\'s original amount contradicts the ledger (backtest 2025-07)', () => {
    const tolerances = DEFAULT_TOLERANCES;
    const aws = bank('b-aws', { counterparty: 'Aws Emea', amount: '-208.33', origAmount: '-245.95', origCurrency: 'USD', date: '2025-07-02' });
    assert.equal(amountFit(aws, ledger('l-podcast', { counterparty: 'Podcast Example', amount: '-249.00', currency: 'USD', amountEur: '-211.40' }), tolerances), null);
    // Identical EUR amounts still pair, as a mismatch pointing at the ledger's foreign-amount typo.
    assert.equal(amountFit(bank('b', { amount: '-20.28', origAmount: '-23.80', origCurrency: 'USD' }), ledger('l', { amount: '-23.28', currency: 'USD', amountEur: '-20.28' }), tolerances)?.basis, 'fee');
  });
});
