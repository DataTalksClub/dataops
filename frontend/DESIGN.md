# Process Docs and Operating Model

The shared DataOps tokens, components, shell, responsive rules, states, and
accessibility requirements are defined in [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md).
This document narrows those rules for the Knowledge family: Process Docs
library, Process Docs reader, Operating Model hub and section, and the shared
chrome on My Plan.

Knowledge is an editorial system, not an admin dashboard.

- Process Docs **library** = a catalog of documents.
- Process Docs **reader** = one editorial page.
- Operating Model **hub** = a system map of named families.
- Operating Model **section** = definition rows.

Stay on dakit `--dk-*` tokens. Do not invent a second palette, a second type
scale, or colored edge accents.

## Product shape

The Docs route has three primary states:

- **Library:** find and open a document.
- **Reader / editor:** one page.
- **Create:** capture document metadata, then continue in the editor.

On mobile, only one state is visible at a time.

## Type and measure

- One page-title scale on every surface in this family: `--dk-text-page`
  (32px desktop, 22px mobile), weight 600.
- Reader prose measure is **40rem**. Library, hub, section, and My Plan use
  `--content-width` (56rem).
- Body in the reader is 14px / 1.6. Metadata is 12px, sentence case, middots.
- Counts use `--dk-font-mono` at 15px / 600.

## Library

- H1 `Docs`. No eyebrow. No explainer. The sidebar already names the surface.
- One primary action: `New process doc`, content-width.
- The primary object is the catalog of loaded documents. Each row: title, one
  muted metadata line, whole-row open.
- Search and filters stay in the Docs sidebar or drawer.
- Quality Findings is not the home of Docs. Omit it when there are zero
  findings. If non-zero, one quiet `N findings` disclosure.
- GitHub planning docs, if shown at all, sit under a quiet `Project docs`
  disclosure after the catalog.

## Reader

- One H1: the document title. Hide `#document-title` and `#document-path`.
- Strip a leading `#` or `##` heading from the rendered body when it duplicates
  the title. Display-only; do not change the SOP parser.
- One muted metadata line: humanized type · systems · tags, deduped. SOP step
  counts may follow. No pills. `Edit metadata` is a quiet text button.
- Section headings are the section name. Never prefix `Section`.
- Related docs use document titles, not repository paths. Omit when empty.
- Hide empty TODO chrome and native file-picker chrome (`Choose File`).
- Reserve bottom padding so Discard / History / Save cannot cover prose.

## Operating Model

- Hub H1 `Operating Model` at the page-title scale. No kicker. No explainer.
- One bordered container of named rows: family name and a mono count. The whole
  row is the control. No chevron buttons. No per-row restatement.
- Section H1 is the title-cased family name (`Functions`). Entity rows: name,
  outcome, one muted metadata line. Whole-row open when a source document
  exists.
- My Plan shares this chrome. State is a word (`Active`, `Proposed`). No
  colored left edge. No uppercase letterspaced labels.

## Radius and border

- Page canvas and reader rules: radius 0.
- One library / hub / section container: `--dk-radius-md` (6px). Inner rows: 0.
- Status is a word. Selection is accent-soft fill. No colored left or top edge.

## Create

- Create is a short intake flow, not a second editor.
- Ask only for path, title, type, summary, and scaffold choice.
- After creation, open the new document directly in the editor.

## Responsive rules

- The 390×844 workspace baseline applies.
- Search, filters, and the tree belong in the drawer, not above document
  content.
- Touch targets are 44px on 390px. Hub and catalog rows are the control.
- Avoid layout jumps among loading, browsing, reading, and editing states.

## Banned tells

Page-level eyebrows; explainer sub-lines under every H1; two page-title
scales; duplicate document H1; `Section` prefixes; type/system/tag pills;
raw repository paths as related-doc labels; native file-picker chrome; empty
TODO slabs; Quality Findings as the Docs home; GitHub planning docs as the
catalog; colored edge accents; identical chevron buttons; lowercase slug H1s;
uppercase letterspaced meta labels; `Open source document`; nested cards;
full-width primary buttons; hardcoded hex; sticky footer covering prose.

## Additional references

- Notion: sidebar and page navigation, one-page workspace, low-chrome editing.
- Confluence: explicit page tree and create/edit workflows.
- GitBook: related but distinct content structure and editor modes.
