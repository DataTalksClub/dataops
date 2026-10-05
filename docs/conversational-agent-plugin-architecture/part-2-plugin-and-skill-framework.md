> Part 2 of 3 of the [Conversational Agent Plugin Architecture](part-1-goals-decisions-and-approval-model.md):
> Part 1 (entry) covers goals, MVP decisions, and the approval model;
> Part 3 covers [post-MVP plugins, adapters, and the delivery order](part-3-post-mvp-plugins-adapters-and-delivery.md).

## Plugin and Skill Framework

The agent should not permanently receive every domain tool, schema, and
instruction. That would make the system prompt and tool context grow every
time DataOps adds a capability.

Instead, DataOps should provide a plugin registry with progressive disclosure.
Each plugin packages a related capability, its agent guidance, schemas,
validation, proposal renderer, and trusted executor.

The agent's base context should contain:

1. the core conversational and approval rules;
2. a compact catalog containing one short description for each available
   plugin;
3. only the two framework operations needed to load and invoke a skill.

Suggested framework interface:

```text
skill_load
  plugin: string

skill_invoke
  plugin: string
  action: string
  input: object
```

`skill_load` returns the selected plugin's relevant instructions, supported
actions, strict input schemas, and short examples. `skill_invoke` validates the
request against the registered action schema and runs it through the shared
proposal and approval framework.

`skill_load` ends the current model step. The runtime stores the loaded plugin
and starts a second model step with that plugin's instructions and schema in
context. The next `skill_invoke` is validated deterministically. Validation
errors are returned to the agent for a bounded correction attempt.

If the plugin catalog eventually becomes too large for the base prompt, the
framework can add semantic catalog search. It is unnecessary while a compact
list of plugin names and one-line descriptions remains small.

### Plugin Manifest

Each registered plugin should declare:

```text
id
version
display_name
summary
activation_hints
skill_instructions
actions
  name
  description
  input_schema
  effect: read | proposal
  core_permission
renderer
validator
executor
reconciler
build_digest
```

The manifest summary and activation hints are safe for the compact base
catalog. Full instructions and action schemas are loaded only when selected.

Plugin instructions are lower priority than core system and approval rules. A
plugin references a permission defined by the core; it cannot define policy,
grant itself broader permissions, or bypass approval.

### Plugin Package and Registration

A plugin is a trusted TypeScript object imported into an explicit registry:

```text
Plugin
  id
  version
  build_digest
  summary
  activation_hints
  skill_instructions
  actions
  validate
  render_proposal
  execute
  reconcile
```

The application owns a static list such as:

```text
PLUGINS = [todo, typefully]
```

Build and startup validation should reject duplicate IDs, invalid schemas,
unknown core permissions, missing handlers, or external mutation actions
without a declared reconciliation mode. Deployment configuration may enable or
disable a registered plugin and restrict it by role or channel.

Configuration should allow a plugin to be enabled, disabled, or restricted
without changing the core agent:

```text
plugin: typefully
enabled: true
allowed_roles: [admin, operator]
allowed_channels: [telegram, web]
settings_ref: managed runtime configuration
```

Secrets and provider identifiers are runtime configuration. They must not be
placed in the manifest, skill instructions, proposal, or model context.

Sessions and proposals record the exact plugin build digest, not only a semantic
version. A deployment must retain the executor build for claimed attempts.
Unclaimed proposals whose build is unavailable are superseded and regenerated.

The core injects only the narrow executor capability authorized for the stored
target, such as a todo writer for the actor's scope or a Typefully draft creator
for one account. Plugins never receive generic database access, credential
stores, or unrestricted provider clients.

Runtime package discovery, independently distributed plugins, and arbitrary
plugin code loading are out of scope for the MVP.

### Conversational Flow in the MVP

The plugin skill instructions explain which fields are required and what the
agent should clarify. Plugin-specific draft state is stored as validated JSON
on the conversation.

The framework standardizes only a few UI/session actions:

```text
select_option
submit_input
approve
request_changes
cancel_proposal
discard_draft
end_conversation
```

Buttons use these stable action kinds plus plugin-validated payloads. Telegram
may render them as inline keyboards; the web portal may render forms or richer
controls.

Only `approve` may claim a proposal for consequential execution.
Clarification actions update draft/session state without calling an executor.

A reusable flow language should be introduced only after several plugins show
the same state and transition patterns.

The core renders its actions using plugin-supplied labels and hints:

| Plugin state | Example actions |
|---|---|
| SOP clarification | **Create new SOP**, **Update existing SOP**, **Choose document** |
| SOP review | **View full document**, **View diff**, **Request changes**, **Approve and open SOP pull request**, **Cancel proposal** |
| Podcast clarification | **Choose audience**, **Choose duration**, **Add source** |
| Podcast review | **Review questions**, **Request changes**, **Approve podcast document**, **Cancel proposal** |
| Typefully clarification | **Alexey**, **DataTalksClub**, **X**, **LinkedIn** |
| Typefully review | **Approve and add to Typefully**, **Request changes**, **Cancel proposal** |
| Todo clarification | **Today**, **Tomorrow**, **Choose date**, **No time** |
| Todo review | **Approve todo**, **Request changes**, **Cancel proposal** |

These are presentation hints for core-owned actions. The stable core action IDs
and plugin input schemas, not the displayed text, drive runtime behavior.

### Initial Plugins

| Plugin | Responsibility |
|---|---|
| `todo` | Propose creating one todo in the actor's own scope. |
| `typefully` | Propose creating one unscheduled, unpublished Typefully draft. |

### Possible Later Plugins

These should be introduced only after their conversational behavior and
approval boundaries are designed:

| Plugin | Responsibility |
|---|---|
| `reference` | Create or update a non-procedural reference document. |
| `content-template` | Create or update reusable email, message, or content copy. |
| `workflow-template` | Create or update a reusable sequence of operational tasks. |
| `calendar` | Create or update a calendar item. |
| `newsletter` | Create or update newsletter scheduling data. |
| `sponsor` | Create or update sponsor CRM information. |
| `sop` | Create or update a structured SOP through a reviewed pull request. |
| `podcast` | Create or update a podcast preparation document through a reviewed pull request. |
| `workflow` | Start or update an operational workflow after multi-effect semantics are designed. |
| `recurring-todo` | Create or update recurring work after partial-failure semantics are designed. |

Bookkeeping should not receive a broad generic mutation tool. Any future
bookkeeping plugin actions should be narrow, strongly validated, and separately
approved.

Authorized resource search and loading are core read services, not plugins.
Their results carry stable source references, revisions, audience, and
classification without displacing the active mutation skill.

### Example Plugin Selection

For a social request, the base prompt might contain only:

```text
typefully — Prepare platform-specific social copy and, after approval, create
an unscheduled saved Typefully draft.
```

The interaction is:

```text
User asks for a social post
    |
    v
Agent selects `typefully` from the compact catalog
    |
    v
skill_load(plugin="typefully")
    |
    v
Runtime exposes only the Typefully skill instructions and action schema
    |
    v
skill_invoke(plugin="typefully", action="propose_draft", input=...)
    |
    v
Proposal preview and approval
```

The SOP, podcast, todo, and workflow schemas never enter this conversation's
context.

### Context Management

Context should be assembled in layers:

1. core system behavior and approval rules;
2. the compact plugin catalog;
3. the current conversation summary and bounded recent messages;
4. the active plugin's instructions and schemas;
5. only the source documents or search results needed for the current task;
6. a compact reference to proposal state, which remains stored outside the
   model context.

The session should remember which plugin is active, but the runtime should load
its full instructions only when needed. When the conversation changes to a
different capability, the previous plugin details should be removed from the
next assembled context.

Large source documents, complete conversation history, immutable proposal
payloads, and approval records should remain in storage. The model receives
bounded excerpts, summaries, and stable references rather than repeatedly
receiving everything.

This keeps the base prompt stable as plugins are added and prevents unrelated
schemas from competing for the model's attention.

### Memory and History

Memory is primarily a core runtime service because every conversation and
plugin depends on consistent identity, privacy, retrieval, retention, and
context budgeting.

The MVP distinguishes:

- **working memory:** active objective, plugin draft state, proposal reference,
  recent events, and unresolved questions;
- **conversation history:** immutable ordered events with actor, channel,
  audience, and provenance;
- **summary checkpoints:** replaceable context optimizations that point to the
  events they summarize;
- **resource references:** stable links to canonical SOPs, podcasts, todos, and
  workflows.

Summaries are never authoritative. They cannot approve an action, replace
structured plugin state, or become durable facts without provenance.

For the MVP, references such as “that thing” resolve only from active structured
state and bounded recent events. If that is ambiguous, the agent asks the user
to identify the resource. History-wide search and candidate selection are
post-MVP.

The first version should not automatically create long-term personal facts.
A narrow first-party `memory` plugin may be added later for explicit requests:

```text
remember
list
correct
forget
```

Domain plugins may read context selected by the core runtime but may not write
durable memory directly. Personal memory must not be injected into a group
conversation. Shared memory requires an explicit audience and confirmation.

Context should be budgeted by tokens, not only by message count. Each turn
should retain a small receipt identifying the summary, event range, resource
revisions, and plugin version that were supplied to the model.

### Internal Capabilities, Not Plugins

The following are supporting infrastructure rather than operator intentions:

- intake records;
- assistant jobs;
- generic artifact records;
- file records;
- audit events;
- notifications;
- authentication sessions.

The runtime should manage these automatically. They should not appear in the
plugin catalog. The agent should work in terms of an SOP, podcast document,
todo, workflow, or social post rather than asking the model to manipulate
internal job and artifact records.

