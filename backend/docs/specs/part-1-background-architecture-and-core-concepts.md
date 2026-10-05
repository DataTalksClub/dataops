> Part 1 of 3 of the [DataTasks Product Specification](../specs.md),
> covering the background, architecture, and core concepts. The data model
> and API are in [Part 2](part-2-data-model-and-api.md), and the UI,
> migration, and future extensions are in
> [Part 3](part-3-ui-migration-and-extensions.md).

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

- Displayed as cards (like cards), not a table
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
  - References: fixed URLs that are the same for every card (process docs, server links, reference pages). Defined on the template, copied to every card.
  - Card links: links that need to be filled during execution, unique per card (e.g., Luma event URL, YouTube link). Template defines the link names; cards fill in the URLs.
- Card creation triggers - two types:
  - Automatic: template has a schedule (cron expression) that auto-creates cards. The schedule defines when to create the card relative to the anchor date. Examples: Newsletter (weekly, 14 days before publish), Social Media Weekly (weekly, Friday before), Tax Report (monthly, 1st of following month)
  - Manual: card is created by a person when a specific event happens (e.g., guest confirms a date, Alexey sends a recording). No schedule - user creates the card and sets the anchor date
- Some templates may not have a meaningful anchor date (e.g., Tax Report) - tasks are just sequential

### Cards

A card is an instance of a template with a concrete anchor date. When created, all template tasks are generated with calculated due dates.

- Displayed as cards with same format as templates: emoji, tag, title - with anchor date as a separate badge
- Progress badge showing completed/total tasks
- Ordered/grouped by template type (which template they were created from)
- Inherit tags from templates
- Task dates calculated relative to the anchor date
- Links:
  - References: inherited from template, pre-filled (process docs, server links)
  - Card links: empty slots from template, filled during execution (e.g., Luma URL, YouTube link)
  - Users can add custom extra links beyond template-defined ones
- Can mark tasks as done within the card view
- No direct delete - flow: archive -> delete
- Cards have stages that represent workflow progress:
  - "preparation": initial stage when card is created, tasks being set up
  - "announced": event has been announced publicly
  - "after-event": the main event/milestone has passed, post-event tasks remain
  - "done": all tasks completed
- Completing certain milestone tasks triggers automatic stage transitions (e.g., the "Actual stream" milestone moves card from "announced" to "after-event")
- Stage transitions can also be triggered manually

### Tasks

Three types with clear visual distinction:

Template-based tasks:
- Created automatically when a card is instantiated from a template
- Have relative deadlines calculated from anchor date
- Appear in both the card card and the unified task list

Ad-hoc tasks:
- Created via Telegram, email, or manually
- Standalone tasks not part of any card
- Should display "ad-hoc" label (not "untitled")
- Some require a link to the deliverable and cannot be marked as done without it (e.g., "publish article") - "required link" flag

Recurring tasks:
- Regular tasks (e.g., "weekly mailchimp dump" on Wednesdays)
- Automatically added to the task list on schedule
- Schedule uses cron notation for full granularity

All tasks:
- Each task has: date, description, status, optional comment, optional link
- Comment is not required at creation - can be added later
- Easy to see which card a task belongs to
- Compact display: less whitespace, more info on screen - Trello-style
- No delete action - only mark as done, archive, then delete if needed
- Filtering by date, tag, card, template, user, etc.
- Task completion requirements: some tasks require specific actions before they can be marked done:
  - Required link: task requires filling in a URL (e.g., "Create event on Luma" requires the Luma link to be added to the card)
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
