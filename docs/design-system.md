---
title: "DataOps Design System"
summary: "Internal V1 design-system spec for shared portal, work-engine, and assistant UI tokens and components."
doc_type: reference
tags:
  - design
  - frontend
  - portal
  - work-engine
systems:
  - frontend
  - work-engine
related_docs:
  - docs/local-development.md
  - docs/operations-manager-platform-jtbd.md
  - docs/v1-runtime-architecture.md
---

# DataOps Design System

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
primary product surface. The calmer portal direction is the baseline. Legacy
DataTasks work-engine patterns are migration targets.

Primary inputs:

- `.goal-v1.md` for V1 workflow framing.
- `frontend/DESIGN.md` for the Notion-like, one-page-at-a-time workspace model.
- `docs/local-development.md` for the current portal/work-engine runtime split.
- `frontend/` for the current DataOps docs portal, Operations Home, task and
  bundle panels, notifications, document editing, create flow, and dark mode.
- `work-engine/src/pages/index.html` and `work-engine/src/public/app.js` for
  sign-in, dashboard, task tables, bundle cards, filters, recurring work,
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
   Podcast Assistant and future assistant UI must reuse DataOps components for
   jobs, artifacts, logs, approvals, retries, and review actions. They must not
   introduce a second assistant-specific visual language.
7. Incremental implementation.
   V1 uses current HTML, CSS, and JavaScript. Token aliases, class cleanup, and
   shared component names should precede any framework decision.

## Token Namespace

Use `--do-*` for canonical DataOps tokens. Existing `frontend/` and
`work-engine/` variables may remain as compatibility aliases during migration,
but new shared components should consume `--do-*`.

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
| `--do-color-shell` | `--sidebar` | `nav` legacy `#2c3e50` and mobile nav surface | Replace DataTasks nav with DataOps shell later. |
| `--do-color-surface` | `--surface` | `--surface`, many `#fff` rules | Alias and remove hard-coded white over time. |
| `--do-color-border` | `--line` | `--border`, `#ddd`, `#e0e0e0`, `#eee` | Normalize borders before component migration. |
| `--do-color-accent` | `--accent` | `--primary`, `#3498db` | Portal accent is canonical; work-engine blue becomes alias only. |
| `--do-color-danger` | `--danger` | `#e74c3c`, `#b71c1c` | Normalize destructive/error states. |
| `--do-color-warning` | `#a96400` use in portal waiting states | `#e67e22`, `#fff3cd`, `#7a4f01` | Use waiting/follow-up tokens. |
| `--do-shadow-panel` | `--shadow` | `box-shadow: 0 1px 3px ...` cards | Reserve strong shadows for overlays. |

## Component Primitives

### Workspace Shell

Canonical primitive: `do-shell`.

Includes:

- Persistent desktop sidebar.
- Mobile top bar.
- Mobile workspace drawer.
- Main page shell.
- Page toolbar.
- Optional right detail panel.

Usage rules:

- Use the DataOps workspace shell as the V1 baseline.
- Desktop shows the sidebar and one main workspace canvas.
- Mobile shows only one main state at a time. The drawer is modal and must
  trap focus, close on Escape, close on scrim click, and return focus to the
  opener.
- Work-engine top navigation is legacy. It may remain temporarily, but future
  shared portal and work-engine views should adopt the DataOps shell.

Current mapping:

- Portal: `.app-shell`, `.sidebar`, `.mobile-topbar`, `.page-shell`,
  `.page-toolbar`, `.sidebar-resize`, `.sidebar-toggle-button`.
- Work-engine: `nav`, `.brand`, route links, mobile menu. These map to
  `do-shell` but need DOM and class cleanup before full migration.

### Navigation And Library

Canonical primitives: `do-sidebar`, `do-drawer`, `do-tree`, `do-nav-row`,
`do-recent-list`.

Usage rules:

- The tree is the navigation object for docs and process context.
- Search and filters live inside the sidebar or drawer, not above every content
  screen on mobile.
- Folder rows need explicit expand/collapse buttons and selected state.
- GitHub links and low-level repo actions remain secondary tools.

Current mapping:

- Portal: `#doc-tree`, `.doc-tree`, `.tree-section`, `.tree-file`,
  `.tree-folder`, `.recent-list`, `.changes-section`.
- Work-engine: route links only. Future work-engine shell migration should
  move route navigation into DataOps workspace navigation or a compact page tab
  set where the full shell is not yet available.

### Page Header And Toolbar

Canonical primitives: `do-page-header`, `do-page-toolbar`, `do-save-state`,
`do-toolbar-actions`.

Usage rules:

- Page headers describe the current work surface, not the product.
- Operational page headings should be compact and leave work visible above the
  fold.
- Save, discard, view toggle, pin, notifications, and panel actions live in the
  toolbar.
- Disabled toolbar actions should remain visible only when they explain state;
  otherwise hide unavailable actions on mobile to preserve space.

Current mapping:

- Portal: `.page-toolbar`, `.page-context`, `.toolbar-actions`, `#save-state`,
  `#save-button`, `#discard-button`, `#work-bell-button`.
- Work-engine: route-level headings in generated HTML, `.page-header`,
  `.page-subtitle`, `.page-actions`, `.save-bar`.

### Search, Filters, Segmented Controls, And Tabs

Canonical primitives: `do-search`, `do-filter-group`, `do-segmented-control`,
`do-tabs`.

Usage rules:

- Use search for text narrowing and filters for structured state.
- Filter labels stay visible. Placeholder-only filters are not enough.
- Segmented controls are for mutually exclusive view modes such as bundle sort:
  `Date`, `Stage`, `Template`.
- Tabs are for stable sections within one task or workflow, not global product
  navigation unless the shell is unavailable.

Current mapping:

- Portal: `#search-form`, `#search-input`, `.filter-row`, custom selects,
  `#view-toggle-button`.
- Work-engine: `.filter-bar`, `.task-toolbar`, `.bundle-sort-control`,
  `.bundle-sort-btn`, `.search-input`, dashboard assigned-to-me controls.

### Buttons, Icon Buttons, And Links

Canonical primitives: `do-button`, `do-icon-button`, `do-link`,
`do-inline-action`.

Variants:

- `primary`: one main action in the local scope.
- `quiet`: secondary action in toolbar or row.
- `danger`: destructive action.
- `ghost`: low-emphasis navigation action.
- `inline`: text-level action inside a row or metadata block.

Usage rules:

- Prefer icons for common tool actions only when the icon has an accessible
  name and tooltip/title where helpful.
- Do not use emoji or decorative glyphs as the only signifier.
- Primary buttons use `--do-color-accent`; work-engine blue primary buttons
  should be migrated.
- Destructive actions need confirmation when deleting work, workflow state, or
  artifacts.

Current mapping:

- Portal: `.primary-button`, `.quiet-button`, `.icon-button`,
  `.new-page-button`, `.task-action-btn`.
- Work-engine: `.btn-primary`, `.btn-danger`, `.btn-today`, `.btn-back`,
  `.task-action-btn`, `.empty-state-action`, `.card-action-link`.

### Forms And Fields

Canonical primitives: `do-field`, `do-field-group`, `do-input`, `do-select`,
`do-date-input`, `do-checkbox`, `do-radio-group`, `do-save-bar`.

Usage rules:

- Labels are required for all inputs.
- Date inputs are common operational controls; keep them compact on desktop and
  full-width touch targets on mobile.
- Field groups should not become large decorative cards by default.
- Create flows should be short. On mobile, task creation should not push the
  task list below a long block of filters and fields unless creation is the
  selected state.

Current mapping:

- Portal: `.create-form`, `.scaffold-fieldset`, `.fm-editor`,
  `.block-step-attr-row`, `.git-commit-label`, custom selects.
- Work-engine: `.form-section`, `.form-row`, `.form-group`,
  `.editor-group`, `.editor-row`, `.radio-group`, `.template-editor`,
  `.task-def-item`.

### Tables, Lists, Rows, And Cards

Canonical primitives: `do-table`, `do-responsive-list`, `do-row`,
`do-card`, `do-empty-state`.

Usage rules:

- Use tables for dense desktop task comparison.
- On mobile, task tables become stacked task rows/cards with labels preserved.
- Use cards for repeated items such as workflow cards, template cards, and
  assistant artifacts. Do not nest cards inside page-section cards.
- Operational empty states should be compact and actionable. Avoid large
  center-aligned empty containers on desktop when they leave the rest of the
  workspace blank.

Current mapping:

- Portal: `.document-list`, `.document-row`, `.ops-lane`,
  `.ops-template-card`, `.ops-future-card`, `.empty-state`, `.ops-empty`.
- Work-engine: `table`, `.task-table-compact`, `.responsive-table`,
  `.dashboard-bundle-card`, `.bundle-card`, `.template-card`,
  `.empty-state-rich`.

### Documents And Process Context

Canonical primitives: `do-doc-row`, `do-doc-card`, `do-editor-canvas`,
`do-process-block`, `do-context-block`, `do-file-row`.

Usage rules:

- Documents support the workflow. They should not dominate the daily operations
  home.
- The editor is one document at a time.
- Process blocks can expose warnings, related docs, steps, screenshots, Looms,
  TODOs, and GitHub raw links, but the primary editor canvas remains readable.
- File and artifact rows use one shared primitive across documents, proof
  capture, assistant outputs, and workflow references.

Current mapping:

- Portal: `.editor-view`, `.document-title`, `.document-path`,
  `.markdown-editor`, `.rendered-view`, `.block-step`, `.block-todos`,
  `.block-loom`, `.block-warnings`, `.task-file-row`.
- Work-engine: instructions links, required link rows, bundle reference rows,
  template reference rows.

### Task Execution

Canonical primitives: `do-task-row`, `do-task-detail-panel`,
`do-task-status`, `do-proof-control`, `do-follow-up-control`,
`do-reminder-chip`.

Usage rules:

- Task rows show status, description, workflow/ad hoc context, due/follow-up
  date, assignee, proof state, and next action.
- A task cannot appear complete when required proof is missing.
- Waiting work needs `waitingFor`, `followUpAt`, and a clear follow-up action.
- Repeated daily execution should surface active task rows before creation
  controls on mobile.

Current mapping:

- Portal: `.task-panel`, `.task-status-badge`, `.task-follow-up-row`,
  `.task-file-section`, `.task-file-empty`, `.task-action-btn`.
- Work-engine: `.task-table-compact`, `.task-status-checkbox`,
  `.task-action-group`, `.follow-up-next-date`, `.badge-waiting`,
  `.required-link-wrapper`, `.task-checklist-row`.

### Workflow And Bundle Execution

Canonical primitives: `do-workflow-card`, `do-workflow-detail-panel`,
`do-progress-bar`, `do-stage-badge`, `do-bundle-link-row`,
`do-template-card`.

Usage rules:

- Workflows show title, stage, anchor date, progress, missing proof, waiting
  state, and next task.
- Workflow cards are scannable operational objects, not decorative dashboard
  tiles.
- Workflow detail can open as a desktop side panel from Operations Home and as
  a full-screen mobile state.
- Template cards are reusable workflow blueprints and should share card,
  badge, and metadata rules with workflow cards.

Current mapping:

- Portal: `#bundle-panel`, `.bundle-stage-select`,
  `.bundle-checklist-item`, `.bundle-checklist-evidence`,
  `.ops-template-card`, `.ops-card-chips`.
- Work-engine: `.dashboard-bundle-card`, `.bundle-card`,
  `.bundle-detail-header`, `.bundle-detail-badges`, `.bundle-links-editable`,
  `.template-card`, `.template-editor`, `.task-def-item`.

### Badges, Chips, And Metadata

Canonical primitives: `do-badge`, `do-chip`, `do-meta`.

Required variants:

- Status: todo, active, waiting, overdue, done, missing proof.
- Stage: preparation, active/execution, review, after-event, archived.
- Assignee.
- Reminder and follow-up.
- Proof required and proof missing.
- Progress.
- Assistant job status.

Usage rules:

- Badges are text-first.
- Chips are interactive only when they visibly behave like controls.
- Progress badges must include numerator and denominator text where possible.
- Stage badges should not encode workflow state by color alone.

Current mapping:

- Portal: `.task-status-badge`, `.bundle-checklist-evidence`,
  `.ops-card-chips`.
- Work-engine: `.badge-stage`, `.badge-status`, `.progress-badge`,
  `.badge-assignee`, `.badge-waiting`, `.badge-anchor-date`, `.badge-tag`,
  `.badge-type`, `.badge-trigger`, `.badge-bundle`, `.badge-adhoc`.

### Banners, Toasts, Modals, Drawers, And Panels

Canonical primitives: `do-banner`, `do-toast`, `do-dialog`, `do-drawer`,
`do-side-panel`, `do-popover`.

Usage rules:

- Use banners for persistent page-level errors or warnings.
- Use toasts for short-lived success/error/undo feedback.
- Dialogs require `role="dialog"`, `aria-modal="true"`, initial focus, Escape
  close, return focus, and scroll lock where content behind remains visible.
- Drawers are modal on mobile. Side panels may be non-modal on wide desktop if
  they reserve space and do not cover primary content.
- Notification dropdowns and custom selects use popover behavior and must close
  when focus leaves or Escape is pressed.

Current mapping:

- Portal: `#confirm-modal`, `#diff-modal`, `#lint-modal`,
  `#git-commit-modal`, `.quick-form-overlay`, `.quick-nav-panel`,
  `.undo-toast`, `.error-toast`, `.task-panel`, `.work-bell-panel`,
  `.doc-menu-popover`, `.custom-select-menu`.
- Work-engine: notification dropdown, notification page, error banners,
  `confirm()` for deletion, empty state actions.

### Assistant Job And Output Panels

Canonical primitives: `do-assistant-job-row`, `do-assistant-output-panel`,
`do-artifact-row`, `do-review-action`, `do-run-log`.

Usage rules:

- Podcast Assistant and future assistant UI must reuse DataOps shell, panels,
  cards, buttons, status badges, file rows, empty states, and proof/artifact
  controls.
- Assistant jobs are workflow-linked operational items. They should show job
  status, owner, linked workflow/task, input artifacts, outputs, logs, retry
  state, approval state, and next action.
- Assistant outputs become artifacts that can satisfy proof requirements only
  when the workflow/task explicitly accepts that artifact type.
- Assistant review actions use the same primary/quiet/danger button rules.
- Assistant-specific icons or colors may identify the source, but they must sit
  inside the shared badge/card/panel system.

Current mapping:

- Portal: Operations Home future section `Assistant Jobs` already previews the
  surface as an operational card.
- Work-engine: no assistant UI yet. Future #44 work should consume this spec
  instead of creating separate assistant styling.

## Current Surface Mapping

### Portal

| Surface | Current source | Shared components |
| --- | --- | --- |
| Workspace sidebar and drawer | `frontend/index.html`, `.sidebar`, `.mobile-topbar`, `.doc-tree` | `do-shell`, `do-sidebar`, `do-drawer`, `do-tree`, `do-nav-row`. |
| Library | `#library-view`, `.library-heading`, `.document-list` | `do-page-header`, `do-doc-row`, `do-empty-state`, `do-filter-group`. |
| Editor | `#editor-view`, `.document-title`, `.markdown-editor`, `.rendered-view` | `do-editor-canvas`, `do-process-block`, `do-save-state`. |
| Create flow | `#create-view`, `.create-form`, `.scaffold-fieldset` | `do-field-group`, `do-radio-group`, `do-save-bar`. |
| Operations Home | `renderOperationsHome`, `.operations-home`, `.ops-lane` | `do-ops-dashboard`, `do-task-row`, `do-workflow-card`, `do-reminder-chip`. |
| Task detail | `#task-panel`, `renderTaskPanel` | `do-side-panel`, `do-task-detail-panel`, `do-proof-control`, `do-follow-up-control`. |
| Workflow detail | `#bundle-panel`, `renderBundlePanel` | `do-workflow-detail-panel`, `do-progress-bar`, `do-stage-badge`, `do-bundle-link-row`. |
| Notifications | `#work-bell-button`, `.work-bell-panel` | `do-popover`, `do-notification-row`, `do-badge`. |
| Modals and toasts | lint, diff, confirm, git commit, quick nav, undo/error toasts | `do-dialog`, `do-toast`, `do-popover`. |
| Dark mode | `body.dark` token overrides | Canonical dark `--do-*` aliases. |

Portal drift to address:

- Operations Home desktop heading is too large for daily execution.
- Side panels can overlay wide headings and lanes; reserve space or add
  intentional overlay/scrim rules.
- Mobile drawer visually covers the page, but the spec requires modal focus,
  scroll, and return-focus behavior.
- Pixel 7 create flow has oversized title and scaffold controls for a short
  intake flow.

### Work-Engine

| Surface | Current source | Shared components |
| --- | --- | --- |
| Sign-in | `renderSignIn`, `.form-section` | `do-auth-panel`, `do-field-group`, `do-button`. |
| Top navigation | `work-engine/src/pages/index.html` `nav`, `.brand` | Legacy; map to `do-shell` when migrated. |
| Dashboard | `renderDashboard`, `.dashboard-layout`, `.dashboard-bundle-card` | `do-ops-dashboard`, `do-workflow-card`, `do-task-row`, `do-segmented-control`. |
| Task route | `renderTasks`, `.task-toolbar`, `.filter-bar`, `.form-section`, task table | `do-filter-group`, `do-task-row`, `do-table`, `do-field-group`. |
| Bundle route | `renderBundles`, `.bundle-card`, `renderBundleDetail` | `do-workflow-card`, `do-workflow-detail-panel`, `do-bundle-link-row`. |
| Recurring route | `renderRecurring`, generation forms, responsive table | `do-field-group`, `do-table`, `do-reminder-chip`. |
| Notifications | notification dropdown and `renderNotifications` | `do-popover`, `do-notification-row`, `do-empty-state`. |
| Templates | `renderTemplates`, `.template-card`, `.template-editor` | `do-template-card`, `do-field-group`, `do-task-definition-row`. |
| Proof and follow-up | required link inputs, waiting badges, follow-up actions | `do-proof-control`, `do-follow-up-control`, `do-status-badge`. |

Work-engine drift to address:

- Brand still says `DataTasks`; V1 shared shell should say `DataOps`.
- Sticky top nav is a legacy admin pattern beside the portal sidebar shell.
- Blue primary buttons and blue hover borders conflict with DataOps teal.
- Card-heavy dashboards, large mobile form cards, and empty states reduce
  operational density.
- Inline generated styles make tokens harder to apply.
- Badge, button, card, table, and form class names duplicate portal concepts.

## Prioritized Drift Migration

1. Token compatibility.
   Add `--do-*` tokens and alias current portal variables and work-engine polish
   variables. Map legacy hard-coded work-engine colors to semantic tokens.
2. Shell and layers.
   Make the portal DataOps shell canonical first. Define drawer, side-panel,
   popover, modal, and toast layer behavior before expanding to work-engine.
3. Buttons, focus, and forms.
   Normalize primary/quiet/danger/icon buttons, focus-visible rings, labels,
   field density, and date inputs.
4. Badges and chips.
   Replace separate portal/work-engine badge families with status, stage,
   assignee, follow-up, proof, progress, and assistant variants.
5. Task and workflow rows/cards.
   Align task rows, workflow cards, progress, required proof, and follow-up
   controls across Operations Home and work-engine.
6. Work-engine shell cleanup.
   Replace DataTasks top nav and generated inline class fragments after tokens
   and core primitives are stable.
7. Assistant UI reuse.
   Build Podcast Assistant and future assistant surfaces only on shared panels,
   artifacts, status badges, buttons, and empty states.

## Responsive Rules

### Desktop

- Use persistent sidebar at `--do-width-sidebar`.
- Page toolbar stays visible.
- Operations Home can use multi-column lanes only above `--do-bp-wide`.
- Detail panels may reserve `--do-width-panel` on the right. If overlaid, they
  need clear clipping rules and must not obscure primary headings or lane
  actions.
- Document editor content should stay near `--do-width-content`; operational
  dashboards may use `--do-width-ops`.

### Tablet

- Sidebar may collapse to rail or drawer at `--do-bp-tablet`.
- Operational lane grids reduce to two columns or one column depending on item
  width.
- Task/workflow detail should become an overlay panel only if focus and Escape
  behavior are implemented.
- Toolbars wrap into compact groups, with secondary actions hidden behind a
  menu when needed.

### Pixel 7-Sized Mobile

- Pixel 7 is the baseline mobile viewport.
- Show one primary state at a time: navigation drawer, document editor, create
  flow, task list, workflow detail, or assistant job panel.
- The drawer is modal. Underlying content is inert and does not scroll.
- Search and document filters stay in the drawer for docs browsing.
- Task execution mobile order is: page title, date/critical filters, active
  task list, workflow context, then optional create form. Creation can become
  its own state when the form is long.
- Workflow detail and assistant job panels become full-screen states with a
  compact back action and sticky primary action area only when needed.
- Modals and drawers use touch targets of at least `--do-density-touch`.
- Avoid long stacked navigation/control blocks before daily work.

## Accessibility Rules

- Keyboard access:
  All controls, cards with click handlers, rows with actions, custom selects,
  drawer toggles, notification popovers, and panels must be keyboard reachable.
- Focus:
  Use visible `:focus-visible` rings based on `--do-focus-ring`. Never remove
  outlines without replacement.
- Labels:
  Inputs, selects, date controls, icon buttons, and custom controls need
  accessible names. Placeholder text is not a label.
- Contrast:
  Text and interactive states must meet WCAG AA contrast for their text size.
  Muted text can be subtle, but not unreadable.
- Status messaging:
  Status is text plus optional color. Waiting, overdue, done, missing proof,
  dismissed, assistant failed, and assistant ready states must be readable
  without color.
- Motion:
  Respect `prefers-reduced-motion: reduce`. Disable hover transforms and reduce
  transitions to near-instant changes for users who request reduced motion.
- Dialogs and drawers:
  Use focus trap, initial focus, Escape close, return focus, accessible title,
  and scroll lock when the layer is modal.
- Tables:
  Preserve table headers on desktop and data labels on mobile stacked rows.
- Errors:
  Error banners and toasts should describe the failed action and next recovery
  step when possible.

## Implementation Sequencing

### Can Implement With Current HTML/CSS/JavaScript

- Add canonical `--do-*` tokens and alias current portal variables.
- Add compatibility aliases for work-engine `--primary`, `--border`,
  `--surface`, and legacy hard-coded colors where CSS variables already exist.
- Normalize focus-visible styles, button variants, input/select density,
  border/radius/shadow tokens, and dark-mode token overrides.
- Define shared badge classes while keeping current class names as aliases.
- Add reduced-motion CSS rules.
- Adjust panel/drawer z-index tokens and scrim behavior in current DOM.
- Document assistant job/output components and use them when #44 work starts.

### Needs DOM Or Generated HTML Cleanup

- Work-engine generated inline styles in `app.js` for forms, task definitions,
  required links, and recurring controls.
- Work-engine DataTasks top nav and route link structure.
- Clickable cards that need consistent role, tab index, and keyboard handling.
- Mobile task route ordering so active tasks are not pushed below long filters
  and create forms.
- Shared task/workflow card markup across portal Operations Home and
  work-engine dashboard/bundles.
- Modal replacement for `confirm()` deletion flows.

### Should Wait For Future Frontend Framework Decision

- Component package extraction.
- State-management rewrites.
- Full shared router or cross-app shell composition.
- Rich editor replacement beyond the current Markdown textarea/rendered view.
- Virtualized task/workflow lists.
- Complex assistant run timeline components if the assistant job lifecycle is
  still changing.

### Should Not Change In V1

- The current plain HTML/CSS/JavaScript stack.
- Runtime behavior not required for token or component normalization.
- The portal/work-engine Lambda split described in `docs/local-development.md`.
- Source repos outside `dataops`.
- Public DataTalksClub brand or marketing guidelines.

## Migration Plan

Phase 1: Spec and first shell implementation.

- Use this spec as the shared vocabulary.
- Implement #55 for portal shell tokens, focus, sidebar/drawer, page toolbar,
  panels, and compatibility aliases.
- Keep current portal behavior and verify desktop plus Pixel 7 screenshots.

Phase 2: Work-engine compatibility aliases.

- Add canonical tokens to work-engine CSS.
- Alias legacy `--primary`, `--border`, `--surface`, and hard-coded status
  colors where possible.
- Keep the top nav while reducing visual drift in colors, focus rings, buttons,
  badges, forms, and empty states.

Phase 3: Shared primitives in work-engine generated HTML.

- Replace inline form widths and hard-coded colors with shared classes.
- Migrate `.btn-primary`, `.btn-danger`, `.form-section`, `.filter-bar`,
  `.task-table-compact`, `.bundle-card`, `.template-card`, and badge families
  to shared primitive aliases.
- Reorder mobile task execution around active work before optional creation.

Phase 4: Unified task and workflow execution.

- Align portal Operations Home cards, work-engine task rows, bundle cards,
  detail panels, proof controls, and follow-up actions.
- Use the same status/proof/progress language in portal panels and
  work-engine detail pages.

Phase 5: Assistant surfaces.

- Build Podcast Assistant and future assistant UI with shared shell, panel,
  artifact row, status badge, empty state, and review action primitives.
- Link assistant artifacts to workflows and tasks using the same proof/evidence
  controls.

Phase 6: Framework decision, if needed.

- Decide on a frontend framework only after V1 component vocabulary is stable
  and repeated DOM/class cleanup shows real maintenance pain.
- If a framework is adopted, preserve token names, component names, accessibility
  rules, and responsive behavior from this spec.

## Verification Guidance

Docs-only changes to this spec need:

- `git diff --check`
- cheap markdown/link inspection for changed docs

Runtime UI checks are not required for this issue because this spec does not
change CSS, JavaScript, HTML behavior, Lambda code, or work-engine runtime code.
Implementation issues such as #55 must run focused portal checks and capture
desktop plus Pixel 7 screenshots.
