## Milestones

### Milestone 0: Decision Record

Outcome: write down the target repo, deployment model, auth model, and migration
boundary.

Tasks:

- Choose target repo strategy.
- Decide whether to preserve both old apps during transition.
- Decide how authenticated doc saves commit to the private knowledge repo and
  how the public app consumes refreshed metadata/indexes.
- Decide if current DataTasks production state exists and must be migrated.

### Milestone 1: Read-Only Integration

Outcome: one app can read both task data and docs metadata.

Tasks:

- Add document registry endpoint.
- Add doc metadata client to task UI.
- Add task instruction links using doc IDs.
- Add unified search proof of concept.

### Milestone 2: Workflow Linking

Outcome: templates and docs are connected.

Tasks:

- Add `instructionDocId` and related doc fields to templates/tasks.
- Create migration/sync script for selected workflows.
- Import top-priority templates.
- Add UI links between templates, cards, tasks, and docs.

### Milestone 3: Unified Operator Experience

Outcome: daily operations happen from one product shell.

Tasks:

- Merge navigation and session handling.
- Build Today, Upcoming, Overdue, and Active Cards views.
- Add doc lint/status indicators where docs are used by active work.
- Add end-to-end tests for core workflows.

### Milestone 4: Publishing and Automation

Outcome: docs, templates, and recurring tasks support a complete operating loop.

Tasks:

- Create template-from-doc flow.
- Add review and publish flow for generated templates.
- Wire recurring configs to template/card creation.
- Add notifications for overdue and blocked work.

### Milestone 5: Cutover

Outcome: the old separate surfaces are no longer needed for daily operations.

Tasks:

- Freeze writes to old task/docs surfaces as needed.
- Migrate or reseed production data.
- Verify critical workflows with real operators.
- Update runbooks and deployment docs.
- Archive or redirect old entry points.

## Risks and Decisions

### Stable IDs

Risk: docs move often, and path-based links will break.

Decision: use stable frontmatter IDs for docs referenced by tasks/templates.
Aliases preserve intentionally migrated old IDs or paths. `source` remains
provenance, and `instructionsUrl` remains only a legacy or external fallback.

### Source of Truth

Risk: task templates and docs drift apart.

Decision: private Git-backed operational docs are the source of truth for
instructions; private Git-backed workflow templates are the source of truth for
repeatable execution definitions; DynamoDB is the source of truth for runtime
execution scheduling and status. The public `dataops` repo may keep only
sanitized fixtures, generated public-safe views, schemas, and product code.

### Scope Creep

Risk: the combined product becomes a full project management suite.

Decision: optimize for DataTalks.Club operations first: recurring workflows,
clear instructions, and daily execution.

### Auth

Risk: DTC Operations uses protected docs access and DataTasks has its own auth
routes.

Decision: Milestone 0 must choose one shared auth/session implementation before
deep UI integration.

### Deployment

Risk: combining apps makes content edits as expensive as code deploys.

Decision: preserve the content-only validation/refresh path.

## Immediate Next Steps

1. Create the private operational knowledge repository boundary and migration
   plan.
2. Add stable IDs to high-priority DTC Operations docs.
3. Design the document registry API contract.
4. Add `instructionDocId` support to DataTasks templates and tasks.
5. Build a read-only task-to-doc link for one workflow, preferably Newsletter.
6. Create the first template-from-doc migration script.
7. Add Playwright coverage for opening a task, following its SOP, and returning
   to the task.

## Verification Notes

As of this plan:

- `alexeygrigorev/datatasks` has no open GitHub issues.
- `DataTalksClub/dtc-operations` has no open GitHub issues.
- `../datatasks` has one local modified file: `e2e/.auth-state.json`.
- `../dtc-operations` has a clean local git status.
