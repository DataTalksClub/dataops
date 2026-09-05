---
title: "ADR: Operating Model Definition and Execution Boundary"
status: accepted
date: 2026-09-05
---

# ADR: Operating Model Definition and Execution Boundary

## Decision

DataOps reads the operating model from the private knowledge repository and
projects it into two authenticated product surfaces:

- Operating Model is a read-only organizational view.
- My Plan joins roadmap sessions to the signed-in actor's execution Cards.

Git remains authoritative for definitions. DynamoDB remains authoritative for
personal execution state. Creating a session copies its current workflow into
one Card and its Tasks; later definition changes do not silently rewrite work
already in progress.

## Identity and concurrency

A personal session Card has a deterministic identity derived from actor,
roadmap, and session. It does not include the selected date or definition
revision. A retry therefore resolves to the existing aggregate instead of
creating duplicate work.

Creation requires the definition revision shown in the preview. The Card and
all Tasks are written atomically. Replays are accepted only after checking the
stored owner and operating-model origin. Creation is disabled while the model
is stale, although the last valid read projection may remain visible.

## Private projection boundary

The public application contains projection code and sanitized contracts, not a
copy of the private registers. The backend reads only named registry and
workflow paths. Authenticated file downloads use a narrow allowlist. Logs and
telemetry contain route/status metadata, never registry bodies or authored
text.

Each created Card retains its source document and definition revision. This
origin is included in the portable execution export so the relationship
survives recovery and migration.

## Consequences

- Organizational definitions can evolve through reviewable Git changes.
- Personal Tasks use the existing Card lifecycle, evidence, assignment, and
  completion behavior.
- A definition update causes an old creation preview to conflict and reload.
- Completing a Task does not approve a governance change or mutate a register.
- Native editing of registers remains outside the first release.

