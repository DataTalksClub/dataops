# DataOps Shared Project Plan

## Goal

Create one internal DataTalks.Club operations portal that combines task
execution, process documentation, recurring workflows, artifacts, and assistants.

The combined project should let the team:

- Find the private SOP or template needed to do operational work through the
  authenticated portal.
- Turn recurring playbooks into task bundles.
- Execute tasks from one unified task list.
- Collect raw operational inputs from Telegram, email, files, and manual entry.
- Run assistants that draft operational artifacts, starting with podcast prep
  documents.
- Keep sensitive operational knowledge in Git-backed markdown in a private
  repository.
- Preserve lightweight serverless deployment and low maintenance cost.

## Source Projects

### DataTasks

Source: `../datatasks`

Role in the combined project: task execution system.

Current capabilities:

- Task, template, bundle, recurring-task, file, user, auth, email, Telegram, and
  cron routes.
- DynamoDB-backed data model for templates, bundles, tasks, recurring configs,
  users, files, sessions, and notifications.
- Vanilla JavaScript SPA served by a Lambda-style backend.
- Local dev with dynalite and Node.js.
- Unit, Playwright E2E, typecheck, build, and integration scripts.

Important concepts to retain:

- Templates define repeatable workflows.
- Bundles instantiate templates for concrete dates or events.
- Tasks appear both inside bundles and in a unified task list.
- Tasks can carry instruction URLs, required links, file requirements, tags, and
  assignees.
- Recurring configs generate routine operational tasks automatically.

### DTC Operations

Source: `../dtc-operations`

Role in the combined project: private operational knowledge base and SOP
editor pattern.

Current capabilities:

- Domain-first markdown content under `content/`.
- SOPs, checklists, templates, references, playbooks, prompts, and screenshots.
- Structured SOP format with HTML comment markers.
- Browser editor with block editing, linting, search, filters, drafts, diff, and
  GitHub-backed publishing.
- Lambda full app that serves frontend, docs API, GitHub-backed content editing,
  search, linting, and image handling.
- Content-only CI path separate from full app deploys.

Important concepts to retain:

- Private GitHub is the source of truth for operational documentation.
- Markdown remains readable on GitHub.
- Structured SOP markers make docs machine-readable.
- Content changes can validate and refresh search without redeploying app code.

### Podcast Assistant

Source: `../podcast-assistant`

Role in the combined project: first assistant module for raw intake and podcast
prep document generation.

Current capabilities:

- Telegram bot for collecting podcast notes, files, voice notes, audio, images,
  and video metadata.
- Groq-powered audio transcription and image description.
- Heru-powered agent runs with Codex or Claude engines.
- Retry/resume support, progress updates, and generated documents.

Important concepts to retain:

- Raw inputs go into an inbox before processing.
- Processing is an explicit job with progress, logs, and retry behavior.
- Generated podcast documents should be reviewed before becoming official
  bundle artifacts.

## Product Shape

The shared product should be one internal DataTalks.Club Operations app with
four primary surfaces:

1. **Work**: tasks, bundles, recurring operations, assignments, due dates,
   execution status, and links/files needed to complete work.
2. **Knowledge**: authenticated in-app access to private SOPs, templates,
   references, playbooks, prompts, screenshots, search, editing, linting, and
   publishing.
3. **Assistants**: intake, transcription, AI drafting, job logs, retry, and
   human review.
4. **Artifacts**: podcast docs, event pages, Luma links, YouTube links,
   transcripts, invoices, reports, sponsor docs, and other outputs of work.

The user-facing distinction should be simple:

- A task tells the operator what to do next.
- A doc tells the operator how to do it.
- A workflow connects repeatable work to the right docs.
- An assistant prepares drafts or structured inputs.
- An artifact proves that an output exists.

## Shared Data Model

### Document

Backed by markdown in the private operational knowledge repo, not copied into
DynamoDB. During migration, `content/` in this public repo is only a
transitional/sanitized fixture source.

Minimum metadata exposed to the task app:

- `id`
- `path`
- `title`
- `doc_type`
- `summary`
- `tags`
- `systems`
- `related_docs`
- `updated_at`

### Template

DataTasks templates should reference DTC Operations docs by stable document ID.
Repo paths are transitional lookup aids only; they are not the workflow
identity once a task, template, reminder, or completion flow depends on the
document.

Additional fields to support the integration:

- `sourceDocIds`: SOPs, checklists, or playbooks used to define the workflow.
- `taskDefinitions[].instructionDocId`: preferred over raw instruction URL.
- `taskDefinitions[].phase`: optional grouping derived from SOP/checklist
  structure.
- `taskDefinitions[].systems`: tools touched by the task.
- `taskDefinitions[].validation`: optional completion check copied or linked
  from the SOP.

### Bundle

Bundles remain task-side execution records, but should link back to the docs
that explain the workflow.

Additional fields:

- `sourceTemplateDocId`
- `relatedDocIds`
- `stage`
- `bundleLinks`
- `references`

### Task

Tasks remain execution records in DynamoDB.

Additional fields:

- `instructionDocId`
- `instructionStepId`
- `systems`
- `blockedReason`
- `completedBy`
- `completedAt`

### Assistant Job

Assistant jobs represent long-running AI or automation work.

Fields:

- `id`
- `type`: for example `podcast-prep`
- `status`: `queued`, `running`, `needs-review`, `done`, or `failed`
- `inputRefs`
- `outputArtifactIds`
- `bundleId`
- `taskId`
- `logPath`
- `engine`
- `createdBy`
- `createdAt`
- `updatedAt`

### Artifact

Artifacts are the concrete outputs and links produced by operations.

Fields:

- `id`
- `type`: for example `podcast-doc`, `luma-link`, `youtube-link`,
  `transcript`, `invoice`, or `tax-report-zip`
- `title`
- `url`
- `storagePath`
- `bundleId`
- `taskId`
- `assistantJobId`
- `status`
- `createdAt`
- `updatedAt`

## Architecture Direction

Use one product shell with shared navigation and auth, but keep storage
boundaries clear.

- DynamoDB stores operational execution state: users, tasks, bundles, recurring
  configs, notifications, sessions, assistant jobs, artifacts, and files
  metadata.
- Private GitHub markdown stores operational knowledge: SOPs, templates,
  references, playbooks, prompts, and screenshots. The public app repo stores
  code, schemas, migrations, sanitized examples, and registry client logic.
- Search indexes markdown content and selected task/template metadata.
- Lambda remains the primary deployment unit unless scale or auth needs force a
  different hosting model.

Preferred target:

- One frontend app.
- One backend API surface.
- Separate internal modules for docs and tasks.
- Shared auth/session layer.
- Shared CI, tests, deployment, and observability.

Avoid in the first merge:

- Copying docs into DynamoDB as canonical records.
- Moving task state into markdown.
- Introducing a heavy workflow engine before the task/bundle model proves
  insufficient.
- Replacing both frontends with a new framework before product integration is
  validated.

## Workstreams

### 1. Repository and Ownership

Deliverables:

- Keep the combined app in the public `DataTalksClub/dataops` repo.
- Preserve private operational content history in a private knowledge repo
  rather than importing sensitive docs into the public app repo.
- Define code owners for app code, task backend, task frontend, infra, and the
  private knowledge repo.
- Establish branch and release policy.

Recommendation:

- Keep `DataTalksClub/dataops` as the public app/runtime repo.
- Keep operational knowledge in a separate private GitHub repo so sensitive
  SOPs, templates, prompts, screenshots, and operational context are not
  exposed publicly.

### 2. Shared Product Shell

Deliverables:

- Shared navigation with `Work`, `Knowledge`, `Search`, and `Admin`.
- Unified login/session behavior.
- Consistent layout, mobile behavior, dark mode, and status messaging.
- Link from tasks to instruction docs.
- Link from docs/checklists/playbooks to task templates and bundles.

Acceptance:

- A user can open a task and jump to its SOP.
- A user can open an SOP and see related templates or active bundles.
- No separate mental model is required for "task app" versus "docs app".

### 3. Document Registry API

Deliverables:

- API endpoint that exposes indexed document metadata.
- Stable document IDs and aliases for markdown docs.
- Resolver for `instructionDocId` and wiki-style links.
- Internal-link validation in CI.
- Authenticated private-doc resolution through the app API; public code must
  not expose private repo paths, tokens, or raw content.

Acceptance:

- Task templates can safely reference docs without relying on brittle file paths.
- Renaming or moving a doc does not break task instructions if its ID is stable.

### 4. Template From Docs

Deliverables:

- Mapping from private operational checklists/playbooks/SOPs to DataOps
  workflow templates.
- Import or sync command for selected docs.
- UI affordance to create a task template from a checklist or playbook.
- Review screen for offsets, assignees, milestones, required links, and files.

Acceptance:

- Newsletter, podcast, webinar, workshop, book of the week, open-source
  spotlight, social media, Maven lightning lesson, office hours, and tax report
  templates can be represented from the existing docs.
- Generated templates keep stable private-doc IDs and specific SOP-step
  references where possible. Public-side records may contain task structure,
  offsets, required proof, and doc IDs, but not copied SOP/template text unless
  explicitly sanitized.

### 5. Unified Search

Deliverables:

- Search across docs, templates, bundles, and tasks.
- Filters for doc type, task status, domain, tag, system, assignee, due date, and
  bundle/template.
- Search result cards that show whether the result is knowledge or executable
  work.

Acceptance:

- Searching for "Mailchimp newsletter" can surface SOPs, templates, active
  tasks, and current bundles in one place.

### 6. Operations Dashboard

Deliverables:

- Today view.
- Upcoming view.
- Overdue view.
- Active bundles by stage.
- Recurring task health.
- Content lint/status summary for docs tied to active work.

Acceptance:

- An operator can start the day from one screen and see what needs attention.

### 7. Assistants

Deliverables:

- Bring `../podcast-assistant` into the portal as an assistant module.
- Store assistant jobs in the portal.
- Store raw inputs, generated outputs, logs, and review state.
- Attach approved outputs to bundles as artifacts.
- Preserve Telegram intake and progress reporting.

Acceptance:

- Podcast raw material can be submitted from Telegram or the portal.
- A podcast document draft can be generated, reviewed, approved, and attached to
  a Podcast bundle.

### 8. Migration

Deliverables:

- Inventory existing DataTasks templates and DTC Operations docs by workflow.
- Map old Google Doc links to internal markdown docs where migrated.
- Convert raw instruction URLs to `instructionDocId` where possible.
- Seed templates from the Trello/template reference in `../datatasks/docs`.
- Migrate or re-seed current tasks only if there is production state to retain.

Priority workflows:

1. Newsletter
2. Podcast
3. Webinar
4. Workshop
5. Book of the Week
6. Open-Source Spotlight
7. Social media weekly posts
8. Monthly tax report
9. Maven lightning lessons
10. Office hours

### 9. CI, Tests, and Release

Deliverables:

- Shared typecheck/build/test commands.
- Private knowledge validation, SOP linting, and public fixture validation.
- Unit tests for docs registry and template import.
- Playwright coverage for task-to-doc and doc-to-template flows.
- Separate fast path for private knowledge changes to validate and refresh
  search/index metadata without unnecessary public app deploys.
- Full deploy path for app, Lambda, infra, and package changes.

Acceptance:

- Private knowledge changes validate and refresh search without unnecessary app
  redeploys.
- App changes run both docs and task tests before deployment.

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
- Add UI links between templates, bundles, tasks, and docs.

### Milestone 3: Unified Operator Experience

Outcome: daily operations happen from one product shell.

Tasks:

- Merge navigation and session handling.
- Build Today, Upcoming, Overdue, and Active Bundles views.
- Add doc lint/status indicators where docs are used by active work.
- Add end-to-end tests for core workflows.

### Milestone 4: Publishing and Automation

Outcome: docs, templates, and recurring tasks support a complete operating loop.

Tasks:

- Create template-from-doc flow.
- Add review and publish flow for generated templates.
- Wire recurring configs to template/bundle creation.
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
