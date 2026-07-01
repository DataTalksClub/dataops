---
title: "V1 Execution State Schema"
summary: "Production-facing schema definition for DataOps V1 execution state in DynamoDB, with portable IDs and future migration boundaries."
doc_type: reference
tags:
  - v1
  - data
  - dynamodb
  - work-engine
systems:
  - aws
  - dynamodb
  - lambda
related_docs:
  - docs/v1-runtime-architecture.md
  - docs/v1-execution-data-safety.md
  - backend/docs/specs.md
---

# V1 Execution State Schema

## Summary

DataOps V1 uses DynamoDB for mutable execution state once `work-engine` is
connected to the portal.

This schema is for runtime state:

- tasks
- workflow bundles
- reminders
- notifications
- runtime template instances
- file metadata
- operator identity

It isn't for process knowledge because Markdown under `content/` keeps SOPs and
prompt templates. The same directory keeps reviewed workflow templates,
references, and canonical operating docs.

Portability is the design constraint, and DynamoDB can be the V1 database. The
application records still need stable business IDs and relationship fields so we
can export the data and migrate to Postgres later.

## Current State

The deployed DataOps stack now owns the V1 execution-state DynamoDB tables and
the private `WorkEngineFunction` that uses them through the portal broker.

Runtime state access lives in `backend/`:

- `backend/src/types.ts` defines the runtime entities.
- `backend/src/db/setup.ts` creates local/prototype DynamoDB tables.
- `backend/docs/specs.md` documents the original model.

For production V1:

- SAM/CloudFormation owns table lifecycle.
- Production handlers don't create tables on cold start.
- Table names come from environment variables.
- Local/test mode may keep dynalite and auto-created local tables.

## Storage Boundary

Store in Git:

- SOPs
- reviewed task templates
- workflow definitions
- assistant prompts
- process references
- screenshots and small reviewed process assets

Store in DynamoDB:

- operator users or portal actors
- tasks and task status
- workflow bundles
- instantiated template metadata
- recurring task configs
- reminders and notifications
- file and artifact metadata
- assistant job metadata
- audit events

Store in S3 or external private systems:

- uploaded files
- generated artifacts
- invoices, receipts, statements, raw exports
- large assistant outputs

DynamoDB stores metadata and references for files/artifacts and doesn't store
large binaries.

## Table Ownership

All production tables should be declared in the SAM template that deploys the
DataOps runtime.

Table defaults:

- billing mode: `PAY_PER_REQUEST`
- point-in-time recovery: enabled for durable tables
- deletion policy: `Retain` for production durable tables
- tags: `Project=DataOps`, `App=DataOpsV1`, `DataClass=ExecutionState`
- physical names: stack-scoped and environment-scoped
- IAM: least privilege for `WorkEngineFunction`

Environment variables:

- `DATAOPS_TASKS_TABLE`
- `DATAOPS_BUNDLES_TABLE`
- `DATAOPS_TEMPLATES_TABLE`
- `DATAOPS_USERS_TABLE`
- `DATAOPS_FILES_TABLE`
- `DATAOPS_ARTIFACTS_TABLE`
- `DATAOPS_NOTIFICATIONS_TABLE`
- `DATAOPS_SESSIONS_TABLE`
- `DATAOPS_ASSISTANT_JOBS_TABLE`
- `DATAOPS_AUDIT_EVENTS_TABLE`

Local defaults may map to the existing prototype names:

- `Tasks`
- `Projects`
- `Templates`
- `Users`
- `Files`
- `Artifacts`
- `AssistantJobs`
- `AuditEvents`
- `Notifications`
- `Sessions`

Current implementation reads these environment variables in `work-engine` and
keeps the local defaults above. The Lambda handler auto-creates tables only in
test/local mode or when `DATAOPS_AUTO_CREATE_TABLES=true`.

The deployed SAM template declares stack-owned DynamoDB tables with names such
as `${AWS::StackName}-tasks`, `${AWS::StackName}-bundles`, and
`${AWS::StackName}-files`. The private `WorkEngineFunction` receives those table
names through the `DATAOPS_*_TABLE` environment variables and has table-scoped
DynamoDB permissions for the actions used by the work-engine data layer.

## ID Rules

Every exported entity needs a stable application-level ID.

Required rules:

- IDs are explicit fields such as `task_id`, `bundle_id`, and `template_id`.
- DynamoDB `PK` and `SK` are implementation details, not the public data model.
- Exports may include source keys for traceability, but migrations can't depend
  on source keys only.
- Relationships use explicit ID fields, not embedded DynamoDB key strings.
- Timestamps use ISO 8601 strings.
- Dates use `YYYY-MM-DD`.

Export field names should use snake case. Runtime TypeScript can keep
camelCase if the export layer maps fields consistently.

## Core Tables

## Tasks Table

Tasks cover daily work items and follow-ups, plus reminders, checklist steps,
and instantiated workflow tasks.

Application fields:

- `task_id`
- `description`
- `date`
- `status`
- `source`
- `comment`
- `instructions_doc_id`
- `instructions_url`
- `link`
- `required_link_name`
- `requires_file`
- `assignee_id`
- `bundle_id`
- `template_id`
- `template_task_ref`
- `recurring_config_id`
- `stage_on_complete`
- `tags`
- `created_at`
- `updated_at`
- later: `completed_at`
- later: `completed_by`

Current DynamoDB access patterns:

- get task by ID
- list tasks for a date
- list tasks in a date range
- list tasks by bundle
- list tasks by status

Recommended indexes:

- table key: `PK=TASK#{task_id}`, `SK=TASK#{task_id}`
- `GSI-Date`: partition `date`, sort `status`
- `GSI-Bundle`: partition `bundle_id`, sort `date`
- `GSI-Status`: partition `status`, sort `date`

## Bundles Table

Bundles represent workflow runs or operating packages.

Examples:

- podcast episode
- newsletter issue
- webinar
- recurring operations bundle

Application fields:

- `bundle_id`
- `title`
- `description`
- `anchor_date`
- `template_id`
- `status`
- `stage`
- `references`
- `bundle_links`
- `tags`
- `created_at`
- `updated_at`

Recommended key:

- `PK=BUNDLE#{bundle_id}`, `SK=BUNDLE#{bundle_id}`

Optional future indexes:

- status/stage by anchor date
- template by anchor date

## Templates Table

Templates are runtime records that the engine can instantiate.

Application fields:

- `template_id`
- `source_doc_id`
- `name`
- `type`
- `tags`
- `default_assignee_id`
- `references`
- `bundle_link_definitions`
- `task_definitions`
- `trigger_type`
- `trigger_schedule`
- `trigger_lead_days`
- `created_at`
- `updated_at`

Important boundary:

- canonical workflow templates live in Git
- DynamoDB template records are runtime copies or generated projections

Recommended key:

- `PK=TEMPLATE#{template_id}`, `SK=TEMPLATE#{template_id}`

## Recurring Configs Table

Recurring configs are schedules that create repeated tasks or bundles.

Application fields:

- `recurring_config_id`
- `description`
- `cron_expression`
- `assignee_id`
- `enabled`
- `created_at`
- `updated_at`
- later: `last_generated_at`
- later: `next_due_at`

Recommended key:

- either a dedicated table with `PK=RECURRING#{recurring_config_id}`,
  `SK=RECURRING#{recurring_config_id}`
- or the tasks table only if the access patterns are intentionally shared

Recommended future index:

- enabled/due schedule lookup for cron generation

## Users Table

Users are portal actors and assignees.

Application fields:

- `user_id`
- `name`
- `email`
- `created_at`
- later: `role`
- later: `active`

Normal exports must not include password hashes or auth secrets.

Recommended key:

- `PK=USER#{user_id}`, `SK=USER#{user_id}`

## Files Table

Files store metadata for files attached to tasks or workflow bundles.

Application fields:

- `file_id`
- `task_id`
- `bundle_id`
- `filename`
- `category`
- `tags`
- `storage_uri`
- `checksum`
- `size_bytes`
- `created_at`

Recommended indexes:

- table key: `PK=FILE#{file_id}`, `SK=FILE#{file_id}`
- `GSI-Task`: partition `task_id`, sort `SK`
- later: `GSI-Bundle`: partition `bundle_id`, sort `created_at`

The current prototype uses `storagePath`, but production should use
`storage_uri` and make the storage backend explicit.

## Artifacts Table

Artifacts store metadata for generated or operational outputs. DynamoDB does
not store binaries, large generated documents, raw assistant logs, signed URLs,
or secrets.

Application fields:

- `artifact_id`
- `type`
- `title`
- `description`
- `status`
- `storage_provider`
- `storage_uri`
- `filename`
- `content_type`
- `checksum`
- `size_bytes`
- `visibility`
- `data_class`
- `task_id`
- `bundle_id`
- `assistant_job_id`
- `file_id`
- `source_type`
- `created_by`
- `reviewed_by`
- `created_at`
- `updated_at`
- `reviewed_at`
- `tags`
- `metadata`

Recommended key:

- `PK=ARTIFACT#{artifact_id}`, `SK=ARTIFACT#{artifact_id}`

The V1 implementation filters artifacts by task, bundle, assistant job, file,
status, and type. Dedicated GSIs can be added when production access patterns
and volume require them.

`status=approved` is the only status that satisfies an artifact proof gate.
`assistant_job_id` references an exported assistant job when present.

## Notifications Table

Notifications cover operator reminders, follow-ups, alerts, and UI inbox items.

Application fields:

- `notification_id`
- `message`
- `user_id`
- `task_id`
- `bundle_id`
- `template_id`
- `due_at`
- `dismissed`
- `created_at`
- later: `dismissed_at`

Recommended future indexes:

- user/dismissed/due lookup for inbox
- due notifications for scheduled reminders

## Sessions Table

Sessions store server-side session state only if the portal needs it.

Application fields:

- `session_id`
- `user_id`
- `created_at`
- `expires_at`

Sessions aren't part of normal portable exports, so they may use TTL and don't
need long-retention backups.

## Assistant Jobs Table

Assistant jobs track long-running assistant work.

Fields:

- `assistant_job_id`
- `assistant_type`
- `title`
- `status`
- `task_id`
- `bundle_id`
- `requested_by`
- `input_refs`
- `output_artifact_ids`
- `log_refs`
- `approval_required`
- `approval`
- `attempt_count`
- `max_attempts`
- `retry_of_job_id`
- `last_error`
- `created_at`
- `queued_at`
- `started_at`
- `completed_at`
- `updated_at`

Statuses are `draft`, `queued`, `running`, `waiting_approval`, `approved`,
`rejected`, `retrying`, `succeeded`, `failed`, and `canceled`. Jobs must link to
at least one task or bundle. Outputs link to artifact metadata through
`output_artifact_ids`; raw transcripts and unbounded logs are artifact/log
references, not DynamoDB blobs.

## Audit Events Table

Audit events record assistant lifecycle changes and can later hold broader
workflow history.

Fields:

- `audit_event_id`
- `assistant_job_id`
- `actor_id`
- `action`
- `summary`
- `metadata`
- `created_at`

Audit events should be append-only.

## Query Requirements For V1

The schema must support:

- today's tasks
- overdue tasks
- tasks due in the next seven days
- tasks by assignee
- tasks by status
- tasks by bundle
- active bundles
- bundles by stage
- recurring configs due soon
- unread or due notifications
- task-linked file/artifact metadata
- template instantiation by template ID
- export of every durable entity type

## Migration Notes

To keep a future Postgres migration straightforward:

- keep stable IDs on every entity
- keep relationship fields explicit
- avoid storing only nested opaque task graphs
- store dates/timestamps consistently
- store generated projections separately from canonical Git documents
- keep enum values documented
- record schema version in exports

Postgres tables can map almost directly from the application entities:

- `users`
- `tasks`
- `bundles`
- `templates`
- `recurring_configs`
- `files`
- `notifications`
- `artifacts`
- `assistant_jobs`
- `audit_events`

## Implementation Checklist

Use this checklist when implementing the schema.

- Move production table names to environment variables.
- Keep local dynalite defaults for tests and development.
- Add SAM table resources with PITR and retain policy.
- Add least-privilege DynamoDB permissions for `WorkEngineFunction`.
- Add tests for table-name resolution.
- Add tests for core query paths.
- Keep export mapping in sync with this schema.
