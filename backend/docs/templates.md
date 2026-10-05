# Templates Reference

Extracted from the Trello board export. 11 active templates.

Notes on mapping to our data model:
- Trello has two-level hierarchy: checklists (phases) -> items (tasks). We flatten into a single task list per template.
- Trello has no explicit offset days. We derive them from checklist ordering and timing hints in task names (e.g., "one week before", "2 weeks before").
- Many tasks reference Google Docs process documents via markdown links - these map to `instructionsUrl`.
- Some tasks mention specific assignees (e.g., "– Valeriia", "– Alexey") - these map to per-task `assigneeId`.
- Checklist names become phase groupings - useful for understanding the workflow but flattened in our model.

## Document Parts

This document is split into four parts:

- [Part 1: Recurring publication templates](templates/part-1-recurring-publication-templates.md)
- [Part 2: Event templates](templates/part-2-event-templates.md)
- [Part 3: Periodic operations templates](templates/part-3-periodic-operations-templates.md)
- [Part 4: Summary and shared tasks](templates/part-4-summary-and-shared-tasks.md)
