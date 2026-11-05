# DONE evidence — intake 8328bb8d (CLI gap: record platform payout income)

The gap was already closed on main by `e7c75da1` ("feat(bookkeeping): add
platform payout income", 2026-11-01, pushed directly to main — it sits on
main's first-parent chain, no PR number in the subject). Later work extended
the same command with the credit-note path (`46c3c0d5`, intake 965686b1,
2026-11-02) and hardened it (`47b1ce03`). This file records the 2026-11-05
re-verification on current origin/main (`0e9228de`) and live prod, plus the
two additions this PR makes (one SKILL.md sentence and one pin). No product
code changes were needed.

- Inventory — CLI: `dataops bookkeeping add-income` in the Finance group
  (`cli/src/cli.mjs:128` registers the family; command exported at
  `cli/src/commands/bookkeeping.mjs:421`; usage in the family help at
  `cli/src/commands/bookkeeping.mjs:31-44`). Dry-run first, `--apply` writes
  (`addIncome`, `cli/src/commands/bookkeeping.mjs:305`), matching the
  sync/classify/facts/set verb style.
- Inventory — record shape (`platformIncomeRecord`,
  `cli/src/commands/bookkeeping.mjs:229`): every ask of the intake is covered —
  platform name `--counterparty`, `--amount` (positive, two decimals),
  `--currency` (3-letter ISO), received date `--date` (transactionDate), payout
  period `--period` (incomePeriod, YYYY-MM) and reference `--reference`
  (statementRef, the idempotency key), plus `--category` and `--comment`.
  Stored as `entryType: "income"`, `sourceType: "platform-payout"`,
  `sourceKey: "platform-payout:<reference>"`.
- Inventory — validation: CLI UsageErrors for a non-date, non-positive amount,
  non-ISO currency and non-YYYY-MM period; the backend route re-validates
  platform-payout rows (`backend/src/routes/bookkeepingTransactions.ts:127-136`:
  entryType must be income, sourceKey prefix, statementRef present,
  incomePeriod month, positive amount). Idempotency holds on both sides: the
  CLI replays an existing reference and refuses conflicting details
  (`checkIncomeIdentity`), and a duplicate POST returns 200 with the same id.
- Inventory — reports: `backend/src/reconcile/service.ts:341-357` collects
  platform-payout income rows for the report period (by incomePeriod and by
  addedAt month), and `dataops reconcile report` prints them under a dedicated
  "Platform payouts" section (`cli/src/commands/reconcile.mjs:224`). The
  finance summary counts them as ordinary income ledger rows by entryType
  (rules in `backend/src/finance/summary.ts:106-120`); the repo does not split
  income by source in the summary — the source distinction lives in the
  reconcile report, which is where `e7c75da1` wired it. `docs/finance-summary.md`
  documents the ledger sources including platform payouts (line 29) and the
  credit-note flag (line 80).
- Tests on this tree (2026-11-05): `cli/test/bookkeeping.test.mjs` 23/23
  (dry-run default and idempotent apply at :254, replay and conflict rejection
  at :281, `--type refund` validation at :418, and this PR's new agent-guide
  pin at :434) and `cli/test/reconcile.test.mjs` (report includes non-sponsor
  platform payouts at :417) — 51/51 across the two files;
  `backend/tests/reconcile-platform-payouts.test.ts` 2/2 (route creation,
  duplicate idempotency, report listing for income and added months, 400 field
  errors). Only targeted suites were run.
- Prod checks were read-only CLI only (2026-11-05): `dataops bookkeeping
  --help` documents add-income on the deployed CLI; a dry-run
  `dataops bookkeeping add-income … --json` (no `--apply`) returned
  `mode: "dry-run"`, `outcome: "would-create"` with the full record shape
  (sourceType platform-payout, sourceKey prefix, incomePeriod) and wrote
  nothing; `dataops reconcile report --period 2026-10` shows a live
  "Platform payouts (1)" section (Amazon 59.99 EUR, income 2026-10, added
  2026-11-01). Nothing was written to prod, no direct DB or AWS access.
- What this PR adds: (1) one sentence in `cli/skill/SKILL.md` (the canonical
  agent guide — `agent-guide` renders it) documenting the payout recording
  path, which no doc there mentioned before; (2) the pin "agent-guide documents
  dataops bookkeeping add-income" in `cli/test/bookkeeping.test.mjs:434`
  (house style per `cli/test/offers.test.mjs:223` and PR #335), so the
  documentation cannot silently regress; (3) this DONE file. No file in either
  repo mentioned `8328bb8d` before this commit.

Remaining gaps, none blocking:

- `dataops finance summary` does not break income down by source (sponsor
  income vs platform payouts); platform payouts count as generic income. The
  reconcile report is the only surface that separates them. Splitting the
  summary is out of scope for this intake.
- Hub was unavailable during this session (Intake HTTP 503 on
  `hub intake show 8328bb8d`), so the intake could not be annotated in Hub;
  merge-state bookkeeping stays with the operator.
- `cli/README.md`'s Commands table is selective and omits several registered
  families (already noted in DONE-0f847429.md).
