---
title: "V1 Runtime Architecture"
summary: "Architecture decision for DataOps V1: one public Lambda, private work-engine Lambda, DynamoDB execution state, Git-backed knowledge, and portable exports."
doc_type: reference
tags:
  - v1
  - architecture
  - work-engine
  - backups
systems:
  - aws
  - lambda
  - dynamodb
  - github
related_docs:
  - docs/architecture.md
  - docs/operations-manager-platform-jtbd.md
  - docs/repository-structure-recommendation.md
---

# V1 Runtime Architecture

## Summary

DataOps V1 stays on the current serverless architecture. We're not changing to
a different hosting model or frontend framework for V1.

The runtime decision is:

- Keep the current Python `DocsFullAppFunction` as the only public entry point.
- Add the TypeScript `work-engine` as a private SAM-managed Node.js Lambda when
  we connect runtime task execution.
- Broker same-origin `/work/api/*` requests through the authenticated Python
  full app into the private work-engine Lambda.
- Store operational execution state in DynamoDB tables managed by
  CloudFormation/SAM.
- Keep process knowledge in Git-backed Markdown under `content/`.
- Store private or bulky artifacts in S3 or external systems, with DynamoDB
  holding metadata and proof links.
- Add both AWS-native backups and application-level portable exports before
  production execution data becomes valuable.

## Current State

The deployed V1 app now includes DynamoDB execution-state tables and a private
work-engine Lambda connected behind the public portal.

The deployed stack is still the protected Python docs/full-app Lambda:

- `.github/workflows/deploy-dataops-v1.yml` builds and deploys
  `lambda-functions/template.full.yaml`.
- `lambda-functions/template.full.yaml` defines `DocsFullAppFunction` and
  Secrets Manager access.
- `lambda-functions/template.full.yaml` declares the DataOps execution tables.
  It covers task/bundle/template/user state, file metadata, artifact metadata,
  notifications, and sessions.
- Durable execution tables have point-in-time recovery and retain policies.
- `lambda-functions/template.full.yaml` defines `WorkEngineFunction` as a
  private Node.js Lambda without a Function URL.
- `DocsFullAppFunction` invokes `WorkEngineFunction` and passes the shared
  portal secret name.
- `WorkEngineFunction` receives stack-owned `DATAOPS_*_TABLE` names and has
  table-scoped DynamoDB permissions for the work-engine data layer.

## Public Entry Point

Use one public Lambda Function URL:

```text
Browser -> DocsFullAppFunction -> frontend/docs/search/git APIs
Browser -> DocsFullAppFunction -> /work/api/* broker -> private WorkEngineFunction
```

The Python full app remains responsible for:

- login and protected session
- frontend serving
- docs/search/lint/parse APIs
- Git-backed markdown editing
- request brokering to work-engine.

We shouldn't expose work-engine as a second public Function URL in V1. A second
public URL would create CORS, duplicate auth, and another security surface.

## Work API Routes

Add these routes when work-engine is connected:

```text
GET /work
GET /work/*
ANY /work/api/*
GET /work/health
```

Route behavior:

- `/work` and `/work/*` serve the same DataOps frontend shell.
- `/work/api/*` requires the existing portal auth first.
- The Python full app strips `/work` and invokes work-engine with `/api/*`.
- The Python full app passes trusted portal headers to the private Lambda:
  `x-portal-auth`, `x-portal-secret`, `x-user-id`, and later
  `x-user-email`.
- The Python full app does not forward browser `Authorization` headers,
  portal cookies, or unrelated browser cookies to work-engine.
- Work-engine accepts trusted portal headers only when
  `WORK_ENGINE_AUTH_MODE=portal` and the shared portal secret matches.
- Don't use test-only `SKIP_AUTH=true` in production.

## Auth Strategy

V1 keeps the existing portal auth as the outer perimeter.

Short term:

- current basic-auth/session protects all public surfaces
- work-engine is private and callable only by `DocsFullAppFunction`
- the browser session is the portal `dtc_auth` cookie, not a work-engine bearer
  token
- browser work calls use same-origin `/work/api/*`; the frontend does not use a
  separate work-engine URL, localStorage bearer token, CORS flow, or standalone
  DataTasks sign-in
- initial actor can be `portal-admin` until real portal users are implemented
- in production portal mode, work-engine hides `/api/auth/*` and `/api/me`
  returns the portal actor from trusted headers.

Later:

- replace single-user basic auth with real user identity
- use the same identity for `completedBy`, audit events, task assignments, and
  assistant jobs.

## Execution State

DynamoDB is the V1 execution-state store once work-engine is deployed.

Execution data belongs in DynamoDB, not Markdown:

- users
- tasks
- workflow bundles
- workflow/runtime templates
- recurring configs
- notifications
- file metadata
- artifact metadata
- assistant jobs
- reminders and follow-up state
- audit/history events

Process knowledge stays in Git-backed Markdown:

- SOPs
- references
- communication templates
- workflow-template source documents
- assistant prompts
- screenshots used by process docs.

## DynamoDB Tables

The current work-engine code expects these logical entities:

- tasks
- bundles
- templates
- users
- files metadata
- artifact metadata
- notifications
- sessions
- assistant jobs
- audit events

For production V1, CloudFormation/SAM should own table lifecycle, and
work-engine must not create production tables on cold start.

Table requirements:

- stack-scoped physical names
- `PAY_PER_REQUEST` billing
- point-in-time recovery enabled for durable tables
- tags for DataOps and backup selection
- deletion protection or retain policy for production
- least-privilege IAM from `WorkEngineFunction`
- environment variables for table names
- local/test defaults can keep dynalite auto-create behavior.

`DataOpsSessionsTable` is session state for the legacy/standalone work-engine
auth model and local tests. It is not the shared production portal session
source in V1. Production browser sessions are owned by the Python portal. The
sessions table is tagged as `SessionState` and intentionally does not get the
same point-in-time recovery requirement as durable execution-state tables such
as tasks, bundles, templates, users, files, and notifications.

`DataOpsArtifactsTable` is durable execution state for artifact metadata only.
It receives point-in-time recovery and retain policies, and `WorkEngineFunction`
gets its name through `DATAOPS_ARTIFACTS_TABLE`. Artifact binaries and large
generated outputs remain in S3 or existing private external systems.

## Backups

Use AWS-native backups for operational recovery:

- DynamoDB point-in-time recovery on all durable execution tables.
- On-demand DynamoDB backups before migrations, schema changes, bulk imports,
  and risky releases.
- AWS Backup plan for scheduled long-retention backups once execution data is
  production-critical.
- S3 versioning/lifecycle/backups for private artifact buckets once introduced.

Native DynamoDB backups are necessary but not enough. They restore DynamoDB
tables, but they don't give us a clean migration format for Postgres or another
future database.

## Portable Export

Add an application-level export before production execution data matters.

Export format:

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

Export requirements:

- JSON or NDJSON
- schema version
- generated timestamp
- source environment
- app git SHA/version
- entity counts
- checksums
- stable business IDs and references
- optional DynamoDB source keys for traceability
- no secrets or live session tokens in normal exports
- no password hashes in normal user exports
- file binaries excluded, represented by metadata and storage URI/checksum.

This is the migration path for a future Postgres move. It should use business
objects and stable references, not raw DynamoDB `PK`/`SK` records as the only
format.

## Import And Restore Validation

Portable exports need a validation path:

- validate manifest/schema version
- verify counts and checksums
- verify required fields
- verify references such as task bundle ID, task assignee ID, task file ID,
  artifact task/bundle/job IDs, and template references
- support dry-run import
- write a restore report with invalid/skipped records
- run smoke checks after staging restore.

The minimum smoke checks after restore:

- list today tasks
- open a workflow bundle
- instantiate a workflow template
- generate recurring tasks
- show file/artifact metadata
- export again and compare counts.

## File And Artifact Storage

Don't rely on Lambda local filesystem for production files.

V1 should use:

- DynamoDB for file/artifact metadata
- S3 or existing private external systems for binaries
- Git only for canonical process knowledge and small reviewed templates.
- local filesystem paths only in local/test mode.

This matters for:

- invoices
- receipts
- bank statements
- tax report zips
- podcast raw inputs
- recordings
- transcripts
- assistant job logs
- generated draft artifacts.

## Frontend Direction

Extend the existing vanilla frontend rather than mounting the old standalone
DataTasks app as a second product.

The frontend should evolve toward:

- Operations Home
- Workflows
- Tasks
- Inbox
- Assistants
- Knowledge
- Templates
- Recurring
- Artifacts
- Settings

The user shouldn't see repository or Lambda boundaries.

## CI/CD Requirements

Because work-engine is part of V1 deploys:

- include `work-engine/**` in the deploy workflow path filters
- run `npm --prefix work-engine test`
- run `npm --prefix work-engine run typecheck`
- package `WorkEngineFunction` through SAM
- validate SAM with DynamoDB resources
- smoke-test the `/work/api/health` broker route
- keep docs app tests and content validation.

## Implementation Order

Implement V1 in this order:

1. Keep the current Operations Home in the public frontend. Done.
2. Add production-safe DynamoDB table definitions to SAM. Done.
3. Refactor work-engine table names to environment variables. Done.
4. Add `WorkEngineFunction` as a private Lambda. Done.
5. Add trusted portal auth mode in work-engine. Done.
6. Add `/work/api/*` broker in the Python full app. Done.
7. Add portable export/import validation for current work-engine entities.
8. Add task/workflow frontend screens that call `/work/api/*`.
9. Add file/artifact S3 storage before exposing production binary uploads.
10. Run restore drills before relying on production execution data.

## Open Questions

These questions remain open after this decision:

- Whether `Sessions` should be backed up or treated as ephemeral only.
- Whether production artifact storage should use a DataOps-owned S3 bucket or
  continue linking to Google Drive/Dropbox for some domains.
- Whether the first deployed workflow execution slice should be Podcast or
  Newsletter.
- Whether single-user basic auth is enough for the first work-engine slice, or
  whether real user identity must land first for audit correctness.
