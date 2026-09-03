# Document review tool

Status: implementation complete; adoption evidence pending

This plan turns the SYSTEMology audit backlog in the private `dataops-knowledge`
repository into an operator workflow inside DataOps. The audit evidence remains
in that repository; DataOps reads the live document catalog and stores review
decisions separately from document Markdown.

## Audit-backed scope

The final audit recheck reports 443 governed Markdown documents: 412 proposed,
8 draft, 20 archived, 2 blocked, 1 deprecated, and 0 active. It also reports
782 external-link rows and 13 quarantined orphan assets. Those are different
review objects with different evidence requirements, so the first DataOps lane
is the document queue. External links and orphan assets remain visible as
follow-up work in the audit evidence rather than being represented as fake
documents.

## Review queue contract

The queue is derived on every catalog load from document metadata and persisted
review records:

- Reviewable lifecycle values are `proposed`, `draft`, `review-due`, and
  `blocked`. Archived and deprecated documents are available only as historical
  context.
- A document needs review when it has no review record, its content timestamp
  is newer than the last review, or the latest decision is `changes_requested`,
  `blocked`, or `deferred`.
- Core documents sort before supporting documents. Within a priority band,
  unresolved decisions and oldest content come first.
- Each queue row explains why it is present and shows its owner role, business
  system, lifecycle, criticality, and source path.
- A review decision is evidence about the document. It does not change
  frontmatter lifecycle fields or claim that an operational workflow has been
  observed.

## Operator workflow

1. Open Review from the DataOps workspace navigation.
2. Filter or search the derived queue and select a document.
3. Read the current Markdown preview or open the document in the editor.
4. Complete the checklist: purpose, procedure, validation, troubleshooting,
   references, and ownership/tool metadata.
5. Record one decision: approve review evidence, request changes, block, or
   defer. Changes requested and blocked decisions require feedback.
6. Revisit the history after the document is edited; a changed document returns
   to the queue because its content timestamp no longer matches the review.

## Data and API design

Document reviews use a dedicated DynamoDB table with one `CURRENT` item and
append-only `REVIEW#...` history items per document. The API is authenticated
through the existing DataOps router:

- `GET /api/document-reviews` returns current review records.
- `GET /api/document-reviews/:documentId` returns the current record and history.
- `POST /api/document-reviews` validates and persists a checklist, decision,
  feedback, document identity, and server-derived reviewer identity.

Review records are intentionally separate from Git commits and document
frontmatter. They are portable execution evidence and can later feed lifecycle
promotion or external-source review without rewriting this first workflow.

## Item-by-item delivery plan

### Item 1 — Queue contract and governed metadata

- Expose the audit metadata fields through the DataOps document registry.
- Define queue inclusion, stale-review detection, priority, and reason labels.
- Acceptance: the live catalog contains enough information to explain every
  queue row without a manually maintained list.

### Item 2 — Review records and history

- Add the dedicated review table, authenticated routes, validation, and
  append-only history.
- Reject unsafe feedback containing tokens, credentials, or signed URLs.
- Acceptance: a reviewer can create, list, retrieve, and validate a decision;
  the original document is unchanged.

### Item 3 — Review workspace

- Add a canonical `/#/review` route and sidebar entry.
- Render summary counts, searchable/filterable queue, selected-document
  preview, metadata, checklist, decision controls, feedback, and history.
- Link to the existing editor for content changes.
- Acceptance: an operator can complete the end-to-end review flow without
  leaving DataOps, and the URL preserves the selected document.

### Item 4 — Verification and adoption evidence

- Add model, API, routing, and surface tests; update the frontend capability
  contract and responsive browser coverage.
- Run the full DataOps verification workflow and capture the first real owner
  review as human evidence before changing any document to `active`.
- Acceptance: tests prove queue derivation, stale detection, authorization,
  persistence, failure states, responsive layout, and safe re-review after an
  edit.

## Explicit follow-up lanes

After the document workflow is usable, add typed review objects for the audit's
remaining owner-controlled work:

- external URL classification, access, owner, replacement, and provenance;
- orphan asset attachment, retention decision, or owner-approved deletion;
- Typefully and Trello runtime boundary confirmation;
- podcast provenance decisions and dry-run/adoption evidence.

These lanes must reuse the review evidence model or a clearly related model;
they must not become another static report or silently inherit document status.

## Verification status

The document review lane is implemented and covered by unit, API, routing,
capability, build, SAM validation, and responsive browser checks. The first
real owner review remains intentionally pending: review evidence must be
captured in DataOps before any document is promoted to `active`.

The focused review checks pass. The repository-wide backend command still
reports unrelated Telegram-conversational failures because its test command
disables the conversational feature flags while those tests expect the enabled
path; those failures are outside this review lane.
