# DONE evidence — intake c6b05dfc (Payment notification mail ingestion (Ramp/Stripe/BILL) -> receive-payment candidates)

The gap was already closed on main by three 2026-11-03 commits: `f8f7e60e`
("feat(finance): ingest payment notification candidates" — backend parse/match/
ingest, routes and the CLI `sponsors payment-mail` family), `340f81bb`
("feat(finance): already-paid fallback for payment mails without a stored
invoice number") and `c7c5323d` ("fix(finance): don't report a paid amount as
outstanding on already-paid mail matches"). This file records the 2026-11-05
re-verification on current origin/main (`0e9228de`) and live prod. No backend
changes were needed; this PR adds one confirm-flow parity fix, its test pin,
the canonical-doc paragraph and this evidence.

Verification per acceptance criterion, on this tree:

- (a) Recognizing payment-notification mails: `parsePaymentMail`
  (`backend/src/sponsorFinance/paymentMail.ts:94`) — sender-host gate
  `providerForSender` for ramp.com / stripe.com / bill.com hosts (:36-50),
  received-payment phrase gate with failure/refund/dispute exclusion
  (:100-102), invoice number / amount / currency / payer extraction
  (:104-118, HTML-stripping `plain` at :84). Mail source: `pollPaymentMail`
  (`backend/src/sponsorFinance/paymentMailPoll.ts:34`) reads recent mails from
  Orin's Gmail through the existing Dapier token broker (query at :15), or an
  agent that already read the mailbox pushes mails through the ingest route;
  both paths share `ingestPaymentMail` and are idempotent per message id.
- (b) Receive-payment candidates: `ingestPaymentMail` (paymentMail.ts:256)
  stores idempotent `payment-mail-candidate` items under `PAYMENT_MAIL#`
  keys (:226-228) with statuses candidate / unmatched / already-paid (:269);
  deal matching is `matchPayment` (paymentMail.ts:164 — invoice number first,
  then amount+sponsor, never guesses between ties) plus the already-paid
  fallback `matchPaidRow` (paymentMail.ts:144) and the paid-row match
  describe (:244). Nothing is marked paid by a mail.
- (c) The confirm flow: routes
  `/api/sponsor-crm/finance/payment-mail[/ingest|/poll|/<id>|/<id>/(confirmed|dismissed)]`
  (`backend/src/routes/sponsorFinance.ts:76-118`, wired in
  `backend/src/router.ts:593`, gated by `financeEnabled()` at :61);
  `decidePaymentMailCandidate` (paymentMail.ts:307) allows confirming only a
  matched candidate, dismiss any undecided one, with conditional-write guards.
  CLI: `dataops sponsors payment-mail list|poll|ingest|confirm|dismiss`
  (`cli/src/commands/sponsors.mjs:748`, help block at :45) — confirm
  dry-runs by default and `--apply` records the receive-payment through
  `POST /api/sponsor-crm/deals/<deal-id>/finance/receipts` with
  `Idempotency-Key: pmail-<candidate-id>` (reference
  `mail:<provider>:<invoice-or-id>`) before marking the candidate confirmed,
  i.e. the same endpoint as `sponsors receive-payment`.
- Tests on this tree (2026-11-05): backend
  `backend/tests/sponsor-finance-payment-mail.test.ts` 14/14 (Ramp/Stripe/BILL
  parsing incl. European amount formats, unknown-sender and failure/refund
  rejection, matching and no-guess-between-ambiguous, already-paid fallback
  refusals, idempotent ingestion, API list + authorized confirm, Dapier poll
  ok/deferred). CLI: `test/sponsors-payment-mail.test.mjs` (extended in this
  PR), `test/sponsors.test.mjs`, `test/thank-you.test.mjs`,
  `test/sponsors-cold.test.mjs`, `test/sponsors-contract.test.mjs`,
  `test/cli.test.mjs` — all pass (27 + 23).
- Prod checks were read-only CLI only (`dataops sponsors payment-mail list
  --json`): two candidates exist, both provider ramp — one `already-paid`
  (reasons include "already paid") and one `dismissed` (decidedBy recorded,
  2026-11-03); nothing was written to prod, no direct DB or AWS access. Names,
  amounts and deal titles from prod were not copied into this repo.
- What this PR adds:
  1. `sponsors payment-mail confirm` now surfaces the same thank-you next
     step as `sponsors receive-payment` (`cli/src/commands/sponsors.mjs`):
     previously the receipts response was dropped except `paymentState`, so
     the SOP-10 thank-you required by `cli/skill/SKILL.md` for every payment
     resolution was silently lost on the mail-candidate path. `--apply` now
     spreads the receipts response, attaches `thankYou`/`nextStep`
     (`attachThankYouResult`, `cli/src/thank-you.mjs:109`) and prints the
     hint; the dry run previews it like `receive-payment`, and the
     candidate's parsed invoice number feeds `<WHAT_WAS_PAID>` even when the
     deal finance state has no stored invoice number. Pinned by the extended
     `cli/test/sponsors-payment-mail.test.mjs`.
  2. The payment-mail family paragraph in `cli/skill/SKILL.md` (finance
     section) — the canonical CLI documentation did not mention the family
     at all.
  3. This DONE evidence.

dapier side (cross-repo; no dapier code change is required by dataops):

- Pull path (what dataops already does): `POST {DAPIER_BASE_URL}/api/agent/token`
  (default `https://dapier.dtcdev.click`, `backend/src/calendar/dapierBroker.ts:18`)
  with `Authorization: Bearer <dapier credential>` and body
  `{"connection_id": "gmail-orin", "agent": "personal-scheduler"}`
  (connection id default at `backend/src/sponsorDocs/emailDelivery.ts:43`,
  agent at `backend/src/calendar/dapierBroker.ts:19`), then Gmail REST
  `GET /gmail/v1/users/me/messages` with the payment-mail query
  (paymentMailPoll.ts:15). dapier requirement (config, not code): the
  `gmail-orin` connection must hold Gmail read scope and a Dapier `use`
  grant for agent `personal-scheduler`. Without read scope Gmail answers 403
  and poll reports `{state: "deferred", reason: "gmail_list_http_403", ...}`
  (paymentMailPoll.ts:63) — the push path below keeps working.
- Push path (no dapier involvement; any agent holding portal credentials):
  `POST /api/sponsor-crm/finance/payment-mail/ingest` with
  `{"mails": [{"messageId", "from", "subject", "body", "receivedAt"}]}`
  (at most 100 mails per request; field validation at paymentMail.ts:230-240),
  idempotent per messageId. Confirm/dismiss:
  `POST /api/sponsor-crm/finance/payment-mail/<id>/confirmed|dismissed`.
- So the only possible dapier follow-up is operational: grant Gmail read
  scope on the existing Orin Gmail connection (or run a mailbox-trigger agent
  that pushes ingests). It is not a code task in the dapier repo.

Remaining gaps, none blocking:

- The portal frontend has no payment-mail surface; candidates are consumed
  via CLI/API (the ask was ingestion + candidates, and the same was true for
  the offers family before its frontend work).
- Poll depends on the Gmail read scope above; until it is granted, ingestion
  runs through `payment-mail ingest` pushes.
- Hub was unavailable during this session (Intake HTTP 503 on every endpoint,
  including `hub intake show c6b05dfc`), so the intake could not be annotated
  in Hub; merge-state bookkeeping stays with the operator.
