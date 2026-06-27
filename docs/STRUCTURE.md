---
title: "Structure"
summary: "Defines the domain-first documentation structure, required frontmatter, and standard body sections for SOPs, templates, references, and playbooks."
doc_type: reference
tags: []
systems:
  - airtable
  - github
  - loom
  - luma
  - mailchimp
  - slack
  - trello
related_docs: []
---

# Structure

## Summary

## Content

### Documentation Structure

All operational documents in this repository should follow an explicit domain-first folder structure so people and agents can scan, edit, validate, and reuse them predictably.

Operational documentation lives under the repo-root `content/` folder, alongside its image assets. Repo-meta documents (this file, the SOP format spec, the archive) stay in `docs/`.

Top-level layout:

- `content/` - DataTalks.Club operating documentation and its image assets.
  - `content/<domain>/` - one folder per work domain (events, finance, courses, ...).
  - `content/media/` - content team (podcast, video, webinar, workshops, ...).
  - `content/maven/` - Maven-specific documentation.
  - `content/prompts/` - maintained AI prompts.
  - `content/images/` - all screenshots and other doc images.
- `docs/` - repo-meta documentation (this spec, format docs, archive).

Inside each domain, organize by document type:

- `content/media/podcast/sops/`
- `content/media/podcast/templates/`
- `content/events/luma/sops/`
- `content/finance/bookkeeping/sops/`
- `content/finance/bookkeeping/templates/`
- `content/courses/playbooks/`
- `content/overview/reference/`

### Document Types

Use one of these `doc_type` values in frontmatter:

- `sop` - step-by-step instructions for doing operational work.
- `checklist` - ordered checklist that links to SOPs or summarizes a multi-step workflow.
- `template` - reusable text, email, contract, announcement, or prompt template.
- `task-template` - Git-backed DataTasks workflow template.
- `reference` - overview, index, FAQ, guide, spreadsheet export, or troubleshooting reference.
- `playbook` - campaign or strategy plan, usually with multiple activities and references.
- `prompt` - maintained AI prompt.
- `archive` - imported or deprecated material kept for traceability.
- `doc` - generic document when no narrower type applies.

### Required Frontmatter

Every operational Markdown file under `content/` should start with:

```yaml
---
id: sop.media.podcast.create-podcast-document
aliases: []
title: "Human-readable title"
doc_type: sop
source: "Processes/original-file.docx"
tags: []
systems: []
related_docs: []
---
```

Field meanings:

- `id`: stable document identity. Use lowercase letters, numbers, dots,
  dashes, or underscores only. Prefer `doc_type.domain.area.slug`, for
  example `sop.media.podcast.create-podcast-document`. Do not change an ID
  after another task, workflow, or document links to it.
- `aliases`: old IDs or old paths that should still resolve to this document
  after a rename or migration.
- `title`: displayed title.
- `doc_type`: one of `sop`, `checklist`, `template`, `reference`, or `playbook`.
- `source`: optional original import source, usually the original `.docx` path from the Processes export.
- `tags`: topical tags.
- `systems`: tools/services touched by the doc, such as `airtable`, `mailchimp`, `luma`, `github`, `slack`.
- `related_docs`: stable document IDs, wiki references such as `[[doc-id]]`,
  or repo-relative Markdown paths for related docs. New links should use IDs.

Stable ID examples:

- `sop.media.podcast.create-podcast-document`
- `template.media.podcast.remind-guest-one-day-before`
- `task-template.tasks.podcast`
- `reference.finance.invoices-receipts-and-statements`
- `playbook.courses.launch-cohort`

### SOP Body

SOP docs should use this body structure:

```markdown
# Title

## Summary

- Purpose:
- Outcome:
- Trigger:
- Frequency:

## Prerequisites

- Access:
- Tools:
- Inputs:

## Procedure

1. First step.
2. Second step.

## Validation

- How to confirm the work is done correctly.

## Troubleshooting

- Common issue:
- Fix:

## References

- Links, Loom videos, Trello cards, source docs, and related docs.
```

### Checklist Body

Checklist docs use the same section structure as SOPs, but the `Procedure` section should be a short ordered list of links to the required SOPs.

### Template Document Body

Template docs should use this body structure:

```markdown
# Title

## Usage

- Use when:
- Audience:
- Required inputs:

## Template

Reusable content goes here.

## Notes

- Optional context or formatting requirements.
```

### Reference Document Body

Reference docs should use this body structure:

```markdown
# Title

## Summary

Short explanation of what this reference contains.

## Content

The reference material.

## References

- Related links and docs.
```

### Playbook Body

Playbook docs use the reference structure:

```markdown
# Title

## Summary

Short explanation of the campaign or strategy.

## Content

Activities, timelines, examples, and decisions.

## References

- Related links and docs.
```

### Migration Notes

The imported Google Docs often contain the structure implicitly:

- `What:` maps to `Summary / Purpose`.
- `Why:` maps to `Summary / Outcome` or supporting context.
- `When:` maps to `Summary / Trigger`.
- `Step-by-step Instructions` maps to `Procedure`.
- Loom links and Trello links belong in `References`.
- Old Google Doc links should be replaced with internal relative Markdown links when the target has been migrated.

## References

-
