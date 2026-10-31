import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ParseError } from '../src/reconcile/parsers';
import { detectPdfStatementAccount, parseFinomPdfText, parseRevolutPdfText } from '../src/reconcile/pdfLayouts';

// Synthetic statements laid out the way pdfText renders the real ones:
// cells separated by three spaces, one text line per PDF line, page chrome
// repeated on every page. Every name, IBAN and amount here is invented.

const FINOM_SOLARIS = `Example Widgets GmbH   Statement of account
Musterweg 1, 10115, Berlin, Germany
VAT No.: DE000000000
Main
No.   2025-M-03
Issue date:   05.04.2025
From:   01.03.2025
To:   31.03.2025
Opening balance:   10.000,00 €
Closing balance:   9.155,50 €
IBAN: DE00 0000 0000 0000 0000 00
BIC: SOBKDEB2XXX
Completed   Description   Pay in/out
28.03.2025   Jane Example
invoice 2025-07
IBAN: DE00000000000000000001
BIC: TESTDEB1XXX
Value date: 28.03.2025
- 1.250,00 €
24.03.2025   ACME SOFTWARE INC,ACME.EXAMPLE
ACME SOFTWARE INC,ACME.EXAMPLE
Value date: 24.03.2025
1 EUR = 1,0800 USD
- 100,00 €
- 108,00 $
1 Empowered by Solaris
Completed   Description   Pay in/out
21.03.2025   Big Customer Ltd
Contract 42
first instalment
IBAN:
BIC: TESTUS33XXX
Value date: 21.03.2025
2.500,00 €
03.03.2025   Cloud Hosting Co
Cloud Hosting Co
Value date: 03.03.2025
- 1.994,50 €
Dear Madam, Dear Sir,
please review the bookings in this statement.
Your Solaris Team
2 Empowered by Solaris
FINOM, a limited liability company registered with the Netherlands Chamber of Commerce.
3 Empowered by Solaris`;

const FINOM_BALANCE = `Example Widgets GmbH   STATEMENT
Musterweg 1, 10115, Berlin, Germany
Main
Issue date:   03.11.2025
From:   01.10.2025
To:   31.10.2025
Opening balance:   500,00 €
Closing balance:   12.389,40 €
IBAN: DE00 0000 0000 0000 0000 01
BIC: FNOMDEB2
Completed   Description   Pay in/out   Balance
20.10.2025   Jane Example
2025/10-1
IBAN: DE00000000000000000002
BIC: TESTDEB1XXX
- 1.560,00 €   12.389,40 €
16.10.2025   PAYMENT PROVIDER
PAYOUT EXAMPLE
IBAN: NL00TEST0000000000
BIC: TESTNL2X
13.500,00 €   13.949,40 €
1 Created with Finom.co
Completed   Description   Pay in/out   Balance
09.10.2025   SAAS TOOL.COM/CHARGE   - 50,60 €   449,40 €
FINOM PAYMENTS B.V., a private limited liability company registered in the Netherlands.
2 Created with Finom.co`;

const REVOLUT_CHROME = (page: string) => `Report lost or stolen card
+00 0 000 0000
Get help directly In app
Scan the QR code
Revolut Bank UAB is a credit institution licensed in the Republic of Lithuania. Eligible deposits are insured.
investicijų draudimas") is available at Deposit Insurance Information Document.
© 2026 Revolut Bank UAB   ${page} `;

const REVOLUT_TWO_WALLETS = `${REVOLUT_CHROME('1/3')}
Account name   Euro
Currency   EUR
Type   Local
IBAN   LT00 0000 0000 0000 0000
BIC   REVOLT21
Example Widgets GmbH
Balance summary
Opening balance   €1 000.00
Money in   €12 000.00
Money out   - €2 763.50
Closing balance   €10 236.50
Your funds are held and protected by a licensed bank.
Transactions from April 1, 2026 to April 30, 2026
Date (UTC)   Description   Money out   Money in   Balance
28 Apr 2026   FEE   Revolut Business Fee • Basic plan fee   €10.00   €10 236.50
23 Apr 2026   CAR   Example Saas Llc
FX rate EUR 1 = USD 1.080000, Fee:€0.50
€100.50
$108.00
€10 246.50
20 Apr 2026   MOS   To Jane Example • Hey   €2 500.00   €10 347.00
Account statement
Generated on the May 4, 2026
${REVOLUT_CHROME('2/3')}
7 Apr 2026   MOA   Money added from BIG CUSTOMER LTD •
2026-04/01
€11 900.00   €12 847.00
5 Apr 2026   MOR   Refund from Book Shop De   €100.00   €947.00
3 Apr 2026   CAR   Hosting Co   €153.00   €847.00
Transaction types
Card payments (CAR)
- €253.50
Money sent (MOS)
- €2 500.00
Money received (MOR)
+ €100.00
Money added (MOA)
+ €11 900.00
Revolut Fees (FEE)
- €10.00
${REVOLUT_CHROME('3/3')}
Account name   United States Dollar
Currency   USD
Type   International
IBAN   LT00 0000 0000 0000 0000
BIC   REVOLT21
Balance summary
Opening balance   $400.00
Money in   $0.00
Money out   - $129.54
Closing balance   $270.46
Transactions from April 1, 2026 to April 30, 2026
Date (UTC)   Description   Money out   Money in   Balance
2 Apr 2026   CAR   Cloud Compute   $100.00   $270.46
1 Apr 2026   CAR   Chat Subscription   $29.54   $370.46
Transaction types
Card payments (CAR)
- $129.54
Account statement
Generated on the May 4, 2026`;

const REVOLUT_EMPTY_USD = `${REVOLUT_CHROME('1/1')}
Account name   United States Dollar
Currency   USD
Balance summary
Opening balance   $50.00
Money in   $0.00
Money out   $0.00
Closing balance   $50.00
Transactions from 01 January 2025 to 31 January 2025
Date (UTC)   Description   Money out   Money in   Balance
There were no transactions during this period
Transaction types
Card payments (CAR)
$0.00
Monthly statement
Generated on the 17 February 2025`;

describe('detectPdfStatementAccount', () => {
  it('tells Finom and Revolut statements apart by their issuer markers', () => {
    assert.equal(detectPdfStatementAccount(FINOM_SOLARIS), 'finom');
    assert.equal(detectPdfStatementAccount(FINOM_BALANCE), 'finom');
    assert.equal(detectPdfStatementAccount(REVOLUT_TWO_WALLETS), 'revolut');
    assert.equal(detectPdfStatementAccount('Some other bank\nDate   Amount'), null);
  });
});

describe('parseFinomPdfText', () => {
  it('reads the Solaris layout: multi-line descriptions, page breaks, FX original amount', () => {
    const parsed = parseFinomPdfText(FINOM_SOLARIS);
    assert.match(parsed.layout, /Solaris/);
    assert.deepEqual(parsed.period, { from: '2025-03-01', to: '2025-03-31' });
    assert.deepEqual(parsed.balances, [{ currency: 'EUR', amount: '9155.50', asOf: '2025-03-31' }]);
    assert.deepEqual(parsed.openingBalances, [{ currency: 'EUR', amount: '10000.00', asOf: '2025-03-01' }]);
    assert.deepEqual(parsed.warnings, []);
    assert.deepEqual(parsed.rows, [
      { date: '2025-03-28', amount: '-1250.00', currency: 'EUR', counterparty: 'Jane Example', reference: 'invoice 2025-07' },
      { date: '2025-03-24', amount: '-100.00', currency: 'EUR', counterparty: 'ACME SOFTWARE INC,ACME.EXAMPLE', origAmount: '-108.00', origCurrency: 'USD' },
      { date: '2025-03-21', amount: '2500.00', currency: 'EUR', counterparty: 'Big Customer Ltd', reference: 'Contract 42 first instalment' },
      { date: '2025-03-03', amount: '-1994.50', currency: 'EUR', counterparty: 'Cloud Hosting Co' },
    ]);
  });

  it('reads the balance-column layout, including one-line rows', () => {
    const parsed = parseFinomPdfText(FINOM_BALANCE);
    assert.match(parsed.layout, /balance column/);
    assert.deepEqual(parsed.period, { from: '2025-10-01', to: '2025-10-31' });
    assert.deepEqual(parsed.balances, [{ currency: 'EUR', amount: '12389.40', asOf: '2025-10-31' }]);
    assert.deepEqual(parsed.rows.map((row) => [row.date, row.amount, row.counterparty, row.reference]), [
      ['2025-10-20', '-1560.00', 'Jane Example', '2025/10-1'],
      ['2025-10-16', '13500.00', 'PAYMENT PROVIDER', 'PAYOUT EXAMPLE'],
      ['2025-10-09', '-50.60', 'SAAS TOOL.COM/CHARGE', undefined],
    ]);
  });

  it('throws when the column header changed', () => {
    const changed = FINOM_BALANCE.replace(/Pay in\/out   Balance/g, 'Amount   Balance');
    assert.throws(() => parseFinomPdfText(changed), (error: unknown) => error instanceof ParseError && /unrecognized finom PDF statement layout/.test(error.message));
  });

  it('throws on a statement from another bank', () => {
    assert.throws(() => parseFinomPdfText(REVOLUT_TWO_WALLETS), /unrecognized finom PDF statement layout/);
  });

  it('throws when the rows do not add up to the closing balance', () => {
    const broken = FINOM_SOLARIS.replace('Closing balance:   9.155,50 €', 'Closing balance:   9.155,51 €');
    assert.throws(() => parseFinomPdfText(broken), /does not reconcile/);
  });

  it('throws when a running balance disagrees with the rows', () => {
    const broken = FINOM_BALANCE.replace('13.949,40 €', '13.949,41 €');
    assert.throws(() => parseFinomPdfText(broken), /running balance/);
  });
});

describe('parseRevolutPdfText', () => {
  it('reads one section per wallet with signs from the running balance', () => {
    const parsed = parseRevolutPdfText(REVOLUT_TWO_WALLETS);
    assert.deepEqual(parsed.period, { from: '2026-04-01', to: '2026-04-30' });
    assert.deepEqual(parsed.balances, [
      { currency: 'EUR', amount: '10236.50', asOf: '2026-04-30', wallet: 'EUR' },
      { currency: 'USD', amount: '270.46', asOf: '2026-04-30', wallet: 'USD' },
    ]);
    assert.deepEqual(parsed.openingBalances.map((balance) => [balance.wallet, balance.amount]), [['EUR', '1000.00'], ['USD', '400.00']]);
    assert.deepEqual(parsed.warnings, []);
    assert.deepEqual(parsed.rows, [
      { date: '2026-04-28', amount: '-10.00', currency: 'EUR', counterparty: 'Revolut Business Fee', reference: 'Basic plan fee', bankType: 'FEE', wallet: 'EUR' },
      { date: '2026-04-23', amount: '-100.50', currency: 'EUR', counterparty: 'Example Saas Llc', bankType: 'CARD_PAYMENT', origAmount: '-108.00', origCurrency: 'USD', fee: '-0.50', wallet: 'EUR' },
      { date: '2026-04-20', amount: '-2500.00', currency: 'EUR', counterparty: 'Jane Example', reference: 'Hey', bankType: 'TRANSFER', wallet: 'EUR' },
      { date: '2026-04-07', amount: '11900.00', currency: 'EUR', counterparty: 'BIG CUSTOMER LTD', reference: '2026-04/01', bankType: 'TOPUP', wallet: 'EUR' },
      { date: '2026-04-05', amount: '100.00', currency: 'EUR', counterparty: 'Book Shop De', bankType: 'CARD_REFUND', wallet: 'EUR' },
      { date: '2026-04-03', amount: '-153.00', currency: 'EUR', counterparty: 'Hosting Co', bankType: 'CARD_PAYMENT', wallet: 'EUR' },
      { date: '2026-04-02', amount: '-100.00', currency: 'USD', counterparty: 'Cloud Compute', bankType: 'CARD_PAYMENT', wallet: 'USD' },
      { date: '2026-04-01', amount: '-29.54', currency: 'USD', counterparty: 'Chat Subscription', bankType: 'CARD_PAYMENT', wallet: 'USD' },
    ]);
  });

  it('keeps the closing balance of a wallet without transactions', () => {
    const parsed = parseRevolutPdfText(REVOLUT_EMPTY_USD);
    assert.deepEqual(parsed.rows, []);
    assert.deepEqual(parsed.period, { from: '2025-01-01', to: '2025-01-31' });
    assert.deepEqual(parsed.balances, [{ currency: 'USD', amount: '50.00', asOf: '2025-01-31', wallet: 'USD' }]);
  });

  it('throws when the column header changed', () => {
    const changed = REVOLUT_TWO_WALLETS.replace(/Money out   Money in   Balance/g, 'Amount   Balance');
    assert.throws(() => parseRevolutPdfText(changed), (error: unknown) => error instanceof ParseError && /unrecognized revolut PDF statement layout/.test(error.message));
  });

  it('throws on a statement from another bank', () => {
    assert.throws(() => parseRevolutPdfText(FINOM_BALANCE), /unrecognized revolut PDF statement layout/);
  });

  it('throws on an unknown transaction type', () => {
    const changed = REVOLUT_TWO_WALLETS.replace('3 Apr 2026   CAR', '3 Apr 2026   XYZ');
    assert.throws(() => parseRevolutPdfText(changed), /unknown transaction type "XYZ"/);
  });

  it('throws when a row does not move the running balance by its amount', () => {
    const broken = REVOLUT_TWO_WALLETS.replace('€153.00   €847.00', '€153.00   €846.00');
    assert.throws(() => parseRevolutPdfText(broken), /does not reconcile/);
  });

  it('throws when the printed money in / out totals disagree with the rows', () => {
    const broken = REVOLUT_TWO_WALLETS.replace('Money in   €12 000.00', 'Money in   €12 000.01');
    assert.throws(() => parseRevolutPdfText(broken), /does not reconcile/);
  });
});
