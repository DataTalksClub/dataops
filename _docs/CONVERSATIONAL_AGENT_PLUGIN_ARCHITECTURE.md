# Conversational Agent Plugin Architecture

Status: accepted MVP architecture; implementation is tracked through GitHub
issues.

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

## MVP Decisions

The first implementation should optimize for clarity and reversibility rather
than maximum plugin flexibility.

- The first release supports verified users in Telegram private chats using
  text, voice notes, and photos.
- The first complete mutation is one conversational todo per proposal.
- Typefully create-only support follows after the todo path proves approval and
  crash recovery. It creates an unscheduled, unpublished draft.
- Groups, generic file uploads, the web adapter, SOP and podcast mutation, workflow
  execution, recurring work, cross-channel continuation, durable personal
  memory, and the direct `/todo` shortcut are post-MVP.
- Plugins are registered explicitly in TypeScript at build time.
- The runtime does not discover or execute arbitrary plugin packages.
- The agent uses `skill_load`, then a separate model turn uses
  `skill_invoke`.
- One mutation plugin may be active at a time. Read-only knowledge or history
  lookup may support it.
- Plugins provide typed actions, validation, deterministic proposal rendering,
  and capability-scoped execution.
- Conversational collection stays in skill instructions. There is no general
  flow-definition language in the MVP.
- Every agent-requested mutation becomes an immutable proposal.
- Every MVP mutation, including todo creation, requires exact approval.
- Authentication sessions and conversation sessions remain separate.
- Conversation events and summaries are core runtime services, not plugins.
- Durable personal memory is opt-in. The system does not automatically turn
  conversation text into permanent facts.
- Runtime contracts remain channel-neutral, but only Telegram private chat is
  delivered in the MVP.

This scope is intentionally narrow. It proves one internal mutation and one
external mutation without simultaneously solving group privacy, document
ingestion, multi-effect workflows, or cross-channel presentation.

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
voice_note
photo
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
execution_pending
status_update
result
error
```

Plugins supply domain choices, validation results, and presentation hints.
The core supplies approval, revision, cancellation, and session actions.
Plugins do not contain Telegram callback formatting or web HTML. Channel
adapters decide how to render the core interactions.

### Minimum Trust Boundaries

- Telegram chat allowlisting is not user authorization. Mutations and private
  retrieval require a verified link to an enabled DataOps user.
- Authorization is checked again by the executor for the exact action, target,
  and account. The model and plugin input cannot grant permissions.
- Messages, uploaded documents, search results, and remembered prose are
  untrusted data. They cannot override system policy, select permissions, or
  bypass approval.
- Executors receive only a server-stored immutable execution envelope. They do
  not execute parameters resubmitted by Telegram or the browser.
- Retrieved and rendered content is filtered by audience and data
  classification before it enters model context or a group response.
- Voice and photo preprocessing is bounded and isolated from domain plugins.
  Generic file and rich-document processing remains deferred.

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

- **Approve and open SOP pull request**
- **Approve todo**
- **Approve and add to Typefully**

## Interaction and Approval Action Handling

Plugins define domain inputs rather than channel-specific buttons or flow
transitions. For example, Typefully may accept:

```text
choose_account
choose_platforms
```

Each plugin action declares:

- its input payload schema;
- its core-defined permission reference;
- its validation and missing-field results;
- optional presentation hints;
- its pure proposal result.

The core owns `select_option`, `submit_input`, `approve`, `request_changes`,
`cancel_proposal`, `discard_draft`, and conversation transitions. Plugins cannot
define `next_state`, approval, cancellation, or execution policy. Telegram and
future adapters render these core actions differently but send the same
normalized action to the runtime.

When an approval action is received, the core runtime should:

1. authenticate the actor and resolve their shared DataOps identity;
2. load the referenced session, plugin, proposal, and proposal version;
3. verify authorization, state, expiry, and channel binding;
4. reject stale, already-used, or mismatched actions;
5. verify that the canonical target still matches its base revision;
6. use one DynamoDB transaction to consume the action token, claim the
   proposal, and create a queued `ExecutionAttempt` with an idempotency key;
7. return `execution_pending` and disable obsolete controls;
8. let a durable worker lease the attempt and call the capability-scoped
   executor outside the approval request;
9. record the result and audit event using conditional writes;
10. render success, a safe failure, or an explicit uncertain-outcome status.

Telegram callback data should contain only a short opaque action token. The
proposal content, provider parameters, permissions, and executable action stay
on the server. Web actions should follow the same rule rather than trusting
proposal content submitted by the browser.

Repeated button presses must be idempotent. They should return the existing
result and must not execute the plugin twice.

### Proposal and Execution Records

Keep four small records instead of overloading one status field:

```text
PluginDraft
  collecting | ready | abandoned

ProposalVersion
  presented | superseded | expired | canceled | claimed | conflicted

ProposalPresentation
  active | consumed | revoked | expired

ExecutionAttempt
  queued | executing | succeeded | failed_safe | outcome_unknown
  | manually_resolved
```

`PluginDraft` is mutable working state. `ProposalVersion` is an immutable
candidate effect. `ProposalPresentation` owns channel-specific controls and
opaque token hashes. `ExecutionAttempt` is the durable job and attempt history.

Approval uses one DynamoDB transaction to validate and consume the presentation,
atomically claim the proposal, and insert the queued attempt. A DynamoDB
Stream-triggered worker leases queued attempts; a scheduled recovery scan
re-enqueues attempts whose delivery or lease was interrupted. The approval
handler never performs the external write directly.

Every attempt declares one delivery mode:

```text
provider_idempotency
correlation_lookup
operator_reconciliation_only
```

`failed_safe` means the worker can prove no change occurred. `outcome_unknown`
means the provider may have applied the change, so automatic retry is forbidden.
The plugin must reconcile by provider idempotency/correlation lookup or provide
an accepted manual reconciliation procedure before the feature is enabled.

### Exact Preview-to-Execution Binding

The immutable `ProposalVersion` contains a normalized `ProposalSpec` with every
semantically relevant field:

- plugin ID and exact build digest;
- action, operation, effect, target, and destination account reference;
- complete normalized proposed content and base revision;
- source references/revisions and data classifications;
- core permission, policy version, schema digest, and expiration.

The preview is rendered deterministically from this spec. Store both the
canonical payload hash and rendered-view hash. Executors accept only the stored
spec. They may resolve secrets and serialize provider requests, but they may not
rewrite content, change destination, schedule work, or add a new effect. Any
semantic change creates and presents a new proposal version.

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
- authentication sessions;
- mailing-list exports.

The runtime should manage these automatically. They should not appear in the
plugin catalog. The agent should work in terms of an SOP, podcast document,
todo, workflow, or social post rather than asking the model to manipulate
internal job and artifact records.

## Post-MVP SOP Plugin

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

Approval opens a branch and pull request containing the exact proposed Markdown
in the private knowledge repository. It never merges or writes directly to the
canonical branch. The approval label is **Approve and open SOP pull request**.

## Post-MVP Podcast Plugin

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

## Todo Plugin

An ordinary request such as:

> Remind me to follow up with Jane next Tuesday.

loads the `todo` plugin and invokes its `propose` action. The agent resolves
missing information, presents exactly one todo, and waits for approval. Batches
and partial success are excluded.

The deterministic `/todo` shortcut is deferred until the conversational path
has proven the approval system. If later added, it must be private-chat,
create-only, linked-user-only, idempotent, deterministic, explicit about
timezone and no-time behavior, and provide a short undo action.

## Social Media and Typefully

Social media is a first-class capability.

Suggested plugin action:

```text
plugin: typefully
action: propose_draft
  operation: create
  account: alexey | datatalksclub
  platforms: x[] | linkedin[]
  title?: string
  source_refs?: string[]
  destination: typefully
```

Example conversational sequence (not a framework DSL):

```text
collect_request
  -> choose_account when account is missing
  -> choose_platforms when platforms are missing
  -> compose
  -> review
       core request_changes -> compose
       core cancel_proposal -> canceled
       core approve -> execution_pending
  -> completed
```

The agent clarifies the account, platforms, purpose, and missing source
material, then shows the complete platform-specific copy. Scheduling questions
are omitted because this action cannot schedule; avoiding non-executable fields
keeps the preview and effect unambiguous.

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
boundary explicit.

The existing `/social` command should not be the primary workflow and should
not create a Typefully draft directly. Ordinary conversation should drive
social drafting.

## Telegram Voice and Photo Input

Voice notes and photos are channel inputs, not plugins. They produce normalized
conversation events before plugin selection:

```text
Telegram voice note
  -> authenticated bounded download
  -> Groq Whisper transcription
  -> delete audio bytes
  -> voice_note event with transcript and Telegram provenance

Telegram photo plus optional caption
  -> authenticated bounded download
  -> z.ai GLM-4.6V description and OCR
  -> delete image bytes
  -> photo event with description, caption, and Telegram provenance
```

Downstream logic receives text regardless of input modality, and the bot shows
the transcript or description back to the operator before continuing.

Use Groq `whisper-large-v3` for multilingual voice accuracy. Use z.ai
`glm-4.6v` for photo understanding through its native multimodal endpoint. The
conversational model remains z.ai through its Anthropic-compatible Messages
endpoint. Provider/model IDs are configuration with startup validation; the
writing assistant's former Groq Llama vision model has been retired.

MVP limits:

- Telegram private chat and verified linked users only;
- voice/OGG and Telegram photo JPEG only;
- one media item per event;
- at most 20 MB and five minutes for voice, and 10 MB/20 megapixels for photos;
- bounded download and provider timeouts, with no automatic unbounded retry;
- temporary bytes are sent only to the dedicated media processor; they never
  enter DynamoDB, logs, audit events, or conversational-model context;
- a `finally` path deletes temporary bytes after success or failure, and a
  bounded startup/reaper cleanup removes crash-orphaned temporary objects;
- derived transcript/description is owner-private, excluded from logs and audit
  payloads, and follows the 30-day conversation retention;
- provider output is untrusted text and cannot authorize or execute anything;
- the bot reports conversion failure and asks for text instead of guessing.

DataOps needs dedicated production secret references and least-privilege
deployment wiring for both processors. Automated tests use fake Telegram
download, transcription, and vision clients.

## Uploaded Documents and Classification

Generic uploaded-document handling is post-MVP. It should not be enabled until bounded
plain-text extraction, quarantine, size limits, classification, and
prompt-injection handling exist. PDF, office, archive, image, link, and macro
handling are not one generic capability.

When introduced, an uploaded document should enter intake before any canonical
change.

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

The minimal persistent records are:

```text
IdentityBinding
  DataOps user <-> verified channel user

Conversation
  owner, audience, status, active plugin/draft/proposal, revision

ChannelBinding
  conversation <-> Telegram chat/topic or web conversation

ConversationEvent
  ordered immutable input/output/action event with provenance

SummaryCheckpoint
  replaceable summary through a specific event sequence

Proposal
  split into PluginDraft, ProposalVersion, ProposalPresentation,
  and ExecutionAttempt
```

Conversation events use stable idempotency keys and a monotonic revision. Model
work runs from revision `N` without holding a lock and may commit only if the
conversation is still at `N`; otherwise it is discarded and reprocessed. A
loaded skill is bound to conversation ID/revision, plugin build digest, and a
one-time load nonce. New input invalidates stale model work.

Inactivity does not silently change conversation identity in the MVP.
Conversations change only through explicit session actions. Approval tokens
expire independently after 30 minutes and are never revived.

Resuming a session must not revive an expired approval. The agent may restore
context, but the system must generate a fresh approval for any pending action.

Cross-channel continuation should require linked identities and explicit user
action. For example, an authenticated portal user may choose to continue a
Telegram-originated session in the web portal. The system must not infer that
two channel identities belong to the same person.

## Telegram Adapter

In a private chat, the bot may treat each ordinary message as conversational
input.

Group conversation is disabled in the MVP. A mention may return a static,
public-safe prompt to continue in private chat, but it must not retrieve private
context, invoke the model, present private preview links, or mutate anything.

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
| `/new` | End the current conversation and start a new one; executing attempts continue to status. |
| `/continue` | Resume a paused conversation. |
| `/sessions` | List resumable conversations. |
| `/cancel` | Revoke the active unexecuted proposal presentations; keep the draft and conversation. |
| `/discard` | Abandon the active draft; do not affect an executing attempt or end the conversation. |
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
| Cancel proposal | Revoke the active unexecuted proposal presentations. |
| Discard draft | Abandon working state without ending the conversation. |
| End conversation | Close the conversation; executing attempts remain visible by status. |

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
- The current `Sessions` records contain authentication tokens and user IDs;
  they are not suitable for conversation history or memory.
- Telegram chat allowlisting does not link a Telegram sender to an authorized
  DataOps user.
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

1. Define event, identity, conversation, proposal, presentation, attempt, and
   audit contracts in DynamoDB.
2. Implement event deduplication, single-writer revisions, and stale-turn
   rejection.
3. Implement exact proposal specs, 30-minute presentation tokens, transactional
   approval claims, durable worker leasing, and reconciliation.
4. Add the static registry, compact catalog, `skill_load`, and `skill_invoke`.
5. Implement the verified private-Telegram adapter and callback handling.
6. Register conversational todo create and prove conflict, duplicate-click,
   revocation, crash, and recovery behavior.
7. Remove the premature Typefully write, register Typefully create-only, and
   enable it only after its reconciliation mode is accepted.
8. Roll out with kill switches, redacted monitoring, and real-account smoke
   checks.
9. Consider SOP, podcast, web, history search, commands, groups, uploads,
   workflows, recurring work, and memory only after the MVP is stable.

## Resolved Product Decisions

These choices favor the smallest safe system. They can be revisited with usage
evidence.

| Decision | MVP choice | Why |
|---|---|---|
| SOP effect | Open a branch and pull request in the private knowledge repository; never merge directly. | Git review is a second safety boundary and matches the knowledge boundary. |
| Document source of truth | Markdown with strict front matter, stable IDs, and a lossless parser/renderer for both SOP and podcast documents. | One human-readable canonical format avoids dual-write synchronization. |
| Telegram groups | No conversational group mode; only a static invitation to continue privately. | This removes audience and private-context leakage from the first release. |
| `/todo` | Defer it. | Conversational todo must first prove the universal approval path. |
| Approval expiry | One configurable 30-minute default for every MVP proposal. | One policy is understandable and avoids plugin-specific timing rules. |
| Cross-channel approval | Deferred with the web adapter. Later, each presentation gets a token and one global claim wins. | The MVP has only one channel, while the data model remains future-safe. |
| Typefully data egress | Public source material only. Organization, user-private, and restricted source documents are blocked. | A saved third-party draft is still external disclosure. |
| External-write guarantee | Provider idempotency, reliable correlation lookup, or an explicitly accepted manual reconciliation procedure is a release gate. | Unknown outcomes must never trigger blind retries. |
| Typefully operations | Create one unscheduled, unpublished draft only. | Update, schedule, and publish require additional conflict and effect semantics. |
| Todo batching | Exactly one todo per proposal. | This removes transaction batches and partial-success behavior. |
| Conversation inactivity | No automatic pause or new conversation. Session changes are explicit. | Timer-driven identity changes are surprising and unnecessary. |
| Retention | Raw messages, derived voice/photo text, summaries, proposal payloads, and redacted provider results: 30 days. Minimal audit metadata and effect receipts: 1 year. Temporary media bytes are deleted after processing. | Short payload retention limits exposure while preserving operational evidence. |
| Model-provider egress | Public and ordinary operator-entered task text may be sent; operational source documents classified organization, user-private, or restricted are blocked. Prompt/completion bodies are not logged by default. | This permits the MVP without silently exporting private knowledge. |
| Voice/photo provider egress | Voice bytes go only to Groq Whisper; photo bytes go only to z.ai vision. The bot shows derived text before it becomes conversational input. | A narrow declared route makes third-party processing visible and testable. |
| Generic upload formats | None in the MVP. Plain text may be the first later format after the intake boundary exists. | Rich “attachments” otherwise introduce several unrelated security problems at once. |
| Identity lifecycle | Admin creates/revokes an audited binding between a DataOps user and immutable Telegram numeric user ID; linking occurs only in private chat. Authorization is rechecked at read, approval, and worker execution. | This avoids building a self-service portal flow while still supporting revocation safely. |
| Cancel semantics | Cancel proposal revokes presentations; discard draft abandons working state; end conversation closes the session. An executing attempt cannot be canceled unless the provider supports it. | Separate verbs prevent a UI action from promising an impossible rollback. |
