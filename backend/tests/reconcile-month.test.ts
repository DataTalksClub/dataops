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

  it('surfaces an accepted pending email invoice as needs-review without treating it as a ledger match', () => {
    const result = buildMonthTable({
      period: '2026-10',
      bank: [bank('b-mailchimp', { date: '2026-10-22', counterparty: 'Intuit Ireland Software L', amount: '-726.59' })],
      ledger: [],
      pendingEmailInvoices: [{
        id: 'draft-mailchimp', artifactId: 'email-document-mailchimp', receivedAt: '2026-10-22T06:00:00Z',
        fields: { transactionDate: '2026-10-21', counterparty: 'Intuit Mailchimp' }, direction: 'expense',
      }],
      decisions: none(), rules: [],
    });
    const row = result.rows[0];
    assert.equal(row.status, 'needs-review');
    assert.match(row.missing!, /pending email invoice draft needs review/);
    assert.deepEqual(row.emailInvoiceCandidates, [{
      invoiceId: 'draft-mailchimp', artifactId: 'email-document-mailchimp', counterparty: 'Intuit Mailchimp',
    }]);
    assert.equal(row.ledger, undefined, 'a draft is not published into the bookkeeping ledger');
    assert.deepEqual(row.documents, [], 'the draft document is not presented as an attached ledger document');
    assert.equal(result.counters.bankWithoutInvoice, 0);
    assert.equal(result.counters.needsReview, 1);
  });

  it('surfaces a possible refund direction conflict without associating an unrelated draft', () => {
    const result = buildMonthTable({
      period: '2026-10',
      bank: [
        bank('b-refund', { date: '2026-10-22', counterparty: 'X Corp. Paid Features', amount: '7.64' }),
        bank('b-other', { date: '2026-10-22', counterparty: 'Unrelated Vendor', amount: '-5.00' }),
      ],
      ledger: [],
      pendingEmailInvoices: [
        { id: 'wrong-direction', artifactId: 'invoice-a', receivedAt: '2026-10-22T00:00:00Z', fields: { counterparty: 'X Internet Unlimited Company' }, direction: 'expense' },
        { id: 'wrong-date', artifactId: 'invoice-b', receivedAt: '2026-09-01T00:00:00Z', fields: { counterparty: 'Another Vendor' }, direction: 'income' },
      ],
      decisions: none(), rules: [],
    });
    const rows = Object.fromEntries(result.rows.map((row) => [row.id, row]));
    assert.equal(rows['b-refund'].status, 'needs-review');
    assert.deepEqual(rows['b-refund'].emailInvoiceCandidates, [{
      invoiceId: 'wrong-direction', artifactId: 'invoice-a', counterparty: 'X Internet Unlimited Company', directionConflict: true,
    }]);
    assert.equal(rows['b-other'].status, 'no-invoice');
  });

  it('surfaces pending email documents for paired rows with no invoice and for Google Play review', () => {
    const result = buildMonthTable({
      period: '2026-10',
      bank: [
        bank('b-refund', { date: '2026-10-31', counterparty: 'Pro Sulum Llc', amount: '646.63', currency: 'USD' }),
        bank('b-google-play', { date: '2026-10-17', counterparty: 'Google*google Play App', amount: '877.39' }),
      ],
      ledger: [ledger('l-refund', { date: '2026-10-30', counterparty: 'Pro Sulum, LLC', amount: '646.63', currency: 'USD', documents: [] })],
      pendingEmailInvoices: [
        { id: 'refund-draft', artifactId: 'email-document-refund', receivedAt: '2026-10-31T00:00:00Z', fields: { transactionDate: '2026-10-30', amount: '646.63', currency: 'USD', counterparty: 'Pro Sulum, LLC' }, direction: 'income' },
        { id: 'google-play-draft', artifactId: 'email-document-google-play', receivedAt: '2026-10-04T00:00:00Z', fields: { transactionDate: '2026-10-02', amount: '219.99', currency: 'EUR', counterparty: 'Google Commerce Limited' }, direction: 'expense' },
      ],
      decisions: none(), rules: [],
    });
    const rows = Object.fromEntries(result.rows.map((row) => [row.id, row]));
    assert.equal(rows['b-refund'].status, 'needs-review');
    assert.equal(rows['b-refund'].ledger?.id, 'l-refund');
    assert.equal(rows['b-refund'].emailInvoiceCandidates?.[0].invoiceId, 'refund-draft');
    assert.equal(rows['b-google-play'].status, 'needs-review');
    assert.deepEqual(rows['b-google-play'].emailInvoiceCandidates, [{
      invoiceId: 'google-play-draft', artifactId: 'email-document-google-play',
      counterparty: 'Google Commerce Limited', directionConflict: true,
    }]);
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

  it('classifies taxes and health insurance separately without blocking month close', () => {
    assert.equal(classify(bank('x', { counterparty: 'Techniker Krankenkasse' }), RULES)?.kind, 'tk_debit');
    assert.equal(classify(bank('x', { counterparty: 'Techniker Krankenkasse', amount: '5.00' }), RULES), undefined);
    assert.deepEqual(classify(bank('refund', { counterparty: 'Finanzamt refund', amount: '43633.73' }), []), {
      kind: 'tax_refund', ruleId: 'tax-refund', category: 'Taxes',
    });
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
    assert.deepEqual([byId['b-tax'].exception?.kind, byId['b-tax'].status, byId['b-tax'].tax], ['tax_debit', 'matched', true]);
    assert.deepEqual([byId['b-tax'].exception?.proof, byId['b-tax'].exception?.satisfied], ['category', true]);
    const refundAndTk = table([
      bank('b-refund', { counterparty: 'Finanzamt refund', amount: '43633.73' }),
      bank('b-tk', { counterparty: 'Techniker Krankenkasse', amount: '-534.20' }),
    ], []);
    assert.deepEqual(refundAndTk.rows.map((row) => [row.exception?.kind, row.tax, row.status]), [
      ['tax_refund', true, 'matched'], ['tk_debit', true, 'matched'],
    ]);
    assert.equal(refundAndTk.counters.rows, 0);
    assert.equal(refundAndTk.counters.needsReview, 0);
    assert.equal(closeBlockers(refundAndTk).length, 0);
    assert.equal(tableCsv(refundAndTk).includes('Finanzamt refund'), false);
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

  it('keeps ordinary Compliance & Taxes service invoices in regular rows and CSV while excluding exact tax categories', () => {
    const result = table(
      [
        bank('b-advisory', { counterparty: 'Synthetic Advisory GmbH', amount: '-238.00', date: '2026-10-08' }),
        bank('b-finanzamt', { counterparty: 'Finanzamt Example', amount: '-1500.00', date: '2026-10-10' }),
        bank('b-tk', { counterparty: 'Techniker Krankenkasse', amount: '-540.00', date: '2026-10-12' }),
      ],
      [
        ledger('l-advisory', {
          counterparty: 'Synthetic Advisory GmbH',
          description: 'Monthly bookkeeping service',
          amount: '-238.00',
          date: '2026-10-07',
          category: 'Compliance & Taxes',
          subtype: 'Services',
          invoiceNumber: 'SYN-2026-10',
        }),
        ledger('l-exact-tax', {
          counterparty: 'State Revenue Office',
          amount: '-400.00',
          date: '2026-10-15',
          category: 'Taxes',
        }),
        ledger('l-exact-hi', {
          counterparty: 'Statutory Health Fund',
          amount: '-300.00',
          date: '2026-10-16',
          category: 'Health Insurance',
        }),
      ],
    );
    const byId = Object.fromEntries(result.rows.map((row) => [row.id, row]));
    assert.equal(byId['b-advisory'].tax, false);
    assert.equal(byId['b-advisory'].status, 'matched');
    assert.equal(byId['b-advisory'].ledger?.category, 'Compliance & Taxes');
    assert.equal(byId['b-advisory'].ledger?.subtype, 'Services');

    assert.equal(byId['b-finanzamt'].tax, true);
    assert.equal(byId['b-tk'].tax, true);
    assert.equal(byId['ledger:l-exact-tax'].tax, true);
    assert.equal(byId['ledger:l-exact-hi'].tax, true);

    assert.equal(result.counters.rows, 1);
    assert.equal(result.counters.matched, 1);

    const csv = tableCsv(result);
    assert.match(csv, /Synthetic Advisory GmbH/);
    assert.match(csv, /Compliance & Taxes/);
    assert.doesNotMatch(csv, /Finanzamt Example/);
    assert.doesNotMatch(csv, /Techniker Krankenkasse/);
    assert.doesNotMatch(csv, /State Revenue Office/);
    assert.doesNotMatch(csv, /Statutory Health Fund/);

    const withExplicitTaxException = table(
      [bank('b-advisory', { counterparty: 'Synthetic Advisory GmbH', amount: '-238.00', date: '2026-10-08' })],
      [ledger('l-advisory', { counterparty: 'Synthetic Advisory GmbH', amount: '-238.00', date: '2026-10-07', category: 'Compliance & Taxes', subtype: 'Services' })],
      { ...none(), exceptions: { 'bank:b-advisory': { kind: 'tax_debit', by: 'operator', at: '2026-11-01T00:00:00Z' } } },
    );
    assert.equal(withExplicitTaxException.rows[0].tax, true);
  });

  it('omits satisfied owner withdrawals from accountant CSV while preserving reconciliation rows and counters', () => {
    const ownerWithdrawalRule: ClassificationRule = {
      id: 'owner-withdrawal', kind: 'owner_withdrawal', direction: 'out',
      counterparty: 'synthetic owner', category: 'Owner pay',
    };
    const result = table(
      [
        bank('b-owner', { counterparty: 'Synthetic Owner', amount: '-42.00' }),
        bank('b-ilz', { counterparty: 'Synthetic ILZ Services', amount: '-238.00', date: '2026-10-08' }),
      ],
      [
        ledger('l-owner', { counterparty: 'Synthetic Owner', amount: '-42.00', category: 'Owner pay' }),
        ledger('l-ilz', { counterparty: 'Synthetic ILZ Services', amount: '-238.00', date: '2026-10-08', category: 'Compliance & Taxes', subtype: 'Services' }),
      ],
      none(),
      [...RULES, ownerWithdrawalRule],
    );
    const ownerRow = result.rows.find((row) => row.id === 'b-owner')!;
    assert.deepEqual([ownerRow.exception?.kind, ownerRow.exception?.satisfied, ownerRow.status], ['owner_withdrawal', true, 'matched']);
    assert.equal(result.counters.rows, 2);
    assert.equal(result.counters.matched, 2);
    assert.equal(result.counters.exceptions, 1);

    const csv = tableCsv(result);
    assert.doesNotMatch(csv, /Synthetic Owner|Owner pay/);
    assert.match(csv, /Synthetic ILZ Services/);
    assert.match(csv, /Compliance & Taxes/);
    assert.equal(result.rows.includes(ownerRow), true);
    assert.equal(result.counters.rows, 2);
    assert.equal(result.counters.matched, 2);
    assert.equal(result.counters.exceptions, 1);

    const unresolved = table(
      [bank('b-owner-unresolved', { counterparty: 'Synthetic Owner', amount: '-42.00' })],
      [],
      { ...none(), exceptions: { 'bank:b-owner-unresolved': { kind: 'owner_withdrawal', by: 'operator', at: '2026-11-01T00:00:00Z' } } },
      [],
    );
    assert.equal(unresolved.rows[0].exception?.satisfied, false);
    assert.match(tableCsv(unresolved), /Synthetic Owner/);
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

  // Separate-proof scenarios found in 2024-26 bookkeeping (anonymized): each replays
  // row -> payment proof missing -> proof attached -> matched -> nothing blocks close.
  for (const scenario of [
    { name: 'N26 personal card, printed transaction page', rows: [ledger('l-n26', { counterparty: 'Example Taxi', amount: '-11.23', date: '2026-05-04' })] },
    { name: 'PayPal transaction details page', rows: [ledger('l-paypal', { counterparty: 'Example Podcast Editing', amount: '-249.00', currency: 'USD', date: '2025-07-04' })] },
    { name: 'Wise transfer confirmation covering two ledger rows', rows: [ledger('l-wise-1', { counterparty: 'Contractor Example', amount: '-1000.00', date: '2025-05-06' }), ledger('l-wise-2', { counterparty: 'Contractor Example', amount: '-1000.00', date: '2025-05-06' })] },
    { name: 'personal Revolut one-transaction statement', rows: [ledger('l-retail', { counterparty: 'Example Store', amount: '-35.00', date: '2026-02-10' })] },
    { name: 'Google Play receipt paid by personal card', rows: [ledger('l-play', { counterparty: 'Google Play', amount: '-1.99', date: '2024-08-14' })] },
    { name: 'credit note with no bank row yet', rows: [ledger('l-credit', { counterparty: 'Example Vendor', amount: '646.63', currency: 'USD', date: '2026-10-30' })] },
  ]) {
    it(`separate proof: ${scenario.name}`, () => {
      const period = scenario.rows[0].date.slice(0, 7);
      const run = (decisions: ManualDecisions) => buildMonthTable({ period, bank: [], ledger: scenario.rows, decisions, rules: RULES });
      const before = run(none());
      assert.ok(before.rows.every((row) => row.status === 'payment-proof-missing'));
      assert.equal(closeBlockers(before).length, scenario.rows.length);
      // One proof document may cover several rows (one transfer paying two invoices).
      const proofs = Object.fromEntries(scenario.rows.map((row) => [row.id, { documentId: 'proof-1', by: 'operator', at: '2026-11-01T00:00:00Z' }]));
      const after = run({ ...none(), proofs });
      assert.ok(after.rows.every((row) => row.status === 'matched'), JSON.stringify(after.rows));
      assert.equal(closeBlockers(after).length, 0);
    });
  }

  it('separate proof: income known only from a notification or chat stays blocked until a proof is attached', () => {
    const rows = [ledger('l-notified', { counterparty: 'Sponsor Example', amount: '3000.00', date: '2026-10-31' })];
    const result = buildMonthTable({ period: '2026-10', bank: [], ledger: rows, decisions: { ...none(), exceptions: { 'ledger:l-notified': { kind: 'platform_payout', by: 'operator', at: '2026-11-01T00:00:00Z' } } }, rules: RULES });
    // A no-invoice kind waives the document, never the payment.
    assert.equal(result.rows[0].status, 'payment-proof-missing');
  });

  it('expands one bank payment (420.84 EUR) across three allocated invoice CSV rows while keeping internal reconciliation 1-to-1 and excluding owner withdrawals and true taxes', () => {
    const result = buildMonthTable({
      period: '2026-10',
      bank: [
        bank('b-42084', {
          date: '2026-10-18',
          amount: '-420.84',
          currency: 'EUR',
          counterparty: 'Synthetic Card Settlement',
          reference: 'BATCH-42084',
        }),
        bank('b-owner', {
          date: '2026-10-19',
          amount: '-1200.00',
          currency: 'EUR',
          counterparty: 'Owner Person',
          reference: 'Owner withdrawal',
        }),
        bank('b-consulting', {
          date: '2026-10-20',
          amount: '-238.00',
          currency: 'EUR',
          counterparty: 'Synthetic Tax Advisory GmbH',
          reference: 'ADV-10',
        }),
        bank('b-tax', {
          date: '2026-10-21',
          amount: '-1500.00',
          currency: 'EUR',
          counterparty: 'Finanzamt Example',
          reference: 'USt Q3',
        }),
      ],
      ledger: [
        ledger('l-42084', {
          date: '2026-10-18',
          amount: '-420.84',
          currency: 'EUR',
          counterparty: 'Synthetic Card Settlement',
          description: 'Combined vendor settlement',
          category: 'Tools',
          documents: [{ id: 'doc-399' }, { id: 'doc-1499' }, { id: 'doc-685' }],
          allocations: [
            {
              id: 'alloc-1',
              documentId: 'doc-399',
              invoiceNumber: 'INV-399',
              counterparty: 'Synthetic Compute GmbH',
              counterpartyCanonical: 'Synthetic Compute GmbH',
              description: 'Dedicated cluster October',
              amount: '399.00',
              currency: 'EUR',
              category: 'Infrastructure',
              transactionDate: '2026-10-15',
            },
            {
              id: 'alloc-2',
              documentId: 'doc-1499',
              invoiceNumber: 'INV-1499',
              counterparty: 'Synthetic Domains Ltd',
              counterpartyCanonical: 'Synthetic Domains Ltd',
              description: 'Domain renewal',
              amount: '14.99',
              currency: 'EUR',
              category: 'Domains',
              transactionDate: '2026-10-16',
            },
            {
              id: 'alloc-3',
              documentId: 'doc-685',
              invoiceNumber: 'INV-685',
              counterparty: 'Synthetic Mail B.V.',
              counterpartyCanonical: 'Synthetic Mail B.V.',
              description: 'Transactional email usage',
              amount: '6.85',
              currency: 'EUR',
              category: 'Tools',
              transactionDate: '2026-10-17',
            },
          ],
        }),
        ledger('l-consulting', {
          date: '2026-10-20',
          amount: '-238.00',
          currency: 'EUR',
          counterparty: 'Synthetic Tax Advisory GmbH',
          description: 'Monthly accounting and consulting fee',
          category: 'Compliance & Taxes',
          subtype: 'Services',
          documents: [{ id: 'doc-consulting' }],
        }),
      ],
      decisions: {
        ...none(),
        exceptions: {
          'bank:b-owner': {
            kind: 'owner_withdrawal',
            proof: 'Owner draw October',
            by: 'operator',
            at: '2026-10-19T12:00:00Z',
          },
        },
      },
      rules: RULES,
    });

    // Internal reconciliation stays unchanged: 3 non-tax rows (b-42084, b-owner, b-consulting) + 1 tax row (b-tax).
    assert.equal(result.counters.rows, 3);
    assert.equal(result.counters.matched, 3);
    assert.equal(result.counters.exceptions, 1);

    const csv = tableCsv(result);
    const lines = csv.trim().split('\n');
    // Header + 3 allocated invoice rows + 1 consulting row = 5 lines (owner_withdrawal and true tax excluded).
    assert.equal(lines.length, 5);
    assert.match(lines[1], /Synthetic Compute GmbH,Dedicated cluster October,-399\.00,EUR,finom,2026-10-18,-420\.84 EUR,BATCH-42084,l-42084,2026-10-15,-399\.00 EUR,Infrastructure,doc-399/);
    assert.match(lines[2], /Synthetic Domains Ltd,Domain renewal,-14\.99,EUR,finom,2026-10-18,-420\.84 EUR,BATCH-42084,l-42084,2026-10-16,-14\.99 EUR,Domains,doc-1499/);
    assert.match(lines[3], /Synthetic Mail B\.V\.,Transactional email usage,-6\.85,EUR,finom,2026-10-18,-420\.84 EUR,BATCH-42084,l-42084,2026-10-17,-6\.85 EUR,Tools,doc-685/);
    assert.match(lines[4], /Synthetic Tax Advisory GmbH,Monthly accounting and consulting fee,-238\.00,EUR/);
    assert.doesNotMatch(csv, /Owner Person/);
    assert.doesNotMatch(csv, /Finanzamt Example/);
  });
});
