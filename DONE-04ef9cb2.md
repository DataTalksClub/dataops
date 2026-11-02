# DONE evidence — intake 04ef9cb2 (October 2026 bookkeeping: invoice PDFs, X receipt, Finom tail)

Status: PARTIAL — 3 of 5 AC pieces verified live on the production portal
2026-11-02 ~19:40 UTC (host RMTHZ, `dataops whoami` = Orin Vale / admin,
portal https://ops.dtcdev.click). The other two need a Finom browser session
(sign-in) on DESKTOP-FP4OP26; desktop routing is currently failing
(`no_eligible_route` / `workspace_unavailable` in this intake's history), so
they remain blocked from any headless host.

## AC pieces done (live reads, 2026-11-02 19:35–19:42 UTC)

- **Invoice PDF 202610/53 attached.** Document
  `443522d3-e9ee-4819-8148-a4ccb2c09188` (`202610-53.pdf`, facts
  `invoiceNumber = 202610/53`, CH Advisers LLC d/b/a COMMAND, USD 6000,
  issued 2026-10-16, `documentType = receipt`, `linkRefCount = 1`) is linked
  as evidence (link `61ab2adece404804b285331df2c24eac43d5837eb0549e624d5040db8fbb7db98b`,
  created 2026-11-02T14:11:52Z) to ledger row
  `receipt-7aceb67624c4496bd10f1ffdb70e0f21f9974b2f` (CH ADVISERS LLC +6000
  USD, 2026-10-23, Revolut; the deal's recorded payment). The month view
  shows the row with `docs 443522d3-e9e`. Deal `593b04bb…` finance keeps the
  invoice metadata (202610/53, issued 2026-10-16, due 2026-10-31, USD 6000)
  and claims that ledger row. Deal-level `attach-invoice` is not possible for
  this file (document prepare dedupes by sha256, and invoice candidates
  require `documentType = invoice`), so the invoice lives on the ledger row.
- **X Corp 7.64 EUR receipt attached.** Document
  `59731c9a-9667-487a-8331-2457d8ef94df` (`Refund-3002-8230-4520.pdf`,
  facts: X Internet Unlimited, 7.64, invoice LOFS2YLD-0011,
  `documentType = receipt`, `linkRefCount = 1`) is linked as evidence (link
  `cf371cbe73e8cd7917e9f2fcb96c20813f27ba3b9b347032c74ebb525bde691d62c`,
  created 2026-11-02T11:18:21Z) to transaction
  `17ca09fb6e050b59aab4e806ac6b53d8aad09551b76edbb80347e38a2dc6e880`
  (X Corp. Paid Features +7.64 EUR, 2026-10-17, Revolut EUR). The month view
  shows the row with `docs 59731c9a-966`.
- **Teachable payout proof linked (supports the 202610/54 row).** Document
  `2ccc8205-ebc5-4751-9004-adcc58ed1566` (`teachable transaction.pdf`,
  `other-evidence`, `linkRefCount = 2`) is linked to both the platform-payout
  row `c60b8a57…` and the Finom-invoice row `08b5156c… (finom-invoice:202610/54)`.
  The month view shows row 08b5156c with `docs 2ccc8205-ebc proof 2ccc8205-ebc`.
  This is the PayPal payment proof, not the Finom invoice PDF itself.
- **Reconcile counters reported** — see below. The month is now fully matched
  (36/36, 0 blockers), an improvement over the earlier partial run: the Pro
  Sulum refund bank row (2026-10-31, Revolut USD) is matched to ledger
  `a1c9d26b`, and Finanzamt / X Corp / Google Play incoming all have ledger
  rows. "Nothing blocks closing." (Month left OPEN — closing was not requested.)

## AC pieces blocked (need a Finom session on DESKTOP-FP4OP26)

- **Invoice PDF 202610/54 not attachable from here.** A full scan of all 578
  bookkeeping documents finds zero documents with `facts.invoiceNumber =
  202610/54` or a matching filename. Row `08b5156c` (`finom-invoice:202610/54`,
  Finom id b27a86ba) carries only the PayPal proof above. The Finom invoice
  is "Not shared" in Finom — it exists only inside Finom, so downloading it
  needs a signed-in Finom browser session (SOP
  `record-a-platform-payout-with-a-finom-invoice`, steps 2/9). The same
  blocker is logged on DataOps task `43d4add1` (status done). No Finom
  credentials or browser session exist on this host, and sign-in needs
  credentials/2FA. Dapier's action catalog offers Gmail send only (no
  Gmail search/read), so no headless email fallback exists either.
- **Finom October statement tail (31 Oct) not re-uploadable from here.**
  Statements for 2026-10: revolut doc `4a0b4d98…` 31 rows 2026-10-01 →
  2026-10-31; finom doc `e59bd02d…` (`bank-statement`, uploaded
  2026-11-01T05:56Z) 7 rows 2026-10-01 → 2026-10-30. Coverage gap is exactly
  2026-10-31. Closing it needs a fresh Finom monthly-statement export that
  includes 31 Oct, re-uploaded via `dataops reconcile upload` — same
  Finom-session blocker. No unimported statement-like document exists in the
  portal (checked all 578 docs by filename/facts).

## Reconcile counters, 2026-10 (live, 2026-11-02 19:42 UTC)

`dataops reconcile months --from 2026-10 --to 2026-10`:

```
month    state   rows matched no-inv no-proof mismatch review except blockers statements
2026-10  open     36      36      0        0        0      0      2        0          2
```

`dataops reconcile report --period 2026-10`: matched 5, ambiguous 2
(Astronomer 9000 EUR 2026-10-20; Hackamamba 2700 EUR 2026-10-01), incoming
without invoice 4 (Finanzamt refund 43633.73 EUR 30 Oct; X Corp 7.64 EUR
17 Oct; Google Play 877.39 EUR 17 Oct; Pro Sulum 646.63 USD 31 Oct —
matched to ledger `a1c9d26b`, duplicate of the 30 Oct row already tracked in
dev ticket c966996a), issued invoices without payment 4 (202609/48 due
2026-11-15; 202608/44; 202608/40; 202604/25), platform payouts 1 (Amazon
59.99 EUR credit note). Coverage: revolut 31/31 days, finom 30/31 (gap
2026-10-31), business-1/business-2 without statements.

## What remains (desktop session)

1. On DESKTOP-FP4OP26 with Finom sign-in: open the 202610/54 internal invoice
   and download/share its PDF, then attach to ledger row `08b5156c`
   (e.g. `dataops reconcile attach-doc 08b5156c… file.pdf --period 2026-10`).
2. Same session: export the Finom October monthly statement including 31 Oct
   and `dataops reconcile upload --file …` it (replaces stored 01→30 rows,
   closes the coverage gap).
3. Re-run `dataops reconcile report --period 2026-10` and confirm finom 31/31.
