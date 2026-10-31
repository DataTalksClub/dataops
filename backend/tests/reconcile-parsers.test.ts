import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseAmount,
  parseStatement,
  parseStatementCsv,
  parseStatementDate,
  parseStatementPdfText,
  parseStatementXlsx,
  statementTotal,
  csvHeaders,
  detectStatementAccount,
} from '../src/reconcile/parsers';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', 'reconcile', name), 'utf8');

/** Minimal single-page PDF with one Helvetica text line per input line. */
function pdf(text: string): Buffer {
  const stream = 'BT /F1 10 Tf 30 750 Td ' + text.split('\n').map((line, i) => (i ? '0 -15 Td ' : '') + `(${line.replace(/[()\\]/g, '\\$&')}) Tj`).join('\n') + ' ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets = [0];
  for (const [i, obj] of objects.entries()) { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${obj}\nendobj\n`; }
  const xref = Buffer.byteLength(out);
  out += 'xref\n0 6\n0000000000 65535 f \n' + offsets.slice(1).map((x) => `${String(x).padStart(10, '0')} 00000 n \n`).join('') + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out);
}

describe('statement parsers', () => {
  it('normalizes the amount formats banks print', () => {
    assert.equal(parseAmount('1,234.56'), '1234.56');
    assert.equal(parseAmount('1.234,56'), '1234.56');
    assert.equal(parseAmount('-12.34'), '-12.34');
    assert.equal(parseAmount('(12.34)'), '-12.34');
    assert.equal(parseAmount('12.34-'), '-12.34');
    assert.equal(parseAmount('+12'), '12.00');
    assert.equal(parseAmount('1500.00'), '1500.00');
    assert.equal(parseAmount('0.00'), '0.00');
    assert.throws(() => parseAmount('n/a'));
    assert.throws(() => parseAmount(''));
  });

  it('normalizes the date formats banks print', () => {
    assert.equal(parseStatementDate('2026-01-02'), '2026-01-02');
    assert.equal(parseStatementDate('02 Jan 2026'), '2026-01-02');
    assert.equal(parseStatementDate('02-Jan-2026'), '2026-01-02');
    assert.equal(parseStatementDate('Jan 2, 2026'), '2026-01-02');
    assert.equal(parseStatementDate('05/03/2026'), '2026-03-05');
    assert.equal(parseStatementDate('05/13/2026', 'auto'), '2026-05-13');
    assert.throws(() => parseStatementDate('31.02.2026'));
  });

  it('parses the revolut-style semicolon layout and skips pending rows', () => {
    const csv = [
      'Type;Product;Started Date;Completed Date;Description;Amount;Fee;Currency;State;Balance',
      'TRANSFER;Current;02 Jan 2026 10:12;02 Jan 2026 10:12;Transfer from Sponsor One;1000.00;0.00;EUR;Completed;5000.00',
      'CARD_PAYMENT;Current;03 Jan 2026;03 Jan 2026;CloudServices GmbH;-12.34;0.00;EUR;Completed;4987.66',
      'TRANSFER;Current;05 Jan 2026;05 Jan 2026;Future transfer;500.00;0.00;EUR;Pending;5487.66',
    ].join('\n');
    const parsed = parseStatementCsv(csv, 'revolut');
    assert.deepEqual(parsed.rows, [
      { date: '2026-01-02', amount: '1000.00', currency: 'EUR', counterparty: 'Transfer from Sponsor One' },
      { date: '2026-01-03', amount: '-12.34', currency: 'EUR', counterparty: 'CloudServices GmbH' },
    ]);
    assert.ok(parsed.warnings.some((warning) => warning.includes('pending')));
    assert.equal(statementTotal(parsed.rows), '987.66');
  });

  it('parses the mercury-style layout with credit/debit types and references', () => {
    const csv = [
      'Date,Description,Category,Subcategory,Type,Amount,Balance,Currency,Status,Reference',
      '2026-02-05,"Sponsor Two, GmbH",Income,Revenue,Credit,2500.00,12000.00,USD,completed,202602/7',
      '2026-02-06,Server rent,Software,Infrastructure,Debit,-120.00,11880.00,USD,completed,',
    ].join('\n');
    const parsed = parseStatementCsv(csv, 'mercury');
    assert.deepEqual(parsed.rows, [
      { date: '2026-02-05', amount: '2500.00', currency: 'USD', counterparty: 'Sponsor Two, GmbH', reference: '202602/7' },
      { date: '2026-02-06', amount: '-120.00', currency: 'USD', counterparty: 'Server rent' },
    ]);
  });

  it('parses money-in/money-out columns for the merchant fallback', () => {
    const csv = [
      'Date,Description,Reference,Money in,Money out,Currency',
      '05/03/2026,Sponsor Three,202603/12,900.00,,EUR',
      '06/03/2026,Office rent,,,75.00,EUR',
    ].join('\n');
    const parsed = parseStatementCsv(csv, 'merchant');
    assert.deepEqual(parsed.rows, [
      { date: '2026-03-05', amount: '900.00', currency: 'EUR', counterparty: 'Sponsor Three', reference: '202603/12' },
      { date: '2026-03-06', amount: '-75.00', currency: 'EUR', counterparty: 'Office rent' },
    ]);
  });

  it('rejects files without a usable header row', () => {
    assert.throws(() => parseStatementCsv('nothing,to,see\n1,2,3\n', 'merchant'), /no (date|amount) column/);
  });

  it('parses a revolut-style PDF statement block layout', () => {
    const text = [
      'Account holder: Synthetic Trading Ltd',
      'Account currency: EUR',
      'Statement period: 01 Jan 2026 - 31 Jan 2026',
      '',
      '02 Jan 2026',
      'Transfer from Sponsor Four',
      'Reference: 202601/44',
      '+1,500.00 EUR',
      'Balance: 9000.00 EUR',
      '03 Jan 2026',
      'Payment to CloudServices GmbH',
      '-99.00 EUR',
      'Balance: 8901.00 EUR',
    ].join('\n');
    const parsed = parseStatementPdfText(text);
    assert.deepEqual(parsed.rows, [
      { date: '2026-01-02', amount: '1500.00', currency: 'EUR', counterparty: 'Sponsor Four', reference: '202601/44' },
      { date: '2026-01-03', amount: '-99.00', currency: 'EUR', counterparty: 'CloudServices GmbH' },
    ]);
  });

  it('extracts PDF statement rows end to end and dispatches on content type', async () => {
    const bytes = pdf([
      'Account currency: EUR',
      '02 Feb 2026',
      'Received payment from Sponsor Five',
      'Reference: 202602/9',
      '+2200.00 EUR',
      'Balance: 12000.00 EUR',
    ].join('\n'));
    const parsed = await parseStatement('application/pdf', bytes, 'merchant');
    // Revolut and Finom PDFs only go through their fixed layouts.
    await assert.rejects(parseStatement('application/pdf', bytes, 'revolut'), /unrecognized revolut PDF statement layout/);
    assert.deepEqual(parsed.rows, [
      { date: '2026-02-02', amount: '2200.00', currency: 'EUR', counterparty: 'Sponsor Five', reference: '202602/9' },
    ]);
  });

  it('reads xlsx workbooks through the same column mapping', async () => {
    const imported = await new Function("return import('exceljs')")() as typeof import('exceljs');
    const ExcelJS = 'Workbook' in imported ? imported : imported.default;
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Statement');
    sheet.addRow(['Date', 'Description', 'Amount', 'Currency', 'Reference']);
    sheet.addRow([new Date('2026-03-01T00:00:00Z'), 'Sponsor Six', 750, 'EUR', '202603/21']);
    sheet.addRow([new Date('2026-03-02T00:00:00Z'), 'Catering', -64.5, 'EUR', '']);
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    const parsed = await parseStatementXlsx(bytes, 'merchant');
    assert.deepEqual(parsed.rows, [
      { date: '2026-03-01', amount: '750.00', currency: 'EUR', counterparty: 'Sponsor Six', reference: '202603/21' },
      { date: '2026-03-02', amount: '-64.50', currency: 'EUR', counterparty: 'Catering' },
    ]);
  });

  it('parses the current Revolut Business all-accounts export', () => {
    const parsed = parseStatementCsv(fixture('revolut-business-all-accounts.csv'), 'revolut');
    assert.deepEqual(parsed.rows.map((row) => [row.date, row.amount, row.currency, row.counterparty, row.reference, row.bankId?.slice(-2)]), [
      ['2026-10-20', '-20.00', 'USD', 'Example Cloud', undefined, '05'],
      ['2026-10-15', '-460.00', 'EUR', 'Exchanged to USD', undefined, '04'],
      ['2026-10-15', '500.00', 'USD', 'Exchanged from EUR', undefined, '03'],
      ['2026-10-05', '-9.80', 'EUR', 'Example Hosting', undefined, '02'],
      // Booked just after midnight Berlin time: the local completed date wins over UTC.
      ['2026-10-01', '2500.00', 'EUR', 'Payment from Sponsor One BV', '202610/12', '01'],
    ]);
    assert.equal(parsed.warnings.filter((warning) => /skipped a (pending|reverted) row/.test(warning)).length, 2);
    assert.deepEqual(parsed.balances, [
      { currency: 'EUR', amount: '4130.00', asOf: '2026-10-15', wallet: 'Main EUR' },
      { currency: 'USD', amount: '1480.00', asOf: '2026-10-20', wallet: 'Main USD' },
    ]);
  });

  it('reads Revolut Business exports with UTC columns only', () => {
    const csv = [
      'Date started (UTC),Date completed (UTC),ID,Type,State,Description,Reference,Payer,Card number,Orig currency,Orig amount,Payment currency,Amount,Fee,Balance,Account',
      '2026-10-02,2026-10-03,b1,TRANSFER,COMPLETED,Payment from Sponsor Seven,202610/7,Sponsor Seven,,EUR,700.00,EUR,700.00,0.00,1700.00,EUR',
    ].join('\n');
    const parsed = parseStatementCsv(csv, 'revolut');
    assert.deepEqual(parsed.rows, [
      { date: '2026-10-03', amount: '700.00', currency: 'EUR', counterparty: 'Payment from Sponsor Seven', reference: '202610/7', bankId: 'b1', bankType: 'TRANSFER', wallet: 'EUR' },
    ]);
    assert.deepEqual(parsed.balances, [{ currency: 'EUR', amount: '1700.00', asOf: '2026-10-03', wallet: 'EUR' }]);
  });

  it('parses the Finom statement export, defaulting to EUR, and keeps its closing balance', () => {
    const parsed = parseStatementCsv(`\uFEFF${fixture('finom-main.csv')}`, 'finom');
    assert.equal(parsed.rows.length, 7);
    assert.deepEqual(parsed.warnings, []);
    assert.deepEqual(parsed.rows[0], { date: '2026-10-31', amount: '-1250.00', currency: 'EUR', counterparty: 'Example Payroll Service', reference: 'October salaries' });
    assert.deepEqual(parsed.rows[1], { date: '2026-10-28', amount: '2000.00', currency: 'EUR', counterparty: 'Sponsor Two GmbH', reference: 'Invoice 202610/15' });
    assert.deepEqual(parsed.rows[3], { date: '2026-10-12', amount: '-50.00', currency: 'EUR', counterparty: 'Example Software Inc' });
    assert.deepEqual(parsed.balances, [{ currency: 'EUR', amount: '3210.55', asOf: '2026-10-31' }]);
    assert.equal(statementTotal(parsed.rows), '1210.55');

    const usd = parseStatementCsv(fixture('finom-main.csv'), 'finom', { currency: 'USD' });
    assert.ok(usd.rows.every((row) => row.currency === 'USD'));
    assert.equal(usd.balances[0].currency, 'USD');
  });

  it('orders same-day balances by the file direction', () => {
    const header = 'Completed date,Counterparty name,Reference,Amount,Balance';
    const oldestFirst = [header, '01.10.2026,A,,10.00,110.00', '01.10.2026,B,,5.00,115.00'].join('\n');
    const newestFirst = [header, '02.10.2026,C,,1.00,116.00', '01.10.2026,B,,5.00,115.00', '01.10.2026,A,,10.00,110.00'].join('\n');
    assert.equal(parseStatementCsv(oldestFirst, 'finom').balances[0].amount, '115.00');
    assert.equal(parseStatementCsv(newestFirst, 'finom').balances[0].amount, '116.00');
  });

  it('refuses Revolut and Finom files whose columns changed instead of guessing', () => {
    const renamed = fixture('finom-main.csv').replace('Counterparty name', 'Counterparty');
    assert.throws(() => parseStatementCsv(renamed, 'finom'), /unrecognized finom export.*Finom statement \(missing Counterparty name\)/);
    // A generic bank layout is not silently accepted as Revolut.
    assert.throws(() => parseStatementCsv('Date,Description,Amount,Currency\n2026-10-01,X,1.00,EUR\n', 'revolut'), /unrecognized revolut export/);
  });

  it('keeps the Revolut fields the matcher needs: type, original amount, fee, exchange leg', () => {
    const rows = parseStatementCsv(fixture('revolut-business-all-accounts.csv'), 'revolut').rows;
    const hosting = rows.find((row) => row.counterparty === 'Example Hosting')!;
    assert.deepEqual([hosting.bankType, hosting.origAmount, hosting.origCurrency, hosting.fee], ['CARD_PAYMENT', '-8.50', 'GBP', '0.20']);
    const exchange = rows.find((row) => row.counterparty === 'Exchanged to USD')!;
    assert.equal(exchange.relatedBankId, 'a0000000-0000-4000-8000-000000000003');
  });

  it('detects the bank from the header row alone', () => {
    assert.deepEqual(detectStatementAccount(csvHeaders(fixture('revolut-business-all-accounts.csv'))), { account: 'revolut', layout: 'Revolut Business account statement (local time)' });
    assert.deepEqual(detectStatementAccount(csvHeaders(`\uFEFF${fixture('finom-main.csv')}`)), { account: 'finom', layout: 'Finom statement' });
    assert.equal(detectStatementAccount(['Date', 'Description', 'Amount']), null);
  });
});
