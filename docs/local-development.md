---
title: "Local Development"
summary: "Developer command plan for local DataOps work."
doc_type: reference
tags:
  - development
  - local
  - backend
systems: []
related_docs:
  - docs/v1-runtime-architecture.md
---

# Local Development

## Runtime Shape

DataOps runs as a single TypeScript backend (`backend/`) that serves the static
`frontend/` shell, the docs content API, `zerosearch-node` search, and the work
execution APIs from one origin.

- **Backend**: `backend/` (TypeScript / Node Lambda)
- **Frontend**: `frontend/` (static vanilla JS)
- **CLI**: `cli/` (`dataops` CLI workspace)
- **Content validation helpers**: `tools/content_tools/` (stdlib-only Python
  helpers used by `scripts/validate_planning_docs.py`)

## Quick Start

Install root npm workspace dependencies:

```bash
make setup
```

Initialize the local DynamoDB schema and seed users, templates, and recurring
operations when needed:

```bash
npm --prefix backend run setup:local
```

Start the consolidated local portal (frontend + docs API + work APIs on
`http://127.0.0.1:3000`):

```bash
make dev
```

For the live-representative local portal with Vite hot reload, set
`DATAOPS_DEV_ACTOR_EMAIL` in the ignored root `.env` and run:

```bash
scripts/dev/run-home-vite.sh
```

## Canonical Verification Commands

Run `make help` from the repository root to list all targets:

| Area | Command | Underlying command |
| --- | --- | --- |
| Planning / repo-meta docs | `make validate-planning-docs` | `uv run --with pytest python -m pytest tests/planning_docs` |
| Docs links & registry | `npm --prefix backend run validate:docs-links -- --content-root ../dataops-knowledge/content` | `npx --prefix backend tsx backend/scripts/validate-docs-links.ts` |
| SOP format lint | `make sop-lint FILES="path/to/sop.md"` | `npx --prefix backend tsx backend/scripts/sop.ts lint ...` |
| Search index build | `npm --prefix backend run build:search-index -- --content-dir ../content --output ../.tmp/dataops-content-search.index` | `backend/scripts/build-search-index.ts` |
| Frontend unit tests | `make test-frontend-unit` | `npm run test:frontend:unit` |
| Frontend coverage | `make test-frontend-coverage` | `npm run test:frontend:coverage` |
| Backend unit tests | `make test-backend` | `npm --prefix backend test` |
| Backend DDB transactions | `make test-backend-transactions` | `npm run test:backend:transactions` |
| Backend typecheck & build | `make typecheck-backend && make build-backend` | `npm --prefix backend run typecheck && npm --prefix backend run build` |
| Backend Playwright E2E | `make test-backend-e2e` | `npm --prefix backend run test:e2e` |
| CLI unit & E2E tests | `make test-cli && make test-cli-e2e` | `npm run test:cli && npm run test:e2e --workspace dataops-cli` |
| SAM template validation | `make sam-validate` | `sam validate --template-file infra/template.full.yaml` (with empty local AWS config) |
| SAM build & checks | `make sam-build && make verify-sam-frontend && make verify-sam-runtime-boundary` | `sam build --parallel --config-env full-sandbox` |
| Full local CI parity | `make ci` | Runs frontend, backend, CLI, typecheck, build, and SAM checks |

## CI Workflows

- `.github/workflows/deploy-dataops-v1.yml` — runs frontend, backend, CLI, and
  SAM build/isolation checks, then deploys `dataops-v1` via GitHub Actions OIDC
  on pushes to `main`.
- `.github/workflows/validate-dataops-content.yml` — validates docs links and
  builds/smoke-tests the `zerosearch-node` search index against
  `DataTalksClub/dataops-knowledge`.
- `.github/workflows/validate-planning-docs.yml` — runs read-only planning docs
  and infrastructure contract checks (`tests/planning_docs`, `tests/infra`, and
  `validate:docs-links`).
