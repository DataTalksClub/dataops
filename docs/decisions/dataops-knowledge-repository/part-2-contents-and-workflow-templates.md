> Part 2 of 5 of the [DataOps Knowledge Repository Boundary
> ADR](../dataops-knowledge-repository.md): [Part 1](part-1-decision-and-boundaries.md)
> covers the decision and the repository boundaries,
> [Part 3](part-3-assistant-boundary-and-migration.md) covers the assistant
> boundary and the migration inventory, [Part 4](part-4-runtime-portal-and-ci.md)
> covers runtime, portal-edit, and CI integration, and
> [Part 5](part-5-safety-rollout-and-consequences.md) covers data safety,
> follow-up issues, and consequences.

## Knowledge Repository Contents

The knowledge repository contains more than `content/`.

Target shape:

```text
dataops-knowledge/
  content/
    ...domain-first SOPs, references, playbooks, and communication templates...
  workflow-templates/
    book-of-the-week.yaml
    course.yaml
    maven-ll.yaml
    newsletter.yaml
    office-hours.yaml
    oss.yaml
    podcast.yaml
    social-media.yaml
    tax-report.yaml
    webinar.yaml
    workshop.yaml
  assistant-prompts/
    podcast/
      intake.md
      document-generation.md
      review-checklist.md
  assistant-process/
    podcast/
      podcast.md
      podcast-guest-intake.md
  examples/
    podcast/
      README.md
  images/
  indexes/
    document-registry.yaml
    systems.yaml
  schemas/
    document.schema.json
    workflow-template.schema.json
    assistant-prompt.schema.json
  tests/
  scripts/
```

Rules:

- Human-readable operational documents live under `content/`.
- Executable workflow definitions live under `workflow-templates/`.
- Prompts and assistant process instructions live under `assistant-prompts/`
  and `assistant-process/`.
- Small screenshots and images used by SOPs live under `images/` or a
  content-relative image layout selected during migration.
- Lightweight indexes and registries can live under `indexes/` when they are
  either maintained metadata or deterministic generated files.
- Large generated indexes, search cards, and runtime caches remain generated
  artifacts and are not hand-edited.
- The repository is private by default. Curated examples may be made public
  only after a separate data review confirms they are safe, useful, and
  intentionally public.

## DataOps Workflow Template Decision

DataOps workflow templates are canonical process knowledge, not runtime state.

Canonical Git location after migration:

```text
DataTalksClub/dataops-knowledge/workflow-templates/*.yaml
```

Preferred format: YAML with a strict JSON Schema. YAML is easier to review for
operators and maintainers than JSON while remaining machine-readable.

Each template should include:

- stable `id`, `type`, `name`, `schema_version`, and optional aliases
- trigger and anchor-date model
- card link definitions
- phases and task stage mapping
- task list with stable task IDs
- offsets or scheduling rules
- required proof and required link declarations
- default assignee references by stable role/user ID, not personal names only
- `instruction_doc_id` links to SOP stable IDs
- optional migration source metadata

The current Markdown files in `content/tasks/templates/` remain the
transitional canonical copies until the YAML source files exist. During
migration, convert the 11 current templates to YAML and keep generated
Markdown/portal views derived from YAML if human-readable template pages are
still needed.

The stable ID is the migration boundary between `dataops` and the future
knowledge repository. File paths, Google Docs URLs, and `source` provenance can
change during the split; task and workflow records should still open the same
process context by resolving the stable ID or one of its aliases.

Runtime behavior:

- The work engine loads or syncs runtime template records from the Git-backed
  YAML source.
- DynamoDB may cache the current runtime template version for fast execution and
  historical task creation.
- DynamoDB is not the source of truth for canonical template definitions.
- Runtime tasks and cards should store the template ID and template version
  used to create them so old executions remain explainable after template edits.
- A full DynamoDB rebuild must be able to restore template definitions from Git
  plus runtime execution exports.
