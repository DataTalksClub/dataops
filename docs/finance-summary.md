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

```
dataops finance taxes --month 2026-10      # tax ledger: VAT, other taxes by type, TK
dataops finance taxes --year 2026 --json
```

Exactly one period flag. The default output is a table; `--json` prints the API
payload unchanged. YTD runs from 1 January to today (Europe/Berlin).

## What counts

| Source | Counted? | How |
|---|---|---|
| Ledger rows (`BOOKKEEPING#`): sheet import, confirmed incoming invoices, sponsor payments, platform payouts | Yes | Counted once in the month paid |
| Unmatched TK and Finanzamt statement debits | Yes | Classified as health insurance, VAT paid/refunded, or other taxes; a matching ledger row prevents a second count |
| Incoming invoice drafts (`pending`, `rejected`) | No | Listed as a gap until verified and published |
| Issued outgoing invoices | Only once paid | Through the payment row; an unpaid invoice is not income |
| Other bank statement lines | No | Evidence only; a line no ledger row explains remains a gap |

A row is booked in the month it was **paid** (`paidDate`, else
`transactionDate`). `entryType: income` is money in, `expense` is money out —
except Finanzamt, TK and owner-pay refunds coming back in, which stay out of
money in (see *Tax refunds* below).

## No double counting

1. **Ledger row vs the bank line that pays it.** Reconciliation determines
   the pairing, including manual pairs, rejections and ambiguous candidates.
   A line counts through a paired retained ledger row only once. Overlapping
   statement copies use the same bank-row identity and count once; separate
   repeated payments remain separate. The matched statement reference
   supplying its purpose when the ledger row has only a generic tax label. This
   keeps a matched `UMS.ST` debit in VAT paid instead of other taxes. Unmatched TK and Finanzamt debit
   lines count directly; other unmatched lines are listed as
   `bank-line-without-ledger-row`.
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
| `VAT`, or Finanzamt purpose `USt` / `UMS.ST` in the row or its matched statement reference | VAT paid or refunded |
| `Taxes`, except an USt / `UMS.ST` purpose | Taxes by type: Einkommensteuer + Soli (`incomeTax`), Gewerbesteuer (`tradeTax`), other (`otherTaxes`) |
| `Health Insurance`, or TK statement debit | Health insurance |
| anything else | Operating income or expense |

**Refunds.** A supplier refund or credit note is recorded as **contra-expense**:
an expense row with subtype `Refund` and source key
`credit-note:<full document number>` (the invoice intake does this
automatically, and `dataops bookkeeping add-income --type refund` records one
by hand; both dedupe on the key, so a credit note recorded by hand is linked,
never booked twice). The refund reduces operating expenses, and its VAT
reduces input VAT; it is not money in and not revenue. A row with a
`credit-note:` key is a refund even without the subtype.

**Tax refunds.** Only payments count as taxes. A Finanzamt or TK refund
(money in on the taxes or health-insurance line) is listed in `taxRefunds`
with its ledger row and summed in `totals.taxRefunds`. It is kept out of
money in and net cash: a refund is not income. It is not revenue, not profit,
and never a negative tax in any year: a refund settles an earlier assessed
year, and the bank date says nothing about which one. When a refund row
carries `taxYearAttribution` (mapping each assessed `YYYY` to its EUR amount),
each attributed part is reported in its assessed tax year while Bookkeeping
keeps the row with its real date and amount.

- **Net profit excluding VAT** = (operating income − output VAT) − (operating
  expenses − input VAT); supplier refunds reduce the expense side.
- **Taxes and TK paid** (`taxesTotal`) = `incomeTax` + `tradeTax` +
  `otherTaxes` + `healthInsurance`, each shown on its own as well. *Net after
  taxes and TK* = net profit excluding VAT − taxes and TK paid. VAT payments
  and refunds, and tax refunds, are neither profit nor loss.
- **Projected VAT position** = output VAT − input VAT. Positive is owed to the
  Finanzamt, negative is a refund. It is shown next to what was actually paid
  or refunded in the same period.

For output and input VAT, a reviewed ledger `vatAmount` takes precedence. If it
is absent, the summary reads the linked active invoice/receipt document's stored
VAT facts. It uses an explicit VAT amount, or derives VAT from the document's
net amount and explicit rate, or from its gross minus net amount. Explicit `0%`
is zero VAT. For reverse-charge documents, an explicit rate and net amount give
equal output and input VAT; this cancels in the position and does not change
profit. Without source VAT facts or a stated rate, VAT is zero. Missing VAT does
not produce a warning.

## Gaps

Each response lists what it could not count or had to assume:
`unconverted`, `no-direction`, `no-booked-eur`, `pending-invoices`,
`bank-line-without-ledger-row` and `missing-statement` (a business account with
no bank statement for a month that has started).

## Access

Signed-in portal users, API tokens, and the read-only `invoice-reader` service
credential (GET only).

## Upcoming tax debits

The Finanzamt and TK collect every tax and the health insurance by direct
debit from the business account, VAT included. `dataops finance upcoming
[--days 60] [--json]` and the *Upcoming tax debits* section of `/finance` list
what will be debited, so the account holds enough money beforehand.

- **Schedule as data.** Each prepayment or assessment is a `TAX_SCHEDULE#`
  entry: label, tax type (`income-tax`, `trade-tax`, `vat`,
  `health-insurance`, `other`), amount, rule (`monthly` on a day, `quarterly`
  on a day of given months, or `once` on a date), source (`Bescheid`,
  `USt-VA`, `recurring`) and an optional validity window. When a new Bescheid
  or USt-VA arrives, replace the entry: `dataops finance schedule set <id>
  --file entry.json --expected-version N` (the version you read with
  `dataops finance schedule`). Close an old entry with `validUntil` and add the
  new one with `validFrom` rather than editing history.
- **Dates.** A due date on a weekend or Berlin public holiday moves to the next
  business day (§108 AO); the row says why. TK collects *around* its day and
  is marked approximate.
- **Paid.** A debit counts as paid when a mandatory-payment ledger row or an
  unmatched EUR statement line classified as `tax_debit` or `tk_debit` shows the
  same amount within 5 days (7 for approximate ones). A statement line matched
  to a ledger row is used once. A past debit with neither is listed as *not seen*.
- **Cover.** The total of unpaid debits in the next 30 days is compared with
  the latest known business account balance and its as-of date; a balance
  below it is a shortfall, and a balance older than 7 days is flagged stale.
  With no balance on record the check says so instead of guessing.

## Tax ledger (`dataops finance taxes`, GET /api/finance/taxes)

Same entries, dedup and EUR conversion as the summary. Per month and for the
period it shows:

- **VAT**: projected position (output VAT on income minus input VAT on expenses;
  positive is owed to the Finanzamt, negative a refund) next to what was actually
  paid and refunded, and the outstanding difference. A period that has not ended
  yet (`open: true`) shows a projection; a closed one shows it against the actual
  payment.
- **Other taxes by type**: `income-tax` (Einkommensteuer, Körperschaftsteuer,
  Soli), `trade-tax` (Gewerbesteuer), `other`. The type is the row's stored
  `taxType` when set, otherwise derived from the booking text. A stored
  `taxType` also moves a mislabelled row (for example 2024 "VAT Advance payment"
  rows that are really ESt + Soli) between the VAT and taxes lines.
- **TK** health insurance, on its own line.
- **Tax refunds** (`taxRefunds`) on their own line; never netted into a tax
  type.

Tax payments are never expenses: they sit below net profit excluding VAT.

## Owner pay

Money paid to the owner personally is a ledger row with category `Owner pay`
and `ownerPayType` of `salary` (Geschäftsführergehalt), `draw` (Privatentnahme),
`reimbursement` or `unknown`. It is money out, but not an operating expense; it
has its own line (`totals.ownerPay`) below net profit and
`netAfterOwnerPay = netAfterTaxes - ownerPay`. Shown per month, year and YTD in
the portal and in `dataops finance summary` (table and `--json`).

Classifying existing rows: `backend/scripts/finance-owner-pay-dryrun.ts` scans a
transactions export for outgoing transfers to the owner since 2024, decides the
type from the booking text and counterparty, and writes a markdown report. It
never writes. Apply the classifications only after the report is reviewed
(add a category and `ownerPayType`; nothing is deleted).
