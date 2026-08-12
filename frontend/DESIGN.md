# Process Docs design pattern

The shared DataOps tokens, components, shell, responsive rules, states, and
accessibility requirements are defined in [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md).
This document narrows those rules for the Process Docs experience.

Process Docs should feel calm, predictable, and focused on one page at a time.

## Product shape

The Docs route has three primary states:

- **Library:** find and understand documents.
- **Editor:** read or edit one document.
- **Create:** capture document metadata, then continue in the editor.

On mobile, only one state is visible at a time. Do not combine navigation,
editing, and creation into one long page.

## Library

- The document tree is the primary Docs navigation object and lives in the
  sidebar or drawer only while the Docs route owns the shell.
- The tree starts below the repository content root; do not render a redundant
  root folder.
- Folders use explicit expand and collapse controls.
- Selecting a folder changes the document list; selecting a file opens the
  editor.
- Search and document filters live in the Docs sidebar or drawer.
- Document rows are compact, divided, and whole-row actionable.
- Do not make GitHub or repository plumbing a primary operator action.

## Editor

- The title, path, save status, and relevant return context remain visible.
- Editing must not navigate unexpectedly back to the library.
- Save is explicit. Unsaved local changes are shown clearly but quietly.
- Local drafts remain recoverable until saved or deliberately discarded.
- On mobile, the editor owns the viewport and global workspace chrome recedes.
- Until a structured editor is adopted, style the Markdown textarea as a page
  canvas using the shared form and focus tokens.

## Create

- Create is a short intake flow, not a second editor.
- Ask only for path, title, type, summary, and scaffold choice.
- Use the shared stacked form language and footer action row.
- After creation, open the new document directly in the editor.

## Responsive rules

- The 390×844 workspace baseline applies.
- Search, filters, and the tree belong in the drawer, not above document
  content.
- Reader and editor content use a readable maximum width.
- Document summaries clamp before the title or primary action is lost.
- Avoid layout jumps among loading, browsing, reading, and editing states.

## Additional references

- Notion: sidebar and page navigation, one-page workspace, low-chrome editing.
- Confluence: explicit page tree and create/edit workflows.
- GitBook: related but distinct content structure and editor modes.
