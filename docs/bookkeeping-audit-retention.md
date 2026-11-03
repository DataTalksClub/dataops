# Bookkeeping Audit Retention and Storage

## Current contract

Bookkeeping transaction rows live in the managed `DataOpsBookkeepingTable`, a
PK/SK DynamoDB table with point-in-time recovery, deletion protection, and
`Retain` policies on stack deletion or replacement. Transaction edits and
allocation changes use `updatedAt` compare-and-swap. The transaction update,
allocation claims, evidence-link/refcount changes, and sponsor-finance claim
checks are sent through the same `TransactWriteItems` operation.

The transaction's `audit` array is currently inline. The application keeps at
most 100 entries. The merged PR 308 also drops older entries until the encoded
array is at most 128 KiB, so it can retain fewer than 100. Open PR 309 changes
that byte-budget behavior to reject an append before writing and caps a reason
at 2 KiB UTF-8. Neither the 100-entry window nor the 128 KiB guard establishes
indefinite historical retention.

The portable execution export writes all selected `BOOKKEEPING#` rows to
`bookkeeping_records.jsonl`. The archive is private, encrypted, versioned, and
stored in the retained archive bucket. Export scans are sequential and do not
provide a transactional snapshot. DynamoDB PITR is configured on the table;
the documented recovery window is up to 35 days. Production settings and the
presence of a live archive have not been checked as part of this code review.

## Safe storage design

Store each new audit event in the existing managed bookkeeping table under a
separate partition, `PK=BOOKKEEPING_AUDIT#<transactionId>`. Use a sortable
sequence in `SK` and keep the event payload in that row. This needs no new
table, GSI, bucket, secret, or infrastructure resource. The transaction row
stores an audit schema marker and the latest sequence.

On the first audited update to a legacy transaction, move its currently present
inline entries into one bounded legacy-batch row and remove the inline `audit`
attribute. Add the new event, marker, sequence, transaction changes, and any
allocation/claim/link updates in the same transaction. If migration, event
append, CAS, or a related condition fails, DynamoDB commits none of them. The
batch contains only entries found on that row; it does not recreate history
that the old 100-entry or byte-budget behavior already removed.

Keep the current rolling window of 100 visible entries. Each audited write
adds one event and, when the window is full, expires exactly its oldest entry
in the same transaction. This removes the 128 KiB per-row bottleneck without
changing the established entry-count behavior. It does not promise retention
beyond the current 100 entries. The application has no substantiated
time-based retention or archival policy for older bookkeeping audits; any
longer retention requirement needs an explicit product decision.

Read legacy rows from their inline array. For migrated rows, read the legacy
batch and sequenced event rows, return the same `audit` array shape from the
existing transaction read APIs, and expose a cursor-based audit endpoint for
clients that need pages. Validate sequence continuity during portable export
and restore so a sequential scan that observes only one side of an atomic
parent/event write is rejected rather than archived as complete. Include the
new `BOOKKEEPING_AUDIT#` prefix in `bookkeeping_records.jsonl`; raw table dumps
and PITR already cover it because it remains in the same table.

## DynamoDB limits and concurrency

The application must count generated claim checks as transaction actions,
reject a request before sending it if the final action count exceeds 100, and
keep each audit row below DynamoDB's 400 KiB item limit. Event rows use a
different key from the transaction row and each other; no transaction may
target the same item twice. DynamoDB enforces the 4 MiB aggregate transaction
limit and applies a transaction atomically. The audit event and transaction
row share the same `updatedAt` CAS condition, so concurrent edits cannot
commit an event without its corresponding transaction update or vice versa.

These limits are documented by [DynamoDB transaction semantics](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html)
and [DynamoDB item-size constraints](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Constraints.html).

## Verification boundary

Local tests should cover concurrent transaction updates, allocation put and
delete, UTF-8 reason boundaries, legacy-inline migration, export/restore
readback, transaction/action limits, and atomic failure with no partial
business or audit writes. Tests must use synthetic data. Do not read or write
production bookkeeping records to validate this change. A live AWS check of
PITR and archive lifecycle requires separate authorization and is outside this
design review.
