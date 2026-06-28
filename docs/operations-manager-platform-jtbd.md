# DataOps Platform: Operations Manager JTBD and Usage Spec

## Purpose

This document defines how the DataOps platform should be used by the
DataTalksClub operations manager. It is not a domain SOP and it is not a list of
content folders. It describes the product experience: what the operator sees
every day, what actions they perform, what reminders the system sends, what
they click to close work, and what the platform must prevent them from
forgetting.

The goal is a unified operations workspace where docs, task templates,
recurring work, reminders, external links, files, and assistant-generated
artifacts are part of one flow.

## Source Material Used

The analysis is grounded in:

- `work-engine/docs/specs.md`: imported source product problem, data model, task
  types, templates, bundles, recurring configs, required links, required files,
  stages, and dashboard goals.
- `work-engine/docs/data.md`: Trello board and spreadsheet analysis, including
  active columns, templates, open tasks, completed recurring tasks, and daily
  spreadsheet behavior.
- `work-engine/docs/templates.md`: canonical workflow templates for newsletter,
  podcast, webinar, workshop, book of the week, OSS, course, social media, tax
  report, Maven lightning lesson, and office hours.
- `work-engine/src/types.ts`: current platform objects for tasks, bundles,
  templates, recurring configs, users, files, and notifications.
- `work-engine/src/public/app.js`: current SPA behavior for dashboard, tasks,
  bundles, templates, recurring configs, notifications, required links, and
  completion checkboxes.
- `content/tasks/templates/*.md`: imported task templates and due-date offsets.
- `content/overview/reference/*.md`: schedule, newsletter, and operations
  reference material.
- `content/**/sops/*.md` and `content/**/templates/*.md`: process documents
  used as contextual instructions.
- `assistants/podcast/README.md`, `assistants/podcast/process/podcast.md`, and
  `assistants/podcast/templates/podcast_guest_intake.md`: assistant pattern for
  turning raw inputs into prepared operating documents.

## The User

The primary user is the DataTalksClub operations manager. The existing
The imported work-engine specification names this person as Grace, but the
product should not be built around one hard-coded person. The role is:

- Keeps weekly community operations moving.
- Coordinates guests, speakers, sponsors, authors, publishers, assistants, and
  internal reviewers.
- Works across Trello-like workflow cards, a spreadsheet-like task list,
  Google Docs, Google Sheets, Google Calendar, Slack, Mailchimp, Luma, Meetup,
  YouTube, Spotify, Airtable, Dropbox, Figma, LinkedIn, X, Finom, Revolut, Wise,
  email, Telegram, and GitHub-backed process docs.
- Handles both planned workflows and ad-hoc incoming requests.
- Needs to know what to do now, what is waiting for someone else, what is late,
  what needs a reminder, and what proof is required before something can be
  considered done.

The user is not trying to browse documentation. They are trying to operate the
club without missing handoffs.

## The Core Platform Job

When the operations manager opens DataOps, they need to answer four questions
within a few seconds:

1. What must I do today?
2. What is late or blocked?
3. Who needs a follow-up because they have not replied or provided an asset?
4. Which active workflows are at risk because a required link, file, approval,
   or status update is missing?

The platform should turn scattered operations into a single work queue:

- process docs explain how to do a step;
- task templates create the step at the right time;
- recurring configs create periodic operational work;
- reminders bring work back when someone has not replied;
- bundle links collect the artifacts produced by work;
- files and comments preserve evidence;
- notifications surface risk and deadlines;
- the dashboard gives the operator the next action.

## Current Platform Capabilities

The current code already contains useful primitives:

- Login and session-based access.
- Dashboard route with active bundles and tasks due today.
- "Assigned to me" behavior on the dashboard.
- Task list with date, range, status, assignee, and bundle filters.
- Ad-hoc task creation.
- Bundle list and bundle detail pages.
- Template list and template editor.
- Recurring config page.
- Notification bell and notification page.
- Task checkboxes to mark done or todo.
- Required link fields that block completion until a URL is saved.
- Bundle links that store workflow-specific URLs.
- Template references that point to fixed process docs.
- Task instructions URLs that open process docs.
- Stage transitions for bundles, including preparation, announced,
  after-event, and done.
- File records in the data model.

These primitives are not enough by themselves. The platform still needs a
clear operator workflow, reminder semantics, follow-up semantics, and
acceptance criteria for "done".

## The Daily Operating Loop

### 1. Open the dashboard

The operations manager signs in and lands on an operations dashboard, not a docs
tree.

The dashboard must show:

- Today: tasks assigned to the user and unassigned tasks due today.
- Overdue: tasks with due dates before today that are not done.
- Waiting: tasks blocked on a guest, sponsor, author, speaker, publisher,
  internal reviewer, freelancer, accountant, or Alexey.
- Follow-ups due: waiting tasks whose follow-up date is today or earlier.
- Active workflows: bundles grouped by risk and next due action.
- Recurring operations: generated periodic tasks that need attention.
- Notifications: new risk alerts, missed deadlines, generated workflow runs,
  and failed automations.

Expected user action:

- Click a task to open its workflow context.
- Click a workflow to see its timeline and all missing artifacts.
- Click "Complete" only after required evidence is present.
- Click "Waiting" when the next step depends on someone else.
- Click "Follow up" or "Snooze" when a reminder has been sent.

Acceptance criteria:

- The user can tell the next action without opening Trello, Google Sheets, or a
  docs folder first.
- Overdue tasks are visually separate from normal today tasks.
- Waiting tasks do not disappear from the operator's attention.
- A workflow with missing required links or files is marked at risk.
- A dismissed notification does not hide the underlying overdue or blocked
  state.

### 2. Triage overdue and at-risk work

The operator starts with risks because these are the tasks that cause public
mistakes.

Common risks from the source processes:

- A guest, author, speaker, or sponsor has not replied.
- An event date was proposed but not confirmed.
- The schedule spreadsheet status was not changed to confirmed.
- A required public event page link was not saved.
- A social post was scheduled but its link was not captured.
- A newsletter sponsor document is missing or not reviewed.
- A podcast, webinar, or workshop has no Luma, Meetup, YouTube, or website link.
- A recording exists but was not uploaded, edited, transcribed, or published.
- A tax report still contains TODO values.
- A finance transaction exists without an invoice, receipt, statement, or EUR
  value.
- A post-event sponsor performance report was not sent.
- Winners were selected but publisher handoff did not happen.

Expected user action:

- Open each risk item.
- Decide whether the task can be completed now, needs a follow-up, needs a
  comment, needs a missing link, or needs reassignment.
- Save the next follow-up date if waiting.
- Complete the task only when the acceptance criteria are met.

Acceptance criteria:

- A task can be moved from `todo` to `waiting` without being marked done.
- Waiting tasks require `waitingFor`, `followUpAt`, and a short note.
- A waiting task appears again on the dashboard when `followUpAt` arrives.
- A task that is overdue and waiting is shown as "follow-up due", not just
  "overdue".
- Completing a task with a required link is blocked until the URL exists.
- Completing a task with a required file is blocked until a file is attached.

### 3. Work through today's tasks

After risks, the operator handles normal due work.

The platform should show each task with:

- status;
- due date;
- assignee;
- workflow bundle;
- source: template, recurring, manual, email, Telegram, assistant, or import;
- instructions link;
- required evidence;
- comments;
- next follow-up date;
- related external links;
- one-click access to the workflow detail.

Expected user action:

- Read the task.
- Open instructions only if needed.
- Perform the external action.
- Paste the resulting link or upload the resulting file.
- Add a comment if the task outcome needs context.
- Click the completion checkbox.

Acceptance criteria:

- The completion action is a deliberate click in the task row or workflow
  checklist.
- The app explains why completion is blocked, for example "Add Luma link first".
- Completing a milestone task can advance the workflow stage.
- Completed tasks move below active tasks in the workflow detail.
- The system records who completed the task and when.

### 4. Process incoming work

Incoming work arrives from people and systems:

- Telegram messages.
- Emails forwarded into the task system.
- New guest or sponsor recommendations.
- Alexey assigning an ad-hoc task.
- A guest sending assets.
- A sponsor sending copy.
- A freelancer sending transcription output.
- A finance document landing in Dropbox.
- A process correction discovered while doing work.

Expected user action:

- Convert the incoming item into either an ad-hoc task or a workflow bundle.
- Attach the source message or paste the source link.
- Assign an owner and due date.
- If the item belongs to an active workflow, attach it to the bundle instead of
  leaving it as a standalone task.
- If it creates a new repeatable pattern, flag it as a template/process
  improvement.

Acceptance criteria:

- The user can create an ad-hoc task in less than one minute.
- The user can attach an ad-hoc task to an existing workflow.
- The user can create a new workflow bundle from a template when a trigger
  occurs.
- The user can mark an incoming item as "needs clarification" with a follow-up
  date.
- The system preserves the source channel and source link.

### 5. End-of-day review

Before stopping work, the operator should leave the system in a state where
tomorrow's risks are visible.

Expected user action:

- Review open tasks due today.
- Mark finished tasks done.
- Move blocked tasks to waiting with follow-up dates.
- Add notes to tasks that cannot be completed yet.
- Check whether tomorrow has urgent tasks.
- Confirm no workflow is missing a required artifact before its next milestone.

Acceptance criteria:

- The dashboard can be filtered to "unfinished today".
- The user can bulk review tasks that are due today but not done.
- Every unfinished task has either a reason, a follow-up date, or an owner.
- The platform can show "no unresolved today tasks" only when all due tasks are
  done or intentionally waiting.

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
- Create the bundle.

Acceptance criteria:

- Automatic templates are generated from their cron schedules.
- Manual templates require a person to create a bundle and set the anchor date.
- Generated tasks inherit instructions, required links, required files,
  assignee defaults, and tags.
- The created workflow appears immediately in active workflows.
- The workflow title follows a predictable naming pattern.

### JTBD 3: Know exactly what is blocking a workflow

When I open an active workflow, I want to see missing inputs, next tasks, due
dates, waiting items, and required artifacts in one place, so I can move it
forward without reconstructing state from memory.

Platform actions:

- Open a bundle from the dashboard.
- Review progress, stage, anchor date, links, references, tasks, and comments.
- Save bundle links such as Luma, Meetup, YouTube, Mailchimp, sponsorship doc,
  publisher, Dropbox, Airtable, or website URL.
- Complete active tasks from the checklist.

Acceptance criteria:

- Workflow detail shows stage, progress, next due task, overdue count, and
  waiting count.
- Workflow links are shown above the checklist.
- Required bundle links are visibly empty until filled.
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
- Completing a proof task updates the related bundle link when applicable.
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
- Weekly Mailchimp mailing list backup.
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
- View the relevant SOP/template/reference.
- Return to the workflow and complete the task.

Acceptance criteria:

- Every template task that has an SOP exposes a direct instructions link.
- Search is available when a task does not have a mapped SOP.
- The workflow remains the primary screen.
- Docs are contextual help, not the main navigation model.

### JTBD 8: Improve the process when a gap is found

When I discover that a task or process is unclear, missing, or wrong, I want to
capture a process improvement without interrupting operations, so the system
gets better over time.

Platform actions:

- Click "Report process gap" from a task or doc.
- Enter what was missing or wrong.
- Link it to the task, workflow, and source SOP.
- Create a GitHub issue or internal improvement task.

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

- Completing a milestone can move the bundle to the next stage.
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
  proposes the bundle stage.
- If the task produces a bundle link, completion should sync the task link into
  the bundle link slot.

## Workflow Bundle Behavior

A bundle is the operator's main unit of work. It represents a concrete instance
of a repeatable operation, such as "Newsletter #180", "Podcast with guest X",
"Monthly tax report May 2026", or "Book of the Week: book Y".

Every active bundle should show:

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

Bundle actions:

- Start from template.
- Open from dashboard.
- Edit links.
- Add an ad-hoc task to the bundle.
- Mark task done.
- Mark task waiting.
- Add comment.
- Upload file.
- Advance stage.
- Archive when done.

Acceptance criteria:

- The operator does not need to switch to the generic task list to complete a
  workflow task.
- The operator can see why a bundle is not done.
- A bundle cannot be marked done while active tasks remain unfinished.
- A bundle cannot be marked done while required links/files are missing.
- A done bundle can be archived but remains searchable.

## Platform Screens

### Dashboard

Primary job: daily command center.

Must include:

- Today tasks.
- Overdue tasks.
- Follow-ups due.
- Active workflows at risk.
- Active workflows by next action.
- Notification summary.
- Quick create ad-hoc task.
- Quick start workflow.

Important clicks:

- Complete task.
- Add required link.
- Mark waiting.
- Open workflow.
- Create task.
- Start workflow.
- Dismiss notification after resolving or acknowledging it.

### Task List

Primary job: inspect and manage tasks across time.

Must include:

- Date and date-range filters.
- Status/state filters.
- Assignee filter.
- Bundle filter.
- Source filter.
- Search.
- Inline required link field.
- Completion checkbox.
- Waiting/follow-up controls.

Important clicks:

- Mark done.
- Reopen.
- Save link.
- Mark waiting.
- Set follow-up date.
- Edit task.
- Open instructions.
- Open workflow.

### Workflow Detail

Primary job: complete a concrete operation.

Must include:

- Workflow header with stage and risk indicators.
- Required links panel.
- Fixed references panel.
- Missing evidence panel.
- Active checklist.
- Waiting checklist.
- Done history.
- Assistant/context panel when applicable.
- Process docs available from each task.

Important clicks:

- Save bundle link.
- Save task link.
- Upload file.
- Mark done.
- Mark waiting.
- Send/record follow-up.
- Advance stage.
- Add ad-hoc task.
- Archive.

### Workflow Library

Primary job: start repeatable work from templates.

Must include:

- Template cards grouped by operation type.
- Trigger type: automatic or manual.
- Lead days and schedule.
- Task count.
- Required links/files summary.
- "Start workflow" action for manual templates.
- "Edit template" action for maintainers.

### Recurring Operations

Primary job: configure periodic tasks.

Must include:

- Enabled/disabled configs.
- Human-readable schedule.
- Cron expression.
- Owner.
- Last generated date.
- Next generated date.
- Duplicate-skip history.

### Notifications

Primary job: acknowledge alerts, not manage all work.

Must include:

- Due/overdue/follow-up/failure types.
- Related task or workflow link.
- Dismiss action.
- Dismiss all for low-priority informational alerts.
- No ability to dismiss real task state without resolving or acknowledging the
  task.

## Daily, Weekly, Monthly, and Event-Based Tasks

### Daily tasks

The operator should expect to perform some of these every workday:

- Open dashboard.
- Check overdue tasks.
- Check follow-ups due.
- Check today tasks.
- Review active workflow risks.
- Process incoming email/Telegram/ad-hoc requests.
- Invite people to Slack from Airtable when applicable.
- Create or update tasks from incoming messages.
- Update links and comments after external work.
- Follow up with people who have not replied.
- Review tomorrow's urgent work before ending the day.

Acceptance criteria:

- The platform can generate or show these tasks without manual memory.
- Every unfinished daily task has a next state by end of day.

### Weekly tasks

The operator should expect recurring weekly work:

- Prepare newsletter pipeline.
- Ensure there are two newsletter drafts in progress when required by the
  newsletter reference.
- Schedule or verify newsletter send.
- Schedule social media posts.
- Prepare and follow up on sponsored content.
- Review active events for upcoming reminders.
- Handle book-of-the-week activities when active.
- Back up Mailchimp mailing list if this recurring task is configured.

Acceptance criteria:

- Weekly recurring tasks are generated on schedule.
- Newsletter workflow is created with enough lead time.
- Sponsor follow-ups are shown before the deadline becomes urgent.

### Monthly tasks

The operator should expect monthly maintenance:

- Prepare monthly tax report.
- Review bookkeeping TODO values.
- Match Dropbox invoices, receipts, statements, Finom, and Revolut records.
- Convert currencies when needed.
- Prepare and send accounting package.
- Organize invoice folders.
- Create Slack dump if configured.
- Review monthly sponsor/performance/admin follow-ups.

Acceptance criteria:

- Monthly tax workflow is generated automatically.
- Tasks that involve files require file evidence.
- Finance tasks make incomplete TODO values visible as risk.

### Event-based tasks

The operator starts workflows when external triggers occur:

- Guest confirms event date.
- Speaker agrees to webinar or workshop.
- Author agrees to book-of-the-week.
- Sponsor slot is assigned.
- Recording becomes available.
- Newsletter issue enters preparation window.
- Course or lesson needs setup.

Acceptance criteria:

- User can start a workflow from the trigger in less than two minutes.
- Workflow tasks are calculated from the anchor date.
- The first next action is immediately visible after creation.

## Pain Points The Platform Must Solve

### Pain point 1: Work is scattered

Current state:

- Trello has workflow cards.
- Spreadsheet has ad-hoc and recurring tasks.
- Google Docs has instructions.
- Telegram and email create new tasks.
- External systems hold proof.

Product response:

- One dashboard.
- One task queue.
- One workflow detail page.
- Links and docs attached to tasks instead of separate navigation.

### Pain point 2: Waiting becomes invisible

Current state:

- Guests, sponsors, authors, publishers, freelancers, and reviewers often need
  reminders.
- A task can look "not done" but not tell the operator why.

Product response:

- Waiting state.
- Follow-up date.
- Waiting-for person.
- Follow-up reminders.
- Follow-up history.

### Pain point 3: Completion is ambiguous

Current state:

- Many tasks happen in external systems.
- Without a link/file/comment, nobody can tell if the task is truly done.

Product response:

- Required links.
- Required files.
- Completion blocking.
- Evidence visible in workflow.
- Audit trail.

### Pain point 4: Recurring work depends on memory

Current state:

- Weekly newsletter, social media, monthly tax report, backups, dumps, and
  daily maintenance can be forgotten.

Product response:

- Recurring configs.
- Automatic task generation.
- Duplicate protection.
- Dashboard reminders.

### Pain point 5: Process docs are useful but disconnected

Current state:

- SOPs explain steps, but the operator has to find them.
- Some docs are incomplete or need improvements.

Product response:

- SOPs appear at the task step.
- Search is secondary.
- Process gap reporting is attached to the task.

### Pain point 6: Workflow risk is hard to see

Current state:

- A workflow may look active but actually be missing public links, sponsor
  assets, recordings, transcripts, invoices, or confirmations.

Product response:

- Bundle risk indicators.
- Missing artifact panel.
- Stage-aware next actions.
- Required evidence before completion.

## Concrete Acceptance Criteria Inventory

### Dashboard acceptance criteria

- Shows today, overdue, follow-up due, and active workflow risk sections.
- Shows assigned-to-me by default while allowing all-team view.
- Shows unassigned urgent tasks.
- Shows active workflows with progress, stage, next task, overdue count, and
  waiting count.
- Shows missing required evidence for at-risk workflows.
- Allows completing a task from dashboard when no proof is missing.
- Blocks completion from dashboard when proof is missing.
- Opens workflow detail from a task or workflow card.

### Reminder acceptance criteria

- Due tasks appear on due date.
- Overdue tasks remain until done or explicitly moved to waiting.
- Follow-up tasks appear on follow-up date.
- Waiting tasks require waiting-for and follow-up date.
- Missing evidence creates visible risk.
- Automation failures create admin/operator notifications.
- Dismissed notifications do not change task status.

### Task acceptance criteria

- User can create ad-hoc task with description, due date, assignee, source, and
  optional bundle.
- User can edit description, due date, assignee, comment, link, and state.
- User can mark task done.
- User can reopen task.
- User can mark task waiting.
- User can set follow-up date.
- User can save required link inline.
- User can upload required file when file support is implemented.
- Done task records completed-by and completed-at.

### Workflow acceptance criteria

- User can create a workflow from a template.
- User can set anchor date and required variables.
- Generated tasks have due dates from offsets.
- Generated tasks inherit instructions, required links, required files, tags,
  and default assignee.
- Workflow detail shows required links, references, tasks, stage, and progress.
- Milestone completion can advance stage.
- Workflow cannot be marked done while active tasks remain.
- Workflow cannot be marked done while required evidence is missing.

### Recurring acceptance criteria

- User can create recurring configs using human-friendly schedule controls.
- Cron expression is stored.
- User can enable or disable a recurring config.
- System generates recurring tasks automatically.
- Duplicate recurring tasks are skipped.
- Generated recurring tasks are visible on dashboard.
- Recurring generation failures create notifications.

### Follow-up acceptance criteria

- User can mark any task as waiting for a person or entity.
- User can choose a follow-up date.
- User can record that a follow-up was sent.
- User can set the next follow-up date.
- User can mark response received and return task to todo.
- Follow-up history is visible from task and workflow.

### Contextual docs acceptance criteria

- Task instructions open the relevant SOP/template/reference.
- Workflow detail links to fixed process references.
- Search can find docs when a task has no mapped instructions.
- Docs are not the primary daily work screen.
- User can report a process gap from a task.

### Audit acceptance criteria

- Task creation, state changes, completion, reopening, waiting changes, follow-up
  changes, link saves, file uploads, and stage changes are recorded.
- Audit entries include actor and timestamp.
- Done and archived work remains searchable.
- Bundle history can explain why a workflow was delayed.

## V1 Product Shape

The first meaningful version should not be "docs plus search". It should be:

1. Dashboard as daily command center.
2. Workflow detail as the main execution surface.
3. Task list for cross-workflow inspection.
4. Template library for starting known operations.
5. Recurring tasks for periodic duties.
6. Notifications/reminders for due, overdue, follow-up, and missing evidence.
7. Contextual docs inside task and workflow screens.
8. Assistant-generated artifacts attached to workflows, starting with podcast
   patterns but designed generically.

## What To Build Next

### Phase 1: Make the dashboard operational

- Add overdue section.
- Add follow-ups due section.
- Add workflow risk indicators.
- Add quick task actions: complete, waiting, open workflow, add required link.
- Show unassigned urgent tasks alongside assigned tasks.

### Phase 2: Add waiting and follow-up semantics

- Add waiting fields or first-class waiting status.
- Add follow-up date.
- Add waiting-for person/entity.
- Add follow-up history.
- Generate follow-up reminders.

### Phase 3: Strengthen workflow detail

- Add missing evidence panel.
- Add active/waiting/done task grouping.
- Add ad-hoc task-to-bundle attachment.
- Add workflow-level "cannot close because..." checks.
- Add audit trail.

### Phase 4: Make recurring operations reliable

- Show next/last generated dates.
- Surface cron generation failures.
- Add recurring source badges on tasks.
- Add operations defaults for newsletter, social media, tax report, Slack invite
  handling, Mailchimp backup, and Slack dump.

### Phase 5: Integrate docs and assistant into execution

- Keep docs as contextual instruction links.
- Add process gap reporting.
- Attach assistant output as workflow artifacts.
- Generalize the podcast assistant pattern into workflow assistants that turn
  raw input into prepared documents or task evidence.

## Non-Goals For V1

- Do not make the docs tree the primary homepage.
- Do not present the imported work-engine as a separate disconnected tool.
- Do not hide waiting work in generic todo status.
- Do not allow tasks with required proof to be completed without proof.
- Do not build a heavy project-management system with unnecessary complexity.
- Do not require the operator to understand the underlying Git/content layout to
  do daily work.

## Product Goal Statement

The DataOps platform succeeds when the operations manager can open one page,
see what needs action, understand what is blocked, follow up with the right
people, complete tasks with proof, and keep every active DataTalksClub workflow
moving without reconstructing state from Trello, spreadsheets, Telegram, email,
and disconnected process docs.
