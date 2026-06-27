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

## docs/ - repo-meta only

This folder holds plain-markdown documentation about the repo:

- the structured-SOP spec
- naming conventions
- design notes
- the archive of historical material

The Lambda app doesn't serve this folder through the docs frontend, and the
search index skips it.

Files that live here:

- `architecture.md` - deployed app architecture, content lifecycle, CI/CD
  split, credentials model, and upgrade notes.
- `local-development.md` - developer command plan for local checks, focused
  verification, handoff, and deployment-adjacent work.
- `v1-runtime-architecture.md` - V1 runtime decision for the unified operations
  workspace and its Lambda, DynamoDB, and work-engine boundaries.
- `v1-execution-state-schema.md` - production-facing DynamoDB schema definition
  for V1 mutable execution state.
- `v1-execution-data-safety.md` - backup, restore, and portable export format
  for execution data and future database migration.
- `STRUCTURE.md` - required frontmatter and section conventions.
- `sop-format.md` - strict spec for the structured-SOP markdown format.
- `sop-format-design.md` - design log and tooling notes.
- `archive/` - deprecated or imported historical material.

## content/ - operational documentation

Operational docs live under `content/`, alongside their image assets:

- `content/<domain>/sops/`, `content/<domain>/templates/`, and related folders.
- `content/media/` - podcast, video, webinar, workshops.
- `content/maven/` - Maven-specific docs.
- `content/prompts/` - maintained AI prompts.
- `content/images/` - screenshots and other doc images.

The Lambda app reads operational docs from the `content/` directory when it
serves the docs frontend.

## References

-
