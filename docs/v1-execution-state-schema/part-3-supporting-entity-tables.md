> Part 3 of 4 of the [V1 Execution State Schema](../v1-execution-state-schema.md):
> the supporting-entity tables (users, files, artifacts, notifications,
> sessions, and audit events). [Part 1](part-1-overview-storage-and-id-rules.md)
> covers the overview, storage boundary, table ownership, and ID rules;
> [Part 2](part-2-work-entity-tables.md) covers the work-entity tables; [Part 4](part-4-query-migration-and-checklist.md) closes the reference.

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

Files store metadata for files attached to tasks or workflow cards.

Application fields:

- `file_id`
- `task_id`
- `card_id`
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
- later: `GSI-Card`: partition `card_id`, sort `created_at`

The current prototype uses `storagePath`, but production should use
`storage_uri` and make the storage backend explicit.

## Artifacts Table

Artifacts store metadata for generated or operational outputs. DynamoDB does
not store binaries, large generated documents, raw logs, signed URLs,
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
- `card_id`
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

The V1 implementation filters artifacts by task, card, file,
status, and type. Dedicated GSIs can be added when production access patterns
and volume require them.

`status=approved` is the only status that satisfies an artifact proof gate.

## Notifications Table

Notifications cover operator reminders, follow-ups, alerts, and UI inbox items.

Application fields:

- `notification_id`
- `message`
- `user_id`
- `task_id`
- `card_id`
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

## Audit Events Table

Audit events record card lifecycle, template, and import history.

Fields:

- `audit_event_id`
- `actor_id`
- `action`
- `summary`
- `metadata`
- `created_at`

Audit events should be append-only.
