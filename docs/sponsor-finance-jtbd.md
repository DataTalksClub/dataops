# Sponsor money: jobs to be done

Status: accepted 2026-10-14. Public-safe: no sponsor names, amounts or
private links. The real ledger lives outside this repository.

## Operator jobs

| # | Job | Question the operator asks | Served by |
|---|-----|----------------------------|-----------|
| 1 | Know the deals | Which deals does this sponsor have, of which kind, and what was promised (newsletter slots, social, podcast, webinar, workshop, course, installments)? | Company page: deals with deliverables and a deal title |
| 2 | Know what was delivered | Which promised deliverables are published, which are still ahead? | Deliverable `publishedAt` and planned dates; fulfillment chip |
| 3 | Know the invoice position | Is an invoice needed, sent, paid, partially paid, overdue or void? Which number, when sent, when due? | Finance state per deal: classification, invoice number, issued/sent/due dates, payment state, timing state |
| 4 | Know the cash | What came in, when, from which evidence (ledger row, accountant report, sponsor confirmation)? | Payments: linked ledger rows plus recorded payments with a method and reference |
| 5 | Chase today | What must I do today: send an invoice after delivery, chase an overdue invoice, provide payment details or a card link, reconcile? | Derived follow-up per deal and the Money "chase" list; finance alerts in notifications |
| 6 | Know who we wait on | Is the ball with us (billing info, payment link, vendor form) or with the sponsor (billing details, PO, payment run)? | `waitingOn {party, reason, since, note}` on the finance state |
| 7 | Forecast | What cash do I expect and when? What is overdue? What is agreed but not yet invoiced? | Money ledger summary: outstanding and overdue per currency, expected cash by due month, uninvoiced agreed amounts |
| 8 | Prove it | Where is the evidence: mail thread, invoice PDF, bookkeeping row? | Evidence references on the finance state, linked invoice document and ledger rows |

## States

- Invoice: `unclassified` -> `to-request` -> `requested` -> `issued`; or
  `not-required`; or `voided`. Issued means an invoice number and issue
  and due dates are recorded. Attaching the PDF from bookkeeping is
  evidence, not the definition of issued: the bookkeeping archive only
  receives sales invoices once they are paid.
- Payment: `unpaid` -> `partially-paid` -> `paid`, or
  `reconciliation-required` when linked ledger evidence drifts.
- Timing: `not-due`, `overdue`, `settled`.
- Follow-up (derived, never stored): `classify`, `send-invoice`,
  `unblock` (we owe the sponsor something), `chase-payment`,
  `reconcile`, `await-sponsor`, `await-payment`, `invoice-later`, `none`.

## Model decisions

- One money model. The per-deal sponsor finance state is the only
  invoice and payment record. The earlier free-form CRM `invoice`
  records are removed; the CRM money chip and the queue derive from the
  finance state.
- One deal is one billing unit. A package invoiced once is one deal with
  several deliverables; a sponsorship billed in installments is one deal
  per installment.
- Payments come from two evidence sources in one list: ledger rows
  (claimed exclusively, verified against bookkeeping) and recorded
  payments for cash the ledger has not caught up with yet. When the
  ledger row arrives, the operator removes the recorded payment and
  links the ledger row.
- No new table or index. Everything lives in the sponsor CRM table under
  the existing `SPONSOR_FINANCE*` key families.

## Alerts

`invoice-request-overdue`, `invoice-missing`, `invoice-after-delivery`,
`payment-overdue`, `finance-waiting-on-us`,
`finance-reconciliation-required`, `finance-unclassified`.
