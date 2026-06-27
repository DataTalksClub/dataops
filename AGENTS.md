# Agent Notes

Read `_docs/PROCESS.md` before working on issues.

When launching subagents for this workflow, use high-capability/high-reasoning
settings by default unless the user explicitly asks for a cheaper or lower
reasoning run.

Treat "continue where we stopped" as a prompt to check `_docs/PROCESS.md`,
inspect the current issue/worktree/process state, and resume the next pipeline
step.

This repo uses GitHub Issues in `DataTalksClub/dataops` as the work tracker.
The orchestrator files raw user requests as issues with `needs grooming`, then
role agents move each issue through the pipeline.

Current planning docs:

- `_docs/MERGE_PLAN.md`
- `_docs/PROCESS.md`
- `PORTAL_ANALYSIS.md`
- `PROJECT_PLAN.md`

Initial source systems:

- `../dtc-operations`
- `../datatasks`
- `../podcast-assistant`

Do not modify those source repos while working in `dataops` unless the issue
explicitly asks for it.
