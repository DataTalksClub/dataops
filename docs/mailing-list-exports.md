# Private mailing-list exports

DataOps can request an asynchronous provider export, retain its ZIP in private S3, register one private system artifact, and optionally attach that artifact to a recurring task. Provider credentials, signed provider URLs, contact data, and archive contents are never returned by the status API or written to logs.

## Configuration

The stack defaults to no enabled exports. A credentialed operator supplies both deployment parameters through the approved secret/deploy mechanism:

- `MailchimpSecretArn`: ARN of a pre-created Secrets Manager secret. The Lambda role receives `secretsmanager:GetSecretValue` only for that ARN.
- `MailingExportsConfig`: a JSON array whose `secretName` references that same secret. Configuration IDs, account names, and scope labels are operator-facing labels; use no contact data.

Placeholder configuration:

```json
[
  {
    "id": "example-mailchimp-account",
    "provider": "mailchimp",
    "account": "Example account",
    "scopeLabel": "All audiences (account export)",
    "taskId": "optional-recurring-task-id",
    "secretName": "placeholder/provider-secret",
    "enabled": true
  }
]
```

The secret is JSON:

```json
{ "apiKey": "placeholder-api-key-server", "server": "server" }
```

`server` is optional because DataOps derives it from the API-key suffix. If both are present they must match. Mailchimp Marketing API keys are account-wide; Mailchimp does not offer a narrower key permission for this account-export operation. Limit access to the secret and DataOps operator role, rotate it out of band, and do not paste it into configuration, logs, tasks, issues, or documentation.

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

## Disable and rollback

Set a configuration's `enabled` value to `false` or remove it, then redeploy the parameter. This stops new scheduled/manual runs without deleting history or retained archives. To roll back application code, deploy the prior revision while leaving the bucket and artifact table intact. Do not remove the legacy Zapier/Google Drive flow until a credentialed operator has verified one real DataOps export and its intended task attachment.
