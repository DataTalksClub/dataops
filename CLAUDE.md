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

The project is in the merge-planning and import stage.

The first implementation objective is to import the source systems while keeping
them runnable. The first end-to-end product slice is Podcast.

## Technology Direction

- Long-term backend: Python
- First frontend shell: existing `dtc-operations` vanilla JavaScript frontend
- Execution state: DynamoDB
- Process docs: GitHub markdown
- Search: existing `minsearch` path first
- Python package management: `uv`
- TypeScript transition package management: `npm`

