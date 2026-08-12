# DataOps Design System

DataOps uses the Course Management Platform design system as its primary visual
and interaction reference. That system is based on GitHub Primer: neutral
surfaces, restrained borders, compact row-based content, content-width actions,
clear status language, and predictable responsive behavior.

This document adapts those principles for an internal operations workspace. It
does not copy course-specific templates, branding, or content. The canonical
implementation lives in top-level `frontend/`; the Home screen is the first
reference surface rebuilt with this system.

## Product model

The interface should help an operator answer five questions quickly:

1. What needs attention now?
2. What process should I follow?
3. What context, people, links, and files do I need?
4. What already happened?
5. What can automation prepare for review?

Keep the object model visible in the UI:

- a task says what to do next;
- a process document says how to do it;
- a workflow groups repeatable work and context;
- an assistant prepares an output for review;
- an artifact is evidence that an output exists.

## Principles

- Prefer content-first pages over decorative dashboards.
- Use rows over columns unless the content is genuinely comparable or tabular.
- Present one dominant operator question per page.
- Keep actions only as wide as their content; do not default to full-width
  buttons.
- Use one clear primary action and make secondary actions visibly quieter.
- Resolve human names before rendering. Do not expose routine object, user,
  workflow, storage, or provider IDs.
- Use familiar operational language. Avoid API names, state codes, and internal
  implementation terminology in normal copy.
- Keep loading, empty, partial failure, validation, conflict, permission,
  not-found, and retry states honest. Never render a false zero or fabricated
  success.
- Preserve dark mode without a reload. JavaScript owns the state; CSS variables
  own the colors.
- Use public-safe synthetic examples in fixtures and evidence. Operational
  documents and private context remain outside this public repository.

## Foundation tokens

The tokens in `frontend/src/styles.css` are the implementation source of truth.
They intentionally follow the Course Management Platform names where practical.

### Neutral palette

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--page-bg` | `#ffffff` | `#0d1117` | page canvas |
| `--surface-bg` | `#ffffff` | `#161b22` | cards, panels, rows |
| `--surface-muted` | `#f6f8fa` | `#0d1117` | headers, footers, secondary controls |
| `--surface-hover` | `#eef1f4` | `#21262d` | row and control hover |
| `--border-muted` | `#d0d7de` | `#30363d` | normal dividers and containers |
| `--border-strong` | `#afb8c1` | `#484f58` | controls and active boundaries |
| `--text-primary` | `#24292f` | `#e6edf3` | body copy |
| `--text-heading` | `#0f172a` | `#e6edf3` | headings and important values |
| `--text-muted` | `#57606a` | `#8b949e` | metadata and helper copy |
| `--text-faint` | `#8c959f` | `#6e7681` | unavailable and disabled content |

### Product and semantic colors

- Course Management Platform blue (`#315f8f`) is the primary action,
  selected-navigation, and conventional link color; its hover is `#244d78`.
- The pale information blue (`#edf5ff`) is used for selected and informational
  backgrounds. It must not be replaced by a product-specific accent on shared
  components.
- Green is reserved for completion and success.
- Amber is reserved for waiting, caution, or follow-up.
- Red is reserved for overdue, destructive, failed, or blocking states.
- Never use color alone. Pair it with text, an icon, position, or accessible
  state.
- In dark mode, keep CMP's roles separate: links and selected text use
  `#8bb7df`, while filled primary controls use `#4d7fa8` and hover at
  `#6d99c2`. Secondary controls use `#21262d`, hover at `#30363d`, and gain
  a `#8b949e` hover border. Dark canvas and surfaces use `#0d1117` / `#161b22`
  with normal `#30363d` borders; do not synthesize these colors by inverting
  the light theme.

### Type, spacing, and shape

- Use the system sans-serif stack with Inter when available.
- Page titles are 32–36px desktop and 22px mobile, semibold, with tight leading.
- Section headings are 16px semibold.
- Body and row titles are 14px; metadata is 12–13px.
- Use a 4px base rhythm. Normal component gaps are 8, 12, 16, or 24px.
- The shared component radius is 6px. A larger radius is reserved for avatars,
  circular controls, or product marks.
- Normal surfaces have no shadow. Shadows indicate overlays, drawers, and
  modals only.

## Shell and navigation

### Desktop

- Use a persistent 268px sidebar and one main page canvas.
- The sidebar shows the product mark, workspace name, search, and a short
  primary navigation list.
- Primary navigation is `Today`, `Inbox`, `Workflows`, `Newsletter`,
  `Calendar`, `Sponsors`, `Bookkeeping`, `Mailing exports`, and `Process Docs`.
  Every area remains visible as a first-level item with an icon. Do not add a
  `More`, overflow, disclosure, or contextual navigation section to this
  sidebar.
- Use icon plus text navigation rows, not icon-only navigation.
- The selected row uses one accent-soft background with accent text and icon.
  Never add a left border, inset stripe, colored rail, or other edge accent to
  selected navigation. One selection signal is enough and keeps the navigation
  calm in both themes.
- The top toolbar owns global actions such as notifications, help, identity,
  and account access. Page-specific editor controls appear only on pages that
  need them.
- Show the authenticated person with an avatar/initials and name on desktop,
  and the same avatar/initials on mobile. Do not use an anonymous settings gear
  as the account entry point.
- Account scope and actor identity are separate concepts. A `Show work for`
  control may change whose tasks are visible, but it must not imply an identity
  switch. When a teammate's task is open, state both the signed-in actor and
  the teammate who remains assigned.
- Teammate scope rows show names and ownership context, not peer email
  addresses. The signed-in person may see their own email in the account
  summary.
- The global sidebar is navigation-only on every route. Never append a process
  document tree, document filters, pending changes, recent documents, or a
  `New process doc` control below it.
- Process Docs is a separate main-canvas view. Its library, search/filter
  controls, document tree or list, pending state, editor, and creation actions
  belong inside that view—not inside the global sidebar.
- Top-level routes own and replace the entire main canvas. Clear the previous
  route before rendering the next one; never retain a shared page title, status
  summary, filter strip, quality count, or content fragment across areas.
- The desktop toolbar contains global controls only. Do not show an `All docs /
  Workspace / Current area` breadcrumb or duplicate route title above a
  top-level page. The selected sidebar item and the page's own main heading
  provide context.
- Never put `Save`, `Discard`, or mutation state in the global toolbar. Form and
  editor actions live in the relevant main-canvas form footer, primary first and
  secondary/cancel actions after it.
- Home Settings does not expose Process Docs Git/review tools. Those controls
  remain contextual to the knowledge workspace.
- Collapsing the sidebar must leave a visible, keyboard-operable restore
  control.

### Mobile

- Use a 64px top bar with menu, page title, notifications, and settings.
- The workspace navigation opens as a modal drawer with a scrim, initial focus,
  Escape handling, focus containment, and focus restoration.
- Show one page or detail state at a time. Do not put a desktop split view into
  a narrow viewport.
- Hide global chrome while a full-screen editor or entity detail owns the
  interaction.

## Page composition

- Stack page title/description and utility actions. On desktop they may share a
  row only when the actions are short and the title remains dominant.
- Use a readable 760–820px content width for queues and text-heavy work.
- Center a primary framed work list in the available page canvas unless the
  surrounding page has an explicit master/detail layout.
- Prefer a single bordered container with divided rows over multiple nested
  cards.
- Use muted surface backgrounds for container headers and footers.
- Keep supporting metadata next to the object it describes, not in a separate
  dashboard card.

## Home: reference implementation

Home is a scan-first daily queue and the first reference implementation of this
system.

- The page answers “What needs my attention now?”
- Lead with the human calendar date and content-width `New task` / `Start
  workflow` actions.
- Show Overdue, Due today, and Waiting as one compact segmented strip.
- Center one CMP-standard `56rem` (896px) `Needs your attention` container in
  the main canvas, aligned with the daily header and summary strip.
- Cap the visible queue at six rows and link to the complete work queue.
- Order once by priority: overdue, follow-up due, due today, missing proof;
  then by applicable date and stable title.
- A desktop row contains marker, task title, resolved workflow, human timing,
  and one action. A mobile row collapses to title, timing, and action.
- Home does not mutate a task immediately. `Open` opens task detail; a
  proof-specific action may say `Add proof` but still opens the exact task.
- Avoid status sentences, duplicated badges, raw IDs, owner IDs, and source
  codes.
- Successful rows remain visible during a partial feed failure. An unavailable
  source does not become zero.

## Lists, tables, and cards

- Default to row lists with dividers.
- Use a subtle bordered container on desktop when it materially improves
  scanning; use edge-to-edge divided rows on mobile when space is tight.
- A list header establishes scope and may contain one small utility action.
- A row should have one primary label, one short metadata line, status when
  needed, and one next action.
- Use tables only for truly tabular comparison. On mobile, convert dense tables
  into labelled cards or rows rather than relying on horizontal scrolling.
- Do not nest cards inside cards for ordinary form or list content.

## Buttons and links

- Primary buttons use the Course Management Platform blue with white text.
- Secondary buttons use the muted surface, neutral border, and primary text.
- Content-width is the default. Use wrapping action rows instead of stretching
  controls full width.
- Default desktop control height is 32–36px; interactive mobile controls are at
  least 44px.
- Put the primary action first. Destructive actions must be explicitly labelled
  and visually separated from routine actions.
- Icon-only buttons need a stable icon plus `aria-label` and `title` where
  useful.
- Text links use the shared blue link token. Do not style arbitrary text as a
  link with the product accent.

## Forms

- Use one form language: stacked sections and fields, labels above controls,
  helper text immediately below its control.
- Keep mixed or content-heavy fields one per row. Use two or three columns only
  for short comparable fields.
- Use a single footer action row separated by a top border: primary first,
  then Cancel/back.
- Keep checkbox and radio controls beside their labels with the helper below
  the label.
- Read-only data uses definition/meta rows, not disabled input-shaped boxes.
- Retain submitted values and focus when validation, conflict, or network
  errors occur.

## Status and system states

Use one shared state vocabulary across surfaces:

- **Loading:** stable skeleton or reserved space; no fabricated records.
- **Empty:** explain what is absent and retain the safe next action.
- **Partial:** keep successful content and name the unavailable source or
  capability with a retry path.
- **Validation:** place field-level copy next to the field and focus the first
  invalid control.
- **Conflict:** explain that the record changed, retain input, and offer reload
  or retry.
- **Permission:** explain the allowed role/action without exposing policy
  internals.
- **Not found:** identify the object type, offer retry, and provide a return
  path.
- **Failure:** concise operator copy, no raw stack trace or provider payload.
- **Success:** confirm the durable result; do not rely on a transient color-only
  toast.

Status labels are compact, semantic, and used only when a status changes the
operator's decision. Do not add a pill to every row by default.

## Overlays and detail ownership

- Popover: lightweight global or row action, anchored to its trigger; Escape
  closes and focus returns to the trigger.
- Modal: focused confirmation or task detail that should interrupt the page;
  backdrop, Escape, focus trap, and focus restoration are required.
- Sheet: persistent comparative detail on desktop; becomes a full-screen page
  on mobile.
- Toast: brief feedback only. Errors requiring a decision remain in the
  relevant surface.
- Do not mix native dialogs, custom overlays, and inline replacement forms for
  the same interaction family.

## Accessibility

- Use native headings, lists, buttons, links, forms, tables, and `<time>` before
  adding ARIA.
- Maintain a visible focus indicator with sufficient contrast.
- Keyboard behavior must match pointer behavior, including row actions,
  disclosures, drawers, and overlays.
- Modal interactions trap focus and restore it to the originating control.
- Touch targets are at least 44px on mobile.
- Do not clip zoomed text or require horizontal page scrolling at supported
  viewports.
- Keep semantic machine values, such as `datetime`, when rendering human copy.
- Changed states should have no critical or serious WCAG A/AA findings.

## Responsive rules

- Baseline mobile viewport is 390×844; desktop evidence uses 1440×900.
- Reflow at 820px unless a surface demonstrates a more appropriate local
  breakpoint.
- Preserve task order, labels, and actions across viewports.
- Convert master/detail to one-pane navigation on mobile.
- Hide lower-priority metadata before truncating the primary label.
- Avoid fixed widths that cause page overflow. Use `minmax(0, 1fr)`, readable
  maximum widths, and wrapping action rows.

## Migration rules

- Build and document shared primitives before redesigning another surface.
- Migrate one coherent surface at a time; Home is first.
- During migration, legacy classes may receive minimal structural rules so a
  route remains usable. They are not a second design system.
- New styles must use foundation tokens rather than hard-coded one-off colors,
  radii, shadows, or control sizes.
- Do not reintroduce the retired frontend, a second router, or a second token
  vocabulary.
- Visual screenshots support review but do not prove routing, focus, state,
  mutation, accessibility, or API behavior. Verify those separately against
  the normal local backend and packaged frontend.

## Sources of truth

- DataOps implementation: `frontend/src/styles.css`
- DataOps product behavior: `PORTAL_ANALYSIS.md` and `PROJECT_PLAN.md`
- Primary design reference: `../course-management-platform/docs/design-system.md`
- Reference implementation tokens/components:
  `../course-management-platform/courses/static/courses.css`
- Interaction baseline: GitHub Primer, without GitHub branding
