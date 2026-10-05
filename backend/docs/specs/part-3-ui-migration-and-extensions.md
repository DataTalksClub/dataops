> Part 3 of 3 of the [DataTasks Product Specification](../specs.md),
> covering the UI, migration, and future extensions. The background,
> architecture, and core concepts are in
> [Part 1](part-1-background-architecture-and-core-concepts.md), and the
> data model and API are in [Part 2](part-2-data-model-and-api.md).

## UI

### Home Dashboard

The default landing page:
- Shows all active cards on the left
- Shows all tasks assigned to the current user on the right
- Notifications appear above the task list (e.g., "Newsletter card auto-created for Mar 15", "Tax Report card auto-created for February")
  - Generated when automatic triggers create cards
  - Dismissible by the user
- "Assigned to me" filter is on by default - can be toggled off to see everything
- Tasks ordered by date, with filtering by card, template, tag, etc.

### Task List View

Compact Trello-style display. Each task shows:
- Date
- Description (with markdown links rendered as clickable anchors)
- Card link (clickable, navigates to card detail) or "ad-hoc" badge
- Status checkbox
- Instructions URL (clickable link to instruction document, if present)
- Assignee
- Completion requirements (if any):
  - Required link: inline input field for the URL, pre-filled if the card link already has a value. The link name (e.g., "Luma") is shown as the field label. Task checkbox is disabled until the link is filled. When the link is saved, it also syncs to the card's cardLinks array.
  - Required file: upload button. Task checkbox is disabled until the file is uploaded.

Note: comments are not shown in the task list view. They are low priority and mostly for ad-hoc tasks.

Filtering by: date/date range, tag, card, template, user.

When loading tasks, the app collects unique cardId values and fetches card details to display card titles.

### Card List View

Cards ordered/grouped by template type. Each card shows title, anchor date, description preview, and progress badge. Clicking navigates to detail view.

### Card Detail View

- Card title, emoji, and anchor date
- Description (with markdown links)
- References section: read-only links inherited from template (process docs, server links)
- Card links section: fillable link slots defined by template. Inline input for each. Users can also add custom extra links.
- Tasks table: all card tasks with description, date, status toggle, instructions URL, and assignee
  - Tasks with a required link show an inline input field linked to the corresponding card link. Filling it updates the card's cardLinks array. Checkbox disabled until filled.
  - Tasks with a required file show an upload button. Checkbox disabled until file is uploaded.
  - Task comments are not shown in the card detail view.

### Templates View

Cards (not a table). Each card shows name, type, tags, and task count. Clicking opens the template editor.

Template editor:
- Edit name, type, emoji, tags, default assignee
- Trigger config: trigger type (automatic/manual), cron expression, lead days
- References: manage fixed links (add/edit/remove)
- Card link definitions: manage link slot names (add/edit/remove)
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

Text fields (task description, task comment, card description) support markdown-style links: `[text](url)`. These are rendered as clickable HTML anchor tags that open in a new tab.

The rendering function first escapes all HTML to prevent XSS, then converts markdown link patterns to anchor tags. Only the `[text](url)` pattern is supported - no other markdown formatting.

## Migration

The migration script (scripts/migrate-data.js) imports data from a Trello board export and CSV spreadsheets.

Known issues to fix:
- Template names are not properly extracted from Trello
- Links are not extracted from Trello cards

### Date Handling

When converting Trello cards to cards, the anchor date is determined by this fallback chain:
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

### Card Links from Attachments

Trello cards have an attachments array. Non-image attachments (non-Trello URLs) are extracted as card links: { name: attachment.name, url: attachment.url }. Trello-hosted attachments (URLs matching trello.com/1/cards/) are skipped.

## Automatic Card Creation

Templates with `triggerType: "automatic"` have cards created automatically on a schedule. The `triggerSchedule` (cron expression) defines when to create cards, and `triggerLeadDays` defines how many days before the anchor date the card should be created.

Implementation: AWS EventBridge Scheduler rules that invoke the Lambda on a schedule. For local development, a simple cron runner script that polls and creates cards.

When a card is auto-created, a notification is generated (e.g., "Newsletter card auto-created for Mar 15") that appears on the home dashboard.

## Users

Users are manually created via a seed script. No signup flow needed. Three initial users:
- Grace: community manager, does most of the work
- Valeriia: handles newsletter content, social media
- Alexey: project owner, handles podcast uploads, Maven content

All users can see all tasks. Default view shows tasks assigned to the current user.

## Future Extensions

- Invoice tracking and reminders for pending invoices
- Could be separate or integrated into the task system
