# DataOps Platform: Operations Manager JTBD and Usage Spec

> This document has three parts. Part 1 (this file) covers the user context
> and the daily operating loop, [Part 2](part-2-jtbd-reminders-and-status-models.md)
> covers jobs to be done, reminders, and status models, and
> [Part 3](part-3-screens-pain-points-and-roadmap.md) covers screens, pain points, and roadmap.

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

- `backend/docs/specs.md`: imported source product problem, data model, task
  types, templates, cards, recurring configs, required links, required files,
  stages, and dashboard goals.
- `backend/docs/data.md`: Trello board and spreadsheet analysis, including
  active columns, templates, open tasks, completed recurring tasks, and daily
  spreadsheet behavior.
- `backend/docs/templates.md`: canonical workflow templates for newsletter,
  podcast, webinar, workshop, book of the week, OSS, course, social media, tax
  report, Maven lightning lesson, and office hours.
- `backend/src/types.ts`: current platform objects for tasks, cards,
  templates, recurring configs, users, files, and notifications.
- `frontend/src/app.js`: canonical portal behavior for dashboard, tasks,
  cards, templates, recurring configs, notifications, required links, and
  completion checkboxes.
- workflow-templates/*.yaml in the private DataTalksClub/dataops-knowledge repository: transitional imported task templates and
  due-date offsets; long-term canonical templates belong in the private
  knowledge repo.
- Private operations-knowledge content, or sanitized fixtures when referenced
  from this public repo: schedule, newsletter, operations reference material,
  SOPs, and templates used as contextual instructions.
- `assistants/podcast/README.md`: current assistant module overview.
- `assistants/podcast/process/podcast.md` and
  `assistants/podcast/templates/podcast_guest_intake.md`: current assistant
  process/template inputs for turning raw inputs into prepared operating
  documents; long-term reusable process/template content belongs in the
  private knowledge repo.

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
  email, Telegram, and private GitHub-backed process docs surfaced inside
  DataOps.
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
- card links collect the artifacts produced by work;
- files and comments preserve evidence;
- notifications surface risk and deadlines;
- the dashboard gives the operator the next action.

## Current Platform Capabilities

The current code already contains useful primitives:

- Login and session-based access.
- Dashboard route with active cards and tasks due today.
- "Assigned to me" behavior on the dashboard.
- Task list with date, range, status, assignee, and card filters.
- Ad-hoc task creation.
- Card list and card detail pages.
- Template list and template editor.
- Recurring config page.
- Notification bell and notification page.
- Task checkboxes to mark done or todo.
- Required link fields that block completion until a URL is saved.
- Card links that store workflow-specific URLs.
- Template references that resolve through the private document registry.
- Task instructions URLs or IDs that open process docs inside the authenticated
  app.
- Stage transitions for cards, including preparation, announced,
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
- Active workflows: cards grouped by risk and next due action.
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
- workflow card;
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

- Convert the incoming item into either an ad-hoc task or a workflow card.
- Attach the source message or paste the source link.
- Assign an owner and due date.
- If the item belongs to an active workflow, attach it to the card instead of
  leaving it as a standalone task.
- If it creates a new repeatable pattern, flag it as a template/process
  improvement.

Acceptance criteria:

- The user can create an ad-hoc task in less than one minute.
- The user can attach an ad-hoc task to an existing workflow.
- The user can create a new workflow card from a template when a trigger
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

