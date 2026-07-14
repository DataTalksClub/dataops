# Email document intake API

`POST /api/v1/intake/email-documents` is the machine-to-machine entry point for
an upstream mail automation. It accepts an email envelope and up to 25 stable
references to private transfer objects. It does not receive email bodies,
attachment bytes, base64 data, credentials, presigned URLs, or public URLs.
A metadata-only TODO email is valid.

## Authentication and rotation

Send the dedicated credential in `x-dataops-intake-secret`. Query-string and
body credentials are rejected. The runtime reads a pre-created Secrets Manager
secret referenced by the stack parameter `EmailDocumentIntakeSecretArn`. The
secret may be a plain credential or JSON:

```json
{"id":"sender-primary","credential":"replace-with-the-private-value"}
```

`id` is a non-secret audit/rate-limit identifier. Both supplied and configured
credentials are reduced to fixed-length SHA-256 digests before constant-time
comparison, including missing and wrong-length values. The cache expires within
60 seconds, and a failed comparison
forces one refresh so a newly rotated value works immediately. Rotate by
writing the new value, updating the sender, confirming the new value, and then
revoking the old value. Missing, malformed, and incorrect credentials all
receive the same `401` response.

The default limit is 60 authenticated requests per credential per minute.
Every authenticated request atomically increments a fixed-minute counter in the
managed DynamoDB audit-events table, so concurrent and horizontally scaled
Lambda instances share one limit. Expired windows have DynamoDB TTL cleanup.
`429 rate-limited` includes `Retry-After` in seconds.

Deployment requires the GitHub Actions secret
`EMAIL_DOCUMENT_INTAKE_SECRET_ARN`. Its value is the ARN of the pre-created
Secrets Manager secret, not the credential value. The workflow fails before
`sam deploy` when this configuration is absent and passes it to the required
CloudFormation parameter without printing it.

## Request schema

Requests must use `Content-Type: application/json`, be no larger than 256 KiB
before parsing, and contain only these fields:

```json
{
  "version": "2026-07-01",
  "messageId": "<provider-message-id@example.test>",
  "recipientRoute": "invoice",
  "from": "billing@example.test",
  "subject": "Example invoice",
  "receivedAt": "2026-07-12T10:00:00Z",
  "documents": [
    {
      "kind": "attachment",
      "storageUri": "s3://example-private-transfer/transfer/example.pdf",
      "filename": "example.pdf",
      "contentType": "application/pdf",
      "sizeBytes": 12345,
      "checksum": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  ]
}
```

`version` is exactly `2026-07-01`. `recipientRoute` must be in the deployed
route allowlist. `receivedAt` is a real UTC ISO timestamp and cannot be more
than five minutes in the future. `documents` is required and may be empty.

Each document is either `attachment` or `rendered-email-pdf`; a rendered email
must be `application/pdf`. The filename is a sanitized basename, size is 1 byte
through 25 MiB, and checksum is lowercase `sha256:` plus 64 hexadecimal
characters. Duplicate descriptors, unknown fields, unsupported versions,
control characters, tokenized URLs, and non-S3 references are rejected.

Before calling the endpoint, upload each object under the configured private
transfer prefix with an exact `Content-Type` and `x-amz-meta-sha256` containing
the lowercase 64-character hex digest. A native S3 SHA-256 checksum is also
accepted. The API performs `HeadObject` and checks actual size, media type, and
checksum before registration.
If any descriptor is outside the allowlist, unavailable, or disagrees with the
object metadata, the whole request receives safe `400 validation-error`; no
intake, artifact, or managed copy is created.

## Responses and retries

Responses contain only an intake ID and safe artifact IDs/statuses—never object
paths, filenames, checksums, sender, subject, Message-ID, credentials, bytes, or
signed download URLs.

| HTTP | `status` | Meaning |
|---|---|---|
| 202 | `accepted` | First delivery completed |
| 200 | `duplicate` | Exact completed replay, or exact partial retry completed |
| 207 | `partial-failure` | Safe document indexes/codes identify retryable work |
| 400 | `validation-error` | Request contract or source prerequisite is invalid |
| 401 | `unauthorized` | Machine authentication failed |
| 409 | `idempotency-conflict` | The same route/Message-ID has changed immutable content |
| 413 | `payload-too-large` | Encoded request exceeds 256 KiB |
| 429 | `rate-limited` | Retry after the response header delay |
| 503 | `configuration-error` | Required private storage or persistence is unavailable |

Retry the identical complete request after `207` or a transient `503`. The
identity is normalized `(recipientRoute, messageId)`. The immutable envelope
and ordered manifest are fingerprinted: changing either returns `409` without
changing the original item. Concurrent deliveries reserve one deterministic
intake record and deterministic artifact records.

Artifact identity combines the intake ID, kind, checksum, and a hash of source
URI plus filename. That final hash is the tie-breaker when two distinct files
have the same bytes. Completed documents and links are reused on retry. A
partial intake is `blocked` with safe failure codes; an exact successful retry
returns it to `new` and clears the blocked reason. If copying succeeds but the
following intake-link update fails, the exact retry finds the completed
deterministic artifact and repairs the missing link without needing the transfer
source to remain available. If copying succeeds but artifact finalization
itself fails, a retained unlinked object version may remain; retry first, then
reconcile the deterministic destination key before any operator-approved
cleanup.

## Private storage and access

The stack owns a retained, versioned S3 bucket with KMS encryption, bucket-owner
enforcement, complete public-access blocking, and a TLS-only bucket policy.
Source reads are limited to the configured transfer prefix and destination
writes to the managed artifact prefix. DynamoDB stores only the durable managed
`s3://` destination and artifact/intake metadata. Portable exports retain that
metadata for restore reconciliation but never embed document bytes.

Operators download documents only through the existing authenticated,
short-lived private artifact download flow. This intake endpoint never returns
object bytes or a download URL.

For the stack-owned same-account transfer, grant the sender `s3:PutObject` only on the transfer
prefix and KMS encrypt/data-key permissions only on the bucket key. The runtime
already has prefix-scoped source read, destination write, and KMS permissions.
An optional second same- or cross-account source is deployable through
`EmailDocumentExternalSourceBucketName`,
`EmailDocumentExternalSourcePrefix`, and (for a customer-managed encrypted
source) `EmailDocumentExternalSourceKmsKeyArn`. CI sources these from the
repository variables `EMAIL_DOCUMENT_EXTERNAL_SOURCE_BUCKET` and
`EMAIL_DOCUMENT_EXTERNAL_SOURCE_PREFIX`, plus the masked Actions secret
`EMAIL_DOCUMENT_EXTERNAL_SOURCE_KMS_KEY_ARN`. CloudFormation adds exactly that
object-prefix ARN to `s3:GetObject`, adds only `kms:Decrypt` for the optional key,
and passes the same bucket/prefix to the runtime allowlist. No arbitrary runtime
JSON allowlist is accepted.

For a cross-account source, its bucket policy and KMS key policy must also grant
the role ARN published by the `BackendFunctionRoleArn` stack output those exact
`s3:GetObject` and `kms:Decrypt`
permissions. Do not use account-wide S3/KMS grants. The destination always
remains DataOps-owned.

For a blocked intake, inspect its safe failure code, correct source placement or
metadata/IAM/KMS access, and replay the exact request. Do not edit the manifest
or manually create artifact records. Delete source transfer objects only after
the accepted/duplicate response and authenticated private-download check meet
the sender's retention policy.
