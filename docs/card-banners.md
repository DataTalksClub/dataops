# Card banners

The CLI requests private covers from the Card's title, linked People register
entries and source-verified portrait files already uploaded to Tasks on that Card:

```sh
dataops cards update CARD_ID --people PERSON_ID,SECOND_PERSON_ID
dataops cards banner CARD_ID --event-type workshop --layout landscape \
  --speakers PERSON_ID:PORTRAIT_FILE_ID,SECOND_PERSON_ID:SECOND_PORTRAIT_FILE_ID \
  --revision cover-v1 --wait
dataops cards banner CARD_ID --job JOB_ID --wait
dataops artifacts list --card CARD_ID
dataops artifacts download ARTIFACT_ID --output cover.png
```

Supported event types are `workshop`, `webinar`, and `podcast`; each has landscape
and square templates for one to three speakers. The event type chooses the icon
as well as the label. For a live Q&A, use `--event-type webinar --event-label 'Live Q&A'` to retain the webinar icon with an explicit Q&A badge; other event types cannot use that override. A selection that contradicts an unambiguous Card template/tag classification is rejected; unclassified or ambiguous Cards need an explicit selection. The operator selects portraits whose identities and sources
have been checked. Portrait ownership and byte checksums are checked server-side.
There is no renderer credential or local image path in the generation command.

Requests return a durable job immediately. `--wait` polls for up to ten minutes;
the job continues if the CLI exits. Repeating identical inputs, portrait
checksums, title, template bundle and revision reuses the job and artifact.
Retry a failed request with the original flags. Use a new revision to request
another version. Previous approved artifacts remain intact.

Completed PNGs appear in the Card's existing Artifacts section with a controlled
download action and `needs-review` status. The artifact records dimensions,
checksum, template identity/source revision, bundle checksum, input checksum and
speaker provenance. Review title wrapping, icon, portraits, labels and cropping
before approving. Generation does not publish an image to an external platform.
Downloads verify the bytes and refuse to overwrite existing files.

For a confirmed sponsored cover, explicitly add `--sponsor-logo FILE_ID
--sponsor-treatment approved-logo`. Select a source-verified logo image already
saved on the same Card. The service uses the approved logo slot and records the
logo's file ID, checksum and treatment in the immutable job and image provenance.
Omitting these flags selects the unchanged nonsponsored layout; a company name
does not establish approval for logo treatment.

## Runtime

The authenticated Card API writes `BANNERJOB#` records in the artifacts table
(outside the `ARTIFACT#` namespace), then sends a small job ID message to the
application's encrypted SQS queue. A Lambda worker obtains a conditional lease,
loads an immutable private template bundle, embeds portraits, and writes
self-contained HTML. It invokes the existing private Banner Generator generic
renderer through IAM using `html-renderer.job.v1`. Rendered objects have immutable
job keys. Retries repair an interrupted Card attachment using the same artifact ID.
Infrastructure delivery failures retry through SQS; the queue has a dead-letter
queue. Raw table backups retain jobs; portable artifact exports include completed
artifacts, rather than transport jobs.

Configuration:

| Variable | Meaning |
| --- | --- |
| `BANNER_RENDERER_ARN` | Private generic renderer Lambda |
| `BANNER_TEMPLATE_BUNDLE_KEY` | Immutable template bundle in the knowledge bucket |
| `BANNER_QUEUE_URL`, `BANNER_QUEUE_ARN` | Application-owned work queue |
| `TASK_FILES_BUCKET` | Private input HTML and generated Card images |

Approved template assets stay in private storage. Product source contains only
the bundle contract: `schema: dataops.banner-templates.v1`, `sourceRevision`,
optional shared `assets`, and `templates`. Each template declares `id`,
`eventType`, `layout`, `speakerCount`, `width`, `height`, and self-contained `html`.
Sponsored variants also declare `sponsorTreatment: approved-logo` and contain
the `{{sponsorLogo}}` image field.
Fields are `{{title}}`, `{{titleFontSize}}`, `{{speaker1Name}}`,
`{{speaker1Portrait}}` and their speaker-2/speaker-3 equivalents. Shared asset field names
start with `asset`. Text is escaped; the renderer blocks scripts and external
resources. Publish bundles under a new content-addressed private key and update
the application parameter for a template release.

Safe failure codes distinguish queue delivery, template configuration, portrait
changes/checksums, renderer cold activation/access, invalid completion/output,
and attachment failure. Provider payloads and signed URLs are excluded from
durable errors. A renderer cold-activation failure can be retried with the same
request after activation completes.
