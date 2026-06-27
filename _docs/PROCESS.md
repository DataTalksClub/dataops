# DataOps Development Process

## Overview

Use GitHub Issues to manage all DataOps work in
`DataTalksClub/dataops`.

The project follows the AI Shipping Labs issue pipeline, adapted for the
DataTalks.Club operations portal.

The orchestrator turns user input into raw GitHub issues. Role agents then move
each issue through grooming, implementation, testing, acceptance, merge, and
CI/deploy monitoring.

## Links

- Repo: `https://github.com/DataTalksClub/dataops`
- Issues: `https://github.com/DataTalksClub/dataops/issues`
- Merge plan: `_docs/MERGE_PLAN.md`
- Portal analysis: `PORTAL_ANALYSIS.md`
- Shared project plan: `PROJECT_PLAN.md`

## Agent Roles

| Agent | Role |
|---|---|
| Product Manager | Grooms raw issues into scoped specs and performs final user acceptance |
| Architect | Reviews merge architecture, data boundaries, and migration approach |
| Process Curator | Reviews SOP/content changes, document IDs, workflow-doc links, and lint quality |
| Assistant Engineer | Owns assistant modules such as Podcast Assistant |
| Software Engineer | Implements code and tests |
| Tester | Runs technical verification and screenshots |
| On-Call Engineer | Monitors CI/CD after push and fixes deployment/test failures |

## Issue Lifecycle

```text
User intake
  -> Orchestrator files raw issue with needs grooming
  -> Product Manager grooms issue
  -> Architect or Process Curator reviews when needed
  -> Software Engineer implements
  -> Tester verifies
  -> Product Manager accepts from user perspective
  -> Software Engineer commits
  -> Orchestrator merges and pushes
  -> On-Call Engineer monitors CI/CD
```

## Orchestrator Responsibilities

- File raw issues from chat, links, recordings, screenshots, or repo findings.
- Add `needs grooming` to raw issues.
- Do not groom inline unless explicitly asked.
- Launch the Product Manager for grooming.
- Launch the Architect for cross-system merge decisions.
- Launch the Process Curator for SOP, workflow, or content-quality work.
- Launch the Assistant Engineer for podcast-assistant and future assistant work.
- Launch the Software Engineer only after an issue is groomed and unblocked.
- Launch the Tester after implementation.
- Launch the Product Manager for acceptance after tester pass.
- Merge locally after approval.
- Push `main`.
- Launch On-Call Engineer after push.
- Keep the pipeline moving with at least one active track when backlog exists.

## Mandatory Gates

Every implementation issue must pass these gates:

1. Product Manager grooming.
2. Implementation with tests.
3. Tester review.
4. Product Manager acceptance.
5. Commit that references the issue.
6. Local merge to `main`.
7. Push to GitHub.
8. On-call CI/deploy check.

Do not commit feature work directly to `main` without tester and PM acceptance.

## Issue Format

Groomed issues use this structure:

```markdown
# Title

Status: pending
Tags: `area`, `priority`
Depends on: None
Blocks: —

## Scope

Describe the exact product and technical work.

## Acceptance Criteria

- [ ] Criterion that can be tested
- [ ] Criterion that can be tested

## Test Scenarios

### Scenario: Operator completes a real task
Given: starting context
When: operator actions
Then: observable result

## Out of Scope

- Explicit exclusions
```

## Labels

Use these labels initially:

| Category | Labels |
|---|---|
| Workflow | `needs grooming`, `human` |
| Type | `enhancement`, `bug`, `docs`, `migration`, `research` |
| Area | `portal`, `process-docs`, `work-engine`, `assistant`, `podcast`, `frontend`, `backend`, `infra`, `testing`, `data` |
| Priority | `P0`, `P1`, `P2` |

## Merge Rules

Use local merges, not pull requests, unless the user asks otherwise.

After an approved software engineer commit on a branch:

```bash
git fetch origin
git checkout main
git status
git merge --no-ff <branch> -m "Merge <branch>: <commit subject> (#ISSUE)"
git push origin main
```

The feature commit should include:

```text
Short imperative subject

Closes #ISSUE
```

Use `Refs #ISSUE` when the issue must remain open for human verification.

## Testing Expectations

Testing depends on the touched area.

For `dtc-operations` imports:

- Python unit tests for backend and parsers.
- SOP linting for changed process docs.
- Search-index smoke tests.
- Playwright tests for portal flows.

For `datatasks` imports:

- `npm test`
- `npm run typecheck`
- focused Playwright tests for task and bundle flows.

For `podcast-assistant` imports:

- `uv run pytest`
- integration tests only when credentials and local agent tools are available.

For portal integration issues:

- Backend tests for API behavior.
- Playwright tests for user workflows.
- Screenshot verification for changed UI pages.

## Human Verification

Use `[HUMAN]` acceptance criteria for checks that cannot be automated safely:

- real Telegram bot delivery
- real GitHub write behavior in production
- external OAuth or secret setup
- actual sponsor/client-facing messages
- production deployment verification

When an issue has `[HUMAN]` criteria:

- Commit and push completed code after agent review.
- Add the `human` label.
- Comment with the exact manual checks needed.
- Leave the issue open until the human verifies it.

## Temporary Files

Use `.tmp/` inside the project root for screenshots, logs, scratch data, and
draft issue bodies.

Do not write project temporary files to `/tmp` or other shared locations.

