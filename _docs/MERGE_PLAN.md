# DataOps Merge Plan

## Direction

Build `DataTalksClub/dataops` as the single operations portal for
DataTalks.Club.

The first milestone is a code and process merge, not a full product rewrite.
The repo should bring the existing systems under one roof, keep them runnable,
and create clear integration points.

Source systems:

- `../dtc-operations`: process docs, SOP editor, search, Lambda docs app
- `../datatasks`: task execution engine, templates, bundles, recurring work
- `../podcast-assistant`: Telegram intake and AI drafting for podcast prep

## Product Result

The merged portal will have these top-level areas:

- `Home`: today, overdue, active workflows, inbox, assistant jobs
- `Work`: tasks, bundles, workflows, recurring work, assignments
- `Processes`: SOPs, templates, references, playbooks, prompts, lint status
- `Assistants`: podcast assistant first, later process-doc and newsletter helpers
- `Artifacts`: files, generated docs, event links, transcripts, invoices, reports
- `Search`: one search across work, process docs, artifacts, and assistant output
- `Admin`: users, integrations, imports, secrets, diagnostics

## Repository Structure

Use this target structure after the merge:

```text
dataops/
  _docs/                  repo process, architecture, merge notes
  .claude/agents/         role-agent instructions for the issue pipeline
  content/                DataTalks.Club process docs from dtc-operations
  frontend/               shared portal frontend
  backend/                Python backend copied from dtc-operations Lambda app
  work-engine/            DataTasks TypeScript task engine during transition
  assistants/
    podcast/              podcast-assistant code and prompts
  scripts/                import, migration, lint, dev tooling
  tests/                  cross-system tests
  playwright_tests/       portal E2E tests
```

Transition rule:

- Keep source systems mostly intact at first.
- Integrate through APIs and explicit import/sync scripts.
- Refactor only after one workflow runs end to end in the merged repo.

## Technology Choices

### Backend

Use Python as the long-term portal backend.

Reasons:

- `dtc-operations` already uses a Python Lambda backend for docs, search, lint,
  GitHub-backed content editing, and image handling.
- `podcast-assistant` is Python.
- Process-doc parsing and linting are already Python.
- Python is a better fit for assistant jobs, document parsing, transcription,
  and background processing.

Keep the DataTasks TypeScript backend as `work-engine/` during the first merge.
Expose its concepts through integration code before rewriting them.

Long-term options:

- Move task execution into the Python backend after the models are stable.
- Keep a small TypeScript service only if it provides a real operational
  advantage.

### Frontend

Use the existing `dtc-operations` vanilla JavaScript frontend as the first portal
shell.

Reasons:

- It already has docs navigation, search, filters, editor, drafts, lint status,
  image upload, keyboard shortcuts, and mobile layout.
- It avoids a framework rewrite before the merge proves the product model.

Do not introduce React or another frontend framework in the merge milestone.

### Data Stores

Use separate stores for separate truth:

- GitHub markdown is the source of truth for process knowledge.
- DynamoDB stores execution state: users, tasks, bundles, workflows, recurring
  work, assistant jobs, artifacts, sessions, and notifications.
- S3 or GitHub stores generated files depending on the artifact type.
- Lambda `/tmp` remains cache only, not durable storage.

### Search

Start with the existing `minsearch` index for process docs.

Then add indexed records for:

- workflows
- task templates
- active bundles
- tasks
- artifacts
- assistant outputs

### Deployment

Keep the `dtc-operations` Lambda deployment model for the first merge.

Required paths:

- Content-only changes validate docs and refresh the deployed index.
- Code changes run backend, frontend, and Playwright tests before deploy.
- Assistant jobs can run locally first, then move to a Lambda, container, or
  queued worker once the portal job model is stable.

### Package Management

Use both ecosystems during transition:

- Python: `uv`
- Node/TypeScript: `npm`

Add one top-level `Makefile` later to wrap common commands.

## Merge Phases

### Phase 0: Repo and Process Setup

Outcome: `DataTalksClub/dataops` is ready for issue-driven work.

Tasks:

- Create public GitHub repo.
- Add planning docs.
- Add `_docs/PROCESS.md`.
- Add role-agent instructions.
- Add labels for the GitHub issue pipeline.
- File initial merge issues.

### Phase 1: Import DTC Operations

Outcome: the process-doc portal runs from `dataops`.

Tasks:

- Copy `content/`, `frontend/`, `lambda-functions/`, `scripts/`, `templates/`,
  and docs-app tests from `../dtc-operations`.
- Preserve commit history only if we decide it is worth the added merge
  complexity. Otherwise record the source commit in `_docs/import-log.md`.
- Rename `lambda-functions/` to `backend/` after import, or leave it in place
  until tests pass.
- Keep docs search, editor, lint, image handling, and GitHub-backed save working.
- Update repo names and deployment configuration from `dtc-operations` to
  `dataops`.

Validation:

- Local docs app starts.
- Search works.
- SOP lint still runs.
- A document can be edited and saved in local mode.

### Phase 2: Import DataTasks

Outcome: task execution code lives in the merged repo and still runs.

Tasks:

- Copy DataTasks into `work-engine/`.
- Keep its TypeScript build, tests, and Playwright tests passing from that
  subdirectory.
- Add an adapter contract between portal backend and work engine.
- Expose tasks, templates, bundles, recurring configs, users, files, and
  notifications as portal concepts.
- Add `instructionDocId`, `instructionStepId`, `phase`, `systems`, and required
  artifact fields to the task/template model.

Validation:

- `npm test`, `npm run typecheck`, and focused Playwright tests pass in
  `work-engine/`.
- A task can link to a process doc by ID.
- A bundle can show related process docs.

### Phase 3: Import Podcast Assistant

Outcome: podcast-assistant is a portal assistant module.

Tasks:

- Copy local `../podcast-assistant` into `assistants/podcast/`.
- Keep its tests passing with `uv`.
- Replace local-only `documents/` output with portal artifact records.
- Add assistant job records: queued, running, needs review, done, failed.
- Keep Telegram intake.
- Add a portal screen for inbox, job logs, generated draft review, and approval.

Validation:

- Telegram or local input can create a podcast assistant inbox item.
- The assistant can draft a podcast prep document.
- A reviewed draft becomes a `podcast-doc` artifact.

### Phase 4: First End-to-End Workflow

Outcome: one real workflow runs across docs, tasks, artifacts, and assistant
output.

Use Podcast first.

Tasks:

- Add stable IDs to priority podcast SOPs and templates.
- Define the Podcast workflow from the DataTasks/Trello template.
- Link each workflow task to a process doc or template.
- Add required artifacts: podcast doc, Luma link, Meetup link, YouTube link,
  transcript, Spotify link, Apple link, DTC webpage link.
- Add stages: prep, announced, live, post-production, published, follow-up, done.
- Add Playwright coverage for the operator flow.

Validation:

- Create Podcast bundle.
- Generate tasks.
- Open a task and jump to its SOP.
- Run podcast assistant.
- Approve generated podcast doc.
- Attach artifact to bundle.
- Complete required-link tasks only after outputs exist.

### Phase 5: Consolidate Backend

Outcome: the portal has one backend implementation for work and docs.

Tasks:

- Move task execution from TypeScript into Python only after the first workflow
  proves the model.
- Migrate DataTasks data access to the portal backend.
- Retire `work-engine/` when parity tests pass.

Do not start this phase before Phase 4 succeeds.

## Initial GitHub Issues

Create these as the first issues in `DataTalksClub/dataops`:

1. Set up process docs and role-agent workflow.
2. Import DTC Operations into `dataops`.
3. Keep DTC Operations docs app running from merged repo.
4. Import DataTasks into `work-engine/`.
5. Add document registry IDs and resolver.
6. Add task-to-process-doc links.
7. Import Podcast Assistant into `assistants/podcast/`.
8. Define Podcast workflow.
9. Build Podcast end-to-end slice.
10. Add first portal dashboard.

## Key Decisions

### Base App

Use `dtc-operations` as the base app during the merge because it already owns
the process docs and portal-like frontend.

### Repo

Use `DataTalksClub/dataops` as the new public repo.

### Issues

Use GitHub Issues in `DataTalksClub/dataops`.

The orchestrator files raw issues from user input. The user does not need to
write issue specs manually.

### First Workflow

Use Podcast as the first real workflow because it touches all three source
systems.

