---
title: "Restore Drill"
summary: "How to back up, validate, and restore DataOps execution data using PITR and portable exports."
doc_type: reference
tags:
  - backups
  - restore
  - runbook
systems:
  - aws
  - dynamodb
related_docs:
  - docs/v1-execution-data-safety.md
  - docs/v1-runtime-architecture.md
---

# Restore Drill

## Purpose

Run this drill before relying on production execution data. It proves you can
recover from accidental deletes, bad updates, or a full migration using both
AWS-native backups and portable exports.

## Backup Layers

Before any restore, make sure both layers are active:

1. **DynamoDB PITR** - point-in-time recovery is enabled on all durable
   execution tables (tasks, bundles, templates, users, files, notifications).
   This protects against accidental deletes and bad updates.
2. **Portable export** - an application-level JSONL snapshot that does not
   depend on DynamoDB internals. This is the migration path to Postgres or
   another store.

## On-Demand Backup Procedure

Create an on-demand backup before schema changes, bulk imports, migration
scripts, or risky releases:

```bash
aws dynamodb create-backup \
  --table-name dataops-v1-tasks \
  --backup-name dataops-v1-tasks-pre-migration-$(date +%Y%m%d%H%M%S)
```

Repeat for each durable table: `bundles`, `templates`, `users`, `files`,
`notifications`. Tag or name backups with the environment, date, and reason.

## Portable Export

Create a portable export:

```bash
npm --prefix work-engine run export:data -- /tmp/dataops-export
```

Or trigger the scheduled export route:

```bash
curl -X POST http://localhost:3000/api/cron/export
# Requires EXPORT_OUTPUT_DIR to be set on the work-engine
```

The export produces:

```text
manifest.json
users.jsonl
tasks.jsonl
bundles.jsonl
templates.jsonl
recurring_configs.jsonl
files.jsonl
notifications.jsonl
```

Password hashes and session tokens are redacted. File binaries are excluded;
only metadata is exported.

## Validation

Validate the export:

```bash
npm --prefix work-engine run validate:export -- /tmp/dataops-export
```

This checks manifest schema version, file presence, entity counts, checksums,
required fields, duplicate IDs, and relationship integrity.

## Dry-Run Import

Run a dry-run import to see what a restore would write without mutating any
data:

```bash
npm --prefix work-engine run dry-run:import -- /tmp/dataops-export
```

Output:

```json
{
  "valid": true,
  "errors": [],
  "totalRecords": 52,
  "wouldWrite": {
    "users": 3,
    "tasks": 12,
    "bundles": 2,
    ...
  },
  "skipped": {}
}
```

Exits zero when valid, non-zero when validation fails.

## PITR Restore

To restore a DynamoDB table to a specific point in time using AWS-native
backups:

1. Identify the target time (up to 35 days in the past with PITR).
2. Restore to a new table:

```bash
aws dynamodb restore-table-to-point-in-time \
  --source-table-name dataops-v1-tasks \
  --target-table-name dataops-v1-tasks-restored \
  --restore-date-time 2026-06-27T10:00:00Z
```

3. Verify the restored table has the expected records.
4. Switch the application to point at the restored table (via environment
   variable), or rename tables after verification.

## Full Restore Drill

Run this sequence end-to-end before production data becomes critical:

1. Create on-demand DynamoDB backups for all durable tables.
2. Create a portable export.
3. Validate the export.
4. Run a dry-run import to confirm record counts.
5. Restore or import into a staging environment.
6. Run the smoke checks below.
7. Export staging data again and compare entity counts.

### Smoke Checks After Restore

- List today's tasks (`GET /api/tasks?date=<today>`)
- Open a workflow bundle (`GET /api/bundles/:id`)
- Instantiate a workflow template
- Generate recurring tasks
- List due notifications (`GET /api/notifications`)
- List files for a task (`GET /api/files?taskId=<id>`)
- Export again and compare counts

## Known Limitations

- The export scans tables sequentially; there is no multi-table transactional
  snapshot guarantee.
- File export covers metadata only; binary backup requires S3 versioning or
  a separate artifact archive.
- The dry-run import validates and counts but does not write to a target
  database. A full import tool (for Postgres migration) is a follow-up.
