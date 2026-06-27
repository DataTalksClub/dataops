---
title: "V1 Execution Data Safety"
summary: "Backup, restore, and portable export definition for DataOps V1 execution data."
doc_type: reference
tags:
  - v1
  - backups
  - export
  - migration
systems:
  - aws
  - dynamodb
  - s3
related_docs:
  - docs/v1-runtime-architecture.md
  - docs/v1-execution-state-schema.md
---

# V1 Execution Data Safety

## Summary

Yes, V1 should use DynamoDB for execution state once the work engine is
deployed. DynamoDB backups are easy to create, but backups and portable exports
solve different problems.

DynamoDB backups protect the running AWS service. Portable exports protect Data
Talks Club ownership of the operational data and make a later Postgres migration
possible.

We need both before production execution data becomes valuable.

## Backup Layers

## Point-In-Time Recovery

Enable point-in-time recovery on every durable DynamoDB execution table.

Use it for:

- accidental deletes
- bad updates
- recovering a table to a recent point in time

Don't rely on it for:

- reviewing records in Git
- moving to Postgres
- environment-independent archival exports

## On-Demand Backups

Create an on-demand backup before:

- schema changes
- bulk imports
- migration scripts
- risky releases
- manual production repair work

Backups should include the table name, environment, date, and reason in the
backup name or tags.

## AWS Backup

Use AWS Backup after execution data becomes production-critical.

Use it for:

- scheduled retention
- cross-region or cross-account backup plans
- centralized backup policy
- compliance-style restore coverage

## S3 Versioning

Use S3 versioning for buckets that store uploaded files, generated artifacts, or
export bundles.

DynamoDB records should reference S3 objects by `storage_uri`, checksum, and
metadata. DynamoDB shouldn't store the file binaries.

## Portable Export Format

Portable exports are application-level snapshots.

Required archive layout:

```text
manifest.json
users.jsonl
tasks.jsonl
bundles.jsonl
templates.jsonl
recurring_configs.jsonl
files.jsonl
notifications.jsonl
artifacts.jsonl
assistant_jobs.jsonl
audit_events.jsonl
```

Files may be omitted only when the entity isn't implemented yet. The manifest
must list omitted entity types explicitly.

## Manifest

`manifest.json` fields:

- `schema_version`
- `generated_at`
- `source_environment`
- `source_stack`
- `source_region`
- `app_git_sha`
- `export_format_version`
- `entity_files`
- `entity_counts`
- `checksums`
- `redactions`
- `omitted_entities`

Example:

```json
{
  "schema_version": "dataops.execution.v1",
  "generated_at": "2026-06-27T00:00:00Z",
  "source_environment": "prod",
  "source_stack": "dataops-v1",
  "source_region": "eu-west-1",
  "app_git_sha": "unknown",
  "export_format_version": 1,
  "entity_files": {
    "tasks": "tasks.jsonl"
  },
  "entity_counts": {
    "tasks": 42
  },
  "checksums": {
    "tasks.jsonl": "sha256:..."
  },
  "redactions": [
    "users.password_hash",
    "sessions"
  ],
  "omitted_entities": [
    "assistant_jobs"
  ]
}
```

## Entity Files

Use JSON Lines for entity files.

Rules:

- one JSON object per line
- deterministic key ordering where practical
- stable application IDs
- explicit relationship IDs
- no dependency on DynamoDB `PK` and `SK`
- optional `source_dynamodb` trace fields allowed
- no secrets
- no live session tokens

Normal export field names should use snake case even if runtime code uses
camelCase.

## Redaction Rules

Normal exports exclude:

- password hashes
- session tokens
- API keys
- OAuth tokens
- cookies
- signed URLs that grant temporary access
- private credentials in comments or metadata if detectable

Admin-only forensic exports may include more fields, but that mode must be
explicit, documented, and protected separately.

## Files And Artifacts

Portable export includes metadata, not binaries.

File and artifact records should include:

- `file_id` or `artifact_id`
- related task, bundle, or assistant job IDs
- `storage_uri`
- `filename`
- `checksum`
- `size_bytes`
- `created_at`

Binary backup is handled by S3 versioning, S3 replication, external system
exports, or a separate artifact export archive.

## Restore Validation

The validator must check:

- manifest schema version
- file presence
- entity counts
- checksums
- required fields
- duplicate IDs
- relationship integrity
- unknown enum values
- timestamp/date parseability
- redaction compliance

Relationship checks:

- every task `bundle_id` references an exported bundle or is empty
- every task `assignee_id` references an exported user or is empty
- every task `template_id` references an exported template or is empty
- every file `task_id` references an exported task
- every artifact `task_id`, `bundle_id`, and `assistant_job_id` references an
  entity from the same export or is empty
- every notification relation references an exported entity or is empty

## Dry-Run Import

A dry-run import must:

- read the manifest
- validate all entity files
- build an in-memory relationship graph
- report insert/update counts
- report skipped records
- report invalid records
- write no production data

This is the safety check before using an export for migration or restore.

## Postgres Migration Path

The export structure should map cleanly to relational tables:

- `users.jsonl` to `users`
- `tasks.jsonl` to `tasks`
- `bundles.jsonl` to `bundles`
- `templates.jsonl` to `templates`
- `recurring_configs.jsonl` to `recurring_configs`
- `files.jsonl` to `files`
- `notifications.jsonl` to `notifications`
- `artifacts.jsonl` to `artifacts`
- `assistant_jobs.jsonl` to `assistant_jobs`
- `audit_events.jsonl` to `audit_events`

The export shouldn't require DynamoDB to read it. A migration script should be
able to read the archive from disk or S3 and write to Postgres.

## Restore Drill

Run a restore drill before relying on production execution data:

1. Create on-demand DynamoDB backups.
2. Create a portable export.
3. Validate the export.
4. Restore or import into a staging environment.
5. Run smoke checks.
6. Export staging data again.
7. Compare entity counts and key checksums.

Minimum smoke checks:

- list today's tasks
- open a workflow bundle
- instantiate a template
- generate recurring tasks
- list due notifications
- list files for a task
- export again

## Implementation Checklist

Use this checklist when implementing data safety.

- Add PITR to SAM table resources.
- Add production table retention policy.
- Add an on-demand backup runbook.
- Add export command or authenticated admin endpoint.
- Add export manifest generation.
- Add JSONL writers for every durable entity.
- Add redaction rules.
- Add restore validator.
- Add dry-run import.
- Add tests for export structure and validation failures.
