# DONE evidence — intake bccc0df8 (Email-intake extraction: credit notes/refunds amount, full doc number, flag ambiguous, Pro Sulum CN)

The email-intake extraction gap was already closed on main by the 2026-10-31
through 2026-11-03 commits: `6932955f` ("fix(invoices): read credit notes as
refunds and book them once as income"), `2a6a3138` ("test(extraction): gold
case for a credit note with an adjusted-total decoy" — its fixture names this
intake), `0f5367e5`, `74bf5ad5`, `12d56695` ("fix(finance): book supplier
credit notes as contra-expense, not income") and `7a600185`
("fix(invoices): distinguish customer credit notes, clear ambiguous refund
totals, and guard auto-match"). The bookkeeping half of the task
(`dataops bookkeeping add-income --type refund`, commit `46c3c0d5`) was
already out of scope here. This file records the 2026-11-05 re-verification
on current origin/main (`35e7b376`) plus a 7-scenario synthetic probe and a
read-only prod check. No backend code changes were needed; the PR adds one
test pin and this evidence.

## Pipeline inventory (before, as of origin/main 35e7b376)

Email intake `handleEmailDocumentIntake`
(`backend/src/routes/emailDocuments.ts:234`) copies attachments to artifacts
and, for invoice routes, hands off to `processInvoiceIntake`
(`backend/src/invoices/service.ts:102`), which runs
`financeExtractor = extractFinancePdf`
(`backend/src/invoices/service.ts:18`) on every PDF
(`backend/src/invoices/service.ts:125`). `extractFinancePdf`
(`backend/src/invoices/financeExtraction.ts:193`) reads text via `pdfText`
(pdfjs text layer + bounded OCR, `backend/src/invoices/extract.ts:379`) and
extracts through `extractFinanceText`
(`backend/src/invoices/financeExtraction.ts:102`): the deterministic layer
`extractInvoiceText` (`backend/src/invoices/extract.ts:240`), the labeled
regex pass `regexFinanceFacts`
(`backend/src/invoices/financeExtraction.ts:18`), layout templates
`FINANCE_TEMPLATES` (`backend/src/invoices/financeExtraction.ts:44`, the
Stripe-family template covers Pro Sulum at :75-77) and the LLM reader
(`backend/src/invoices/llm.ts`) with cross-checks and a regex fallback.

## Verification per acceptance criterion, on this tree

- (a) Recognize credit notes/refunds: `creditNote()`
  (`backend/src/invoices/extract.ts:217-229`) gated by the title/label regex
  `CREDIT_NOTE` (extract.ts:207 — "credit note/gutschrift/stornorechnung/
  refund" titles, "credited (sub)total", "refunded on"; prose mentions on a
  replacement invoice do not match) plus the `-CN` number pattern
  `CREDIT_NUMBER` (extract.ts:208). `extractInvoiceText` tags
  `documentType: 'credit_note'` (extract.ts:376) and sets supplier-refund
  semantics `subtype: 'Refund'` (extract.ts:302). The regex pass sets
  `docType='credit_note'` (financeExtraction.ts:31-32) and the reader prompt
  classifies docType `credit_note` without letting boilerplate refund prose
  do it (`backend/src/invoices/llm.ts:62`). A deterministic credit-note
  detection overrides a reader misclassification
  (financeExtraction.ts:134) — pinned by the new test.
- (b) Amount with credit semantics: the refunded/credited amount is used,
  never the adjusted total, remaining balance or original invoice total —
  `REFUNDED`, `CREDITED_TOTAL`, `NEGATIVE_TOTAL`
  (extract.ts:215-216, 210, applied at 222-224); credited subtotal/tax for
  partial refunds (financeExtraction.ts:34-35); reader instruction
  (llm.ts:64); amounts stay positive and the direction carries the credit
  semantics: supplier refund = contra-expense (`direction 'expense'`,
  `subtype 'Refund'`, extract.ts:302 + financeExtraction.ts:164,175), a
  DataTalks.Club-issued customer credit note stays income without the
  subtype (financeExtraction.ts:162-164, extract.ts:301-302); booking keys
  on `credit-note:<full number>` (`backend/src/invoices/service.ts:219-226`,
  `backend/src/invoices/model.ts:18-23`).
- (c) Full document number, same field semantics as invoices
  (`fields.invoiceNumber`): `CREDIT_NUMBER` captures the whole hyphenated
  number (extract.ts:208, applied at 303), the U+0000 PDF-font hyphens are
  rejoined by `normalizePdfText` (extract.ts:198-202) so
  `XXXX-NNNN-CN-01` stays one number, the generic labeled fallback also
  accepts "credit note number" (extract.ts:181-184), and the reader must
  keep every suffix and restore printed punctuation (llm.ts:68).
- (d) Ambiguity flagged through the pipeline's existing mechanism
  (`needsReview` + `candidates` + issues): conflicting refunded amounts leave
  the amount empty, keep the candidate list and ask for review
  (extract.ts:308-317; finance layer also clears gross/net/vat on
  candidates or a regex/reader disagreement and pushes the review issue,
  financeExtraction.ts:135-140,158-161); a credit note without a clear
  amount is flagged for manual entry (extract.ts:310-317); missing fields
  (incl. invoice number), reader/document disagreements and reader
  confidence below `high` all flag review via `validateFinanceFacts`
  (financeExtraction.ts:86-99, `confidence:<level>` at :97,
  `uncertain:<field>` at :98) with `needsReview: issues.length > 0`
  (financeExtraction.ts:177).

## Probe (2026-11-05, synthetic Pro Sulum-shaped Stripe credit note, invented vendor/numbers/amounts)

Clean read → full extraction (`deterministic-credit-note` in the plain
layer; amount, full `-CN-01` number, subtype Refund, direction expense,
payment channel card). Reader misclassification (docType invoice, gross =
original total) → docType forced to credit_note, amounts cleared,
candidates = [refunded, original], needsReview. Conflicting credited
amounts → cleared + candidates + needsReview. Missing document number →
`missing:invoiceNumber` + needsReview. Reader confidence `low` →
`confidence:low` + needsReview. "Amount refunded" label form → still
extracted; when no refunded/credited amount exists the draft is flagged
"Credit note without a refunded or credited amount". Invoice behavior is
unchanged (existing suite).

## Tests on this tree (2026-11-05)

- `backend/tests/invoice-extraction.test.ts` + `backend/tests/invoice-finance-extraction.test.ts`:
  41/41 before this PR, 42/42 with the new pin (12/12 in the finance file).
  Existing credit-note coverage: gold case `credit-note-refund-adjusted-total`
  (invoice-extraction.test.ts:134-154, fixture source names this intake),
  conflicting amounts (invoice-extraction.test.ts:155-163,
  invoice-finance-extraction.test.ts:124-144), customer vs supplier credit
  notes (invoice-extraction.test.ts:171-181,
  invoice-finance-extraction.test.ts:124-131), partial refund credited
  subtotal (invoice-finance-extraction.test.ts:118-122), full number kept on
  a refund (invoice-finance-extraction.test.ts:32-38).
- `backend/tests/invoice-llm.test.ts`, `backend/tests/invoice-replace-document.test.ts`,
  `backend/tests/bookkeeping-credit-notes.test.ts` (17 tests) and
  `backend/tests/invoice-intake.test.ts`, `backend/tests/api-email-documents.test.ts`
  (16 tests) — all pass on this tree (2026-11-05).

## Prod checks (read-only)

`dataops invoices list --json` only: the draft filed from this intake
(prefix `1c7b85ad…`) extracted deterministically (`deterministic-text`),
carries the supplier-refund subtype and the full `-CN` number, and is
already confirmed by Finance. No values, names or numbers from prod are
quoted here; nothing was written to prod, no direct DB or AWS access.

## What this PR adds

1. One regression pin in `backend/tests/invoice-finance-extraction.test.ts`:
   a reader misread of a supplier credit note (misclassified as an invoice,
   gross = the original total) is forced back to `credit_note`, gets its
   amounts cleared with both candidates and `needsReview`, keeps the Refund
   contra-expense semantics, and surfaces `disagreement:invoiceNumber`; plus
   the confidence gate (`confidence:low` flags review while keeping the
   extracted values). Both paths were previously untested.
2. This evidence file. No production code changes: nothing else in the task
   was left to implement on the extraction side.
