> Part 4 of 4 of the [V1 Execution State Schema](../v1-execution-state-schema.md):
> query requirements, migration notes, and the implementation checklist.
> [Part 1](part-1-overview-storage-and-id-rules.md) covers the overview,
> storage boundary, table ownership, and ID rules; [Part 2](part-2-work-entity-tables.md)
> and [Part 3](part-3-supporting-entity-tables.md) cover the tables.

## Query Requirements For V1

The schema must support:

- today's tasks
- overdue tasks
- tasks due in the next seven days
- tasks by assignee
- tasks by status
- tasks by card
- active cards
- cards by stage
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
- `cards`
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
- Keep explicit script/test-owned dynalite setup for tests and development.
- Add SAM table resources with PITR and retain policy.
- Add least-privilege DynamoDB permissions for `WorkEngineFunction`.
- Add tests for table-name resolution.
- Add tests for core query paths.
- Keep export mapping in sync with this schema.
