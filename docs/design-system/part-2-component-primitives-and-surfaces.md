> Part 2 of 3 of the historical [DataOps Design System](../design-system.md)
> spec. [Part 1](part-1-principles-and-tokens.md) covers principles, tokens,
> and the compatibility mapping; [Part 3](part-3-responsive-accessibility-and-migration.md)
> covers responsive, accessibility, and migration rules.

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
  `.page-toolbar`, `.sidebar-toggle-button`.
- Work-engine: `nav`, `.brand`, route links, mobile menu. These map to
  `do-shell` but need DOM and class cleanup before full migration.

### Navigation And Library

Canonical primitives: `do-sidebar`, `do-drawer`, `do-nav-row`,
`do-filter-group`.

Usage rules:

- The global sidebar and mobile drawer are navigation-only.
- Search and structured filters are owned by their main-canvas surface; the
  shell exposes them only where that surface is active.
- Process Docs uses one filtered document list; do not add a second sidebar
  hierarchy for the same destination.
- Navigation rows need explicit selected state where the row represents the
  current route or selection.
- GitHub links and low-level repo actions remain secondary tools.

Current mapping:

- Portal: `.sidebar`, `.mobile-topbar`, `.document-list`, `.filter-row`,
  `.changes-section`.
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
- The desktop toolbar contains global controls such as help, account,
  notifications, and contextual view toggles.
- Save, discard, and mutation state live in the form or editor that owns the
  mutation, not in the global toolbar.
- Disabled toolbar actions should remain visible only when they explain state;
  otherwise hide unavailable actions on mobile to preserve space.

Current mapping:

- Portal: `.page-toolbar`, `.page-context`, `.toolbar-actions`,
  `#work-bell-button`; the editor owns its inline status and mutation controls.
- Work-engine: route-level headings in generated HTML, `.page-header`,
  `.page-subtitle`, `.page-actions`, `.save-bar`.

### Search, Filters, Segmented Controls, And Tabs

Canonical primitives: `do-search`, `do-filter-group`, `do-segmented-control`,
`do-tabs`.

Usage rules:

- Use search for text narrowing and filters for structured state.
- Filter labels stay visible. Placeholder-only filters are not enough.
- Segmented controls are for mutually exclusive view modes such as card sort:
  `Date`, `Stage`, `Template`.
- Tabs are for stable sections within one task or workflow, not global product
  navigation unless the shell is unavailable.

Current mapping:

- Portal: `#search-form`, `#search-input`, `.filter-row`, custom selects,
  `#view-toggle-button`.
- Work-engine: `.filter-bar`, `.task-toolbar`, `.card-sort-control`,
  `.card-sort-btn`, `.search-input`, dashboard assigned-to-me controls.

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
- A surface header may own the primary creation action for that surface, as the
  Process Docs header does.
- Destructive actions need confirmation when deleting work, workflow state, or
  artifacts.

Current mapping:

- Portal: `.primary-button`, `.quiet-button`, `.icon-button`,
  `.ops-docs-create`, `.task-action-btn`.
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
  `.dashboard-card-card`, `.card-card`, `.template-card`,
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
- Work-engine: instructions links, required link rows, card reference rows,
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

### Workflow And Card Execution

Canonical primitives: `do-workflow-card`, `do-workflow-detail-panel`,
`do-progress-bar`, `do-stage-badge`, `do-card-link-row`,
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

- Portal: `#card-panel`, `.card-stage-select`,
  `.card-checklist-item`, `.card-checklist-evidence`,
  `.ops-template-card`, `.ops-card-chips`.
- Work-engine: `.dashboard-card-card`, `.card-card`,
  `.card-detail-header`, `.card-detail-badges`, `.card-links-editable`,
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

- Portal: `.task-status-badge`, `.card-checklist-evidence`,
  `.ops-card-chips`.
- Work-engine: `.badge-stage`, `.badge-status`, `.progress-badge`,
  `.badge-assignee`, `.badge-waiting`, `.badge-anchor-date`, `.badge-tag`,
  `.badge-type`, `.badge-trigger`, `.badge-card`, `.badge-adhoc`.

### Banners, Toasts, Modals, Drawers, And Panels

Canonical primitives: `do-banner`, `do-toast`, `do-dialog`, `do-drawer`,
`do-side-panel`, `do-popover`.

Usage rules:

- Keep mutation success, validation, warning, and failure feedback in the
  owning surface's live region so it stays next to the work being performed.
- Reserve the shell toast for short-lived reversible actions such as Undo; do
  not add a global mutation-feedback channel.
- Dialogs require `role="dialog"`, `aria-modal="true"`, initial focus, Escape
  close, return focus, and scroll lock where content behind remains visible.
- Drawers are modal on mobile. Side panels may be non-modal on wide desktop if
  they reserve space and do not cover primary content.
- Notification dropdowns and custom selects use popover behavior and must close
  when focus leaves or Escape is pressed.

Current mapping:

- Portal: `#confirm-modal`, `#diff-modal`, `#lint-modal`,
  `#git-commit-modal`, `.quick-form-overlay`, `.quick-nav-panel`,
  `.undo-toast`, `.editor-inline-status`, `.changes-status`, `.task-panel`, `.work-bell-panel`,
  `.doc-menu-popover`, `.custom-select-menu`.
- Work-engine: notification dropdown, notification page, error banners,
  `confirm()` for deletion, empty state actions.

### Assistant Job And Output Panels

Canonical primitives: `do-assistant-job-row`, `do-assistant-output-panel`,
`do-artifact-row`, `do-review-action`, `do-run-log`.

Usage rules:

- DataOps podcast assistant and future assistant UI must reuse DataOps shell, panels,
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
| Workspace sidebar and drawer | `frontend/index.html`, `.sidebar`, `.mobile-topbar` | `do-shell`, `do-sidebar`, `do-drawer`, `do-nav-row`. |
| Library | `#library-view`, `.document-list-header`, `.document-list` | `do-page-header`, `do-doc-row`, `do-empty-state`, `do-filter-group`. |
| Editor | `#editor-view`, `.document-title`, `.markdown-editor`, `.rendered-view` | `do-editor-canvas`, `do-process-block`, `do-save-state`. |
| Create flow | `#create-view`, `.create-form`, `.scaffold-fieldset` | `do-field-group`, `do-radio-group`, `do-save-bar`. |
| Operations Home | `renderOperationsHome`, `.operations-home`, `.ops-lane` | `do-ops-dashboard`, `do-task-row`, `do-workflow-card`, `do-reminder-chip`. |
| Task detail | `#task-panel`, `renderTaskPanel` | `do-side-panel`, `do-task-detail-panel`, `do-proof-control`, `do-follow-up-control`. |
| Workflow detail | `#card-panel`, `renderCardPanel` | `do-workflow-detail-panel`, `do-progress-bar`, `do-stage-badge`, `do-card-link-row`. |
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
| Dashboard | `renderDashboard`, `.dashboard-layout`, `.dashboard-card-card` | `do-ops-dashboard`, `do-workflow-card`, `do-task-row`, `do-segmented-control`. |
| Task route | `renderTasks`, `.task-toolbar`, `.filter-bar`, `.form-section`, task table | `do-filter-group`, `do-task-row`, `do-table`, `do-field-group`. |
| Card route | `renderCards`, `.card-card`, `renderCardDetail` | `do-workflow-card`, `do-workflow-detail-panel`, `do-card-link-row`. |
| Recurring route | `renderRecurring`, generation forms, responsive table | `do-field-group`, `do-table`, `do-reminder-chip`. |
| Notifications | notification dropdown and `renderNotifications` | `do-popover`, `do-notification-row`, `do-empty-state`. |
| Templates | `renderTemplates`, `.template-card`, `.template-editor` | `do-template-card`, `do-field-group`, `do-task-definition-row`. |
| Proof and follow-up | required link inputs, waiting badges, follow-up actions | `do-proof-control`, `do-follow-up-control`, `do-status-badge`. |

Work-engine drift to address:

- Work-engine brand now says `DataOps`; V1 still needs shared shell and token convergence.
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
   Replace the imported work-engine top nav and generated inline class
   fragments after tokens and core primitives are stable.
7. Assistant UI reuse.
   Build DataOps podcast assistant and future assistant surfaces only on shared panels,
   artifacts, status badges, buttons, and empty states.

