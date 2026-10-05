> Part 1 of 3 of the [DataOps Design System](../design-system.md) spec.
> [Part 2](part-2-component-primitives-and-surfaces.md) covers component
> primitives and surface mapping; [Part 3](part-3-responsive-accessibility-and-migration.md)
> covers responsive, accessibility, and migration rules.
>
> **Status: historical spec.** Shared tokens are now owned by **dakit**; the
> token tables below describe a superseded proposal. See
> `frontend/DESIGN_SYSTEM.md` for the current system.

## Purpose

This is the internal V1 design-system specification for the DataOps operations
workspace. It defines shared tokens, component primitives, usage rules, current
surface mappings, drift, accessibility rules, responsive behavior, and migration
sequencing for the plain HTML/CSS/JavaScript portal and work-engine stack.

The system is framed by `.goal-v1.md`: DataOps V1 is a unified daily operations
workspace for the DataTalksClub operations manager. The operator should log in,
see what needs action today, identify overdue and waiting work, follow up with
people who have not replied, complete tasks with required proof, and use
process docs in context without switching between disconnected tools.

This is not a generic documentation site system and not a generic admin
dashboard system. Docs remain important, but V1 is workflow-first: daily work,
proof, reminders, follow-ups, workflow state, and assistant artifacts are the
primary product surface. The calmer portal direction is the baseline. Imported
work-engine UI patterns are migration targets.

Primary inputs:

- `.goal-v1.md` for V1 workflow framing.
- `frontend/DESIGN.md` for the Notion-like, one-page-at-a-time workspace model.
- `docs/local-development.md` for the current portal/work-engine runtime split.
- `frontend/` for the current DataOps docs portal, Operations Home, task and
  card panels, notifications, document editing, create flow, and dark mode.
- `work-engine/src/pages/index.html` and `work-engine/src/public/app.js` for
  sign-in, dashboard, task tables, card cards, filters, recurring work,
  notifications, templates, proof links, and follow-up controls.
- Designer audit for issue #46:
  https://github.com/DataTalksClub/dataops/issues/46#issuecomment-4821732275

Follow-up implementation issue:

- #55: Apply shared DataOps shell tokens to the V1 portal shell
  (https://github.com/DataTalksClub/dataops/issues/55).

## V1 Principles

1. Workflow-first, docs-in-context.
   The daily dashboard, task list, workflow detail, reminders, and proof
   controls take priority. SOPs and templates appear as contextual support.
2. Calm and low chrome.
   Use neutral surfaces, restrained borders, compact controls, and quiet
   hierarchy. Avoid marketing-style hero layouts and decorative cards.
3. One primary state at a time.
   Library, editor, create, task detail, workflow detail, and assistant job
   review must not compete for the same mobile viewport.
4. Operational density over presentation.
   The operator should scan today's work quickly. Empty states, dashboards, and
   forms should not consume large areas unless the user is actively editing.
5. Proof is part of completion.
   Done states require acceptance criteria and proof when the task requires a
   link, file, artifact, or review record.
6. Assistant output is operational output.
   DataOps podcast assistant and future assistant UI must reuse DataOps components for
   jobs, artifacts, logs, approvals, retries, and review actions. They must not
   introduce a second assistant-specific visual language.
7. Incremental implementation.
   V1 uses current HTML, CSS, and JavaScript. Token aliases, class cleanup, and
   shared component names should precede any framework decision.

## Token Namespace

Shared roles live in dakit and are consumed as `--dk-*` tokens
(`frontend/src/dakit/tokens.css`; refresh via `node build.mjs` in `../dakit`).
New shared components must use `--dk-*` roles — surfacing, text, borders,
accent, status triplets, focus, type, space, radius, and control sizes — and
must not introduce a project-local color vocabulary. DataOps-local roles
(the `attention-*` ramp and layout metrics) live in the `:root` block of
`frontend/src/styles/base.css` until promoted into dakit.

### Color Tokens

| Token | Light value | Dark value | Use |
| --- | --- | --- | --- |
| `--do-color-bg` | `#ffffff` | `#181818` | App background and page canvas. |
| `--do-color-shell` | `#f7f7f5` | `#1f1f1f` | Sidebar, drawer, and low-emphasis shell areas. |
| `--do-color-surface` | `#ffffff` | `#1f1f1f` | Inputs, cards, panels, modals, document canvas. |
| `--do-color-surface-hover` | `#efefec` | `#262626` | Row hover, quiet button hover, selected affordances. |
| `--do-color-control` | `#f1f1ef` | `#262626` | Default button and compact control background. |
| `--do-color-control-hover` | `#e9e9e6` | `#2e2e2e` | Control hover background. |
| `--do-color-border` | `#e6e5e1` | `#2e2e2e` | Default border and dividers. |
| `--do-color-border-strong` | `#d6d4ce` | `#3a3a3a` | Active borders, panel edges, table header borders. |
| `--do-color-text` | `#242424` | `#e6e6e6` | Main text. |
| `--do-color-muted` | `#6f6e69` | `#9d9d9d` | Secondary text, metadata, helper text. |
| `--do-color-faint` | `#9b9a95` | `#6a6a6a` | Disabled text, timestamps, low-emphasis counts. |
| `--do-color-accent` | `#1f6f64` | `#5fb39d` | Primary action, selected state, progress complete. |
| `--do-color-accent-soft` | `#e5f0ed` | `#1f3833` | Accent badge background and selected row background. |
| `--do-color-danger` | `#a14225` | `#d8755d` | Destructive action, error, missing proof. |
| `--do-color-warning` | `#a96400` | `#d4a24a` | Waiting, follow-up due, at-risk but not blocked. |
| `--do-color-warning-soft` | `#fff8ec` | `#312611` | Warning badge and callout background. |
| `--do-color-info` | `#4f6f98` | `#8fb2df` | Informational status only, not primary action. |

Usage rules:

- Teal `--do-color-accent` is the canonical primary color. The legacy
  work-engine blue `#3498db` is not a new primary; alias it during migration.
- Green is reserved for completed or healthy states and must not become the
  main action color.
- Warning and danger states must include text labels. Color alone is never the
  state.
- Purple badge colors from work-engine may be mapped to neutral metadata or
  info states. Do not expand purple into a broad product palette.

### Status Tokens

| Token | Use |
| --- | --- |
| `--do-status-todo-bg`, `--do-status-todo-text` | Not started or ad hoc work. |
| `--do-status-active-bg`, `--do-status-active-text` | Active workflow, in progress task, selected workflow. |
| `--do-status-waiting-bg`, `--do-status-waiting-text` | Waiting for person, follow-up due, external dependency. |
| `--do-status-overdue-bg`, `--do-status-overdue-text` | Overdue work or missed follow-up. |
| `--do-status-done-bg`, `--do-status-done-text` | Completed task with proof satisfied. |
| `--do-status-missing-proof-bg`, `--do-status-missing-proof-text` | Required link, file, artifact, or review is missing. |
| `--do-status-assistant-bg`, `--do-status-assistant-text` | Assistant job or artifact status. |

Each status component must render readable text such as `Waiting`,
`Missing proof`, `2/5 done`, or `Assistant output ready`.

### Typography Tokens

| Token | Value | Use |
| --- | --- | --- |
| `--do-font-sans` | `Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif` | Product UI. |
| `--do-font-mono` | `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` | Code, paths, IDs, raw diffs. |
| `--do-text-xs` | `11px` | Dense metadata, badge helper text. |
| `--do-text-sm` | `12px` | Labels, compact table headers. |
| `--do-text-md` | `13px` | Dense rows, task metadata, sidebar rows. |
| `--do-text-body` | `14px` | Standard UI body and controls. |
| `--do-text-lg` | `16px` | Card titles, panel titles, form section titles. |
| `--do-text-xl` | `22px` | Page titles in operational pages. |
| `--do-text-page` | `32px` | Document/editor page title maximum. |

Usage rules:

- Operational screens should use `--do-text-xl` or smaller for page titles.
  Hero-scale headings such as the current Operations Home desktop title should
  be reduced for daily execution.
- Document editor titles may use `--do-text-page` when the editor is the only
  primary state.
- Letter spacing is `0` by default. Uppercase labels must be used sparingly and
  should not require positive letter spacing to be readable.

### Spacing And Density Tokens

| Token | Value | Use |
| --- | --- | --- |
| `--do-space-1` | `4px` | Tight icon/text gaps. |
| `--do-space-2` | `8px` | Compact row gaps, badge padding. |
| `--do-space-3` | `12px` | Form group gaps, toolbar groups. |
| `--do-space-4` | `16px` | Card padding, panel padding, section gaps. |
| `--do-space-5` | `20px` | Page section spacing. |
| `--do-space-6` | `24px` | Desktop page gutters and major section gaps. |
| `--do-density-compact-row` | `32px` min height | Sidebar rows, compact task actions. |
| `--do-density-control` | `34px` height | Standard buttons, inputs, selects. |
| `--do-density-touch` | `44px` min height | Mobile buttons, drawer rows, touch targets. |

Usage rules:

- Use compact density for repeated operational lists and metadata.
- Use touch density on Pixel 7-sized mobile controls.
- Forms should group related fields without wrapping every field in a large
  card. Long mobile forms should prioritize the primary work list before
  optional creation controls.

### Card Content Alignment

| Token | Value | Use |
| --- | --- | --- |
| `--do-card-border-width` | `1px` | Card and list-row border width. |
| `--do-card-padding-x` | `12px` | Horizontal padding inside every card-like surface. |
| `--do-card-content-inset` | `border + padding-x` (`13px`) | Inset for labels that head a stack of cards. |

Usage rules:

- Every element inside a card shares one content container: the card's own
  padding box. No child adds its own horizontal padding, margin, or indent, so
  the title, metadata row, progress bar, and badges all start and end on the
  same two vertical lines.
- A label that heads a stack of cards — a board column header, an archive month
  header, a list section header — insets its content by
  `--do-card-content-inset` so it sits on the same vertical line as the card
  content it labels, not on the card's outer border.
- Card-like surfaces (workflow card, checklist row, template card) use the same
  `--do-card-padding-x`, so content lines up when they appear in the same
  column.
- Rows with a leading control (checkbox, avatar) keep the control in the first
  grid column at the shared inset; the control column, not the row edge, is the
  alignment anchor for the text beside it.

### Radius, Borders, Shadows, And Focus

| Token | Value | Use |
| --- | --- | --- |
| `--do-radius-xs` | `4px` | Badges, small inline buttons. |
| `--do-radius-sm` | `6px` | Inputs, buttons, table row controls. |
| `--do-radius-md` | `8px` | Cards, modals, panels, empty states. |
| `--do-border` | `1px solid var(--do-color-border)` | Default divider and container border. |
| `--do-border-strong` | `1px solid var(--do-color-border-strong)` | Active controls and drawer/panel edges. |
| `--do-shadow-panel` | `0 18px 60px rgb(15 15 15 / 16%)` | Modal and overlay panel. |
| `--do-shadow-card` | `none` by default | Operational cards should prefer border over shadow. |
| `--do-focus-ring` | `0 0 0 2px color-mix(in srgb, var(--do-color-accent) 24%, transparent)` | Keyboard focus ring. |

Usage rules:

- Cards use radius `8px` or less.
- Default cards should not use raised shadows. Use borders and subtle hover
  backgrounds for scan-friendly operational surfaces.
- Focus uses `:focus-visible` where possible. Fallback `:focus` may remain for
  older portal controls during migration.

### Layers

| Token | Value | Use |
| --- | --- | --- |
| `--do-z-base` | `0` | Page content. |
| `--do-z-sticky` | `10` | Sticky toolbar or mobile top bar. |
| `--do-z-popover` | `30` | Custom select menu, doc menu, notification dropdown. |
| `--do-z-panel` | `40` | Task/workflow side panel, assistant review panel. |
| `--do-z-drawer` | `50` | Mobile sidebar drawer. |
| `--do-z-modal` | `60` | Modal dialog and scrim. |
| `--do-z-toast` | `70` | Toasts and temporary status. |

Layer rules:

- Drawers and modals need a scrim when underlying content remains visible.
- A panel may reserve layout width on desktop or overlay with explicit clipping
  and scrim rules. It must not accidentally cut off headings or lanes.
- Only one modal layer is active at a time.

### Responsive Breakpoints

| Token | Value | Intent |
| --- | --- | --- |
| `--do-bp-mobile` | `700px` | Pixel 7-sized mobile baseline. |
| `--do-bp-tablet` | `820px` | Switch between persistent sidebar and drawer. |
| `--do-bp-wide` | `1100px` | Multi-column operational lanes and reserved side panels. |
| `--do-width-sidebar` | `292px` | Default desktop workspace sidebar. |
| `--do-width-sidebar-rail` | `44px` | Collapsed sidebar rail. |
| `--do-width-panel` | `360px` | Task, workflow, notification, and assistant side panels. |
| `--do-width-content` | `760px` | Document/editor readable width. |
| `--do-width-ops` | `1120px` | Operational dashboard max width. |

## Compatibility Mapping

| Canonical token | Current portal source | Current work-engine source | Migration note |
| --- | --- | --- | --- |
| `--do-color-bg` | `--bg` | `--bg` in polish layer, `#f5f5f5` legacy body | Alias both to canonical. |
| `--do-color-shell` | `--sidebar` | `nav` legacy `#2c3e50` and mobile nav surface | Align the work-engine nav with the DataOps shell after token migration. |
| `--do-color-surface` | `--surface` | `--surface`, many `#fff` rules | Alias and remove hard-coded white over time. |
| `--do-color-border` | `--line` | `--border`, `#ddd`, `#e0e0e0`, `#eee` | Normalize borders before component migration. |
| `--do-color-accent` | `--accent` | `--primary`, `#3498db` | Portal accent is canonical; work-engine blue becomes alias only. |
| `--do-color-danger` | `--danger` | `#e74c3c`, `#b71c1c` | Normalize destructive/error states. |
| `--do-color-warning` | `#a96400` use in portal waiting states | `#e67e22`, `#fff3cd`, `#7a4f01` | Use waiting/follow-up tokens. |
| `--do-shadow-panel` | `--shadow` | `box-shadow: 0 1px 3px ...` cards | Reserve strong shadows for overlays. |
| `--do-card-padding-x` | `--card-padding-x` | per-component paddings | Live in `frontend/src/styles/base.css`; adopt for every card-like surface. |
| `--do-card-content-inset` | `--card-content-inset` | none yet | Used by board column and archive month headers to align with card content. |

