# Conversational Agent Plugin Architecture

Status: accepted MVP architecture; implementation is tracked through GitHub
issues.

> This document has three parts. Part 1 (this file) covers the goals, MVP
> decisions, and the approval model, [Part 2](part-2-plugin-and-skill-framework.md)
> covers the plugin and skill framework, and [Part 3](part-3-post-mvp-plugins-adapters-and-delivery.md)
> covers post-MVP plugins, adapters, and the delivery order.

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

