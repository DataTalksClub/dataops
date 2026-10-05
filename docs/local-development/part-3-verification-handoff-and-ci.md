> Part 3 of 3 of the [Local Development](../local-development.md)
> guide. [Part 1](part-1-environment-and-quick-start.md) covers the local
> environment and quick start; [Part 2](part-2-changed-areas-and-canonical-commands.md)
> covers the changed-area matrix and canonical commands.

## Focused Verification By Work Type

For docs/content-only changes:

```bash
cd lambda-functions
uv run --extra search python -m lambda_functions.build_search_index \
  --docs-dir ../content \
  --output ../.tmp/dataops-content-search.index
```

Add docs app tests when metadata, routing, search behavior, document IDs,
templates, archive behavior, or content shape changes.

When workflow-critical frontmatter changes, add or run checks that prove the
migrated docs report `stable_id: true`, `id_source: frontmatter`, and resolve by
stable ID through the document registry. If a workflow source reference is
assistant-local or external, keep that exception explicit in code or docs rather
than letting it appear as an accidental missing registry record.

For docs portal backend/frontend changes:

```bash
uv run --project lambda-functions --extra search --with pytest python -m pytest tests/docs_app
```

Add search-index build when the change touches content or search behavior. Add
screenshots for changed portal UI pages or flows.

For work-engine changes:

```bash
npm --prefix work-engine test
npm --prefix work-engine run typecheck
npm --prefix work-engine run build
```

Add `npm --prefix work-engine run test:e2e` for changed operator flows, browser
UI, route behavior, or end-to-end task/workflow behavior.

For assistant/podcast changes:

```bash
uv run --project assistants/podcast pytest
```

For cross-system workflow changes that touch portal, content links, task state,
templates, and operator flows, run the docs app tests, search-index build,
work-engine unit/type/build checks, and the relevant work-engine E2E tests.

For infrastructure or deployment changes:

```bash
sam validate --template-file infra/template.full.yaml
```

Add `make sam-build` when Lambda packaging, build metadata,
dependencies, SAM resources, or workflow deploy behavior changes.

## Before Handoff Or Commit

For a narrow documentation/process-doc change:

```bash
git diff --check
```

Add search-index build when the change is under `content/**` or affects served
operational docs. Do not invoke user-facing prose tooling for internal process
docs unless Alexey asks for prose polish.

For common V1 product work that touches portal or workflow behavior:

```bash
git diff --check
uv run --project lambda-functions --extra search --with pytest python -m pytest tests/docs_app
cd lambda-functions
uv run --extra search python -m lambda_functions.build_search_index \
  --docs-dir ../content \
  --output ../.tmp/dataops-content-search.index
```

If the same work touches `work-engine/**`, add:

```bash
npm --prefix work-engine test
npm --prefix work-engine run typecheck
npm --prefix work-engine run build
```

If it changes operator browser flows, add:

```bash
npm --prefix work-engine run test:e2e
```

If it touches `assistants/podcast/**`, add:

```bash
uv run --project assistants/podcast pytest
```

If it touches SAM templates, deployment workflow, package/build behavior, or
production infrastructure, add:

```bash
cd lambda-functions
sam validate --template-file template.full.yaml
```

## CI And OIDC Notes

`.github/workflows/deploy-dataops-v1.yml` runs on pushes to `main` for
deployment-relevant app paths such as `content/**`, `frontend/**`,
`lambda-functions/**`, `scripts/**`, `tests/docs_app/**`, `work-engine/**`,
root `package.json`, root `pyproject.toml`, root `uv.lock`, and the workflow
itself. It runs docs app tests, work-engine tests and typecheck, search-index
build, a handler smoke test, SAM validation, SAM build, and then deploys through
GitHub Actions OIDC.

`.github/workflows/validate-dataops-content.yml` runs for `content/**` and the
workflow itself. The workflow also still has a `pull_request` trigger even
though merges go to `main` locally. It
builds and smoke-tests the search index. On push, if content changed, it uses
GitHub Actions OIDC to refresh the deployed docs cache.

After `main` is pushed, GitHub Actions deploys; check the run there if
something looks broken.

