> Part 1 of 3 of the [DataOps Repository and Directory Structure
> Recommendation](../repository-structure-recommendation.md):
> Part 2 covers [what lives where and directory layouts](part-2-directory-layouts.md),
> and Part 3 covers [navigation, the transition plan, and the implementation
> goal](part-3-navigation-transition-and-goal.md).

## Purpose

This document recommends where DataOps product code, process documents,
workflow templates, assistant code, generated artifacts, private files, and
infrastructure should live.

The goal is to make the unified DataOps platform easy to change while keeping a
clear boundary between:

- the product that runs the portal;
- the private operational knowledge that defines how DataTalksClub work is
  done;
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

- Public Git in `DataTalksClub/dataops` stores code, schemas, tests, sanitized
  fixtures, and public-safe planning docs.
- Private Git in `DataTalksClub/dataops-knowledge` stores process knowledge,
  workflow definitions, assistant prompts/process instructions, screenshots,
  and small canonical templates.
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

It may temporarily contain `content/` while the product is being unified, but
that content is public-sensitive migration debt because this repo is public.
The long-term recommendation is to make operational knowledge a separate
private repo, described below, and keep only sanitized fixtures or generated
public-safe views here.

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
  work-engine/          # DataOps work-engine module, to be folded into app/
  assistants/podcast/   # DataOps podcast assistant module
  content/              # existing process docs and templates
  docs/                 # product/architecture/recommendation docs
  tests/                # docs portal tests
```

The current shape can ship. The recommended shape is the cleanup target once
the unified flows are clear.

### 2. `DataTalksClub/dataops-knowledge` private repo

Role: canonical process knowledge repository.

This is the repo I recommend creating once V1 is stable enough that process
docs and app code should move at different speeds. It should be private by
default because the operational docs contain sensitive process details, private
links, people/contact context, sponsor or finance context, screenshots, and
assistant instructions that should not be public.

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
- Transcripts for specific episodes unless explicitly reviewed and approved as
  private repository examples.
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
The app can also serve them in the unified operator UI, but raw private
knowledge should remain in the private repository.

The private knowledge repository should back itself up to private S3 once per
day. The backup job should compare the current Git commit SHA to the latest S3
backup manifest and upload a new archive only when the commit changed. Each
backup should include a Git archive zip for quick inspection, a Git card for
full-history restore, a JSON manifest, and SHA-256 checksums.

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
    cards/{card_id}/
  reports/
    finance/
  exports/
  knowledge-backups/
    dataops-knowledge/
      daily/
      latest/
```

DataOps should store metadata in DynamoDB:

- artifact type;
- URL or storage path;
- task ID;
- card ID;
- assistant job ID;
- owner;
- status;
- created/updated timestamps;
- review state.

The platform user sees these artifacts in one workflow view, but the files
remain outside Git.
