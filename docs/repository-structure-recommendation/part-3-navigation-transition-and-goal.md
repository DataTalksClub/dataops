> Part 3 of 3 of the [DataOps Repository and Directory Structure
> Recommendation](../repository-structure-recommendation.md):
> Part 1 covers [ownership principles and the repository map](part-1-ownership-and-repository-map.md),
> and Part 2 covers [what lives where and directory layouts](part-2-directory-layouts.md).

## Product Navigation Should Not Mirror Repos

The user should not see repository boundaries.

Recommended portal navigation:

```text
Home
Workflows
Tasks
Inbox
Assistants
Knowledge
Templates
Recurring
Artifacts
Settings
```

How that maps internally:

- Home reads DynamoDB tasks, cards, reminders, notifications, doc health, and
  assistant jobs.
- Workflows read DynamoDB cards and Git-backed workflow definitions.
- Tasks read DynamoDB tasks and Git-backed instruction docs.
- Inbox reads DynamoDB/S3 intake records.
- Assistants read DynamoDB jobs, S3 files, and Git-backed prompts.
- Knowledge reads Git-backed markdown.
- Templates read Git-backed workflow templates plus DynamoDB runtime templates.
- Recurring reads DynamoDB recurring configs.
- Artifacts read DynamoDB metadata and S3/Dropbox/Google Drive links.

This navigation is based on the DataOps operating model:

- start the day;
- see work;
- handle reminders and follow-ups;
- open a workflow;
- complete tasks with proof;
- use docs only when needed;
- run assistants when raw input needs transformation;
- preserve artifacts and audit.

It is not intended to match the directory structure of any other DataTalksClub
site.

## Transition Plan

### Step 1: Keep current app repo intact but label ownership

Add documentation and metadata that says:

- `content/` is transitional operational knowledge in a public repo and must be
  audited before it is treated as safe.
- `content/tasks/templates/` is transitional imported task-template
  documentation until private `workflow-templates/*.yaml` sources exist.
- `work-engine/` is the DataOps execution engine.
- `assistants/podcast/` is the DataOps podcast assistant module.
- `lambda-functions/` and `frontend/` are current deployed portal app.

No large moves yet.

### Step 2: Introduce stable IDs and workflow template files

Add:

```text
content/indexes/document-registry.yaml
content/workflow-templates/
```

or, if preparing for a split:

```text
workflow-templates/
schemas/
assistant-prompts/
```

Then map runtime tasks to `instructionDocId`, not just raw Google Doc URLs.

### Step 3: Move generated/private outputs out of Git

For podcast assistant:

- Keep assistant code in the public app repo.
- Move prompts and process instructions to the private knowledge repo.
- Move raw inputs, generated drafts, logs, and episode-specific outputs to S3 or
  another private storage backend.
- Store artifact metadata in DynamoDB.

### Step 4: Split private `dataops-knowledge` when the sync boundary exists

Do not split content before the app can:

- read docs from that repo;
- validate doc IDs;
- sync workflow templates into runtime templates;
- deploy or refresh content without app-code deploy;
- keep CI green in both repos.

Until then, do not add new sensitive operational knowledge to `dataops`.
Existing `content/` should be treated as migration debt and reduced to
sanitized fixtures or generated public-safe views as the private repo comes
online.

### Step 5: Clean up the app folders

After unified UX decisions are implemented:

- fold `work-engine` into `app`;
- keep the old source `podcast-assistant` import folded into
  `assistants/podcast`;
- consolidate shared types and schemas;
- keep old folder moves in separate commits to avoid mixing refactors with
  product behavior changes.

## Recommended Near-Term Decision

For the next implementation goal, keep product/runtime work in public
`DataTalksClub/dataops`, keep shared AWS infrastructure in `../aws-infra`, and
move the operational knowledge source of truth toward private
`DataTalksClub/dataops-knowledge`.

Do this because:

- V1 still needs product discovery and fast iteration.
- The app already deploys from this repo.
- The operator UX must stay unified even though the knowledge source is
  private.
- The current public-repo docs, task templates, and assistant knowledge need an
  audit/migration path instead of becoming the steady state.

Design the directories and loaders so `content/`, `workflow-templates/`, and
`assistant-prompts/` become private `DataTalksClub/dataops-knowledge` inputs.

The clearest near-term structure is:

```text
dataops/
  content/
    ...transitional, audited, public-safe process docs or generated views...
    workflow-templates/
    assistant-prompts/
    indexes/
  app/
    ...new unified app code, introduced gradually...
  work-engine/
    ...existing task engine until folded in...
  lambda-functions/
    ...existing deployed docs/backend until folded in...
  frontend/
    ...existing docs frontend until folded in...
  assistants/podcast/
    ...DataOps podcast assistant module...
  docs/
    product and architecture docs
```

This lets the product move now while preserving the option to split knowledge
later.

## Concise Goal For Implementation Planning

Build DataOps as one operations workspace where:

- `dataops` owns the running public app, schemas, tests, sanitized fixtures,
  and public-safe planning docs;
- private `dataops-knowledge` owns canonical operational knowledge;
- `aws-infra` owns AWS account-level infrastructure;
- runtime work state lives in DynamoDB;
- private/bulky artifacts live outside Git;
- process docs, workflow templates, and assistant prompts are versioned in
  private Git;
- the UI hides repository boundaries and gives the operations manager one daily
  flow for tasks, workflows, reminders, follow-ups, artifacts, docs, and
  assistants.
