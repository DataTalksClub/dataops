---
title: "Readme"
summary: "Explains the repo-meta docs folder and points to content/ for operational documentation."
doc_type: reference
tags: []
systems: []
related_docs: []
---

# Readme

## Summary

## Content

### docs/ — repo-meta only

This folder holds plain-markdown documentation **about the repo itself**:
the structured-SOP spec, naming conventions, design notes, and the archive
of historical material. It is not served by the docs frontend and is not
indexed by search.

Files that live here:

- `architecture.md` — deployed app architecture, content lifecycle, CI/CD
  split, credentials model, and upgrade notes.
- `v1-runtime-architecture.md` — V1 runtime decision for the unified
  operations workspace, including Lambda boundaries, DynamoDB execution state,
  backup/export strategy, and work-engine integration.
- `STRUCTURE.md` — required frontmatter and section conventions.
- `sop-format.md` — strict spec for the structured-SOP markdown format.
- `sop-format-design.md` — design log and tooling notes.
- `archive/` — deprecated or imported historical material.

### content/ — operational documentation

All operational SOPs, templates, references, playbooks, and prompts live
under `content/`, alongside their image assets:

- `content/<domain>/sops/`, `content/<domain>/templates/`, etc.
- `content/media/` — podcast, video, webinar, workshops (content team).
- `content/maven/` — Maven-specific docs.
- `content/prompts/` — maintained AI prompts.
- `content/images/` — all screenshots and other doc images.

The docs frontend and Lambda app read operational documentation from
`content/`.

## References

-
