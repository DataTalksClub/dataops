---
title: "Changing DynamoDB indexes"
summary: Why a global secondary index change cannot ride a normal deploy, and how to make one without building migration machinery.
doc_type: reference
schema_version: 1
tags:
  - operations
  - data
systems:
  - aws
  - dynamodb
related_docs: []
---

# Changing DynamoDB indexes

## Summary

- DynamoDB allows **one global secondary index created or deleted per stack update**.
- A rename is a delete plus a create, so it is two operations and fails as one deploy.
- Do index changes as an **offline job**, not through the deploy pipeline.
- While the data is disposable, prefer replacing the table over migrating it.

## The constraint

A template that removes one index and adds another in the same change produces
two index operations in a single CloudFormation update, which DynamoDB rejects.
The stack update fails partway rather than up front.

This is what made renaming `GSI-Bundle` to `GSI-Card` on the tasks table
awkward, and it is the entire reason the Sponsor CRM migration machinery
existed: issue #136 needed four new indexes on one table, which is four stack
updates.

## Do it offline, not in CI/CD

Do not build the migration into the deploy workflow. The Sponsor CRM version of
that grew a staged migrator, a guard step that blocked ordinary deploys, a
dispatch workflow and a digest-pinned test. It cost about 80 seconds on every
deploy, and when one of its pins went stale it blocked every deploy for weeks
while the migration it protected had already finished.

Instead:

1. Make the index change as a deliberate one-off operation against the table,
   run by an operator with credentials, outside the deploy path.
2. Update the template to declare the end state.
3. Deploy normally. CloudFormation sees no index change left to make.

The deploy pipeline should describe the desired state, not carry the machinery
for reaching it. Migration tooling that lives in the pipeline outlives the
migration and rots there.

## Prefer replacing the table

While a table's contents are disposable, replacing it is simpler and safer than
migrating it. A new table is created with every index it needs in one shot,
with no per-update limit to work around.

That is how the workflow card table was renamed: the old table was deleted, the
template declared the new one, and the deploy created it with the right
indexes. No staged migration, no guard, nothing left behind afterwards.

Two things to watch when replacing a table:

- `DeletionPolicy: Retain` and `UpdateReplacePolicy: Retain` mean CloudFormation
  will **not** delete the old table. It is orphaned out of the stack and keeps
  existing, and billing, until someone removes it by hand. Delete it explicitly.
- Renaming a table's logical ID while keeping an explicit `TableName` makes
  CloudFormation create a resource whose name is already taken. Delete the old
  table first.

## If the data is not disposable

Then the table cannot simply be replaced, and the change becomes a real
migration: add the new index, backfill the attribute it is keyed on, move reads
across, then remove the old index in a later update. Each index step is its own
stack update. Do the backfill offline as well.
