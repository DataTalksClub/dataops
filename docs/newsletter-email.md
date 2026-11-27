---
title: "Newsletter email: built in DataOps, sent through Relay"
summary: "How a newsletter issue's email is drafted, rendered, approved and handed to Relay; the API contract, guards, Relay transport contract and what was retired."
doc_type: reference
tags: [newsletter, relay, api]
systems: [dataops, relay]
related_docs: []
---

# Newsletter email: built in DataOps, sent through Relay

## Summary

DataOps owns each issue's email: the content blocks, the subject and preview
text, the rendering and the review. Relay is transport only: once the owner
approves the exact rendered revision in DataOps, DataOps hands that frozen
payload (subject, preview text, HTML, plain text) to Relay's existing client
campaign API, which sends a test to the owner's mailbox; once the owner
confirms that test arrived, the same payload is scheduled. Nothing is imported or pulled
from Relay, and no block is ever written to Relay.

## Content

### Flow

1. **Start**: on the issue page (`/newsletter/<issue-id>`) "Start the draft",
   or `dataops newsletter draft <issue> --create`. The draft starts with one
   intro block whose label is the issue number and date. No Relay call. Slots
   that already have a sponsor document get their sponsor block at once.
2. **Build**: the left pane holds subject and inbox preview text, the ordered
   block list (each block opens into its form; arrows reorder) and "Add block"
   with a block-type picker. Incomplete blocks may be saved; bad URLs, unknown
   fields and over-long values are refused. Every change is one revision.
3. **Preview**: the right pane shows the whole email, re-rendered by DataOps
   from the unsaved form state as you type (`POST /draft/preview`, writes
   nothing). "View full email" opens `/newsletter-issues/<id>/preview`: the
   exact email at desktop and phone width with what still blocks approval.
4. **Approve** (owner): "Approve this version" on the full-email page, or
   `dataops newsletter approve <issue> --version N --hash <sha256>` with the
   values `render` printed. The approval names the draft version and the
   sha256 of the rendered payload; the payload is frozen in its own item.
5. **Edit after approval**: any content change (block, subject, preview text,
   a sponsor-doc save) withdraws the approval and the test receipt and records
   that in the history.
6. **Test send** (owner, approval current): "Send test to me" (or
   `dataops newsletter test-send <issue>`). The frozen payload becomes a Relay
   draft campaign and Relay sends it to the owner's mailbox
   (`alexey@datatalks.club`), fixed on the server; a request naming any other
   address is refused (`400 test_recipient_not_owner`).
7. **Test receipt** (owner): when the test arrived and looks right, "I received
   the test — it looks right" (or `dataops newsletter test-receipt <issue>
   --test <request-id> --version N --hash <sha256>`) records the receipt for
   that exact approved version and payload hash. A provider-accepted send is
   not a receipt.
8. **Schedule** (owner, approval and receipt current): one Schedule button,
   labelled with its time: 10:00 Europe/Berlin on the issue's publication date,
   or on the next Monday when that has passed (at least 15 minutes ahead,
   DST-correct). "Change time" adjusts the date and time (Berlin) in place.
   The frozen payload is saved with `scheduled_at` and queued; DataOps shows
   the time and status Relay confirmed. Relay's own scheduling options are not
   reproduced here and stay untouched for other workflows.
9. **Edit a scheduled email**: saving any change (block, subject, preview text,
   a sponsor-doc save) is one action that first cancels the Relay campaign and
   reads it back to verify the cancel, then saves the change, withdraws the
   approval and test receipt, and leaves the email a draft (`delivery.state
   cancelled`). Only an explicit `cancelled` status read back from Relay
   counts. If Relay cannot be reached, times out, answers 403, has no campaign
   under that key (404), refuses the cancel, or has started sending, the edit
   fails (`unschedule_failed`) and neither the content nor the schedule
   changes. While a schedule request is still in flight the edit
   waits (`409 schedule_in_progress`). "Cancel schedule" cancels without an
   edit. The next schedule is a new campaign.

### Sponsor content

A sponsor slot with a sponsor document takes its sponsor block from the doc:
every doc save stages the block (and, for the primary slot, the subject with
the ` | DataTalks.Club Weekly` suffix and the preview text) into the DataOps
draft. Staging is local only: no Relay call, no invoice, deal or outreach.
The one exception is a scheduled issue: a staff doc save that changes the
doc first unschedules every linked scheduled draft (step 9); if Relay cannot
confirm, the doc is not saved. A sponsor's own save of a doc whose issue is
scheduled is refused (`409 newsletter_scheduled`).
The block is read-only in the editor and links to its doc.

The linked sponsor document is the only way to change a sponsor block's copy.
Sponsor blocks are not in the "Add block" picker and cannot be edited in the
draft (`409 sponsor_block_doc_only` / `sponsor_block_readonly`). An own
DataTalks.Club promo (a course, a Zoomcamp) gets its own internal sponsor doc
too: book the slot for DataTalks.Club (which skips the invoice and
sponsor-email Tasks, `dataops newsletter sync-tasks`) and create the doc from
the issue page; no sponsor email is prepared for an own slot. A sponsor block
left without a doc (archived hand-made blocks, or a main block whose doc was
removed) stays readable and deletable but blocks approval.

Readiness (`422 draft_incomplete` at approval; draft saves stay possible and
list the same problems):

- every sponsor block comes from a linked sponsor doc, and a booked slot has one;
- the subject is at most 65 characters, not counting the
  ` | DataTalks.Club Weekly` suffix, and the preview text at most 140;
- a sponsor block's title is at most 12 words;
- an own DataTalks.Club promo has bullet points, a closing sentence and `utm_`
  tracking parameters in its button link.

A newsletter sponsor doc marked Submitted / Ready enforces the same subject,
preview text and title limits (`422` with per-field messages); drafts may
exceed them.

The sponsor doc page shows the sponsor block as recipients see it: the
button's link carries the URL (with its tracking) and is not repeated as text,
empty fields render nothing, and the subject and preview text are edited on the
left and shown in the whole-email preview. The X post is one card per tweet
(stored as the `---`-joined thread). Staff get a compact strip (Copy share
link, Open Card, and a More menu with the sponsor email, send, rotate code and
Copy Markdown); the share URL and access code are never displayed, and a
newsletter sponsor doc shows no Markdown dump.

### Rendering

`backend/src/newsletter/emailRender.ts` is a TypeScript port of Relay's block
renderer (`mailing/services/newsletter_layout.py`, `render_issue`,
`render_block_text`) filling the same #302 Mailchimp shell
(`emailSkeleton.ts`, copied from Relay at 394fd42). The test
`backend/tests/newsletter-email-render.test.ts` proves the port renders issue
#302's blocks and the whole document byte for byte like Relay did. Markdown
fields escape raw HTML and keep only http(s)/mailto links; the `html` block
inserts its HTML as is. The footer keeps Mailchimp's `list-manage.com`
preferences/unsubscribe links with `[UNIQID]`, which Relay's campaign send
rewrites to each recipient's Relay unsubscribe page.

"View this email in your browser" links to
`<portal>/api/newsletter-view/<token>`, a public, script-free page that serves
the frozen payload Relay was asked to send (per-recipient links disabled), and
only while it is scheduled or sent.

### API contract

All routes are under `/api/newsletter-issues/<issue>/draft` and need a DataOps
identity (`work-read` for reads, `work-write` for writes; API tokens need
`newsletter:write`). "Owner" means the admin account of `alexey@datatalks.club`
signed in personally (browser session or the CLI's personal login), never a
scoped API token; others get `403 newsletter_owner_required`.

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| POST | `/draft` | `{}` | 201 `{draft, sponsorStaging}`; 409 `draft_exists` |
| GET | `/draft` | | `{draft}`; 404 `draft_missing` |
| PUT | `/draft` | `{version, subject?, previewText?}` | `{changed, draft}`; 409 `draft_version_conflict` |
| GET | `/draft/render[?mode=editor]` | | `{render: {subject, previewText, html, text, payloadHash, draftVersion, problems}, approval}` |
| POST | `/draft/preview` | `{subject?, previewText?, blocks?: [{id, type, data}]}` | `{preview: {subject, previewText, html, text}}`; no write |
| GET | `/draft/types` | | `{types: [{type, label, addable, fields}]}` (sponsor types: `addable: false`) |
| POST | `/draft/blocks` | `{type, data?, position?}` | 201 `{block, draft}` |
| PUT | `/draft/blocks/<id>` | `{version, data}` | `{changed, draft}`; 409 `block_version_conflict`, `sponsor_block_readonly`, `schedule_in_progress`; 409/502 `unschedule_failed` (scheduled draft, Relay did not confirm the cancel) |
| POST | `/draft/blocks/<id>/move` | `{direction: up\|down}` or `{to}` | `{draft}` |
| DELETE | `/draft/blocks/<id>` | | `{deleted, draft}` |
| GET | `/draft/revisions[?block=<id>]` | | `{revisions}` (block edits, approvals, withdrawals, test sends, test receipts, schedules, cancels) |
| POST | `/draft/sponsor-sync` | `{slot, dryRun?}` | stage the slot's sponsor doc now (local only) |
| POST | `/draft/approve` | `{version, payloadHash, note?}` | owner; 409 `draft_changed`, 422 `draft_incomplete` |
| POST | `/draft/test-send` | `{requestId}` | owner, approval current; sends to the owner's mailbox only (`emails` other than it: 400 `test_recipient_not_owner`); `{testSend: {requestId, ...}, draft}`; a replayed `requestId` returns the first result |
| POST | `/draft/test-receipt` | `{version (approval.draftVersion), payloadHash, testRequestId}` | owner; needs a provider-accepted test of that approval to the owner; `{testReceipt, draft}`; 409 `test_send_required`, `draft_changed`, `approval_required` |
| POST | `/draft/schedule` | `{scheduledAt (ISO with offset, 15 min to 60 days ahead), payloadHash, version, requestId}` | owner, approval and test receipt current (409 `test_receipt_required`); `{delivery, adopted, replayed, draft}` |
| POST | `/draft/cancel` | `{}` | owner; `{delivery, draft}`; 409 `relay_campaign_missing` when Relay answers 404 (not proof nothing is pending; the delivery is kept) |
| GET | `/draft/delivery[?refresh=1]` | | stored delivery; `refresh=1` (owner) reads Relay |

`draft` carries `subject`, `previewText`, `version`, `locked` (Relay holds the
email scheduled; edits still save, unscheduling first), `blocks` (each with
`fields`, `problems`, `readOnly`, `canMove`, `canDelete`, `sponsorDocUrl`),
`problems`, `payloadHash`, `approval: {state: none|current|stale, approvedBy,
approvedByName, approvedAt, draftVersion, payloadHash, note}`, `testReceipt:
{state: none|current|stale, approvedVersion, payloadHash, testRequestId,
recipient, receivedAt, receivedByName}`, `lastTest: {requestId, payloadHash,
approvedVersion, status, at}`, `testRecipient`, `delivery`, `relayAudience`,
`webViewUrl`, `canApprove`. Every content-changing route (block add, edit, move,
delete, subject PUT) of a scheduled draft unschedules it first (step 9).

`POST /api/newsletter-issues/<issue>/images` (multipart) still hosts an image
publicly for a block's image field.

### Relay transport contract

Only Relay's documented client campaign API is used, with the
`dtc-newsletter` client key (`relay-production.dtc-newsletter-api-key`) and
audience `dtc` (`RELAY_NEWSLETTER_AUDIENCE` overrides it):

| Call | When | Body |
| --- | --- | --- |
| `GET /api/campaigns/<key>?client&audience` | before every write | |
| `PUT /api/campaigns/<key>` | test send, schedule | `{client, audience, subject, preview_text, html_body, text_body, scheduled_at?, metadata: {source_system: "dataops-newsletter", dataops_issue_id, dataops_payload_sha256, dataops_draft_version}}` |
| `POST /api/campaigns/<key>/test-send` | test send | `{client, audience, emails: [owner mailbox]}` |
| `POST /api/campaigns/<key>/queue` | schedule | `{client, audience}`; must answer `scheduled: true` |
| `POST /api/campaigns/<key>/cancel` | cancel, and edit of a scheduled draft (then `GET` to verify) | `{client, audience}` |

The campaign key is `dataops-newsletter-<number>-<issue-id prefix>`, with
`-r<n>` after a cancelled schedule. Guards:

- Nothing reaches Relay before a current owner approval; every call re-renders
  the draft, checks the approval hash, and re-verifies the frozen payload.
- Test sends go only to the owner's mailbox; nothing is queued before the
  owner recorded a receipt for that exact approved version and payload hash.
- An edit of a scheduled draft never claims success unless Relay confirmed the
  cancel on a read-back (status `cancelled`; a 404 is unconfirmed, because the
  campaign may sit under another scope or be hidden from the credential). If two edits race, Relay is cancelled once, one edit
  is saved, the other gets `409 draft_version_conflict`, and the cancellation
  is recorded either way, so DataOps never shows a schedule Relay dropped.
- Relay must store exactly the approved HTML and time before it is queued.
- Scheduling first locks the draft with an optimistic write (`scheduling`), so
  concurrent requests cannot schedule twice; a lock left by a request that
  died is retryable or cancellable after 5 minutes.
- A test send holds a short lock on the draft; a schedule waits for it, so a
  test send can never rewrite the campaign between its scheduled save and the
  queue. Right before queueing, the campaign is read back and must still be a
  draft with the approved HTML and time.
- When a call fails, Relay is asked what it holds before anything is unlocked:
  a campaign holding the approved payload is recorded as scheduled (at Relay's
  actual time); if Relay cannot be reached the draft stays locked in
  `scheduling` until `delivery --refresh` (or the 5-minute stuck window) settles
  it. A retry adopts a campaign that already holds the same payload instead of
  writing or queueing again; a campaign cancelled in Relay directly moves on to
  the next key.
- An issue whose email Relay holds can be neither deleted nor cancelled in
  DataOps until the schedule is cancelled.
- Test sends are recorded under their `requestId`; a replay never sends again.
  The receipt is kept on the draft and the test record.
- A schedule less than 15 minutes ahead is refused, so Relay never treats it as
  "send now".

**Dependency**: Relay's CloudFront WAF blocks request bodies over 8 KB unless
the request carries its trusted label. The full email HTML is larger, and the
Lambda has no fixed egress IP, so `/api/campaigns/` must be exempt for Bearer
requests like `/api/admin|client|agent/`:
DataTalksClub/aws-infra#182 (`main/edge-live`, needs a credentialed
plan/apply). Until it is applied, test sends and schedules fail loudly with a
bare 403 and nothing is recorded as sent.

### Storage

In the artifacts table: the draft `NL_BLOCKS#<issue>/SET` (one item,
optimistic `version`; holds `approval`, `testReceipt`, `lastTest`,
`delivery`), revisions `NL_BLOCK_REV#<issue>/REV#nnnnnnnn`, frozen payloads
`NL_PAYLOAD#<issue>/HASH#<sha256>`, test-send records
`NL_DELIVERY#<issue>/TEST#<requestId>` (with `receivedAt` once confirmed),
web views `NL_WEBVIEW#<token>/VIEW`.

### Retired, and what happened to the data

- The Markdown package (issue/sources/brief editor, its tabs and the
  code-gated preview), the Relay final render, `Import blocks from Relay`,
  `Check/Sync with Relay` and the three-way block sync are removed from the
  backend, the UI and the CLI (`markdown`, `final-render`, `relay-sync`,
  `blocks --import`, `blocks-sync`, `block-edit`), as is
  `scripts/newsletter_to_relay.py`.
- Nothing was deleted from storage. Issues keep `markdown`, `finalRender` and
  the preview-code fields (returned read-only, secrets stripped); Mailchimp
  metrics still read archived `issue.md` frontmatter for older issues.
- Drafts first built by the Relay import stay readable and editable: their
  archived Relay attributes (`relay`, `relayIssue`, per-block `relayBlockId`
  and `base`, `deleted`, `orderBase`, `lastSync`) are preserved on every write
  and never read, except that an archived draft starts from its Relay subject
  and preview text until they are saved.
- The stand-alone Card's "Markdown" step now closes when the owner approves the
  draft.
