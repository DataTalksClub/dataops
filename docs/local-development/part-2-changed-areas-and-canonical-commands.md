> Part 2 of 3 of the [Local Development](../local-development.md)
> guide. [Part 1](part-1-environment-and-quick-start.md) covers the local
> environment and quick start; [Part 3](part-3-verification-handoff-and-ci.md)
> covers focused verification, handoff checks, and CI notes.

## Changed Area Matrix

| Changed area | Required local checks | Add when relevant |
| --- | --- | --- |
| `docs/**`, `docs/**`, `templates/**`, `content/tasks/templates/**`, `.goal-v1.md`, `PROJECT_PLAN.md`, `PORTAL_ANALYSIS.md`, or `README.md` | Docs link validation; planning docs validation; build the search index when task templates or content metadata are touched. | Docs app tests when registry/search behavior or metadata parsing can be affected. Process Curator review for operational usefulness. |
| `content/**` | Docs link validation; build the search index. | Docs app tests when frontmatter, document IDs, routing, registry behavior, templates, archive rules, or content shape changes. Process Curator review for operational usefulness. |
| `frontend/**` | Docs app tests for served portal behavior; focused browser/manual check of changed pages. | Screenshots for changed UI flows. Work-engine E2E if the UI crosses `/work/*` operator flows. |
| `backend/**` | Backend tests, typecheck, and build. | Search-index build for search/content behavior; SAM validation/build for dependency, packaging, or Lambda runtime changes; E2E for changed operator flows. |
| `assistants/podcast/**` | DataOps podcast assistant module pytest command. | `[HUMAN]` or opt-in integration checks for Telegram, Groq, live Heru, Codex, or Claude. |
| `.github/workflows/**` | Inspect changed workflow paths and commands; run the nearest local equivalent. | For deployment workflow changes, SAM validation. |
| `infra/template.full.yaml`, `infra/sam-build/**`, or `samconfig.toml` | SAM template validation. | `make sam-build` when package/build behavior changes. Production deploy remains CI/OIDC after `main` is pushed. |
| root `pyproject.toml` or `uv.lock` | `uv lock --check`; root import smoke check; relevant root pytest command. | Package-local lock checks and canonical Lambda/assistant/work-engine commands when proving boundaries for deployment-relevant metadata changes. |
| root `package.json` | Affected root wrapper command and underlying package-local command. | Work-engine tests/typecheck/build when wrappers target work-engine. |

## Canonical Commands

### Docs Portal, Lambda, And Frontend

Run planning/process docs validation from the repo root:

```bash
make validate-planning-docs
```

Underlying command:

```bash
uv run --with pytest python -m pytest tests/planning_docs
```

This check validates internal repo links, V1 goal/JTBD references, process
lifecycle guardrails, task-template metadata, doc registry references, and the
read-only planning-docs workflow. It intentionally ignores external URLs and
does not invoke stylint or prose-polish tooling.

Run content/process-doc link validation from the repo root:

```bash
make validate-docs-links
```

Underlying command:

```bash
uv run --project lambda-functions --extra search python -m lambda_functions.validate_docs_links \
  --repo-root . \
  --content-root content
```

This check validates document IDs, aliases, `related_docs`, wiki refs, `doc:`
refs, repo-local Markdown links and images, task-template docs, and work-engine
seed `sourceDocIds`/`instructionDocId` values. It ignores external URLs,
`mailto:` links, and anchor-only links. Heading-anchor validation is deferred:
links with `#anchor` still need an existing target file or document ID, but the
anchor text itself is not checked yet.

Run docs app tests from the repo root:

```bash
make test-docs
```

Underlying command:

```bash
uv run --project lambda-functions --extra search --with pytest python -m pytest tests/docs_app
```

Use this for changes under `lambda-functions/**`, served `frontend/**`
behavior, docs/search handlers, auth behavior, and portal routing.

Build the search index when `content/**`, content metadata, document IDs,
registry/search behavior, templates, archive rules, or search routing changes:

```bash
make search-index
```

Underlying command:

```bash
cd lambda-functions
uv run --extra search python -m lambda_functions.build_search_index \
  --docs-dir ../content \
  --output ../.tmp/dataops-content-search.index
```

The content validation workflow also smoke-tests a built index by loading it
through `lambda_functions.search_handler`. For local debugging of search
behavior, point `SEARCH_INDEX_PATH` at the file under `.tmp/`.

### Work-Engine

Run work-engine commands from the repo root:

```bash
make test-work-engine
make typecheck-work-engine
make build-work-engine
```

Underlying package-local commands:

```bash
npm --prefix work-engine test
npm --prefix work-engine run typecheck
npm --prefix work-engine run build
```

Run E2E tests when the change affects operator flows, browser UI, route
behavior, task lifecycle behavior, card behavior, exports, recurring tasks, or
end-to-end workflow behavior:

```bash
make test-work-engine-e2e
```

Underlying package-local command:

```bash
npm --prefix work-engine run test:e2e
```

Root wrappers are available for common work-engine checks:

```bash
npm run test:work-engine
npm run typecheck:work-engine
npm run build:work-engine
npm run dev:work-engine
npm run seed:work-engine
```

The package-local commands remain canonical because CI usually names them
directly.

The Makefile also exposes the local seed wrapper:

```bash
make seed-work-engine
```

### DataOps Podcast Assistant Module

Run safe local DataOps podcast assistant module tests from the repo root:

```bash
make test-assistant
```

Underlying command:

```bash
uv run --project assistants/podcast pytest
```

This is the default non-credentialed check for `assistants/podcast/**`.

Checks that require real Telegram delivery, Groq credentials, live Heru
execution, Codex, Claude, or other external accounts are opt-in only and must be
marked `[HUMAN]` in issue acceptance criteria. They are not required for normal
local verification or default CI.

At the time of this document, the deploy workflow path filters do not run for
`assistants/podcast/**`; use the local command above until assistant CI coverage
is added.

### Infrastructure And Deployment

Validate the SAM/CloudFormation template from `lambda-functions/`:

```bash
make sam-validate
```

This target is local validation only. It prepares empty AWS config and
credentials files under `.tmp/aws-empty/`, disables EC2 metadata lookup, defaults
`AWS_DEFAULT_REGION` to `eu-west-1`, and does not require live AWS credentials
or run `sam deploy`.

Underlying command shape:

```bash
cd lambda-functions && \
  AWS_CONFIG_FILE=../.tmp/aws-empty/config \
  AWS_SHARED_CREDENTIALS_FILE=../.tmp/aws-empty/credentials \
  AWS_EC2_METADATA_DISABLED=true \
  AWS_DEFAULT_REGION=eu-west-1 \
  sam validate --template-file template.full.yaml
```

When packaging or dependency behavior changes, also run the SAM build used by
the deployment workflow:

```bash
make sam-build
```

Underlying command (the repository root is passed to the tiny SAM CodeUri so
all six parallel function builds coordinate on one content-addressed bundle):

```bash
DATAOPS_REPO_ROOT="$PWD" sam build --parallel --config-env full-sandbox
```

Production deployment is not a normal local developer command. After approved
work is committed, merged locally to `main`, and pushed, GitHub Actions uses
OIDC to assume `arn:aws:iam::817685572750:role/dataops-github-actions-deploy`
and deploys the `dataops-v1` stack.

Local AWS deploys, live stack mutation, real cache refreshes, Telegram delivery,
OAuth flows, sponsor/client-facing messages, and destructive restore or
migration checks need explicit human approval and scoping.

