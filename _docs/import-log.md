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
    - Status: passed on 2026-06-27 during #7 verification.
  - `test ! -d ../podcast-assistant/.git`
    - Status: passed on 2026-06-27 during #7 verification.
- Destination paths in this repo:
  - `assistants/podcast/` as the canonical in-repo Podcast Assistant location.
  - Root-level `podcast-assistant/` was removed during #7; no compatibility
    shim was kept because the import can run directly from the canonical
    module path.
- Copied path groups currently represented in this repo:
  - `assistants/podcast/data/`
  - `assistants/podcast/documents/` with `.gitkeep` only
  - `assistants/podcast/inbox/` with `.gitkeep` placeholders only
  - `assistants/podcast/knowledge_base/`
  - `assistants/podcast/podcast_examples/`
  - `assistants/podcast/process/`
  - `assistants/podcast/scripts/`
  - `assistants/podcast/templates/`
  - `assistants/podcast/tests/`
  - `assistants/podcast/tests_integration/`
  - Assistant files such as `.env.example`, `README.md`, `main.py`,
    `process_request.py`, `message_queue.py`, `progress_tracker.py`,
    `session_retrier.py`, `heru_runner.py`, `pyproject.toml`, and `uv.lock`.
- Deliberate exclusions recorded by the initial import:
  - `.venv`
  - `__pycache__`
  - `.pytest_cache`
  - `.env`
  - Local-only environment files
- Deliberate exclusions confirmed during #7 canonicalization:
  - `../podcast-assistant/.tmp`
  - `../podcast-assistant/.venv`
  - `assistants/podcast/.env`
  - `assistants/podcast/.env.*` except `.env.example`
  - `assistants/podcast/.tmp/`
  - `assistants/podcast/.venv/`
  - `assistants/podcast/heru_runs/`
  - Generated/private files under `assistants/podcast/inbox/raw/`
  - Generated/private files under `assistants/podcast/inbox/used/`
  - Generated podcast documents under `assistants/podcast/documents/`
- Purpose: podcast operations workflow, guest-intake template, podcast process
  document preparation, and knowledge-base tooling.
- Validation:
  - `test -d ../podcast-assistant && test ! -d ../podcast-assistant/.git && test ! -e podcast-assistant`:
    passed on 2026-06-27 during #7 verification.
  - `uv lock --project assistants/podcast`: passed on 2026-06-27 during #7
    verification after updating the editable Heru path to
    `../../../heru` from `assistants/podcast/`.
  - `uv run --project assistants/podcast pytest`: passed on 2026-06-27 during
    #7 follow-up verification after adding a package-local pytest entrypoint;
    28 tests passed.
  - `cd assistants/podcast && uv run pytest`: passed on 2026-06-27 during #7
    follow-up verification; 28 tests passed.
  - `cd assistants/podcast && uv run pytest tests/test_session_retrier.py tests/test_main.py`:
    passed on 2026-06-27 during #7 follow-up verification; 12 tests passed,
    including retry/resume and default no-push coverage.
  - `cd assistants/podcast && uv run python scripts/search_podcast_kb.py "AI agents evaluation"`:
    passed on 2026-06-27 during #7 verification.
  - `git diff --check`: passed on 2026-06-27 during #7 verification.
- Follow-up context:
  - #7 completed the canonical path move. Local `inbox/`, `documents/`, and
    Heru logs remain transitional development storage until later assistant
    job/artifact work attaches outputs to DataOps workflow records.

## 2026-06-28 Issue #20 DTC Operations Backend Reconciliation

Selective reconciliation for #20 confirmed that the DataOps
`lambda-functions/` backend already carries the DTC Operations docs backend
capabilities plus V1-specific workflow integration. No whole source files were
copied from `../dtc-operations`; this update strengthened missing evidence and
adapted weaker DataOps-local defaults without replacing the authoritative
Lambda runtime.

### DTC Operations

- Source system: DTC Operations.
- Source path: `../dtc-operations`
- Source repository URL: `git@github.com:DataTalksClub/dtc-operations.git`
- Source state: Git-backed source commit
  `e6f7b43f641389fa58a8e027485f5aac18e8ace5`.
- Source-state commands:
  - `git -C ../dtc-operations rev-parse HEAD`
    - Status: passed on 2026-06-28 during #20 verification.
    - Output: `e6f7b43f641389fa58a8e027485f5aac18e8ace5`
  - `git -C ../dtc-operations status --short`
    - Status: passed on 2026-06-28 during #20 verification.
    - Output: no output; source worktree clean.
- Destination paths reconciled in this repo:
  - `lambda-functions/src/lambda_functions/docs_index.py`
  - `lambda-functions/src/lambda_functions/search_handler.py`
  - `lambda-functions/template.github-actions.yaml`
  - `scripts/audit_doc_structure.py`
  - `scripts/convert_processes.py`
  - `scripts/optimize_images.py`
  - `tests/docs_app/`
- Reconciled behavior:
  - Search index documents now carry a workflow-facing `description` field in
    addition to `id`, `path`, `title`, `summary`, `domain`, `doc_type`, and
    `purpose`.
  - Maintenance scripts that still had docs-era defaults now operate on
    `content/` and `content/images/`; generated conversion/image reports go
    under `.tmp/`.
  - The legacy GitHub Actions OIDC template no longer defaults to
    `dtc-operations` repository or stack names. The active deploy template
    remains `template.github-actions-dataops.yaml`.
  - Tests now prove image upload commits, folder rename/delete commits,
    supported `/docs/resolve` refs, built search index fields, script defaults,
    and DataOps OIDC defaults without live GitHub writes.
- Deliberate exclusions confirmed during #20:
  - No files were copied from `.venv`, `.aws-sam`, `.tmp`, `__pycache__`,
    caches, secrets, generated indexes, runtime outputs, or source-repo private
    artifacts.
  - `backend/` was not populated; `lambda-functions/` remains the authoritative
    Python backend.
  - Source repositories outside DataOps were read only and not modified.
- Validation:
  - `uv run --project lambda-functions --extra search --with pytest python -m pytest tests/docs_app`:
    passed on 2026-06-28 during #20 verification; 84 passed, 1 skipped.
  - `cd lambda-functions && uv run --extra search python -m lambda_functions.build_search_index --docs-dir ../content --output ../.tmp/dataops-content-search.index`:
    passed on 2026-06-28 during #20 verification; indexed 357 documents.
  - `cd lambda-functions && sam validate --template-file template.full.yaml`:
    skipped on 2026-06-28 during #20 verification because `sam` was not
    installed in the local environment (`sam: command not found`).
  - `python3 scripts/sop_lint.py content/systems/airtable/sops/access-and-update-the-data-on-airtable.md`:
    passed on 2026-06-28 during #20 verification.
  - `python3 scripts/sop_parse.py content/systems/airtable/sops/access-and-update-the-data-on-airtable.md >/dev/null`:
    passed on 2026-06-28 during #20 verification.
  - `git diff --check`: passed on 2026-06-28 during #20 verification.
- Follow-up context:
  - #21 remains the broader backend/script path and branding cleanup issue.
  - #32 and #33 remain the workflow search design and stable-ID content
    migration follow-ups. #20 intentionally did not bulk-edit process docs.
