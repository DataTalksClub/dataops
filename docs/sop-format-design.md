---
title: "SOP Structured Markdown Format: design notes"
summary: "Why our SOP markdown files use HTML-comment markers, what the format looks like, and the tooling we built to keep files valid."
doc_type: reference
tags: []
systems: []
related_docs:
  - sop-format.md
---

# SOP Structured Markdown Format: design notes

This is the design log for the structured-markdown format used across all
240 SOPs in this repository. The strict spec lives at
[`sop-format.md`](sop-format.md); this document explains **why** the format
exists, **how** we arrived at the current shape, and **what tooling**
keeps it valid.

## Why this format

Our SOPs follow a recognisable shape: a series of numbered steps, each
with a short instruction and (almost always) a screenshot. The structure
is consistent enough that a script could in principle pull a step
sequence out of any SOP and feed it to an agent, a renderer, or a
checklist runner.

In practice this was hard to do reliably because nothing in the file
enforced or signalled the structure. Step numbering was ad-hoc (a few
files restarted `1.` mid-document, or duplicated numbers across
sub-procedures). Image captions sat as sibling paragraphs prefixed with
`Image note:` rather than as data attached to the image. Sub-procedures
were `### headings` whose semantics had to be inferred. Every parser would
have had to re-invent heuristics, and every editor could break them
without noticing.

We wanted two things at once:

1. A **parsed tree** of each SOP — sections, groups, steps with
   attributes, screenshots with captions — so agents and the frontend can
   work with structured data instead of regex-guessing.
2. **Native GitHub rendering** — the file you open on github.com still
   looks like a clean SOP with the images displayed inline.

### Alternatives we ruled out

- **Pure heading/list convention.** `### Step N` for steps, strict
  ordering, no markers. Cannot carry per-step metadata (system, action,
  stable id). Silently breaks when an editor inserts or renames a
  section. Rejected.
- **YAML frontmatter for the entire body.** Lossless and easy to parse,
  but GitHub renders the YAML as code — images don't display, formatting
  is gone. Rejected because the rendering goal is non-negotiable.
- **MDX or a custom file extension.** GitHub renders unknown formats as
  plain text. Rejected.

### What we chose

HTML comments as **boundary markers**. GitHub strips them from the
rendered output (invisible to readers) but a parser finds them with a
regex. Every marker is prefixed with `sop-` so it cannot collide with
comments from other tools, and uses explicit `-start` / `-end` suffixes
rather than the slash-close HTML convention so the source reads
naturally for humans hand-editing.

### Why explicit start/end markers

We considered self-closing markers like `<!-- sop-step 1 -->` before each
numbered item. Rejected because they make body boundaries ambiguous: if
prose appears between two steps, the parser cannot tell whether it
belongs to the previous step, the next step, or neither. Explicit
`<!-- sop-step-start --> ... <!-- sop-step-end -->` removes the
ambiguity at the cost of one extra line per step.

## How the format looks

A snippet — full spec in [`sop-format.md`](sop-format.md):

```markdown
<!-- sop-section-start: procedure -->
## Procedure

<!-- sop-group-start: "Getting the audio file" -->
### Getting the audio file

<!-- sop-step-start id=1 -->
1.  Open the YouTube video and click "Edit video".

    <!-- sop-screenshot-start -->
    ![](../../../images/podcast/.../image1.jpg)
    <!-- sop-caption-start -->
    Look for the Edit video button below the player.
    <!-- sop-caption-end -->
    <!-- sop-screenshot-end -->
<!-- sop-step-end -->

<!-- sop-group-end -->
<!-- sop-section-end -->
```

Key properties:

- **Six fixed sections** wrap the body: `summary`, `prerequisites`,
  `procedure`, `validation`, `troubleshooting`, `references`. The
  marker name is the parser key — the visible `## Heading` text is just
  for rendering.
- **Groups are optional inside Procedure.** A flat procedure (no
  sub-groups) is valid. When groups are used, every step must live
  inside one.
- **Step `id` is the stable identifier**, independent of the rendered
  `N.` number. Numbering is continuous across the whole procedure (not
  reset per group), so a step keeps the same id even if groups are
  renamed or reordered.
- **`schema_version: 1`** in the frontmatter opts a file into strict
  validation. Files without it are treated as legacy.
- **Escape hatch:** `<!-- sop-section-start: procedure raw -->` marks a
  section as opaque markdown. Useful for SOPs whose body is a template
  text or copy bank rather than a step-by-step procedure.

## The tooling

Three stdlib-only Python scripts under `scripts/`. Each one does one
thing and is callable from the shell or imported as a library.

### `scripts/sop_parse.py`

Reads a marked-up SOP and emits the parsed tree as JSON.

```bash
python3 scripts/sop_parse.py path/to/sop.md --pretty
```

Returns a dict with `frontmatter`, `schema_version`, and `sections`. The
`procedure` section contains `groups` (each with `steps`), `flat_steps`
(when there are no groups), `prose` blocks, and `todos`. Each step
exposes its `id`, `attrs` (systems, action, tool), `body_md`, and
`screenshots` (each with `src`, `alt`, and `caption`).

This is the entry point for any agent or tool that wants structured SOP
data.

### `scripts/sop_lint.py`

Validates a file against the spec. Used in CI gating once we wire it up.

```bash
python3 scripts/sop_lint.py path/to/sop.md
```

Checks:

- Frontmatter has `title` and `doc_type` (`sop` or `checklist`).
- All six required sections are present (even if empty).
- Marker open/close pairs balance.
- Step ids are unique and sequential `1..N`.
- A procedure is either all-grouped or all-flat — not mixed.
- Step `action` attribute, if present, is from the allowed vocabulary.
- Step `systems` attribute, if present, is a subset of the doc's
  frontmatter `systems`.
- Every `<!-- sop-screenshot-start -->` block contains exactly one image.

Files without `schema_version: 1` are skipped — migration is
incremental.

### `scripts/sop_normalize.py`

Converts a legacy SOP into the marked-up form. This is what we used to
migrate all 240 files in one pass.

```bash
python3 scripts/sop_normalize.py path/to/sop.md -o path/to/sop.md
```

Heuristics:

- Detects the six standard section headings and wraps each in section
  markers.
- Inside Procedure, treats `### subheadings` as group boundaries and
  numbered `N.  text` items as step boundaries.
- Pairs each image with its following `Image note:` paragraph into a
  screenshot+caption block.
- Re-indents step-body lines to the list-item indent so GitHub keeps the
  screenshot inside the rendered numbered list.
- Auto-renumbers steps from a running counter — legacy files with
  duplicate `1. 2. 3.` numbering across sub-procedures come out clean.
- Adds `schema_version: 1` to the frontmatter.

## How we validated the format

We didn't trust the format until we'd round-tripped real files through
it. The validation pipeline:

1. **Spec drafted** alongside a parser and a linter.
2. **Round-tripped three representative shapes** — a small flat SOP, a
   mid-sized sub-grouped SOP, and the 479-line podcast-transcription SOP
   with 7 sub-groups and multi-image steps. All three parsed and linted
   clean.
3. **Bulk-tested on 50 random SOPs** to catch edge cases the
   representatives missed. Found three real classes of issue:
   - `doc_type: checklist` was rejected (fixed: lint now accepts both
     `sop` and `checklist`, which share the same shape).
   - Legacy duplicate `1. 2. 3.` numbering across sub-procedures (fixed:
     normalizer assigns sequential ids from a running counter and
     rewrites the rendered numbers to match).
   - Mixed groups + flat steps where flat steps appear before/after the
     groups (left as a lint error — semantically ambiguous, needs human
     judgement).
4. **Ran on all 240 SOPs.** 236 normalized cleanly on first pass. The
   remaining 4 had legitimate structural ambiguities and were
   hand-edited:
   - `fill-in-the-sponsored-block-in-the-newsletter.md` — wrapped the
     leading `1. Open the newsletter draft` in a new "Preparation"
     group, and merged a Word-imported duplicate H3 back into intro
     prose.
   - `creating-invoices-in-finom.md` — removed the lone trailing group
     so all 23 steps are flat.
   - `github-guide-common-errors-and-solutions.md` — wrapped the 4
     leading troubleshooting steps in a "General approach" group,
     mirroring the four Scenario groups that follow.
   - `filling-newsletter-statistics.md` — wrapped the 14 leading flat
     steps in a "Newsletter delivery statistics" group, mirroring the
     existing "LinkedIn Sponsored Post Statistics" group.
5. **All 240 SOPs now pass lint clean.**

## Known limitations

- The `action` attribute vocabulary (`navigate`, `click`, `type`,
  `upload`, ...) is a first-pass guess. We should look at real SOPs and
  refine the enumeration.
- Template-text SOPs (no real procedure, just copy banks — e.g.
  `post-podcast-guest-recommendations.md`) currently parse as "fake
  steps" because the copy templates use a numbered list. The `raw`
  escape hatch is the right answer but the normalizer doesn't yet
  auto-detect these.
- The frontmatter parser is a minimal YAML subset that handles the
  patterns in current files. If we ever want richer frontmatter, swap
  for PyYAML.
- Lint is not yet wired into CI — for now it's a manual gate.
