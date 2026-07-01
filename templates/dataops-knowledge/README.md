# dataops-knowledge Migration Scaffold

This directory is a scaffold for the future private
`DataTalksClub/dataops-knowledge` repository. It is not the live source for the
DataOps portal, docs search, backend templates, or portal edit commits.

For this migration slice, `content/` in public `DataTalksClub/dataops` remains
transitional migration debt. The files here define the target private
repository shape, validation contract, backup model, and migration inventory
that later issues can use when the read, sync, edit, and refresh paths are
ready.

Do not move or copy production SOPs, prompts, images, examples, generated
indexes, or workflow template content into this scaffold unless a later groomed
issue explicitly scopes that migration.

Validate the scaffold from the `dataops` repository root with:

```bash
uv run --project tools/content_tools python -m content_tools.validate_knowledge_repo --repo-root . --scaffold-root templates/dataops-knowledge
```

Target top-level directories:

- `content/` - future operational SOPs, references, playbooks, and text
  templates after migration.
- `workflow-templates/` - future canonical YAML workflow template definitions.
- `assistant-prompts/` - future reviewed assistant prompts.
- `assistant-process/` - future reviewed assistant process instructions.
- `examples/` - future reviewed examples after data review.
- `images/` - future small documentation images after data review.
- `indexes/` - migration manifests and lightweight registries.
- `schemas/` - strict schemas for future knowledge repository files.
- `scripts/` - repository-local validation, migration, or backup scripts.
- `tests/` - repository-local tests and fixtures.

## S3 Backups

The scaffold includes `.github/workflows/backup-to-s3.yml` and
`scripts/backup_to_s3.py` for the future private repository.

The intended model:

- private GitHub remains canonical for SOPs, templates, prompts, and workflow
  definitions;
- private S3 stores daily backup archives;
- the backup job compares the current commit SHA to
  `s3://$DATAOPS_KNOWLEDGE_BACKUP_BUCKET/$DATAOPS_KNOWLEDGE_BACKUP_PREFIX/latest/manifest.json`;
- if the SHA matches, the job exits without uploading;
- if the SHA changed, the job uploads a Git archive zip, a full Git bundle, a
  manifest, and checksums.

Required repository variables in the private knowledge repo:

- `DATAOPS_KNOWLEDGE_BACKUP_ROLE_ARN`
- `DATAOPS_KNOWLEDGE_BACKUP_BUCKET`
- `DATAOPS_KNOWLEDGE_BACKUP_PREFIX`, optional, default `dataops-knowledge`
- `AWS_REGION`, optional, default `eu-west-1`

The AWS role should be assumable through GitHub Actions OIDC and should have
reasonable S3 permissions for the backup bucket/prefix: `s3:GetObject` for the
latest manifest, `s3:PutObject` for daily and latest backup objects, and
`s3:ListBucket` scoped to the configured prefix when needed for restore or
audit tooling.

Example resource scope:

```text
arn:aws:s3:::<backup-bucket>
arn:aws:s3:::<backup-bucket>/<prefix>/*
```

Restore options:

- inspect files by downloading the latest zip archive;
- restore full Git history with `git clone dataops-knowledge-<sha>.bundle`;
- verify downloaded objects against `checksums.sha256` and `manifest.json`.
