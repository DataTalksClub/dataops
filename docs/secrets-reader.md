# Machine reads from the team secrets store

The TypeScript reader is `backend/src/secrets/reader.ts`; the Python reader is
`packages/secrets-reader/python/dataops_secrets.py` (requires boto3). Both require
an explicit table name, KMS key ARN and region. They use the ambient workload
identity, strongly consistent DynamoDB GetItem, and KMS Decrypt with
`EncryptionContext: {secret: <store-name>}`. They return the field map, never log
values, and do not cache credentials or plaintext. Machine reads bypass the
portal audit table; KMS CloudTrail records identity and secret context.

Give each workload only `dynamodb:GetItem` on the secrets table and
`kms:Decrypt` on the secrets key ARN, with this condition (substitute that
consumer's exact names):

```json
{"StringEquals":{"kms:EncryptionContext:secret":["consumer.session"]}}
```

The key policy must permit the workload's IAM grant. Do not grant Scan, Query,
Encrypt, table writes, or unconditional Decrypt. The shared `SECRETS` partition
means DynamoDB LeadingKeys cannot isolate individual secrets; KMS context is the
per-secret confidentiality boundary. A consumer may fetch other ciphertext but
cannot decrypt it. Account for cross-region clients explicitly: the table and
key are in their store region, even when a consumer runs elsewhere.

## Name and value mapping

Map AWS names explicitly to lowercase store identifiers, replacing `/` with
`.` (for example `dapier/admin` becomes `dapier.admin`). Lowercase mixed-case
names as well. Check the complete mapping for collisions before import; never
silently overwrite. Store names have 1–64 lowercase letters, digits, `.`, `_`,
`-`, starting with a letter or digit.

Every imported AWS SecretString, including JSON, goes into **one field named
`value`**, verbatim. This preserves whitespace and JSON types for byte-for-byte
hash verification. Consumers read `fields.value` and parse JSON when their
original integration parsed JSON. Existing human-managed field maps remain
field maps. Never flatten JSON or stringify individual members during import.
Binary secrets need an explicit separately reviewed mapping; these readers do
not guess an encoding. Payloads must fit the API's existing encrypted size cap.

## Atomic context cutover

All new writes and reads require context; there is no runtime legacy fallback.
Before deploying this change, pause secret writes and offline re-encrypt every
existing ciphertext with KMS ReEncrypt: SourceKeyId and DestinationKeyId are the
existing key, omit SourceEncryptionContext for old entries, and set
DestinationEncryptionContext to `{secret: item.name}`. Use a conditional
DynamoDB update (`data = old ciphertext`) to avoid overwriting concurrent edits.
Verify each old plaintext against new-context decrypt in memory, emitting only
MATCH/MISMATCH and byte length. Never print plaintext or hashes. Preserve all
metadata. Record names/counts and immediately deploy through normal CI while
writes remain paused. The previous runtime cannot decrypt migrated entries:
coordinate a maintenance interval and do not roll back to context-free code.

The migration is a one-time operator operation, not startup behavior. Delete its
script after successful verification. A missing or mismatched context must fail
closed. Local AES-GCM binds the same name as additional authenticated data so
unit and API tests exercise this invariant without AWS.
