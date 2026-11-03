# Bookkeeping Audit Retention and Storage

## Current contract

Bookkeeping transaction rows live in the managed `DataOpsBookkeepingTable`, a
PK/SK DynamoDB table with point-in-time recovery, deletion protection, and
`Retain` policies on stack deletion or replacement. Transaction edits and
allocation changes use `updatedAt` compare-and-swap. The transaction update,
allocation claims, evidence-link/refcount changes, and sponsor-finance claim
checks are sent through the same `TransactWriteItems` operation.

The transaction's `audit` array is currently inline. The application keeps at
most 100 entries. PR 308 added a 128 KiB encoded-array guard, and merged PR 309
rejects an append over that guard and limits allocation reasons to 2 KiB in
UTF-8. Those limits can make an otherwise valid transaction uneditable once
its audit array grows. Neither the 100-entry window nor the byte guard
establishes indefinite historical retention.

The portable execution export writes selected bookkeeping records to
`bookkeeping_records.jsonl`. The application template's archive bucket blocks
public access, uses AES-256 server-side encryption and versioning, and has
CloudFormation retain policies. The template schedules a portable export daily
at 08:30 UTC. Archive keys include the export timestamp. Its lifecycle rule
expires only noncurrent versions after `ExportArchiveRetentionDays` (default
365 days, minimum 90); that rule does not age out current objects. Export scans
are sequential and do not provide a transactional snapshot.

The template also schedules a raw DynamoDB dump daily at 09:00 UTC. The backup
code scans each application table sequentially and writes compressed NDJSON
objects plus a manifest. A table scan failure makes the run fail after it
writes the manifest. The bucket lifecycle expires both current and noncurrent
raw dump versions after `DynamoBackupRetentionDays` (default 90 days, minimum
30). These are declared schedules and lifecycle settings, not evidence that a
particular scheduled run succeeded or that an archive object is present.

The bookkeeping table's template enables PITR but does not set a custom
recovery period. DynamoDB defaults that period to 35 days; a PITR restore
creates a new table. Live PITR status and production settings were not checked
as part of this work. Earlier audit entries may be present in a dated export,
raw dump, or PITR-restored table if captured before they were trimmed, but no
such artifact was inspected or used to establish recoverability. [DynamoDB
PITR documentation](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/PointInTimeRecovery_Howitworks.html)
describes the configurable 1-to-35-day recovery window.

## Safe storage design

Store each new audit event in the existing managed bookkeeping table under a
separate partition, `PK=BOOKKEEPING_AUDIT#<transactionId>`. Use a sortable
sequence in `SK` and keep the event payload in that row. This needs no new
table, GSI, bucket, secret, or infrastructure resource. The transaction row
stores an audit schema marker and the latest sequence.

On the first audited update to a legacy transaction, serialize the inline
entries that are still present and split them into bounded base64 legacy
chunks. Remove the inline `audit` attribute in the same transaction that writes
the chunks, the new event, the schema marker, the sequence, the requested
transaction changes, and any allocation/claim/link updates. Even an inline
audit near DynamoDB's 400 KiB item limit can move into multiple sidecar items
without exceeding the per-item budget. If migration, event append, CAS, or a
related condition fails, DynamoDB commits none of them. Migration preserves
entries found on the row; it cannot recreate entries already removed by the
former 100-entry or byte-budget behavior.

Keep the current rolling window of 100 visible entries. Each audited write
adds one event and, when the window is full, expires exactly its oldest entry
in the same transaction. This removes the 128 KiB per-row bottleneck without
changing the established entry-count behavior. Sidecar storage is not a full
historical archive and does not promise retention beyond the latest 100
events. The application has no substantiated time-based retention or archival
policy for older bookkeeping audits. If the product needs history beyond the
latest 100 events, that requirement and its retention period need an explicit
decision; this design does not infer one.
This is the online audit contract. Backup copies have separate recovery
lifecycles described above; they are not an audit-history interface or a
product retention policy.

Read legacy rows from their inline array. For migrated rows, read the bounded
legacy chunks and sequenced event rows, return the same `audit` array shape from
the existing transaction read APIs, and expose a cursor-based audit endpoint
for clients that need pages. Validate sequence continuity during portable
export and restore so a sequential scan that observes only one side of an
atomic parent/event write is rejected rather than archived as complete.
Include the new `BOOKKEEPING_AUDIT#` prefix in `bookkeeping_records.jsonl`; raw
table dumps and PITR can include it because it remains in the same table.

If a new event itself exceeds the safe sidecar item budget, or a write would
exceed the 100-action DynamoDB transaction limit, reject it before sending the
transaction with an explicit no-change response. If a portable export fails
its audit consistency check, rerun it after concurrent writes settle. If
persisted rows are inconsistent, recovery may require PITR or a verified raw
table backup, followed by audit-integrity validation. Live PITR status and
backup availability were not checked here.

## DynamoDB limits and concurrency

The application counts generated claim checks as transaction actions, rejects
a request before sending it if the final action count exceeds 100, and keeps
each audit row below a conservative 350 KiB budget. Event rows and legacy
chunks use different keys from the transaction row and each other; no
transaction may target the same item twice. DynamoDB enforces the 4 MiB
aggregate transaction limit and applies a transaction atomically. The audit
event and transaction row share the `updatedAt` CAS condition plus an audit
sequence or legacy-schema condition, so concurrent edits cannot commit an
event without its corresponding transaction update or vice versa.

Reads that observe a parent and sidecar set from opposite sides of a concurrent
commit re-read the parent. They retry only when `updatedAt`, the storage version,
or the audit sequence changed; a stable mismatch remains an integrity error.
Audited writes that detect such a parent change return a CAS conflict before
writing, so a race does not look like stored-history corruption. Updates advance
`updatedAt` past the supplied CAS value even when two writes start in the same
millisecond.

These limits are documented by [DynamoDB transaction semantics](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html)
and [DynamoDB item-size constraints](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Constraints.html).

## Verification boundary

Synthetic tests cover concurrent transaction updates, allocation put and
delete, UTF-8 reason boundaries, legacy-inline migration including a near-item
limit row, export/restore readback, transaction/action limits, and atomic
failure with no partial business or audit writes. No production bookkeeping
records were read or written. A live AWS check of PITR and archive lifecycle
was not performed. The verified retention contract remains the rolling
100-event window; any stronger history requirement is an open product-policy
question, not a completed part of this change.
