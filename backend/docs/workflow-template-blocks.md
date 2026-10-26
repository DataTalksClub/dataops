# Workflow template blocks

A block defines a reusable task group once, under
`workflow-templates/blocks/*.yaml` in the private knowledge repository, and
templates splice it in with a single task-list entry.

## Include syntax

Flow style (one physical line):

```yaml
tasks:
  - { include: blocks/sponsor-performance.yaml, slot: primary-slot }
```

Mapping style (one list item):

```yaml
tasks:
  - include: blocks/sponsor-performance.yaml
    prefix: secondary-
    slot: secondary-slot
    name_prefix: "Secondary slot: "
    only: [send-performance-to-sponsor]
```

## Include parameters (all optional)

| Parameter     | Default              | Meaning                                                        |
| ------------- | -------------------- | -------------------------------------------------------------- |
| `prefix`      | `""`                 | Prepended to every emitted task id. Internal `depends_on` refs track it; refs to tasks outside the block do not. |
| `slot`        | `null`               | Sets `optional_group` on the block's `slot_tasks`; removes it when null/empty. |
| `anchor`      | block `anchor_from`  | Rewrites every `depends_on` entry equal to the block's `anchor_from` (e.g. `schedule-email-newsletter`). |
| `offset_days` | block default (`7`)  | Overrides `schedule.offset_days` for every emitted task.       |
| `name_prefix` | `""`                 | Prepended to every emitted task name.                          |
| `only`        | all tasks            | Emit a subset by unprefixed block task id (e.g. only the send task for a secondary slot that reuses shared collect tasks). |

## Block file shape

```yaml
params:                # defaults for the include parameters above
  prefix: ""
  slot: null
  anchor: schedule-email-newsletter
  offset_days: 7
  name_prefix: ""
anchor_from: schedule-email-newsletter   # the depends_on value `anchor` rewrites
slot_tasks:                              # tasks whose optional_group follows `slot`
  - send-performance-to-sponsor
tasks:
  - <full task definitions with concrete ids>
```

Rules:

- Blocks are one level only: a block task must not itself be an include.
- Expansion runs before authored-template validation, so the expanded tasks
  are what the validators and the lossless mapping check see.
- Expansion yields stable task keys: the same include parameters always
  produce the same task ids and dependencies, so existing Cards and
  `dataops templates update` keep working.
- Files under `workflow-templates/blocks/` are never templates themselves;
  loaders only read top-level `workflow-templates/*.yaml` as templates.

## Example: sponsor performance stats

`workflow-templates/blocks/sponsor-performance.yaml` holds
`collect-mailchimp-stats`, `collect-x-stats`, `collect-linkedin-stats`, and
`send-performance-to-sponsor` (which depends on the three collect tasks).

Primary slot (full group):

```yaml
- { include: blocks/sponsor-performance.yaml, slot: primary-slot }
```

Secondary slot (send-only; reuses the shared collect tasks):

```yaml
- { include: blocks/sponsor-performance.yaml, prefix: secondary-, slot: secondary-slot, name_prefix: "Secondary slot: ", only: [send-performance-to-sponsor] }
```

Standalone template (no slot):

```yaml
- { include: blocks/sponsor-performance.yaml }
```
