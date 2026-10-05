> Part 1 of 4 of the [V1 Execution State Schema](../v1-execution-state-schema.md).
> [Part 2](part-2-work-entity-tables.md) covers the work-entity tables (tasks,
> cards, templates, recurring configs); [Part 3](part-3-supporting-entity-tables.md)
> covers the supporting-entity tables; [Part 4](part-4-query-migration-and-checklist.md)
> covers query requirements, migration notes, and the implementation checklist.

## Summary

DataOps V1 uses DynamoDB for mutable execution state once `work-engine` is
connected to the portal.

This schema is for runtime state:

- tasks
- workflow cards
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
- `backend/src/db/tableNames.ts` resolves declared runtime table names.
- `backend/scripts/setup-local.ts` owns explicit local dynalite setup and seeds.
- `backend/docs/specs.md` documents the original model.

For production V1:

- SAM/CloudFormation owns table lifecycle.
- Production handlers don't create tables on cold start.
- Table names come from environment variables.
- Local/test tooling may create dynalite tables only through script/test-owned
  setup helpers that are excluded from the Lambda artifact.

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
- workflow cards
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
- `DATAOPS_CARDS_TABLE`
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

Current implementation reads these environment variables in `backend/` and
keeps the local names above. The Lambda handler never creates tables. Local
developers run `npm --prefix backend run setup:local`, while tests explicitly
start an in-memory database fixture.

The deployed SAM template declares stack-owned DynamoDB tables with names such
as `${AWS::StackName}-tasks`, `${AWS::StackName}-cards`, and
`${AWS::StackName}-files`. The private `WorkEngineFunction` receives those table
names through the `DATAOPS_*_TABLE` environment variables and has table-scoped
DynamoDB permissions for the actions used by the work-engine data layer.

## ID Rules

Every exported entity needs a stable application-level ID.

Required rules:

- IDs are explicit fields such as `task_id`, `card_id`, and `template_id`.
- DynamoDB `PK` and `SK` are implementation details, not the public data model.
- Exports may include source keys for traceability, but migrations can't depend
  on source keys only.
- Relationships use explicit ID fields, not embedded DynamoDB key strings.
- Timestamps use ISO 8601 strings.
- Dates use `YYYY-MM-DD`.

Export field names should use snake case. Runtime TypeScript can keep
camelCase if the export layer maps fields consistently.
