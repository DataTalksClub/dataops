---
title: "Session handoff, 2026-08-13"
summary: State of the card rename, knowledge repository move, infrastructure boundary and test work, with what is blocked and what to pick up next.
doc_type: reference
schema_version: 1
tags:
  - handoff
  - migration
systems:
  - dataops
related_docs: []
---

# Session handoff, 2026-08-13

Everything below is committed and pushed to `main` unless stated otherwise.
Nothing has been deployed: the deploy pipeline is red for reasons that predate
this session.

## What shipped

**Task templates point at internal process documents.** All 194 task
definitions across 11 templates now resolve to an internal document; none point
at a Google Doc. 63 previously-unmapped tasks were resolved by hand, and the 26
Google Doc template references moved into `sourceDocIds`. The mapping is
recorded as a generated process document covering all 102 Google Docs, including
the 14 that were split across several internal documents and therefore resolve
per task rather than per link. A test fails the build if a Google Docs link ever
reappears without an internal document.

**The workflow `bundle` domain is now `card`,** across backend, frontend,
infrastructure, tests, content and docs. About 3,800 occurrences. Two traps
worth knowing: "bundle" also named sponsor email template bundles and proof
bundles, which are different concepts and were renamed to `SponsorTemplateSet`
and `proofGrants` rather than to "card"; and the Trello importer already used
`card` for the Trello source card, so `cardFromTrello` and `planTrelloActiveCard`
had to be rebuilt to keep the two apart.

**Process documents moved to a private repository.**
`DataTalksClub/dataops-knowledge` holds the 2,127-file corpus with history
preserved, plus the authored workflow templates, the JSON schema and the
document authoring scaffolds. It backs up to S3 daily; the first backup is
verified in the bucket. The portal reads and writes it through the Contents API
with a token stored at `dataops-v1/knowledge/github-token`, and CI checks it out
with a read-only deploy key.

**The application can no longer create infrastructure.** `handler.ts` used to
call `createTables` on every cold start. That is gone, along with
`shouldAutoCreateTables` and the `DATAOPS_AUTO_CREATE_TABLES` escape hatch, so
no environment variable can make the app create tables against real AWS. A
missing table now fails with a message naming it.

**Infrastructure ownership moved to `aws-infra`.** Three account-level templates
that had drifted from their canonical copies were deleted here and reconciled
there, with their tests. Three commits in that repo: `e5547bd`, `447f1ee`,
`a21fd68`.

**About 8,000 lines of dead migration machinery deleted.** The Sponsor CRM GSI
apparatus (migrator, guard, contract, 57 tests, dispatch workflow, an 80-second
deploy step) had already completed its migration — all four indexes exist. The
reset apparatus was several hundred lines of approval ceremony to delete a table
holding zero rows.

**The backend suite went from never terminating to 19 seconds.** It was not
merely slow: a test leaked a dynalite handle and the runner waited forever. 1111
tests, 0 failures. Separately, 259 golden comparisons were traded for 112
authorization tests, which the suite badly needed since every other file runs
with `SKIP_AUTH=true`.

## What is blocked, and why

**The deploy.** Playwright end-to-end specs fail on assertions that were already
failing at `ba2ee05`, before any of this work: `history.length` arithmetic,
fixed `waitForTimeout` calls, and exact UI strings, inside two specs of 759 and
1289 lines. They live in an area another session was actively refactoring.

Until this is resolved, `dataops-v1-cards` does not exist, the portal is not
serving from the knowledge repository, and the card rename is not live. The old
`dataops-v1-bundles` table has already been deleted, with a backup at
`.local/pre-rename-backup/`.

Two ways forward: fix those assertions, or move the end-to-end suite off the
deploy's critical path so a flaky browser test cannot block infrastructure
changes. Given they were failing beforehand, the second is the faster unblock.

**After the deploy lands:** `dataops-v1-tasks` keeps 281 items, 153 of which
still carry a `bundleId` attribute. They will not resolve against the renamed
code, so clear them and re-run the Trello importer. Watch the first run —
DynamoDB permits only one index operation per stack update, and that table
changes `GSI-Bundle` to `GSI-Card`.

## Recurring lesson from this session

Three separate outages had the same shape: an assertion pinned to bytes or exact
text outlived the reason anyone cared.

- Whole-file SHA-256 pins over the deploy workflow broke on a change that
  swapped a test step for a coverage step, and blocked **every deploy for
  weeks**. A second set, off the critical path, had the Sponsor CRM reset
  workflow unable to pass its own self-check, unnoticed.
- A 1.4 MB golden fixture asserted parsed output for 258 documents against a
  Python implementation that no longer exists and could not be regenerated.
- End-to-end specs asserting exact UI copy went stale on a vocabulary rename.

All three are now removed or replaced by assertions about behaviour. When adding
a guard, prefer asserting the property, and keep it on the path that matters: a
guard checked only off the critical path is worse than no guard.

## Next, in order

1. **Unblock the deploy** (above). Everything AWS-side waits behind it.
2. **Finish git-authored templates.** The format, the lossless migration and the
   11 authored YAML files exist and are pushed to the knowledge repository.
   Remaining: point seeding at them, delete `DEFAULT_TEMPLATES` from
   `seed-templates.ts`, and demote the runtime template CRUD from issue #157 —
   git and the API cannot both be authoritative.
3. **Propagate template changes to cards** (issue #167). Unblocked by the rename
   and by 2.
4. **Move `createTables` out of `backend/src`** so no infrastructure-creating
   code ships in the Lambda, with one local setup script composing dynalite,
   tables and seeding.
5. **Deploy speed.** One duplicate build was removed, worth about 88 seconds.
   The remaining cost is structural: SAM does not deduplicate functions sharing
   a `CodeUri`, so all six build the same artifact. Building once and copying
   measured *slower* and nearly shipped a broken artifact, so the real lever is
   bundling with esbuild to shrink the 78 MB artifact.
6. **Move the application stack template to `aws-infra`.**
   `infra/template.full.yaml` is the last infrastructure definition left in this
   repository. It cannot simply move: all six Lambdas use `CodeUri: ..` with a
   makefile build, so SAM packages the app from here and the template has to sit
   beside the code it packages. Moving it means decoupling the artifact — either
   upload it to S3 and pass the key as a parameter, or have CI check out
   `aws-infra` during deploy. `aws-infra` also has no CI; its stacks are applied
   by a credentialed operator. The same decoupling is what would make a smaller
   deploy possible.
7. **Finish auditing one-shot migration scripts.** The reset and GSI apparatus
   are gone. Still to classify: `migrate-sponsor-crm.ts`, `scrub-task-titles.ts`,
   `dry-run-import.ts`, `restore-drill.ts`, the `import-*` scripts, and
   `export-templates-to-yaml.ts`, which its own header says to delete once the
   authored templates become the source of truth. `migrate-data.ts` stays: it is
   what repopulates the tables after the deploy. The rule that keeps catching
   things: a migration that has run, and a guard for a migration that has
   finished, are dead code.
8. **Purge the corpus from git history.** Removed from the working tree but
   still in all 405 commits; the pack is 123 MB. Needs a force-push when no
   other session has uncommitted work. Note it does not un-publish: rotate
   anything credential-shaped rather than relying on the rewrite.

## Loose ends

- `backend/src/sponsorCrmMigration/` is 2,902 lines that nothing in
  `backend/src` imports. Not dead — issue #115 is open — but it has no business
  shipping in the Lambda. Move it out rather than deleting it.
- `DataTalksClub/dataops-content` was created before the naming decision landed
  on `dataops-knowledge`. It is a redundant duplicate and safe to delete.
- The knowledge repository does not validate or lint its own content on push.
  A document changed there is now checked by nothing.
- `backend/scripts/frontend-artifact.test.mjs` proves the packaged handler
  resolves nothing outside its artifact. It caught a real regression this
  session and **is not run by any workflow**.
- `PUT /api/tasks/:id` is last-write-wins with no version check, and
  `taskHistory` is read-modify-write, so concurrent edits silently drop history
  events. Templates and sponsor bookings have version checks; the core Task
  object does not.
- None of this work has a GitHub issue, so there is nothing to groom against or
  post evidence to, which `docs/PROCESS.md` expects.
