# Task dialog design contract

The task dialog is a compact work sheet. The operator should identify the work,
understand its current state, and find the next action without scrolling past
setup information.

## Problems to remove

- The delegation notice is larger and brighter than the task context.
- The card link, waiting information and actions are three competing boxes.
- Due date, assignee and category are pills despite being ordinary metadata.
- Needs and Browser each take a heading and a separate row before the next action.
- The follow-up input grows independently of its action and breaks the action row.
- A required file uses a large drop zone even while the task is waiting.
- The same background, border and heading weight give unrelated blocks equal priority.

## Direction: a calm operational work sheet

Retain the shared dakit theme and typography. Establish identity through strong
alignment, restrained color, and a deliberate scale contrast rather than new fonts.

- Type: `--dk-font-sans` for prose and controls; `--dk-font-mono` for dates only.
  Title 22px/1.2 semibold, section headings 14px/1.5 semibold, body 14px/1.5,
  metadata 12px/1.5 regular. No uppercase eyebrow headings.
- Palette: shared dakit semantic roles, never local color overrides. Light/dark
  surfaces #ffffff/#161b22; inset #f6f8fa/#21262d; text #24292f/#e6edf3;
  muted #57606a/#9198a1; borders #d0d7de/#30363d. Blue means a link or primary
  action, amber waiting, red an actionable overdue date. No decorative color.
- Shape: 10px dialog perimeter, 6px controls, square section dividers. No new
  pill metadata, nested cards, gradients, colored edge accents, or section shadows.
- Spacing: 24px dialog padding, 24px between sections, 8–12px within groups.
  Compact controls use 34px minimum height; touch widths use 44px.
- Header: task title is the strongest text, with an unobtrusive close control.
- Context: one quiet card link and a plain status/date/assignee line. Delegation
  is a compact sentence naming actor and owner, not a prominent warning panel.
- State and actions: waiting reason and follow-up date directly precede the
  controls. One primary response action. Follow-up scheduling is a secondary
  disclosure with a clearly labeled date. Skip remains a quiet secondary action.
- Setup: Needs and Browser sit together as compact aligned rows after the next
  action. Their existing inline editors remain usable and keyboard accessible.
- Instructions: simple linked rows separated by rules. Evidence stays visible
  when required, but file upload starts as a compact control rather than a billboard.
- History and optional attachments: retain the existing disclosure.
- Mobile: full-screen dialog, 16px padding, no horizontal scrolling; action rows
  wrap in DOM order. Dates and controls retain their labels.

## Verification

Render real task components with sanitized tasks in waiting, open, completed,
and inline-edit states. Inspect dark and light desktop and narrow mobile views.
Exercise response/follow-up, required-resource editing, browser editing, file
input, disclosure and close behavior. Keep existing versioned mutation and draft
recovery behavior intact.
