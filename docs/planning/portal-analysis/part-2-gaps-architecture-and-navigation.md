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
- Ability to convert intake into a task, card, doc draft, or assistant job.
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
- Ability to attach generated artifacts to cards and docs.
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

- Artifact records with type, URL/file, owner, status, and related task/card.
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
2. The operator creates a Podcast card or sends material to the Podcast
   Assistant inbox.
3. The assistant ingests notes, voice notes, screenshots, links, and files.
4. The assistant drafts a podcast prep document.
5. The operator reviews and approves the draft.
6. The approved podcast document becomes an artifact on the Podcast card.
7. The card creates tasks from the Podcast workflow definition.
8. Each task links to the relevant SOP or template.
9. Required outputs are captured as card artifacts: podcast doc, Luma link,
   Meetup link, YouTube link, transcript, Spotify link, Apple link, DTC webpage.
10. Milestone tasks move the card through stages: prep, announced, live,
    post-production, published, follow-up, done.

What needs to be added:

- A final podcast document template for the assistant.
- A portal API for assistant job submission and status.
- A job output review screen.
- A mapping from Podcast card fields to podcast document placeholders.
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
- Active cards.
- Inbox items.
- Assistant jobs.
- Process quality warnings.

### Work

- Tasks.
- Cards.
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

- One search across tasks, cards, docs, templates, artifacts, and assistant
  outputs.

### Admin

- Users.
- Integrations.
- Secrets/configuration.
- Content validation.
- Import/migration tools.

