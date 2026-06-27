# Import Log

## 2026-06-27

Initial v1 import for operations docs and tasks.

### DTC Operations

- Source path: `../dtc-operations`
- Source commit: `e6f7b43f641389fa58a8e027485f5aac18e8ace5`
- Imported into repo root.
- Excluded: `.git`, `.github`, `.venv`, `node_modules`, `.pytest_cache`,
  `.tmp`, `.aws-sam`, reports, and archived zip exports.
- Purpose: v1 Lambda app base for operation docs, SOP editing, search, linting,
  and GitHub-backed content.

### DataTasks

- Source path: `../datatasks`
- Source commit: `9adbc21da3a4db3990a58965950513c618abcda0`
- Imported into `work-engine/`.
- Excluded: `.git`, `.github`, `.claude`, `node_modules`, `dist`, `.data`,
  test results, and uploads.
- Purpose: v1 task execution engine during the merge.

### Podcast Assistant

- Source path: `../podcast-assistant`
- Source state: local directory without a Git repository.
- Imported into `podcast-assistant/`.
- Excluded: `.venv`, `__pycache__`, `.pytest_cache`, `.env`, and local-only
  environment files.
- Purpose: podcast operations workflow, guest-intake template, podcast process
  document preparation, and knowledge-base tooling.
