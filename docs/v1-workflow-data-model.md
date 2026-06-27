---
title: "V1 Workflow Data Model"
summary: "Shared workflow contract for DataOps V1 workflow definitions, runtime bundles, tasks, reminders, proof, and migration-safe references."
doc_type: reference
tags:
  - v1
  - workflow
  - data
  - work-engine
systems:
  - work-engine
  - dynamodb
  - content
related_docs:
  - docs/v1-runtime-architecture.md
  - docs/v1-execution-state-schema.md
  - docs/v1-execution-data-safety.md
---

# V1 Workflow Data Model

## Summary

DataOps V1 uses one shared workflow model for daily operations. A workflow
definition describes repeatable work in Git. A workflow bundle is one runtime
execution of that definition in DynamoDB. Tasks, reminders, file metadata,
artifact references, assistant job references, and audit event references all
use stable application IDs so the data can be exported and later migrated.

This document defines the shared contract. It does not define the first Podcast
workflow content, detailed artifact lifecycle, or detailed assistant job
lifecycle.

## Ownership Boundary

Store in Git under `content/`:

- reviewed workflow definitions and task templates
- source document IDs for SOPs and templates
- assistant prompts and reusable process references
- small reviewed process assets

Store in DynamoDB:

- runtime workflow bundles
- task instances and follow-up state
- recurring configs
- notifications/reminders
- file and artifact metadata
- assistant job metadata
- append-only audit events

Store outside DynamoDB:

- uploaded binaries
- generated artifacts
- large assistant outputs
- external-system source files

DynamoDB stores metadata and `storage_uri` style references, not binaries.

## IDs And Export Names

Runtime TypeScript fields use camelCase. Portable export fields use snake_case.
DynamoDB `PK` and `SK` are implementation details only.

Required stable IDs:

- `template_id`
- `bundle_id`
- `task_id`
- `notification_id`
- `file_id`
- `artifact_id`
- `assistant_job_id`
- `audit_event_id`
- `user_id`

Relationships use these IDs directly. Exports must not depend on embedded
DynamoDB keys to rebuild relationships.

## Workflow Definition

A workflow definition is the canonical Git-backed template for a repeatable
operation.

Fields:

- `template_id`
- `name`
- `type`
- `phases`: ordered `{ id, name, stage }` records
- `tags`
- `default_assignee_id`
- `source_doc_ids`
- `references`
- `bundle_link_definitions`
- `task_definitions`
- `trigger_type`
- `trigger_schedule`
- `trigger_lead_days`
- `created_at`
- `updated_at`

Stages are intentionally small for V1: `preparation`, `announced`,
`after-event`, and `done`. Future workflow types may add more stage strings,
but they must remain documented in the workflow definition.

## Task Definition

A task definition is a step inside a workflow definition.

Fields:

- `ref_id`
- `description`
- `offset_days`
- `is_milestone`
- `stage_on_complete`
- `assignee_id`
- `instructions_url`
- `instruction_doc_id`
- `instruction_step_id`
- `phase`
- `systems`
- `validation`
- `required_link_name`
- `requires_file`
- `proof_requirement`
- `artifact_refs`
- `assistant_job_refs`
- `audit_event_refs`

Document context reuses the existing registry fields: `source_doc_ids` at the
workflow level and `instruction_doc_id`, `instruction_step_id`, `phase`,
`systems`, and `validation` at the task level. `instructions_url` remains a
legacy fallback when no registered document ID is available.

## Runtime Bundle

A workflow bundle is one runtime execution package, such as one event, report,
newsletter issue, or podcast episode.

Fields:

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
- `artifact_refs`
- `assistant_job_refs`
- `audit_event_refs`
- `created_at`
- `updated_at`

Tasks point back to the bundle with `bundle_id`. Bundle-level `artifact_refs`
are lightweight context pointers; the artifacts table is the durable source for
artifact metadata and review state.

## Task Instance

A task instance is the operator's daily unit of work.

Fields:

- `task_id`
- `description`
- `date`
- `status`: `todo`, `waiting`, `done`, or `archived`
- `source`
- `comment`
- `waiting_for`
- `follow_up_at`
- `completed_by`
- `completed_at`
- `proof_requirement`
- `external_status`
- `instructions_url`
- `instruction_doc_id`
- `instruction_step_id`
- `phase`
- `systems`
- `validation`
- `link`
- `required_link_name`
- `requires_file`
- `assignee_id`
- `bundle_id`
- `template_id`
- `template_task_ref`
- `recurring_config_id`
- `stage_on_complete`
- `artifact_refs`
- `assistant_job_refs`
- `audit_event_refs`
- `tags`
- `created_at`
- `updated_at`

`waiting` tasks require `waiting_for` and `follow_up_at`. They remain active
and should drive `follow-up-due` notifications when the follow-up timestamp is
due.

## Proof Requirement

Proof describes the evidence needed before a task can be completed.

Fields:

- `type`: `url`, `file`, `artifact`, `comment`, or `external-status`
- `label`
- `required`

Completion semantics:

- `required_link_name` requires `link`.
- `requires_file` requires an uploaded file metadata record.
- `proof_requirement.type=url` requires `link`.
- `proof_requirement.type=file` requires exported file metadata.
- `proof_requirement.type=artifact` requires an approved artifact record
  attached to the task, attached to the task's bundle, or referenced by
  `artifact_refs` from the task or bundle.
- `proof_requirement.type=comment` requires `comment`.
- `proof_requirement.type=external-status` requires `external_status`.

A task with missing required proof is not valid in `done` state.

## Reminders And Notifications

V1 uses the existing notification entity for reminders and inbox items.

Types:

- `task-due`
- `task-overdue`
- `follow-up-due`
- `missing-evidence`
- `recurring-due`
- `stage-change`
- `automation-failure`

Fields:

- `notification_id`
- `notification_type`
- `message`
- `user_id`
- `task_id`
- `bundle_id`
- `template_id`
- `due_at`
- `dismissed`
- `created_at`

`follow-up-due` notifications require `task_id` and `due_at`.

## Artifact References

Artifact references are stable metadata pointers, not binaries.

Fields:

- `artifact_id`
- `type`
- `title`
- `storage_uri`
- `status`

Artifact references are not proof by themselves. An artifact ref satisfies
artifact proof only when the referenced artifact record exists and has
`status=approved`. `draft`, `needs-review`, `rejected`, `archived`, and
`superseded` records remain visible context but do not complete proof gates.

## Artifact Records

Artifact records are metadata-only runtime records for generated outputs,
external deliverables, assistant drafts, reviewed documents, and public/private
links. DynamoDB stores the metadata and stable storage URI, not the binary,
large generated document, signed URL, raw assistant log, secret, OAuth token, or
cookie.

Fields:

- `artifact_id`
- `type`: `podcast-doc`, `transcript`, `recording`, `report`, `invoice`,
  `event-page`, `assistant-output`, `external-link`, or `other`
- `title`
- `description`
- `status`: `draft`, `needs-review`, `approved`, `rejected`, `archived`, or
  `superseded`
- `storage_provider`: `s3`, `dropbox`, `google-drive`, `github`,
  `external-url`, `local-dev`, or `unknown`
- `storage_uri`
- `filename`
- `content_type`
- `checksum`
- `size_bytes`
- `visibility` or `data_class`: `public`, `internal`, `private`, or
  `sensitive`
- `task_id`
- `bundle_id`
- `assistant_job_id`
- `file_id`
- `source_type`: `manual-link`, `manual-upload`, `assistant-output`, `import`,
  `migration`, or `system`
- `created_by`
- `reviewed_by`
- `created_at`
- `updated_at`
- `reviewed_at`
- `tags`
- small redacted `metadata`

`assistant_job_id` references an assistant job when present. Podcast Assistant local folders such as `documents/`, `inbox/`,
and `heru_runs/` are local runtime/dev storage; attached assistant outputs must
be represented by artifact metadata instead of committed as durable artifacts.

## Assistant Job References

Assistant job references connect workflow state to assistant runs without
embedding job internals into tasks or bundles.

Fields:

- `assistant_job_id`
- `assistant_type`
- `status`

Assistant job records hold the detailed lifecycle: `draft`, `queued`,
`running`, `waiting_approval`, `approved`, `rejected`, `retrying`,
`succeeded`, `failed`, and `canceled`. Jobs are linked to a task, bundle, or
both; output artifacts are linked through `output_artifact_ids` and the
artifact table. Workflow screens show the lightweight refs so the operator can
request help, see whether a job is waiting/running/failed/needs approval, and
act on the next step without leaving the task or bundle context.

## Audit Events

Audit events are append-only.

Fields:

- `audit_event_id`
- `actor_id`
- `entity_type`
- `entity_id`
- `action`
- `before`
- `after`
- `summary`
- `created_at`

Tasks and bundles may hold `audit_event_refs` for fast context, but the audit
event table remains the durable history source once implemented.

## Migration Contract

Every durable workflow entity must export with:

- stable business IDs
- explicit relationship fields
- parseable dates and timestamps
- no secrets
- no binary payloads
- omitted entity markers for entities that are not implemented yet

The V1 portable export includes `templates.jsonl`, `bundles.jsonl`,
`tasks.jsonl`, `notifications.jsonl`, `files.jsonl`, `artifacts.jsonl`,
`assistant_jobs.jsonl`, and `audit_events.jsonl`. Omitted entity markers are
reserved for durable entities that are not implemented yet.
