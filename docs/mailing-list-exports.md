# Private mailing-list exports

DataOps can request an asynchronous provider export, retain its ZIP in private S3, register one private system artifact, and optionally attach that artifact to a recurring task. Provider credentials, signed provider URLs, contact data, and archive contents are never returned by the status API or written to logs.

## Configuration

The stack defaults to no enabled exports. Deployment supplies these parameters:

- `DapierCredentialsTableName`: physical name of the dedicated credentials table owned and populated by Dapier.
- `DapierCredentialsTableArn`: ARN used only in the DataOps runtime IAM policy.
- `MailingExportsConfig`: a JSON array whose `credentialId` is `mailchimp`. Configuration IDs, account names, and scope labels are operator-facing labels; use no contact data.

Placeholder configuration:

```json
[
  {
    "id": "example-mailchimp-account",
    "provider": "mailchimp",
    "account": "Example account",
    "scopeLabel": "All audiences (account export)",
    "taskId": "optional-recurring-task-id",
    "credentialId": "mailchimp",
    "enabled": true
  }
]
```

The Dapier-owned DynamoDB item contract is:

```json
{
  "credential_id": "mailchimp",
  "provider": "mailchimp",
  "value": { "apiKey": "placeholder-api-key-server", "server": "server" },
  "updated_at": "2026-07-14T08:00:00Z"
}
```

Dapier is the only writer. DataOps performs one consistent `GetItem` for the `mailchimp` key and never scans, writes, migrates, or deletes credentials. DynamoDB transparent encryption at rest protects stored data, but an IAM principal authorized for `GetItem` receives the plaintext attributes. The DataOps role is therefore restricted to `GetItem` on the supplied table ARN and leading key `mailchimp`.

`server` is optional because DataOps derives it from the API-key suffix. If both are present they must match. Rotate the credential in Dapier by replacing the same item; no DataOps configuration change is needed. Missing, unreadable, wrong-provider, and malformed records all become the same sanitized `authorization` failure with `fix-authorization`. Credential identifiers and values are excluded from jobs, artifacts, task links, logs, and APIs.

## Mailchimp behavior

The adapter calls Marketing API v3 account exports with `include_stages: ["audiences"]`. This exports the audiences stage for the whole Mailchimp account, not one selected audience. `scopeLabel` only explains that account-wide scope to operators.

Mailchimp accepts one account export at a time and one completed export per 24 hours. A run therefore persists the provider export ID and polls it on later invocations. Provider in-progress or limit responses remain pending with a wait/retry action. DataOps never starts a new daily provider job while an unfinished job exists or the local completed-run history is within 24 hours.

## Runs, APIs, and downloads

The daily EventBridge event uses `detail.dataopsAction = "mailing-export"`. Scheduled and manual delivery call the same service:

- `GET /api/mailing-exports` returns sanitized configurations and run history.
- `POST /api/mailing-exports/run` accepts `{"configId":"example-mailchimp-account","runKey":"2026-07-14"}`. A stable run key is required for caller-controlled retries; the portal and scheduler default to the UTC calendar day.
- `GET /api/artifacts/{artifactId}/download` authorizes the operator and returns a five-minute presigned download. Raw `s3://` identities and the provider `download_url` are never browser links.

The deterministic run ID is derived from configuration ID plus run key. Conditional DynamoDB creation and a short processing lease serialize overlapping delivery. Pending jobs reuse their provider export ID. Object keys and artifact IDs are deterministic, task references are de-duplicated, and replaying a completed run returns its durable result. If the configured task is missing, the archive and artifact remain available while the run reports a task-link action.

The provider ZIP must have a valid ZIP signature. DataOps records its size, `application/zip` content type, and SHA-256 checksum before writing it to the retained, encrypted, versioned, public-blocked bucket. Incomplete multipart uploads are aborted after seven days and noncurrent versions are retained for the configured lifecycle period.

Safe failure categories are `authorization`, `provider-api`, `provider-timeout`, `provider-concurrency`, `download-integrity`, `storage`, `persistence`, and `task-link`. Retry a retriable failure with the same run key. Authorization and storage failures first require the indicated configuration repair. Logs contain only configuration/run IDs, status transitions, and safe categories.

## Adding another provider

Implement `MailingExportProvider` from `backend/src/mailingExports/types.ts` and register its factory and any minimum completed-export interval in `backend/src/mailingExports/registry.ts`. Request, status polling, signed-download handling, and provider constraints stay behind that extension boundary. Scheduling, persistence, idempotency, ZIP validation, storage, artifacts, task attachment, API responses, and portal behavior do not change.

## Deployment, disable, and rollback

Deploy Dapier's table and writer first, then save or re-save the Mailchimp credential so the stable item exists. Deploy DataOps second with the table name/ARN and `credentialId: "mailchimp"` configuration, then verify one export without inspecting or copying the value. Only after that verification may Dapier remove an obsolete credential copy under its own change.

Set a configuration's `enabled` value to `false` or remove it to stop new runs without deleting history. If the reader switch fails, roll DataOps back to its previous stack version while leaving the Dapier table/item, export bucket, and artifact table intact. Never paste the credential into deployment or rollback commands.
