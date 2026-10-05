---
title: "ADR: DataOps Knowledge Repository Boundary"
summary: "Decision record for separating DataOps app/runtime code, canonical process knowledge, workflow templates, assistant knowledge, runtime state, and private artifacts."
doc_type: reference
tags:
  - adr
  - architecture
  - process-docs
  - migration
  - data
systems:
  - github
  - aws
  - dynamodb
  - s3
related_docs:
  - docs/repository-structure-recommendation.md
  - docs/v1-runtime-architecture.md
  - docs/v1-execution-data-safety.md
---

# ADR: DataOps Knowledge Repository Boundary

This decision record separates DataOps app/runtime code, canonical process
knowledge, workflow templates, assistant knowledge, runtime execution state,
and private artifacts across the public app repository, the private
`DataTalksClub/dataops-knowledge` repository, `aws-infra`, and private
artifact storage. It is accepted for planning; implementation is out of
scope for this ADR.

## Document Parts

This document is split into five parts:

- [Part 1: Decision and repository boundaries](dataops-knowledge-repository/part-1-decision-and-boundaries.md)
- [Part 2: Repository contents and workflow templates](dataops-knowledge-repository/part-2-contents-and-workflow-templates.md)
- [Part 3: Assistant boundary and migration inventory](dataops-knowledge-repository/part-3-assistant-boundary-and-migration.md)
- [Part 4: Runtime, portal-edit, and CI integration](dataops-knowledge-repository/part-4-runtime-portal-and-ci.md)
- [Part 5: Data safety, follow-up issues, and consequences](dataops-knowledge-repository/part-5-safety-rollout-and-consequences.md)
