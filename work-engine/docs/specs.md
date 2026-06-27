# DataTasks - Product Specification

A unified task management application that combines the best aspects of Trello and todo lists, specifically designed for community managers and small teams.

## Background

The current workflow for Grace (community manager at DataTalks.Club) involves multiple disjointed systems:

- Google Spreadsheet for todo list
- Trello for project cards and tasks inside them
- Ad hoc tasks sent via Telegram
- Email forwarding creates additional tasks
- Regular recurring tasks (weekly mailchimp dumps, etc.)

To see what needs to be done today, Grace must check all of these separately. 

Existing tools (Trello, Monday, Asana, Jira) don't fit because:

- Ad hoc tasks can't be easily added to Trello without creating a full card
- Tasks are trapped inside cards - no unified view across all cards
- Integrations (Zapier, n8n) are paid and limited
- Need something simple and customizable

## Architecture

- Backend: AWS Lambda with JavaScript
- Database: DynamoDB
- Frontend: SPA with vanilla JavaScript (no React), served from the Lambda
- Deployment: Fully serverless - Lambda + DynamoDB, no hosting costs

### Local Development

- Local DynamoDB alternative that works like SQLite - no real DynamoDB needed
- No Docker required for development
- Local environment as close to Lambda as possible

### Deployment

- Deploy through Lambda and DynamoDB
- Docker acceptable for packaging if needed
- Fewer dependencies the better - ideally one Lambda, simple zip archive

### Testing

- Local testing should be easy and straightforward
- Integration testing: run Lambda in Docker and test through that

## Core Concepts

### Users

- Everyone is on the same team - all users can see tasks of others
- Adding users is manual via terminal/scripts - no signup flow needed
- When a user logs in, they see tasks assigned to them by default, but can toggle to see everything
- Anyone can execute any task even if it's assigned to somebody else

### Templates

Templates (playbooks) define reusable task sets for repeating workflows (newsletter, course, event, etc.).

- Displayed as cards (like bundles), not a table
- Card display format: emoji, tag, title - with anchor date shown as a separate UI element (badge/tag), not part of the title text
- Clicking a card opens it for editing, including arranging items within
- Can contain variables in the title (e.g., day)
- Each template has an anchor date - the main event day
- Tasks are set up relative to the anchor date
- Some tasks are "milestone tasks" fixed to the anchor date; other tasks are relative to these milestones
- Templates should have tags
- Default assignee per template, with customizable assignee per task
- Drag and drop to reorder tasks; when order changes, offset days update accordingly
- Each task definition has:
  - Description
  - Offset days (relative to anchor date)
  - Optional instructions URL (link to how-to document)
- Templates have two kinds of links:
  - References: fixed URLs that are the same for every bundle (process docs, server links, reference pages). Defined on the template, copied to every bundle.
  - Bundle links: links that need to be filled during execution, unique per bundle (e.g., Luma event URL, YouTube link). Template defines the link names; bundles fill in the URLs.
- Bundle creation triggers - two types:
  - Automatic: template has a schedule (cron expression) that auto-creates bundles. The schedule defines when to create the bundle relative to the anchor date. Examples: Newsletter (weekly, 14 days before publish), Social Media Weekly (weekly, Friday before), Tax Report (monthly, 1st of following month)
  - Manual: bundle is created by a person when a specific event happens (e.g., guest confirms a date, Alexey sends a recording). No schedule - user creates the bundle and sets the anchor date
- Some templates may not have a meaningful anchor date (e.g., Tax Report) - tasks are just sequential

### Bundles

A bundle is an instance of a template with a concrete anchor date. When created, all template tasks are generated with calculated due dates.

- Displayed as cards with same format as templates: emoji, tag, title - with anchor date as a separate badge
- Progress badge showing completed/total tasks
- Ordered/grouped by template type (which template they were created from)
- Inherit tags from templates
- Task dates calculated relative to the anchor date
- Links:
  - References: inherited from template, pre-filled (process docs, server links)
  - Bundle links: empty slots from template, filled during execution (e.g., Luma URL, YouTube link)
  - Users can add custom extra links beyond template-defined ones
- Can mark tasks as done within the bundle view
- No direct delete - flow: archive -> delete
- Bundles have stages that represent workflow progress:
  - "preparation": initial stage when bundle is created, tasks being set up
  - "announced": event has been announced publicly
  - "after-event": the main event/milestone has passed, post-event tasks remain
  - "done": all tasks completed
- Completing certain milestone tasks triggers automatic stage transitions (e.g., the "Actual stream" milestone moves bundle from "announced" to "after-event")
- Stage transitions can also be triggered manually

### Tasks

Three types with clear visual distinction:

Template-based tasks:
- Created automatically when a bundle is instantiated from a template
- Have relative deadlines calculated from anchor date
- Appear in both the bundle card and the unified task list

Ad-hoc tasks:
- Created via Telegram, email, or manually
- Standalone tasks not part of any bundle
- Should display "ad-hoc" label (not "untitled")
- Some require a link to the deliverable and cannot be marked as done without it (e.g., "publish article") - "required link" flag

Recurring tasks:
- Regular tasks (e.g., "weekly mailchimp dump" on Wednesdays)
- Automatically added to the task list on schedule
- Schedule uses cron notation for full granularity

All tasks:
- Each task has: date, description, status, optional comment, optional link
- Comment is not required at creation - can be added later
- Easy to see which bundle a task belongs to
- Compact display: less whitespace, more info on screen - Trello-style
- No delete action - only mark as done, archive, then delete if needed
- Filtering by date, tag, bundle, template, user, etc.
- Task completion requirements: some tasks require specific actions before they can be marked done:
  - Required link: task requires filling in a URL (e.g., "Create event on Luma" requires the Luma link to be added to the bundle)
  - Required file: task requires uploading a file
  - These requirements are defined in the template task definition and enforced in the UI

### Recurring Configs

- Define schedule using cron notation (not just daily/weekly/monthly)
- Enabled/disabled toggle
- No "Generate Tasks" button - tasks are generated automatically

### Files

- Attach files to tasks
- Files have tags for filtering
- Separate view for files with filtering and search
- Categories: images, invoices, other documents

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
- bundleId: string, optional (links task to a bundle)
- source: "manual", "template", "recurring", or "telegram"
- templateTaskRef: string, optional (refId from the template task definition)
- tags: array of strings, optional
- createdAt: ISO timestamp
- updatedAt: ISO timestamp

DynamoDB keys: PK = TASK#{id}, SK = TASK#{id}
GSI: DateIndex with PK = date, SK = TASK#{id}
GSI: BundleIndex with PK = bundleId, SK = TASK#{id}

### Bundle

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
- bundleLinks: array of { name: string, url: string }, optional (slots to fill during execution - e.g., Luma URL, YouTube link)
- tags: array of strings, optional (inherited from template)
- createdAt: ISO timestamp
- updatedAt: ISO timestamp

The bundle has two kinds of links:
- References: inherited from the template, pre-filled with fixed URLs (process docs, server links). Read-only in the bundle view.
- Bundle links: empty slots defined by the template's `bundleLinkDefinitions`, filled during execution. Each entry has a display name and a URL. When a task with `requiredLinkName` has its `link` filled, the corresponding bundle link is also updated.

DynamoDB keys: PK = BUNDLE#{id}, SK = BUNDLE#{id}

### Template

Fields:
- id: UUID, auto-generated
- name: string, required
- type: string, required (e.g., "newsletter", "podcast", "webinar")
- emoji: string, optional (e.g., "📰", "🎙️")
- tags: array of strings, optional
- defaultAssigneeId: string, optional (default user for tasks)
- references: array of { name: string, url: string }, optional (fixed links same for every bundle - process docs, server links)
- bundleLinkDefinitions: array of { name: string }, optional (bundle link slots to be filled during execution)
- taskDefinitions: array, required, each element:
  - refId: string, required (slug identifier)
  - description: string, required
  - offsetDays: number, required (relative to anchor date) -- comment. not required, automatically calculated based on milestones. but for milestones it's required. 
  - isMilestone: boolean, optional (if true, fixed to the anchor date)
  - stageOnComplete: string, optional (stage to transition bundle to when this milestone task is completed, e.g., "announced", "after-event", "done")
  - assigneeId: string, optional (overrides template default)
  - instructionsUrl: string, optional (URL to instruction document)
  - requiredLinkName: string, optional (name of the bundle link that must be filled before task can be completed, e.g., "Luma")
  - requiresFile: boolean, optional (if true, task cannot be completed without uploading a file)
- triggerType: "automatic" or "manual", defaults to "manual"
- triggerSchedule: string, optional (cron expression for auto-creating bundles, only for automatic triggers)
- triggerLeadDays: number, optional (how many days before anchor date to create the bundle, only for automatic triggers)
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
- `POST /api/tasks` - create a task (body: { description, date, comment?, instructionsUrl?, link?, requiredLinkName?, source?, bundleId?, assigneeId?, tags? })
- `GET /api/tasks/:id` - get a single task
- `PUT /api/tasks/:id` - update a task (body: subset of { description, date, status, comment, instructionsUrl, link, assigneeId, tags })
- `DELETE /api/tasks/:id` - archive a task (soft delete)

### Bundles API

- `GET /api/bundles` - list all bundles
- `POST /api/bundles` - create a bundle (body: { title, anchorDate, description?, templateId?, emoji?, references?, bundleLinks?, tags? })
- `GET /api/bundles/:id` - get a single bundle
- `PUT /api/bundles/:id` - update a bundle (body: subset of { title, description, anchorDate, status, stage, emoji, references, bundleLinks, tags })
- `PUT /api/bundles/:id/archive` - archive a bundle
- `DELETE /api/bundles/:id` - permanently delete (only archived bundles)
- `GET /api/bundles/:id/tasks` - list all tasks for a bundle

The references and bundleLinks fields are arrays of objects: [{ name: "Overview doc", url: "https://..." }, ...].
When creating or updating a bundle, each array replaces the entire existing array.

### Templates API

- `GET /api/templates` - list all templates
- `POST /api/templates` - create a template (body: { name, type, emoji?, tags?, defaultAssigneeId?, references?, bundleLinkDefinitions?, triggerType?, triggerSchedule?, triggerLeadDays?, taskDefinitions })
- `GET /api/templates/:id` - get a single template
- `PUT /api/templates/:id` - update a template (body: subset of { name, type, emoji, tags, defaultAssigneeId, references, bundleLinkDefinitions, triggerType, triggerSchedule, triggerLeadDays, taskDefinitions })
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

## UI

### Home Dashboard

The default landing page:
- Shows all active bundles on the left
- Shows all tasks assigned to the current user on the right
- Notifications appear above the task list (e.g., "Newsletter bundle auto-created for Mar 15", "Tax Report bundle auto-created for February")
  - Generated when automatic triggers create bundles
  - Dismissible by the user
- "Assigned to me" filter is on by default - can be toggled off to see everything
- Tasks ordered by date, with filtering by bundle, template, tag, etc.

### Task List View

Compact Trello-style display. Each task shows:
- Date
- Description (with markdown links rendered as clickable anchors)
- Bundle link (clickable, navigates to bundle detail) or "ad-hoc" badge
- Status checkbox
- Instructions URL (clickable link to instruction document, if present)
- Assignee
- Completion requirements (if any):
  - Required link: inline input field for the URL, pre-filled if the bundle link already has a value. The link name (e.g., "Luma") is shown as the field label. Task checkbox is disabled until the link is filled. When the link is saved, it also syncs to the bundle's bundleLinks array.
  - Required file: upload button. Task checkbox is disabled until the file is uploaded.

Note: comments are not shown in the task list view. They are low priority and mostly for ad-hoc tasks.

Filtering by: date/date range, tag, bundle, template, user.

When loading tasks, the app collects unique bundleId values and fetches bundle details to display bundle titles.

### Bundle List View

Cards ordered/grouped by template type. Each card shows title, anchor date, description preview, and progress badge. Clicking navigates to detail view.

### Bundle Detail View

- Bundle title, emoji, and anchor date
- Description (with markdown links)
- References section: read-only links inherited from template (process docs, server links)
- Bundle links section: fillable link slots defined by template. Inline input for each. Users can also add custom extra links.
- Tasks table: all bundle tasks with description, date, status toggle, instructions URL, and assignee
  - Tasks with a required link show an inline input field linked to the corresponding bundle link. Filling it updates the bundle's bundleLinks array. Checkbox disabled until filled.
  - Tasks with a required file show an upload button. Checkbox disabled until file is uploaded.
  - Task comments are not shown in the bundle detail view.

### Templates View

Cards (not a table). Each card shows name, type, tags, and task count. Clicking opens the template editor.

Template editor:
- Edit name, type, emoji, tags, default assignee
- Trigger config: trigger type (automatic/manual), cron expression, lead days
- References: manage fixed links (add/edit/remove)
- Bundle link definitions: manage link slot names (add/edit/remove)
- Task definitions list with drag-and-drop reordering
- Editing offset days, assignee overrides, milestone flag, requiredLinkName, requiresFile per task

### Recurring View

List of recurring configs with description, cron expression, and enabled toggle.

### Files View

Separate view with:
- Filtering by category (images, invoices, documents) and tags
- Search by filename
- File previews where applicable

### Markdown Link Rendering

Text fields (task description, task comment, bundle description) support markdown-style links: `[text](url)`. These are rendered as clickable HTML anchor tags that open in a new tab.

The rendering function first escapes all HTML to prevent XSS, then converts markdown link patterns to anchor tags. Only the `[text](url)` pattern is supported - no other markdown formatting.

## Migration

The migration script (scripts/migrate-data.js) imports data from a Trello board export and CSV spreadsheets.

Known issues to fix:
- Template names are not properly extracted from Trello
- Links are not extracted from Trello cards

### Date Handling

When converting Trello cards to bundles, the anchor date is determined by this fallback chain:
1. card.due (explicit due date)
2. Date extracted from card name (e.g., "2026-Feb-15")
3. card.dateLastActivity (when the card was last modified)

The same chain applies when assigning dates to checklist item tasks. Using dateLastActivity as the final fallback preserves historical information about when the card was actually active.

### Instruction URL Extraction

Trello checklist items often contain markdown links to instruction documents. The migration extracts these:

Pattern: item name contains `[text](url)` - the first such link is extracted as instructionsUrl. The link text and parentheses are removed from the description.

Example input: "Create a MailChimp campaign ([link](https://docs.google.com/...))"
Result: description = "Create a MailChimp campaign", instructionsUrl = "https://docs.google.com/..."

The extracted instructionsUrl is stored on the template task definition. When tasks are instantiated, the URL is copied to the task's `instructionsUrl` field. For active card tasks (not templates), the instructionsUrl is stored directly in the task's `instructionsUrl` field.

### Bundle Links from Attachments

Trello cards have an attachments array. Non-image attachments (non-Trello URLs) are extracted as bundle links: { name: attachment.name, url: attachment.url }. Trello-hosted attachments (URLs matching trello.com/1/cards/) are skipped.

## Automatic Bundle Creation

Templates with `triggerType: "automatic"` have bundles created automatically on a schedule. The `triggerSchedule` (cron expression) defines when to create bundles, and `triggerLeadDays` defines how many days before the anchor date the bundle should be created.

Implementation: AWS EventBridge Scheduler rules that invoke the Lambda on a schedule. For local development, a simple cron runner script that polls and creates bundles.

When a bundle is auto-created, a notification is generated (e.g., "Newsletter bundle auto-created for Mar 15") that appears on the home dashboard.

## Users

Users are manually created via a seed script. No signup flow needed. Three initial users:
- Grace: community manager, does most of the work
- Valeriia: handles newsletter content, social media
- Alexey: project owner, handles podcast uploads, Maven content

All users can see all tasks. Default view shows tasks assigned to the current user.

## Future Extensions

- Invoice tracking and reminders for pending invoices
- Could be separate or integrated into the task system
