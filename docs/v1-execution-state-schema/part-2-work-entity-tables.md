> Part 2 of 4 of the [V1 Execution State Schema](../v1-execution-state-schema.md):
> the work-entity tables (tasks, cards, templates, recurring configs).
> [Part 1](part-1-overview-storage-and-id-rules.md) covers the overview,
> storage boundary, table ownership, and ID rules;
> [Part 3](part-3-supporting-entity-tables.md) covers the supporting-entity tables.

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
- `card_id`
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
- list tasks by card
- list tasks by status

Recommended indexes:

- table key: `PK=TASK#{task_id}`, `SK=TASK#{task_id}`
- `GSI-Date`: partition `date`, sort `status`
- `GSI-Card`: partition `card_id`, sort `date`
- `GSI-Status`: partition `status`, sort `date`

## Cards Table

Cards represent workflow runs or operating packages.

Examples:

- podcast episode
- newsletter issue
- webinar
- recurring operations card

Application fields:

- `card_id`
- `title`
- `description`
- `anchor_date`
- `template_id`
- `status`
- `stage`
- `references`
- `card_links`
- `tags`
- `created_at`
- `updated_at`

Recommended key:

- `PK=CARD#{card_id}`, `SK=CARD#{card_id}`

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
- `card_link_definitions`
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

Recurring configs are schedules that create repeated tasks or cards.

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
