> Part 3 of 3 of the historical [DataOps Design System](../design-system.md)
> spec. [Part 1](part-1-principles-and-tokens.md) covers principles, tokens,
> and the compatibility mapping; [Part 2](part-2-component-primitives-and-surfaces.md)
> covers component primitives and surface mapping.

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
- Imported work-engine top nav and route link structure.
- Clickable cards that need consistent role, tab index, and keyboard handling.
- Mobile task route ordering so active tasks are not pushed below long filters
  and create forms.
- Shared task/workflow card markup across portal Operations Home and
  work-engine dashboard/cards.
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
  `.task-table-compact`, `.card-card`, `.template-card`, and badge families
  to shared primitive aliases.
- Reorder mobile task execution around active work before optional creation.

Phase 4: Unified task and workflow execution.

- Align portal Operations Home cards, work-engine task rows, card cards,
  detail panels, proof controls, and follow-up actions.
- Use the same status/proof/progress language in portal panels and
  work-engine detail pages.

Phase 5: Assistant surfaces.

- Build DataOps podcast assistant and future assistant UI with shared shell, panel,
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
