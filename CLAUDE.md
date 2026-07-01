# Project Context

DataOps is the combined DataTalks.Club operations portal.

The portal will merge:

- DTC Operations process docs and docs app
- DataTasks task execution
- Podcast Assistant intake and drafting

## Working Process

Before issue work, read `_docs/PROCESS.md`.

Use GitHub Issues in `DataTalksClub/dataops`.

Follow the lifecycle:

```text
PM groom -> implement -> tester verify -> PM accept -> commit -> merge -> push -> on-call check
```

## Current Stage

The project is in the consolidation stage. Source systems have been merged into
a single TypeScript backend. See `_docs/TARGET_ARCHITECTURE.md`.

The single `backend/` package serves the frontend, docs content API, search,
and work APIs from one TypeScript Lambda. The Python docs/SOP backend has been
retired; its content-validation tooling lives in `tools/content_tools/`.

## Technology Direction

- Backend: TypeScript (single `backend/` package — supersedes the earlier
  "Long-term backend: Python" direction; see `_docs/MERGE_PLAN.md`)
- Search: `zerosearch-node` (BM25-lite, zero-dependency; supersedes `minsearch`)
- First frontend shell: existing `dtc-operations` vanilla JavaScript frontend
- Execution state: DynamoDB
- Process docs: GitHub markdown
- TypeScript transition package management: `npm`
- Python tooling (content validation, podcast assistant): `uv`
