# Finance summary: money in, money out, net profit and VAT position

The Finance overview (`/finance` in the portal) and `dataops finance summary`
show the same numbers, because both render `GET /api/finance/summary`. The
arithmetic lives in `backend/src/finance/summary.ts` (pure, fixture-tested in
`backend/tests/finance-summary.test.ts`); the rules below are also returned in
the response as `rules`. Change the code and this page together.

## Commands

```
dataops finance summary --month 2026-10
dataops finance summary --year 2026
dataops finance summary --ytd
```

Exactly one period flag. The default output is a table; `--json` prints the API
payload unchanged. YTD runs from 1 January to today (Europe/Berlin).

## What counts

| Source | Counted? | How |
|---|---|---|
| Ledger rows (`BOOKKEEPING#`): sheet import, confirmed incoming invoices, sponsor payments, platform payouts | Yes | The ledger is the only thing summed |
| Incoming invoice drafts (`pending`, `rejected`) | No | Listed as a gap until verified and published |
| Issued outgoing invoices | Only once paid | Through the payment row; an unpaid invoice is not income |
| Bank / PayPal statement lines | Never | Evidence only; a line no ledger row explains is a gap |

A row is booked in the month it was **paid** (`paidDate`, else
`transactionDate`). `entryType: income` is money in, `expense` is money out.

## No double counting

1. **Invoice or payout vs the bank line that pays it.** Statement lines are
   never summed. A line is "explained" by a ledger row with the same direction,
   the same currency and amount (or the row's booked EUR amount against a EUR
   line), paid within 5 days; each row explains at most one line. Unexplained
   lines are listed as `bank-line-without-ledger-row`.
2. **Sheet row vs a system row for the same payment.** A `spreadsheet` row that
   repeats an `invoice`, `sponsor-receipt` or `payout` row (same direction,
   currency and amount, paid within 3 days, same payer/payee by name) is
   dropped and listed under `duplicates`; the system row is kept. Two system
   rows are never merged.

## Currency

Totals are in EUR. Every non-EUR row keeps its original amount and shows how it
was converted:

| `rateSource` | Meaning |
|---|---|
| `booked` | The EUR amount the bank actually booked (`amountEur`); the rate is implied (`amount / amountEur`) |
| `ecb` | No booked amount: the ECB euro reference rate for the paid date, or the last ECB business day before it, with that rate's date |
| none | No rate: the row is left out of the totals and listed as `unconverted` |

Rates are quoted as units of the currency per 1 EUR, the ECB convention.

## Lines and the two headline numbers

| Category | Line |
|---|---|
| `VAT` | VAT payment to (expense) or refund from (income) the Finanzamt |
| `Taxes` | Every other tax: Gewerbesteuer, income/corporate tax prepayments |
| `Health Insurance` | TK |
| anything else | Operating income or expense |

A `Refund` subtype income row reduces operating expenses rather than adding to
income.

- **Net profit excluding VAT** = (operating income − output VAT) − (operating
  expenses − input VAT). Taxes and TK are shown as their own lines and in *net
  after taxes and TK*. VAT payments and refunds are neither profit nor loss.
- **Projected VAT position** = output VAT − input VAT. Positive is owed to the
  Finanzamt, negative is a refund. It is shown next to what was actually paid
  or refunded (category `VAT`) in the same period.

A row without a VAT amount counts as zero VAT and is listed as `vat-unknown`,
so the projection is only as complete as the VAT data.

## Gaps

Each response lists what it could not count or had to assume:
`unconverted`, `no-direction`, `no-booked-eur`, `vat-unknown`,
`pending-invoices`, `bank-line-without-ledger-row` and `missing-statement` (a
business account with no bank statement for a month that has started).

## Access

Signed-in portal users, API tokens, and the read-only `invoice-reader` service
credential (GET only).
