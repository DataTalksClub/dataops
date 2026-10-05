> Part 2 of 3 of the [Operations Manager JTBD spec](part-1-user-context-and-daily-loop.md):
> Part 1 (entry) is the user context and the daily operating loop;
> Part 3 covers [screens, pain points, and roadmap](part-3-screens-pain-points-and-roadmap.md).

## Jobs To Be Done

### JTBD 1: Start the day with one operational queue

When I start my workday, I want one prioritized queue of due, overdue,
follow-up, and at-risk tasks, so I do not need to check Trello, a spreadsheet,
Telegram, email, and process docs separately.

Platform actions:

- Show "Today", "Overdue", "Follow-ups due", and "At risk workflows".
- Default to assigned-to-me plus unassigned urgent work.
- Allow switching to all team work.
- Let the user open a task in workflow context.

Acceptance criteria:

- Dashboard loads without requiring a search.
- Tasks are grouped by urgency, not just by source.
- Each task shows the workflow title or "ad hoc".
- Each task shows the next required click: complete, add link, upload file,
  follow up, or open workflow.
- Empty states tell the operator what is clear, for example "No follow-ups due".

### JTBD 2: Turn a repeatable operation into a workflow run

When a known trigger happens, I want to start a workflow from a template, so the
right tasks are created at the right offsets and I do not need to copy a Trello
card manually.

Triggers:

- Newsletter issue enters the 14-day preparation window.
- Social media weekly tasks are generated.
- Monthly tax report starts on the first of the month.
- Guest confirms a podcast, webinar, workshop, office hours, OSS, course, or
  Maven lightning lesson date.
- Book author agrees and a date is chosen.
- Sponsor slot is assigned.

Platform actions:

- Click "New workflow".
- Select a template.
- Enter the anchor date and required variables.
- Review generated tasks.
- Create the card.

Acceptance criteria:

- Automatic templates are generated from their cron schedules.
- Manual templates require a person to create a card and set the anchor date.
- Generated tasks inherit instructions, required links, required files,
  assignee defaults, and tags.
- The created workflow appears immediately in active workflows.
- The workflow title follows a predictable naming pattern.

### JTBD 3: Know exactly what is blocking a workflow

When I open an active workflow, I want to see missing inputs, next tasks, due
dates, waiting items, and required artifacts in one place, so I can move it
forward without reconstructing state from memory.

Platform actions:

- Open a card from the dashboard.
- Review progress, stage, anchor date, links, references, tasks, and comments.
- Save card links such as Luma, Meetup, YouTube, Mailchimp, sponsorship doc,
  publisher, Dropbox, Airtable, or website URL.
- Complete active tasks from the checklist.

Acceptance criteria:

- Workflow detail shows stage, progress, next due task, overdue count, and
  waiting count.
- Workflow links are shown above the checklist.
- Required card links are visibly empty until filled.
- Process docs are available as contextual instruction icons on the relevant
  tasks.
- Completed tasks are retained for audit but do not distract from active work.

### JTBD 4: Follow up when people do not reply

When a guest, sponsor, speaker, author, publisher, freelancer, or internal
reviewer does not reply, I want the task to come back at the right time, so
waiting does not become forgetting.

Platform actions:

- Click "Waiting" on a task.
- Choose who the task is waiting for.
- Set a follow-up date.
- Add the last contact channel and note.
- When follow-up is due, click "Send follow-up" or "Mark response received".

Acceptance criteria:

- Waiting tasks are not counted as done.
- Waiting tasks are not hidden from workflow progress.
- Follow-up due tasks appear on the dashboard.
- A follow-up action records timestamp, channel, and note.
- The user can snooze with a reason.
- A task can be moved back from waiting to todo when a response is received.

### JTBD 5: Complete tasks with proof

When I finish a task, I want to save the proof of completion at the same time,
so the next person and future me can verify what was done.

Proof types:

- URL, for example Luma event, Meetup event, YouTube stream, Mailchimp campaign,
  LinkedIn post, X post, Airtable record, schedule spreadsheet, podcast page,
  Spotify link, Apple Podcasts link, GitHub page, or Google Doc.
- File, for example invoice, receipt, statement, banner, transcription,
  recording, edited audio, zip package, or screenshot.
- Comment, for example "sponsor asked for changes" or "guest requested a new
  date".
- External status, for example schedule changed to confirmed or newsletter
  campaign scheduled.

Platform actions:

- Paste the URL into the required link field.
- Upload or attach a required file.
- Add a comment when needed.
- Click the checkbox.

Acceptance criteria:

- The app blocks completion when required proof is missing.
- The app tells the user which proof is missing.
- Proof is visible from both the task row and workflow detail.
- Completing a proof task updates the related card link when applicable.
- Completion history includes user and timestamp.

### JTBD 6: Handle recurring operations without remembering schedules

When a periodic duty is due, I want the platform to generate it and remind me,
so repeated maintenance work is not dependent on memory.

Recurring work from current sources:

- Weekly newsletter preparation.
- Weekly social media schedule.
- Monthly tax report.
- Daily or near-daily Slack invite handling from Airtable.
- Daily review of new Trello/cards/tasks from historical spreadsheet behavior.
- Monthly Slack dump.
- Periodic sponsor performance follow-up.
- Periodic checking of invoices, receipts, Dropbox folders, and bookkeeping
  TODO values.

Platform actions:

- Admin creates or edits recurring configs.
- Cron creates tasks automatically.
- Operator sees generated tasks on the dashboard.
- Operator completes them with proof or comments.

Acceptance criteria:

- Recurring configs use cron expressions.
- Recurring configs can be enabled and disabled.
- Duplicate tasks are skipped for the same schedule window.
- Generated tasks show source `recurring`.
- Generated tasks have due dates, owners, and instructions where applicable.

### JTBD 7: Use process docs only at the moment of need

When I am unsure how to do a task, I want the relevant SOP opened from the task,
so docs help me finish work instead of becoming a separate place to browse.

Platform actions:

- Click the instructions icon on a task.
- View the relevant private SOP/template/reference inside the authenticated
  app.
- Return to the workflow and complete the task.

Acceptance criteria:

- Every template task that has an SOP exposes a direct instructions link.
- Search is available when a task does not have a mapped SOP.
- The workflow remains the primary screen.
- Docs are contextual help, not the main navigation model.
- The UI does not expose private repo paths or require the operator to
  understand where the doc is stored.

### JTBD 8: Improve the process when a gap is found

When I discover that a task or process is unclear, missing, or wrong, I want to
capture a process improvement without interrupting operations, so the system
gets better over time.

Platform actions:

- Click "Report process gap" from a task or doc.
- Enter what was missing or wrong.
- Link it to the task, workflow, and source SOP.
- Create a private knowledge-repo issue or internal improvement task when the
  gap contains operational details; public GitHub issues may contain only
  sanitized product/code work.

Acceptance criteria:

- Process gaps are linked to the task where they were discovered.
- The operator can continue the workflow after filing the gap.
- Gaps can be reviewed later by maintainers.
- Repeated gaps can become template updates or SOP updates.

## Reminder Model

The platform needs multiple reminder types. A single notification bell is not
enough unless the underlying reminder semantics are explicit.

### Due reminders

Purpose: show tasks whose due date is today.

Examples:

- Schedule newsletter one day before Monday send.
- Remind guest seven days before event.
- Remind guest one day before event.
- Create invoice on publication day.
- Select book winners on Friday of book week.
- Prepare monthly tax report tasks from the first day of the month.

Acceptance criteria:

- Due reminders appear on the dashboard on the due date.
- Due reminders remain visible until the task is done or waiting.
- Due reminders include workflow context.

### Overdue reminders

Purpose: catch tasks that were not closed on time.

Acceptance criteria:

- Overdue tasks are grouped separately.
- Overdue tasks cannot be dismissed as notifications without changing the task.
- Overdue severity increases after configurable thresholds, for example 1 day,
  3 days, and 7 days late.
- Overdue workflow cards show a visible risk indicator.

### Follow-up reminders

Purpose: bring back tasks that are waiting for someone else.

Examples:

- Guest has not confirmed a proposed date.
- Sponsor has not sent content.
- Author has not answered book-of-the-week coordination.
- Publisher has not received winner emails.
- Freelancer has not returned transcription.
- Alexey has not uploaded or reviewed a recording.
- Accountant has not acknowledged monthly report.

Acceptance criteria:

- Follow-up reminder requires a waiting state and follow-up date.
- Follow-up reminder appears even if the task due date is in the future.
- User can record "follow-up sent" without completing the task.
- User can set the next follow-up date after sending a follow-up.

### Missing evidence reminders

Purpose: catch tasks that were performed externally but not recorded in
DataOps.

Examples:

- Luma event was created but no Luma link is saved.
- LinkedIn post was scheduled but no post link is saved.
- Mailchimp campaign exists but no campaign link is saved.
- Invoice was sent but no invoice file/link is attached.
- Recording was edited but output file is not attached.
- Tax report zip was prepared but not linked or attached.

Acceptance criteria:

- Tasks with required links/files cannot be completed until proof exists.
- Workflows show empty required links as missing evidence.
- Missing evidence reminders are separate from normal due reminders.

### Stage-change reminders

Purpose: move workflow attention when a milestone changes the type of work.

Examples:

- Event announced: pre-event publication and reminder work starts.
- Actual stream completed: post-event editing and publishing work starts.
- Newsletter sent: invoice, social posts, performance report work starts.
- Book event week begins: daily Slack/community tasks become active.
- Tax package sent: accountant confirmation and folder cleanup remain.

Acceptance criteria:

- Completing a milestone can move the card to the next stage.
- Stage changes create or surface the next group of tasks.
- Stage changes are logged.
- Manual stage override requires a comment.

### Automation failure reminders

Purpose: surface when the platform failed to generate or sync expected work.

Examples:

- Cron failed to create newsletter tasks.
- Duplicate protection skipped a task unexpectedly.
- Template import failed.
- Search index build failed.
- External webhook payload was malformed.

Acceptance criteria:

- Automation failure notifications are visible to admins/operators.
- They include enough context to retry or file an issue.
- They are not mixed with ordinary task reminders without severity.

## Task Status Model

The current code has `todo`, `done`, and `archived`. The operating model needs
more visible user states, even if some are initially implemented as fields on a
todo task.

Recommended states:

- `todo`: ready to work.
- `in_progress`: someone is actively doing it.
- `waiting`: blocked on another person or external event.
- `blocked`: cannot proceed because access, inputs, or process are missing.
- `done`: accepted and closed with required proof.
- `archived`: no longer active, retained for history.

Minimum V1 if data model changes are deferred:

- Keep stored `status` as `todo`, `done`, `archived`.
- Add fields: `stateReason`, `waitingFor`, `followUpAt`, `blockedReason`,
  `completedBy`, `completedAt`.
- Treat a task with `followUpAt` and not done as waiting in the UI.

Task close rules:

- If `requiredLinkName` exists, `link` must be non-empty.
- If `requiresFile` is true, at least one file must be attached.
- If the task is waiting, it must be moved back to todo or done before closure.
- If the task is a milestone with `stageOnComplete`, completing it changes or
  proposes the card stage.
- If the task produces a card link, completion should sync the task link into
  the card link slot.

## Workflow Card Behavior

A card is the operator's main unit of work. It represents a concrete instance
of a repeatable operation, such as "Newsletter #180", "Podcast with guest X",
"Monthly tax report May 2026", or "Book of the Week: book Y".

Every active card should show:

- title;
- type and tags;
- anchor date;
- current stage;
- owner or default assignee;
- progress count;
- overdue count;
- waiting count;
- next due task;
- missing required links;
- missing required files;
- fixed process references;
- workflow-specific links;
- active task checklist;
- done task history;
- comments and audit events.

Card actions:

- Start from template.
- Open from dashboard.
- Edit links.
- Add an ad-hoc task to the card.
- Mark task done.
- Mark task waiting.
- Add comment.
- Upload file.
- Advance stage.
- Archive when done.

Acceptance criteria:

- The operator does not need to switch to the generic task list to complete a
  workflow task.
- The operator can see why a card is not done.
- A card cannot be marked done while active tasks remain unfinished.
- A card cannot be marked done while required links/files are missing.
- A done card can be archived but remains searchable.

