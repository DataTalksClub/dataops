---
title: "Local Development"
summary: "Developer command plan for local DataOps V1 work and role-agent handoff."
doc_type: reference
tags:
  - development
  - local
  - work-engine
systems: []
related_docs:
  - docs/v1-runtime-architecture.md
---

# Local Development

## Purpose

This is the top-level command plan for DataOps V1 development. Use it to choose
the smallest correct local verification command for a narrow change, and the
broader command set before role-agent handoff, commit, or deployment-adjacent
work.

The commands here are source-of-truth wrappers or package-local commands from:

- root `Makefile`
- `_docs/PROCESS.md`
- root `package.json`
- `work-engine/package.json`
- `assistants/podcast/pyproject.toml`
- `lambda-functions/Makefile`
- `.github/workflows/deploy-dataops-v1.yml`
- `.github/workflows/validate-dataops-content.yml`

Internal process docs do not require user-facing prose tooling or stylint-style
review unless Alexey explicitly asks for prose polish.

The root Makefile is the preferred discoverable entry point:

```bash
make help
```

The package-local commands in this document remain canonical for debugging when
a Make target fails or an issue asks for the underlying command explicitly.

## Runtime Shape

The DataOps workspace has two runtime components in production:

1. **Portal** (Python Lambda) - serves the frontend, docs/search APIs, and
   brokers `/work/api/*` to the work-engine.
2. **Work engine** (TypeScript Lambda) - owns task, bundle, and notification
   state in DynamoDB.

For local development you run both together so the Operations Home dashboard
reads real data.

## Python Project Boundaries

The root `pyproject.toml` is the repository coordination project. It owns
dependencies for checked-in root scripts under `scripts/` and root developer
checks such as `tests/test_import_sources.py`.

```bash
uv lock --check
uv run python -c "import httpx, openpyxl, PIL, slugify, uvicorn"
uv run python -m pytest tests/test_import_sources.py
```

It does not package the Lambda or assistant modules and it does not manage Node
dependencies. Keep package-local commands package-local:

- Lambda/docs portal: `uv run --project lambda-functions ...`
- Podcast assistant: `uv run --project assistants/podcast ...`
- Work-engine: `npm --prefix work-engine ...`

External command-line tools used by some scripts remain external prerequisites:
`pandoc` for process conversion, `git` for import and migration scripts,
`aws`/`make` for local deploy helpers, and SAM/Docker/npm where those workflows
call them. Do not add production credentials or external service secrets to
Python metadata.

## Quick Start

Install local dependencies:

```bash
make setup
```

### 1. Start the work-engine dev server

```bash
make dev-work-engine
```

This starts the work-engine on `http://127.0.0.1:3000` with an in-memory
DynamoDB (dynalite) and seeded sample data. It serves the work-engine's own
dashboard UI and all `/api/*` endpoints.

### 2. Start the portal local server

```bash
make dev-docs
```

Set `WORK_ENGINE_DEV_URL` so the portal proxies `/work/api/*` to the
work-engine dev server:

```bash
WORK_ENGINE_DEV_URL=http://127.0.0.1:3000 make dev-docs
```

Run `make dev-work-engine` and the proxied `make dev-docs` command in separate
terminals. Both targets run in the foreground and stop with Ctrl-C.

### 3. Open the portal frontend

The portal local server serves the API at `http://127.0.0.1:8787`. For the
frontend with hot reload, use any static server pointing at `frontend/`:

```bash
make dev-frontend
```

Then open `http://127.0.0.1:5173/` and click **Operations home**.

## How the Proxy Works

When `WORK_ENGINE_DEV_URL` is set, the portal local server intercepts all
`/work/*` requests and proxies them to the work-engine dev server:

- `/work/api/tasks` -> `http://127.0.0.1:3000/api/tasks`
- `/work/api/bundles` -> `http://127.0.0.1:3000/api/bundles`
- `/work/health` -> `http://127.0.0.1:3000/api/health`

This mirrors the production broker path without requiring a deployed Lambda.
It is still a local-only HTTP proxy. In production, `/work/api/*` is handled by
the authenticated Python portal, rewritten to `/api/*`, and invoked against the
private `WorkEngineFunction` Lambda with the portal broker headers and shared
Secrets Manager secret.

When `WORK_ENGINE_DEV_URL` is not set, `/work/api/*` requests return a 503 and
the dashboard falls back to doc-based lanes.

## Auth In Local Dev

The work-engine dev server runs with `IS_LOCAL=true`, which enables `SKIP_AUTH`.
The portal local server does not enforce session auth. These bypasses are only
for local development and tests.

`IS_LOCAL=true` also enables local filesystem file storage for uploads and
local-dev artifact paths. Production work-engine runs must not use Lambda local
disk as durable file or artifact storage. Production file uploads are rejected
until a durable storage adapter is configured, and artifact records should use
stable `s3://`, Dropbox, Google Drive, GitHub, or public/external URLs rather
than temporary signed URLs.

Production uses the shared Cognito browser flow at `auth.dtcdev.click` through
`/login`, `/auth/callback`, and `/logout`. The browser receives only the opaque,
HTTP-only `dataops_session` cookie; OAuth transaction data and sessions remain
server-side. Callback failures redirect before rendering to the clean
`/auth/error` route, which is non-cacheable and sends a no-referrer policy; the
authorization code and state therefore do not remain in the rendered page URL.
Post-login return paths are canonicalized against the exact configured callback
origin. The frontend calls same-origin `/work/api/*` without a standalone password
form or a localStorage bearer token. Existing non-browser bearer sessions remain
available to dedicated clients and are validated independently.

## Changed Area Matrix

| Changed area | Required local checks | Add when relevant |
| --- | --- | --- |
| `_docs/**`, `docs/**`, `templates/**`, `content/tasks/templates/**`, `.goal-v1.md`, `PROJECT_PLAN.md`, `PORTAL_ANALYSIS.md`, or `README.md` | Docs link validation; planning docs validation; build the search index when task templates or content metadata are touched. | Docs app tests when registry/search behavior or metadata parsing can be affected. Process Curator review for operational usefulness. |
| `content/**` | Docs link validation; build the search index. | Docs app tests when frontmatter, document IDs, routing, registry behavior, templates, archive rules, or content shape changes. Process Curator review for operational usefulness. |
| `frontend/**` | Docs app tests for served portal behavior; focused browser/manual check of changed pages. | Screenshots for changed UI flows. Work-engine E2E if the UI crosses `/work/*` operator flows. |
| `lambda-functions/**` | Docs app tests. | Search-index build for search/content behavior. SAM validation for template, dependency, packaging, or Lambda runtime changes. |
| `work-engine/**` | Unit tests, typecheck, and build. | E2E for changed operator flows, browser UI, route behavior, or end-to-end task/workflow behavior. |
| `assistants/podcast/**` | DataOps podcast assistant module pytest command. | `[HUMAN]` or opt-in integration checks for Telegram, Groq, live Heru, Codex, or Claude. |
| `.github/workflows/**` | Inspect changed workflow paths and commands; run the nearest local equivalent. | For deployment workflow changes, SAM validation and a clear On-Call follow-up after push. |
| `lambda-functions/template*.yaml` or `samconfig.toml` | SAM template validation. | `sam build --config-env full-sandbox` when package/build behavior changes. Production deploy remains CI/OIDC after `main` is pushed. |
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
behavior, task lifecycle behavior, bundle behavior, exports, recurring tasks, or
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

The package-local commands remain canonical because CI and role-agent issue
specs usually name them directly.

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

Underlying command:

```bash
cd lambda-functions && sam build --config-env full-sandbox
```

Production deployment is not a normal local developer command. After approved
work is committed, merged locally to `main`, and pushed, GitHub Actions uses
OIDC to assume `arn:aws:iam::817685572750:role/dataops-github-actions-deploy`
and deploys the `dataops-v1` stack.

Local AWS deploys, live stack mutation, real cache refreshes, Telegram delivery,
OAuth flows, sponsor/client-facing messages, and destructive restore or
migration checks are `[HUMAN]` unless a groomed issue explicitly scopes them.

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
cd lambda-functions
sam validate --template-file template.full.yaml
```

Add `sam build --config-env full-sandbox` when Lambda packaging, build metadata,
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
workflow itself. The workflow also still has a `pull_request` trigger, although
the DataOps process uses local merges to `main` rather than GitHub PRs. It
builds and smoke-tests the search index. On push, if content changed, it uses
GitHub Actions OIDC to refresh the deployed docs cache.

On-Call Engineer owns CI/CD monitoring after `main` is pushed. The orchestrator
should launch On-Call rather than manually watching GitHub Actions.
