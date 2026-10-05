> Part 1 of 5 of the [DataOps Knowledge Repository Boundary
> ADR](../dataops-knowledge-repository.md):
> [Part 2](part-2-contents-and-workflow-templates.md) covers the repository
> target shape and workflow templates, [Part 3](part-3-assistant-boundary-and-migration.md)
> covers the assistant boundary and the migration inventory,
> [Part 4](part-4-runtime-portal-and-ci.md) covers runtime, portal-edit, and
> CI integration, and [Part 5](part-5-safety-rollout-and-consequences.md)
> covers data safety, follow-up issues, and consequences.

## Status

Accepted for planning. Implementation is out of scope for this ADR.

## Context

DataOps V1 should feel like one workflow-first workspace for the operations
manager, but repository and storage ownership need clear boundaries.

Current state:

- `DataTalksClub/dataops` is the public product/runtime repository for
  `ops.dtcdev.click`.
- `content/` is the transitional Git home for imported SOPs, references,
  images, prompts, indexes, and task templates. Because this repository is
  public, existing operational content is public-sensitive migration debt until
  it is audited and moved behind the private knowledge boundary.
- `content/tasks/templates/` contains DataOps workflow templates that encode
  repeatable operational process.
- `assistants/podcast/` is the canonical in-repo DataOps podcast assistant
  module.
- Runtime workflow state is stored in DynamoDB execution tables managed by the
  deployed stack.
- Private or bulky files must remain outside the public app repository and
  outside private process Git unless explicitly approved as canonical knowledge.
- `../dtc-operations`, `../datatasks`, and `../podcast-assistant` are read-only
  source systems for DataOps migration work unless another issue explicitly
  scopes source-repo edits.

The main risk is mixing durable process knowledge, executable app code, mutable
runtime records, and private generated artifacts into one ownership model. That
would make review, restore, export, and future repo migration harder.

## Decision

Create a future canonical process repository named
`DataTalksClub/dataops-knowledge`.

Visibility: private by default. The app repository stays public, but the
operational knowledge repository must be private because DataOps SOPs,
workflow templates, assistant prompts/process instructions, screenshots,
private links, contact details, sponsor or finance context, and generated
operational materials may contain sensitive information. Public excerpts or
examples require an explicit data review and must be copied out as sanitized
fixtures or public-safe documentation, not treated as the canonical source.

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
- Private operational knowledge, outputs, and uploads should not enter the
  public app repository.

Do not split the repository immediately. Keep `content/` in `dataops` until the
app can read from the knowledge repository, validate it in CI, sync templates
into the work engine, refresh deployed content without app redeploy, and commit
portal edits to the correct repository.

## Repository Boundaries

| Boundary | Canonical home | Includes | Excludes |
|---|---|---|---|
| Product/runtime code | `DataTalksClub/dataops` public repo | Portal frontend, Lambda APIs, work-engine code, assistant service code, tests, app deployment, schemas, sanitized local development seeds, public-safe product architecture docs | Canonical private process repo after migration, raw operational docs/templates/prompts, private artifacts, long-lived runtime records |
| Process knowledge | `DataTalksClub/dataops-knowledge` private repo | SOPs, references, playbooks, communication templates, workflow templates, assistant prompts/process instructions, small doc images, validation schemas, lightweight generated indexes | Runtime task instances, audit events, assistant jobs, generated documents, raw recordings, invoices, DynamoDB exports |
| Shared infrastructure | `DataTalksClub/aws-infra` | Account-level OIDC, IAM, Route 53, certificates, shared buckets, shared deployment wrappers | App source, app-specific Lambda code, process content |
| Runtime execution state | DynamoDB tables owned by the `dataops-v1` stack | Tasks, cards, reminders, runtime templates loaded from Git, recurring configs, file metadata, artifact metadata, assistant job metadata, audit events | Canonical process docs and template source files |
| Private/bulky artifacts | S3, Dropbox, Google Drive, or equivalent private storage | Raw uploads, recordings, transcripts, invoices, receipts, guest-specific podcast drafts, generated assistant outputs, export cards | Public process knowledge, app code |
