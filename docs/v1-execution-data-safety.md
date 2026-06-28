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

## Offsite Export Archives

The V1 SAM stack owns a retained S3 bucket for portable execution export
archives. The work-engine receives the bucket name and prefix through stack
environment variables:

- `DATAOPS_EXPORT_ARCHIVE_BUCKET`
- `DATAOPS_EXPORT_ARCHIVE_PREFIX` (default `execution-exports`)
- `DATAOPS_ENV`

Archive object keys use this shape:

```text
<prefix>/<environment>/<YYYY-MM-DD>/dataops-execution-<generated-at>.tar.gz
```

The key includes environment and generation time only. It must not include task
titles, user emails, operator names, customer names, credentials, signed URLs,
or other private data.

The archive object is a gzip-compressed tar containing `manifest.json` and the
portable JSONL entity files. It is still an application-level export and must
preserve the normal portable export safety rules: no password hashes, live
sessions, API keys, OAuth tokens, cookies, signed temporary URLs, private
credentials, raw binary payloads, or DynamoDB-only key dependency.

The SAM bucket is private, encrypted with S3-managed encryption, versioned,
retained on stack deletion/replacement, tagged for backup selection, and has a
lifecycle rule for noncurrent versions. Production operators must verify the
deployed bucket settings and at least one scheduled/admin archive object in AWS
before treating production execution data as critical.

## Portable Export Format

Portable exports are application-level snapshots.

Current implementation:

- `npm --prefix work-engine run export:data -- <export-dir>`
- `npm --prefix work-engine run validate:export -- <export-dir>`
- `npm --prefix work-engine run restore:drill -- --archive <file-or-s3-uri> --target-environment <non-prod> --output-dir .tmp/exports/restore-drill`

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
  "omitted_entities": []
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
- status/review metadata for artifacts
- storage provider
- `storage_uri`
- `filename`
- `checksum`
- `size_bytes`
- `created_at`

Binary backup is handled by S3 versioning, S3 replication, external system
exports, or a separate artifact export archive.

`artifacts.jsonl` is implemented in V1 and must be present in normal exports.
It contains metadata only. It must not contain binary payloads, large assistant
outputs, raw assistant logs, signed temporary URLs, OAuth tokens, cookies, API
keys, or private credentials. `assistant_job_id` must reference an exported
assistant job when present.

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
- every artifact `task_id`, `bundle_id`, and `file_id` references an entity
  from the same export or is empty
- every artifact `assistant_job_id` references an exported assistant job or is
  empty
- every assistant job `task_id`, `bundle_id`, `requested_by`,
  `output_artifact_ids`, and `retry_of_job_id` references an exported entity or
  is empty, and each job must reference at least one task or bundle
- every audit event `assistant_job_id` and `actor_id` references an exported
  entity or is empty
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
2. Create or select a portable export archive.
3. Generate restore evidence under `.tmp/exports/restore-drill`.
4. Validate the extracted export.
5. Run a dry-run import.
6. Restore or import into staging or a scratch table only after human approval.
7. Run smoke checks.
8. Export staging data again.
9. Compare entity counts and key checksums.

Minimum smoke checks:

- list today's tasks
- open a workflow bundle
- instantiate a template
- generate recurring tasks
- list due notifications
- list files for a task
- export again

The restore evidence report records the source archive URI/key, app git SHA,
export `generated_at`, manifest checksum summary, validation result, dry-run
import counts, skipped/invalid record counts, target environment, timestamp,
and smoke-check checklist result. The evidence command never writes production
data.

Production restore, import, table replacement, overwrite, delete, or data repair
is human-gated. Automated cron export, admin export, validation, restore
evidence, and dry-run import paths must not mutate production DynamoDB tables.

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
