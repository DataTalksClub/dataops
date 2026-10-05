> Part 3 of 3 of the [Operations Manager JTBD spec](part-1-user-context-and-daily-loop.md):
> Part 1 (entry) is the user context and the daily operating loop;
> Part 2 covers [jobs to be done, reminders, and status models](part-2-jtbd-reminders-and-status-models.md).

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
- Card filter.
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

- Save card link.
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

- Card risk indicators.
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
  optional card.
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
- Sensitive SOP/template content is resolved through authenticated private-doc
  APIs, not stored in or linked directly from the public app repo.

### Audit acceptance criteria

- Task creation, state changes, completion, reopening, waiting changes, follow-up
  changes, link saves, file uploads, and stage changes are recorded.
- Audit entries include actor and timestamp.
- Done and archived work remains searchable.
- Card history can explain why a workflow was delayed.

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
- Add ad-hoc task-to-card attachment.
- Add workflow-level "cannot close because..." checks.
- Add audit trail.

### Phase 4: Make recurring operations reliable

- Show next/last generated dates.
- Surface cron generation failures.
- Add recurring source badges on tasks.
- Add operations defaults for newsletter, social media, tax report, Slack invite
  handling, and Slack dump.

### Phase 5: Integrate docs and assistant into execution

- Keep private docs as contextual instruction links through the document
  registry.
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
- Do not store sensitive SOPs, templates, prompts, screenshots, or generated
  operational artifacts in the public app repo.

## Product Goal Statement

The DataOps platform succeeds when the operations manager can open one page,
see what needs action, understand what is blocked, follow up with the right
people, complete tasks with proof, and keep every active DataTalksClub workflow
moving without reconstructing state from Trello, spreadsheets, Telegram, email,
and disconnected process docs.
