# DataTalks.Club Operations Portal Analysis

## Product Thesis

We are not just merging two codebases. We are creating one internal
DataTalks.Club operations portal that replaces scattered daily work across
Trello, Google Sheets, process docs, Telegram notes, email tasks, local
assistant scripts, and manual search.

The portal should answer these operator questions:

- What do I need to do today?
- What process should I follow?
- What assets, links, people, and templates do I need?
- What has already happened for this podcast, newsletter, event, course, or
  finance process?
- What can the system prepare automatically before I start?

The product becomes an operations OS for DataTalks.Club:

- Work: tasks, bundles, due dates, assignments, statuses, files, required
  links, and recurring work.
- Knowledge: private SOPs, templates, references, playbooks, screenshots,
  Looms, prompts, and search surfaced inside the authenticated portal.
- Assistants: ingestion and drafting workflows such as the podcast assistant.
- History: execution logs, task completion, generated docs, decisions, and
  links to final artifacts.

## Source System Inventory

### DataTasks

Location: `../datatasks`

What it gives us:

- DynamoDB-backed execution state.
- Data model for tasks, bundles, templates, recurring configs, users, files,
  sessions, and notifications.
- API routes for task-like operations, bundles, templates, recurring work,
  email, Telegram, files, users, auth, cron, and notifications.
- Local development with Node.js, TypeScript, dynalite, and Playwright tests.
- A product model close to what operations needs: template -> bundle -> tasks.

Current limitation:

- It knows about instruction URLs, but not DTC Operations documents as
  first-class objects.
- It doesn't have a document registry, SOP viewer, SOP editor, or process-doc
  search.
- It's task-centric, not portal-centric.

### DTC Operations

Location: `../dtc-operations`

What it gives us:

- A large private operations knowledge base under `content/`.
- Git-backed markdown docs with screenshots and Loom links.
- A structured SOP format that can be parsed by scripts and the Lambda app.
- A docs editor with search, filters, linting, drafts, diff, and GitHub-backed
  publishing.
- A Lambda full app that already serves docs, search, editing, linting, images,
  and frontend.
- A CI split between content-only validation and full app deployment.

Current limitation:

- It documents work, but it doesn't execute work.
- It has process documents, but most are not connected into task bundles.
- It doesn't know which process docs are used in active work.
- It doesn't track whether a real podcast, newsletter, event, or finance report
  is done.

### Podcast Assistant

Location: `../podcast-assistant`

What it gives us:

- Telegram intake for podcast notes, links, files, voice notes, images, audio,
  and video metadata.
- Voice/audio transcription through Groq Whisper.
- Image description through a Groq vision model.
- Inbox staging under `inbox/raw/` and processed material under `inbox/used/`.
- Heru-based agent execution with Codex or Claude engines.
- Retry and resume support for interrupted agent sessions.
- Progress updates back into Telegram.
- Generated podcast documents under `documents/`.
- Example podcast `.docx` files that can train or validate the output format.

Current limitation:

- It isn't a git repo.
- It has no shared auth, UI, durable job dashboard, or portal integration.
- Its podcast output format is explicitly temporary.
- It writes local files, not portal records.
- It's specialized for podcast prep, but the same intake flow can support other
  workflows later.

## Current Content Coverage

DTC Operations already has enough content to be the private knowledge base for
the portal. That content should be surfaced through DataOps, not copied into
the public app repo as the long-term source of truth.

Content inventory:

- 346 markdown documents.
- 240 SOPs.
- 67 templates.
- 35 references.
- 2 checklists.
- 2 playbooks.
- 187 docs with Loom metadata.

Largest domains:

- `media`: 79 docs
- `finance`: 48 docs
- `events`: 38 docs
- `community`: 35 docs
- `sales`: 30 docs
- `social-media`: 29 docs
- `newsletter`: 23 docs
- `courses`: 15 docs
- `internal-admin`: 13 docs
- `maven`: 10 docs

Important workflow clusters:

- Podcast: 40 docs, including 30 SOPs and 9 templates.
- Newsletter: 23 docs, including 15 SOPs and 7 templates.
- Events: 38 docs, including event creation, Luma, Meetup, LinkedIn,
  cancellation, rescheduling, and outreach.
- Finance: 48 docs, mostly bookkeeping, invoices, and monthly tax reporting.
- Book of the Week: 30 docs, including author outreach, announcements, Slack,
  winners, and templates.
- Open-Source Spotlight: 11 docs.
- Maven: 10 docs.
- Social media: 29 docs.

## Content Quality Findings

The process library is already large. The docs now need enough normalization to
become executable workflows.

Observed gaps:

- 55 docs have empty summary fields such as purpose, outcome, trigger, and
  frequency.
- 241 docs have empty validation sections.
- 345 docs have empty `related_docs`.
- 28 docs contain TODOs or placeholders.
- 2 SOPs are missing `schema_version`.
- Many docs are atomic SOPs, but only a few docs are true checklist or playbook
  docs that sequence several SOPs into a workflow.

The portal needs different content types:

- Atomic SOP: "How to create an event on Luma"
- Template: "Email to ask a podcast guest for links"
- Reference: "Podcast workflow overview"
- Checklist/playbook: "Run one podcast episode from first contact to publishing"
- Executable task template: "Create these 40 tasks relative to the podcast
  stream date"

The current content mostly covers atomic SOPs and reusable text templates. The
missing layer is workflow assembly.

## What Is Missing From the Unified Portal

### 1. A Document Registry

Tasks need to link to process docs by stable ID, not by brittle paths or raw
Google Doc links.

Needed:

- Stable `id` frontmatter for every operational doc used by tasks.
- Aliases for old names and old paths.
- API endpoint for document metadata.
- Resolver for wiki links and task instruction links.
- Broken-link validation in CI.

### 2. Workflow Definitions

The portal needs a first-class object between "many SOPs" and "active tasks".

Needed:

- Workflow definition for each repeatable operation.
- Phases such as prep, announced, live, post-production, published, follow-up.
- Milestones and date offsets.
- Required inputs and outputs.
- Related SOPs and templates.
- Automation hooks.

DataTasks templates can become this object, but the model needs richer doc
links and phases.

### 3. Work Intake

DataTalks.Club work starts in many places. Sources include Telegram, email,
spreadsheets, speaker conversations, sponsor messages, voice notes, and old
Trello cards.

Needed:

- One inbox in the portal.
- Source metadata for each intake item.
- Ability to convert intake into a task, bundle, doc draft, or assistant job.
- Duplicate detection.
- Attachment handling.
- Clear ownership: who must triage the item.

The podcast assistant already proves this pattern for Telegram.

### 4. Assistant Jobs

Some operations are not just "task created". They are "collect messy inputs and
draft a useful artifact".

Needed:

- Job records for assistant runs.
- Inputs, outputs, logs, status, retry state, and human review.
- Portal UI for starting and monitoring assistant jobs.
- Ability to attach generated artifacts to bundles and docs.
- Policy for whether generated files are committed to Git, saved in object
  storage, or attached to execution records.

Podcast prep should be the first assistant job type.

### 5. Artifact Management

Operations produce these artifacts:

- Podcast documents
- Event pages
- Luma URLs
- YouTube links
- Transcripts
- Sponsor documents
- Invoices
- Zip reports
- Mailchimp campaign links
- Social posts

Needed:

- Artifact records with type, URL/file, owner, status, and related task/bundle.
- Required artifact checks before a task can be completed.
- Search across artifacts.
- A clear distinction between private files, public URLs, and generated docs.

DataTasks already has a file model and required-link fields, but it needs a
broader artifact concept.

### 6. Process Quality Dashboard

If the portal depends on process docs, stale or incomplete docs become an
operations risk.

Needed:

- Docs missing validation.
- Docs with TODOs.
- Docs without related docs.
- Docs used by active workflows.
- Docs with broken images or broken internal links.
- Docs whose source process is still a legacy Google Doc.

This should sit next to the work dashboard because process quality affects daily
execution.

## Podcast Workflow Analysis

Podcast is the best first integration because all three systems touch it.

Existing assets:

- DataTasks has a podcast template reference from Trello with about 40 tasks.
- DTC Operations has 40 podcast docs: 30 SOPs, 9 templates, and 1 reference.
- Podcast Assistant can collect raw material and generate guest prep documents.
- The process docs include concrete SOPs such as creating a podcast document,
  creating transcriptions, adding a podcast episode in Airtable, updating
  YouTube links, scheduling Spotify episodes, moving documents to archive, and
  guest reminder templates.

Recommended portal flow:

1. A guest/topic arrives from Telegram, email, LinkedIn, or manual entry.
2. The operator creates a Podcast bundle or sends material to the Podcast
   Assistant inbox.
3. The assistant ingests notes, voice notes, screenshots, links, and files.
4. The assistant drafts a podcast prep document.
5. The operator reviews and approves the draft.
6. The approved podcast document becomes an artifact on the Podcast bundle.
7. The bundle creates tasks from the Podcast workflow definition.
8. Each task links to the relevant SOP or template.
9. Required outputs are captured as bundle artifacts: podcast doc, Luma link,
   Meetup link, YouTube link, transcript, Spotify link, Apple link, DTC webpage.
10. Milestone tasks move the bundle through stages: prep, announced, live,
    post-production, published, follow-up, done.

What needs to be added:

- A final podcast document template for the assistant.
- A portal API for assistant job submission and status.
- A job output review screen.
- A mapping from Podcast bundle fields to podcast document placeholders.
- A stable workflow definition that connects the 40 DataTasks tasks to the
  relevant DTC Operations SOPs.
- Validation checks for required outputs.

## Recommended Architecture

Use one public app repo plus one private operational knowledge repo. The app
provides one frontend/API and authenticated access to private Git-backed
knowledge.

Reasoning:

- The operational knowledge base is already in `dtc-operations`, but it
  contains sensitive information and should stay behind a private boundary.
- It already has the docs editor, search, content validation, GitHub publishing,
  Lambda deployment, and domain-first content structure.
- DataTasks is smaller and can be added as the execution module.
- Podcast Assistant is local tooling and should become an assistant module, not
  the base app.

Target shape:

- One public repo for the portal/runtime code.
- One private repo for operational knowledge.
- One frontend shell with `Work`, `Processes`, `Assistants`, `Assets`, `Search`,
  and `Admin`.
- One backend API surface.
- Private GitHub markdown remains the source of truth for knowledge.
- DynamoDB stores execution state.
- Object storage stores generated/private artifacts by default.
- Assistant jobs run asynchronously with durable logs and outputs.

## Proposed Navigation

### Home

- Today.
- Overdue.
- Waiting on review.
- Active bundles.
- Inbox items.
- Assistant jobs.
- Process quality warnings.

### Work

- Tasks.
- Bundles.
- Templates/workflows.
- Recurring work.
- Assignments.
- Calendar view.

### Processes

- SOPs.
- Checklists.
- Templates.
- References.
- Playbooks.
- Prompt library.
- Process quality dashboard.

### Assistants

- Podcast assistant.
- Process document assistant.
- Future assistants for newsletters, event setup, social media, and finance.

### Assets

- Files.
- Links.
- Generated documents.
- Images.
- Invoices and reports.
- Public artifacts such as event pages and YouTube videos.

### Search

- One search across tasks, bundles, docs, templates, artifacts, and assistant
  outputs.

### Admin

- Users.
- Integrations.
- Secrets/configuration.
- Content validation.
- Import/migration tools.

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
- Milestones and bundle stage transitions.
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
- Connect approved output to Podcast bundles.
- Finalize the podcast document template.

### Phase 4: Build Daily Operations

Goal: the team can start from the portal every morning.

Build:

- Today/Overdue/Upcoming dashboard.
- Inbox triage.
- Recurring tasks and recurring bundles.
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
process docs, task bundles, artifacts, assistant-generated documents, and
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
  -> Podcast bundle artifact -> tasks with SOP links.

## Key Decisions

### Repo

Recommendation: keep `dataops` as the public app/runtime repo. Keep
operational knowledge in a separate private GitHub repo. DataOps renders and
edits that knowledge through authenticated APIs.

### Source of Truth

Recommendation:

- Private GitHub markdown is the source of truth for process knowledge.
- DynamoDB is the source of truth for execution state.
- Assistant outputs become artifacts that are attached to bundles.

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
