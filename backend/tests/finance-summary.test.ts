import { describe, it } from 'node:test';
import assert from 'node:assert';
import { dedupe, resolvePeriod, summarize, unmatchedStatementLines, type LedgerRow, type RateLookup } from '../src/finance/summary';
import { clearEcbRateCacheForTests, loadEcbRates, parseEcbCsv } from '../src/finance/rates';
import { financeStatementLines, parsePeriodQuery } from '../src/finance/service';
import { bankRowsFrom } from '../src/reconcile/monthService';
import { pairAll, DEFAULT_TOLERANCES } from '../src/reconcile/month';
import { businessAccountStatementRequirement } from '../src/finance/businessAccounts';

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
      { bankKey: 'bank-inv', accountId: 'business-1', date: '2026-10-23', amount: '-753.10', currency: 'EUR' },
      { accountId: 'business-1', date: '2026-10-24', amount: '-20.00', currency: 'EUR' },
      { accountId: 'business-1', date: '2026-10-23', amount: '753.10', currency: 'EUR' },
    ];
    assert.deepEqual(unmatchedStatementLines(lines, rows, new Map([['bank-inv', 'inv']])).map((l) => l.amount), ['-20.00', '753.10']);
    const s = summarize({ today: '2026-10-31', query: { month: '2026-10' }, rates: noRates, rows, statementLines: lines, statementPairs: new Map([['bank-inv', 'inv']]) });
    assert.equal(s.totals.moneyOut, 753.1);
    assert.equal(s.totals.moneyIn, 0);
    assert.equal(s.gaps.find((g) => g.kind === 'bank-line-without-ledger-row')?.count, 2);
  });

  it('counts bank-only TK and Finanzamt debits while deduping a matching ledger tax row', () => {
    const s = summarize({
      today: '2026-04-30', query: { month: '2026-04' }, rates: noRates,
      rows: [row('eink', { entryType: 'expense', amount: '1000.00', paidDate: '2026-04-08', category: 'Taxes', counterparty: 'Finanzamt', description: 'EINK.ST / SOLI' })],
      statementLines: [
        { id: 'finom:tk', accountId: 'finom', date: '2026-04-16', amount: '-1179.36', currency: 'EUR', counterparty: 'Techniker Krankenkasse', reference: 'TK-BuchNr 06408502800 Monat 03/26' },
        { id: 'finom:vat', accountId: 'finom', date: '2026-04-14', amount: '-4581.14', currency: 'EUR', counterparty: 'Finanzamt', reference: 'UMS.ST 2025' },
        { id: 'finom:eink', bankKey: 'bank-eink', accountId: 'finom', date: '2026-04-14', amount: '-1000.00', currency: 'EUR', counterparty: 'Finanzamt', reference: 'EINK.ST / SOLI' },
        { id: 'finom:unrelated', accountId: 'finom', date: '2026-04-20', amount: '-20.00', currency: 'EUR', counterparty: 'Synthetic Vendor', reference: 'Unrelated purchase' },
      ],
      statementPairs: new Map([['bank-eink', 'eink']]),
    });
    assert.equal(s.totals.healthInsurance, 1179.36);
    assert.equal(s.totals.vatPaid, 4581.14);
    assert.equal(s.totals.incomeTax, 1000);
    assert.equal(s.totals.otherTaxes, 0);
    assert.equal(s.totals.taxesTotal, 2179.36);
    assert.equal(s.totals.moneyOut, 6760.5);
    assert.equal(s.totals.entryCount, 3);
    assert.equal(s.gaps.find((gap) => gap.kind === 'bank-line-without-ledger-row')?.count, 1);
    assert.deepEqual(s.entries.filter((entry) => entry.sourceType === 'statement').map((entry) => [entry.id, entry.mandatoryKind, entry.line]), [
      ['finom:vat', 'tax_debit', 'vat'],
      ['finom:tk', 'tk_debit', 'health-insurance'],
    ]);
  });

  it('classifies USt in Taxes as VAT while ESt and GewSt remain other taxes', () => {
    const rows = [
      row('vat-2025', { entryType: 'expense', amount: '1029.96', paidDate: '2025-02-14', category: 'Taxes', counterparty: 'Finanzamt', description: 'UMS.ST 1VJ.25' }),
      row('vat-2026', { entryType: 'expense', amount: '4196.60', paidDate: '2026-08-15', category: 'Taxes', counterparty: 'Finanzamt', description: 'UMS.ST 2VJ.26' }),
      row('eink', { entryType: 'expense', amount: '11042.00', paidDate: '2026-06-10', category: 'Taxes', counterparty: 'Finanzamt', description: 'EINK.ST / SOLI' }),
      row('gewst', { entryType: 'expense', amount: '3296.00', paidDate: '2026-08-15', category: 'Taxes', counterparty: 'Finanzamt', description: 'GEW.ST 2026' }),
    ];
    const feb = summarize({ today: '2026-10-31', query: { month: '2025-02' }, rates: noRates, rows });
    const aug = summarize({ today: '2026-10-31', query: { month: '2026-08' }, rates: noRates, rows });
    assert.equal(feb.totals.vatPaid, 1029.96);
    assert.equal(aug.totals.vatPaid, 4196.6);
    assert.equal(aug.totals.tradeTax, 3296);
    assert.equal(aug.totals.otherTaxes, 0);
    const jun = summarize({ today: '2026-10-31', query: { month: '2026-06' }, rates: noRates, rows });
    assert.equal(jun.totals.incomeTax, 11042);
  });

  it('splits generic Finanzamt Taxes rows into GewSt and ESt by the matched bank purpose', () => {
    const generic = { entryType: 'expense', category: 'Taxes', counterparty: 'Finanzamt Synthetic', description: 'Finanzamt Synthetic' };
    const s = summarize({
      today: '2026-12-31', query: { year: '2026' }, rates: noRates,
      rows: [
        row('gewst-q1', { ...generic, amount: '3296.00', paidDate: '2026-02-17' }),
        row('est-q1', { ...generic, amount: '11042.00', paidDate: '2026-03-17' }),
        row('refund', { entryType: 'income', category: 'Taxes', amount: '43633.73', counterparty: 'Finanzamt Synthetic', description: 'Erstattung', paidDate: '2026-10-30' }),
      ],
      statementLines: [
        { id: 'f:1', bankKey: 'bank-gewst', accountId: 'finom', date: '2026-02-17', amount: '-3296.00', currency: 'EUR', counterparty: 'Finanzamter', reference: 'STEUERNR 00/000/00000 GEW.ST 1VJ.26 3.296,00EUR' },
        { id: 'f:2', bankKey: 'bank-est', accountId: 'finom', date: '2026-03-17', amount: '-11042.00', currency: 'EUR', counterparty: 'Finanzamter', reference: 'STEUERNR 00/000/00000 EINK.ST 1VJ.26 11.042,00EUR' },
      ],
      statementPairs: new Map([['bank-gewst', 'gewst-q1'], ['bank-est', 'est-q1']]),
    });
    assert.equal(s.totals.tradeTax, 3296);
    assert.equal(s.totals.incomeTax, 11042);
    assert.equal(s.totals.otherTaxes, 0);
    assert.equal(s.totals.taxesTotal, 14338);
    assert.equal(s.totals.taxRefunds, 43633.73);
    assert.equal(s.months.find((m) => m.month === '2026-10')?.taxesTotal, 0);
    const credit = s.entries.find((e) => e.id === 'refund');
    assert.equal(credit?.direction, 'in');
    assert.equal(credit?.mandatoryKind, 'tax_refund');
    assert.deepEqual(s.taxRefunds.map(({ id, eur }) => [id, eur]), [['refund', 43633.73]]);
    assert.equal(s.entries.find((e) => e.id === 'gewst-q1')?.mandatoryKind, 'tax_debit');
  });

  it('attributes a multi-year Finanzamt refund to its assessed tax years and omits it from the bank year', () => {
    const refundId = '37865149b2143fc299d8e635bda9fb5cac57e43e8f5c5c2837049bbf53b1febd';
    const rows = [
      row('est-2024', { entryType: 'expense', category: 'Taxes', amount: '881.09', counterparty: 'Finanzamt Synthetic', description: 'EINK.ST 2024', paidDate: '2024-06-10' }),
      row('est-2025', { entryType: 'expense', category: 'Taxes', amount: '11042.00', counterparty: 'Finanzamt Synthetic', description: 'EINK.ST 2025', paidDate: '2025-03-10' }),
      row('gewst-2026', { entryType: 'expense', category: 'Taxes', amount: '3296.00', counterparty: 'Finanzamt Synthetic', description: 'GEW.ST 2026', paidDate: '2026-08-15' }),
      row(refundId, {
        entryType: 'income',
        category: 'Taxes',
        amount: '43633.73',
        counterparty: 'ZAHLUNGSVERKEHR BERLINER',
        description: 'Finanzamt tax refund (Erstattung)',
        paidDate: '2026-10-30',
        sourceType: 'statement',
        taxYearAttribution: { '2024': '27729.10', '2025': '15904.63' },
      }),
    ];
    const statementLines = [
      { id: 'finom:refund', bankKey: 'bank-refund', accountId: 'finom', date: '2026-10-30', amount: '43633.73', currency: 'EUR', counterparty: 'ZAHLUNGSVERKEHR BERLINER', reference: 'Finanzamt Erstattung' },
    ];
    const statementPairs = new Map([['bank-refund', refundId]]);

    const y2026 = summarize({ today: '2026-11-12', query: { year: '2026' }, rates: noRates, rows, statementLines, statementPairs });
    assert.equal(y2026.totals.taxRefunds, 0);
    assert.deepEqual(y2026.taxRefunds, []);
    assert.equal(y2026.totals.tradeTax, 3296);
    assert.equal(y2026.totals.otherTaxes, 0);
    assert.equal(y2026.totals.taxesTotal, 3296);
    assert.equal(y2026.months.find((m) => m.month === '2026-10')?.taxRefunds, 0);
    assert.equal(y2026.gaps.some((g) => g.kind === 'bank-line-without-ledger-row'), false);

    const m202610 = summarize({ today: '2026-11-12', query: { month: '2026-10' }, rates: noRates, rows, statementLines, statementPairs });
    assert.equal(m202610.totals.taxRefunds, 0);
    assert.deepEqual(m202610.taxRefunds, []);

    const y2024 = summarize({ today: '2026-11-12', query: { year: '2024' }, rates: noRates, rows, statementLines, statementPairs });
    assert.equal(y2024.totals.taxRefunds, 27729.1);
    assert.equal(y2024.totals.incomeTax, 881.09);
    assert.equal(y2024.totals.otherTaxes, 0);
    assert.equal(y2024.totals.taxesTotal, 881.09);
    assert.deepEqual(y2024.taxRefunds.map(({ id, date, month, taxYear, eur }) => ({ id, date, month, taxYear, eur })), [
      { id: refundId, date: '2026-10-30', month: '2026-10', taxYear: '2024', eur: 27729.1 },
    ]);

    const y2025 = summarize({ today: '2026-11-12', query: { year: '2025' }, rates: noRates, rows, statementLines, statementPairs });
    assert.equal(y2025.totals.taxRefunds, 15904.63);
    assert.equal(y2025.totals.incomeTax, 11042);
    assert.equal(y2025.totals.otherTaxes, 0);
    assert.equal(y2025.totals.taxesTotal, 11042);
    assert.deepEqual(y2025.taxRefunds.map(({ id, date, month, taxYear, eur }) => ({ id, date, month, taxYear, eur })), [
      { id: refundId, date: '2026-10-30', month: '2026-10', taxYear: '2025', eur: 15904.63 },
    ]);
  });

  it('uses the matched statement purpose to classify a generic Taxes ledger row as VAT paid', () => {
    const s = summarize({
      today: '2026-08-31', query: { month: '2026-08' }, rates: noRates,
      rows: [row('ust-ledger', {
        entryType: 'expense', amount: '4196.60', paidDate: '2026-08-15', category: 'Taxes',
        counterparty: 'Finanzamt Charlottenburg', description: 'Finanzamt Charlottenburg',
      })],
      statementLines: [{
        id: 'finom:ust-august', bankKey: 'bank-ust', accountId: 'finom', date: '2026-08-15', amount: '-4196.60',
        currency: 'EUR', counterparty: 'Finanzamt Charlottenburg', reference: 'UMS.ST 2VJ.26 4.196,60EUR',
      }],
      statementPairs: new Map([['bank-ust', 'ust-ledger']]),
    });
    assert.equal(s.totals.vatPaid, 4196.6);
    assert.equal(s.totals.otherTaxes, 0);
    assert.equal(s.totals.moneyOut, 4196.6);
    assert.equal(s.entries.length, 1);
    assert.deepEqual([s.entries[0].id, s.entries[0].line, s.entries[0].mandatoryKind], ['ust-ledger', 'vat', 'tax_debit']);
  });

  it('derives VAT only from stored document fields and handles zero-rate and reverse-charge documents', () => {
    const s = summarize({ today: '2026-10-31', query: { month: '2026-10' }, rates: usdAt(1, '2026-10-07'), rows: [
      row('scalevector', { entryType: 'income', amount: '5950.00', paidDate: '2026-10-04', documentExtraction: { netAmount: '5000.00', vatAmount: '950.00', vatCurrency: 'EUR', vatRate: '19', amount: '5950.00', currency: 'EUR', reverseCharge: false } }),
      row('zero-rated', { entryType: 'expense', amount: '100.00', paidDate: '2026-10-05', documentExtraction: { netAmount: '100.00', vatAmount: '0.00', vatCurrency: 'EUR', vatRate: '0', amount: '100.00', currency: 'EUR', reverseCharge: false } }),
      row('reverse-charge', { entryType: 'expense', amount: '100.00', paidDate: '2026-10-06', documentExtraction: { netAmount: '100.00', netAmountEur: '100.00', vatAmount: '0.00', vatAmountEur: '0.00', vatCurrency: 'EUR', vatRate: '19', amount: '100.00', currency: 'EUR', reverseCharge: true } }),
      row('unknown-vat', { entryType: 'expense', amount: '50.00', currency: 'USD', paidDate: '2026-10-07' }),
    ] });
    const byId = Object.fromEntries(s.entries.map((entry) => [entry.id, entry]));
    assert.equal(byId.scalevector.vatEur, 950);
    assert.equal(byId.scalevector.vatAmount, '950.00');
    assert.equal(byId.scalevector.vatRate, '19');
    assert.equal(byId['zero-rated'].zeroRated, true);
    assert.equal(byId['zero-rated'].vatAmount, '0.00');
    assert.equal(byId['reverse-charge'].reverseCharge, true);
    assert.equal(byId['reverse-charge'].reverseChargeVatEur, 19);
    assert.equal(byId['unknown-vat'].vatEur, 0);
    assert.equal(byId['unknown-vat'].vatAmount, '0.00');
    assert.equal(byId['unknown-vat'].vatCurrency, 'USD');
    assert.equal(s.totals.outputVat, 969);
    assert.equal(s.totals.inputVat, 19);
    assert.equal(s.totals.projectedVat, 950);
    assert.equal(s.totals.expensesNetOfVat, 250);
  });

  it('converts with the booked EUR amount first, the ECB rate second, and lists rows it cannot convert', () => {
    const rows = [
      row('booked', { entryType: 'expense', amount: '10.00', currency: 'USD', amountEur: '8.73', rateSource: 'ECB 22 Oct 2026', category: 'Tools', subtype: 'Subscription', paidDate: '2026-10-22' }),
      row('ecb', { entryType: 'income', amount: '6000', currency: 'USD', paidDate: '2026-10-25' }),
      row('gbp', { entryType: 'expense', amount: '5', currency: 'GBP', paidDate: '2026-10-25' }),
    ];
    const s = summarize({ today: '2026-10-31', query: { month: '2026-10' }, rates: usdAt(1.12, '2026-10-23'), rows });
    const byId = Object.fromEntries(s.entries.filter((entry) => entry.currency !== 'EUR').map((entry) => [entry.id, entry]));
    assert.equal('conversions' in s, false);
    assert.equal(byId.booked.date, '2026-10-22');
    assert.equal(byId.booked.amount, '10.00');
    assert.equal(byId.booked.currency, 'USD');
    assert.equal(byId.booked.amountEur, '8.73');
    assert.equal(byId.booked.bookedRateSource, 'ECB 22 Oct 2026');
    assert.equal(byId.booked.eur, 8.73);
    assert.equal(byId.booked.rate, 1.145475);
    assert.equal(byId.booked.rateDate, '2026-10-22');
    assert.equal(byId.booked.rateSource, 'booked');
    const bookedEntry = s.entries.find((entry) => entry.id === 'booked');
    assert.equal(bookedEntry?.category, 'Tools');
    assert.equal(bookedEntry?.subtype, 'Subscription');
    assert.equal(bookedEntry?.amountEur, '8.73');
    assert.equal(bookedEntry?.bookedRateSource, 'ECB 22 Oct 2026');
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
      row('refund', { entryType: 'expense', subtype: 'Refund', amount: '11.90', vatAmount: '1.90', paidDate: '2026-10-05' }),
      row('vat-paid', { entryType: 'expense', category: 'VAT', amount: '150', paidDate: '2026-10-10' }),
      row('gewst', { entryType: 'expense', category: 'Taxes', amount: '3296', paidDate: '2026-10-15' }),
      row('tk', { entryType: 'expense', category: 'Health Insurance', amount: '1179.36', paidDate: '2026-10-16' }),
      row('no-vat', { entryType: 'expense', amount: '10', paidDate: '2026-10-17' }),
    ];
    const summary = summarize({ today: '2026-10-31', query: { month: '2026-10' }, rates: usdAt(1.12, '2026-10-03'), rows });
    const t = summary.totals;
    assert.equal(t.operatingIncome, 2190);
    assert.equal(t.outputVat, 190);
    assert.equal(t.operatingExpenses, 217.1);
    assert.equal(t.inputVat, 27.1);
    assert.equal(t.incomeNetOfVat, 2000);
    assert.equal(t.expensesNetOfVat, 190);
    assert.equal(t.netProfitExVat, 1810);
    assert.equal(t.projectedVat, 162.9);
    assert.equal(t.vatPaid, 150);
    assert.equal(t.otherTaxes, 3296);
    assert.equal(t.healthInsurance, 1179.36);
    assert.equal(t.taxesTotal, 4475.36);
    assert.equal(t.netAfterTaxes, -2665.36);
    assert.equal('vatUnknownCount' in t, false);
    assert.equal(summary.gaps.some((gap) => gap.kind === 'vat-unknown'), false);
    assert.equal(t.moneyOut, 4854.36);
    assert.equal(t.moneyIn, 2190);
  });

  it('keeps tax refunds out of money in and net cash, lists them separately, and never as a negative tax', () => {
    const rows = [
      row('sale', { entryType: 'income', amount: '1190', vatAmount: '190', paidDate: '2026-10-02' }),
      row('tax-refund', { entryType: 'income', amount: '4000', category: 'Taxes', counterparty: 'Finanzamt', description: 'ESt prepayment refund', paidDate: '2026-10-03' }),
      row('tax-payment', { entryType: 'expense', amount: '100', category: 'Taxes', counterparty: 'Finanzamt', description: 'EINK.ST', paidDate: '2026-10-04' }),
      row('insurance', { entryType: 'expense', amount: '1179.36', category: 'Health Insurance', counterparty: 'TK', paidDate: '2026-10-05' }),
      row('owner-draw', { entryType: 'expense', amount: '2500', category: 'Owner pay', ownerPayType: 'draw', paidDate: '2026-10-06' }),
      row('vat-refund', { entryType: 'income', amount: '30', category: 'VAT', counterparty: 'Finanzamt', description: 'UMS.ST refund', paidDate: '2026-10-07' }),
    ];
    const summary = summarize({ today: '2026-10-31', query: { month: '2026-10' }, rates: noRates, rows });
    const t = summary.totals;
    // Money in is operating income only: a Finanzamt refund is cash back, not
    // income, and stays out of money in and net cash.
    assert.equal(t.moneyIn, 1190);
    assert.equal(summary.months[0].moneyIn, 1190);
    assert.equal(t.moneyOut, 3779.36);
    assert.equal(t.net, -2589.36);
    assert.equal(summary.months[0].net, -2589.36);
    assert.equal(t.operatingIncome, 1190);
    assert.equal(t.netProfitExVat, 1000);
    assert.equal(t.incomeTax, 100);
    assert.equal(t.tradeTax, 0);
    assert.equal(t.otherTaxes, 0);
    assert.equal(t.healthInsurance, 1179.36);
    assert.equal(t.taxesTotal, 1279.36);
    assert.equal(t.taxRefunds, 4000);
    assert.equal(t.vatRefunded, 30);
    assert.equal(t.ownerPay, 2500);
    assert.equal(t.netAfterTaxes, -279.36);
    assert.equal(t.netAfterOwnerPay, -2779.36);
    assert.deepEqual(summary.taxRefunds.map(({ id, date, eur }) => [id, date, eur]), [['tax-refund', '2026-10-03', 4000]]);
    assert.equal(summary.months[0].taxRefunds, 4000);
    assert.equal(summary.months[0].otherTaxes, 0);
    assert.deepEqual(summary.entries.map(({ id, line, direction }) => [id, line, direction]), [
      ['sale', 'operating', 'in'],
      ['tax-refund', 'taxes', 'in'],
      ['tax-payment', 'taxes', 'out'],
      ['insurance', 'health-insurance', 'out'],
      ['owner-draw', 'owner-pay', 'out'],
      ['vat-refund', 'vat', 'in'],
    ]);
  });

  it('books a credit-note row as contra-expense: not money in, not revenue, whatever its entryType', () => {
    const rows = [
      row('cn', { entryType: 'expense', amount: '646.63', currency: 'USD', paidDate: '2026-10-30', sourceType: 'manual', sourceKey: 'credit-note:A1B2C3D4-0059-CN-01' }),
      row('sale', { entryType: 'income', amount: '1000', paidDate: '2026-10-02', vatAmount: '0' }),
    ];
    const t = summarize({ today: '2026-10-31', query: { month: '2026-10' }, rates: usdAt(1.1, '2026-10-30'), rows }).totals;
    assert.equal(t.moneyIn, 1000);
    assert.equal(t.moneyOut, 0);
    assert.equal(t.operatingIncome, 1000);
    assert.equal(t.operatingExpenses, -587.85);
    assert.equal(t.expensesNetOfVat, -587.85);
    assert.equal(t.netProfitExVat, 1587.85);
    // Rows recorded before the contra-expense change carry entryType income.
    const legacy = summarize({ today: '2026-10-31', query: { month: '2026-10' }, rates: usdAt(1.1, '2026-10-30'), rows: rows.map(({ entryType, ...rest }) => (entryType === 'expense' && String(rest.sourceKey || '').startsWith('credit-note:') ? { entryType: 'income', ...rest } : { entryType, ...rest })) }).totals;
    assert.equal(legacy.moneyIn, 1000);
    assert.equal(legacy.netProfitExVat, 1587.85);
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
      businessAccounts: [{ id: 'revolut' }, { id: 'finom' }],
      statementCoverage: [{ accountId: 'revolut', month: '2026-10' }],
    });
    assert.equal(s.totals.moneyOut, 0);
    assert.deepEqual(s.gaps.map((g) => g.kind), ['pending-invoices', 'missing-statement']);
    assert.match(s.gaps[1].message, /finom/);
  });

  it('stops requiring legacy business setup statements after September 2026', () => {
    const businessAccounts = ['business-1', 'business-2', 'revolut', 'finom'].map(businessAccountStatementRequirement);
    const october = summarize({
      today: '2026-10-31', query: { month: '2026-10' }, rates: noRates, rows: [], businessAccounts,
      statementCoverage: [
        { accountId: 'revolut', month: '2026-10' },
        { accountId: 'finom', month: '2026-10' },
      ],
    });
    assert.equal(october.gaps.some((gap) => gap.kind === 'missing-statement'), false);

    const september = summarize({
      today: '2026-09-30', query: { month: '2026-09' }, rates: noRates, rows: [], businessAccounts,
      statementCoverage: [{ accountId: 'business-1', month: '2026-09' }],
    });
    assert.match(september.gaps.find((gap) => gap.kind === 'missing-statement')?.message || '', /business-2/);
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

it('uses the reconciliation bank identity for mandatory statement entries', () => {
  const statement = {
    id: 'synthetic-statement', recordType: 'reconcile-statement', accountId: 'synthetic-account',
    period: '2026-04', createdAt: '2026-05-01T00:00:00Z', updatedAt: '2026-05-01T00:00:00Z',
    rows: [{ date: '2026-04-16', amount: '-123.45', currency: 'EUR',
      counterparty: 'Techniker Krankenkasse', reference: 'synthetic contribution' }],
  } as any;
  const bank = bankRowsFrom([statement]);
  const lines = financeStatementLines([statement]);
  const summary = summarize({ today: '2026-05-01', query: { month: '2026-04' },
    rates: noRates, rows: [], statementLines: lines, statementPairs: new Map() });
  assert.strictEqual(summary.entries.length, 1);
  assert.strictEqual(summary.entries[0].bankKey, bank[0].key);
  assert.notStrictEqual(summary.entries[0].id, bank[0].key);
  assert.strictEqual(summary.entries[0].mandatoryKind, 'tk_debit');
});

it('deduplicates overlapping statements without merging genuine repeated payments', () => {
  const payment = { date: '2026-04-16', amount: '-123.45', currency: 'EUR',
    counterparty: 'Techniker Krankenkasse', reference: 'synthetic contribution' };
  const original = { id: 'synthetic-original', recordType: 'reconcile-statement',
    accountId: 'synthetic-account', period: '2026-04',
    createdAt: '2026-05-01T00:00:00Z', updatedAt: '2026-05-01T00:00:00Z',
    rows: [payment, { ...payment }] } as any;
  const overlap = { ...original, id: 'synthetic-overlap', createdAt: '2026-05-02T00:00:00Z' };
  const statements = [overlap, original];
  const lines = financeStatementLines(statements);
  const bank = bankRowsFrom(statements);
  assert.strictEqual(lines.length, 2);
  assert.deepStrictEqual(lines.map((line) => line.bankKey), bank.map((row) => row.key));
  assert.deepStrictEqual(lines.map((line) => line.id), ['synthetic-original:0', 'synthetic-original:1']);
  const unmatched = summarize({ today: '2026-05-03', query: { month: '2026-04' },
    rates: noRates, rows: [], statementLines: lines, statementPairs: new Map() });
  assert.strictEqual(unmatched.entries.length, 2);
  assert.strictEqual(unmatched.entries.reduce((sum, entry) => sum + (entry.eur || 0), 0), 246.90);
  const onePayment = financeStatementLines([{ ...original, rows: [payment] }, { ...overlap, rows: [payment] }]);
  const matched = summarize({ today: '2026-05-03', query: { month: '2026-04' }, rates: noRates,
    rows: [row('synthetic-ledger', { transactionDate: '2026-04-16', paidDate: '2026-04-16',
      entryType: 'expense', amount: '123.45', counterparty: 'Techniker Krankenkasse',
      category: 'Health Insurance', description: 'synthetic contribution' })], statementLines: onePayment,
    statementPairs: new Map([[onePayment[0].bankKey!, 'synthetic-ledger']]) });
  assert.strictEqual(matched.entries.length, 1);
  assert.strictEqual(matched.entries[0].eur, 123.45);
});

it('does not hide a mandatory bank row when equal ledger candidates are ambiguous', () => {
  const statement = { id: 'synthetic-statement', recordType: 'reconcile-statement',
    accountId: 'synthetic-account', period: '2026-04',
    createdAt: '2026-05-01T00:00:00Z', updatedAt: '2026-05-01T00:00:00Z',
    rows: [{ date: '2026-04-16', amount: '-123.45', currency: 'EUR',
      counterparty: 'Techniker Krankenkasse', reference: 'synthetic contribution' }] } as any;
  const bank = bankRowsFrom([statement]);
  const candidates = ['Vendor Alpha', 'Vendor Beta'].map((counterparty, i) => ({
    id: `candidate-${i}`, date: '2026-04-16', amount: '-123.45', currency: 'EUR',
    counterparty, documents: [],
  }));
  const pairing = pairAll(bank, candidates, { pairs: [], rejected: [], exceptions: {}, proofs: {} }, DEFAULT_TOLERANCES);
  assert.strictEqual(pairing.pairs.size, 0);
  const ledger = candidates.map((candidate) => row(candidate.id, {
    transactionDate: candidate.date, paidDate: candidate.date, entryType: 'expense',
    amount: '123.45', counterparty: candidate.counterparty, description: '',
  }));
  const summary = summarize({ today: '2026-05-03', query: { month: '2026-04' },
    rates: noRates, rows: ledger, statementLines: financeStatementLines([statement]),
    statementPairs: new Map([...pairing.pairs].map(([key, pair]) => [key, pair.ledger.id])) });
  assert.ok(summary.entries.some((entry) => entry.bankKey === bank[0].key),
    'ambiguous payment must remain in mandatory section');
});

it('does not suppress bank evidence paired to an invoice-only candidate', () => {
  const line = { id: 'synthetic-statement:0', bankKey: 'bank-candidate', accountId: 'finom',
    date: '2026-04-16', amount: '-123.45', currency: 'EUR',
    counterparty: 'Techniker Krankenkasse', reference: 'synthetic' };
  const result = summarize({ today: '2026-05-03', query: { month: '2026-04' },
    rates: noRates, rows: [], statementLines: [line],
    statementPairs: new Map([['bank-candidate', 'invoice-candidate-only']]) });
  assert.strictEqual(result.entries.length, 1);
  assert.strictEqual(result.entries[0].bankKey, 'bank-candidate');
});

it('maps pairs to retained ledger rows after sheet/system deduplication', () => {
  const ledger = [
    row('system', { entryType: 'expense', amount: '123.45', paidDate: '2026-04-16',
      counterparty: 'Synthetic vendor', sourceType: 'invoice' }),
    row('sheet', { entryType: 'expense', amount: '123.45', paidDate: '2026-04-16',
      counterparty: 'Synthetic vendor', sourceType: 'spreadsheet' }),
  ];
  const line = { id: 'statement:0', bankKey: 'bank-dedup', accountId: 'finom',
    date: '2026-04-16', amount: '-123.45', currency: 'EUR',
    counterparty: 'Techniker Krankenkasse', reference: 'synthetic' };
  const result = summarize({ today: '2026-05-03', query: { month: '2026-04' },
    rates: noRates, rows: ledger, statementLines: [line],
    statementPairs: new Map([['bank-dedup', 'sheet']]) });
  assert.strictEqual(result.entries.length, 1);
  assert.strictEqual(result.entries[0].id, 'system');
});

it('preserves extra bank evidence when two pairs collapse to one deduplicated ledger row', () => {
  const ledger = [
    row('system', { entryType: 'expense', amount: '123.45', paidDate: '2026-04-16',
      counterparty: 'Synthetic vendor', sourceType: 'invoice' }),
    row('sheet', { entryType: 'expense', amount: '123.45', paidDate: '2026-04-16',
      counterparty: 'Synthetic vendor', sourceType: 'spreadsheet' }),
  ];
  const line = { accountId: 'finom', date: '2026-04-16', amount: '-123.45',
    currency: 'EUR', counterparty: 'Techniker Krankenkasse', reference: 'synthetic' };
  const result = summarize({ today: '2026-05-03', query: { month: '2026-04' }, rates: noRates,
    rows: ledger, statementLines: [
      { ...line, id: 'statement:0', bankKey: 'bank-one' },
      { ...line, id: 'statement:1', bankKey: 'bank-two' },
    ], statementPairs: new Map([['bank-one', 'system'], ['bank-two', 'sheet']]) });
  assert.strictEqual(result.entries.length, 2);
  assert.ok(result.entries.some((entry) => entry.bankKey === 'bank-two'));
});
