# dataops-knowledge Migration Scaffold

This directory is a scaffold for the future `DataTalksClub/dataops-knowledge`
repository. It is not the live source for the DataOps portal, docs search,
work-engine templates, or portal edit commits.

For this migration slice, `content/` in `DataTalksClub/dataops` remains the
transitional canonical source. The files here define the target repository
shape, validation contract, and migration inventory that later issues can use
when the read, sync, edit, and refresh paths are ready.

Do not move or copy production SOPs, prompts, images, examples, generated
indexes, or workflow template content into this scaffold unless a later groomed
issue explicitly scopes that migration.

Validate the scaffold from the `dataops` repository root with:

```bash
uv run --project lambda-functions --extra search python -m lambda_functions.validate_knowledge_repo --repo-root . --scaffold-root templates/dataops-knowledge
```

Target top-level directories:

- `content/` - future operational SOPs, references, playbooks, and text
  templates after migration.
- `workflow-templates/` - future canonical YAML workflow template definitions.
- `assistant-prompts/` - future reviewed assistant prompts.
- `assistant-process/` - future reviewed assistant process instructions.
- `examples/` - future public-safe examples after data review.
- `images/` - future small documentation images after data review.
- `indexes/` - migration manifests and lightweight registries.
- `schemas/` - strict schemas for future knowledge repository files.
- `scripts/` - repository-local validation or migration scripts.
- `tests/` - repository-local tests and fixtures.
