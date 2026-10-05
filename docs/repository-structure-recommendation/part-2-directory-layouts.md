> Part 2 of 3 of the [DataOps Repository and Directory Structure
> Recommendation](../repository-structure-recommendation.md):
> Part 1 covers [ownership principles and the repository map](part-1-ownership-and-repository-map.md),
> and Part 3 covers [navigation, the transition plan, and the implementation
> goal](part-3-navigation-transition-and-goal.md).

## What Lives Where

| Thing | Recommended home | Reason |
|---|---|---|
| Portal frontend | `dataops/app/frontend` | Product code |
| Portal backend APIs | `dataops/app/backend` | Product code |
| Work engine | `dataops/app/backend` and `dataops/app/frontend` | Core product, not separate app |
| Docs editor/search code | `dataops/app` | Product capability |
| SOP markdown | private `dataops-knowledge/content` | Canonical operational knowledge |
| Task/workflow templates | private `dataops-knowledge/workflow-templates` | Canonical process definitions |
| Communication templates | private `dataops-knowledge/content/**/templates` | Knowledge, reusable wording |
| Assistant prompts/processes | private `dataops-knowledge/assistant-prompts` | Reviewable operational knowledge |
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
| Runtime workflow cards | DynamoDB | Execution state |
| Recurring configs | DynamoDB with optional Git seed | Runtime schedule state |
| Audit history | DynamoDB | Execution history |
| Domain/OIDC/IAM | `aws-infra` | Shared infrastructure ownership |
| App Lambda/SAM template | `dataops/infra/app` or current `lambda-functions` | Deployable app code boundary |

## Podcast-Specific Recommendation

Podcast is the clearest example because it has process docs, task templates,
assistant code, raw inputs, generated drafts, recordings, transcripts, public
pages, and third-party links.

### Keep in private knowledge repo as process knowledge

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
- curated examples only if reviewed and approved for private repository use.

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

The official workflow card stores:

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
card_links:
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
- the old source `podcast-assistant/` import has become `assistants/podcast/`
  plus app API integration.
- `content/` either remains here short-term or moves to `dataops-knowledge`
  when the sync/import boundary is implemented.
