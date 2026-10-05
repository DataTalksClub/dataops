> Part 3 of 5 of the [DataOps Knowledge Repository Boundary
> ADR](../dataops-knowledge-repository.md): [Part 1](part-1-decision-and-boundaries.md)
> covers the decision and the repository boundaries,
> [Part 2](part-2-contents-and-workflow-templates.md) covers the repository
> target shape and workflow templates, [Part 4](part-4-runtime-portal-and-ci.md)
> covers runtime, portal-edit, and CI integration, and
> [Part 5](part-5-safety-rollout-and-consequences.md) covers data safety,
> follow-up issues, and consequences.

## Assistant Boundary

`assistants/podcast/` remains the canonical product-code location for the
DataOps podcast assistant module in `dataops`.

Keep in `dataops`:

- Python assistant code and CLI entrypoints
- package metadata and lock files
- tests and integration-test harnesses
- search/build scripts that are part of the assistant implementation
- job creation, retry, resume, queue, progress, and DataOps integration code
- local `.env.example` and development documentation

Move or duplicate to private `dataops-knowledge` after review:

- reusable podcast process instructions from `assistants/podcast/process/`
- reusable guest-intake templates from `assistants/podcast/templates/`
- prompts and review checklists used to shape assistant behavior
- curated, approved knowledge-base summaries and taxonomies from
  `assistants/podcast/knowledge_base/`
- curated examples only when explicitly approved for private training/reference
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
| `content/` | Move after private-repo sync exists | `dataops-knowledge/content/` plus selected sibling folders | Treat existing public-repo content as migration debt. Audit before moving and leave only sanitized fixtures or generated public-safe views in `dataops`. |
| `content/tasks/templates/` | Convert then move | `dataops-knowledge/workflow-templates/*.yaml` | Current Markdown remains transitional only until private YAML sources exist. Generate Markdown views only if needed. |
| `content/images/` | Move after review | `dataops-knowledge/images/` or content-relative images | Keep SOP screenshots private by default. Copy public screenshots only after explicit review. |
| `content/prompts/` | Move after review | `dataops-knowledge/assistant-prompts/` or `content/prompts/` | Process prompts are private operational knowledge, not runtime code. |
| `content/indexes/` | Split | `dataops-knowledge/indexes/` for maintained registries; CI artifacts for generated search cards | Do not hand-edit generated search indexes. |
| `assistants/podcast/process/` | Move or duplicate after review | `dataops-knowledge/assistant-process/podcast/` | Reusable process knowledge. Code keeps references/config to load it. |
| `assistants/podcast/templates/` | Move or duplicate after review | `dataops-knowledge/assistant-process/podcast/` or `assistant-prompts/podcast/` | Guest-intake and reusable templates are knowledge. |
| `assistants/podcast/knowledge_base/` | Curate before moving | `dataops-knowledge/assistant-process/podcast/` or `examples/podcast/` | Only stable, reviewed, approved summaries/taxonomies move. Episode-specific or private artifact material stays external. |
| `assistants/podcast/data/` | Defer | App repo or generated artifact storage depending on file role | Decide after classifying source data versus generated indexes. |
| `assistants/podcast/podcast_examples/` | Keep out unless curated | External/private storage, or `dataops-knowledge/examples/podcast/` after approval | Current `.docx` examples look episode-specific and need data review. |
| `assistants/podcast/inbox/` | Keep outside Git | S3 or private runtime storage | Git should keep placeholders only during transition. |
| `assistants/podcast/documents/` | Keep outside Git | S3, Google Drive, or private artifact storage | Generated guest-specific docs are artifacts. |
| `work-engine/docs/templates.md` | Keep as reference until replaced | `dataops` docs or generated docs | Useful migration reference, not canonical executable source after YAML templates exist. |
| `docs/repository-structure-recommendation.md` | Keep | `dataops/docs/` | Background recommendation; this ADR is the durable decision. |
