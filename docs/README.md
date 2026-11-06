---
title: "Readme"
summary: "Explains the repo-meta docs folder and points to the private knowledge repository for operational documentation."
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

The Lambda app doesn't serve this folder through the docs frontend, and the
search index skips it.

Files that live here:

- `architecture.md` - deployed app architecture, content lifecycle, CI/CD
  split, credentials model, and upgrade notes.
- `design-system.md` - internal V1 design-system spec for shared DataOps
  tokens, component primitives, current portal/work-engine mappings,
  accessibility, responsive behavior, and migration sequencing.
- `decisions/` - durable architecture decision records for repository,
  runtime, data, and process boundaries.
- `decisions/dataops-knowledge-repository.md` - ADR for the future private
  `DataTalksClub/dataops-knowledge` boundary and migration plan.
- `decisions/operating-model-projection.md` - ADR for projecting private
  operating-model definitions into personal execution Cards.
- `local-development.md` - developer command plan for local checks, focused
  verification, handoff, and deployment-adjacent work.
- `v1-runtime-architecture.md` - V1 runtime decision for the unified operations
  workspace and its Lambda, DynamoDB, and work-engine boundaries.
- `v1-workflow-data-model.md` - shared workflow contract for definitions,
  runtime cards, tasks, reminders, proof, references, and migration-safe IDs.
- `task-dependencies.md` - Task prerequisites: model, Template refs, enforcement
  rules, transaction guards, and limitations.
- `v1-execution-state-schema.md` - production-facing DynamoDB schema definition
  for V1 mutable execution state.
- `v1-execution-data-safety.md` - backup, restore, and portable export format
  for execution data and future database migration.
- `STRUCTURE.md` - required frontmatter and section conventions.
- `archive/` - deprecated or imported historical material.

Operational documentation no longer lives in this repository: the process
document corpus moved to the separate private
`DataTalksClub/dataops-knowledge` repository, and the Lambda app serves the
docs frontend from that repository over the GitHub Contents API.

## References

-
