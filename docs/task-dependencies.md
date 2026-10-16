# Task dependencies

A Task can depend on other Tasks of its own Card. It cannot be completed until
every prerequisite is resolved: `done` or `skipped`. A skipped prerequisite
unblocks its dependents just as a completed one does.

## Model

- `Task.dependsOn?: string[]` holds prerequisite Task ids. Same Card only; a
  Task without a Card has none. No edges is stored as an absent attribute.
- A Template `TaskDefinition.dependsOn?: string[]` (`depends_on` in authored
  YAML) holds prerequisite `refId`s. Card creation, recovery
  (`instantiateTemplate`) and reviewed Card Template updates resolve them to
  Task ids; `TemplateTaskDefinitionSnapshot.dependsOnRefs` keeps the refs so a
  later update can diff them.
- Template validation rejects unknown, self, duplicate and cyclic refs, and a
  dependency that crosses an optional-group boundary.
- Task responses add `prerequisites: [{id, description, status}]` (status may be
  `missing`) and `blocked`. These are projections, never stored.
- `GET /api/tasks?blocked=false` leaves out blocked Tasks (`blocked=true` keeps
  only them). The work queue loads its lanes this way and drops blocked Tasks
  from the Card checklists it merges, so a Task joins the queue once every
  prerequisite is done or skipped. Card checklists still show blocked Tasks.

## Rules (enforced in `db/taskDependencies.ts`, below the routes)

| Operation | Result |
| --- | --- |
| self / missing / duplicate / cross-Card / cyclic edge, or an edge on a Card-less Task | 400 |
| complete a Task (PUT, `resolve-done`, create as done) with an unfinished prerequisite | 409 `prerequisites-incomplete`, naming the prerequisites |
| reopen (to `todo`/`waiting`, including unskip) or delete a prerequisite of a completed Task | 409 `prerequisite-of-completed-task` |
| delete a Task that others depend on | 409 `has-dependents` |
| change the edges of a completed Task, or move a Task with edges to another Card | 409 `dependencies-locked` |

Template sync never rewrites a completed Task. Template edges plus
operator-added edges that would form a cycle make the update refuse to apply.

## Atomicity

The Card version is the dependency graph's revision. Every write that can
change the graph or the statuses the rules read (Task create/delete,
open/resolved transitions, edge edits, Template sync) writes the Card, and an edge edit bumps
it even when no counter changes.

1. The checks read the Card first and pin its version.
2. They then read the graph from the base table with consistent reads: the
   prerequisite closure by `GetItem`, and a Card's dependents by a consistent
   filtered `Scan` (never `GSI-Card`, which is eventually consistent).
3. The write is one `TransactWriteItems` that commits only while the Card is
   still at the pinned version, so a dependent or edge inserted after the read
   cancels it (409) instead of slipping past.
4. Task-level `ConditionCheck`s stay as a second guard: each prerequisite of a
   completing Task must still be `done` or `skipped`, and every Task read for a cycle check
   or dependents check must keep its version.

A `done` <-> `skipped` change does not write the Card: both are resolved, so it
changes nothing the rules read.

Card Template sync loads the Card and its Tasks consistently (Card first),
conditions the update on the Card version, and additionally version-checks
every Task on a dependency edge that the update does not rewrite.

Concurrency is covered by `tests/task-dependencies.test.ts` (interleaved
writes injected between the read and the write, a hidden `GSI-Card`, churn),
`tests/template-task-dependencies.test.ts` (sync) and
`tests/task-dependency-transaction.ddb.ts` (DynamoDB Local).

## Web editor

The task dialog's Prerequisites section lists each prerequisite by name and
status and has an "Edit prerequisites" disclosure for tasks that are not done:
it loads the Card's other tasks, shows name and status (never ids), greys a
task that already waits on this one, and saves with the Task version.

## Limitations

- Same-Card scope only (first version). Cross-Card prerequisites would need a
  graph revision shared across Cards.
- Reopen and delete of a prerequisite use a filtered consistent Scan of the
  Tasks table, whose cost grows with the table. They are rare operations.
- Any write to a Card, including one unrelated to dependencies, makes an
  in-flight dependency check retry (409), as with other Card writes.
- An edge to a Task removed by other means (for example a whole-Card delete
  racing) is shown as `missing` and blocks completion until it is removed.

## Persisted data

No offline migration is required. `dependsOn` is a new optional attribute, so
existing Task rows remain valid. Existing Cards gain template edges only when
the Template definition gains `dependsOn` and an operator applies the reviewed
Card Template update. Do not backfill edges with a script.
