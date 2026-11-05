# DONE evidence — intake fe05735a (CLI gap: receive-payment / link-payment should create dependent "Mark invoice paid in Finom" task)

Verdict: **already implemented and merged on origin/main; verification-only session — no product
code changes needed.** This session verified the behavior end to end, re-ran the targeted tests on
current main, and confirmed the handoff's acceptance criteria are each covered by an existing test.

## Where the behavior lives (verified on origin/main d213cf9b)

- `backend/src/sponsorFinance/finomPaidTask.ts` (introduced 4524ec57, extended 36028078):
  `finomPaidTaskActions` leaves exactly one open "Mark invoice \<number\> paid in Finom" Task per
  deal (`finomPaidTaskDescription`), an ordinary cardless Task with `subject: sponsor-deal`,
  `source: sponsor-finom`, `tags: [finom-invoice-paid]`,
  `instructionDocId: sop.finance.bookkeeping.marking-invoice-as-paid-in-finom`, due `date` = today
  (Berlin), `dependsOn: [payment/receipt sourceId]`, and `assigneeId` resolved by
  `resolveDealOwnerId` (deal owner → organization owner → deal/organization creation actor →
  workspace assignment policy; `createdBy` stays the payment actor).
- `backend/src/sponsorFinance/repository.ts` `linkPayment()`: calls `finomPaidTaskActions` and puts
  `...finom.actions` inside the same `TransactWrite` that commits the payment link, so the Task
  exists if and only if the payment commits (or the deal's open one is adopted);
  `details: { finomTaskId, finomTaskCreated }` is recorded on the `payment-linked` history event.
- `receivePayment()` delegates to `linkPayment()` with the prepared receipt source, so every CLI
  entry that records cash rides the same transaction:
  `dataops sponsors receive-payment` (POST `/api/sponsor-crm/deals/:id/finance/receipts`),
  `dataops sponsors link-payment` (POST `/finance/payments`), `dataops reconcile confirm` (posts the
  same two endpoints, `cli/src/commands/reconcile.mjs:268,279`) and
  `dataops sponsors payment-mail confirm` (POST `/finance/receipts`).
- `backend/src/db/taskDependencies.ts`: a committed receipt satisfies the Task's payment
  prerequisite; unlinking the payment makes it unmet and blocks completing the Task with
  `409 prerequisites-incomplete`.
- `cli/skill/SKILL.md` documents the payment follow-through (thank-you SOP step 10).

Idempotency, per criterion 3: a second payment on the same deal does not create a parallel Task —
`finomPaidTaskActions` adopts the deal's open Finom Task (appends the new sourceId to `dependsOn`,
version-checked update); a fresh Task row is keyed by `finance-<digest({dealId, sourceId,
finom: 'invoice-paid'})>` so the next receipt after a resolved Task gets its own row; identical
retries with the same Idempotency-Key replay via `replayMutation`; concurrent receipts converge on
one Task (one 200, one 409).

## Merge evidence — the handoff branch was already merged

The prior agent attempt `origin/agent/fe05735a-73645e3e` (commit 793ec5e2, "Link Finom paid Task
dependsOn to payment step and assign deal owner") has git patch-id
`0c95739dcbe948c2128342df8c6d17bfda2a0073`, identical to origin/main commit 36028078 — it was
merged verbatim. The base feature (creation/adoption + first tests) landed as 4524ec57. Nothing was
left to implement.

## Acceptance criteria → evidence

| Criterion | Evidence |
| --- | --- |
| 1. Verify first; implement only the gap | Inspected `cli/src/commands/sponsors.mjs` (`receivePayment`, `linkPayment`, sibling `followUp`), the sibling task-creation convention (`paymentFollowUp.ts`), and git log. Gap = none; see merge evidence above. |
| 2. Task auto-created on receive-payment / link-payment, linked, owner-assigned, dated | ddb test "creates the single Finom Task with instruction, owner, due date and payment dependency on receive-payment" (asserts description, instructionDocId, assigneeId = deal owner, dependsOn = receipt sourceId, date = today, subject) and "link-payment creates the same Finom Task for a ledger row linked after the fact" (org-owner fallback; unlink blocks completion). |
| 3. No duplicate on second call (reuse/adopt open task with the same link) | ddb tests "replays a retried receive-payment to the same single Task", "a second receipt adopts the open Task instead of creating parallel work" (dependsOn grows to [firstSourceId, secondSourceId]), "concurrent receipts converge on exactly one open Finom Task". |
| 4. Targeted tests only | No new tests needed — the existing suite already pins every criterion; this session re-ran them (below) and changed no test files. |

## Tests re-run 2026-11-04 (worktree of branch fix/receive-payment-dependent-task = origin/main d213cf9b)

`backend/tests/sponsor-finance-finom-task.ddb.ts` against real DynamoDB Local
(`docker run amazon/dynamodb-local -inMemory -sharedDb`, the same gate
`backend/scripts/test-sponsor-finance-transaction.sh` uses):
**7/7 pass, 0 fail** —
1. creates the single Finom Task with instruction, owner, due date and payment dependency on receive-payment
2. replays a retried receive-payment to the same single Task
3. a second receipt adopts the open Task instead of creating parallel work
4. a resolved Task lets the next receipt create a fresh one
5. link-payment creates the same Finom Task for a ledger row linked after the fact
6. concurrent receipts converge on exactly one open Finom Task
7. an unrelated open deal Task is never adopted as the Finom Task

`backend/tests/sponsor-finance.test.ts` (unit, includes `finomPaidTaskDescription` /
`finomPaidTaskActions`): **16/16 pass, 0 fail.**

## Prod read-only checks 2026-11-04

- `hub intake show fe05735a` → `Intake HTTP 503: request_failed` (service unavailable during the
  session), so the live task record could not be read; verification is from git, source and tests.
- Read-only `GET /api/tasks`, fully paginated: **532 todo + 88 waiting + 1406 done = 2024 Tasks
  scanned, 0** with `source: sponsor-finom` or tag `finom-invoice-paid`. No open Finom Task exists
  (no payment has been recorded through the new path since it merged 2026-11-03) and no duplicate
  rows exist anywhere in the pool.

## Remaining gaps

- None against the acceptance criteria.
- Observation, not a criterion: the CLI's `receive-payment`/`link-payment` stdout does not print
  the created/adopted Finom Task id (the route result carries `financeVersion`/`recordId` only; the
  id lives in the server-side history event). The Task surfaces through
  `dataops sponsors show deals <id>` openTasks and `dataops sponsors finance <deal-id>`
  (`paymentFollowUp.existingTasks`). Left untouched to avoid unrelated churn.
