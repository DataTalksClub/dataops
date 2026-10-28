# Unified event lifecycle

Design for intakes d8d270d5 and 87fb06a6. Status: revised after independent
different-model review; implementation follows in verified slices. The newer lifecycle contract
supersedes preserving confirmed status when rescheduling.

## State and authority

Every event-capable Card has one current hold. Its authoritative lifecycle is
`proposed -> approved -> released`. A reschedule from proposed or approved
returns to proposed; release is allowed from either active state. Released
events can be proposed again as a new generation. Initial proposal starts at
generation 1; every reschedule and reproposal increments it. Approve, release
and operation retries retain the generation. Repeated requests with the
same operation key return the original result. Approve on an already approved
generation and release on an already released generation have no side effects.
Approval locks the current datetime, not all future edits to the Card.

An authenticated operator/API client can propose, approve, reschedule or
release. A verified guest Calendar acceptance can invoke the same approve
operation. Time edits, task completion, email delivery and Google sync success
never imply approval. Expiry can release a proposal with a recorded reason;
it cannot release an approved event. A decline records a visible response and
never releases or changes the lifecycle.

## Authoritative record and consistency

Keep the existing hold identifier and Google IDs during ordinary reschedules.
After release, reproposal allocates a fresh Google identity namespace; archive
previous event IDs in history and never attempt to PATCH a cancelled event. Evolve the hold record into
the event authority: cardId, templateId and template version, generation,
status, local date/time, IANA timeZone, startIso/endIso, duration, version,
proposal expiry, Google IDs by calendar, transition history and operation
state. Use proposed/approved/released as persisted statuses after migration.
Each history entry records transition, timestamp, actor, generation and operation
key; Calendar approval also records attendee email and the exact description
`approved via calendar accept`.

The Card links the hold and projects lifecycle/datetime for display. Episode
recording datetime is a projection of that same record, including Berlin time
and time zone; it is not another editable authority. Transactionally update
the hold, Card projection and linked episode projection using expected versions.
All existing Card time and episode date writers must invoke this service or
reject with the unified reschedule command. Concurrent approve/reschedule uses
generation and version checks, so acceptance of an old proposal cannot approve
the replacement date.

External writes cannot join a DynamoDB transaction. Persist a durable operation
and desired state in the transaction, then reconcile Google and transition hooks.
Expose pending/failed sync and a retry command; do not report a failed external
write as complete. Stable operation keys and per-hook receipts permit recovery
after crashes. A conditional lease allows one reconciler per operation. Google
identities are recoverable by deterministic UID; Zoom creation must use a
recoverable external operation identity or reconcile a previously created
meeting before retry. For email providers without idempotent submission, persist
`dispatching` before send and `sent` after acknowledgment. A crash between these
steps becomes `outcome-unknown`: surface it for provider reconciliation, never
blindly resend. A receipt alone does not guarantee exactly-once delivery. Test
crashes after provider success and before receipt storage. Block competing transitions
while an operation is unresolved. Approval commits a lock for exactly the
generation approved; retries finish that operation rather than approving anew.
The Google topology is one organizer invitation plus two imported calendar
mirrors sharing its UID. Store progress and IDs per target. Read guest responses
only from the organizer; mirror attendees never supply approval evidence. Update
all three in place on ordinary reschedule, retaining IDs. Reconcile mirrors
first and send the organizer notification last; retry compares live desired
state before sending another update. Release removes Google events
but retains all DataOps records and history. This is lifecycle release, not
deletion of stored data.

## Template policy

Add a validated event policy to the Card Template and its Card snapshot. It
defines duration, time zone, named windows, proposal/confirmed title formats,
description and invite text, proposal and approved attendee roles, invite lead
minutes, Zoom enabled/configuration reference, expiry days, calendar acceptance
enablement and quorum (`any` or `all` eligible guests), and notification/email
policy per transition. New proposals use the Card snapshot; the existing explicit
Template update mechanism refreshes that snapshot. Never silently fetch a newer
Template during an operation.
Resolve placeholders from Card fields and explicit guest addresses. No operational
addresses, credentials or private template content belongs in this public doc.
Store the policy version and fully resolved titles, descriptions, addresses,
notification settings and hook payloads on each generation so retries are
deterministic even if the Card changes.
Template updates affect a new proposal, not a half-completed operation.

The lifecycle interpreter uses these values without podcast/webinar/workshop
branches or title/duration heuristics. Test fixtures cover all three with distinct
policies, including Zoom off. Proposal attendee policy must include the guest
when Calendar acceptance is enabled. Approved hooks create/update Zoom as the
policy requires, render the confirmed title, synchronize both calendars and
attendees, and send configured emails through receipt-backed delivery. Reschedule
renders the configured proposal title (which must contain `(Proposal)`) again, resets expiry, updates the existing invite and sends
only the template's reschedule notifications. Document the Google sendUpdates
policy explicitly: guest-facing attendee/time changes notify template-selected
attendees; internal mirror updates do not send additional invitations.

## API, CLI and UI

One service backs `dataops event propose <card> --date D --time HH:MM` or
`--window NAME`, `event approve <card|hold>`, `event reschedule <card> --date D
...`, and `event release <card|hold>`. Time zone defaults from the template;
validate ambiguous/nonexistent DST wall times using the existing IANA resolver.
Expose lifecycle, datetime, generation, sync status and history in API responses.
Add equivalent event routes and an operation retry/read surface.

Retain only the aliases explicitly requested by the intake: calendar
propose/confirm-hold/release-hold and podcast reschedule translate arguments and
call the same service. They contain no lifecycle implementation. The episode
alias resolves its Card before delegation. A legacy move-hold entry point, if
retained, delegates to reschedule with the same semantics. Delete superseded
direct writers and duplicate confirm logic.

Any Card with event policy shows status, date/time/time zone, pending/error
details and Propose/Approve/Reschedule/Release controls appropriate to its state.
Changing an approved date clearly returns it to proposed. No UI action silently
approves. Episode views display the linked authority's recording datetime.

## Calendar acceptance (AC8)

Use a bounded scheduled polling fallback first; watch/push can later wake the
same reconciler. Poll authoritative proposal events and compare each required
guest's responseStatus. Authenticate Google access through the existing broker;
notification bodies alone are never approval evidence. Read the current Google
event and match stored calendar/event ID, current generation and proposal version.
The Template selects `any` or `all` eligible guests (the initial single-guest
policies use `any`); only these explicit guest addresses qualify. Internal
attendees cannot qualify. Only an explicitly configured guest attendee's accepted response qualifies;
organizer/internal mirror responses do not. Enforce response baseline/version
tracking across reschedules so an acceptance retained from an older datetime
cannot approve a new proposal. Reset guest responses when issuing a new proposal
and verify the reset before making it eligible for auto-approval. Write hold ID,
generation and desired-operation ID to organizer private extendedProperties.
Persist an eligibility baseline from the successful reset mutation response,
verifying those markers, exact start/end, organizer, expected guest set and
needsAction responses. Persist ETag and sequence with that response. Then GET
current state; a guest accepting between reset and GET is eligible immediately.
If the write response is lost, mark baseline uncertain and reconcile explicitly,
rather than repeatedly resetting away a valid acceptance. Poll current organizer state and require
matching markers/interval plus a response differing from that baseline before
CAS approval. A failed reset leaves auto-approval ineligible and visible.

Google exposes attendee responseStatus on the current event, but no per-attendee
accepted invitation sequence or response timestamp. Accordingly this protocol
rejects stale polls and retained responses; it cannot prove the intention behind
a delayed RSVP applied by Google after reset to the current event. Do not claim
that stronger guarantee. Test this provider behavior with a test attendee before
AC8 completion; accept only current authoritative state as AC8 specifies.
See [Google event resource](https://developers.google.com/workspace/calendar/api/v3/reference/events).

The reconciler calls the ordinary approve command with a deterministic operation
key for hold + generation, records timestamp and attendee email, then runs all
normal Zoom/guest/email hooks. Conditional transition plus receipts makes repeated
notifications, repeated polling and re-accepts harmless. Persist and surface
declines once per response change; do not auto-release. Poll failures remain
visible and retryable. An acceptance racing a reschedule must lose its version
check and cannot confirm the new date.

## Migration and delivery slices

1. Review this design with a different model and resolve findings before code.
2. Add schema/policy validation and the shared transition service with concurrency,
   retry and projection tests; then wire API and CLI.
3. Replace Card/episode direct writers and add the generic Card UI controls.
4. Add Calendar acceptance polling and response/history surfaces.
5. Run an explicit offline migration: tentative -> proposed, confirmed -> approved,
   released/expired -> released with retained reason. Preserve IDs, datetime,
   Google links and history; link episode/Card/template without guessing ambiguous
   ownership. Inventory hold-backed events, Card-only `card:<id>` events and
   adopted `legacy:<id>` invitations. Card-only events receive a hold authority
   with existing IDs. Foreign-organizer events require explicit ownership
   reconciliation before adoption; never send through the Orin updater blindly.
   Report ambiguities and require resolution before cutover. Backfill
   recording time from the hold; date-only unlinked episodes retain their date
   with unknown time rather than inventing an appointment. Remove migration code
   after execution; no permanent dual reads/writes or runtime resource creation.
   Cutover uses a bounded write freeze: stop old event writers and polling,
   back up and inventory, deploy the new writer while writes remain frozen,
   migrate/verify all event authorities and projections, then enable writes and
   polling. Do not run a mixed-writer interval. Dev and production cutovers are
   separate; production awaits Alexey. Protected real holds are read-only during
   development and never migration test inputs.

Coordinate with calendar-hold and Card-time changes and rebase on landed work.
Use focused commits, tests and different-model review; push main, require green
CI and deploy only dev. Infrastructure changes belong in aws-infra. Production
deployment and GitHub approval gates remain for Alexey.

## Verification contract

Unit/integration tests cover allowed/forbidden transitions, date drift prevention,
CAS races, DST, three distinct template policies, external partial failure/retry,
duplicate hooks and stale Calendar accepts. Dev E2E runs podcast and a second
type through propose/approve/reschedule/proposed/approve/release, checking DB and
both Google calendar mirrors and the organizer invitation at each step. A test attendee acceptance must automatically
approve a proposal, update the title, execute template hooks once and record the
required audit entry; repeated acceptance and decline tests prove idempotency and
non-release. Use only isolated test Cards/calendars/addresses, never real guests
or the protected episode's holds. Preserve test records as evidence. Append DONE
notes with commits, green CI/deploy references and observed results to both
intakes; never close either intake.

## Independent review, 2026-10-28

GPT-6 Astra reviewed this draft against the current implementation before code.
The revision above addresses the review findings as follows; provider RSVP
behavior remains a dev verification requirement before AC8 can be complete:

- External receipts cannot alone guarantee no duplicate email/Zoom effects after
  a crash. Require provider idempotency or recoverable identity, exclusive worker
  claims, and an outcome-unknown state when safe reconciliation is unavailable.
- Migration must inventory hold-backed, Card-only and adopted legacy invitations,
  including foreign organizers; specify write freeze and cutover sequencing.
- Reproposal after release needs fresh Google identities with previous IDs retained
  in history. Ordinary reschedules preserve IDs.
- Calendar acceptance needs a provider-verified generation/reset protocol and an
  explicit any/all guest quorum. A stale RSVP arriving after reset needs testing;
  a DB version check alone does not establish which invitation was accepted.
- Existing Google topology includes one organizer plus two mirrors. Track each
  target separately, read RSVP evidence from the organizer, and verify all three.
- Template schema must explicitly include expiry, acceptance enablement/quorum and
  notification policy. Freeze resolved render inputs for retries; define snapshot
  refresh rules and render proposal titles through the template.

Initial review verdict: revise before implementation. The revised design specifies
per-target reconciliation, uncertain outcomes, cutover inventory, fresh identities
after release, frozen policy inputs and the precise limits of Calendar evidence.
A follow-up different-model review validates the revision before runtime code.

Follow-up review found only generation advancement and fast-accept baseline
ordering gaps; both are incorporated above before runtime implementation. The
reviewer found no other design blockers in the revised design.
