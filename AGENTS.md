# Agent Notes

## Project Context

DataOps is the combined DataTalks.Club operations portal, merging DTC Operations
process docs and docs app, DataTasks task execution, and Podcast Assistant
intake and drafting.

The project is in the consolidation stage. Source systems have been merged into
a single TypeScript backend; see `docs/TARGET_ARCHITECTURE.md`. The single
`backend/` package serves the frontend, docs content API, search, and work APIs
from one TypeScript Lambda. The Python docs/SOP backend has been retired; the
remaining content-validation tooling lives in `tools/content_tools/`.

Domain vocabulary: a **Template** is a reusable definition, a **Card** is one
instantiated unit of work created from a template, and a **Task** is a checklist
item contained by a card.

Technology direction:

- Backend: TypeScript, single `backend/` package (supersedes the earlier
  "long-term backend: Python" direction; see `docs/MERGE_PLAN.md`)
- Search: `zerosearch-node` (BM25-lite, zero-dependency; supersedes `minsearch`)
- Frontend shell: the existing `dtc-operations` vanilla JavaScript frontend
- Execution state: DynamoDB
- Process docs: GitHub markdown
- Package management: `npm` for TypeScript, `uv` for Python tooling
  (content validation, podcast assistant)

## Working Process

Read `docs/PROCESS.md` before working on issues.

Follow the lifecycle:

```text
PM groom -> implement -> tester verify -> PM accept -> commit -> merge -> push -> on-call check
```

When launching subagents for this workflow, use high-capability/high-reasoning
settings by default unless the user explicitly asks for a cheaper or lower
reasoning run.

Treat "continue where we stopped" as a prompt to check `docs/PROCESS.md`,
inspect the current issue/worktree/process state, and resume the next pipeline
step.

Interpret requests for a "todo list widget", "todo widget", or similar wording
as a request to show or update the agent's in-chat task/plan widget. Do not file
a product issue or implement repository UI for such a request unless the user
explicitly names a product surface or asks for application code.

Commit regularly and always:

- Commit working increments as you go rather than leaving a large uncommitted
  tree at the end of a session. A passing checkpoint is worth committing.
- Commit your own work even when another session is working in the same tree;
  stage your paths explicitly instead of `git add -A`, and never commit another
  session's staged index as if it were yours.
- Finish a task with the work committed, not just described.

No backwards compatibility:

- This project has no external consumers and no released API to protect. When
  something is renamed, restructured, or replaced, change it everywhere in one
  step and delete the old shape.
- Do not add compatibility shims, aliases, legacy fallbacks, duplicate routes,
  deprecated fields kept "just in case", dual-read/dual-write paths, or version
  branches that keep old behavior alive alongside new behavior.
- Migrate persisted data as part of the change rather than teaching the code to
  read both the old and the new format.
- If a change cannot be made atomically, say so and propose the sequencing
  instead of leaving a permanent compatibility layer behind.

This repo uses GitHub Issues in `DataTalksClub/dataops` as the work tracker.
The orchestrator files raw user requests as issues with `needs grooming`, then
role agents move each issue through the pipeline.

Operational knowledge boundary:

- `DataTalksClub/dataops` stays public and owns product/runtime code, CI/CD,
  tests, schemas, sanitized fixtures, and public-safe planning docs.
- Operational documents and knowledge belong in a separate private repository.
  The planned repo name is `DataTalksClub/dataops-knowledge`.
- Do not add raw SOPs, workflow templates, assistant prompts/process
  instructions, screenshots, private links, credentials-adjacent setup notes,
  contact details, sponsor or finance context, or generated operational
  artifacts to this public repo.
- Existing `content/` material in this repo is transitional migration debt.
  Treat it as public-sensitive until it is audited and moved behind the private
  knowledge boundary.

Current planning docs:

- `docs/MERGE_PLAN.md`
- `docs/PROCESS.md`
- `PORTAL_ANALYSIS.md`
- `PROJECT_PLAN.md`

AWS infrastructure source:

- **Infrastructure lives in `../aws-infra/`, not in this repo.** DataOps-specific
  infrastructure is in `../aws-infra/sandbox/dataops/`. Edit it there and commit
  it there; do not add or copy infrastructure templates into this repo.
- That directory owns the GitHub Actions OIDC deploy role
  (`template.github-actions.yaml`), the CloudFront domain
  (`template.domain.yaml`), the runtime secrets
  (`template.runtime-secrets.yaml`), and the knowledge backups bucket
  (`template.knowledge-backups.yaml`).
- The one exception is `infra/template.full.yaml`, the application stack. Its
  tiny `infra/sam-build/` CodeUri delegates to the repository packaging script,
  so the template has to sit next to the code it packages. Moving it requires
  changing how the Lambda artifact is produced, not just moving a file.
- Keeping a second copy of an aws-infra template here is what caused the two to
  drift apart. If a template needs changing, change it in `aws-infra`.
- `aws-infra` does not currently deploy itself through CI/CD. If that template
  changes, committing/pushing it is not enough; a credentialed AWS operator must
  apply the `dataops-github-actions` CloudFormation stack.
- The DataOps app itself deploys through this repo's GitHub Actions CI/CD using
  OIDC after `main` is pushed. Do not replace that with a normal manual app
  deploy.

The application never creates infrastructure:

- Tables, buckets, queues and secrets are declared in infrastructure. Nothing in
  `backend/src` creates or mutates them, and no environment variable enables it.
  If a resource is missing the code fails loudly and names it, rather than
  quietly creating one that nothing manages or backs up.
- Local development and tests may stand up throwaway local resources, but that
  belongs in a setup script, not in code that ships to the Lambda.
- DynamoDB allows only one global secondary index created or deleted per stack
  update, so an index rename cannot ride a normal deploy. Do index changes as an
  offline operation and let the template declare the end state; do not build
  migration machinery into the deploy pipeline, where it outlives the migration
  and rots. While data is disposable, replace the table instead. See
  `docs/dynamodb-index-changes.md`.
- A migration that has run, and a guard for a migration that has finished, are
  dead code. Delete them.

Initial source systems:

- `../dtc-operations`
- `../datatasks`
- `../podcast-assistant`

Do not modify those source repos while working in `dataops` unless the issue
explicitly asks for it.
