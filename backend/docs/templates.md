# Templates Reference

Extracted from the Trello board export. 11 active templates.

Notes on mapping to our data model:
- Trello has two-level hierarchy: checklists (phases) -> items (tasks). We flatten into a single task list per template.
- Trello has no explicit offset days. We derive them from checklist ordering and timing hints in task names (e.g., "one week before", "2 weeks before").
- Many tasks reference Google Docs process documents via markdown links - these map to `instructionsUrl`.
- Some tasks mention specific assignees (e.g., "– Valeriia", "– Alexey") - these map to per-task `assigneeId`.
- Checklist names become phase groupings - useful for understanding the workflow but flattened in our model.

## Authored workflow template lint

Workflow task names are Card titles and must be no more than 80 Unicode characters. Put longer task detail in `validation.operatorAction`; keep `instruction_doc_id` when a task links to its SOP.

Offsets are integer day counts from the task's anchor (`start` by default, or `end`). For dependencies on the same anchor, a task cannot be scheduled earlier than any prerequisite. A later, nonzero day than the latest same-anchor prerequisite is treated as an extra delay and needs a documented reason in nonempty `validation.operatorAction` or `instruction_doc_id`. Offset `0` is the Card anchor itself, and a task without same-anchor dependencies is scheduled directly relative to its anchor, so neither needs a separate reason. START and END offsets are not compared because their calendar order depends on each Card's duration.

The shared validator runs for authored templates in CI and on API saves. The `dataops templates update` CLI uses that same API validation and reports its lint issues.

## Document Parts

This document is split into four parts:

- [Part 1: Recurring publication templates](templates/part-1-recurring-publication-templates.md)
- [Part 2: Event templates](templates/part-2-event-templates.md)
- [Part 3: Periodic operations templates](templates/part-3-periodic-operations-templates.md)
- [Part 4: Summary and shared tasks](templates/part-4-summary-and-shared-tasks.md)
- [Part 5: Playbook workflows & personas](templates/part-5-playbook-workflows.md)
