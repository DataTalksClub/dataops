import { describe, it } from 'node:test';
import assert from 'node:assert';
import { dedupe, resolvePeriod, summarize, unmatchedStatementLines, type LedgerRow, type RateLookup } from '../src/finance/summary';
import { clearEcbRateCacheForTests, loadEcbRates, parseEcbCsv } from '../src/finance/rates';
import { parsePeriodQuery } from '../src/finance/service';

// Synthetic fixture books for October 2026, every figure invented.
const row = (id: string, fields: Record<string, unknown>): LedgerRow => ({ id, currency: 'EUR', counterparty: 'Synthetic Vendor', description: 'synthetic', sourceType: 'spreadsheet', ...fields });
const noRates: RateLookup = () => null;
const usdAt = (rate: number, date: string): RateLookup => (currency) => (currency === 'USD' ? { currency, rate, date, source: 'ecb' } : null);

describe('finance summary', () => {
  it('sums money in, money out and net for one month in EUR', () => {
    const s = summarize({
      today: '2026-10-31', query: { month: '2026-10' }, rates: noRates,
      rows: [
        row('in1', { entryType: 'income', amount: '3000', paidDate: '2026-10-05', sourceType: 'sponsor-receipt' }),
        row('out1', { entryType: 'expense', amount: '120.50', paidDate: '2026-10-07' }),
        row('sep', { entryType: 'expense', amount: '999', paidDate: '2026-09-30' }),
      ],
    });
    assert.equal(s.totals.moneyIn, 3000);
    assert.equal(s.totals.moneyOut, 120.5);
    assert.equal(s.totals.net, 2879.5);
    assert.equal(s.totals.entryCount, 2);
    assert.deepEqual(s.months.map((m) => m.month), ['2026-10']);
  });

  it('books a row by its paid date, not its invoice date', () => {
    const s = summarize({ today: '2026-10-31', query: { month: '2026-10' }, rates: noRates, rows: [
      row('late', { entryType: 'expense', amount: '50', transactionDate: '2026-09-28', paidDate: '2026-10-02' }),
      row('unpaid-date', { entryType: 'expense', amount: '7', transactionDate: '2026-10-03' }),
    ] });
    assert.equal(s.totals.moneyOut, 57);
  });

  it('counts a payment once when the bookkeeping sheet repeats a sponsor receipt', () => {
    const rows = [
      row('receipt', { entryType: 'income', amount: '9000', paidDate: '2026-10-20', sourceType: 'sponsor-receipt', counterparty: 'Astro Synthetic, Inc.' }),
      row('sheet-copy', { entryType: 'income', amount: '9000.00', paidDate: '2026-10-21', sourceType: 'spreadsheet', counterparty: 'ASTRO SYNTHETIC INC' }),
      row('sheet-other', { entryType: 'income', amount: '9000', paidDate: '2026-10-22', sourceType: 'spreadsheet', counterparty: 'Other Payer' }),
    ];
    const s = summarize({ today: '2026-10-31', query: { month: '2026-10' }, rates: noRates, rows });
    assert.equal(s.totals.moneyIn, 18000);
    assert.deepEqual(s.duplicates, [{ keptId: 'receipt', droppedId: 'sheet-copy', reason: 'sheet row repeats sponsor-receipt row' }]);
  });

  it('pairs each system row with at most one sheet row and never dedupes two system rows', () => {
    const rows = [
      row('r1', { entryType: 'income', amount: '2700', paidDate: '2026-10-01', sourceType: 'sponsor-receipt', counterparty: 'Same Co' }),
      row('r2', { entryType: 'income', amount: '2700', paidDate: '2026-10-02', sourceType: 'sponsor-receipt', counterparty: 'Same Co' }),
      row('s1', { entryType: 'income', amount: '2700', paidDate: '2026-10-01', counterparty: 'Same Co' }),
    ];
    const { kept, duplicates } = dedupe(rows);
    assert.deepEqual(kept.map((r) => r.id), ['r1', 'r2']);
    assert.equal(duplicates.length, 1);
  });

  it('does not count a bank line that a ledger row already explains, and lists one that none does', () => {
    const rows = [row('inv', { entryType: 'expense', amount: '858', currency: 'USD', amountEur: '753.10', paidDate: '2026-10-22', sourceType: 'invoice' })];
    const lines = [
      { accountId: 'business-1', date: '2026-10-23', amount: '-753.10', currency: 'EUR' },
      { accountId: 'business-1', date: '2026-10-24', amount: '-20.00', currency: 'EUR' },
      { accountId: 'business-1', date: '2026-10-23', amount: '753.10', currency: 'EUR' },
    ];
    assert.deepEqual(unmatchedStatementLines(lines, rows).map((l) => l.amount), ['-20.00', '753.10']);
    const s = summarize({ today: '2026-10-31', query: { month: '2026-10' }, rates: noRates, rows, statementLines: lines });
    assert.equal(s.totals.moneyOut, 753.1);
    assert.equal(s.totals.moneyIn, 0);
    assert.equal(s.gaps.find((g) => g.kind === 'bank-line-without-ledger-row')?.count, 2);
  });

  it('converts with the booked EUR amount first, the ECB rate second, and lists rows it cannot convert', () => {
    const rows = [
      row('booked', { entryType: 'expense', amount: '10.00', currency: 'USD', amountEur: '8.73', paidDate: '2026-10-22' }),
      row('ecb', { entryType: 'income', amount: '6000', currency: 'USD', paidDate: '2026-10-25' }),
      row('gbp', { entryType: 'expense', amount: '5', currency: 'GBP', paidDate: '2026-10-25' }),
    ];
    const s = summarize({ today: '2026-10-31', query: { month: '2026-10' }, rates: usdAt(1.12, '2026-10-23'), rows });
    const byId = Object.fromEntries(s.conversions.map((c) => [c.id, c]));
    assert.deepEqual(byId.booked, { id: 'booked', date: '2026-10-22', amount: '10.00', currency: 'USD', eur: 8.73, rate: 1.145475, rateDate: '2026-10-22', rateSource: 'booked' });
    assert.equal(byId.ecb.eur, 5357.14);
    assert.equal(byId.ecb.rate, 1.12);
    assert.equal(byId.ecb.rateDate, '2026-10-23');
    assert.equal(byId.ecb.rateSource, 'ecb');
    assert.equal(byId.gbp.eur, null);
    assert.equal(s.totals.moneyIn, 5357.14);
    assert.equal(s.totals.moneyOut, 8.73);
    assert.equal(s.totals.unconvertedCount, 1);
    assert.deepEqual(s.gaps.find((g) => g.kind === 'unconverted')?.ids, ['gbp']);
    assert.deepEqual(s.gaps.find((g) => g.kind === 'no-booked-eur')?.ids, ['ecb']);
    const usd = s.byCurrency.find((c) => c.currency === 'USD')!;
    assert.deepEqual(usd, { currency: 'USD', moneyIn: '6000.00', moneyOut: '10.00', moneyInEur: 5357.14, moneyOutEur: 8.73 });
  });

  it('computes net profit excluding VAT with taxes, TK and VAT payments on their own lines', () => {
    const rows = [
      row('sale', { entryType: 'income', amount: '1190', vatAmount: '190', paidDate: '2026-10-02' }),
      row('reverse-charge', { entryType: 'income', amount: '1000', vatAmount: '0', paidDate: '2026-10-03' }),
      row('tool', { entryType: 'expense', amount: '119', vatAmount: '19', paidDate: '2026-10-04' }),
      row('usd-tool', { entryType: 'expense', amount: '112', currency: 'USD', vatAmount: '11.2', paidDate: '2026-10-04' }),
      row('refund', { entryType: 'income', subtype: 'Refund', amount: '11.90', vatAmount: '1.90', paidDate: '2026-10-05' }),
      row('vat-paid', { entryType: 'expense', category: 'VAT', amount: '150', paidDate: '2026-10-10' }),
      row('gewst', { entryType: 'expense', category: 'Taxes', amount: '3296', paidDate: '2026-10-15' }),
      row('tk', { entryType: 'expense', category: 'Health Insurance', amount: '1179.36', paidDate: '2026-10-16' }),
      row('no-vat', { entryType: 'expense', amount: '10', paidDate: '2026-10-17' }),
    ];
    const t = summarize({ today: '2026-10-31', query: { month: '2026-10' }, rates: usdAt(1.12, '2026-10-03'), rows }).totals;
    assert.equal(t.operatingIncome, 2190);
    assert.equal(t.outputVat, 190);
    assert.equal(t.operatingExpenses, 217.1);
    assert.equal(t.inputVat, 27.1);
    assert.equal(t.incomeNetOfVat, 2000);
    assert.equal(t.expensesNetOfVat, 100 + 90 - 10 + 10);
    assert.equal(t.netProfitExVat, 1810);
    assert.equal(t.projectedVat, 162.9);
    assert.equal(t.vatPaid, 150);
    assert.equal(t.otherTaxes, 3296);
    assert.equal(t.healthInsurance, 1179.36);
    assert.equal(t.netAfterTaxes, -2665.36);
    assert.equal(t.vatUnknownCount, 1);
    assert.equal(t.moneyOut, 4854.36);
    assert.equal(t.moneyIn, 2201.9);
  });

  it('splits a year into twelve months, marks future ones, and ytd stops at the current month', () => {
    const rows = [row('a', { entryType: 'income', amount: '1', paidDate: '2026-01-15' }), row('b', { entryType: 'income', amount: '2', paidDate: '2026-11-01' })];
    const year = summarize({ today: '2026-10-31', query: { year: '2026' }, rates: noRates, rows });
    assert.equal(year.months.length, 12);
    assert.equal(year.months.filter((m) => m.future).map((m) => m.month).join(), '2026-11,2026-12');
    assert.equal(year.totals.moneyIn, 3);
    const ytd = summarize({ today: '2026-10-31', query: { ytd: true }, rates: noRates, rows });
    assert.equal(ytd.months.length, 10);
    assert.equal(ytd.totals.moneyIn, 1);
    assert.deepEqual(resolvePeriod({ month: '2026-02' }, '2026-10-31'), { kind: 'month', label: '2026-02', from: '2026-02-01', to: '2026-02-28', months: ['2026-02'] });
  });

  it('lists pending drafts and months without bank statements as gaps without counting them', () => {
    const s = summarize({
      today: '2026-10-31', query: { month: '2026-10' }, rates: noRates, rows: [],
      pendingInvoices: [{ id: 'draft', date: '2026-10-12', amount: '180', currency: 'EUR' }],
      businessAccounts: ['business-1', 'business-2'],
      statementCoverage: [{ accountId: 'business-1', month: '2026-10' }],
    });
    assert.equal(s.totals.moneyOut, 0);
    assert.deepEqual(s.gaps.map((g) => g.kind), ['pending-invoices', 'missing-statement']);
    assert.match(s.gaps[1].message, /business-2/);
  });

  it('validates the period query', () => {
    assert.deepEqual(parsePeriodQuery({ month: '2026-10' }), { month: '2026-10' });
    assert.deepEqual(parsePeriodQuery({ ytd: '1' }), { ytd: true });
    assert.equal(typeof parsePeriodQuery({ month: '2026-13' }), 'string');
    assert.equal(typeof parsePeriodQuery({ month: '2026-10', year: '2026' }), 'string');
    assert.equal(typeof parsePeriodQuery({}), 'string');
  });
});

describe('ECB rates', () => {
  const csv = 'KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE,OBS_STATUS\nEXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-10-22,1.1201,A\nEXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-10-23,1.1188,A\n';

  it('parses the csvdata format', () => {
    assert.deepEqual([...parseEcbCsv(csv)], [['2026-10-22', 1.1201], ['2026-10-23', 1.1188]]);
  });

  it('uses the last published rate for a weekend and fetches once per currency', async () => {
    clearEcbRateCacheForTests();
    const urls: string[] = [];
    const fetchImpl = async (url: string) => { urls.push(url); return { ok: true, status: 200, text: async () => csv }; };
    const { lookup, errors } = await loadEcbRates([{ currency: 'USD', date: '2026-10-25' }, { currency: 'USD', date: '2026-10-23' }, { currency: 'EUR', date: '2026-10-25' }], fetchImpl);
    assert.deepEqual(errors, []);
    assert.equal(urls.length, 1);
    assert.match(urls[0], /D\.USD\.EUR\.SP00\.A\?startPeriod=2026-10-13&endPeriod=2026-10-25/);
    assert.deepEqual(lookup('USD', '2026-10-25'), { currency: 'USD', rate: 1.1188, date: '2026-10-23', source: 'ecb' });
    await loadEcbRates([{ currency: 'USD', date: '2026-10-24' }], fetchImpl);
    assert.equal(urls.length, 1);
  });

  it('reports a failed fetch instead of failing the summary', async () => {
    clearEcbRateCacheForTests();
    const { lookup, errors } = await loadEcbRates([{ currency: 'USD', date: '2026-10-25' }], async () => ({ ok: false, status: 503, text: async () => '' }));
    assert.deepEqual(errors, ['ECB USD: HTTP 503']);
    assert.equal(lookup('USD', '2026-10-25'), null);
  });
});
