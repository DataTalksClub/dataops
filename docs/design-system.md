---
title: "DataOps Design System"
summary: "Internal V1 design-system spec for shared portal, work-engine, and assistant UI tokens and components."
doc_type: reference
tags:
  - design
  - frontend
  - portal
  - work-engine
systems:
  - frontend
  - work-engine
related_docs:
  - docs/local-development.md
  - docs/operations-manager-platform-jtbd/part-1-user-context-and-daily-loop.md
  - docs/v1-runtime-architecture.md
---

# DataOps Design System

> **Status: historical spec.** Shared tokens are now owned by **dakit**
> (`../dakit`), the design system shared with dapier, dataqna, and relay. The
> portal vendors dakit's generated tokens at `frontend/src/dakit/tokens.css`
> and styles resolve to `--dk-*` roles; the teal `--do-*` namespace below was
> retired and never shipped in this palette. The component vocabulary, state,
> accessibility, and responsive rules remain useful guidance; the token tables
> describe a superseded proposal. See `frontend/DESIGN_SYSTEM.md` for the
> current system.

## Document Parts

This document is split into three parts:

- [Part 1: Principles, tokens, and compatibility mapping](design-system/part-1-principles-and-tokens.md)
- [Part 2: Component primitives and surface mapping](design-system/part-2-component-primitives-and-surfaces.md)
- [Part 3: Responsive, accessibility, and migration rules](design-system/part-3-responsive-accessibility-and-migration.md)
