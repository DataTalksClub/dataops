# Task dependencies

A Task can depend on other Tasks of its own Card. It cannot be completed until
every prerequisite is `done`. A `skipped` prerequisite does **not** satisfy a
dependency: skip the dependent too, or remove the edge.

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

## Rules (enforced in `db/taskDependencies.ts`, below the routes)

| Operation | Result |
| --- | --- |
| self / missing / duplicate / cross-Card / cyclic edge, or an edge on a Card-less Task | 400 |
| complete a Task (PUT, `resolve-done`, create as done) with an unfinished prerequisite | 409 `prerequisites-incomplete`, naming the prerequisites |
| reopen or delete a prerequisite of a completed Task | 409 `prerequisite-of-completed-task` |
| delete a Task that others depend on | 409 `has-dependents` |
| change the edges of a completed Task, or move a Task with edges to another Card | 409 `dependencies-locked` |

Template sync never rewrites a completed Task. Template edges plus
operator-added edges that would form a cycle make the update refuse to apply.

## Atomicity

Each rule that depends on another Task's state becomes a `ConditionCheck`
(`TaskGuard`) in the same `TransactWriteItems` as the Task write:

- completing D guards each prerequisite `status = done`;
- adding an edge reads the prerequisite closure with consistent reads and guards
  every Task visited by version, so two edits that would together close a cycle
  cannot both commit (verified on DynamoDB Local in
  `tests/task-dependency-transaction.ddb.ts`);
- reopening or deleting P guards the version of each dependent found for the Card.

The local transaction emulator validates the same guards under its lock.

## Limitations

- Dependents of a prerequisite are found through `GSI-Card`, which is eventually
  consistent. A dependent whose edge was added and completed within the index
  lag could be missed by a reopen or delete of its prerequisite. An edge to a
  deleted Task is treated as `missing`: it blocks completion until removed.
- Reviewed Card Template updates version-check only the Tasks they rewrite; a
  concurrent edge edit on an untouched Task in the same instant is not guarded.
- Edges are edited through the API/CLI (`dataops tasks update --depends-on`);
  the web UI displays them and blocks completion but has no edge editor.

## Persisted data

No offline migration is required. `dependsOn` is a new optional attribute, so
existing Task rows remain valid. Existing Cards gain template edges only when
the Template definition gains `dependsOn` and an operator applies the reviewed
Card Template update. Do not backfill edges with a script.
