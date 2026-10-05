## Goal

Create one internal DataTalks.Club operations portal that combines task
execution, process documentation, recurring workflows, artifacts, and assistants.

The combined project should let the team:

- Find the private SOP or template needed to do operational work through the
  authenticated portal.
- Turn recurring playbooks into task cards.
- Execute tasks from one unified task list.
- Collect raw operational inputs from Telegram, email, files, and manual entry.
- Run assistants that draft operational artifacts, starting with podcast prep
  documents.
- Keep sensitive operational knowledge in Git-backed markdown in a private
  repository.
- Preserve lightweight serverless deployment and low maintenance cost.

## Source Projects

### DataTasks

Source: `../datatasks`

Role in the combined project: task execution system.

Current capabilities:

- Task, template, card, recurring-task, file, user, auth, email, Telegram, and
  cron routes.
- DynamoDB-backed data model for templates, cards, tasks, recurring configs,
  users, files, sessions, and notifications.
- Vanilla JavaScript SPA served by a Lambda-style backend.
- Local dev with dynalite and Node.js.
- Unit, Playwright E2E, typecheck, build, and integration scripts.

Important concepts to retain:

- Templates define repeatable workflows.
- Cards instantiate templates for concrete dates or events.
- Tasks appear both inside cards and in a unified task list.
- Tasks can carry instruction URLs, required links, file requirements, tags, and
  assignees.
- Recurring configs generate routine operational tasks automatically.

### DTC Operations

Source: `../dtc-operations`

Role in the combined project: private operational knowledge base and SOP
editor pattern.

Current capabilities:

- Domain-first markdown content under `content/`.
- SOPs, checklists, templates, references, playbooks, prompts, and screenshots.
- Structured SOP format with HTML comment markers.
- Browser editor with block editing, linting, search, filters, drafts, diff, and
  GitHub-backed publishing.
- Lambda full app that serves frontend, docs API, GitHub-backed content editing,
  search, linting, and image handling.
- Content-only CI path separate from full app deploys.

Important concepts to retain:

- Private GitHub is the source of truth for operational documentation.
- Markdown remains readable on GitHub.
- Structured SOP markers make docs machine-readable.
- Content changes can validate and refresh search without redeploying app code.

### Podcast Assistant

Source: `../podcast-assistant`

Role in the combined project: first assistant module for raw intake and podcast
prep document generation.

Current capabilities:

- Telegram bot for collecting podcast notes, files, voice notes, audio, images,
  and video metadata.
- Groq-powered audio transcription and image description.
- Heru-powered agent runs with Codex or Claude engines.
- Retry/resume support, progress updates, and generated documents.

Important concepts to retain:

- Raw inputs go into an inbox before processing.
- Processing is an explicit job with progress, logs, and retry behavior.
- Generated podcast documents should be reviewed before becoming official
  card artifacts.

## Product Shape

The shared product should be one internal DataTalks.Club Operations app with
four primary surfaces:

1. **Work**: tasks, cards, recurring operations, assignments, due dates,
   execution status, and links/files needed to complete work.
2. **Knowledge**: authenticated in-app access to private SOPs, templates,
   references, playbooks, prompts, screenshots, search, editing, linting, and
   publishing.
3. **Assistants**: intake, transcription, AI drafting, job logs, retry, and
   human review.
4. **Artifacts**: podcast docs, event pages, Luma links, YouTube links,
   transcripts, invoices, reports, sponsor docs, and other outputs of work.

The user-facing distinction should be simple:

- A task tells the operator what to do next.
- A doc tells the operator how to do it.
- A workflow connects repeatable work to the right docs.
- An assistant prepares drafts or structured inputs.
- An artifact proves that an output exists.

