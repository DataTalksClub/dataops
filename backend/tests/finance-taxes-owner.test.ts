import { describe, it } from 'node:test';
import assert from 'node:assert';
import { summarize, type LedgerRow, type RateLookup } from '../src/finance/summary';
import { taxesReport } from '../src/finance/taxes';
import { classifyOwnerPayCandidate } from '../src/finance/ownerPay';
import { taxTypeOf } from '../src/finance/mandatoryPayments';

// Synthetic books, every name and figure invented.
const row = (id: string, fields: Record<string, unknown>): LedgerRow => ({ id, currency: 'EUR', counterparty: 'Synthetic Vendor', description: 'synthetic', sourceType: 'spreadsheet', ...fields });
const noRates: RateLookup = () => null;
const run = (rows: LedgerRow[], query: Parameters<typeof summarize>[0]['query'] = { month: '2026-10' }, today = '2026-11-02') =>
  summarize({ today, query, rates: noRates, rows });

const books = [
  row('in', { entryType: 'income', amount: '1190', vatAmount: '190', paidDate: '2026-10-05' }),
  row('out', { entryType: 'expense', amount: '119', vatAmount: '19', paidDate: '2026-10-06' }),
  row('gewst', { entryType: 'expense', amount: '3296', category: 'Taxes', description: 'Gewerbesteuer Vorauszahlung', counterparty: 'Stadtkasse Synthetic', paidDate: '2026-10-15' }),
  row('est', { entryType: 'expense', amount: '1000', category: 'Taxes', description: 'Einkommensteuer und Solidaritaetszuschlag', counterparty: 'Finanzamt Synthetic', paidDate: '2026-10-10' }),
  row('tk', { entryType: 'expense', amount: '1179.36', category: 'Health Insurance', counterparty: 'Techniker Krankenkasse', paidDate: '2026-10-01' }),
  row('vatpay', { entryType: 'expense', amount: '100', category: 'VAT', counterparty: 'Finanzamt Synthetic', paidDate: '2026-10-10' }),
  row('salary', { entryType: 'expense', amount: '4000', category: 'Owner pay', ownerPayType: 'salary', counterparty: 'Synthetic Owner', paidDate: '2026-10-28' }),
  row('draw', { entryType: 'expense', amount: '500', category: 'Owner pay', ownerPayType: 'draw', counterparty: 'Synthetic Owner', paidDate: '2026-10-29' }),
];

describe('owner pay in the summary', () => {
  const s = run(books);
  it('is its own line, not an operating expense', () => {
    assert.equal(s.totals.ownerPay, 4500);
    assert.equal(s.totals.operatingExpenses, 119);
    assert.equal(s.totals.netProfitExVat, 1000 - 100);
    assert.equal(s.entries.find((e) => e.id === 'salary')?.ownerPayType, 'salary');
  });
  it('sits below net profit and still counts as money out', () => {
    const t = s.totals;
    assert.equal(t.netAfterOwnerPay, Math.round((t.netAfterTaxes - 4500) * 100) / 100);
    assert.equal(t.moneyOut, 119 + 3296 + 1000 + 1179.36 + 100 + 4500);
  });
  it('unknown owner pay type is kept as unknown', () => {
    const u = run([row('x', { entryType: 'expense', amount: '10', category: 'Owner pay', ownerPayType: 'bogus', paidDate: '2026-10-01' })]);
    assert.equal(u.entries[0].ownerPayType, 'unknown');
  });
});

describe('owner pay detection (dry run)', () => {
  const owner = ['synthetic owner'];
  it('decides salary, draw, reimbursement by booking text and needs the owner as counterparty', () => {
    const c = (description: string, counterparty = 'Synthetic Owner', entryType = 'expense') => classifyOwnerPayCandidate({ counterparty, description, entryType }, owner)?.ownerPayType ?? null;
    assert.equal(c('Geschäftsführergehalt 10/2026'), 'salary');
    assert.equal(c('Privatentnahme'), 'draw');
    assert.equal(c('Erstattung Auslagen'), 'reimbursement');
    assert.equal(c('Umbuchung'), 'unknown');
    assert.equal(c('Gehalt', 'Someone Else'), null);
    assert.equal(c('Gehalt', 'Synthetic Owner', 'income'), null);
  });
});

describe('tax types and the tax report', () => {
  it('derives the tax type from booking text and honours a stored taxType', () => {
    assert.equal(taxTypeOf({ description: 'Gewerbesteuer' }, 'taxes'), 'trade-tax');
    assert.equal(taxTypeOf({ description: 'ESt + Soli' }, 'taxes'), 'income-tax');
    assert.equal(taxTypeOf({ description: 'GEW.ST 2026' }, 'taxes'), 'trade-tax');
    assert.equal(taxTypeOf({ description: 'EINK.ST 2024' }, 'taxes'), 'income-tax');
    assert.equal(taxTypeOf({ description: 'Steuer' }, 'taxes'), 'other');
    assert.equal(taxTypeOf({ description: 'x', taxType: 'income-tax' }, 'vat'), 'income-tax');
  });
  it('a stored taxType moves a mislabelled VAT row onto the taxes line', () => {
    const s = run([row('adv', { entryType: 'expense', amount: '12240', category: 'VAT', taxType: 'income-tax', paidDate: '2026-10-10' })]);
    assert.equal(s.totals.vatPaid, 0);
    assert.equal(s.totals.incomeTax, 12240);
    assert.equal(s.totals.otherTaxes, 0);
  });
  it('reports VAT projected next to paid, other taxes by type and TK', () => {
    const r = taxesReport(run(books), '2026-11-02');
    assert.equal(r.open, false);
    assert.equal(r.totals.outputVat, 190);
    assert.equal(r.totals.inputVat, 19);
    assert.equal(r.totals.projectedVat, 171);
    assert.equal(r.totals.vatPaid, 100);
    assert.equal(r.totals.vatOutstanding, 71);
    assert.equal(r.totals.taxes['trade-tax'], 3296);
    assert.equal(r.totals.taxes['income-tax'], 1000);
    assert.equal(r.totals.taxes['health-insurance'], 1179.36);
    assert.equal(r.totals.taxesTotal, 3296 + 1000 + 1179.36);
    assert.equal(r.entries.length, 4);
  });
  it('lists a Finanzamt refund as a refund, never as a negative tax', () => {
    const r = taxesReport(run([
      ...books,
      row('erstattung', { entryType: 'income', amount: '43633.73', category: 'Taxes', counterparty: 'Finanzamt Synthetic', description: 'Erstattung', paidDate: '2026-10-30' }),
    ]), '2026-11-02');
    assert.equal(r.totals.taxRefunds, 43633.73);
    assert.deepEqual(r.totals.taxes, { 'income-tax': 1000, 'trade-tax': 3296, 'health-insurance': 1179.36, other: 0 });
    assert.equal(r.totals.taxesTotal, 3296 + 1000 + 1179.36);
  });
  it('marks the current period open and sums year months', () => {
    const r = taxesReport(run(books, { ytd: true }, '2026-10-31'), '2026-10-31');
    assert.equal(r.open, true);
    assert.equal(r.months.length, 10);
    assert.equal(r.totals.taxes['trade-tax'], 3296);
  });
});
