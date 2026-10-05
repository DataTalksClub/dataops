## Build Order

### Phase 1: Make the Portal Read Both Worlds

Goal: one UI can show work and process docs together.

Build:

- Document registry endpoint.
- Stable IDs for priority docs.
- Task model support for `instructionDocId` and `instructionStepId`.
- Task detail view linking to SOPs.
- SOP view showing related tasks and workflows.
- Unified search prototype.

Use Newsletter or Podcast as the first workflow.

### Phase 2: Create Executable Workflows

Goal: turn process docs and Trello-derived templates into portal workflows.

Build:

- Workflow/template model with phases.
- Workflow-to-task generation.
- Required artifact definitions.
- Milestones and card stage transitions.
- Import script for Trello/DataTasks templates.
- Manual review screen for generated workflows.

Start with Podcast, Newsletter, and Monthly Tax Report.

### Phase 3: Integrate Podcast Assistant

Goal: make the podcast assistant part of the portal.

Build:

- Move `podcast-assistant` code into the portal repo or package it as an
  internal module.
- Move sensitive assistant prompts, templates, examples, and process
  instructions to the private knowledge repo after review.
- Replace local `documents/` output with portal artifacts.
- Add assistant job records.
- Add job status, logs, retry, and output review UI.
- Connect approved output to Podcast cards.
- Finalize the podcast document template.

### Phase 4: Build Daily Operations

Goal: the team can start from the portal every morning.

Build:

- Today/Overdue/Upcoming dashboard.
- Inbox triage.
- Recurring tasks and recurring cards.
- Notifications.
- Assignment and ownership views.
- Process quality warnings for active workflows.

### Phase 5: Replace Old Tools Gradually

Goal: reduce Trello, spreadsheets, and local scripts without forcing a risky
big-bang migration.

Build:

- Import active Trello cards if needed.
- Import open spreadsheet TODOs if needed.
- Keep links to existing Google Docs and spreadsheets where they remain source
  systems.
- Move repeatable work into portal workflows one domain at a time.
- Archive old entry points only after real workflows run successfully in the
  portal.

## First Concrete Slice

The first useful slice should be Podcast because it exercises the full concept:
process docs, task cards, artifacts, assistant-generated documents, and
publishing steps.

Scope:

- Add stable IDs to the main private podcast docs.
- Create a Podcast workflow definition from the existing Trello/DataTasks
  template.
- Link each Podcast task to the best matching private SOP or template by stable
  doc ID.
- Add required artifacts for podcast doc, Luma link, YouTube link, transcript,
  Spotify link, Apple link, and DTC webpage.
- Bring `podcast-assistant` code into the repo as `assistants/podcast/`.
- Add a portal page for Podcast Assistant inbox, processing jobs, and generated
  document review.
- Create one end-to-end flow: raw Telegram material -> assistant draft -> review
  -> Podcast card artifact -> tasks with SOP links.

## Key Decisions

### Repo

Recommendation: keep `dataops` as the public app/runtime repo. Keep
operational knowledge in a separate private GitHub repo. DataOps renders and
edits that knowledge through authenticated APIs.

### Source of Truth

Recommendation:

- Private GitHub markdown is the source of truth for process knowledge.
- DynamoDB is the source of truth for execution state.
- Assistant outputs become artifacts that are attached to cards.

### Podcast Assistant

Recommendation: absorb it into the portal as an assistant module. Keep the
Telegram intake, transcription, image description, Heru execution, retries, and
progress reporting. Replace local-only file outputs with portal artifacts and
job records.

### Workflow Definitions

Recommendation: use DataTasks templates as the starting point, but rename the
product concept to "workflows" in the portal. Operators understand "Podcast
workflow" better than "template".

### Process Docs

Recommendation: do not try to clean all 346 docs before building the portal.
Clean only the docs used by the first workflows. Let the portal expose process
quality gaps so cleanup happens where it matters.

## What We Should Do Next

1. Choose the target repo strategy.
2. Pick Podcast as the first complete workflow.
3. Add stable IDs to the main podcast SOPs and templates.
4. Define the Podcast workflow in one structured file.
5. Add `instructionDocId`, phases, and required artifacts to DataTasks template
   records.
6. Move `podcast-assistant` into the portal as an assistant module.
7. Build the first end-to-end portal slice around Podcast.
