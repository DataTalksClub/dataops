---
title: "Local Development"
summary: "How to run the DataOps portal and work-engine together for dashboard development."
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

## Two Services

The DataOps workspace has two runtime components in production:

1. **Portal** (Python Lambda) - serves the frontend, docs/search APIs, and
   brokers `/work/api/*` to the work-engine.
2. **Work engine** (TypeScript Lambda) - owns task, bundle, and notification
   state in DynamoDB.

For local development you run both together so the Operations Home dashboard
reads real data.

## Quick Start

### 1. Start the work-engine dev server

```bash
npm --prefix work-engine run dev
```

This starts the work-engine on `http://127.0.0.1:3000` with an in-memory
DynamoDB (dynalite) and seeded sample data. It serves the work-engine's own
dashboard UI and all `/api/*` endpoints.

### 2. Start the portal local server

```bash
cd lambda-functions
uv run --extra search python -m lambda_functions.local_server --port 8787
```

Set `WORK_ENGINE_DEV_URL` so the portal proxies `/work/api/*` to the
work-engine dev server:

```bash
WORK_ENGINE_DEV_URL=http://127.0.0.1:3000 \
  uv run --extra search python -m lambda_functions.local_server --port 8787
```

### 3. Open the portal frontend

The portal local server serves the API at `http://127.0.0.1:8787`. For the
frontend with hot reload, use any static server pointing at `frontend/`:

```bash
cd frontend
python3 -m http.server 5173
``+
Then open `http://127.0.0.1:5173/` and click **Operations home**.

## How the Proxy Works

When `WORK_ENGINE_DEV_URL` is set, the portal local server intercepts all
`/work/*` requests and proxies them to the work-engine dev server:

- `/work/api/tasks` -> `http://127.0.0.1:3000/api/tasks`
- `/work/api/bundles` -> `http://127.0.0.1:3000/api/bundles`
- `/work/health` -> `http://127.0.0.1:3000/api/health`

This mirrors the production broker path without requiring a deployed Lambda.

When `WORK_ENGINE_DEV_URL` is **not** set, `/work/api/*` requests return a
503 and the dashboard falls back to doc-based lanes.

## What to Test

The Operations Home dashboard should show live task cards when the work-engine
is running. Clicking a live task card opens the task action panel where you
can mark tasks done, manage follow-ups, and fill required links.

## Auth in Local Dev

The work-engine dev server runs with `IS_LOCAL=true`, which enables
`SKIP_AUTH`. The portal local server does not enforce session auth. In
production, the portal authenticates every `/work/api/*` request before
brokering it to the private work-engine Lambda.
