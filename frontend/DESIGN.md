# Product Design Guidelines

This app should feel closer to Notion than to a file manager or admin dashboard: calm, predictable, and focused on one page at a time.

## Product Shape

The app has three primary states:

- **Library**: find and understand documents.
- **Editor**: read and edit one document.
- **Create**: create a new document and then continue editing it.

On mobile, only one state is visible at a time. Do not combine navigation, editing, and creation in one long page.

## Layout Model

- Desktop uses a persistent left workspace sidebar and one main page canvas.
- Mobile uses a compact top bar for Library and a drawer for the workspace tree.
- Editor and Create use their own top toolbar on mobile; avoid stacked global navigation.
- The main content should read like a page, not a dashboard.

## Library

Library is the mental map of the documentation system.

- The file tree is the primary navigation object and lives in the sidebar/drawer.
- The tree starts below `docs/`; do not show a redundant root `docs` folder.
- Folders use explicit expand/collapse controls.
- Selecting a folder changes the document list to that folder.
- Selecting a file opens it in the Editor screen.
- Search and filters live in the sidebar/drawer.
- Domain and Type filters sit in one compact two-column row.
- Document rows are tappable as a whole and open documents inside the app.
- Do not make GitHub a primary action in the UI.

## Editor

Editor is for one document only.

- The document title/path and save status must remain visible.
- Editing should not move the user unexpectedly back to Explore.
- Save is explicit.
- Unsaved local changes are shown clearly but quietly.
- Local drafts stay in `localStorage` until saved or discarded.
- On mobile, content area should dominate; navigation chrome should be minimal.
- Until TipTap is implemented, the editor is a Markdown textarea styled as a page canvas.

## Create

Create is a short intake flow, not a second editor.

- Ask for path, title, type, and summary.
- After creation, immediately open the new document in Editor.
- Prefer creating inside the currently selected folder later.

## Mobile Rules

- Pixel 7 is the baseline mobile viewport.
- Avoid long stacked navigation/control blocks.
- Do not expose implementation settings such as API endpoint fields.
- Keep header/navigation compact.
- Search and filters belong in the drawer, not above every content screen.
- Document rows should be compact and scannable, with summaries clamped.
- Avoid layout jumps between loading, browsing, and editing.

## Inspiration

- **Notion**: sidebar/page navigation, one page workspace, low-chrome editing.
- **Confluence**: page tree as hierarchy, create/edit as explicit workflows.
- **GitBook**: content structure and editor are related but separate modes.
- **Google Drive mobile**: search plus filters help narrow large collections.
