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

### Card

Cards remain task-side execution records, but should link back to the docs
that explain the workflow.

Additional fields:

- `sourceTemplateDocId`
- `relatedDocIds`
- `stage`
- `cardLinks`
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
- `cardId`
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
- `cardId`
- `taskId`
- `assistantJobId`
- `status`
- `createdAt`
- `updatedAt`

## Architecture Direction

Use one product shell with shared navigation and auth, but keep storage
boundaries clear.

- DynamoDB stores operational execution state: users, tasks, cards, recurring
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
- Introducing a heavy workflow engine before the task/card model proves
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
- Link from docs/checklists/playbooks to task templates and cards.

Acceptance:

- A user can open a task and jump to its SOP.
- A user can open an SOP and see related templates or active cards.
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

- Search across docs, templates, cards, and tasks.
- Filters for doc type, task status, domain, tag, system, assignee, due date, and
  card/template.
- Search result cards that show whether the result is knowledge or executable
  work.

Acceptance:

- Searching for "Mailchimp newsletter" can surface SOPs, templates, active
  tasks, and current cards in one place.

### 6. Operations Dashboard

Deliverables:

- Today view.
- Upcoming view.
- Overdue view.
- Active cards by stage.
- Recurring task health.
- Content lint/status summary for docs tied to active work.

Acceptance:

- An operator can start the day from one screen and see what needs attention.

### 7. Assistants

Deliverables:

- Bring `../podcast-assistant` into the portal as an assistant module.
- Store assistant jobs in the portal.
- Store raw inputs, generated outputs, logs, and review state.
- Attach approved outputs to cards as artifacts.
- Preserve Telegram intake and progress reporting.

Acceptance:

- Podcast raw material can be submitted from Telegram or the portal.
- A podcast document draft can be generated, reviewed, approved, and attached to
  a Podcast card.

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

