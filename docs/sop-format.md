---
title: "SOP Structured Markdown Format"
summary: "Conventions for marking up SOP markdown files with HTML-comment boundaries so they can be programmatically parsed without losing GitHub rendering."
doc_type: reference
tags: []
systems: []
related_docs:
  - STRUCTURE.md
---

# SOP Structured Markdown Format

## Summary

This is a convention for adding **invisible structure** to our SOP markdown
files. The goal:

- A human opens the file on GitHub and sees a clean rendered SOP — no visible
  noise from the markup.
- A script (or an agent) opens the same file and gets a fully structured tree:
  sections, groups, steps with attributes, screenshots with captions.

The structure is carried by HTML comments (`<!-- ... -->`). GitHub strips
them from the rendered output; our parser treats them as load-bearing.

This document defines the format. The implementation lives in:

- `scripts/sop_parse.py` — read a marked-up file → JSON
- `scripts/sop_lint.py` — validate a file against this spec
- `scripts/sop_normalize.py` — convert a legacy SOP into marked-up form

## Content

### Why HTML comments

We considered three alternatives and rejected them:

1. **Pure convention** (`### Step N` headings, strict ordering): cannot carry
   per-step metadata, and silently breaks when an editor reorders or renames a
   section.
2. **YAML frontmatter for the whole body**: loses GitHub rendering — images
   wouldn't display.
3. **MDX or a custom format**: GitHub renders MDX as plain text; not viable.

HTML comments are the only thing that round-trips: GitHub respects them
(invisible in rendered view) and a parser can find them with a regex.

### Document shape

Every SOP has this skeleton:

```markdown
---
title: "..."
doc_type: sop
schema_version: 1
systems: [...]
...
---

# <Title>

<!-- sop-section-start: summary -->
## Summary
...
<!-- sop-section-end -->

<!-- sop-section-start: prerequisites -->
## Prerequisites
...
<!-- sop-section-end -->

<!-- sop-section-start: procedure -->
## Procedure
...steps and groups go here...
<!-- sop-section-end -->

<!-- sop-section-start: validation -->
## Validation
...
<!-- sop-section-end -->

<!-- sop-section-start: troubleshooting -->
## Troubleshooting
...
<!-- sop-section-end -->

<!-- sop-section-start: references -->
## References
...
<!-- sop-section-end -->
```

All six sections are required (even if empty). The marker name
(`summary`, `prerequisites`, …) is the parser key — the visible `## Heading`
text is purely for rendering and may be changed without breaking parsing.

### Frontmatter

Unchanged from current practice, with one addition:

- `schema_version: 1` — opt-in marker that this file conforms to this spec.
  Files without `schema_version` are treated as legacy and parsed with a
  best-effort fallback.

Required fields: `title`, `doc_type: sop`. All other fields stay as
documented in `docs/STRUCTURE.md`.

### Stable document IDs and internal links

Every document may have a stable frontmatter `id`. The `id` is the document's
cross-link identity and should not change when the file is renamed or moved.
Use lowercase letters, numbers, dots, dashes, and underscores only. Prefer a
namespace that starts with the document type and domain:

```yaml
---
id: sop.community.slack.export-dump
title: "Export Create a dump of Slack Data"
aliases:
  - community-slack-export-dump
---
```

Other document types use the same convention:

- `template.media.podcast.remind-guest-one-day-before`
- `reference.finance.invoices-receipts-and-statements`
- `playbook.courses.launch-cohort`
- `task-template.tasks.podcast`

Use wiki-style links for internal cross-links:

```markdown
[[community-slack-export-dump]]
[[community-slack-export-dump|Slack export dump]]
```

Rules:

- `[[id]]` renders with the target document title.
- `[[id|label]]` renders with the explicit label.
- `aliases` are optional old IDs or old paths that should still resolve.
- Existing relative Markdown links may remain, but new internal links should
  prefer `[[id]]` so links survive path and title changes.

### Procedure: groups and steps

Inside `<!-- sop-section-start: procedure -->`, every piece of content must live inside
one of these blocks:

- `<!-- sop-group-start: "Title" -->` ... `<!-- sop-group-end -->`
- `<!-- sop-step-start ... -->` ... `<!-- sop-step-end -->`
- `<!-- sop-prose-start -->` ... `<!-- sop-prose-end -->` (free transitional text)
- `<!-- sop-todo: "..." -->` (self-closing)

Orphan text inside a procedure (text outside any block) is a **lint error**.

#### Groups

```markdown
<!-- sop-group-start: "Getting the audio file" -->
### Getting the audio file

<!-- sop-step-start id=1 ... -->
...
<!-- sop-step-end -->

<!-- sop-step-start id=2 ... -->
...
<!-- sop-step-end -->
<!-- sop-group-end -->
```

Groups are optional. A flat procedure (no groups) is valid. When groups are
used, every step must live inside one.

Step `id` numbering is continuous across the whole procedure, not reset per
group — matches current practice (e.g. the podcast doc numbers 1..49 across
7 groups).

#### Steps

```markdown
<!-- sop-step-start id=5 systems="google-drive" action="upload" -->
5.  Upload the audio to the [podcast-raw-audio folder](...).

    For that, you can drag-and-drop the file or right click on the
    empty space and select "File Upload".

    <!-- sop-screenshot-start -->
    ![](../../../assets/.../image52.jpg)
    <!-- sop-caption-start -->
    This screenshot anchors the step about uploading the audio file.
    <!-- sop-caption-end -->
    <!-- sop-screenshot-end -->
<!-- sop-step-end -->
```

Step attributes:

- `id` is required. It must be an integer, and it is the stable identifier
  independent of the rendered `N.` number.
- `systems` is optional. It is a comma-separated list and must be a subset of
  the doc's `systems` frontmatter.
- `action` is optional. It must be one of `navigate`, `click`, `type`,
  `upload`, `download`, `copy`, `paste`, `submit`, `verify`, `wait`, or
  `other`.
- `tool` is optional free text for a specific tool or feature name.

The rendered number (`5.`) is what GitHub displays. `id=5` is what the
parser uses. The normalizer keeps them in sync, but if they ever diverge,
**`id` wins** — the rendered number is just sugar.

#### Screenshots

A step has zero or more screenshots. Each screenshot block:

```markdown
<!-- sop-screenshot-start -->
![alt text](path/to/image.jpg)
<!-- sop-caption-start -->
Caption text describing what to look for in the image.
<!-- sop-caption-end -->
<!-- sop-screenshot-end -->
```

Rules:

- Exactly one `![](...)` line per `<!-- sop-screenshot-start -->` block.
- `<!-- sop-caption-start -->` is optional but recommended.
- The legacy `Image note:` prefix is removed by the normalizer — captions
  live inside the marker, not as a sibling paragraph.

#### Prose blocks

For transitional text between steps that doesn't belong to either side:

```markdown
<!-- sop-prose-start -->
Now we're ready to submit a transcription job.
Go to <https://github.com/alexeygrigorev/podcast-transcriber/>
<!-- sop-prose-end -->
```

Prose blocks should be rare. Most transitional text belongs in the
preceding step's body. Lint warns (does not error) if a prose block could
be merged into an adjacent step.

#### TODO markers

```markdown
<!-- sop-todo: "Document VLC audio extraction" -->
```

Self-closing. Parser exposes all TODOs as a list. Use these for known gaps
rather than burying `TODO` in step text.

### Notes and callouts

Use a markdown blockquote:

```markdown
> Note: Append `/2` for Cohort 2, `/3` for Cohort 3, etc.
```

This renders as a quoted block on GitHub and needs no marker. The parser
does not extract notes as structured data — they're part of the step body.

### Escape hatch: raw sections

For SOPs that don't fit the step/screenshot pattern (template text, free
prose, copy banks — e.g. `post-podcast-guest-recommendations.md`), mark
the section as raw:

```markdown
<!-- sop-section-start: procedure raw -->
## Procedure

### LinkedIn
Figma pdf + text
...freeform content the parser does not analyze...
<!-- sop-section-end -->
```

The parser returns `raw: true` and the verbatim markdown body for that
section. Lint skips structural checks inside raw sections.

### Parsed shape

`sop_parse.py <file>` produces:

```json
{
  "schema_version": 1,
  "frontmatter": { "title": "...", "doc_type": "sop", "systems": [...] },
  "sections": {
    "summary":         { "raw": false, "body_md": "..." },
    "prerequisites":   { "raw": false, "body_md": "..." },
    "procedure": {
      "raw": false,
      "groups": [
        {
          "title": "Getting the audio file",
          "steps": [
            {
              "id": 1,
              "rendered_number": 1,
              "attrs": { "systems": ["youtube"], "action": "navigate" },
              "body_md": "Open the Youtube video ...",
              "screenshots": [
                { "alt": "", "src": "../.../image46.jpg",
                  "caption": "This screenshot ..." }
              ]
            }
          ]
        }
      ],
      "flat_steps": [],
      "prose": [{"after_step_id": 10, "body_md": "..."}],
      "todos": ["Document VLC audio extraction"]
    },
    "validation":      { "raw": false, "body_md": "" },
    "troubleshooting": { "raw": false, "body_md": "" },
    "references":      { "raw": false, "body_md": "" }
  }
}
```

If the procedure has no `<!-- group -->` blocks, `groups` is `[]` and steps
go in `flat_steps`.

### Migration

Files migrate one at a time:

1. Run `scripts/sop_normalize.py <file>` — auto-injects markers from the
   legacy structure (numbered list + `Image note:` heuristics).
2. Open the diff; eyeball edge cases (multi-image steps, free prose).
3. Add `schema_version: 1` to the frontmatter.
4. Run `scripts/sop_lint.py <file>` — must pass before commit.
5. CI runs lint on every file with `schema_version: 1` and fails the PR
   on any violation.

Files without `schema_version` are ignored by lint. The conversion is not
all-or-nothing.

## References

- `docs/STRUCTURE.md` — overall doc taxonomy and required frontmatter.
- `scripts/sop_parse.py`, `scripts/sop_lint.py`, `scripts/sop_normalize.py`.
