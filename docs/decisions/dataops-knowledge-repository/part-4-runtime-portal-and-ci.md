> Part 4 of 5 of the [DataOps Knowledge Repository Boundary
> ADR](../dataops-knowledge-repository.md): [Part 1](part-1-decision-and-boundaries.md)
> covers the decision and the repository boundaries,
> [Part 2](part-2-contents-and-workflow-templates.md) covers the repository
> target shape and workflow templates, [Part 3](part-3-assistant-boundary-and-migration.md)
> covers the assistant boundary and the migration inventory, and
> [Part 5](part-5-safety-rollout-and-consequences.md) covers data safety,
> follow-up issues, and consequences.

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
  existing task cards.

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
