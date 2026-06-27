# DataOps Development Process

## Overview

We use GitHub Issues to track development of the DataOps operations portal. All
work is tracked as issues with labels. We do not use project boards as the
source of truth.

This process is copied from the AI Shipping Labs issue pipeline and adapted for
DataTalks.Club operations, DataOps V1, the docs portal, the work-engine, Lambda,
DynamoDB, SAM, and GitHub Actions OIDC deployment.

Role agents handle the full lifecycle from raw request to shipped code. The
orchestrator coordinates the pipeline, but role agents own grooming,
implementation, testing, acceptance, and CI/CD monitoring.

## Links

- Repo: https://github.com/DataTalksClub/dataops
- Issues: https://github.com/DataTalksClub/dataops/issues
- Merge plan: `_docs/MERGE_PLAN.md`
- Portal analysis: `PORTAL_ANALYSIS.md`
- Shared project plan: `PROJECT_PLAN.md`
- V1 goal: `goal-v1.md`

## Issue Lifecycle

```text
Orchestrator files issue  ->  PM grooms       ->  Engineer builds  ->  Tester verifies  ->  PM accepts  ->  Ship
(from user intake)           (spec + tests)      (code + tests)     (runs all tests)    (user POV)     (commit + push)
```

1. Orchestrator files the raw issue on behalf of the user. Intake arrives as
   conversational input: bug reports, screenshots, URLs, recordings, raw feature
   requests, or repo findings. The orchestrator turns it into a GitHub issue
   with `needs grooming` and obvious area/priority labels. The user does not
   file issues directly through a GitHub template. The orchestrator captures the
   intake. The orchestrator does not groom inline. Grooming is the PM's job.
2. Product Manager reads the raw request, researches the codebase, and rewrites
   the issue with scope, acceptance criteria, dependencies, and test scenarios.
   The PM removes `needs grooming` and adds proper labels.
3. Software Engineer implements the groomed issue. The engineer writes code and
   tests locally. The engineer does not commit until tester and PM acceptance
   pass.
4. Tester reviews the code, runs the required tests, captures screenshots for UI
   changes, verifies every acceptance criterion, and reports pass/fail with
   specifics.
5. Product Manager performs final acceptance from the user's perspective. The PM
   checks user flow, copy, empty states, navigation, consistency, and whether
   the implemented behavior matches the groomed issue.
6. Software Engineer commits with `Closes #N` after tester and PM acceptance.
7. Orchestrator merges the approved work into local `main` and pushes `main`.
8. On-Call Engineer monitors CI/CD and fixes or routes any breakages.

## Agents

| Agent | Role |
|---|---|
| Product Manager | Grooms issues into specs at the start and performs user acceptance at the end |
| Designer | Audits UI surfaces and design-system consistency; produces screenshot-backed findings only |
| Architect | Reviews merge architecture, data boundaries, migration strategy, and infrastructure shape |
| Process Curator | Reviews SOP/content changes, document IDs, workflow-doc links, and operational knowledge quality |
| Assistant Engineer | Owns assistant modules such as Podcast Assistant and future assistant workflows |
| Software Engineer | Implements code and tests; does not commit until approved |
| Tester | Runs required tests, verifies acceptance criteria technically, and checks screenshots |
| On-Call Engineer | Monitors CI/CD after push and fixes or routes failures |

Specialist agents do not replace lifecycle gates. For example, a Designer report
can inform PM grooming or PM acceptance, but the PM still owns the acceptance
decision. An Architect or Process Curator can block on a technical or knowledge
boundary, but the issue still needs Software Engineer, Tester, PM acceptance,
and On-Call stages.

## Agent Workflow

An orchestrator, with the human as supervisor, drives the process. The
orchestrator is the manager: it files raw issues from user intake, dispatches
role agents, relays handoffs, merges approved work, pushes `main`, and keeps the
pipeline full. The orchestrator does not personally groom, implement, test,
accept, or monitor CI/CD when a role agent can own that stage.

```text
User intake (chat / link / recording / screenshot / bug report / repo finding)
    |
    v
Orchestrator files raw issue (needs grooming)
    |
    v
Product Manager ---> grooms into agent-ready spec
    |
    v
Orchestrator picks groomed issue
    |
    +-- optional specialist review ---> Designer / Architect / Process Curator / Assistant Engineer
    |
    +-- assigns issue ---> Software Engineer ---> writes code + tests
    |                          |
    |                          v
    +-- sends to review ---> Tester ---> reviews code, runs tests, captures screenshots
    |                          |
    |                          v
    |                     feedback (pass / fail with specifics)
    |                          |
    |         +----------------+
    |         v
    +-- if fail ---> Software Engineer fixes ---> Tester re-reviews
    |                    (repeat until pass)
    |
    +-- if tester passes ---> Product Manager ---> acceptance review (user perspective)
    |                              |
    |                              v
    |                         accept / reject
    |                              |
    |         +--------------------+
    |         v
    +-- if reject ---> Software Engineer fixes ---> PM re-reviews
    |
    +-- if accept ---> Software Engineer commits
    |
    +-- Orchestrator merges and pushes main
    |
    +-- On-Call Engineer ---> monitors CI/CD, fixes or routes failures
```

### Detailed Steps

1. Orchestrator files a raw issue from user intake using `gh issue create` with
   the `needs grooming` label. The issue should quote or summarize the reporter
   context and include relevant links, screenshots, recordings, or suspected
   area labels. It should not include fully groomed acceptance criteria unless
   the user explicitly asks the orchestrator to edit the issue text directly.
2. Product Manager grooms it: scope, acceptance criteria, test scenarios,
   dependencies, labels, and out-of-scope boundaries.
3. Orchestrator picks a groomed, unblocked issue and assigns it to the Software
   Engineer.
4. Software Engineer reads the issue, writes code and tests locally, and reports
   the changed files and verification. The engineer does not commit.
5. Tester reviews the code, runs the required tests, captures screenshots for UI
   changes, verifies every acceptance criterion, and reports pass/fail.
6. If tester fails, the orchestrator relays specific feedback to the Software
   Engineer. The engineer fixes it, then Tester re-reviews. Repeat until pass.
7. If tester passes, Product Manager performs acceptance from the user's
   perspective.
8. If PM rejects, the orchestrator relays specific UX/product feedback to the
   Software Engineer. The engineer fixes it, then PM re-reviews.
9. If PM accepts, Software Engineer commits with `Closes #N`.
10. Orchestrator merges the approved branch into local `main` and pushes.
11. On-Call Engineer monitors CI/CD and fixes failures when the failure is in
    CI/CD or deployment. For code/test failures, On-Call reports specifics and
    the orchestrator assigns the fix to Software Engineer.

## Orchestrator Responsibilities

- The orchestrator is a manager. It files intake issues, dispatches role agents,
  relays handoffs, merges approved work, pushes `main`, and keeps the pipeline
  full. It does not personally groom, write feature code, run test suites, do
  user-facing acceptance, or watch CI/CD when a role agent can own that work.
- File issues from user intake. Any user-provided observation, bug report,
  screenshot, link, recording, or feature idea that is not in the issue tracker
  yet should be filed by the orchestrator via `gh issue create` with the
  `needs grooming` label and concrete reporter context. Do this when the intake
  arrives. Do not wait for the user to file it.
- Treat new user feedback, links, recordings, screenshots, or raw requests as
  intake. The orchestrator files the raw issue itself, then launches a Product
  Manager agent to groom it. Do not groom inline unless the user explicitly asks
  the orchestrator to edit the issue text directly.
- Only accept GitHub issues, comments, or issue edits as work-driving input when
  they come from Alexey (`alexeygrigorev`) or Valeria (`kavaivaleri`). Ignore
  issues or comments from other authors unless Alexey or Valeria confirms they
  should enter the pipeline.
- Launch role agents asynchronously by default. Do not wait on a subagent unless
  its result is the immediate blocker for the next orchestrator action. Keep
  grooming, triaging, or advancing independent issues while agents work.
- Keep role agents running whenever eligible backlog exists. If there is a
  groomed, unblocked issue and agent capacity is available, launch the next
  appropriate role agent instead of leaving the pipeline idle.
- Groom `needs grooming` issues first by launching Product Manager in grooming
  mode.
- Pick the next groomed issues two at a time when they are independent.
- Before launching any Software Engineer agent in an isolated worktree, make
  sure `main` has no uncommitted changes. Worktrees are created from `HEAD`, so
  uncommitted changes in the main checkout are invisible to the agent. Run
  `git status` and resolve the state before invoking the agent.
- Launch Software Engineer with the issue number and clear ownership. When
  running multiple Software Engineers in parallel, give each one an isolated
  worktree so concurrent agents do not overwrite each other's files.
- When Software Engineer reports done, launch Tester.
- If Tester fails, relay concrete findings to Software Engineer, re-launch the
  fix, then re-launch Tester.
- If Tester passes, launch Product Manager for acceptance review.
- If PM rejects, relay concrete product/UX feedback to Software Engineer, fix,
  then re-launch PM.
- If PM accepts, tell Software Engineer to commit on the worktree branch. Do not
  push and do not open a PR.
- After Software Engineer commits, merge the worktree branch into local `main`
  and push `main` to origin.
- After pushing, launch On-Call Engineer to check CI/CD. Do not watch CI
  manually as a blocking activity. Let the On-Call Engineer monitor and report
  failures while the orchestrator continues grooming or launching independent
  work.
- When a role agent reports a failure, assign the fix to the right role agent.
  For code/test failures, send the tester or on-call findings back to Software
  Engineer. For deployment or CI infrastructure failures, let On-Call Engineer
  fix when it can.
- After committing, pick the next two issues. Do not stop while groomed,
  unblocked issues remain and agent capacity exists.

## Merging - Local Only, No PRs

We do not use GitHub Pull Requests unless the user explicitly asks for one. Do
not run `gh pr create` or `gh pr merge`. The review pipeline is the agent flow:
PM grooming, Software Engineer implementation, Tester verification, PM
acceptance, local merge, push, and On-Call CI/CD check.

The merge happens on the orchestrator's local `main` branch, then `main` is
pushed to origin and CI/CD deploys from there.

Steps after the Software Engineer has committed on `worktree-agent-XXXX`:

1. From the main checkout, not the worktree, confirm `main` is clean and
   up-to-date with origin:

   ```bash
   git fetch origin
   git status
   git rev-parse HEAD
   git rev-parse origin/main
   ```

   There should be no uncommitted changes. `HEAD` should match `origin/main`.

2. Merge the worktree branch into local `main` with a custom merge-commit
   subject:

   ```bash
   git merge --no-ff worktree-agent-XXXX \
     -m "Merge worktree-agent-XXXX: <SWE commit subject> (#ISSUE)"
   ```

   The `(#ISSUE)` reference is the GitHub issue number, not a PR number.

3. Push:

   ```bash
   git push origin main
   ```

4. The Software Engineer commit body should contain `Closes #ISSUE` so GitHub
   auto-closes the issue when the commit reaches `origin/main`.
5. After push, launch On-Call Engineer.

Use `Refs #ISSUE` instead of `Closes #ISSUE` when the issue must remain open for
human verification.

## Mandatory Steps

Every implementation issue goes through all stages:

```text
PM groom -> SWE implement -> Tester review -> PM acceptance -> Commit -> Local merge -> Push -> On-Call CI check
```

- Tester must actually run tests. Reviewing code is not enough.
- Tester reports exact commands, pass/fail result, and test counts when the tool
  provides counts.
- Tester captures screenshots for every changed UI page or flow and reads each
  screenshot to check for a 404, error page, broken layout, text overlap, or
  missing state.
- Software Engineer must add or update tests that cover the issue's acceptance
  criteria. If automated coverage does not make sense, the issue must explain
  why.
- Product Manager must reject acceptance if the implemented behavior does not
  match the groomed acceptance criteria, if expected operator workflows are
  missing, or if UI changes lack screenshot-backed verification.
- Software Engineer and Tester should update acceptance criteria checkboxes in
  the issue body when the issue body uses `- [ ]` tasks.
- Never commit directly without tester review, even for simple changes.
- Never use `gh pr create` or `gh pr merge`.
- Agents post issue comments via `gh` for their own verdicts. The orchestrator
  should launch the relevant agent, not write the agent's verdict itself.
- After push, always launch On-Call Engineer to monitor CI/CD. The orchestrator
  should not manually watch CI as its main task.

## Testing Expectations

Testing depends on the touched area. A groomed issue should say which commands
are required and why any command is intentionally skipped.

For docs portal, Lambda, frontend, and search changes:

- `uv run --project lambda-functions --extra search --with pytest python -m pytest tests/docs_app`
- Build the search index when content metadata, registry, search, or routing is
  touched:

  ```bash
  cd lambda-functions
  uv run --extra search python -m lambda_functions.build_search_index \
    --docs-dir ../content \
    --output ../.tmp/dataops-content-search.index
  ```

- Run focused backend/frontend tests for the touched route or UI behavior.
- Capture screenshots for changed portal pages or flows.

For work-engine changes:

- `npm --prefix work-engine test`
- `npm --prefix work-engine run typecheck`
- `npm --prefix work-engine run build` when build output or Lambda packaging can
  be affected.
- `npm --prefix work-engine run test:e2e` for changed operator flows, browser
  UI, route behavior, or end-to-end task/workflow behavior.
- Focused Playwright specs are acceptable during development, but the tester
  should explain why the full E2E suite was or was not needed.

For process-doc and content changes:

- Build the search index.
- Run docs metadata tests when frontmatter, document IDs, archive rules,
  templates, registry behavior, or content shape changes.
- Run content validation workflow after push when content changes reach `main`.
- Process Curator reviews document structure and operational usefulness.

For Podcast Assistant or future assistant changes:

- `uv run pytest` in the assistant package when available.
- Integration tests only when credentials and local agent tools are available.
- Assistant Engineer reviews prompts, tool boundaries, and handoff behavior.

For infrastructure and deployment changes:

- Validate SAM/CloudFormation templates.
- Run affected docs-app infrastructure tests.
- On-Call Engineer owns CI/CD monitoring after push.
- Human verification is required when a real external account, secret, OAuth
  flow, GitHub write, Telegram delivery, or sponsor/client-facing message must
  be checked safely.

## Engineering Conventions

- API coverage is the default expectation for operator workflows. When grooming
  an issue that adds or changes an operator action or operator-managed data
  surface, Product Manager must decide whether the same capability needs an
  authenticated API path and include API acceptance criteria when it should.
- Data safety is part of product scope. Issues that add mutable execution state
  must consider DynamoDB backups, portable export, restore checks, and future
  migration to another database such as Postgres.
- Config and secrets must go through the deployed stack, GitHub Actions OIDC,
  AWS Secrets Manager, SAM parameters, or documented local development env vars.
  Do not hardcode production secrets or one-off local credentials.
- Work-engine production tables and Lambda resources should be declared in the
  SAM/CloudFormation templates. Production code must not create unmanaged tables
  on cold start.
- Preserve the unified operator experience. Do not ship disconnected tools when
  the issue is about daily operations flow. A task should connect to the process
  document, evidence, reminders, export path, or follow-up state the operator
  needs to finish the work.

## How to Pick Issues

1. List open issues:

   ```bash
   gh issue list --repo DataTalksClub/dataops --state open --limit 50 \
     --json number,title,labels \
     --jq 'sort_by(.number) | .[] | "#\(.number) \(.title) [\(.labels | map(.name) | join(", "))]"'
   ```

2. Skip issues labeled `needs grooming`. They have not been groomed yet.
3. Pick the lowest-numbered open groomed issues first. Lower-numbered issues are
   usually more foundational.
4. Check the issue's `Depends on` field. Do not start until dependencies are
   closed.
5. Skip issues whose dependencies are still open.
6. Pick two independent issues at a time and run them in parallel when agent
   capacity allows.

## Continuous Issue Pipeline

Always keep the pipeline full. When starting a batch, immediately add a
"Pick next two issues" task blocked by the current batch. This keeps work from
stopping after the current implementation finishes.

The orchestrator should not be idle while eligible backlog exists. Keep at least
one role agent running, and usually two independent tracks, whenever there are
groomed unblocked issues and available agent capacity.

If all active issue tracks are waiting on test, PM, commit, CI, or human
verification, use spare capacity for grooming, next-issue selection, or the next
independent implementation worktree.

```text
Batch N: implement + test + accept -> commit + push
    +-- triggers: Pick next two issues -> Batch N+1 -> ...
```

If the user interrupts with new information while role agents are working, keep
those agents running unless the new instruction invalidates their task. Convert
the new information into intake issues or PM grooming work in parallel, then
return to orchestrating active handoffs.

## Human Verification

Some acceptance criteria are marked `[HUMAN]` in issues. Use them for checks that
cannot be automated safely:

- real Telegram bot delivery
- real GitHub write behavior in production
- external OAuth or secret setup
- actual sponsor/client-facing messages
- production deployment verification that needs a human account
- destructive restore or migration operations against production data

When an issue passes all agent reviews but has `[HUMAN]` criteria:

1. Commit and push the code. Do not block the merge on human verification.
2. Add the `human` label:

   ```bash
   gh issue edit N --repo DataTalksClub/dataops --add-label human
   ```

3. Comment with the exact criteria that need manual verification.
4. Do not close the issue. Leave it open for the human to verify and close.
5. Continue with the next issues. Do not wait.

## Labels

| Category | Labels |
|---|---|
| Workflow | `needs grooming` |
| Type | `enhancement`, `bug`, `docs`, `migration`, `research` |
| Area | `portal`, `process-docs`, `work-engine`, `assistant`, `podcast`, `frontend`, `backend`, `infra`, `testing`, `data`, `design` |
| Priority | `P0` (must have), `P1` (important), `P2` (nice to have) |
| Special | `human` (code done, needs manual verification) |

## Temporary Files

All agents must use the project-local `.tmp/` directory for temporary files:
screenshots, previews, downloads, scratch data, logs, draft issue bodies, and
one-off exports. This directory is gitignored.

- Never write temp files to `/tmp`, `/data/tmp`, or any path outside the project
  root.
- Put screenshots under `.tmp/screenshots/`.
- Put export and restore drill outputs under `.tmp/exports/` or another
  project-local `.tmp/` subdirectory.
- Delete temporary files when they are no longer useful.

## Short-Lived Docs

Point-in-time documents, such as audits, remediation plans, one-off analyses,
dated status reports, and handoff notes, should not live at the `docs/` or
`_docs/` root forever.

Use `_docs/audits/` for short-lived internal analysis when we need to keep it.
Use a `YYYY-MM-DD-<topic>.md` filename. Delete temporary handoff files when the
handoff is no longer needed, or promote durable decisions into an evergreen doc
such as `_docs/PROCESS.md`, `docs/architecture.md`, or `docs/STRUCTURE.md`.

## Technology Stack

- Public app: protected Python Lambda docs/operations portal.
- Work engine: private Node.js/TypeScript Lambda under `work-engine/`.
- Deployment: AWS SAM/CloudFormation, GitHub Actions OIDC, stack name
  `dataops-v1`.
- Runtime state: DynamoDB execution tables declared by the deployed stack.
- Knowledge source: Markdown content under `content/`, with stable document IDs
  and a generated search index.
- Frontend: current portal JavaScript/CSS in `frontend/`, plus work-engine UI
  assets during the V1 merge.
- Tests: pytest for docs app, Node test runner for work-engine, Playwright for
  work-engine and changed operator flows, SAM validation for infrastructure.
- Domain: `ops.dtcdev.click`.

## Content And Knowledge Management

Operational knowledge currently lives in this repo under `content/` and related
docs. The V1 app must treat process documents, task templates, assistant prompts,
and operator workflows as one unified product surface.

Content changes should preserve:

- stable document IDs for SOPs, templates, references, and assistant knowledge
- links from tasks to the process documents an operator needs
- portable templates and execution data so the system can be exported and later
  migrated if needed
- a clear boundary between app code, runtime state, and canonical operational
  knowledge

If we later split canonical knowledge into a separate repository, the DataOps
app must keep the same workflow: issues first, PM grooming, implementation,
tester verification, PM acceptance, merge, push, and On-Call CI/CD monitoring.
