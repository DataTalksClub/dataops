# Import Log

This is the canonical register for copied source systems in
`DataTalksClub/dataops`. It records both the historical import evidence and the
policy future imports and re-imports must follow.

## Import And Source-State Policy

Every source import or re-import must add or update an entry in this file before
dependent migration work relies on the copied files.

Required fields for every entry:

- Source system name.
- Source path and source repository URL when the source is Git-backed, or a
  local source identity when the source is not Git-backed.
- Source state:
  - For Git-backed sources, record the exact output of
    `git -C <source> rev-parse HEAD`.
  - For non-Git local sources, record that no commit is available and describe
    the local source state that was verified, including the commands used to
    check it.
- Destination path or paths in this repo.
- Copied path groups or major copied contents.
- Deliberate exclusions, especially generated files, dependencies, caches,
  secrets, local runtime state, private outputs, archives, and upload data.
- Validation commands run after import or re-import, with each command marked
  `passed`, `failed`, `skipped`, `blocked`, `not rerun`, or `unknown`.
- Follow-up issue references when the import is transitional, incomplete, or
  expected to be normalized by later work.

Source directories such as `../dtc-operations`, `../datatasks`, and
`../podcast-assistant` are read-only for DataOps migration work unless a
specific issue explicitly scopes changes to those source directories. DataOps
issues should copy from or inspect those sources, not modify them.

Validation entries must not imply more than was verified. If a command was not
run during the import or during a later documentation update, record it as
`not rerun`, `skipped`, `blocked`, or `unknown` with the reason.

## 2026-06-27 Initial Import

Initial v1 import for operations docs and tasks. The original import log already
recorded source paths, source commits or source state, imported locations,
exclusions, and purpose notes. This entry preserves that evidence and expands it
with the reusable fields required by the policy above.

### DTC Operations

- Source system: DTC Operations.
- Source path: `../dtc-operations`
- Source repository URL: `git@github.com:DataTalksClub/dtc-operations.git`
- Source state: Git-backed source commit
  `e6f7b43f641389fa58a8e027485f5aac18e8ace5`.
- Source-state command: `git -C ../dtc-operations rev-parse HEAD`
  - Status: passed on 2026-06-27 during #12 verification.
  - Output: `e6f7b43f641389fa58a8e027485f5aac18e8ace5`
- Destination paths in this repo:
  - Repo root for the operations portal app, content, docs, scripts, templates,
    tests, and root runtime/package metadata.
- Copied path groups currently represented in this repo:
  - `content/`
  - `docs/`
  - `frontend/`
  - `lambda-functions/`
  - `scripts/`
  - `templates/`
  - `tests/`
  - Root files such as `README.md`, `compose.yaml`, `package.json`,
    `pyproject.toml`, and `uv.lock`.
- Deliberate exclusions recorded by the initial import:
  - `.git`
  - `.github`
  - `.venv`
  - `node_modules`
  - `.pytest_cache`
  - `.tmp`
  - `.aws-sam`
  - Reports
  - Archived zip exports
- Purpose: v1 Lambda app base for operation docs, SOP editing, search, linting,
  and GitHub-backed content.
- Validation:
  - `test -f _docs/import-log.md`: passed on 2026-06-27 during #12
    verification.
  - `rg -n "policy|DTC Operations|DataTasks|Podcast Assistant|Validation" _docs/import-log.md`:
    passed on 2026-06-27 during #12 final verification.
  - `git -C ../dtc-operations rev-parse HEAD`: passed on 2026-06-27 during #12
    verification.
  - Full DTC Operations application test suites: not rerun for #12; this issue
    is documentation-only.
- Follow-up context:
  - This entry is the source-state convention that downstream migration issues
    must follow when they re-import or normalize root-level operations portal
    files.

### DataTasks

- Source system: DataTasks.
- Source path: `../datatasks`
- Source repository URL: `git@github.com:alexeygrigorev/datatasks.git`
- Source state: Git-backed source commit
  `9adbc21da3a4db3990a58965950513c618abcda0`.
- Source-state command: `git -C ../datatasks rev-parse HEAD`
  - Status: passed on 2026-06-27 during #12 verification.
  - Output: `9adbc21da3a4db3990a58965950513c618abcda0`
- Destination paths in this repo:
  - `work-engine/`
- Copied path groups currently represented in this repo:
  - `work-engine/docs/`
  - `work-engine/e2e/`
  - `work-engine/scripts/`
  - `work-engine/src/`
  - `work-engine/tests/`
  - `work-engine/Dockerfile.lambda`
  - `work-engine/Makefile`
  - `work-engine/README.md`
  - `work-engine/docker-compose.yml`
  - `work-engine/package.json`
  - `work-engine/package-lock.json`
  - `work-engine/playwright.config.js`
  - `work-engine/tsconfig.json`
  - `work-engine/tsconfig.scripts.json`
  - `work-engine/tsconfig.tests.json`
- Deliberate exclusions recorded by the initial import:
  - `.git`
  - `.github`
  - `.claude`
  - `node_modules`
  - `dist`
  - `.data`
  - Test results
  - Uploads
- Local note: ignored/generated directories such as `work-engine/node_modules/`,
  `work-engine/dist/`, and `work-engine/.data/` may exist in a developer
  worktree. They are not source-state evidence for this import entry.
- Purpose: v1 task execution engine during the merge.
- Validation:
  - `test -f _docs/import-log.md`: passed on 2026-06-27 during #12
    verification.
  - `rg -n "policy|DTC Operations|DataTasks|Podcast Assistant|Validation" _docs/import-log.md`:
    passed on 2026-06-27 during #12 final verification.
  - `git -C ../datatasks rev-parse HEAD`: passed on 2026-06-27 during #12
    verification.
  - Full DataTasks/work-engine test suites: not rerun for #12; this issue is
    documentation-only.
- Follow-up context:
  - #4 depends on this policy and import evidence for any DataTasks
    re-import, movement, or normalization work.

### Podcast Assistant

- Source system: Podcast Assistant.
- Source path: `../podcast-assistant`
- Local source identity: local Podcast Assistant directory supplied alongside
  the DataOps migration workspace.
- Source state: non-Git local directory; no source commit is available because
  `../podcast-assistant/.git` is absent.
- Source-state commands:
  - `test -d ../podcast-assistant`
    - Status: passed on 2026-06-27 during #12 verification.
  - `test ! -d ../podcast-assistant/.git`
    - Status: passed on 2026-06-27 during #12 verification.
- Destination paths in this repo:
  - `podcast-assistant/` as the current transitional import location.
- Copied path groups currently represented in this repo:
  - `podcast-assistant/data/`
  - `podcast-assistant/documents/`
  - `podcast-assistant/inbox/`
  - `podcast-assistant/knowledge_base/`
  - `podcast-assistant/podcast_examples/`
  - `podcast-assistant/process/`
  - `podcast-assistant/scripts/`
  - `podcast-assistant/templates/`
  - `podcast-assistant/tests/`
  - `podcast-assistant/tests_integration/`
  - Root assistant files such as `README.md`, `main.py`,
    `process_request.py`, `message_queue.py`, `progress_tracker.py`,
    `session_retrier.py`, `heru_runner.py`, `pyproject.toml`, and `uv.lock`.
- Deliberate exclusions recorded by the initial import:
  - `.venv`
  - `__pycache__`
  - `.pytest_cache`
  - `.env`
  - Local-only environment files
- Local non-Git exclusions observed during #12 verification:
  - `../podcast-assistant/.tmp`
  - `../podcast-assistant/.venv`
- Purpose: podcast operations workflow, guest-intake template, podcast process
  document preparation, and knowledge-base tooling.
- Validation:
  - `test -f _docs/import-log.md`: passed on 2026-06-27 during #12
    verification.
  - `rg -n "policy|DTC Operations|DataTasks|Podcast Assistant|Validation" _docs/import-log.md`:
    passed on 2026-06-27 during #12 final verification.
  - `test -d ../podcast-assistant`: passed on 2026-06-27 during #12
    verification.
  - `test ! -d ../podcast-assistant/.git`: passed on 2026-06-27 during #12
    verification.
  - Full Podcast Assistant test suites: not rerun for #12; this issue is
    documentation-only.
- Follow-up context:
  - #7 should move or canonicalize the transitional `podcast-assistant/` import
    under `assistants/podcast/` and should update this log with the final
    destination, source state, copied paths, exclusions, and validation status.
