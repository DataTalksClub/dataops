---
title: "ADR: DataOps Knowledge Repository Boundary"
summary: "Decision record for separating DataOps app/runtime code, canonical process knowledge, workflow templates, assistant knowledge, runtime state, and private artifacts."
doc_type: reference
tags:
  - adr
  - architecture
  - process-docs
  - migration
  - data
systems:
  - github
  - aws
  - dynamodb
  - s3
related_docs:
  - docs/repository-structure-recommendation.md
  - docs/v1-runtime-architecture.md
  - docs/v1-execution-data-safety.md
---

# ADR: DataOps Knowledge Repository Boundary

## Status

Accepted for planning. Implementation is out of scope for this ADR.

## Context

DataOps V1 should feel like one workflow-first workspace for the operations
manager, but repository and storage ownership need clear boundaries.

Current state:

- `DataTalksClub/dataops` is the product/runtime repository for
  `ops.dtcdev.click`.
- `content/` is the transitional Git home for imported SOPs, references,
  images, prompts, indexes, and task templates.
- `content/tasks/templates/` contains DataTasks workflow templates that encode
  repeatable operational process.
- `assistants/podcast/` is the canonical in-repo Podcast Assistant module.
- Runtime workflow state is stored in DynamoDB execution tables managed by the
  deployed stack.
- Private or bulky files must remain outside public process documentation.
- `../dtc-operations`, `../datatasks`, and `../podcast-assistant` are read-only
  source systems for DataOps migration work unless another issue explicitly
  scopes source-repo edits.

The main risk is mixing durable process knowledge, executable app code, mutable
runtime records, and private generated artifacts into one ownership model. That
would make review, restore, export, and future repo migration harder.

## Decision

Create a future canonical process repository named
`DataTalksClub/dataops-knowledge`.

Visibility: public by default, with a required pre-migration data review. If the
review finds private credentials, private contact data, customer or sponsor
records, invoice data, unreleased guest material, or generated assistant output,
those items stay out of the repository or the repository remains private until
redaction is complete.

Ownership:

- Product/runtime ownership remains in `DataTalksClub/dataops`.
- Canonical process knowledge ownership moves to
  `DataTalksClub/dataops-knowledge` after sync, validation, and portal edit
  support exist.
- Shared AWS account ownership remains in `DataTalksClub/aws-infra`.
- Runtime execution data remains in DynamoDB and portable exports.
- Private and bulky operational files remain in S3, Dropbox, Google Drive, or
  another private artifact store.

Rationale:

- `dataops-knowledge` says what the repository owns more precisely than
  `dataops-docs`. The repo will contain SOPs, process metadata, workflow
  definitions, assistant process instructions, and validation assets, not only
  prose documentation.
- Process knowledge and app code should move at different review and release
  speeds.
- Workflow templates are operational knowledge and must survive a runtime
  database rebuild.
- DynamoDB execution records are mutable operational state and should not be
  reviewed as Git documentation.
- Private outputs and uploads should not enter a public docs repository.

Do not split the repository immediately. Keep `content/` in `dataops` until the
app can read from the knowledge repository, validate it in CI, sync templates
into the work engine, refresh deployed content without app redeploy, and commit
portal edits to the correct repository.

## Repository Boundaries

| Boundary | Canonical home | Includes | Excludes |
|---|---|---|---|
| Product/runtime code | `DataTalksClub/dataops` | Portal frontend, Lambda APIs, work-engine code, assistant service code, tests, app deployment, local development seeds, product architecture docs | Canonical process repo after migration, private artifacts, long-lived runtime records |
| Process knowledge | `DataTalksClub/dataops-knowledge` | SOPs, references, playbooks, communication templates, workflow templates, assistant prompts/process instructions, small doc images, validation schemas, lightweight generated indexes | Runtime task instances, audit events, assistant jobs, generated documents, raw recordings, invoices, DynamoDB exports |
| Shared infrastructure | `DataTalksClub/aws-infra` | Account-level OIDC, IAM, Route 53, certificates, shared buckets, shared deployment wrappers | App source, app-specific Lambda code, process content |
| Runtime execution state | DynamoDB tables owned by the `dataops-v1` stack | Tasks, bundles, reminders, runtime templates loaded from Git, recurring configs, file metadata, artifact metadata, assistant job metadata, audit events | Canonical process docs and template source files |
| Private/bulky artifacts | S3, Dropbox, Google Drive, or equivalent private storage | Raw uploads, recordings, transcripts, invoices, receipts, guest-specific podcast drafts, generated assistant outputs, export bundles | Public process knowledge, app code |

## Knowledge Repository Contents

The knowledge repository contains more than `content/`.

Target shape:

```text
dataops-knowledge/
  content/
    ...domain-first SOPs, references, playbooks, and communication templates...
  workflow-templates/
    book-of-the-week.yaml
    course.yaml
    maven-ll.yaml
    newsletter.yaml
    office-hours.yaml
    oss.yaml
    podcast.yaml
    social-media.yaml
    tax-report.yaml
    webinar.yaml
    workshop.yaml
  assistant-prompts/
    podcast/
      intake.md
      document-generation.md
      review-checklist.md
  assistant-process/
    podcast/
      podcast.md
      podcast-guest-intake.md
  examples/
    podcast/
      README.md
  images/
  indexes/
    document-registry.yaml
    systems.yaml
  schemas/
    document.schema.json
    workflow-template.schema.json
    assistant-prompt.schema.json
  tests/
  scripts/
```

Rules:

- Human-readable operational documents live under `content/`.
- Executable workflow definitions live under `workflow-templates/`.
- Prompts and assistant process instructions live under `assistant-prompts/`
  and `assistant-process/`.
- Small screenshots and images used by SOPs live under `images/` or a
  content-relative image layout selected during migration.
- Lightweight indexes and registries can live under `indexes/` when they are
  either maintained metadata or deterministic generated files.
- Large generated indexes, search bundles, and runtime caches remain generated
  artifacts and are not hand-edited.
- Curated examples may move only after data review confirms they are safe,
  useful, and intentionally public.

## DataTasks Template Decision

DataTasks templates are canonical process knowledge, not runtime state.

Canonical Git location after migration:

```text
DataTalksClub/dataops-knowledge/workflow-templates/*.yaml
```

Preferred format: YAML with a strict JSON Schema. YAML is easier to review for
operators and maintainers than JSON while remaining machine-readable.

Each template should include:

- stable `id`, `type`, `name`, `schema_version`, and optional aliases
- trigger and anchor-date model
- bundle link definitions
- phases and task stage mapping
- task list with stable task IDs
- offsets or scheduling rules
- required proof and required link declarations
- default assignee references by stable role/user ID, not personal names only
- `instruction_doc_id` links to SOP stable IDs
- optional migration source metadata

The current Markdown files in `content/tasks/templates/` remain the
transitional canonical copies until the YAML source files exist. During
migration, convert the 11 current templates to YAML and keep generated
Markdown/portal views derived from YAML if human-readable template pages are
still needed.

Runtime behavior:

- The work engine loads or syncs runtime template records from the Git-backed
  YAML source.
- DynamoDB may cache the current runtime template version for fast execution and
  historical task creation.
- DynamoDB is not the source of truth for canonical template definitions.
- Runtime tasks and bundles should store the template ID and template version
  used to create them so old executions remain explainable after template edits.
- A full DynamoDB rebuild must be able to restore template definitions from Git
  plus runtime execution exports.

## Assistant Boundary

`assistants/podcast/` remains the canonical product-code location for the
Podcast Assistant in `dataops`.

Keep in `dataops`:

- Python assistant code and CLI entrypoints
- package metadata and lock files
- tests and integration-test harnesses
- search/build scripts that are part of the assistant implementation
- job creation, retry, resume, queue, progress, and DataOps integration code
- local `.env.example` and development documentation

Move or duplicate to `dataops-knowledge` after review:

- reusable podcast process instructions from `assistants/podcast/process/`
- reusable guest-intake templates from `assistants/podcast/templates/`
- prompts and review checklists used to shape assistant behavior
- curated, public-safe knowledge-base summaries and taxonomies from
  `assistants/podcast/knowledge_base/`
- curated examples only when explicitly approved as public training/reference
  material

Keep outside Git:

- raw inbox files
- guest-specific generated documents
- recordings and transcripts
- assistant run logs with user input or private context
- Heru run artifacts
- generated draft outputs
- private guest, sponsor, or contact details

Assistant jobs should attach generated outputs to DataOps workflow artifacts.
The operator should see them in the workflow UI, but the files themselves belong
in private artifact storage with DynamoDB metadata.

## Migration Inventory

| Current path | Decision | Future home | Notes |
|---|---|---|---|
| `content/` | Move later | `dataops-knowledge/content/` plus selected sibling folders | Keep in `dataops` until read/sync/edit/refresh support exists. |
| `content/tasks/templates/` | Convert then move | `dataops-knowledge/workflow-templates/*.yaml` | Current Markdown remains transitional canonical source. Generate Markdown views only if needed. |
| `content/images/` | Move after review | `dataops-knowledge/images/` or content-relative images | Keep small SOP screenshots. Exclude private screenshots or bulky media. |
| `content/prompts/` | Move after review | `dataops-knowledge/assistant-prompts/` or `content/prompts/` | Process prompts are knowledge, not runtime code. |
| `content/indexes/` | Split | `dataops-knowledge/indexes/` for maintained registries; CI artifacts for generated search bundles | Do not hand-edit generated search indexes. |
| `assistants/podcast/process/` | Move or duplicate after review | `dataops-knowledge/assistant-process/podcast/` | Reusable process knowledge. Code keeps references/config to load it. |
| `assistants/podcast/templates/` | Move or duplicate after review | `dataops-knowledge/assistant-process/podcast/` or `assistant-prompts/podcast/` | Guest-intake and reusable templates are knowledge. |
| `assistants/podcast/knowledge_base/` | Curate before moving | `dataops-knowledge/assistant-process/podcast/` or `examples/podcast/` | Only stable, public-safe summaries/taxonomies move. Episode-specific or private material stays external. |
| `assistants/podcast/data/` | Defer | App repo or generated artifact storage depending on file role | Decide after classifying source data versus generated indexes. |
| `assistants/podcast/podcast_examples/` | Keep out unless curated | External/private storage, or `dataops-knowledge/examples/podcast/` after approval | Current `.docx` examples look episode-specific and need data review. |
| `assistants/podcast/inbox/` | Keep outside Git | S3 or private runtime storage | Git should keep placeholders only during transition. |
| `assistants/podcast/documents/` | Keep outside Git | S3, Google Drive, or private artifact storage | Generated guest-specific docs are artifacts. |
| `work-engine/docs/templates.md` | Keep as reference until replaced | `dataops` docs or generated docs | Useful migration reference, not canonical executable source after YAML templates exist. |
| `docs/repository-structure-recommendation.md` | Keep | `dataops/docs/` | Background recommendation; this ADR is the durable decision. |

## Runtime Configuration Implications

Future implementation needs explicit runtime configuration. This ADR does not
change it.

Needed changes:

- Add app configuration for `KNOWLEDGE_REPO_OWNER`,
  `KNOWLEDGE_REPO_NAME`, `KNOWLEDGE_REPO_BRANCH`, and content root paths.
- Teach Lambda content reads to clone or download `dataops-knowledge` instead
  of reading only `DataTalksClub/dataops/content`.
- Keep a local Lambda cache for knowledge repo content and generated search
  index data.
- Add a refresh path for docs/template pushes that invalidates the cache and
  rebuilds the search index without redeploying app code.
- Add GitHub token or GitHub App permissions for reading and writing the
  knowledge repo.
- Scope write credentials to the knowledge repo, not broad organization write
  permissions.
- Add configuration for template sync source path and target runtime table.
- Track template source commit SHA in runtime template records.
- Keep local development able to read from an in-repo `content/` fallback until
  migration is complete.

## Portal Edit Commit Model

Portal edits to process docs and workflow templates should commit to
`DataTalksClub/dataops-knowledge`, not to app-code deployment commits.

Branch strategy:

- Minor typo and formatting edits may commit directly to the configured
  knowledge branch only after validation passes.
- SOP, prompt, or workflow-template changes that affect execution should create
  a branch named `portal/<date>/<slug>` and open or link a review issue.
- Template schema changes require normal issue-driven implementation in
  `dataops` before knowledge content can depend on the new schema.

Review expectations:

- Direct edits require automated validation before the commit is accepted.
- Material process changes should be reviewed through the DataOps issue
  pipeline and linked to the knowledge commit.
- Workflow-template changes need template schema validation and doc-ID
  reference validation.
- Assistant prompt/process changes should receive Assistant Engineer review
  when they affect assistant behavior.

Commit authoring:

- The commit author should identify the human operator when available.
- The committer should identify the DataOps portal automation identity.
- Commit messages should include the edited path and optional issue reference,
  for example `Update workflow-templates/podcast.yaml (Refs #123)`.

Rollback and revert:

- Every portal edit must be a normal Git commit.
- Rollback uses Git revert, not manual database repair.
- The portal should expose recent knowledge commits and their validation status.
- Runtime template sync should keep old template versions available for
  existing task bundles.

## Knowledge Repository CI

The knowledge repository needs its own validation workflow.

Required checks:

- Markdown frontmatter validation and stable ID uniqueness.
- Document type validation.
- Internal link and image checks.
- Related document ID validation.
- Workflow-template YAML schema validation.
- Template task ID uniqueness.
- Template references to valid `instruction_doc_id` values.
- Prompt file validation for required metadata when prompt schemas are added.
- Search-index generation.
- Search handler smoke test against generated index.
- A data-safety scan that blocks obvious secrets and private artifact paths.

Docs push refresh model:

- A push to the knowledge repository runs validation and search-index
  generation.
- If validation passes on the configured branch, CI notifies the deployed
  DataOps app to refresh its knowledge cache.
- The refresh should use GitHub OIDC or a narrow GitHub App plus AWS permission
  path. It should not require redeploying Lambda app code.
- The DataOps app should record the loaded knowledge commit SHA and expose it
  in an admin/status endpoint.

## Issue Tracking Model

Use `DataTalksClub/dataops` as the primary issue tracker for the full DataOps
product and for implementation work.

Use `DataTalksClub/dataops-knowledge` issues only after the repository exists
for document-only backlog that does not require app/runtime changes.

Rules:

- App, runtime, sync, CI, deployment, and template-loader issues live in
  `dataops`.
- Knowledge-only edits may live in `dataops-knowledge`.
- Cross-repo work must link both issues.
- If a knowledge change requires runtime support, open or link the
  implementation issue in `dataops` and block the knowledge issue on it.
- The DataOps process pipeline remains the source of truth for shipping app
  behavior.

## Data Safety And Export Requirements

This boundary preserves the existing V1 data-safety model:

- Canonical process docs are Git-backed and reviewable.
- Canonical workflow templates are Git-backed and recoverable without DynamoDB.
- Runtime task/workflow state remains exportable separately from process docs.
- DynamoDB exports include runtime template records and template source commit
  metadata, not the canonical Git source itself.
- Private/generated operational data does not move into a public docs repo.
- Artifact binary backup is handled by S3 versioning, external system exports,
  or private artifact backups.
- Portable execution exports remain application-level JSON/JSONL archives with
  manifests, checksums, redaction rules, and relationship validation.

Before public migration, run an explicit data review over `content/`,
assistant knowledge files, examples, images, and templates. Anything with
private contacts, secrets, unreleased guest context, finance records, sponsor
confidential data, or generated guest-specific output must be redacted or left
outside the public repository.

## Follow-Up Implementation Issues

Create these after ADR acceptance:

1. Create `DataTalksClub/dataops-knowledge` with branch protection, ownership,
   visibility, and initial empty structure.
2. Add knowledge-repo schemas and CI for frontmatter, stable IDs, internal
   links, image checks, workflow-template validation, prompt validation, and
   search-index generation.
3. Run data-safety review for `content/`, `content/images/`, `content/prompts/`,
   `content/tasks/templates/`, and assistant knowledge/example paths.
4. Migrate `content/` process docs and safe images into the knowledge repo.
5. Convert `content/tasks/templates/*.md` to
   `workflow-templates/*.yaml` and generate any needed Markdown views.
6. Implement work-engine template loading/sync from Git-backed YAML with
   versioning and source commit tracking.
7. Add Lambda/portal configuration for reading from `dataops-knowledge`,
   including local development fallback.
8. Implement portal edit commits to the knowledge repository with branch,
   validation, authoring, and revert behavior.
9. Wire knowledge-repo CI to refresh the deployed portal cache/search index
   without app redeploy.
10. Classify and migrate reusable Podcast Assistant process knowledge,
    templates, prompts, and safe knowledge-base summaries.
11. Move Podcast Assistant generated/private outputs to private artifact
    storage and attach artifact metadata to workflow records.
12. Add admin/status visibility for loaded knowledge repo branch, commit SHA,
    index build time, and template sync version.

## Consequences

Positive:

- App code, process knowledge, runtime state, and private artifacts have clear
  ownership.
- DataTasks templates remain reviewable and recoverable in Git.
- Docs and template changes can eventually ship without app redeploys.
- The portal can keep a unified operator experience while the internals stay
  separated.

Tradeoffs:

- The split adds GitHub permission, cache refresh, and sync complexity.
- Portal edits need stricter validation and authoring rules.
- Template schema migrations need coordination between both repositories.
- The migration must wait until data review and sync infrastructure are ready.

## Non-Goals

This ADR does not:

- create the knowledge repository
- move files out of `dataops`
- implement sync code
- change Lambda runtime configuration
- change source repositories outside `dataops`
- migrate DynamoDB data or generated assistant outputs into Git
- decide every final folder name inside the future repo beyond the required
  boundary and target shape
