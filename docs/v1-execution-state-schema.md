---
title: "V1 Execution State Schema"
summary: "Production-facing schema definition for DataOps V1 execution state in DynamoDB, with portable IDs and future migration boundaries."
doc_type: reference
tags:
  - v1
  - data
  - dynamodb
  - work-engine
systems:
  - aws
  - dynamodb
  - lambda
related_docs:
  - docs/v1-runtime-architecture.md
  - docs/v1-execution-data-safety.md
  - backend/docs/specs.md
---

# V1 Execution State Schema

## Document Parts

This document is split into four parts:

- [Part 1: Overview, storage boundary, table ownership, and ID rules](v1-execution-state-schema/part-1-overview-storage-and-id-rules.md)
- [Part 2: Work-entity tables](v1-execution-state-schema/part-2-work-entity-tables.md)
- [Part 3: Supporting-entity tables](v1-execution-state-schema/part-3-supporting-entity-tables.md)
- [Part 4: Query requirements, migration notes, and implementation checklist](v1-execution-state-schema/part-4-query-migration-and-checklist.md)
