> Part 1 of 3 of the [Local Development](../local-development.md)
> guide. [Part 2](part-2-changed-areas-and-canonical-commands.md) covers the
> changed-area matrix and canonical commands; [Part 3](part-3-verification-handoff-and-ci.md)
> covers focused verification, handoff checks, and CI notes.

## Purpose

This is the top-level command plan for DataOps V1 development. Use it to choose
the smallest correct local verification command for a narrow change, and the
broader command set before commit or deployment-adjacent work.

The commands here are source-of-truth wrappers or package-local commands from:

- root `Makefile`
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
2. **Work engine** (TypeScript Lambda) - owns task, card, and notification
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

Initialize the persistent local DynamoDB schema and seed users, Git-authored
templates, and recurring operations:

```bash
npm --prefix backend run setup:local
```

This is the only supported table-creation entry point. Application and seed
commands assume their target tables already exist; production tables remain
owned by CloudFormation.

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
- `/work/api/cards` -> `http://127.0.0.1:3000/api/cards`
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

