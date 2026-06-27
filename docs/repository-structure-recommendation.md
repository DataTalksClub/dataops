# DataOps Repository and Directory Structure Recommendation

## Purpose

This document recommends where DataOps product code, process documents,
workflow templates, assistant code, generated artifacts, private files, and
infrastructure should live.

The goal is to make the unified DataOps platform easy to change while keeping a
clear boundary between:

- the product that runs the portal;
- the operational knowledge that defines how DataTalksClub work is done;
- the runtime records that prove real work happened;
- private or bulky files that should not live in Git.

## Core Principle

DataOps should feel like one platform to the operations manager, but it should
not store every kind of object in one place.

This recommendation is intentionally about DataOps only. It does not use other
DataTalksClub websites or nearby projects as a structural model. External
systems matter only because DataOps needs to link to them, collect evidence
from them, or remind the operator to update them.

The product UI can unify everything. The repositories should keep ownership
clear:

- Git stores code, process knowledge, workflow definitions, and small canonical
  templates.
- DynamoDB stores execution state: tasks, workflow runs, reminders, statuses,
  assignments, and audit events.
- S3/Dropbox/Google Drive stores private or bulky operational files.
- External systems remain the system of record where appropriate, with DataOps
  storing links, metadata, reminders, and proof.
- `../aws-infra` stores shared AWS infrastructure and account-level deployment
  wiring.

## Recommended Repository Map

### 1. `DataTalksClub/dataops`

Role: product/runtime repository.

This repo should contain the application that powers `ops.dtcdev.click`.

It should contain:

- Portal shell and frontend.
- Backend APIs.
- Work engine: tasks, workflows, templates, recurring operations, reminders,
  notifications, files metadata, users, auth, and audit.
- Docs portal integration code.
- Assistant integration code and job model.
- Tests.
- Local development scripts.
- Product specs and implementation docs.
- Deployment workflow for this app.
- Small seed data needed for development and tests.

It may temporarily contain `content/` while the product is being unified. The
long-term recommendation is to make operational knowledge a separate repo or a
clearly isolated Git-backed content package, described below.

Recommended top-level shape:

```text
dataops/
  app/
    frontend/
    backend/
    shared/
  assistants/
    podcast/
    shared/
  content/
    README.md
    process/
    workflow-templates/
    prompts/
    indexes/
  docs/
    product/
    architecture/
    operations/
    decisions/
  infra/
    app/
  scripts/
  tests/
    unit/
    e2e/
    integration/
  .github/
```

For the current repository, this maps to:

```text
dataops/
  frontend/             # existing docs portal frontend
  lambda-functions/     # existing docs portal backend/lambda
  work-engine/          # existing DataTasks engine, to be folded into app/
  podcast-assistant/    # existing assistant, to be folded into assistants/
  content/              # existing process docs and templates
  docs/                 # product/architecture/recommendation docs
  tests/                # docs portal tests
```

The current shape can ship. The recommended shape is the cleanup target once
the unified flows are clear.

### 2. `DataTalksClub/dataops-knowledge`

Role: canonical process knowledge repository.

This is the repo I recommend creating once V1 is stable enough that process
docs and app code should move at different speeds.

It should contain:

- SOPs.
- References.
- Playbooks.
- Communication templates.
- Workflow templates as canonical Git documents.
- Assistant prompts and process instructions.
- Lightweight indexes and validation metadata.
- Screenshots and small images needed by SOPs.

It should not contain:

- Runtime task instances.
- Podcast guest-specific prep docs.
- Raw podcast inputs.
- Recordings.
- Transcripts for specific episodes unless intentionally used as public
  knowledge examples.
- Invoices, receipts, bank statements, tax zips, sponsor performance files, or
  private contact lists.
- DynamoDB exports.

Recommended shape:

```text
dataops-knowledge/
  content/
    overview/
    community/
    courses/
    events/
    finance/
    media/
      podcast/
      webinar/
      workshop/
      video-youtube/
      open-source-spotlight/
    newsletter/
    sales/
    social-media/
    systems/
    internal-admin/
  workflow-templates/
    newsletter.yaml
    podcast.yaml
    webinar.yaml
    workshop.yaml
    book-of-the-week.yaml
    open-source-spotlight.yaml
    social-media-weekly.yaml
    tax-report.yaml
    course.yaml
    maven-lightning-lesson.yaml
    office-hours.yaml
  assistant-prompts/
    podcast/
      intake.md
      document-generation.md
      review-checklist.md
  schemas/
    document.schema.json
    workflow-template.schema.json
  indexes/
    document-registry.yaml
    systems.yaml
  images/
  scripts/
  tests/
```

Why workflow templates belong with process docs:

- They are operational knowledge, not runtime state.
- They preserve the process even if the task database is lost.
- They are reviewed like documentation.
- They explain what tasks exist, why they exist, and which SOPs prove how to do
  them.

The app repo can import or sync these templates into DynamoDB for execution.

### 3. `DataTalksClub/aws-infra`

Role: infrastructure repository.

This repo should continue to contain shared AWS and account-level infrastructure.

It should contain:

- Route 53/domain wiring.
- ACM certificates.
- GitHub OIDC roles.
- Shared IAM policies.
- Shared networking if needed.
- Shared S3 buckets when they are account-level resources.
- DataOps sandbox/prod stack wrappers.

Recommended DataOps location:

```text
aws-infra/
  sandbox/
    dataops/
      README.md
      github-oidc.tf or template.github-actions.yaml
      domain.tf or template.domain.yaml
      shared-buckets.tf
  main/
    dataops/
      README.md
      github-oidc.tf
      domain.tf
      shared-buckets.tf
```

App-specific deployment templates can stay in `dataops/infra/app/` or
`lambda-functions/` while the app is Lambda/SAM based. The boundary should be:

- `aws-infra`: permissions, domains, shared resources, account-level setup.
- `dataops`: deployable app stack and CI workflow that knows the app package.

### 4. Runtime storage outside Git

Role: real operational records and private/bulky artifacts.

These should not live in either code or knowledge repos:

- Raw Telegram uploads.
- Raw audio/video.
- Guest-specific podcast prep drafts.
- Episode-specific generated docs before review.
- Dropbox recordings.
- Transcription files.
- Invoices.
- Receipts.
- Bank statements.
- Tax report zips.
- Sponsor reports.
- Private lists of emails.
- Assistant run logs if they contain sensitive user input.

Recommended storage:

```text
s3://dtc-dataops-artifacts/
  assistant-jobs/
    podcast/
      {job_id}/
        inputs/
        outputs/
        logs/
  files/
    tasks/{task_id}/
    bundles/{bundle_id}/
  reports/
    finance/
  exports/
```

DataOps should store metadata in DynamoDB:

- artifact type;
- URL or storage path;
- task ID;
- bundle ID;
- assistant job ID;
- owner;
- status;
- created/updated timestamps;
- review state.

The platform user sees these artifacts in one workflow view, but the files
remain outside Git.

## What Lives Where

| Thing | Recommended home | Reason |
|---|---|---|
| Portal frontend | `dataops/app/frontend` | Product code |
| Portal backend APIs | `dataops/app/backend` | Product code |
| Work engine | `dataops/app/backend` and `dataops/app/frontend` | Core product, not separate app |
| Docs editor/search code | `dataops/app` | Product capability |
| SOP markdown | `dataops-knowledge/content` | Canonical operational knowledge |
| Task/workflow templates | `dataops-knowledge/workflow-templates` | Canonical process definitions |
| Communication templates | `dataops-knowledge/content/**/templates` | Knowledge, reusable wording |
| Assistant prompts/processes | `dataops-knowledge/assistant-prompts` | Reviewable operational knowledge |
| Assistant service code | `dataops/assistants` | Product code |
| Assistant raw inbox | S3 or private runtime storage | Private/bulky operational input |
| Assistant generated draft | S3 plus DynamoDB artifact record | Runtime artifact needing review |
| Approved podcast prep doc | Google Drive/Docs or S3, linked as artifact | Episode artifact, not process knowledge |
| Public podcast page URL/status | DataOps artifact metadata | DataOps tracks whether the public page exists; the public site remains an external system |
| Podcast historical examples | `dataops-knowledge/examples` only if curated | Training/reference, not raw archive |
| Podcast knowledge base index | Generated artifact, rebuildable | Do not hand-edit generated data |
| Invoices/receipts/statements | Dropbox/S3/finance system | Private finance records |
| Tax report zip | Dropbox/S3, linked in task | Private finance artifact |
| Runtime tasks | DynamoDB | Execution state |
| Runtime workflow bundles | DynamoDB | Execution state |
| Recurring configs | DynamoDB with optional Git seed | Runtime schedule state |
| Audit history | DynamoDB | Execution history |
| Domain/OIDC/IAM | `aws-infra` | Shared infrastructure ownership |
| App Lambda/SAM template | `dataops/infra/app` or current `lambda-functions` | Deployable app code boundary |

## Podcast-Specific Recommendation

Podcast is the clearest example because it has process docs, task templates,
assistant code, raw inputs, generated drafts, recordings, transcripts, public
pages, and third-party links.

### Keep in Git as process knowledge

```text
dataops-knowledge/
  content/media/podcast/
    reference/
    sops/
    templates/
  workflow-templates/
    podcast.yaml
  assistant-prompts/podcast/
    intake.md
    document-generation.md
    review-checklist.md
  examples/podcast/
    README.md
```

This includes:

- how to run podcast workflow;
- how to create podcast document;
- how to create Luma/Meetup/Calendar/YouTube/Spotify/page records;
- email/message templates;
- podcast task template;
- assistant instructions;
- curated examples only if they are safe and useful for future generation.

### Keep in the app repo as product code

```text
dataops/
  assistants/podcast/
    api.py or routes.ts
    runner.py
    transcription.py
    review.py
    tests/
```

This includes:

- assistant job creation;
- status tracking;
- retry/resume behavior;
- integration with Telegram or portal uploads;
- artifact registration;
- UI/API glue.

### Keep outside Git as runtime artifacts

```text
s3://dtc-dataops-artifacts/assistant-jobs/podcast/{job_id}/
  inputs/
    telegram-message.json
    audio.m4a
    links.json
  outputs/
    draft.md
    extracted-fields.json
  logs/
    run.log
```

The official workflow bundle stores:

- guest name;
- topic;
- stream date;
- podcast doc artifact link;
- Luma link;
- Meetup link;
- YouTube link;
- transcription link;
- Spotify link;
- Apple Podcasts link;
- DataTalksClub page link;
- waiting/follow-up state;
- completion audit.

The operator should not care whether the draft lives in S3, Google Drive, or
another storage backend. They should see it as an artifact attached to the
podcast workflow.

## Knowledge Repo Structure Details

### `content/`

Use this for human-readable operational documents:

```text
content/{domain}/{subdomain}/{doc_type}/{slug}.md
```

Examples:

```text
content/media/podcast/sops/create-a-podcast-document.md
content/newsletter/mailchimp/sops/schedule-a-newsletter-on-mailchimp.md
content/finance/tax-reporting/sops/monthly-tax-report.md
content/social-media/templates/template-linkedin-and-x-announcement-article.md
```

Docs should have stable frontmatter IDs:

```yaml
id: sop.media.podcast.create-podcast-document
title: Create a podcast document
doc_type: sop
systems: [google-drive, google-docs, google-calendar]
```

Tasks should reference this ID instead of only a path or Google Doc URL.

### `workflow-templates/`

Use this for executable definitions:

```yaml
id: workflow.podcast
name: Podcast
trigger: manual
anchor: stream_date
bundle_links:
  - guest_email
  - podcast_document
  - luma
  - meetup
  - youtube
  - transcription
  - spotify
  - apple_podcasts
  - dtc_page
phases:
  - id: preparation
  - id: announced
  - id: after_event
  - id: done
tasks:
  - id: create-podcast-document
    phase: preparation
    offset_days: -27
    instruction_doc_id: sop.media.podcast.create-podcast-document
    required_link: podcast_document
```

Benefits:

- Templates are diffable.
- Process and executable workflow stay together.
- Runtime DynamoDB templates can be regenerated.
- CI can validate task IDs, doc IDs, required links, and phases.

### `assistant-prompts/`

Use this for versioned assistant behavior:

```text
assistant-prompts/podcast/
  intake.md
  document-generation.md
  review-checklist.md
```

These prompts are operational knowledge. They should be reviewable and versioned
with the process, while assistant code stays in the app repo.

### `schemas/`

Use this for validation:

```text
schemas/
  document.schema.json
  workflow-template.schema.json
  assistant-prompt.schema.json
```

CI should validate:

- required frontmatter;
- stable IDs;
- no duplicate IDs;
- workflow task IDs;
- valid doc references;
- valid required link names;
- no broken internal links.

## App Repo Structure Details

Recommended target:

```text
dataops/
  app/
    frontend/
      src/
      public/
      styles/
    backend/
      src/
        routes/
          work/
          knowledge/
          assistants/
          artifacts/
          search/
        services/
          tasks/
          workflows/
          recurring/
          reminders/
          docs/
          assistant_jobs/
          artifacts/
        storage/
        auth/
      template.yaml
    shared/
      types/
      schemas/
  assistants/
    podcast/
      runner/
      tests/
  docs/
    product/
    architecture/
    decisions/
    operations/
  infra/
    app/
  scripts/
  tests/
```

Current-to-target migration:

- `work-engine/src` becomes `app/backend/src/routes/work`,
  `app/backend/src/services/tasks`, `app/backend/src/services/workflows`, and
  related frontend screens.
- `lambda-functions/src/lambda_functions` becomes `app/backend/src/routes/knowledge`
  and `app/backend/src/services/docs`, or remains as Python until a later
  consolidation decision.
- `frontend/` becomes the shared portal frontend shell or docs frontend module.
- `podcast-assistant/` becomes `assistants/podcast/` plus app API integration.
- `content/` either remains here short-term or moves to `dataops-knowledge`
  when the sync/import boundary is implemented.

## Product Navigation Should Not Mirror Repos

The user should not see repository boundaries.

Recommended portal navigation:

```text
Home
Workflows
Tasks
Inbox
Assistants
Knowledge
Templates
Recurring
Artifacts
Settings
```

How that maps internally:

- Home reads DynamoDB tasks, bundles, reminders, notifications, doc health, and
  assistant jobs.
- Workflows read DynamoDB bundles and Git-backed workflow definitions.
- Tasks read DynamoDB tasks and Git-backed instruction docs.
- Inbox reads DynamoDB/S3 intake records.
- Assistants read DynamoDB jobs, S3 files, and Git-backed prompts.
- Knowledge reads Git-backed markdown.
- Templates read Git-backed workflow templates plus DynamoDB runtime templates.
- Recurring reads DynamoDB recurring configs.
- Artifacts read DynamoDB metadata and S3/Dropbox/Google Drive links.

This navigation is based on the DataOps operating model:

- start the day;
- see work;
- handle reminders and follow-ups;
- open a workflow;
- complete tasks with proof;
- use docs only when needed;
- run assistants when raw input needs transformation;
- preserve artifacts and audit.

It is not intended to match the directory structure of any other DataTalksClub
site.

## Transition Plan

### Step 1: Keep current repo intact but label ownership

Add documentation and metadata that says:

- `content/` is operational knowledge.
- `content/tasks/templates/` is canonical imported task-template documentation
  for now.
- `work-engine/` is execution engine.
- `podcast-assistant/` is assistant prototype.
- `lambda-functions/` and `frontend/` are current deployed portal app.

No large moves yet.

### Step 2: Introduce stable IDs and workflow template files

Add:

```text
content/indexes/document-registry.yaml
content/workflow-templates/
```

or, if preparing for a split:

```text
workflow-templates/
schemas/
assistant-prompts/
```

Then map runtime tasks to `instructionDocId`, not just raw Google Doc URLs.

### Step 3: Move generated/private outputs out of Git

For podcast assistant:

- Keep prompts and code in Git.
- Move raw inputs, generated drafts, logs, and episode-specific outputs to S3 or
  another private storage backend.
- Store artifact metadata in DynamoDB.

### Step 4: Split `dataops-knowledge` only when the sync boundary exists

Do not split content before the app can:

- read docs from that repo;
- validate doc IDs;
- sync workflow templates into runtime templates;
- deploy or refresh content without app-code deploy;
- keep CI green in both repos.

Until then, keeping `content/` in `dataops` is simpler and safer.

### Step 5: Clean up the app folders

After unified UX decisions are implemented:

- fold `work-engine` into `app`;
- fold `podcast-assistant` into `assistants/podcast`;
- consolidate shared types and schemas;
- keep old folder moves in separate commits to avoid mixing refactors with
  product behavior changes.

## Recommended Near-Term Decision

For the next implementation goal, keep everything in `DataTalksClub/dataops`
except shared AWS infrastructure in `../aws-infra`.

Do this because:

- V1 still needs product discovery and fast iteration.
- Splitting content now would add sync complexity before the user experience is
  clear.
- The app already deploys from this repo.
- The current docs, task templates, and assistant prototype are already visible
  here.

But design the directories as if `content/`, `workflow-templates/`, and
`assistant-prompts/` can later become `DataTalksClub/dataops-knowledge`.

The clearest near-term structure is:

```text
dataops/
  content/
    ...existing process docs...
    workflow-templates/
    assistant-prompts/
    indexes/
  app/
    ...new unified app code, introduced gradually...
  work-engine/
    ...existing task engine until folded in...
  lambda-functions/
    ...existing deployed docs/backend until folded in...
  frontend/
    ...existing docs frontend until folded in...
  podcast-assistant/
    ...prototype until folded into assistants/podcast...
  docs/
    product and architecture docs
```

This lets the product move now while preserving the option to split knowledge
later.

## Concise Goal For Implementation Planning

Build DataOps as one operations workspace where:

- `dataops` owns the running app and current canonical knowledge;
- `aws-infra` owns AWS account-level infrastructure;
- runtime work state lives in DynamoDB;
- private/bulky artifacts live outside Git;
- process docs, workflow templates, and assistant prompts are versioned in Git;
- the UI hides repository boundaries and gives the operations manager one daily
  flow for tasks, workflows, reminders, follow-ups, artifacts, docs, and
  assistants.
