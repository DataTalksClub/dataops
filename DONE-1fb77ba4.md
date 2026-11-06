# DONE evidence — intake 1fb77ba4 (DataOps payment follow-up gaps)

All five sub-items were already implemented on `origin/main` (`0e9228de`); this
file records the 2026-11-05 re-verification that every acceptance criterion
holds. No product code changes were needed.

- AC1 overdue queue: the finance Money view builds a follow-up queue of overdue
  payments — `followUps` rows sorted by urgency with overdue totals and forecast
  buckets (`backend/src/sponsorFinance/ledger.ts:47,202-204,212-220,224`), rendered
  with overdue tones in `frontend/src/surfaces/finance/sponsor-money.js`; covered
  end-to-end by `backend/e2e/sponsor-money.spec.js:26,112-115` ("follows up on the
  overdue invoice first", overdue bucket `€2,500.00`). Task-level overdue queue:
  `GET /api/sponsor-crm/followups?overdue=true` filters open sponsor Tasks past
  their date (`backend/src/routes/sponsorCrm.ts:359-378`, tests
  `backend/tests/crm-followups.test.ts`); pipeline `builtin:pipeline:overdue`
  view (`backend/src/crmWorkspace/views.ts:196`,
  `backend/src/sponsorCrm/pipeline.ts:113`); CLI queue segments start with
  `overdue` (`cli/src/commands/tasks.mjs:238`).
- AC2 finance-alert tasks: the daily `sponsor-finance-alerts` automation
  (`backend/src/cron/runner.ts:11,51,177-200`, scheduled by
  `BackendFunctionDailyBackendCron` cron(0 6 \* \* ? \*) in
  `infra/template.full.yaml:1352-1358`) runs
  `evaluateSponsorFinanceAlerts` (`backend/src/sponsorFinance/alerts.ts`), which
  raises `payment-overdue` notifications for issued, unpaid/partially-paid
  invoices past `dueOn` (`alerts.ts:100-117`) and then creates or reopens one
  payment follow-up Task per overdue deal with deterministic ids and conditional
  writes (`alerts.ts:218-225`, `backend/src/sponsorFinance/overdueTasks.ts:55-107`).
  Tests: `backend/tests/sponsor-finance-transaction.ddb.ts:369-482` (create,
  idempotency, concurrent runs never duplicate) and
  `backend/tests/payment-follow-up-guard.test.ts:63-79` (create/idempotent/reopen
  with a `reopened` history event).
- AC3 +7d snooze: `POST /api/tasks/:id/actions/snooze` accepts relative dates —
  `snoozedUntil: '+7d'` resolves to the Berlin today +7
  (`backend/src/routes/tasks.ts:1082-1114,125-139`,
  `backend/src/relativeDates.ts:55-68`); a recorded payment follow-up defaults
  its next date to +7 days (`PAYMENT_FOLLOW_UP_DEFAULT_DAYS = 7`,
  `backend/src/paymentTaskGuard.ts:10,20-22`, applied at
  `backend/src/routes/tasks.ts:1045`). A *due* payment follow-up cannot be
  snoozed silently — it needs `emailRef` or `raisedCardId`
  (`backend/src/paymentTaskGuard.ts:46-51`, enforced at `tasks.ts:1094`).
  CLI: `dataops tasks snooze <task-id> --until +7d --reason R [--email-ref |
  --card]` (`cli/src/commands/tasks.mjs:39-40`). Tests:
  `backend/tests/tasks-snooze.test.ts:66-76` (+7d) and
  `backend/tests/payment-follow-up-guard.test.ts:119-135` (payment snooze guard
  with `+7d`, non-payment and not-yet-due tasks unaffected).
- AC4 snooze proof: every snooze/unsnooze writes a Task history event recording
  the verified interactive actor, the new/previous follow-up date, the reason,
  and the timestamp (`backend/src/routes/tasks.ts:1097-1102,1121-1126`;
  `makeTaskHistoryEvent` at `backend/src/routes/taskValidation.ts:135-160`;
  actor is resolved from auth, never client-supplied — `tasks.ts:738-759`;
  persisted by `backend/src/db/tasks.ts:222`). The deferral evidence is appended
  to the reason (`[email …, card …]` — `backend/src/paymentTaskGuard.ts:54-57`),
  so history shows what justified the snooze. Tests:
  `backend/tests/tasks-snooze.test.ts:60-63` (event action/followUpAt/note) and
  `backend/tests/payment-follow-up-guard.test.ts:112-116` (note carries
  `msg-42`); actor assertions on Task history exist across
  `backend/tests/api-tasks.test.ts:118,161,1631`.
- AC5 followUp code: the derived, never-stored `FollowUp` code set
  (`classify | send-invoice | unblock | payment-follow-up | reconcile |
  await-sponsor | await-payment | invoice-later | none`,
  `backend/src/sponsorFinance/types.ts:114-121`) is produced by the one
  derivation `deriveFollowUp` (`backend/src/sponsorFinance/followUp.ts:27-51`,
  `payment-follow-up` at lines 39-41 with `since`/`daysOverdue`; `chasedOn`
  turns an overdue issued invoice from `send-invoice` into
  `payment-follow-up` — test `payment-follow-up-guard.test.ts:41-50`) and read
  consistently by urgency ordering (`followUp.ts:53-67`), the ledger queue
  (`ledger.ts:52`), the payment follow-up blocker
  (`backend/src/sponsorFinance/paymentFollowUp.ts:74-82`), the finance alert
  rules (`alerts.ts:100-119`), the finance UI
  (`frontend/src/surfaces/finance/sponsor-finance.js:440` — `classify`
  intentionally handled by its own `data-finance-classify` affordance), and the
  documented model (`docs/sponsor-finance-jtbd.md:29-32`).

## Verification runs (2026-11-05, worktree at `0e9228de` = origin/main)

- `payment-follow-up-guard.test.ts` + `tasks-snooze.test.ts` +
  `crm-followups.test.ts`: 19/19 pass.
- `backend/scripts/test-sponsor-finance-transaction.sh` (DynamoDB Local):
  64/64 pass, including `sponsor-finance-payment-follow-up.ddb.ts` (task pool
  placement, single open follow-up, waiting lifecycle with evidence, proof-gated
  resolution) and `sponsor-finance-transaction.ddb.ts` (finance alert sweep).
