## Product Thesis

We are not just merging two codebases. We are creating one internal
DataTalks.Club operations portal that replaces scattered daily work across
Trello, Google Sheets, process docs, Telegram notes, email tasks, local
assistant scripts, and manual search.

The portal should answer these operator questions:

- What do I need to do today?
- What process should I follow?
- What assets, links, people, and templates do I need?
- What has already happened for this podcast, newsletter, event, course, or
  finance process?
- What can the system prepare automatically before I start?

The product becomes an operations OS for DataTalks.Club:

- Work: tasks, cards, due dates, assignments, statuses, files, required
  links, and recurring work.
- Knowledge: private SOPs, templates, references, playbooks, screenshots,
  Looms, prompts, and search surfaced inside the authenticated portal.
- Assistants: ingestion and drafting workflows such as the podcast assistant.
- History: execution logs, task completion, generated docs, decisions, and
  links to final artifacts.

## Source System Inventory

### DataTasks

Location: `../datatasks`

What it gives us:

- DynamoDB-backed execution state.
- Data model for tasks, cards, templates, recurring configs, users, files,
  sessions, and notifications.
- API routes for task-like operations, cards, templates, recurring work,
  email, Telegram, files, users, auth, cron, and notifications.
- Local development with Node.js, TypeScript, dynalite, and Playwright tests.
- A product model close to what operations needs: template -> card -> tasks.

Current limitation:

- It knows about instruction URLs, but not DTC Operations documents as
  first-class objects.
- It doesn't have a document registry, SOP viewer, SOP editor, or process-doc
  search.
- It's task-centric, not portal-centric.

### DTC Operations

Location: `../dtc-operations`

What it gives us:

- A large private operations knowledge base under `content/`.
- Git-backed markdown docs with screenshots and Loom links.
- A structured SOP format that can be parsed by scripts and the Lambda app.
- A docs editor with search, filters, linting, drafts, diff, and GitHub-backed
  publishing.
- A Lambda full app that already serves docs, search, editing, linting, images,
  and frontend.
- A CI split between content-only validation and full app deployment.

Current limitation:

- It documents work, but it doesn't execute work.
- It has process documents, but most are not connected into task cards.
- It doesn't know which process docs are used in active work.
- It doesn't track whether a real podcast, newsletter, event, or finance report
  is done.

### Podcast Assistant

Location: `../podcast-assistant`

What it gives us:

- Telegram intake for podcast notes, links, files, voice notes, images, audio,
  and video metadata.
- Voice/audio transcription through Groq Whisper.
- Image description through a Groq vision model.
- Inbox staging under `inbox/raw/` and processed material under `inbox/used/`.
- Heru-based agent execution with Codex or Claude engines.
- Retry and resume support for interrupted agent sessions.
- Progress updates back into Telegram.
- Generated podcast documents under `documents/`.
- Example podcast `.docx` files that can train or validate the output format.

Current limitation:

- It isn't a git repo.
- It has no shared auth, UI, durable job dashboard, or portal integration.
- Its podcast output format is explicitly temporary.
- It writes local files, not portal records.
- It's specialized for podcast prep, but the same intake flow can support other
  workflows later.

## Current Content Coverage

DTC Operations already has enough content to be the private knowledge base for
the portal. That content should be surfaced through DataOps, not copied into
the public app repo as the long-term source of truth.

Content inventory:

- 346 markdown documents.
- 240 SOPs.
- 67 templates.
- 35 references.
- 2 checklists.
- 2 playbooks.
- 187 docs with Loom metadata.

Largest domains:

- `media`: 79 docs
- `finance`: 48 docs
- `events`: 38 docs
- `community`: 35 docs
- `sales`: 30 docs
- `social-media`: 29 docs
- `newsletter`: 23 docs
- `courses`: 15 docs
- `internal-admin`: 13 docs
- `maven`: 10 docs

Important workflow clusters:

- Podcast: 40 docs, including 30 SOPs and 9 templates.
- Newsletter: 23 docs, including 15 SOPs and 7 templates.
- Events: 38 docs, including event creation, Luma, Meetup, LinkedIn,
  cancellation, rescheduling, and outreach.
- Finance: 48 docs, mostly bookkeeping, invoices, and monthly tax reporting.
- Book of the Week: 30 docs, including author outreach, announcements, Slack,
  winners, and templates.
- Open-Source Spotlight: 11 docs.
- Maven: 10 docs.
- Social media: 29 docs.

## Content Quality Findings

The process library is already large. The docs now need enough normalization to
become executable workflows.

Observed gaps:

- 55 docs have empty summary fields such as purpose, outcome, trigger, and
  frequency.
- 241 docs have empty validation sections.
- 345 docs have empty `related_docs`.
- 28 docs contain TODOs or placeholders.
- 2 SOPs are missing `schema_version`.
- Many docs are atomic SOPs, but only a few docs are true checklist or playbook
  docs that sequence several SOPs into a workflow.

The portal needs different content types:

- Atomic SOP: "How to create an event on Luma"
- Template: "Email to ask a podcast guest for links"
- Reference: "Podcast workflow overview"
- Checklist/playbook: "Run one podcast episode from first contact to publishing"
- Executable task template: "Create these 40 tasks relative to the podcast
  stream date"

The current content mostly covers atomic SOPs and reusable text templates. The
missing layer is workflow assembly.

