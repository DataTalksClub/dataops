> Part 3 of 3 of the [Conversational Agent Plugin Architecture](part-1-goals-decisions-and-approval-model.md):
> Part 1 (entry) covers goals, MVP decisions, and the approval model;
> Part 2 covers the [plugin and skill framework](part-2-plugin-and-skill-framework.md).

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
