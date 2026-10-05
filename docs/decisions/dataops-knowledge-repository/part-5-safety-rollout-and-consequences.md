> Part 5 of 5 of the [DataOps Knowledge Repository Boundary
> ADR](../dataops-knowledge-repository.md): [Part 1](part-1-decision-and-boundaries.md)
> covers the decision and the repository boundaries,
> [Part 2](part-2-contents-and-workflow-templates.md) covers the repository
> target shape and workflow templates, [Part 3](part-3-assistant-boundary-and-migration.md)
> covers the assistant boundary and the migration inventory, and
> [Part 4](part-4-runtime-portal-and-ci.md) covers runtime, portal-edit, and
> CI integration.

## Data Safety And Export Requirements

This boundary preserves the existing V1 data-safety model:

- Canonical process docs are Git-backed and reviewable.
- Canonical workflow templates are Git-backed and recoverable without DynamoDB.
- Runtime task/workflow state remains exportable separately from process docs.
- DynamoDB exports include runtime template records and template source commit
  metadata, not the canonical Git source itself.
- Private/generated operational data does not move into the public app repo.
- Artifact binary backup is handled by S3 versioning, external system exports,
  or private artifact backups.
- The private knowledge repository is backed up daily to private S3 by a
  scheduled job that uploads only when the current commit differs from the
  latest backup manifest.
- Portable execution exports remain application-level JSON/JSONL archives with
  manifests, checksums, redaction rules, and relationship validation.

Before migration, run an explicit data review over `content/`, assistant
knowledge files, examples, images, and templates. The default destination is
the private knowledge repo. Anything copied back into the public app repo must
be sanitized and intentionally public-safe.

## Follow-Up Implementation Issues

Create these after ADR acceptance:

1. Create private `DataTalksClub/dataops-knowledge` with branch protection,
   ownership, visibility locked to private, and initial empty structure.
2. Add knowledge-repo schemas and CI for frontmatter, stable IDs, internal
   links, image checks, workflow-template validation, prompt validation, and
   search-index generation.
3. Add daily private S3 backup for the knowledge repo using GitHub Actions OIDC,
   a Git archive zip, a Git card, manifests, checksums, and skip-if-unchanged
   behavior based on the latest S3 manifest.
4. Run data-safety review for `content/`, `content/images/`, `content/prompts/`,
   `content/tasks/templates/`, and assistant knowledge/example paths.
5. Migrate `content/` process docs and safe images into the knowledge repo.
6. Convert `content/tasks/templates/*.md` to
   `workflow-templates/*.yaml` and generate any needed Markdown views.
7. Implement work-engine template loading/sync from Git-backed YAML with
   versioning and source commit tracking.
8. Add Lambda/portal configuration for reading from `dataops-knowledge`,
   including local development fallback.
9. Implement portal edit commits to the knowledge repository with branch,
   validation, authoring, and revert behavior.
10. Wire knowledge-repo CI to refresh the deployed portal cache/search index
   without app redeploy.
11. Classify and migrate reusable DataOps podcast assistant process knowledge,
    templates, prompts, and approved knowledge-base summaries.
12. Move DataOps podcast assistant generated/private outputs to private artifact
    storage and attach artifact metadata to workflow records.
13. Add admin/status visibility for loaded knowledge repo branch, commit SHA,
    index build time, and template sync version.

## Consequences

Positive:

- App code, process knowledge, runtime state, and private artifacts have clear
  ownership.
- DataOps workflow templates remain reviewable and recoverable in Git.
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
