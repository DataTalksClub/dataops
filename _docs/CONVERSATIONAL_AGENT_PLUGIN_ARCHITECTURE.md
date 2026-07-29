# Conversational Agent Plugin Architecture

Status: work in progress  
Purpose: capture product suggestions for discussion; this is not yet an
implementation specification or a final decision.

## Goal

DataOps should provide one conversational agent that can be used through
Telegram, the web portal, and future interfaces. It should not be implemented
as a collection of feature commands or as separate agents for each interface.

An operator should be able to describe what they want, answer clarifying
questions, review the complete proposed result, and approve the exact change
from the interface they are currently using.

Examples include:

- creating or editing an SOP;
- preparing or editing a podcast document;
- creating a todo;
- starting a workflow;
- creating a recurring todo;
- drafting a social media post and adding the approved draft to Typefully;
- turning an uploaded document into an appropriate DataOps document.

Podcast support is one capability of the shared bot, not a separate Telegram
bot.

## Channel-Independent Architecture

The conversational runtime, plugin system, sessions, proposals, and approval
engine should not depend on Telegram or the web portal.

```text
Telegram adapter -----\
                       \
Web adapter ------------> Conversational runtime
                       /       |
Future channel adapter-/        +--> Plugin registry
                                +--> Session store
                                +--> Proposal and approval engine
                                +--> Trusted plugin executors
```

Every channel adapter translates between its native events and a shared
interaction contract.

Normalized incoming events include:

```text
message
attachment
button_action
form_submission
session_command
```

Shared outgoing interactions include:

```text
assistant_message
clarification
proposal_preview
choice
approval_request
result
error
```

Plugins describe semantic interactions such as “select account,” “choose a
time,” “approve this proposal,” or “request changes.” They do not contain
Telegram callback formatting or web HTML. Channel adapters decide how to
render those interactions.

## Core Interaction Model

Ordinary messages start or continue a conversation:

```text
Operator request
    |
    v
Load the active conversation session
    |
    v
Understand the requested resource and gather context
    |
    v
Ask only the necessary clarifying questions
    |
    v
Create or revise a complete proposal
    |
    v
Show a preview or diff in the active interface
    |
    v
[Approve] [Request changes] [Cancel]
    |
    v
Trusted backend code applies the exact approved proposal
```

The model does not directly mutate canonical documents, tasks, workflows, or
external services. It invokes registered plugin skills to create proposals. A
trusted executor performs the real mutation only after approval.

The proposal can be revised repeatedly during the conversation. Intermediate
revisions do not require approval because they do not affect canonical data or
external systems. The operator approves once the complete proposal is ready.

## Approval Rules

Every proposal should be immutable and versioned once it is presented for
approval.

An approval should be bound to:

- the proposal ID and exact proposal version;
- the operation, such as create or update;
- the resource type and target;
- the complete proposed content;
- the base revision of an existing target;
- the requesting user, channel, and conversation;
- an expiration time.

If the proposal changes, the previous approval buttons become invalid.

If an existing target changes after the proposal was prepared, approval should
report a conflict. The system should prepare a new proposal rather than
overwriting the newer target.

A detached message such as `yes` should not authorize a consequential action.
Approval should use a version-bound button or form action supplied by the
active interface.

The default buttons are:

- **Approve**
- **Request changes**
- **Cancel**

The approval label should describe the actual effect when useful, for example:

- **Approve and create SOP**
- **Approve todo**
- **Approve and add to Typefully**

## Interaction and Approval Action Handling

Plugins should define semantic actions rather than channel-specific buttons.
For example, a Typefully flow may expose:

```text
choose_account
choose_platforms
choose_preferred_time
approve_draft
request_changes
cancel
```

Each action declares:

- the states in which it is available;
- its label and optional presentation hint;
- its input payload schema;
- whether it only updates conversation state or requests execution;
- the next flow state;
- the result that should be rendered.

Telegram and the web portal render these actions differently but send the same
normalized action to the core runtime.

When an approval action is received, the core runtime should:

1. authenticate the actor and resolve their shared DataOps identity;
2. load the referenced session, plugin, proposal, and proposal version;
3. verify authorization, state, expiry, and channel binding;
4. reject stale, already-used, or mismatched actions;
5. verify that the canonical target still matches its base revision;
6. call the registered plugin executor with an idempotency key;
7. record the result and audit event;
8. advance the plugin flow and session state;
9. ask the channel adapter to replace or disable obsolete controls;
10. render the completed result or a recoverable error.

Telegram callback data should contain only a short opaque action token. The
proposal content, provider parameters, permissions, and executable action stay
on the server. Web actions should follow the same rule rather than trusting
proposal content submitted by the browser.

Repeated button presses must be idempotent. They should return the existing
result and must not execute the plugin twice.

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

The preferred implementation may dynamically mount the selected plugin's
strict action schema after `skill_load`. This preserves native schema-guided
tool calling while ensuring the model sees only the currently relevant plugin,
not every schema in the system.

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
  approval_policy
renderer
validator
executor
permissions
```

The manifest summary and activation hints are safe for the compact base
catalog. Full instructions and action schemas are loaded only when selected.

Plugin instructions are lower priority than core system and approval rules. A
plugin cannot grant itself broader permissions or bypass approval.

### Plugin Package and Registration

A plugin should be a self-contained registered package with a conventional
shape:

```text
plugins/<plugin-id>/
  manifest
  skill instructions
  action schemas
  flow definition
  validators
  renderers
  executor
  tests
```

Registration should happen through trusted application configuration or code,
not by allowing the model to load arbitrary executable packages. At startup or
deployment, the registry should:

1. discover explicitly enabled plugins;
2. validate manifests and unique plugin/action names;
3. validate action and interaction schemas;
4. verify that declared executors and renderers exist;
5. build the compact catalog for the agent;
6. expose only plugins allowed for the current environment and user.

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

Sessions and proposals should record the plugin version used to create them.
An incompatible plugin upgrade should require a proposal to be regenerated
rather than executed with different behavior.

### Plugin Flow Definition

A plugin may describe its conversational flow declaratively:

```text
flow
  entry_action
  required_fields
  optional_fields
  clarification_rules
  states
  transitions
  interaction_actions
  proposal_renderer
  completion_result
```

The flow is a guardrail and interface contract, not a rigid script. The model
can converse naturally and fill fields in any reasonable order, while the
runtime enforces required information and legal transitions.

Interaction actions have stable semantic IDs, labels, and payload schemas:

```text
select_account
select_platforms
select_time
approve
request_changes
cancel
```

A plugin can suggest channel-neutral presentation hints:

```text
single_choice
multiple_choice
date_time
text_input
document_preview
diff_preview
confirmation
```

Telegram may render these as inline keyboard buttons followed by messages. The
web portal may render the same actions as buttons, selectors, forms, and a
side-by-side diff.

Only an approved proposal action can call a consequential plugin executor.
Clarification and selection buttons update session or proposal-draft state;
they do not mutate canonical resources.

Different plugins may expose different interaction actions:

| Plugin state | Example actions |
|---|---|
| SOP clarification | **Create new SOP**, **Update existing SOP**, **Choose document** |
| SOP review | **View full document**, **View diff**, **Request changes**, **Approve SOP**, **Cancel** |
| Podcast clarification | **Choose audience**, **Choose duration**, **Add source** |
| Podcast review | **Review questions**, **Request changes**, **Approve podcast document**, **Cancel** |
| Typefully clarification | **Alexey**, **DataTalksClub**, **X**, **LinkedIn**, **Choose preferred time** |
| Typefully review | **Approve and add to Typefully**, **Request changes**, **Cancel** |
| Todo clarification | **Today**, **Tomorrow**, **Choose date**, **No time** |
| Todo review | **Approve todo**, **Request changes**, **Cancel** |

These labels are presentation defaults. The stable semantic action IDs and
schemas, not the displayed text, drive runtime behavior.

### Initial Plugins

| Plugin | Responsibility |
|---|---|
| `knowledge-search` | Search approved knowledge and load documents. Read-only. |
| `sop` | Create or update a structured SOP proposal. |
| `podcast` | Create or update a podcast preparation document proposal. |
| `todo` | Create or update a todo proposal. |
| `workflow` | Start or update an operational workflow proposal, usually from a workflow template. |
| `recurring-todo` | Create or update a recurring work proposal. |
| `typefully` | Prepare social copy and propose creating an unscheduled Typefully draft. |

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

Bookkeeping should not receive a broad generic mutation tool. Any future
bookkeeping plugin actions should be narrow, strongly validated, and separately
approved.

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

### Internal Capabilities, Not Plugins

The following are supporting infrastructure rather than operator intentions:

- intake records;
- assistant jobs;
- generic artifact records;
- file records;
- audit events;
- notifications;
- authentication sessions;
- mailing-list exports.

The runtime should manage these automatically. They should not appear in the
plugin catalog. The agent should work in terms of an SOP, podcast document,
todo, workflow, or social post rather than asking the model to manipulate
internal job and artifact records.

## SOP Plugin

SOPs are a core DataOps concept and require a dedicated schema-aware plugin.

Suggested plugin action:

```text
plugin: sop
action: propose
  operation: create | update
  target_id?: string
  expected_revision?: string
  sop: SopDocument
```

The SOP structure should cover:

- stable metadata and document ID;
- title, summary, tags, systems, and related documents;
- prerequisites;
- procedure groups;
- ordered steps with stable step IDs;
- step attributes and validation guidance;
- screenshots and captions;
- validation;
- troubleshooting;
- references.

The agent should work with this structure rather than manually constructing the
repository's marker syntax. The backend should render and lint the structured
proposal as Markdown.

Approval of an SOP proposal is the point at which the executor creates or
updates the canonical document.

## Podcast Plugin

Podcast documents have a different structure and require a separate plugin.

Suggested plugin action:

```text
plugin: podcast
action: propose
  operation: create | update
  target_id?: string
  expected_revision?: string
  podcast: PodcastDocument
```

The initial podcast schema should cover:

- guest name, role, organization, location, and links;
- working title and episode angle;
- intended audience and duration;
- episode objective and hook;
- guest background and current focus;
- topics to cover and topics to avoid;
- concrete stories, examples, and supporting sources;
- introduction;
- ordered topic sections;
- ordered questions and optional follow-ups;
- practical advice and resource questions;
- closing;
- event description draft;
- host notes.

Question lists are small enough that create and update operations can submit the
complete podcast document. Stable section and question IDs should still be
preserved so revisions and diffs are understandable.

## Todo Plugin and Direct Command

Todos need two paths.

### Conversational Path

An ordinary request such as:

> Remind me to follow up with Jane next Tuesday.

loads the `todo` plugin and invokes its `propose` action. The agent resolves
missing information, presents the todo, and waits for approval.

### Direct Shortcut

An explicit `/todo` command should bypass the conversational agent and create a
todo immediately:

```text
/todo 2026-08-04 10:00 Follow up with Jane
/todo tomorrow 10:00 Follow up with Jane
/todo friday Prepare podcast notes
/todo Follow up with Jane
```

The command itself is explicit authorization, so it does not need another
approval button. Parsing must be deterministic. If the input cannot be parsed
safely, nothing should be created and the bot should show the accepted syntax.

When no time is supplied, the runtime should use a documented default rather
than asking the language model to guess.

Only deliberately selected operations should receive direct command shortcuts.
The existence of `/todo` does not imply that SOP, podcast, social, or workflow
commands should bypass proposals.

## Social Media and Typefully

Social media is a first-class capability.

Suggested plugin action:

```text
plugin: typefully
action: propose_draft
  operation: create | update
  proposal_id?: string
  account: alexey | datatalksclub
  platforms: x[] | linkedin[]
  title?: string
  source_refs?: string[]
  preferred_publish_at?: string
  destination: typefully
```

Example flow:

```text
collect_request
  -> choose_account when account is missing
  -> choose_platforms when platforms are missing
  -> choose_preferred_time when timing is useful
  -> compose
  -> review
       request_changes -> compose
       cancel -> canceled
       approve_draft -> executing
  -> completed
```

The agent should clarify the account, platforms, purpose, and any missing source
material. The plugin flow may also ask when the operator would like the post to
go out and offer suggestions such as later today, tomorrow, or choosing a
specific time. It should then show the complete platform-specific copy and the
preferred timing.

The preferred time is planning metadata in this version. It can be included in
the proposal and Typefully draft notes, but it is not sent as a scheduling or
publishing instruction.

Before approval:

- nothing is written to Typefully;
- the proposal may be revised;
- the operator can review all X and LinkedIn posts;
- the current proposal version is the only version eligible for approval.

After **Approve and add to Typefully**:

- the executor creates an unscheduled saved Typefully draft;
- the bot returns the private editing link to the authorized operator;
- the Typefully draft ID is recorded as proof of the approved action;
- the executor does not schedule or publish the post.

This is the complete Typefully scope for the conversational agent. It does not
need Typefully scheduling or publishing tools. Scheduling and publication
remain manual actions in Typefully. The completion message should make that
boundary explicit even when a preferred time was collected.

The existing `/social` command should not be the primary workflow and should
not create a Typefully draft directly. Ordinary conversation should drive
social drafting.

## Uploaded Documents and Classification

An uploaded document should enter intake before any canonical change.

The runtime should extract safe text and metadata, then classify the likely
resource:

- SOP;
- podcast source material or podcast document;
- reference document;
- reusable content template;
- todo list;
- unknown.

Classification is not a mutation. The bot should explain what it recognized
and ask for confirmation when the category or intended result is uncertain.

After classification, the agent loads the corresponding plugin and invokes its
proposal action. For example:

- step-by-step instructions become an SOP proposal;
- guest research and questions become a podcast proposal;
- a list of actions becomes one or more todo proposals;
- reusable outreach copy becomes a content-template proposal;
- informational material becomes a reference proposal.

Original files should remain attached to intake or to the proposal as source
material. The generated canonical document should preserve source references
without exposing private links or credentials.

## Conversation Sessions

Conversation sessions should be separate from login/authentication sessions.

A session should be scoped by:

- shared DataOps user identity;
- channel;
- channel conversation or chat;
- channel thread or topic when present.

For Telegram this maps to the Telegram user, chat, and optional topic. For the
web portal it maps to the authenticated user and a web conversation ID. This
avoids treating a Telegram group as one shared private context while allowing
the web interface to present explicit conversations.

A session should contain:

- current objective;
- compact conversation summary;
- bounded recent messages;
- active plugin ID and version;
- plugin flow state and collected fields;
- active proposal and resource type;
- known facts and source references;
- unresolved clarification questions;
- pending approval reference;
- status and timestamps.

After approximately 20 minutes of inactivity, a session should become paused,
not deleted. An ordinary later message can start a new session while noting
that paused work exists. `/continue` should resume a selected paused session.

Resuming a session must not revive an expired approval. The agent may restore
context, but the system must generate a fresh approval for any pending action.

Cross-channel continuation should require linked identities and explicit user
action. For example, an authenticated portal user may choose to continue a
Telegram-originated session in the web portal. The system must not infer that
two channel identities belong to the same person.

## Telegram Adapter

In a private chat, the bot may treat each ordinary message as conversational
input.

In a group, the bot should respond only when:

- it is mentioned;
- a user replies to one of its messages; or
- the same user is already in an active conversation with the bot in that
  thread.

This prevents the bot from interpreting unrelated group conversation as work
requests.

Telegram should render:

- clarifications as messages with inline keyboard choices when appropriate;
- long proposals as a summary plus a secure preview link or chunked messages;
- approvals as inline buttons backed by opaque action tokens;
- completed actions by editing or disabling the previous approval controls.

Telegram messages and callback queries should be normalized before they reach
the agent runtime. Plugins should not call the Telegram API directly.

### Telegram Commands

Commands should control sessions or provide an explicitly deterministic
shortcut. They should not be the primary interface for product capabilities.

Suggested commands:

| Command | Behavior |
|---|---|
| `/new` | Pause the current conversation and start a new one. |
| `/continue` | Resume a paused conversation. |
| `/sessions` | List resumable conversations. |
| `/cancel` | Cancel the active proposal or conversation. |
| `/todo ...` | Deterministically create a todo immediately. |
| `/help` | Explain conversational usage and available session controls. |

The existing `/podcast` and `/social` feature-command behavior should be
retired once the conversational agent replaces it.

## Web Adapter

The web portal can provide easier explicit session management:

- a conversation list and clear “new conversation” control;
- resumable conversation URLs;
- richer document previews and side-by-side diffs;
- forms for dates, accounts, platforms, and other structured choices;
- persistent proposal status and approval history;
- visible expired, superseded, approved, and canceled states.

The web UI should still send normalized interaction actions to the same core
runtime. It must not apply proposals through a separate web-only mutation path.

Web controls corresponding to Telegram commands can be ordinary UI actions:

| Web action | Shared behavior |
|---|---|
| New conversation | Same session transition as `/new`. |
| Continue | Same session transition as `/continue`. |
| Conversation list | Same data as `/sessions`. |
| Cancel proposal | Same transition as `/cancel`. |
| Quick todo | Same deterministic parser and direct executor as `/todo`. |

This keeps behavior consistent while allowing each interface to use controls
that feel natural for that channel.

## Search and Read Operations

Read-only operations do not require approval.

The agent should be able to:

- search approved knowledge;
- load an SOP or other document by stable ID;
- inspect a todo or workflow relevant to the conversation;
- inspect the current version of a resource before proposing an update;
- retrieve the status of a proposal the same user is authorized to see.

Read operations must still enforce authorization and the public/private
knowledge boundary.

## Knowledge Boundary

The model-facing tool contract should not hard-code a repository destination.
Trusted backend configuration should select the correct canonical store.

The public `DataTalksClub/dataops` repository contains product/runtime code,
schemas, tests, and public-safe planning. Operational knowledge is intended to
move to the private `DataTalksClub/dataops-knowledge` repository.

Existing `content/` material is transitional public-sensitive migration debt.
The conversational agent must not make it easier to copy private operational
content into the public repository.

## Current-System Gaps

The existing code provides useful foundations, but it does not yet implement
this interaction model:

- Telegram currently routes several feature commands directly.
- There is no persistent conversational-session model separate from
  authentication sessions.
- Telegram callback queries are not yet part of the webhook update contract.
- There is no channel-neutral interaction contract or shared Telegram/web
  conversational runtime.
- There is no plugin registry, plugin manifest validation, or progressive
  skill loading.
- The docs mutation API commits canonical Markdown directly.
- The social assistant can create a saved Typefully draft before a Telegram
  proposal approval.
- Assistant-job approval exists, but it is not yet a universal, immutable,
  version-bound proposal system.
- The podcast assistant has an intake template but not a formal runtime
  `PodcastDocument` schema.

Direct mutation APIs may remain available to the portal and trusted executors,
but they should not be exposed through plugin skills.

## Suggested Delivery Order

1. Define the channel-neutral event, interaction, session, proposal, and action
   contracts.
2. Add persistent conversation sessions, including Telegram group activation
   rules and explicit web conversations.
3. Add a generic internal proposal record, versioning, expiry, idempotent
   action handling, and trusted approval execution.
4. Add the plugin registry, manifest validation, compact catalog,
   `skill_load`, and `skill_invoke` framework.
5. Implement Telegram and web adapters over the shared runtime.
6. Register the `todo` plugin and deterministic `/todo` shortcut as the
   smallest end-to-end path.
7. Register the structured `sop` plugin and staged GitHub executor.
8. Define `PodcastDocument` and register the `podcast` plugin.
9. Register the `typefully` plugin and change social drafting to stage locally,
   then create an unscheduled Typefully draft only after approval.
10. Register workflow and recurring-todo plugins.
11. Add later plugins only when their schemas and safety rules are
   clear.

## Open Questions

- Should a new ordinary message after the inactivity timeout automatically
  start a new session, or should the bot ask whether to resume?
- What default date and time should `/todo` use when either is omitted?
- Should a proposal be allowed to contain multiple todos with one approval, or
  should each todo require a separate approval?
- What should be the initial canonical storage format and location for podcast
  documents?
- Which uploaded file formats should be supported first?
- Which reference and content-template schemas need first-class plugins in the
  first release?
- What proposal and approval expiration periods are appropriate?
- Should linked users be able to continue a Telegram conversation on the web
  immediately, or should cross-channel continuation be deferred?
- Which channel-neutral interaction components are required for the first
  plugin release?
