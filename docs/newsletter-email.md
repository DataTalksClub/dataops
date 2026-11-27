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
campaign API, which test-sends or schedules it. Nothing is imported or pulled
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
   a sponsor-doc save) withdraws the approval and records that in the history.
6. **Test send** (owner, approval current): the frozen payload becomes a Relay
   draft campaign and Relay sends it to one or two allow-listed addresses.
7. **Schedule** (owner, approval current): the frozen payload is saved with
   `scheduled_at` and queued; Relay sends it at that time. The draft is locked
   until "Cancel schedule", which cancels the Relay campaign (before sending
   starts) and makes the draft editable; the next schedule is a new campaign.

### Sponsor content

A sponsor slot with a sponsor document takes its sponsor block from the doc:
every doc save stages the block (and, for the primary slot, the subject with
the ` | DataTalks.Club Weekly` suffix and the preview text) into the DataOps
draft. Staging is local only: no Relay call, no invoice, deal or outreach.
The block is read-only in the editor and links to its doc.

A slot without a document takes a hand-made sponsor block ("Add block" >
Sponsor), edited like any other block. Use it for an own DataTalks.Club promo
(a course, a Zoomcamp) when no external sponsor is booked; booking a slot for
DataTalks.Club already skips the invoice and sponsor-email Tasks
(`dataops newsletter sync-tasks`).

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
| GET | `/draft/types` | | `{types: [{type, label, addable, fields}]}` |
| POST | `/draft/blocks` | `{type, data?, position?}` | 201 `{block, draft}` |
| PUT | `/draft/blocks/<id>` | `{version, data}` | `{changed, draft}`; 409 `block_version_conflict`, `sponsor_block_readonly`, `draft_locked` |
| POST | `/draft/blocks/<id>/move` | `{direction: up\|down}` or `{to}` | `{draft}` |
| DELETE | `/draft/blocks/<id>` | | `{deleted, draft}` |
| GET | `/draft/revisions[?block=<id>]` | | `{revisions}` (block edits, approvals, withdrawals, test sends, schedules, cancels) |
| POST | `/draft/sponsor-sync` | `{slot, dryRun?}` | stage the slot's sponsor doc now (local only) |
| POST | `/draft/approve` | `{version, payloadHash, note?}` | owner; 409 `draft_changed`, 422 `draft_incomplete` |
| POST | `/draft/test-send` | `{emails: [1-2], requestId}` | owner, approval current; `{testSend}`; a replayed `requestId` returns the first result |
| POST | `/draft/schedule` | `{scheduledAt (ISO with offset, 15 min to 60 days ahead), payloadHash, version, requestId}` | owner, approval current; `{delivery, adopted, replayed, draft}` |
| POST | `/draft/cancel` | `{}` | owner; `{delivery, draft}` |
| GET | `/draft/delivery[?refresh=1]` | | stored delivery; `refresh=1` (owner) reads Relay |

`draft` carries `subject`, `previewText`, `version`, `locked`, `blocks` (each
with `fields`, `problems`, `readOnly`, `canMove`, `canDelete`,
`sponsorDocUrl`), `problems`, `payloadHash`, `approval: {state:
none|current|stale, approvedBy, approvedByName, approvedAt, draftVersion,
payloadHash, note}`, `delivery`, `relayAudience`, `webViewUrl`, `canApprove`.

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
| `POST /api/campaigns/<key>/test-send` | test send | `{client, audience, emails}` |
| `POST /api/campaigns/<key>/queue` | schedule | `{client, audience}`; must answer `scheduled: true` |
| `POST /api/campaigns/<key>/cancel` | cancel | `{client, audience}` |

The campaign key is `dataops-newsletter-<number>-<issue-id prefix>`, with
`-r<n>` after a cancelled schedule. Guards:

- Nothing reaches Relay before a current owner approval; every call re-renders
  the draft, checks the approval hash, and re-verifies the frozen payload.
- Relay must store exactly the approved HTML and time before it is queued.
- Scheduling first locks the draft with an optimistic write (`scheduling`), so
  concurrent requests cannot schedule twice; a lock left by a request that
  died is retryable or cancellable after 5 minutes.
- A retry after a lost response adopts a Relay campaign that already holds the
  same payload hash instead of writing or queueing again.
- Test sends are recorded under their `requestId`; a replay never sends again.
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
optimistic `version`), revisions `NL_BLOCK_REV#<issue>/REV#nnnnnnnn`, frozen
payloads `NL_PAYLOAD#<issue>/HASH#<sha256>`, test-send records
`NL_DELIVERY#<issue>/TEST#<requestId>`, web views `NL_WEBVIEW#<token>/VIEW`.

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
