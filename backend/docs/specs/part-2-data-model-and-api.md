> Part 2 of 3 of the [DataTasks Product Specification](../specs.md),
> covering the data model and API. The background, architecture, and core
> concepts are in
> [Part 1](part-1-background-architecture-and-core-concepts.md), and the
> UI, migration, and future extensions are in
> [Part 3](part-3-ui-migration-and-extensions.md).

## Data Model

### User

Fields:
- id: UUID, auto-generated
- name: string, required
- email: string, required
- createdAt: ISO timestamp

DynamoDB keys: PK = USER#{id}, SK = USER#{id}

### Task

Fields:
- id: UUID, auto-generated
- description: string, required
- date: YYYY-MM-DD, required
- status: "todo", "done", or "archived" - defaults to "todo"
- comment: string, optional (may contain markdown links)
- instructionsUrl: string, optional (URL to instruction document, copied from template task definition)
- link: string, optional (URL associated with the task, e.g., Luma event link)
- requiredLinkName: string, optional (label like "Luma" - if set, task cannot be marked done until `link` is filled)
- assigneeId: string, optional (user ID)
- cardId: string, optional (links task to a card)
- source: "manual", "template", "recurring", or "telegram"
- templateTaskRef: string, optional (refId from the template task definition)
- tags: array of strings, optional
- createdAt: ISO timestamp
- updatedAt: ISO timestamp

DynamoDB keys: PK = TASK#{id}, SK = TASK#{id}
GSI: DateIndex with PK = date, SK = TASK#{id}
GSI: CardIndex with PK = cardId, SK = TASK#{id}

### Card

Fields:
- id: UUID, auto-generated
- title: string, required
- anchorDate: YYYY-MM-DD, required
- description: string, optional (may contain markdown links)
- templateId: string, optional
- status: "active" or "archived" - defaults to "active"
- stage: "preparation", "announced", "after-event", or "done" - defaults to "preparation"
- emoji: string, optional (inherited from template)
- references: array of { name: string, url: string }, optional (fixed links inherited from template - process docs, server links)
- cardLinks: array of { name: string, url: string }, optional (slots to fill during execution - e.g., Luma URL, YouTube link)
- tags: array of strings, optional (inherited from template)
- createdAt: ISO timestamp
- updatedAt: ISO timestamp

The card has two kinds of links:
- References: inherited from the template, pre-filled with fixed URLs (process docs, server links). Read-only in the card view.
- Card links: empty slots defined by the template's `cardLinkDefinitions`, filled during execution. Each entry has a display name and a URL. When a task with `requiredLinkName` has its `link` filled, the corresponding card link is also updated.

DynamoDB keys: PK = CARD#{id}, SK = CARD#{id}

### Template

Fields:
- id: UUID, auto-generated
- name: string, required
- type: string, required (e.g., "newsletter", "podcast", "webinar")
- emoji: string, optional (e.g., "📰", "🎙️")
- tags: array of strings, optional
- defaultAssigneeId: string, optional (default user for tasks)
- references: array of { name: string, url: string }, optional (fixed links same for every card - process docs, server links)
- cardLinkDefinitions: array of { name: string }, optional (card link slots to be filled during execution)
- taskDefinitions: array, required, each element:
  - refId: string, required (slug identifier)
  - description: string, required
  - offsetDays: number, required (relative to anchor date) -- comment. not required, automatically calculated based on milestones. but for milestones it's required. 
  - isMilestone: boolean, optional (if true, fixed to the anchor date)
  - stageOnComplete: string, optional (stage to transition card to when this milestone task is completed, e.g., "announced", "after-event", "done")
  - assigneeId: string, optional (overrides template default)
  - instructionsUrl: string, optional (URL to instruction document)
  - requiredLinkName: string, optional (name of the card link that must be filled before task can be completed, e.g., "Luma")
  - requiresFile: boolean, optional (if true, task cannot be completed without uploading a file)
- triggerType: "automatic" or "manual", defaults to "manual"
- triggerSchedule: string, optional (cron expression for auto-creating cards, only for automatic triggers)
- triggerLeadDays: number, optional (how many days before anchor date to create the card, only for automatic triggers)
- createdAt: ISO timestamp
- updatedAt: ISO timestamp

The instructionsUrl field stores a link to a Google Doc or other document describing how to perform the task. When a template is instantiated, the instructionsUrl is copied to the created task's `instructionsUrl` field (not the comment field).

DynamoDB keys: PK = TEMPLATE#{id}, SK = TEMPLATE#{id}

### Recurring Config

Fields:
- id: UUID, auto-generated
- description: string, required
- cronExpression: string, required (cron notation for schedule)
- assigneeId: string, optional
- enabled: boolean, defaults to true
- createdAt: ISO timestamp
- updatedAt: ISO timestamp

DynamoDB keys: PK = RECURRING#{id}, SK = RECURRING#{id}

### File

Fields:
- id: UUID, auto-generated
- taskId: string, required (links file to a task)
- filename: string, required
- category: "image", "invoice", or "document"
- tags: array of strings, optional
- storagePath: string, required (relative path in local filesystem, e.g., "uploads/{taskId}/{filename}")
- createdAt: ISO timestamp

Files are stored on the local filesystem under an `uploads/` directory (configurable via environment variable `UPLOAD_DIR`). In Lambda deployment, this maps to `/tmp/uploads` or an EFS mount. For local development, files are stored in `./uploads/`.

DynamoDB keys: PK = FILE#{id}, SK = FILE#{id}
GSI: TaskIndex with PK = taskId, SK = FILE#{id}

## API

All endpoints accept and return JSON. All endpoints are auth-gated - unauthenticated requests receive a 401 response.

### Tasks API

- `GET /api/tasks?date=YYYY-MM-DD` - list tasks for a specific date
- `GET /api/tasks?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD` - list tasks in a date range
- `POST /api/tasks` - create a task (body: { description, date, comment?, instructionsUrl?, link?, requiredLinkName?, source?, cardId?, assigneeId?, tags? })
- `GET /api/tasks/:id` - get a single task
- `PUT /api/tasks/:id` - update a task (body: subset of { description, date, status, comment, instructionsUrl, link, assigneeId, tags })
- `DELETE /api/tasks/:id` - archive a task (soft delete)

### Cards API

- `GET /api/cards` - list all cards
- `POST /api/cards` - create a card (body: { title, anchorDate, description?, templateId?, emoji?, references?, cardLinks?, tags? })
- `GET /api/cards/:id` - get a single card
- `PUT /api/cards/:id` - update a card (body: subset of { title, description, anchorDate, status, stage, emoji, references, cardLinks, tags })
- `PUT /api/cards/:id/archive` - archive a card
- `DELETE /api/cards/:id` - permanently delete (only archived cards)
- `GET /api/cards/:id/tasks` - list all tasks for a card

The references and cardLinks fields are arrays of objects: [{ name: "Overview doc", url: "https://..." }, ...].
When creating or updating a card, each array replaces the entire existing array.

### Templates API

- `GET /api/templates` - list all templates
- `POST /api/templates` - create a template (body: { name, type, emoji?, tags?, defaultAssigneeId?, references?, cardLinkDefinitions?, triggerType?, triggerSchedule?, triggerLeadDays?, taskDefinitions })
- `GET /api/templates/:id` - get a single template
- `PUT /api/templates/:id` - update a template (body: subset of { name, type, emoji, tags, defaultAssigneeId, references, cardLinkDefinitions, triggerType, triggerSchedule, triggerLeadDays, taskDefinitions })
- `DELETE /api/templates/:id` - delete a template

Each task definition: { refId, description, offsetDays, isMilestone?, assigneeId?, instructionsUrl?, requiredLinkName?, requiresFile? }.

### Recurring API

- `GET /api/recurring` - list all recurring configs
- `POST /api/recurring` - create a recurring config (body: { description, cronExpression, assigneeId? })
- `GET /api/recurring/:id` - get a single recurring config
- `PUT /api/recurring/:id` - update (body: subset of { description, cronExpression, assigneeId, enabled })
- `DELETE /api/recurring/:id` - delete a recurring config

### Files API

- `POST /api/files` - upload a file (multipart: file, taskId, category?, tags?) - stores file on local filesystem
- `GET /api/files?taskId=...` - list files for a task
- `GET /api/files?category=...&tag=...` - list files with filters
- `GET /api/files/:id` - get file metadata
- `GET /api/files/:id/download` - download the actual file
- `DELETE /api/files/:id` - delete a file (removes from filesystem and database)
